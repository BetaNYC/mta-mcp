// Data layer for mta-mcp: fetch, rate-limit, parse, classify.
//
// Every fact about the feed shapes below was verified against a live pull on
// 2026-09-16/17 and against the trimmed fixture in test/fixtures/. Nothing here
// is inferred from a proto definition that the feed does not actually populate.

import { readFileSync } from "node:fs";

// ─── Version ─────────────────────────────────────────────────────────────────

// Read once, from the one place the version is authored, so the User-Agent and
// the MCP server identity cannot drift apart or from package.json.
export const VERSION: string = (() => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version?: string };
  return pkg.version ?? "0.0.0";
})();

// ─── Endpoints ───────────────────────────────────────────────────────────────
//
// Published at https://api.mta.info/#/serviceAlerts and #/EAndEFeeds.
// No account, no API key: api.mta.info states "Accounts and API keys are no
// longer required to access these feeds." Confirmed with an unauthenticated
// HTTP 200. If you find yourself writing a getApiKey() here, stop.

const BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds";
export const SUBWAY_ALERTS_URL = `${BASE}/camsys%2Fsubway-alerts.json`;
export const ENE_CURRENT_URL = `${BASE}/nyct%2Fnyct_ene.json`;
export const ENE_UPCOMING_URL = `${BASE}/nyct%2Fnyct_ene_upcoming.json`;

export const DATA_SOURCE =
  "MTA service alerts (GTFS-realtime JSON with Mercury extensions), https://api.mta.info/#/serviceAlerts";
export const DISCLAIMER =
  "Unofficial. BetaNYC is not the MTA and makes no claim that this data is accurate, complete, or timely. Confirm service at https://www.mta.info before you travel.";

// ─── Responsible use ─────────────────────────────────────────────────────────
//
// MTA publishes no rate limit and no refresh cadence, and the response carries
// no Cache-Control, ETag, or Expires header — so politeness cannot be
// negotiated with the server and has to be imposed here. Six mechanisms, all
// required, none optional:
//
//   1. TTL cache (60 s default) so a burst of tool calls collapses to one fetch
//   2. Single-flight so concurrent calls for one URL share one request
//   3. A process-wide 1 s minimum interval between ANY two upstream requests
//   4. Bounded retry (2 attempts, 1 s then 2 s) honoring Retry-After
//   5. A 15 s request timeout so a hung request cannot pin the gate
//   6. An identifying User-Agent, so MTA can reach us about load
//
// There is deliberately no background polling, no prefetch, and no warm-up
// fetch. The server fetches only in direct response to a tool call.

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_ERROR_BODY_CHARS = 500;

export const USER_AGENT = `mta-mcp/${VERSION} (+https://github.com/BetaNYC/mta-mcp)`;

/**
 * Read the overrides at call time, not at module load. Tests set them between
 * cases, and a TTL evaluated when the entry is READ means setting it to 0
 * invalidates entries already in the cache.
 */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const cacheTtlMs = (): number => envMs("MTA_MCP_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS);
export const minIntervalMs = (): number =>
  envMs("MTA_MCP_MIN_INTERVAL_MS", DEFAULT_MIN_INTERVAL_MS);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into a bounded wait. */
export function retryAfterMs(header: string | null): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MS);
    }
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) {
      return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS);
    }
  }
  return 1000;
}

// Mechanism 3. A single promise chain serializes every upstream request in the
// process, across all URLs. Awaiting the tail before starting is what makes the
// spacing global rather than per-URL — four tools firing at once queue, they do
// not burst.
let gate: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function throughGate<T>(run: () => Promise<T>): Promise<T> {
  const turn = gate.then(async () => {
    const wait = lastRequestAt + minIntervalMs() - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  // The chain must advance even when `run` rejects, or one failure deadlocks
  // every later request behind it.
  gate = turn.catch(() => undefined);
  return turn.then(run);
}

/** Mechanisms 4 + 5 + 6: one attempt, with a timeout and identifying headers. */
async function attempt(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function errorFromResponse(url: string, res: Response): Promise<Error> {
  let body = "";
  try {
    body = (await res.text()).trim();
  } catch {
    // body unreadable; fall through with empty text
  }
  if (body.length > MAX_ERROR_BODY_CHARS) {
    body = `${body.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated)`;
  }
  let message = `MTA feed error ${res.status} ${res.statusText} for ${url}`;
  if (res.status === 404) {
    message += " — the feed URL may have moved; check https://api.mta.info/.";
  }
  if (body) message += ` Response body: ${body}`;
  return new Error(message);
}

/** A 4xx other than 429 is our bug, not congestion. Retrying it is just load. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

type CacheEntry = { fetchedAt: number; body: unknown };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

export type FeedResult = { body: unknown; fetchedAt: number; fromCache: boolean };

/**
 * Fetch a JSON feed through all six politeness mechanisms.
 * `fetchedAt` is when the bytes left MTA, not when this call ran — a cache hit
 * reports the original time, which is what the staleness note in every tool
 * payload is computed from.
 */
export async function fetchFeed(url: string): Promise<FeedResult> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.fetchedAt < cacheTtlMs()) {
    return { body: hit.body, fetchedAt: hit.fetchedAt, fromCache: true };
  }

  const pending = inFlight.get(url);
  if (pending) {
    const entry = await pending;
    return { body: entry.body, fetchedAt: entry.fetchedAt, fromCache: true };
  }

  const work = (async (): Promise<CacheEntry> => {
    let lastError: Error | undefined;
    let wait = 0;
    for (let tryNo = 0; tryNo <= MAX_RETRIES; tryNo++) {
      if (wait > 0) await sleep(wait);
      const res = await throughGate(() => attempt(url));
      if (res.ok) {
        const entry = { fetchedAt: Date.now(), body: await res.json() };
        cache.set(url, entry);
        return entry;
      }
      lastError = await errorFromResponse(url, res);
      if (!isRetryable(res.status)) throw lastError;
      // Backoff is 1 s then 2 s. A Retry-After can extend that but never
      // shorten it, so honoring the server cannot make us more aggressive.
      const backoff = Math.min(1000 * 2 ** tryNo, MAX_RETRY_AFTER_MS);
      wait =
        res.status === 429
          ? Math.max(backoff, retryAfterMs(res.headers.get("retry-after")))
          : backoff;
    }
    throw lastError ?? new Error(`MTA feed request failed for ${url}`);
  })();

  inFlight.set(url, work);
  try {
    const entry = await work;
    return { body: entry.body, fetchedAt: entry.fetchedAt, fromCache: false };
  } finally {
    inFlight.delete(url);
  }
}

// ─── Feed types ──────────────────────────────────────────────────────────────
//
// Shapes below are the ones the feed actually emits, counted in the 2026-09-16
// pull of 150 entities: all 150 carry active_period, informed_entity,
// header_text and mercury_alert; 149 carry description_text, so it is optional.
// All 1287 informed_entity rows carry route_id and agency_id "MTASBWY";
// stop_id appears only when MTA tagged station-level detail.

export type Translation = { text?: string; language?: string };
export type TranslatedString = { translation?: Translation[] };

export type InformedEntity = {
  agency_id?: string;
  route_id?: string;
  stop_id?: string;
  direction_id?: number;
};

export type MercuryAlert = {
  alert_type?: string;
  created_at?: number;
  updated_at?: number;
  human_readable_active_period?: TranslatedString;
};

export type ActivePeriod = { start?: number; end?: number };

export type Alert = {
  active_period?: ActivePeriod[];
  informed_entity?: InformedEntity[];
  header_text?: TranslatedString;
  description_text?: TranslatedString;
  "transit_realtime.mercury_alert"?: MercuryAlert;
};

export type AlertEntity = { id?: string; alert?: Alert };

export type AlertsFeed = {
  header?: { timestamp?: number };
  entity?: AlertEntity[];
};

/**
 * Pick the plain-English translation.
 *
 * header_text.translation carries both "en" and "en-html". Index 0 happened to
 * be "en" in all 150 observed entities, but nothing in GTFS-realtime orders the
 * array, so select by language and fall back to the first entry only if no "en"
 * exists (human_readable_active_period often has exactly one entry).
 */
export function englishText(value: TranslatedString | undefined): string | null {
  const translations = value?.translation;
  if (!translations || translations.length === 0) return null;
  const en = translations.find((t) => t.language === "en");
  return (en ?? translations[0]).text ?? null;
}

// ─── Effect classification ───────────────────────────────────────────────────

export type Effect =
  | "reduced"
  | "changed"
  | "delay"
  | "informational"
  | "added"
  | "added_at_local_stops"
  | "unknown";

/**
 * Map MTA's Mercury `alert_type` to a rider-meaningful effect.
 *
 * These 11 values are every alert_type observed in the 2026-09-16 pull, with
 * their counts. They are NOT a documented enum — MTA publishes a 35-status
 * table but the feed only exercised these — so the map is a snapshot and
 * unknownEffect() below is what makes that safe.
 *
 * "Planned - Express to Local" is the trap this whole map exists for. Those 16
 * alerts tag stations that GAIN service (a normally-express train stopping
 * locally), so any "is this station mentioned in an alert" check reports a
 * disruption at a station where MORE trains are stopping. Live proof in the
 * fixture: on 2026-09-19 stop 628 (68 St-Hunter College) is tagged by
 * lmm:planned_work:34003 (route 5) and lmm:planned_work:33827 (route 4), both
 * "runs local in both directions between 125 St and Grand Central-42 St".
 */
export const EFFECT_BY_ALERT_TYPE: Readonly<Record<string, Effect>> = {
  "Planned - Stops Skipped": "reduced", // n=49
  "Planned - Part Suspended": "reduced", // n=33
  "Planned - Express to Local": "added_at_local_stops", // n=16
  "Boarding Change": "changed", // n=15
  "Planned - Reroute": "changed", // n=15
  "Planned - Suspended": "reduced", // n=7
  "Reduced Service": "reduced", // n=7
  "Extra Service": "added", // n=4
  "Special Schedule": "changed", // n=2
  Delays: "delay", // n=1
  "Station Notice": "informational", // n=1
};

/** Effects that make a route "disrupted". `unknown` is here on purpose. */
const DISRUPTING: ReadonlySet<Effect> = new Set<Effect>([
  "reduced",
  "changed",
  "delay",
  "unknown",
]);

/**
 * Classify an alert_type. Anything unrecognized becomes "unknown", which counts
 * as disrupted — fail toward caution, and surface it (see `unknown_alert_types`
 * in the tool payloads) so we learn the map is short rather than silently
 * dropping a real disruption.
 */
export function effectFor(alertType: string | undefined): Effect {
  if (alertType === undefined) return "unknown";
  return EFFECT_BY_ALERT_TYPE[alertType] ?? "unknown";
}

export function isDisrupting(effect: Effect): boolean {
  return DISRUPTING.has(effect);
}

export function isKnownAlertType(alertType: string | undefined): boolean {
  return alertType !== undefined && alertType in EFFECT_BY_ALERT_TYPE;
}

// ─── Eastern Time date handling ──────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(date: string): string {
  if (!ISO_DATE.test(date)) {
    throw new Error(`Invalid date '${date}': expected YYYY-MM-DD format.`);
  }
  return date;
}

/** Today in New York, not UTC. en-CA formats as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

/**
 * Minutes that America/New_York is offset from UTC at a given instant.
 * Formatting the instant in ET and re-reading those wall-clock fields as if
 * they were UTC gives the offset without a timezone library, and it is correct
 * across the DST transitions that a fixed -4 or -5 would get wrong.
 */
function etOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    // Some ICU builds render midnight as hour 24 under hour12:false.
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return (asIfUtc - utcMs) / 60_000;
}

/**
 * Epoch ms of a New York wall-clock time. Month is 1-based.
 *
 * Converting with the offset at the naive instant, then again with the offset
 * at the first guess, is what makes this right on DST-transition days, where
 * the first guess lands on the wrong side of the change.
 */
export function etWallClockMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = naive - etOffsetMinutes(naive) * 60_000;
  return naive - etOffsetMinutes(first) * 60_000;
}

/** Epoch ms of 00:00:00 Eastern on an ISO date. */
export function etMidnightMs(dateIso: string): number {
  const [y, m, d] = assertIsoDate(dateIso).split("-").map(Number);
  return etWallClockMs(y, m, d);
}

/** Half-open [start, end) epoch-second bounds of an Eastern calendar day. */
export function etDayBounds(dateIso: string): { start: number; end: number } {
  const [y, m, d] = assertIsoDate(dateIso).split("-").map(Number);
  const nextUtc = new Date(Date.UTC(y, m - 1, d + 1));
  const nextIso = `${nextUtc.getUTCFullYear()}-${String(nextUtc.getUTCMonth() + 1).padStart(2, "0")}-${String(nextUtc.getUTCDate()).padStart(2, "0")}`;
  return {
    start: Math.floor(etMidnightMs(dateIso) / 1000),
    end: Math.floor(etMidnightMs(nextIso) / 1000),
  };
}

/**
 * Does any active_period overlap the Eastern day?
 *
 * Bounds are half-open, so an alert that ends exactly at a day's opening
 * midnight does NOT affect that day, while one that ends exactly at the
 * following midnight does. Weekend work arrives as several periods (one per
 * weekend), so any single overlap is enough. A period with no `end` is
 * open-ended; none were observed, but the feed's schema permits it.
 *
 * An alert with no active_period at all is active on every date. The
 * GTFS-realtime reference (https://gtfs.org/documentation/realtime/reference/#message-alert)
 * says of active_period: "If missing, the alert will be shown as long as it
 * appears in the feed." The feed is a snapshot of what is live now, so an alert
 * with no periods is taken to apply to any date asked about. Answering "not
 * active" instead would drop a real alert, which is the wrong way to fail.
 * None of the 150 entities in the 2026-09-16 pull lacked periods.
 */
export function overlapsEtDay(periods: ActivePeriod[] | undefined, dateIso: string): boolean {
  const { start: dayStart, end: dayEnd } = etDayBounds(dateIso);
  if (!periods || periods.length === 0) return true;
  return periods.some((p) => {
    const start = p.start ?? Number.NEGATIVE_INFINITY;
    const end = p.end ?? Number.POSITIVE_INFINITY;
    return start < dayEnd && end > dayStart;
  });
}

// ─── Station list ────────────────────────────────────────────────────────────

export type Station = {
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
  /** Routes serving this station, joined offline from trips.txt ⋈ stop_times.txt. */
  routes: string[];
};
type StationsFile = {
  generated_at: string;
  source_url: string;
  source_files: string[];
  route_membership: boolean;
  stations_without_routes: string[];
  count: number;
  stations: Station[];
};

/**
 * Loaded from data/stations.json, generated by scripts/update-stations.mjs.
 * Read with readFileSync rather than a JSON import: import attributes changed
 * spelling between Node 20 (`assert`) and Node 22 (`with`), and this package
 * declares engines.node >= 18. A file read behaves identically on all of them.
 */
export const STATIONS: StationsFile = JSON.parse(
  readFileSync(new URL("../data/stations.json", import.meta.url), "utf8")
) as StationsFile;

const STATION_BY_ID = new Map(STATIONS.stations.map((s) => [s.stop_id, s]));

export function stationById(stopId: string): Station | null {
  return STATION_BY_ID.get(stopId) ?? null;
}

export function stationName(stopId: string): string | null {
  return STATION_BY_ID.get(stopId)?.stop_name ?? null;
}

/** Lowercase, strip punctuation, split into tokens. "68 St-Hunter College" → [68, st, hunter, college] */
function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
}

function startsWithTokens(haystack: string[], needle: string[]): boolean {
  return needle.every((t, i) => haystack[i] === t);
}

function containsTokenRun(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((t, j) => haystack[i + j] === t)) return true;
  }
  return false;
}

function scoreTokens(q: string[], n: string[]): number {
  if (q.length === 0) return 0;
  if (q.length === n.length && startsWithTokens(n, q)) return 100;
  if (startsWithTokens(n, q)) return 80;
  if (containsTokenRun(n, q)) return 60;
  if (q.every((t) => n.includes(t))) return 40;
  return 0;
}

/**
 * Score a station name against a query, on whole tokens.
 *
 * Token matching rather than substring matching is load-bearing: "68 St" is a
 * substring of "168 St-Washington Hts" but not a token run of it, so the
 * substring version silently offers a station 100 blocks away as a candidate.
 */
export function scoreStation(query: string, stopName: string): number {
  return scoreTokens(tokens(query), tokens(stopName));
}

export type StationMatch = Station & { score: number };

/** Thrown when a route filter is asked for and the bundled snapshot cannot serve it. */
export function assertRouteFilterAvailable(): void {
  if (!STATIONS.route_membership) {
    throw new Error(
      "This build cannot filter stations by route: data/stations.json was generated without route membership. Re-generate it with 'npm run stations', which joins trips.txt and stop_times.txt from MTA's static GTFS zip. The parameter is rejected rather than ignored so the answer is not silently wider than the question."
    );
  }
}

/**
 * Ranked candidates, best first, optionally restricted to one route.
 *
 * Station names are NOT unique: 193 of 496 parent stations share a stop_name
 * with another, in 76 name groups. "125 St" alone is four stations on four
 * different lines — 116 (1), 225 (2/3), 621 (4/5/6/6X), A15 (A/B/C/D) — so a
 * bare name lookup is a one-in-four guess. Callers get every candidate; the
 * route filter is what narrows it honestly.
 */
export function resolveStationMatches(
  query: string,
  opts: { routeId?: string; limit?: number } = {}
): StationMatch[] {
  if (opts.routeId !== undefined) assertRouteFilterAvailable();
  return STATIONS.stations
    .filter((s) => opts.routeId === undefined || s.routes.includes(opts.routeId))
    .map((s) => ({ ...s, score: scoreStation(query, s.stop_name) }))
    .filter((s) => s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.stop_name.length - b.stop_name.length ||
        (a.stop_id < b.stop_id ? -1 : 1)
    )
    .slice(0, opts.limit ?? 10);
}

export type StationResolution =
  | { station: Station }
  | { candidates: StationMatch[]; reason: "no-match" | "not-on-route" | "ambiguous" };

/**
 * Resolve free text to exactly one station, or refuse.
 *
 * Refusing is the point: picking "the obvious one" out of four stations named
 * 125 St is how a report ends up citing a station on the wrong line with an
 * answer that still reads as correct.
 */
export function resolveStationStrict(query: string, routeId?: string): StationResolution {
  const matches = resolveStationMatches(query, { routeId });
  if (matches.length === 0) {
    // Distinguish "that name does not exist" from "it exists, not on this route".
    const withoutRoute = routeId === undefined ? [] : resolveStationMatches(query);
    return withoutRoute.length > 0
      ? { candidates: withoutRoute, reason: "not-on-route" }
      : { candidates: [], reason: "no-match" };
  }
  const best = matches[0].score;
  const tied = matches.filter((m) => m.score === best);
  if (tied.length > 1) return { candidates: tied, reason: "ambiguous" };
  const { score, ...station } = matches[0];
  void score;
  return { station };
}

// ─── Station accessibility (ADA) ─────────────────────────────────────────────
//
// data/station_ada.json is generated by scripts/update-accessibility-data.mjs
// from data.ny.gov dataset 39hk-dx4f, "MTA Subway Stations". Its gtfs_stop_id
// matched all 496 of our stop_ids on 2026-09-22. MTA's column descriptions:
//
//   ada             0 not ADA-accessible, 1 fully accessible, 2 partially
//   ada_northbound  0 or 1, accessible in the northbound direction
//   ada_southbound  0 or 1, accessible in the southbound direction
//   ada_notes       "the direction a station is accessible in if it is only
//                   accessible in one direction"
//
// In the 2026-09-22 snapshot, all 9 partially accessible stations are
// accessible in exactly one direction, and one note narrows it further: 626
// (86 St) is "Uptown local only". So "partially" is reported with its
// direction and MTA's note, never as a vague "partly".
//
// This is station level, not complex level, on purpose. In 7 complexes the
// stations differ: at 14 St-Union Sq, L03 and R20 are accessible and 635 (the
// 4/5/6) is not. A complex-level answer would tell someone at the 6 platform
// that there is an accessible path when there is not.

export type StationAda = {
  stop_id: string;
  station_mrn: number | null;
  complex_mrn: number | null;
  ada: 0 | 1 | 2;
  ada_northbound: 0 | 1;
  ada_southbound: 0 | 1;
  ada_notes: string | null;
  north_direction_label: string | null;
  south_direction_label: string | null;
};

type SourceHeader = {
  /** When the rows were downloaded from data.ny.gov (ISO 8601, UTC). */
  data_pulled_at: string;
  dataset_id: string;
  name: string;
  page_url: string;
  api_url: string;
  terms: { name: string; url: string };
};

type StationAdaFile = {
  generated_at: string;
  source: SourceHeader;
  count: number;
  stations: StationAda[];
};

export const STATION_ADA: StationAdaFile = JSON.parse(
  readFileSync(new URL("../data/station_ada.json", import.meta.url), "utf8")
) as StationAdaFile;

const ADA_BY_ID = new Map(STATION_ADA.stations.map((s) => [s.stop_id, s]));

export function stationAda(stopId: string): StationAda | null {
  return ADA_BY_ID.get(stopId) ?? null;
}

export type AdaStatus = "fully_accessible" | "partially_accessible" | "not_accessible" | "unknown";

export type StationAccessibility = {
  status: AdaStatus;
  /** MTA's ada_notes, verbatim. For a partial station, this is the answer to lead with. */
  mta_notes: string | null;
  /**
   * Only for partially accessible stations: MTA's own label for the accessible
   * direction, like "Manhattan", "Uptown", or "Outbound". GTFS north and south
   * are nominal (F09's "southbound" is Manhattan-bound), so we never say them.
   */
  accessible_direction?: string | null;
};

const ADA_STATUS: Readonly<Record<number, AdaStatus>> = {
  0: "not_accessible",
  1: "fully_accessible",
  2: "partially_accessible",
};

/**
 * A station's ADA status, compact enough to put on every resolve_station
 * candidate. A stop_id missing from the snapshot is "unknown", never "not
 * accessible": we do not know, and saying no would be a claim.
 */
export function stationAccessibility(stopId: string): StationAccessibility {
  const row = stationAda(stopId);
  if (!row) return { status: "unknown", mta_notes: null };
  const status = ADA_STATUS[row.ada] ?? "unknown";
  if (status !== "partially_accessible") return { status, mta_notes: row.ada_notes };
  let direction: string | null = null;
  if (row.ada_northbound === 1 && row.ada_southbound === 0) direction = row.north_direction_label;
  else if (row.ada_southbound === 1 && row.ada_northbound === 0) direction = row.south_direction_label;
  return { status, mta_notes: row.ada_notes, accessible_direction: direction };
}

/**
 * ADA-compliant elevators the inventory codes to this stop_id. Used only to
 * word an empty answer honestly: four stations MTA lists as not accessible
 * (415, 635, D16, M04) have some. Never used to infer accessibility.
 */
export function adaElevatorsAt(stopId: string): string[] {
  return EQUIPMENT.equipment
    .filter(
      (e) => e.elevator_or_escalator === "Elevator" && e.ada_compliant === "YES" && e.stop_ids.includes(stopId)
    )
    .map((e) => e.equipment_code);
}

/** Other stations MTA groups with this one in a complex. Empty if none. */
export function complexStopIds(stopId: string): string[] {
  const row = stationAda(stopId);
  if (!row || row.complex_mrn === null) return [];
  return STATION_ADA.stations
    .filter((s) => s.complex_mrn === row.complex_mrn && s.stop_id !== stopId)
    .map((s) => s.stop_id);
}

// ─── Elevator and escalator inventory ────────────────────────────────────────
//
// data/equipment.json is generated from data.ny.gov dataset 94fv-bak7, "MTA
// Subway Elevator and Escalator Asset Inventory". It is an asset list, not
// outage status. What it adds to the outage feed:
//
//   stop_ids           where the equipment is, by ID: station_mrn, compared as
//                      an integer (94fv-bak7 zero-pads it, 39hk-dx4f does not),
//                      to 39hk-dx4f station_id, then to gtfs_stop_id. Three
//                      MRNs map to two stop_ids each (W 4 St, 145 St,
//                      Queensboro Plaza). 23 of 759 assets have no station MRN.
//                      Most are yard and shop elevators, but EL787 and EL788
//                      are street elevators at New Dorp (SIR), so rows the
//                      inventory can't place still get name matching.
//   alternative_route  MTA's directions for when the elevator is out. Present
//                      on 427 of 481 elevators, and on no escalator.
//   redundant_elevator "+" if another elevator provides the same service, "-"
//                      if not, per MTA's column description.
//
// The outage feed's `equipment` equals the inventory's equipment_code for all
// 122 distinct codes in the 2026-09-17 fixture, including X-suffixed ones.
// MTA says hand-maintained fields "may be lagged", and alternative_route is
// one; the answers say so.

export type Equipment = {
  equipment_code: string;
  elevator_or_escalator: string | null;
  station_mrn: number | null;
  station_complex_mrn: number | null;
  stop_ids: string[];
  station_description: string | null;
  ada_compliant: string | null;
  notes: string | null;
  redundant_elevator: string | null;
  alternative_route: string | null;
};

type EquipmentFile = {
  generated_at: string;
  source: SourceHeader;
  count: number;
  equipment: Equipment[];
};

export const EQUIPMENT: EquipmentFile = JSON.parse(
  readFileSync(new URL("../data/equipment.json", import.meta.url), "utf8")
) as EquipmentFile;

const EQUIPMENT_BY_CODE = new Map(EQUIPMENT.equipment.map((e) => [e.equipment_code, e]));

export function equipmentByCode(code: string | undefined): Equipment | null {
  if (!code) return null;
  return EQUIPMENT_BY_CODE.get(code.trim()) ?? null;
}

// ─── Elevator and escalator outages ──────────────────────────────────────────
//
// Flat JSON arrays of objects, not GTFS-realtime. Verified keys, all strings:
// station, borough, trainno, equipment, equipmenttype, serving, ADA,
// outagedate, estimatedreturntoservice, reason, isupcomingoutage,
// ismaintenanceoutage.
//
// `station` is FREE TEXT, not a stop_id, and does not always match a GTFS
// stop_name exactly — matching is by name, normalized (see eneTokens below),
// and every payload says so.

export type EneOutage = {
  station?: string;
  borough?: string;
  trainno?: string;
  equipment?: string;
  equipmenttype?: string;
  serving?: string;
  ADA?: string;
  outagedate?: string;
  estimatedreturntoservice?: string;
  reason?: string;
  isupcomingoutage?: string;
  ismaintenanceoutage?: string;
};

/**
 * The two ene feeds are NOT disjoint, which the `upcoming` filter has to
 * account for. Counted in the 2026-09-17 fixtures: nyct_ene.json holds 126 rows
 * — 79 with isupcomingoutage "N" and 47 with "Y" — and nyct_ene_upcoming.json
 * holds exactly those 47. The current feed is a superset.
 *
 * So `upcoming: true` reads the upcoming feed, and `upcoming: false` reads the
 * current feed and filters the upcoming-flagged rows back out. Deriving
 * "upcoming" from the current feed would work today and rests on a superset
 * relationship MTA never documented, so we don't.
 *
 * A `date` query is the one exception. It reads only the current feed, so it
 * covers in-effect and scheduled rows in one request, and it does rest on the
 * superset. That tradeoff is stated in docs/accessibility.md.
 */
export function eneFeedUrl(upcoming: boolean): string {
  return upcoming ? ENE_UPCOMING_URL : ENE_CURRENT_URL;
}

export function filterEneRows(rows: EneOutage[], upcoming: boolean): EneOutage[] {
  return upcoming ? rows : rows.filter((r) => r.isupcomingoutage !== "Y");
}

// ─── Matching elevator-feed station names ────────────────────────────────────
//
// The elevator feed spells some stations differently from GTFS. Counted in the
// 2026-09-17 fixtures (58 distinct `station` values across both ene feeds), 55
// are character-for-character GTFS stop_names and 56 are token-for-token. The
// two that miss, and the rule that fixes each:
//
//   "42St/Port Authority-Bus Terminal"  vs GTFS "42 St-Port Authority Bus Terminal"
//     a digit run glued to letters. Split it: 42st -> 42 st.
//   "Bedford Pk Blvd"                   vs GTFS "Bedford Park Blvd"
//     "Pk" for "Park". MTA's own GTFS uses both spellings: "42 St-Bryant Pk"
//     (D16) against 13 stop_names with "Park". So pk -> park on both sides.
//
// No GTFS stop_name has a digit glued to a letter, and none uses "pk" for
// anything but "Park", so both rules are no-ops on GTFS names except to make
// "Bryant Pk" and "Bryant Park" equal. This normalization is used only for the
// elevator feed. resolve_station keeps its own matching unchanged.

// "pl" for "Place" is the same story: GTFS has "Park Pl" (S03) and "Park
// Place" (228), and "Astor Pl" (636). No GTFS name uses "pl" for anything else.
const ENE_ABBREVIATIONS: Readonly<Record<string, string>> = { pk: "park", pl: "place" };

// Ordinal suffixes a person may type ("34th St", "42nd St"). Neither GTFS nor
// the feed fixtures write one after a number, so dropping them only helps
// queries. "st" is left alone: after a number it is almost always "Street".
const ORDINAL_SUFFIXES: ReadonlySet<string> = new Set(["th", "nd", "rd"]);

export function eneTokens(value: string): string[] {
  const raw = value
    .toLowerCase()
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
  return raw
    .filter((t, i) => !(i > 0 && /^\d+$/.test(raw[i - 1]) && ORDINAL_SUFFIXES.has(t)))
    .map((t) => ENE_ABBREVIATIONS[t] ?? t);
}

/** scoreStation's scale, over the elevator-feed normalization above. */
export function scoreEneStation(query: string, feedStation: string): number {
  return scoreTokens(eneTokens(query), eneTokens(feedStation));
}

// Street-type words. Dropped only in the reverse match below, where the feed's
// name is shorter than the GTFS one: "Cortlandt St" for GTFS "WTC Cortlandt".
const STREET_TYPES: ReadonlySet<string> = new Set(["st", "sts", "av", "avs", "sq", "rd", "blvd", "pkwy"]);

/**
 * Is the feed's name a shorter form of the GTFS name? Every feed word must
 * appear in the GTFS name, ignoring street-type words, and at least one of the
 * words that remain must not be a number. "Court Sq" is in "Court Sq-23 St";
 * "Cortlandt St" is in "WTC Cortlandt". A bare "125 St" is never enough.
 *
 * This is looser than scoreEneStation, so callers must confirm the match
 * another way. get_accessibility_outages uses it only with a stop_id, and only
 * for rows whose trainno shares a route with that station.
 */
export function feedNameWithin(gtfsName: string, feedStation: string): boolean {
  const gtfs = eneTokens(gtfsName);
  const feed = eneTokens(feedStation).filter((t) => !STREET_TYPES.has(t));
  if (!feed.some((t) => !/^\d+$/.test(t))) return false;
  return feed.every((t) => gtfs.includes(t));
}

// ─── Matching elevator-feed routes ───────────────────────────────────────────
//
// `trainno` is slash-separated, e.g. "A/C/E/L". Counted across the 126 rows of
// the current-feed fixture, it uses 1-7, A-G, J, L-N, Q, R, W, Z, "S" (6 rows)
// and "LIRR" (9 rows). It never uses a GTFS express or shuttle id: no 6X, 7X,
// FX, GS, FS, or H. So those route_ids are mapped to the token MTA does use:
//
//   6X -> 6, 7X -> 7, FX -> F   the express shares its local's name
//   GS -> S                     observed: all 6 "S" rows are at Times Sq-42 St,
//                               Grand Central-42 St, and 42St/Port Authority,
//                               the stations of the 42 St Shuttle and its complex
//   FS -> S, H -> S             NOT observed: no row sits on the Franklin Av or
//                               Rockaway Park shuttle. Mapped to "S" anyway, so a
//                               shuttle outage there is not missed. The cost is
//                               that a bare "S" row elsewhere matches too.
//
// The route_id itself is always accepted as well, in case MTA starts using it.

export const ENE_ROUTE_ALIASES: Readonly<Record<string, string>> = {
  "6X": "6",
  "7X": "7",
  FX: "F",
  GS: "S",
  FS: "S",
  H: "S",
};

/** The trainno tokens that count as this route. */
export function eneRouteTokens(routeId: string): string[] {
  const id = routeId.trim().toUpperCase();
  const alias = ENE_ROUTE_ALIASES[id];
  return alias ? [id, alias] : [id];
}

export function trainnoRoutes(trainno: string | undefined): string[] {
  return (trainno ?? "")
    .split(/[/,\s]+/)
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t.length > 0);
}

/**
 * Does the row's trainno include any of these tokens? `null` when trainno is
 * empty, meaning we cannot tell. Every fixture row has a trainno.
 */
export function rowMatchesRouteTokens(row: EneOutage, wanted: string[]): boolean | null {
  const routes = trainnoRoutes(row.trainno);
  if (routes.length === 0) return null;
  return routes.some((r) => wanted.includes(r));
}

// ─── Elevator-feed dates ─────────────────────────────────────────────────────
//
// `outagedate` and `estimatedreturntoservice` look like "09/16/2026 11:55:00 PM".
// All 252 values in the current-feed fixture fit MM/DD/YYYY hh:mm:ss AM|PM.
// MTA documents neither the format nor the time zone. We read them as New York
// wall-clock time, which is how the rest of this server reads dates.

const ENE_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ?(AM|PM)$/i;

/** Epoch ms, or null when the value is missing or not in the observed format. */
export function parseEneDateMs(value: string | undefined): number | null {
  const m = ENE_DATE.exec((value ?? "").trim());
  if (!m) return null;
  const [month, day, year, hour12, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour12 < 1 || hour12 > 12 || minute > 59 || second > 59) return null;
  // Reject 02/31 and friends rather than let Date roll them into March.
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const pm = m[7].toUpperCase() === "PM";
  const hour = (hour12 % 12) + (pm ? 12 : 0);
  return etWallClockMs(year, month, day, hour, minute, second);
}

export type EneDateCaveat = "unparseable_date" | "inconsistent_dates" | "estimate_passed";

/**
 * Does an outage's window overlap the New York day? Fails toward caution:
 *
 * - A missing or unparseable date keeps the row (`unparseable_date`).
 * - A return estimate before the start keeps the row (`inconsistent_dates`).
 * - A return estimate already past when the feed was fetched means MTA still
 *   lists the outage after it was due back, so the estimate is not trusted and
 *   the outage is treated as open-ended (`estimate_passed`).
 *
 * The window is [outagedate, estimatedreturntoservice), half-open like the
 * alert periods.
 */
export function eneOverlapsEtDay(
  row: EneOutage,
  dateIso: string,
  nowMs: number
): { overlaps: boolean; caveat: EneDateCaveat | null } {
  const { start: dayStart, end: dayEnd } = etDayBounds(dateIso);
  const start = parseEneDateMs(row.outagedate);
  const end = parseEneDateMs(row.estimatedreturntoservice);
  if (start === null || end === null) return { overlaps: true, caveat: "unparseable_date" };
  if (end < start) return { overlaps: true, caveat: "inconsistent_dates" };
  const passed = end <= nowMs;
  const effectiveEnd = passed ? Number.POSITIVE_INFINITY : end;
  const overlaps = start < dayEnd * 1000 && effectiveEnd > dayStart * 1000;
  // Flag only when the passed estimate is what kept the row in.
  const keptByPassed = passed && overlaps && !(end > dayStart * 1000);
  return { overlaps, caveat: keptByPassed ? "estimate_passed" : null };
}

export type WithinMatch = {
  /** true if no other station on the shared route has a closer name. */
  closest: boolean;
  /** Stations on the shared route whose GTFS name is closer to the row's. */
  closer_stop_ids: string[];
};

/**
 * With a stop_id: could this row, whose name is shorter than the station's
 * GTFS name, be at that station? `null` means no.
 *
 * Candidates are the stations on a route that both the row's trainno and the
 * target serve, whose GTFS name contains the feed name (feedNameWithin). The
 * closest name is the one with the fewest GTFS words left over. "Cortlandt St"
 * on the 1 is within both "WTC Cortlandt" (138, one word over) and "Van
 * Cortlandt Park-242 St" (101, four over), so 138 is closest.
 *
 * A candidate that is not the closest is still a candidate. It comes back with
 * closest:false and the closer stations named, and the caller returns the row
 * flagged instead of dropping it. A name heuristic is not strong enough to
 * hide an outage from a station it plausibly belongs to. Rows MTA's equipment
 * inventory can place by ID never reach this; see get_accessibility_outages.
 *
 * Counted on the 126 current-feed fixture rows, this finds 4 rows the forward
 * match missed: Cortlandt St (138), Court Sq (F09), and South Ferry (R27,
 * Whitehall St-South Ferry, which shares the R and W).
 */
export function eneRowWithinStation(stopId: string, row: EneOutage): WithinMatch | null {
  const target = stationById(stopId);
  if (!target || !row.station) return null;
  const rowRoutes = trainnoRoutes(row.trainno);
  if (rowRoutes.length === 0) return null;
  const feedWords = eneTokens(row.station).filter((t) => !STREET_TYPES.has(t)).length;
  const leftover = (s: Station) => eneTokens(s.stop_name).length - feedWords;
  // The routes this row and the target have in common. Only stations on one of
  // those compete, since only they could be confused with the target.
  const shared = target.routes.flatMap((r) => eneRouteTokens(r)).filter((r) => rowRoutes.includes(r));
  if (shared.length === 0) return null;
  const candidates = STATIONS.stations.filter(
    (s) =>
      s.routes.flatMap((r) => eneRouteTokens(r)).some((r) => shared.includes(r)) &&
      feedNameWithin(s.stop_name, row.station as string)
  );
  if (!candidates.some((c) => c.stop_id === stopId)) return null;
  const mine = leftover(target);
  const closer = candidates.filter((c) => leftover(c) < mine).map((c) => c.stop_id);
  return { closest: closer.length === 0, closer_stop_ids: closer };
}
