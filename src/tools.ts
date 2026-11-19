import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  type Alert,
  type AlertEntity,
  type AlertsFeed,
  type Effect,
  type EneDateCaveat,
  type EneOutage,
  type InformedEntity,
  type Station,
  type StationMatch,
  DATA_SOURCE,
  DISCLAIMER,
  ENE_DATA_SOURCE,
  STATIONS_DATA_SOURCE,
  EFFECT_BY_ALERT_TYPE,
  FeedError,
  ENE_CURRENT_URL,
  EQUIPMENT,
  STATION_ADA,
  SUBWAY_ALERTS_URL,
  STATIONS,
  assertIsoDate,
  cacheTtlMs,
  adaElevatorsAt,
  complexStopIds,
  effectFor,
  equipmentByCode,
  eneFeedUrl,
  eneOverlapsEtDay,
  eneRouteTokens,
  eneRowWithinStation,
  englishText,
  fetchFeed,
  filterEneRows,
  isDisrupting,
  isKnownAlertType,
  overlapsEtDay,
  resolveStationMatches,
  resolveStationStrict,
  assertRouteFilterAvailable,
  rowMatchesRouteTokens,
  scoreEneStation,
  stationAccessibility,
  stationById,
  stationName,
  todayIso,
  VERSION,
} from "./mta.js";
import { type SnapshotName, SNAPSHOTS, snapshotFooter, stationListHint } from "./freshness.js";
import {
  type ToolResult,
  annotateTools,
  createBetanycTools,
  errorSummary,
  provenance as sourceLine,
  toolError,
} from "./betanyc-tools.js";

/**
 * whats_changed, about_betanyc and about_data, the three tools BetaNYC is adding to each of its
 * MCP servers (betanyc-ai-workspace platform/system/whats-changed-standard.md § 7 and
 * about-data-standard.md). betanyc-tools.ts is a copy of the workspace's canonical file: never
 * edit it here. This server is not on npm and runs from a local build, so WHATS-CHANGED.md and
 * DATA-SOURCES.json are read from the repository root, one level above dist/. None of the three
 * makes a network request.
 *
 * about_data's freshness: the two MTA feeds are "live" (read when a tool is called). The three
 * bundled snapshots answer with the same pull times the tools report in snapshot_as_of
 * (src/freshness.ts), read from the files in data/ that the update scripts write.
 */
export const betanyc = createBetanycTools({
  serverName: "mta-mcp",
  version: VERSION,
  repoUrl: "https://github.com/BetaNYC/mta-mcp",
  whatsChangedPath: new URL("../WHATS-CHANGED.md", import.meta.url),
  pageUrl: "https://betanyc.github.io/mta-mcp/whats-changed.html",
  dataSourcesPath: new URL("../DATA-SOURCES.json", import.meta.url),
  freshness: {
    stations_pulled: () => SNAPSHOTS.stations.asOf() ?? null,
    station_ada_pulled: () => SNAPSHOTS.station_ada.asOf() ?? null,
    equipment_pulled: () => SNAPSHOTS.equipment.asOf() ?? null,
  },
});

// List limits (issue #14): a default, a hard maximum, and offset to page. Counts in each
// answer (alert_count, outage_count, match_count) always cover every match, not just the page.
export const LIMITS = {
  get_service_alerts: { default: 20, max: 100, noun: "alerts" },
  get_accessibility_outages: { default: 50, max: 200, noun: "outages" },
  resolve_station: { default: 10, max: 50, noun: "stations" },
} as const;

function pagingProps(tool: keyof typeof LIMITS) {
  const l = LIMITS[tool];
  return {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: l.max,
      description: `Most ${l.noun} to return. Default ${l.default}, maximum ${l.max}.`,
    },
    offset: {
      type: "integer",
      minimum: 0,
      description: `Skip this many ${l.noun} first, to page through. Default 0; each answer's paging.next_offset gives the next one.`,
    },
  };
}

const pagingArgs = (tool: keyof typeof LIMITS) => ({
  limit: z.number().int().min(1).max(LIMITS[tool].max).optional(),
  offset: z.number().int().min(0).optional(),
});

/** One page of a list, and a paging block saying "showing N of M" and how to get the rest. */
export function page<T>(items: T[], tool: keyof typeof LIMITS, args: { limit?: number; offset?: number }) {
  const { default: def, noun } = LIMITS[tool];
  const limit = args.limit ?? def;
  const offset = args.offset ?? 0;
  const rows = items.slice(offset, offset + limit);
  const next = offset + rows.length < items.length ? offset + rows.length : null;
  const range = rows.length > 0 ? ` (${offset + 1} to ${offset + rows.length})` : "";
  return {
    rows,
    paging: {
      total: items.length,
      returned: rows.length,
      offset,
      limit,
      next_offset: next,
      showing:
        `Showing ${rows.length} of ${items.length} ${noun}${range}.` +
        (next !== null ? ` More are available: call again with offset ${next}.` : ""),
    },
  };
}

const EFFECTS = [
  "reduced",
  "changed",
  "delay",
  "informational",
  "added",
  "added_at_local_stops",
  "unknown",
] as const;

/**
 * The server's MCP `instructions`: what holds for every MTA tool, said once here
 * instead of in each description (issue #18), then when to call the three shared tools.
 */
export const INSTRUCTIONS: string = [
  "NYC subway service alerts, elevator and escalator outages, and station lookup, from MTA's public feeds, by BetaNYC. Unofficial: BetaNYC is not the MTA, and riders should confirm service at https://www.mta.info before they travel.",
  "In every answer, MTA's own fields are as MTA published them. What BetaNYC works out from them is kept apart in a `betanyc` object: for an alert, its effect, whether it counts as a disruption, whether it is planned work and whether its alert type is recognized; for an outage, how it was placed at a station and MTA's inventory details. Answers such as `disrupted` are BetaNYC's, not MTA's.",
  "Station names, routes, ADA status and the elevator inventory come from dated copies bundled with this server, which the user must refresh; `snapshot_as_of` gives their dates and `snapshot_warning` flags old ones. Service alerts and outages are read live from MTA, cached up to a minute, and may not be real time.",
  "Long lists come in pages: `paging.showing` says how many there are, and `offset: paging.next_offset` gets the next page. Counts cover every match.",
  betanyc.instructions,
].join("\n\n");

// Every tool only reads (readOnlyHint: true). openWorldHint is true for the three that call
// MTA's live feeds, false for resolve_station, which answers from the bundled snapshots.
// The shared tools declare their own annotations. Issue #10.
export const TOOLS = annotateTools([
  {
    name: "check_route_on_date",
    title: "Is a subway route disrupted on a date?",
    description:
      "Is a subway route disrupted on a given date, optionally at one station? Dates are interpreted in America/New_York. Answers from MTA's service-alert feed. A station that only GAINS service (an express train running local) is reported as affected but NOT disrupted. Station-level absence is not absence of impact — read station_level_detail before treating disrupted:false as a guarantee. The station carries MTA's ADA status; elevator outages are included only with include_accessibility:true. Each alert's `betanyc` object also says whether it bears on the station, and disrupted is BetaNYC's answer from those readings, not MTA's.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        route_id: {
          type: "string",
          description: "Subway route as MTA emits it: '6', '4', 'A', 'SI'.",
        },
        date: { type: "string", description: "Date to check, YYYY-MM-DD, Eastern Time." },
        stop_id: {
          type: "string",
          description: "GTFS parent-station id, e.g. '628' for 68 St-Hunter College.",
        },
        station: {
          type: "string",
          description:
            "Station name as free text, e.g. '68 St-Hunter College'. Resolved among the stations that serve route_id; if more than one still matches, the candidates are returned instead of a guess. Use stop_id when you already know it.",
        },
        include_accessibility: {
          type: "boolean",
          description:
            "Also list elevator and escalator outages at the station on this date, with MTA's alternate routes. Needs stop_id or station. Costs one extra request to MTA's elevator feed, so it is off by default.",
        },
      },
      required: ["route_id", "date"],
    },
  },
  {
    name: "get_service_alerts",
    title: "Subway service alerts",
    description:
      "List MTA subway service alerts active on a date, with optional filters. Defaults to today in America/New_York. Use this for open-ended questions like what is happening on a line this weekend. disrupting_alert_count counts the alerts BetaNYC reads as disruptions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        route_id: { type: "string", description: "Restrict to one route, e.g. '6'." },
        date: {
          type: "string",
          description: "Date the alert must be active on, YYYY-MM-DD. Defaults to today in Eastern Time.",
        },
        alert_type: {
          type: "string",
          description:
            "Exact MTA alert_type, e.g. 'Planned - Stops Skipped'. Not a fixed enum: MTA can emit a value this server has not seen.",
        },
        planned_only: {
          type: "boolean",
          description:
            "Only planned work, identified by an entity id beginning 'lmm:planned_work:' (149 of 150 entities in the reference pull). An observed convention, not an MTA-documented one.",
        },
        effect: {
          type: "string",
          enum: EFFECTS,
          description: "Restrict to one classified effect. 'unknown' means an alert_type this server does not recognize.",
        },
        ...pagingProps("get_service_alerts"),
      },
    },
  },
  {
    name: "resolve_station",
    title: "Find a subway station",
    description:
      "Resolve free-text station names to GTFS parent-station ids, ranked best first, with the routes serving each and MTA's ADA status. Reads a bundled snapshot of MTA's static GTFS — no network call. Station names are not unique: '125 St' is four different stations on four different lines, so every candidate is returned rather than one guessed. route_id is the disambiguator.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Station name or fragment, e.g. '68 St'." },
        route_id: {
          type: "string",
          description:
            "Restrict to stations served by this route, e.g. '6'. This is how an ambiguous name is narrowed to one station.",
        },
        ...pagingProps("resolve_station"),
      },
      required: ["query"],
    },
  },
  {
    name: "get_accessibility_outages",
    title: "Elevator and escalator outages",
    description:
      "Elevator and escalator outages in the subway: in effect now, scheduled, or overlapping one date, with MTA's alternate route for each elevator. With stop_id, rows are placed by equipment ID using MTA's equipment inventory, with name matching as a fallback. Each row's `betanyc` object says how it was placed (matched_by, match_note) and adds the inventory's details for that equipment. Zero matches is not proof of no outage, and no outage is not proof a station is usable; read no_match_note and station_accessibility.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        station: { type: "string", description: "Station name as free text, matched loosely." },
        stop_id: {
          type: "string",
          description:
            "GTFS parent-station id. Rows are placed by equipment ID first, from MTA's equipment inventory. Rows the inventory doesn't cover fall back to matching the station's name. Outages at other stations in the same complex go to complex_outages; name matches that belong to another station go to other_station_outages.",
        },
        route_id: {
          type: "string",
          description:
            "Only rows whose trainno includes this route, e.g. '6'. Express and shuttle ids are mapped to the names the feed uses: 6X to 6, 7X to 7, FX to F, and GS, FS, H to S.",
        },
        date: {
          type: "string",
          description:
            "YYYY-MM-DD, New York time. Returns outages in effect now or scheduled whose window overlaps that day, from the current feed alone. Cannot be combined with upcoming:true.",
        },
        upcoming: {
          type: "boolean",
          description:
            "false (default) returns outages in effect now; true returns scheduled future outages. true cannot be combined with date.",
        },
        ...pagingProps("get_accessibility_outages"),
      },
    },
  },
  // What's changed in this server, and who built it (BetaNYC standard tools).
  ...betanyc.tools,
], {
  check_route_on_date: true,
  get_service_alerts: true,
  get_accessibility_outages: true,
  resolve_station: false,
});

const ARG_SHAPES = {
  check_route_on_date: {
    route_id: z.string(),
    date: z.string(),
    stop_id: z.string().optional(),
    station: z.string().optional(),
    include_accessibility: z.boolean().optional(),
  },
  get_service_alerts: {
    route_id: z.string().optional(),
    date: z.string().optional(),
    alert_type: z.string().optional(),
    planned_only: z.boolean().optional(),
    effect: z.enum(EFFECTS).optional(),
    ...pagingArgs("get_service_alerts"),
  },
  resolve_station: { query: z.string(), route_id: z.string().optional(), ...pagingArgs("resolve_station") },
  get_accessibility_outages: {
    station: z.string().optional(),
    stop_id: z.string().optional(),
    route_id: z.string().optional(),
    date: z.string().optional(),
    upcoming: z.boolean().optional(),
    ...pagingArgs("get_accessibility_outages"),
  },
};

/**
 * Parse tool arguments strictly. zod strips unknown keys by default, which turns
 * a guessed parameter name into a silently dropped filter and an answer to a
 * different question than the one asked. `.strict()` raises instead, and the
 * message names the rejected key alongside the parameters this tool does accept.
 */
export function parseToolArgs<K extends keyof typeof ARG_SHAPES>(
  tool: K,
  args: unknown
): z.infer<z.ZodObject<(typeof ARG_SHAPES)[K]>> {
  const shape = ARG_SHAPES[tool];
  const parsed = z.object(shape).strict().safeParse(args ?? {});
  if (parsed.success) {
    return parsed.data as z.infer<z.ZodObject<(typeof ARG_SHAPES)[K]>>;
  }
  const rejected = parsed.error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys : []
  );
  if (rejected.length === 0) {
    // zod's own error is a JSON list of issues; say it as a sentence instead.
    const issues = parsed.error.issues.map((i) => {
      const where = i.path.length > 0 ? `'${i.path.join(".")}'` : "the arguments";
      return i.code === "invalid_type" && i.received === "undefined"
        ? `${where} is required`
        : `${where}: ${i.message}`;
    });
    throw new Error(
      `${tool} cannot use these arguments: ${issues.join("; ")}. Fix them and call again; the tool's input schema lists each parameter and its type.`
    );
  }
  throw new Error(
    `${tool} does not accept ${rejected.map((k) => `'${k}'`).join(", ")}. ` +
      `The parameters it accepts are: ${Object.keys(shape).join(", ")}. ` +
      `Unknown parameters are rejected rather than ignored, because ignoring one ` +
      `would return results that look right but answer a different question.`
  );
}

// ─── Shared shaping ──────────────────────────────────────────────────────────

// ─── What BetaNYC did to the data, in every answer ──────────────────────────
//
// BetaNYC's rule: when BetaNYC changes a publisher's data in any way, the answer says so, and
// says it the way about_data does. about_data answers "BetaNYC modified this data" for all five
// sources (DATA-SOURCES.json), so every MTA tool answer carries, in `data_provenance`, one
// shared-module provenance line per source it used: "BetaNYC modified this data: <what>. This
// copy should not be considered the official record. ... Official record: <MTA's feed or file>".
// The names, publisher and links come from DATA-SOURCES.json itself, so the two cannot drift.

type SourceId = "service-alerts" | "elevator-outages" | "stations" | "station-accessibility" | "elevator-inventory";

const DATA_SOURCES_FILE = JSON.parse(readFileSync(new URL("../DATA-SOURCES.json", import.meta.url), "utf8")) as {
  sources: { id: string; source_name: string; publisher: { name: string }; source_url: string }[];
};

/** What BetaNYC did to each source, as one short clause. Agrees with DATA-SOURCES.json `changes`. */
export const BETANYC_CHANGES: Record<SourceId, string> = {
  "service-alerts":
    "it kept only the alerts for this question; for header_text, description_text and human_readable_active_period it keeps one translation as plain text under MTA's field names (MTA's English one, or MTA's first one when there is no English) and drops the others; it added stop names from the station list and, in a separate betanyc object on each alert, its own reading of the alert (any disrupted answer or disruption count is BetaNYC's); MTA's other values are as MTA gave them",
  "elevator-outages":
    "it kept only the outages for this question and, when a station or name is given, lists them in its own order (best station match first); each row's fields are MTA's as published, and what BetaNYC adds (the station it placed the row at, how, and MTA's inventory details) is in a separate betanyc object",
  stations:
    "it built this station list from MTA's GTFS file (parent stations only) and worked out each station's routes from MTA's trips and stop times; where an answer lists station matches, their order and each score are BetaNYC's own ranking, not MTA's",
  "station-accessibility":
    "it kept only the ADA fields, direction labels and station ids, renamed three fields, and turned numbers stored as text into numbers; the ADA values are MTA's",
  "elevator-inventory":
    "it kept only the fields this server uses, turned numbers stored as text into numbers, and added the GTFS stations each piece of equipment is at",
};

const SNAPSHOT_SOURCE: Record<SnapshotName, SourceId> = {
  stations: "stations",
  station_ada: "station-accessibility",
  equipment: "elevator-inventory",
};

type LiveUse = { id: "service-alerts" | "elevator-outages"; fetchedAt: number; feedTimestamp?: number };

/** One provenance line per source an answer used, each saying BetaNYC modified it. */
function dataProvenance(live: LiveUse[], snapshots: SnapshotName[]) {
  const one = (id: SourceId, kind: "live" | "snapshot", asOf: string | null | undefined, now: Date) => {
    const src = DATA_SOURCES_FILE.sources.find((x) => x.id === id);
    if (!src) throw new Error(`DATA-SOURCES.json has no source '${id}'`);
    const p = sourceLine(
      {
        sourceName: src.source_name,
        publisher: src.publisher.name,
        sourceUrl: src.source_url,
        kind,
        asOf: asOf ?? null,
        changedByBetanyc: { kind: "modified-by-betanyc", detail: BETANYC_CHANGES[id] },
      },
      now
    );
    return { id, text: p.text, ...p.provenance };
  };
  return [
    ...live.map((l) =>
      one(l.id, "live", l.feedTimestamp ? new Date(l.feedTimestamp * 1000).toISOString() : null, new Date(l.fetchedAt))
    ),
    ...[...new Set(snapshots)].map((n) => one(SNAPSHOT_SOURCE[n], "snapshot", SNAPSHOTS[n].asOf(), new Date())),
  ];
}

/**
 * Provenance attached to every payload.
 *
 * `may_not_be_realtime` is unconditionally true, and that is deliberate. MTA's
 * data terms require telling the end user when output can lag the feed by more
 * than a minute; our cache TTL alone can do that, and MTA publishes no refresh
 * cadence for the feed itself, so no answer here is ever provably current.
 */
function provenance(fetchedAt: number, feedTimestamp?: number, dataSource: string = DATA_SOURCE) {
  return {
    fetched_at: new Date(fetchedAt).toISOString(),
    feed_timestamp: feedTimestamp ?? null,
    feed_timestamp_iso: feedTimestamp ? new Date(feedTimestamp * 1000).toISOString() : null,
    may_not_be_realtime: true,
    staleness_note: `Responses are served from an in-process cache for up to ${Math.round(
      cacheTtlMs() / 1000
    )}s, and MTA does not publish a refresh cadence for this feed. Treat every result as possibly stale.`,
    // The feed or feeds this answer read, with a link (issue #13).
    data_source: dataSource,
    disclaimer: DISCLAIMER,
  };
}

async function loadAlerts(): Promise<{ entities: AlertEntity[]; fetchedAt: number; feedTimestamp?: number }> {
  const { body, fetchedAt } = await fetchFeed(SUBWAY_ALERTS_URL);
  const feed = body as AlertsFeed;
  return {
    entities: feed.entity ?? [],
    fetchedAt,
    feedTimestamp: feed.header?.timestamp,
  };
}

function entitiesForRoute(alert: Alert, routeId: string): InformedEntity[] {
  return (alert.informed_entity ?? []).filter((e) => e.route_id === routeId);
}

const isPlannedWork = (entityId: string | undefined): boolean =>
  (entityId ?? "").startsWith("lmm:planned_work:");

/**
 * Shape one alert for output. `affected_stops` comes from informed_entity only.
 *
 * MTA's fields stay at the top level, with their values as MTA gives them (the text in the
 * English version where MTA gives one). What BetaNYC works out from them goes in `betanyc`, so
 * a reader can tell the two apart: MTA's terms (term 5) say "You will not modify or delete any
 * of the data", and these readings are BetaNYC's, not MTA's. See docs/terms-compliance.md.
 */
function shapeAlert(entity: AlertEntity, routeIds: string[] | null) {
  const alert = entity.alert ?? {};
  const mercury = alert["transit_realtime.mercury_alert"];
  const alertType = mercury?.alert_type;
  const effect = effectFor(alertType);
  const informed = routeIds
    ? (alert.informed_entity ?? []).filter((e) => e.route_id && routeIds.includes(e.route_id))
    : alert.informed_entity ?? [];
  // informed_entity, NOT mercury_alert.affected_stations. The latter lists the
  // whole route: on lmm:planned_work:33826 it includes stop 628, which is not
  // affected and is exactly the false positive this server exists to avoid.
  const stops = informed
    .filter((e) => e.stop_id)
    .map((e) => ({ stop_id: e.stop_id as string, stop_name: stationName(e.stop_id as string) }));
  return {
    entity_id: entity.id ?? null,
    alert_type: alertType ?? null,
    routes: [...new Set((alert.informed_entity ?? []).map((e) => e.route_id).filter(Boolean))],
    header_text: englishText(alert.header_text),
    description_text: englishText(alert.description_text),
    human_readable_active_period: englishText(mercury?.human_readable_active_period),
    affected_stops: stops,
    active_periods: alert.active_period ?? [],
    betanyc: {
      effect,
      counts_as_disruption: isDisrupting(effect),
      planned: isPlannedWork(entity.id),
      alert_type_recognized: isKnownAlertType(alertType),
    },
  };
}

// ─── Tool implementations ────────────────────────────────────────────────────

async function checkRouteOnDate(args: {
  route_id: string;
  date: string;
  stop_id?: string;
  station?: string;
  include_accessibility?: boolean;
}) {
  const date = assertIsoDate(args.date);
  if (args.include_accessibility && !args.stop_id && !args.station) {
    // Rejected rather than ignored: the outages are per station, and a
    // route-wide list would be a different, much larger answer.
    throw new Error(
      "include_accessibility needs a station. Pass stop_id or station, or call get_accessibility_outages with route_id and date for the whole route."
    );
  }

  let station = args.stop_id ? stationById(args.stop_id) : null;
  let matchedBy: string | null = args.stop_id ? "stop_id" : null;
  if (args.stop_id && !station) {
    // Fail loudly rather than dropping the filter: the static snapshot drifts
    // from the feed a few times a year, and a silently ignored stop_id would
    // widen the answer to the whole route.
    throw new Error(
      `stop_id '${args.stop_id}' is not in the bundled station snapshot (${STATIONS.count} parent stations). Call resolve_station to find the right id. ${stationListHint()}`
    );
  }
  if (!station && args.station) {
    // Resolve among the stations that actually serve this route. Names are not
    // unique — "125 St" is four stations on four lines — so the route is the
    // only honest disambiguator, and a remaining tie is returned, not guessed.
    const resolved = resolveStationStrict(args.station, args.route_id);
    if ("candidates" in resolved) {
      // Only the first 10 candidates are listed; candidate_count counts them all, and
      // resolve_station pages through every match. Nothing is fetched for this answer: it comes
      // from the bundled station and ADA copies, so it names them as its source, dated in
      // snapshot_as_of, and carries no fetched_at.
      const shown = resolved.candidates.slice(0, LIMITS.resolve_station.default);
      const total = resolved.candidates.length;
      return {
        route_id: args.route_id,
        date,
        resolved: false,
        reason: ambiguityReason(args.station, args.route_id, resolved.reason),
        candidate_count: total,
        candidates_showing: candidatesShowing(shown.length, total, args.station, args.route_id, resolved.reason),
        candidates: withAccessibility(shown),
        ...snapshotFooter(["stations", "station_ada"]),
        data_source: STATIONS_DATA_SOURCE,
        data_provenance: dataProvenance([], ["stations", "station_ada"]),
        disclaimer: DISCLAIMER,
      };
    }
    station = resolved.station;
    matchedBy = `station name, narrowed to route ${args.route_id}`;
  }

  const { entities, fetchedAt, feedTimestamp } = await loadAlerts();

  const matching = entities.filter(
    (e) =>
      entitiesForRoute(e.alert ?? {}, args.route_id).length > 0 &&
      overlapsEtDay(e.alert?.active_period, date)
  );

  const shaped = matching.map((entity) => {
    const alertType = entity.alert?.["transit_realtime.mercury_alert"]?.alert_type;
    const routeEntities = entitiesForRoute(entity.alert ?? {}, args.route_id);
    const taggedStops = routeEntities.filter((e) => e.stop_id).map((e) => e.stop_id);
    const hasStationDetail = taggedStops.length > 0;
    const tagsThisStation = station ? taggedStops.includes(station.stop_id) : false;
    const base = shapeAlert(entity, [args.route_id]);
    return {
      ...base,
      betanyc: {
        ...base.betanyc,
        // No station asked about → the question does not apply.
        affects_this_station: station ? tagsThisStation : null,
      // Three ways an alert bears on a specific station: MTA named it; MTA
      // named no stations at all (so the alert is route-wide as far as we
      // know); or the alert_type is one we do not recognize, in which case we
      // cannot claim to know what its station tagging means either. Fail
      // toward caution on all three.
        relevant_to_station: station
          ? tagsThisStation || !hasStationDetail || effectFor(alertType) === "unknown"
          : true,
        station_level_detail: hasStationDetail,
      },
    };
  });

  const considered = station ? shaped.filter((a) => a.betanyc.relevant_to_station) : shaped;
  const disrupted = considered.some((a) => a.betanyc.counts_as_disruption);
  const stationLevelDetail = shaped.length > 0 && shaped.every((a) => a.betanyc.station_level_detail);

  const unknownAlertTypes = [
    ...new Set(shaped.filter((a) => !a.betanyc.alert_type_recognized).map((a) => a.alert_type)),
  ];

  // Opt-in only, and only once a station is known. One request to the current
  // elevator feed, through the same cache and gate as everything else.
  const accessibilityOutages =
    args.include_accessibility && station ? await accessibilityOnDate(station, date) : null;

  const snapshotsUsed: SnapshotName[] = [
    "stations",
    ...(station ? (["station_ada"] as SnapshotName[]) : []),
    ...(accessibilityOutages ? (["equipment"] as SnapshotName[]) : []),
  ];

  return {
    route_id: args.route_id,
    date,
    disrupted,
    station: station
      ? {
          stop_id: station.stop_id,
          stop_name: station.stop_name,
          routes: station.routes,
          accessibility: stationAccessibility(station.stop_id),
        }
      : null,
    station_matched_by: matchedBy,
    station_serves_route: station ? station.routes.includes(args.route_id) : null,
    station_level_detail: stationLevelDetail,
    station_level_detail_note: stationLevelDetailNote(shaped.length, stationLevelDetail),
    alert_count: shaped.length,
    unknown_alert_types: unknownAlertTypes,
    alerts: shaped,
    accessibility_note: station
      ? `station.accessibility is MTA's station-level ADA status from a data.ny.gov snapshot pulled ${todayIso(new Date(STATION_ADA.source.data_pulled_at))}. It says whether the station has an accessible path, not whether it works on ${date}. ${
          accessibilityOutages
            ? "accessibility_outages lists elevator and escalator outages there that day."
            : "Pass include_accessibility:true for elevator and escalator outages that day."
        }`
      : null,
    accessibility_outages: accessibilityOutages,
    ...snapshotFooter(snapshotsUsed),
    ...provenance(
      fetchedAt,
      feedTimestamp,
      accessibilityOutages ? `${DATA_SOURCE}; ${ENE_DATA_SOURCE}` : DATA_SOURCE
    ),
    data_provenance: dataProvenance(
      [
        { id: "service-alerts", fetchedAt, feedTimestamp },
        ...(accessibilityOutages
          ? [{ id: "elevator-outages" as const, fetchedAt: Date.parse(accessibilityOutages.fetched_at) }]
          : []),
      ],
      snapshotsUsed
    ),
  };
}

/**
 * "Showing N of M" for the unresolved-station answer, saying which M it counts. For a tie, M is
 * the stations tied for the best match on the route; resolve_station lists those first and then
 * weaker matches, so its match_count can be larger. That is said here, so the two numbers are
 * not read as a contradiction.
 */
function candidatesShowing(
  shown: number,
  total: number,
  query: string,
  routeId: string,
  reason: "no-match" | "not-on-route" | "ambiguous"
): string {
  if (reason === "no-match") return "No station matches, so there are no candidates.";
  if (reason === "not-on-route") {
    return (
      `Showing ${shown} of ${total} stations whose name matches '${query}', none of them on route ${routeId}.` +
      (shown < total ? ` resolve_station with query '${query}' lists all ${total}, in pages.` : "")
    );
  }
  return (
    `Showing ${shown} of ${total} stations on route ${routeId} tied for the best match to '${query}'.` +
    (shown < total
      ? ` resolve_station with query '${query}' and route_id '${routeId}' lists these ${total} first, in pages, then weaker matches, so its match_count can be larger than ${total}.`
      : "")
  );
}

/** Candidates with MTA's ADA status, so a rider can choose among them. */
function withAccessibility(candidates: StationMatch[]) {
  return candidates.map((c) => ({ ...c, accessibility: stationAccessibility(c.stop_id) }));
}

/** Say which kind of non-answer this is, and what would fix it. */
function ambiguityReason(
  query: string,
  routeId: string,
  reason: "no-match" | "not-on-route" | "ambiguous"
): string {
  switch (reason) {
    case "no-match":
      return `No station matches '${query}'. Call resolve_station to see candidates.`;
    case "not-on-route":
      return `'${query}' matches a station, but none of the matches is served by route ${routeId} in MTA's static GTFS. The candidates listed here are the name matches on other routes.`;
    case "ambiguous":
      return `'${query}' still matches more than one station served by route ${routeId}. Pick one and pass its stop_id.`;
  }
}

/** MTA's own guidance, in the payload, so disrupted:false is never over-read. */
function stationLevelDetailNote(alertCount: number, stationLevelDetail: boolean): string {
  if (alertCount === 0) {
    return "No alert matched this route and date, so this is a route-level answer. MTA does not publish an all-clear; absence of an alert is not a guarantee of normal service.";
  }
  if (stationLevelDetail) {
    return "Every matching alert names the stations it affects, so the station-level answer rests on MTA's own tagging.";
  }
  return "At least one matching alert names no stations. MTA's spec says consumers should not assume every alert includes Stations Affected data, so a station not being listed does not mean it is unaffected.";
}

async function getServiceAlerts(args: {
  route_id?: string;
  date?: string;
  alert_type?: string;
  planned_only?: boolean;
  effect?: Effect;
  limit?: number;
  offset?: number;
}) {
  const date = args.date ? assertIsoDate(args.date) : todayIso();
  const { entities, fetchedAt, feedTimestamp } = await loadAlerts();

  const matching = entities.filter((entity) => {
    const alert = entity.alert ?? {};
    if (!overlapsEtDay(alert.active_period, date)) return false;
    if (args.route_id && entitiesForRoute(alert, args.route_id).length === 0) return false;
    const alertType = alert["transit_realtime.mercury_alert"]?.alert_type;
    if (args.alert_type && alertType !== args.alert_type) return false;
    if (args.planned_only && !isPlannedWork(entity.id)) return false;
    if (args.effect && effectFor(alertType) !== args.effect) return false;
    return true;
  });

  const shaped = matching.map((entity) =>
    shapeAlert(entity, args.route_id ? [args.route_id] : null)
  );

  return {
    date,
    filters: {
      route_id: args.route_id ?? null,
      alert_type: args.alert_type ?? null,
      planned_only: args.planned_only ?? false,
      effect: args.effect ?? null,
    },
    alert_count: shaped.length,
    disrupting_alert_count: shaped.filter((a) => a.betanyc.counts_as_disruption).length,
    unknown_alert_types: [
      ...new Set(shaped.filter((a) => !a.betanyc.alert_type_recognized).map((a) => a.alert_type)),
    ],
    known_alert_types: Object.keys(EFFECT_BY_ALERT_TYPE),
    ...(({ rows, paging }) => ({ paging, alerts: rows }))(page(shaped, "get_service_alerts", args)),
    // Stop names in affected_stops come from the station list.
    ...snapshotFooter(["stations"]),
    ...provenance(fetchedAt, feedTimestamp),
    data_provenance: dataProvenance([{ id: "service-alerts", fetchedAt, feedTimestamp }], ["stations"]),
  };
}

function resolveStation(args: { query: string; route_id?: string; limit?: number; offset?: number }) {
  if (args.route_id !== undefined) assertRouteFilterAvailable();
  const matches = resolveStationMatches(args.query, { routeId: args.route_id });
  const unambiguous =
    matches.length === 1 || (matches.length > 1 && matches[0].score > matches[1].score);
  return {
    query: args.query,
    route_id: args.route_id ?? null,
    match_count: matches.length,
    unambiguous,
    // Candidates are never collapsed. 193 of 496 parent stations share a name
    // with another station, so picking the first match is a coin flip dressed
    // up as an answer.
    ...(({ rows, paging }) => ({ paging, candidates: withAccessibility(rows) }))(
      page(matches, "resolve_station", args)
    ),
    note: unambiguous
      ? null
      : "More than one station matches equally well. Pass route_id to narrow, or pick a stop_id from the candidates.",
    station_data: {
      generated_at: STATIONS.generated_at,
      source_url: STATIONS.source_url,
      station_count: STATIONS.count,
      route_membership: STATIONS.route_membership,
      note: "A station list BetaNYC built from a dated copy of MTA's subway GTFS file (parent stations only), bundled so station lookup makes no network call. Each station's routes are worked out by BetaNYC from MTA's trips and stop times, and the order of the candidates and each score are BetaNYC's own ranking, not MTA's. MTA updates the regular subway GTFS a few times a year; re-generate with 'npm run stations'.",
    },
    ada_data: adaData(),
    ...snapshotFooter(["stations", "station_ada"]),
    // Nothing is fetched; both are bundled copies, dated in snapshot_as_of (issue #13).
    data_source: STATIONS_DATA_SOURCE,
    data_provenance: dataProvenance([], ["stations", "station_ada"]),
    disclaimer: DISCLAIMER,
  };
}

// ─── Elevators and escalators: placing outage rows at a station ─────────────
//
// The outage feed names each row's station in free text. MTA's equipment
// inventory (data/equipment.json, from data.ny.gov 94fv-bak7) places each piece
// of equipment at a station by ID. With a stop_id, the ID wins. Name matching
// is the fallback for rows the inventory doesn't cover, and the evidence when
// the two disagree inside one station complex.

export type MatchedBy = "equipment id" | "name" | "partial name";

type InventoryInfo = {
  stop_ids: string[];
  ada_compliant: string | null;
  redundant_elevator: string | null;
  alternative_route: string | null;
};

// MTA's row keeps MTA's fields and values. What BetaNYC adds goes in `betanyc`,
// apart from them (MTA's terms, term 5; see docs/terms-compliance.md), the same
// way as on service alerts. Our fields are omitted, not null, when they have
// nothing to say, and `betanyc` itself is omitted when it would be empty.
// `inventory` comes only with a station filter. A route-wide or unfiltered
// answer is the big one, and it has no station to route around anyway.
export type OutageAdditions = {
  matched_by?: MatchedBy;
  match_note?: string;
  inventory?: InventoryInfo;
};
export type ShapedOutage = EneOutage & { betanyc?: OutageAdditions };

/** What the inventory adds to an outage row, or null if it has no such code. */
function inventoryInfo(row: EneOutage): InventoryInfo | null {
  const eq = equipmentByCode(row.equipment);
  if (!eq) return null;
  return {
    stop_ids: eq.stop_ids,
    ada_compliant: eq.ada_compliant,
    redundant_elevator: eq.redundant_elevator,
    alternative_route: eq.alternative_route,
  };
}

/** MTA's row unchanged, plus whichever of our three fields apply, in `betanyc`. */
function shapeOutage(
  row: EneOutage,
  matchedBy: MatchedBy | null,
  note: string | null = null,
  withInventory = true
): ShapedOutage {
  const ours: OutageAdditions = {};
  if (matchedBy) ours.matched_by = matchedBy;
  if (note) ours.match_note = note;
  const inventory = withInventory ? inventoryInfo(row) : null;
  if (inventory) ours.inventory = inventory;
  return Object.keys(ours).length > 0 ? { ...row, betanyc: ours } : { ...row };
}

const describeStops = (ids: string[]): string =>
  ids.map((id) => `${stationName(id) ?? "unknown"} (${id})`).join(" and ");

type NameMatch = { matchedBy: MatchedBy; score: number; note: string | null };

/**
 * Does the row's free-text station name point at this station? Forward first
 * (the station's GTFS name found in the row's name), then the shorter-name
 * rule. A shorter-name match that another station on the same route matches
 * more closely is still returned, with a note, rather than dropped.
 */
function nameMatchAt(station: Station, row: EneOutage): NameMatch | null {
  if (!row.station) return null;
  const forward = scoreEneStation(station.stop_name, row.station);
  if (forward > 0) return { matchedBy: "name", score: forward, note: null };
  const within = eneRowWithinStation(station.stop_id, row);
  if (!within) return null;
  const note = within.closest
    ? null
    : `Matched on part of the name only, and ${describeStops(within.closer_stop_ids)} on the same route matches '${row.station}' more closely. Listed here because it could still be this station; check serving and trainno.`;
  return { matchedBy: "partial name", score: 20, note };
}

type Placement = {
  outages: ShapedOutage[];
  complex: ShapedOutage[];
  other: ShapedOutage[];
  /** Returned rows with no station name that the inventory couldn't place. */
  withoutStation: number;
};

const MATCH_RANK: Record<string, number> = { "equipment id": 0, name: 1, "partial name": 2 };

/**
 * Sort rows for one station into this station, another station in its
 * complex, and a same-named station elsewhere.
 *
 * 1. The inventory places the equipment here: `outages`, by equipment id.
 * 2. The inventory places it at another station in this complex. If the
 *    feed's name fits this station, it stays in `outages`, with a note saying
 *    where the inventory puts it. (EL613 and EL617 are "6 Av" in the feed,
 *    which is L02, and at 14 St, D19 and 132, in the inventory. ES218 is
 *    "Times Sq-42 St", a name four stations share.) Otherwise it goes to
 *    `complex`.
 * 3. The inventory places it outside the complex. A name match goes to
 *    `other`, with where the inventory puts it. No name match, no row.
 * 4. Not in the inventory: the name rules from before, and a row whose trainno
 *    shares no route with the station goes to `other`. A row with no station
 *    name can't be ruled out, so it stays.
 */
function placeAtStation(rows: EneOutage[], station: Station): Placement {
  const complexIds = new Set(complexStopIds(station.stop_id));
  const stationTokens = [...new Set(station.routes.flatMap((r) => eneRouteTokens(r)))];
  const here: { row: ShapedOutage; score: number }[] = [];
  const complex: ShapedOutage[] = [];
  const other: ShapedOutage[] = [];
  let withoutStation = 0;

  for (const row of rows) {
    const eq = equipmentByCode(row.equipment);
    const name = nameMatchAt(station, row);
    if (eq && eq.stop_ids.length > 0) {
      if (eq.stop_ids.includes(station.stop_id)) {
        here.push({ row: shapeOutage(row, "equipment id"), score: 1000 });
        continue;
      }
      const where = describeStops(eq.stop_ids);
      if (eq.stop_ids.some((id) => complexIds.has(id))) {
        // The feed's name fits this station, so keep it here, and say where the
        // inventory puts it. Often several stations in a complex share the
        // feed's name (Times Sq, Fulton St), and the equipment may serve more
        // than the one station it is coded to. Listing it costs a line;
        // leaving it out could hide the outage that blocks someone's path.
        if (name) {
          here.push({
            row: shapeOutage(
              row,
              name.matchedBy,
              `MTA's equipment inventory places ${eq.equipment_code} at ${where}, another station in this complex. The outage feed's station name fits this station too, so it is listed here.`
            ),
            score: name.score,
          });
        } else {
          complex.push(shapeOutage(row, "equipment id", `At ${where}, in the same station complex.`));
        }
        continue;
      }
      if (name) {
        other.push(
          shapeOutage(row, name.matchedBy, `Matched by name, but MTA's equipment inventory places ${eq.equipment_code} at ${where}.`)
        );
      }
      continue;
    }

    if (!row.station) {
      withoutStation += 1;
      here.push({
        row: shapeOutage(row, null, "This row has no station name and isn't in MTA's equipment inventory, so it can't be ruled out."),
        score: 1,
      });
      continue;
    }
    if (!name) continue;
    const shaped = shapeOutage(row, name.matchedBy, name.note);
    if (rowMatchesRouteTokens(row, stationTokens) === false) other.push(shaped);
    else here.push({ row: shaped, score: name.score });
  }

  here.sort(
    (a, b) =>
      (MATCH_RANK[a.row.betanyc?.matched_by ?? ""] ?? 3) - (MATCH_RANK[b.row.betanyc?.matched_by ?? ""] ?? 3) ||
      b.score - a.score
  );
  return { outages: here.map((h) => h.row), complex, other, withoutStation };
}

/** Free text, no stop_id: name matching only, as the feed spells it. */
function matchByName(rows: EneOutage[], query: string): { outages: ShapedOutage[]; withoutStation: number } {
  const scored = rows
    .map((row) => ({ row, score: row.station ? scoreEneStation(query, row.station) : 1 }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    outages: scored.map((r) =>
      r.row.station
        ? shapeOutage(r.row, "name")
        : shapeOutage(r.row, null, "This row has no station name, so it can't be ruled out.")
    ),
    withoutStation: scored.filter((r) => !r.row.station).length,
  };
}

/** Keep rows whose window overlaps the date, recording why a row was kept anyway. */
function filterByDate(
  rows: EneOutage[],
  date: string,
  fetchedAt: number
): { kept: EneOutage[]; caveatOf: Map<EneOutage, EneDateCaveat> } {
  const caveatOf = new Map<EneOutage, EneDateCaveat>();
  const kept = rows.filter((row) => {
    const { overlaps, caveat } = eneOverlapsEtDay(row, date, fetchedAt);
    if (overlaps && caveat) caveatOf.set(row, caveat);
    return overlaps;
  });
  return { kept, caveatOf };
}

function inventoryData() {
  return {
    data_pulled_at: EQUIPMENT.source.data_pulled_at,
    source_url: EQUIPMENT.source.page_url,
    note: "Each row's inventory block comes from MTA's elevator and escalator inventory on data.ny.gov, bundled as a snapshot. alternative_route is MTA's own text, kept by hand, and it can lag or describe a different situation than today's. Quote it as MTA's and confirm at mta.info.",
  };
}

function adaData() {
  return {
    data_pulled_at: STATION_ADA.source.data_pulled_at,
    source_url: STATION_ADA.source.page_url,
    note: "MTA's station-level ADA status, bundled as a snapshot. It says whether a station has an accessible path, not whether that path works today. An elevator outage can make an accessible station unusable, and no listed outage is not proof it is usable.",
  };
}

async function getAccessibilityOutages(args: {
  station?: string;
  stop_id?: string;
  route_id?: string;
  date?: string;
  upcoming?: boolean;
  limit?: number;
  offset?: number;
}) {
  if (args.date !== undefined && args.upcoming === true) {
    // Two different questions. `date` already covers outages in effect now and
    // scheduled ones, so honoring upcoming:true as well would mean silently
    // ignoring one of them. upcoming:false is the default and is accepted.
    throw new Error(
      "get_accessibility_outages takes date or upcoming:true, not both. date returns every outage, in effect now or scheduled, whose window overlaps that day. Drop upcoming and call again."
    );
  }
  const date = args.date !== undefined ? assertIsoDate(args.date) : null;
  const upcoming = date ? null : args.upcoming ?? false;

  let query = args.station ?? null;
  let station: Station | null = null;
  if (args.stop_id) {
    station = stationById(args.stop_id);
    if (!station) {
      throw new Error(
        `stop_id '${args.stop_id}' is not in the bundled station snapshot (${STATIONS.count} parent stations). Call resolve_station to find the right id. ${stationListHint()}`
      );
    }
    query = station.stop_name;
  }

  // A date query reads only the current feed, one request. That relies on the
  // current feed carrying every scheduled outage: all 47 upcoming rows were in
  // its 126 in the 2026-09-17 fixtures, but MTA does not document it. The
  // payload's feed_note says so, as does docs/accessibility.md.
  const url = date ? ENE_CURRENT_URL : eneFeedUrl(upcoming as boolean);
  const { body, fetchedAt } = await fetchFeed(url);
  const all = (body as EneOutage[]) ?? [];
  const rows = date ? all : filterEneRows(all, upcoming as boolean);

  // Date. Rows whose dates cannot be read are kept and listed in date_caveats.
  // "Now" is when the feed was fetched: a row still listed then, after its
  // estimated return, is overdue rather than fixed.
  const { kept: byDate, caveatOf } = date
    ? filterByDate(rows, date, fetchedAt)
    : { kept: rows, caveatOf: new Map<EneOutage, EneDateCaveat>() };

  // Route. A row with no trainno cannot be ruled out, so it stays.
  const routeTokens = args.route_id !== undefined ? eneRouteTokens(args.route_id) : null;
  const byRoute = routeTokens
    ? byDate.filter((row) => rowMatchesRouteTokens(row, routeTokens) !== false)
    : byDate;

  let allOutages: ShapedOutage[];
  let complex: ShapedOutage[] | null = null;
  let otherStation: ShapedOutage[] | null = null;
  let withoutStation: number | null = null;
  if (station) {
    const placed = placeAtStation(byRoute, station);
    allOutages = placed.outages;
    complex = complexStopIds(station.stop_id).length > 0 ? placed.complex : null;
    otherStation = placed.other;
    withoutStation = placed.withoutStation;
  } else if (query) {
    const named = matchByName(byRoute, query);
    allOutages = named.outages;
    withoutStation = named.withoutStation;
  } else {
    allOutages = byRoute.map((row) => shapeOutage(row, null, null, false));
  }

  // One page of the rows placed at this station or matched by name (issue #14). The other
  // two lists stay whole: they hold outages at nearby stations, a handful at most.
  const { rows: outages, paging } = page(allOutages, "get_accessibility_outages", args);

  // Caveats only for rows this answer actually returns. Rows are compared by
  // equipment and dates, since the shaped rows are copies.
  const returned = [...outages, ...(complex ?? []), ...(otherStation ?? [])];
  const dateCaveats = date
    ? byRoute
        .filter((row) => caveatOf.has(row))
        .filter((row) =>
          returned.some(
            (o) =>
              o.equipment === row.equipment &&
              o.outagedate === row.outagedate &&
              o.estimatedreturntoservice === row.estimatedreturntoservice
          )
        )
        .map((row) => ({
          equipment: row.equipment ?? null,
          station: row.station ?? null,
          outagedate: row.outagedate ?? null,
          estimatedreturntoservice: row.estimatedreturntoservice ?? null,
          caveat: caveatOf.get(row) as EneDateCaveat,
        }))
    : null;

  const accessibility = station ? stationAccessibility(station.stop_id) : null;
  // Only the files this answer read: the inventory places rows only when
  // there is a station or a name to place them at.
  const snapshotsUsed: SnapshotName[] = station ? ["equipment", "stations", "station_ada"] : query ? ["equipment"] : [];

  return {
    upcoming,
    date,
    feed_url: url,
    query: query ?? null,
    stop_id: args.stop_id ?? null,
    route_id: args.route_id ?? null,
    route_tokens_matched: routeTokens,
    route_note: routeTokens?.includes("S")
      ? "MTA's elevator feed writes every shuttle as 'S' and does not say which one. Rows at another shuttle's stations may be included; check each row's station."
      : null,
    station_accessibility: accessibility,
    matched_by: station
      ? "equipment id first: each row's equipment code is looked up in MTA's equipment inventory, which places it at a station by ID. Rows the inventory doesn't place fall back to the station's name. Each row's matched_by says which."
      : query
        ? "station name, matched loosely — MTA reports these outages with a free-text station name, not a GTFS stop_id, and the two spellings do not always agree. Pass stop_id to place rows by equipment ID instead."
        : null,
    outage_count: allOutages.length,
    paging,
    rows_in_feed: rows.length,
    rows_without_station: query ? withoutStation : null,
    feed_note: date
      ? `Outages in effect now or scheduled whose window overlaps ${date} in New York time. Read from MTA's current feed alone, which relies on that feed containing every scheduled outage. We counted that in our saved copy of both feeds, but MTA does not document it. outagedate and estimatedreturntoservice carry no time zone; they are read as New York time. See date_caveats for rows kept without a reliable window.`
      : upcoming
        ? "Scheduled future outages."
        : "Outages in effect now. MTA's current feed also carries rows flagged isupcomingoutage 'Y'; those are excluded here and are what upcoming:true returns.",
    no_match_note: noMatchNote(
      query,
      args.route_id ?? null,
      allOutages.length,
      otherStation?.length ?? 0,
      complex?.length ?? 0,
      rows,
      date !== null,
      station
    ),
    date_caveats: dateCaveats,
    outages,
    complex_outages: complex,
    other_station_outages: otherStation,
    inventory_data: inventoryData(),
    ada_data: station ? adaData() : null,
    ...snapshotFooter(snapshotsUsed),
    ...provenance(fetchedAt, undefined, ENE_DATA_SOURCE),
    data_provenance: dataProvenance([{ id: "elevator-outages", fetchedAt }], snapshotsUsed),
  };
}

/** Compact outage rows for check_route_on_date, where the route answer comes first. */
function compactOutage(row: ShapedOutage, caveat: EneDateCaveat | undefined) {
  const out: Record<string, unknown> = {
    equipment: row.equipment ?? null,
    equipmenttype: row.equipmenttype ?? null,
    serving: row.serving ?? null,
    ADA: row.ADA ?? null,
    outagedate: row.outagedate ?? null,
    estimatedreturntoservice: row.estimatedreturntoservice ?? null,
    reason: row.reason ?? null,
  };
  // BetaNYC's additions, apart from MTA's fields, as in the full rows.
  const ours: Record<string, unknown> = {};
  if (row.betanyc?.matched_by) ours.matched_by = row.betanyc.matched_by;
  if (row.betanyc?.match_note) ours.match_note = row.betanyc.match_note;
  if (row.betanyc?.inventory?.alternative_route) ours.alternative_route = row.betanyc.inventory.alternative_route;
  if (caveat) ours.date_caveat = caveat;
  if (Object.keys(ours).length > 0) out.betanyc = ours;
  return out;
}

/**
 * Elevator and escalator outages at one station on one date, for
 * check_route_on_date. One request to the current feed, through the same
 * cache and gate as every other request.
 */
async function accessibilityOnDate(station: Station, date: string) {
  const { body, fetchedAt } = await fetchFeed(ENE_CURRENT_URL);
  const rows = (body as EneOutage[]) ?? [];
  const { kept, caveatOf } = filterByDate(rows, date, fetchedAt);
  const placed = placeAtStation(kept, station);
  const caveatFor = (o: ShapedOutage) =>
    [...caveatOf.entries()].find(
      ([row]) =>
        row.equipment === o.equipment &&
        row.outagedate === o.outagedate &&
        row.estimatedreturntoservice === o.estimatedreturntoservice
    )?.[1];
  const inComplex = complexStopIds(station.stop_id).length > 0;
  const none = placed.outages.length === 0;
  return {
    feed_url: ENE_CURRENT_URL,
    fetched_at: new Date(fetchedAt).toISOString(),
    outage_count: placed.outages.length,
    outages: placed.outages.map((o) => compactOutage(o, caveatFor(o))),
    complex_outages: inComplex ? placed.complex.map((o) => compactOutage(o, caveatFor(o))) : null,
    other_station_outage_count: placed.other.length,
    note: [
      `Outages in effect or scheduled on ${date}, from MTA's current elevator feed. alternative_route is MTA's text from a bundled inventory snapshot and can lag.`,
      none ? `No outage is listed here.${accessibilityContext(station.stop_id)}` : null,
      "A missing outage is not proof the station is usable: the feed can lag, and an outage MTA hasn't entered won't show.",
      placed.other.length > 0
        ? "Some rows matched the name but belong to another station; get_accessibility_outages with this stop_id lists them."
        : null,
      "Confirm at https://www.mta.info/elevator-escalator-status before travel.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * One sentence on what an empty outage list means at a station MTA lists as
 * not accessible. Four such stations have ADA-compliant elevators coded to
 * them (415, 635, D16, M04), so "there may be no elevator" would be wrong
 * there. Empty for any other status.
 */
function accessibilityContext(stopId: string): string {
  if (stationAccessibility(stopId).status !== "not_accessible") return "";
  const elevators = adaElevatorsAt(stopId);
  if (elevators.length === 0) {
    return " MTA lists this station as not accessible, and its inventory codes no ADA-compliant elevator here, so there may be no elevator to report.";
  }
  return ` MTA lists this station as not accessible, but its inventory codes ${elevators.length} ADA-compliant elevator(s) here (${elevators.join(", ")}), so an outage could still matter.`;
}

/**
 * Why an elevator search came back empty, and what to try next. A zero from a
 * name search is the answer most likely to be wrong, so it never goes out bare.
 */
function noMatchNote(
  query: string | null,
  routeId: string | null,
  outageCount: number,
  otherStationCount: number,
  complexCount: number,
  feedRows: EneOutage[],
  dateFilter: boolean,
  station: Station | null
): string | null {
  if (outageCount > 0 || (!query && !routeId)) return null;
  const retry =
    "Search again with a short, distinctive part of the name, like 'Port Authority' or 'Bedford', and check each row's station and trainno.";
  const notAccessible = station ? accessibilityContext(station.stop_id) : "";
  const complexNote =
    complexCount > 0
      ? ` ${complexCount} outage(s) at other stations in the same complex are in complex_outages.`
      : "";
  if (station) {
    const other =
      otherStationCount > 0
        ? ` ${otherStationCount} row(s) matched the name but belong to another station; they are in other_station_outages.`
        : "";
    const filtered =
      dateFilter || routeId ? " Run it again without date or route_id to see every outage at this station." : "";
    return `No outage row is at this station, by equipment ID or by name.${complexNote}${other}${notAccessible} A missing outage is not proof the station is usable: the feed can lag, and a row MTA's inventory doesn't cover is matched by name only.${filtered}`;
  }
  const nameInFeed = query ? feedRows.some((r) => scoreEneStation(query, r.station ?? "") > 0) : false;
  const routeInFeed = routeId
    ? feedRows.some((r) => rowMatchesRouteTokens(r, eneRouteTokens(routeId)) === true)
    : false;
  if (routeId && !routeInFeed) {
    return `No row in the feed lists route '${routeId}' in its trainno. That is not proof there is no outage: check the route id (the feed writes the diamond 6 as '6' and every shuttle as 'S'), or search by station instead.`;
  }
  if (query && nameInFeed && (dateFilter || routeId)) {
    return `'${query}' matches outage rows in the feed, but none that pass the date or route filter. Run it again without the filter to see them.`;
  }
  if (query) {
    return `No outage row matched '${query}'. That is not proof there is no outage: MTA's elevator feed spells some stations differently from the station list, and this server only normalizes the differences it has seen. ${retry} Or pass stop_id, which places rows by equipment ID.`;
  }
  return `No outage on route '${routeId}' passes the date filter. That is not proof there is no outage: the dates are MTA's estimates. Run it again without date to see every outage on the route.`;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export async function callTool(name: string, args: unknown) {
  // The shared tools answer in plain text plus structuredContent; they never touch MTA.
  // Every freshness hook is synchronous, so the sync call is enough.
  if (betanyc.handles(name)) return betanyc.call(name, args);
  try {
    switch (name) {
      case "check_route_on_date": {
        const parsed = parseToolArgs("check_route_on_date", args);
        const result = await checkRouteOnDate(parsed);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "get_service_alerts": {
        const parsed = parseToolArgs("get_service_alerts", args);
        const result = await getServiceAlerts(parsed);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "resolve_station": {
        const parsed = parseToolArgs("resolve_station", args);
        const result = resolveStation(parsed);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      case "get_accessibility_outages": {
        const parsed = parseToolArgs("get_accessibility_outages", args);
        const result = await getAccessibilityOutages(parsed);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      default:
        return toolError(
          `Unknown tool: ${name}. This server's tools are: ${TOOLS.map((t) => t.name).join(", ")}.`
        );
    }
  } catch (err) {
    return errorResult(err);
  }
}

const REPORT_BUG = "https://github.com/BetaNYC/mta-mcp/issues";

/**
 * Every failure as an isError result: one plain sentence on what went wrong and
 * what to try, MTA's response body cut to 500 characters, no stack trace
 * (toolError, from the shared module, starts the text with "Error: "). Issue
 * #12. The tools' own errors are already sentences; a failed request to MTA is
 * put into words here.
 */
export function errorResult(err: unknown): ToolResult {
  if (err instanceof FeedError) {
    const feed = ` Feed: ${err.url}`;
    let message: string;
    if (err.notJson) {
      message = `MTA's feed answered, but with a web page or other text instead of data. That usually means MTA's feed is down for maintenance. Try again in a few minutes. For service right now, check https://www.mta.info.${feed}`;
    } else if (err.timedOut) {
      message = `MTA's feed did not answer within 15 seconds. Try again in a minute. For service right now, check https://www.mta.info.${feed}`;
    } else if (err.status === null) {
      message = `Could not reach MTA's feed (${errorSummary(err.reason || err)}). Check this computer's internet connection and try again.${feed}`;
    } else if (err.status === 404) {
      message = `MTA's feed answered 404 Not Found, so the feed address may have moved. Please report a bug in this server at ${REPORT_BUG}.${feed}`;
    } else if (err.status === 429) {
      message = `MTA's feed asked for fewer requests (HTTP 429) and was still saying so after two retries. Wait a minute and try again.${feed}`;
    } else if (err.status >= 500) {
      message = `MTA's feed had a problem on its side (HTTP ${err.status}) and was still failing after two retries. Try again in a few minutes. For service right now, check https://www.mta.info.${feed}`;
    } else {
      message = `MTA's feed refused the request (HTTP ${err.status}). That is likely a bug in this server; please report it at ${REPORT_BUG}.${feed}`;
    }
    return toolError(`${message}`, { upstreamBody: err.body });
  }
  // The tools' own errors are one plain sentence. The shared toolError drops stack-frame lines
  // and caps the length (shared module 1.5.2); errorSummary also drops a frame line that is not
  // indented and keeps only the first plain line, so nothing but the sentence reaches the user.
  if (err instanceof Error) return toolError(errorSummary(err, 1_000));
  return toolError(`The tool failed unexpectedly (${errorSummary(err)}). Please report a bug in this server at ${REPORT_BUG}.`);
}
