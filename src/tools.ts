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
  EFFECT_BY_ALERT_TYPE,
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
} from "./mta.js";

const EFFECTS = [
  "reduced",
  "changed",
  "delay",
  "informational",
  "added",
  "added_at_local_stops",
  "unknown",
] as const;

export const TOOLS = [
  {
    name: "check_route_on_date",
    description:
      "Is a subway route disrupted on a given date, optionally at one station? Dates are interpreted in America/New_York. Answers from MTA's service-alert feed. A station that only GAINS service (an express train running local) is reported as affected but NOT disrupted. Station-level absence is not absence of impact — read station_level_detail before treating disrupted:false as a guarantee. The station carries MTA's ADA status; elevator outages are included only with include_accessibility:true.",
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
    description:
      "List MTA subway service alerts active on a date, with optional filters. Defaults to today in America/New_York. Use this for open-ended questions like what is happening on a line this weekend.",
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
      },
    },
  },
  {
    name: "resolve_station",
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
      },
      required: ["query"],
    },
  },
  {
    name: "get_accessibility_outages",
    description:
      "Elevator and escalator outages in the subway: in effect now, scheduled, or overlapping one date, with MTA's alternate route for each elevator. With stop_id, rows are placed by equipment ID using MTA's equipment inventory, with name matching as a fallback; each row's matched_by says which. Zero matches is not proof of no outage, and no outage is not proof a station is usable; read no_match_note and station_accessibility.",
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
      },
    },
  },
];

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
  },
  resolve_station: { query: z.string(), route_id: z.string().optional() },
  get_accessibility_outages: {
    station: z.string().optional(),
    stop_id: z.string().optional(),
    route_id: z.string().optional(),
    date: z.string().optional(),
    upcoming: z.boolean().optional(),
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
  if (rejected.length === 0) throw parsed.error;
  throw new Error(
    `${tool} does not accept ${rejected.map((k) => `'${k}'`).join(", ")}. ` +
      `The parameters it accepts are: ${Object.keys(shape).join(", ")}. ` +
      `Unknown parameters are rejected rather than ignored, because ignoring one ` +
      `would return results that look right but answer a different question.`
  );
}

// ─── Shared shaping ──────────────────────────────────────────────────────────

/**
 * Provenance attached to every payload.
 *
 * `may_not_be_realtime` is unconditionally true, and that is deliberate. MTA's
 * data terms require telling the end user when output can lag the feed by more
 * than a minute; our cache TTL alone can do that, and MTA publishes no refresh
 * cadence for the feed itself, so no answer here is ever provably current.
 */
function provenance(fetchedAt: number, feedTimestamp?: number) {
  return {
    fetched_at: new Date(fetchedAt).toISOString(),
    feed_timestamp: feedTimestamp ?? null,
    feed_timestamp_iso: feedTimestamp ? new Date(feedTimestamp * 1000).toISOString() : null,
    may_not_be_realtime: true,
    staleness_note: `Responses are served from an in-process cache for up to ${Math.round(
      cacheTtlMs() / 1000
    )}s, and MTA does not publish a refresh cadence for this feed. Treat every result as possibly stale.`,
    data_source: DATA_SOURCE,
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

/** Shape one alert for output. `affected_stops` comes from informed_entity only. */
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
    alert_type_recognized: isKnownAlertType(alertType),
    effect,
    counts_as_disruption: isDisrupting(effect),
    planned: isPlannedWork(entity.id),
    routes: [...new Set((alert.informed_entity ?? []).map((e) => e.route_id).filter(Boolean))],
    header_text: englishText(alert.header_text),
    description_text: englishText(alert.description_text),
    human_readable_active_period: englishText(mercury?.human_readable_active_period),
    affected_stops: stops,
    active_periods: alert.active_period ?? [],
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
      `stop_id '${args.stop_id}' is not in the bundled station snapshot (${STATIONS.count} parent stations, generated ${STATIONS.generated_at}). Re-generate with 'npm run stations', or call resolve_station to find the right id.`
    );
  }
  if (!station && args.station) {
    // Resolve among the stations that actually serve this route. Names are not
    // unique — "125 St" is four stations on four lines — so the route is the
    // only honest disambiguator, and a remaining tie is returned, not guessed.
    const resolved = resolveStationStrict(args.station, args.route_id);
    if ("candidates" in resolved) {
      return {
        route_id: args.route_id,
        date,
        resolved: false,
        reason: ambiguityReason(args.station, args.route_id, resolved.reason),
        candidates: withAccessibility(resolved.candidates),
        ...provenance(Date.now()),
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
    return {
      ...shapeAlert(entity, [args.route_id]),
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
    };
  });

  const considered = station ? shaped.filter((a) => a.relevant_to_station) : shaped;
  const disrupted = considered.some((a) => a.counts_as_disruption);
  const stationLevelDetail = shaped.length > 0 && shaped.every((a) => a.station_level_detail);

  const unknownAlertTypes = [
    ...new Set(shaped.filter((a) => !a.alert_type_recognized).map((a) => a.alert_type)),
  ];

  // Opt-in only, and only once a station is known. One request to the current
  // elevator feed, through the same cache and gate as everything else.
  const accessibilityOutages =
    args.include_accessibility && station ? await accessibilityOnDate(station, date) : null;

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
    ...provenance(fetchedAt, feedTimestamp),
  };
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
    disrupting_alert_count: shaped.filter((a) => a.counts_as_disruption).length,
    unknown_alert_types: [
      ...new Set(shaped.filter((a) => !a.alert_type_recognized).map((a) => a.alert_type)),
    ],
    known_alert_types: Object.keys(EFFECT_BY_ALERT_TYPE),
    alerts: shaped,
    ...provenance(fetchedAt, feedTimestamp),
  };
}

function resolveStation(args: { query: string; route_id?: string }) {
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
    candidates: withAccessibility(matches),
    note: unambiguous
      ? null
      : "More than one station matches equally well. Pass route_id to narrow, or pick a stop_id from the candidates.",
    station_data: {
      generated_at: STATIONS.generated_at,
      source_url: STATIONS.source_url,
      station_count: STATIONS.count,
      route_membership: STATIONS.route_membership,
      note: "Static snapshot of MTA's subway GTFS, bundled so station lookup makes no network call. MTA updates the regular subway GTFS a few times a year; re-generate with 'npm run stations'.",
    },
    ada_data: adaData(),
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

// Our fields are omitted, not null, when they have nothing to say, and
// `inventory` comes only with a station filter. A route-wide or unfiltered
// answer is the big one, and it has no station to route around anyway.
export type ShapedOutage = EneOutage & {
  matched_by?: MatchedBy;
  match_note?: string;
  inventory?: InventoryInfo;
};

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

/** MTA's row unchanged, plus whichever of our three fields apply. */
function shapeOutage(
  row: EneOutage,
  matchedBy: MatchedBy | null,
  note: string | null = null,
  withInventory = true
): ShapedOutage {
  const out: ShapedOutage = { ...row };
  if (matchedBy) out.matched_by = matchedBy;
  if (note) out.match_note = note;
  const inventory = withInventory ? inventoryInfo(row) : null;
  if (inventory) out.inventory = inventory;
  return out;
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
      (MATCH_RANK[a.row.matched_by ?? ""] ?? 3) - (MATCH_RANK[b.row.matched_by ?? ""] ?? 3) ||
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
        `stop_id '${args.stop_id}' is not in the bundled station snapshot (${STATIONS.count} parent stations). Call resolve_station to find the right id.`
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

  let outages: ShapedOutage[];
  let complex: ShapedOutage[] | null = null;
  let otherStation: ShapedOutage[] | null = null;
  let withoutStation: number | null = null;
  if (station) {
    const placed = placeAtStation(byRoute, station);
    outages = placed.outages;
    complex = complexStopIds(station.stop_id).length > 0 ? placed.complex : null;
    otherStation = placed.other;
    withoutStation = placed.withoutStation;
  } else if (query) {
    const named = matchByName(byRoute, query);
    outages = named.outages;
    withoutStation = named.withoutStation;
  } else {
    outages = byRoute.map((row) => shapeOutage(row, null, null, false));
  }

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
    outage_count: outages.length,
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
      outages.length,
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
    ...provenance(fetchedAt),
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
  if (row.matched_by) out.matched_by = row.matched_by;
  if (row.match_note) out.match_note = row.match_note;
  if (row.inventory?.alternative_route) out.alternative_route = row.inventory.alternative_route;
  if (caveat) out.date_caveat = caveat;
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
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}
