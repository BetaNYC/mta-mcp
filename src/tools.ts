import { z } from "zod";
import {
  type Alert,
  type AlertEntity,
  type AlertsFeed,
  type Effect,
  type EneDateCaveat,
  type EneOutage,
  type InformedEntity,
  DATA_SOURCE,
  DISCLAIMER,
  EFFECT_BY_ALERT_TYPE,
  ENE_CURRENT_URL,
  SUBWAY_ALERTS_URL,
  STATIONS,
  assertIsoDate,
  cacheTtlMs,
  effectFor,
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
      "Is a subway route disrupted on a given date, optionally at one station? Dates are interpreted in America/New_York. Answers from MTA's service-alert feed. A station that only GAINS service (an express train running local) is reported as affected but NOT disrupted. Station-level absence is not absence of impact — read station_level_detail before treating disrupted:false as a guarantee.",
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
      "Resolve free-text station names to GTFS parent-station ids, ranked best first, with the routes serving each. Reads a bundled snapshot of MTA's static GTFS — no network call. Station names are not unique: '125 St' is four different stations on four different lines, so every candidate is returned rather than one guessed. route_id is the disambiguator.",
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
      "Elevator and escalator outages in the subway: in effect now, scheduled, or overlapping one date. MTA names stations in free text rather than by stop_id, so station matching is by name and is reported as such. Zero matches is not proof of no outage; read no_match_note.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        station: { type: "string", description: "Station name as free text, matched loosely." },
        stop_id: {
          type: "string",
          description:
            "GTFS parent-station id. Its name is looked up and matched loosely, including feed names shorter than the GTFS name when the row shares a route with the station. Rows whose trainno shares no route with the station are moved to other_station_outages.",
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
}) {
  const date = assertIsoDate(args.date);

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
        candidates: resolved.candidates,
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

  return {
    route_id: args.route_id,
    date,
    disrupted,
    station: station
      ? { stop_id: station.stop_id, stop_name: station.stop_name, routes: station.routes }
      : null,
    station_matched_by: matchedBy,
    station_serves_route: station ? station.routes.includes(args.route_id) : null,
    station_level_detail: stationLevelDetail,
    station_level_detail_note: stationLevelDetailNote(shaped.length, stationLevelDetail),
    alert_count: shaped.length,
    unknown_alert_types: unknownAlertTypes,
    alerts: shaped,
    ...provenance(fetchedAt, feedTimestamp),
  };
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
    candidates: matches,
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
  let station = null;
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
  const caveatOf = new Map<EneOutage, EneDateCaveat>();
  const byDate = date
    ? rows.filter((row) => {
        const { overlaps, caveat } = eneOverlapsEtDay(row, date, fetchedAt);
        if (overlaps && caveat) caveatOf.set(row, caveat);
        return overlaps;
      })
    : rows;

  // Route. A row with no trainno cannot be ruled out, so it stays.
  const routeTokens = args.route_id !== undefined ? eneRouteTokens(args.route_id) : null;
  const byRoute = routeTokens
    ? byDate.filter((row) => rowMatchesRouteTokens(row, routeTokens) !== false)
    : byDate;

  // Station name. A row with no station name cannot be ruled out, so it stays,
  // like a row with no trainno, and is counted in rows_without_station.
  // With a stop_id, a row whose shorter name sits inside the station's GTFS name
  // ("Court Sq" for "Court Sq-23 St") also matches, if it shares a route.
  const nameScore = (row: EneOutage): number => {
    if (!row.station) return 1;
    const forward = scoreEneStation(query as string, row.station);
    if (forward > 0) return forward;
    return station && eneRowWithinStation(station.stop_id, row) ? 20 : 0;
  };
  const named = query
    ? byRoute
        .map((row) => ({ row, score: nameScore(row) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.row)
    : byRoute;
  const withoutStation = query ? named.filter((row) => !row.station).length : null;

  // With a stop_id we know the station's routes, so a same-named station on
  // other lines ("125 St" on the 1 when you asked about A15) can be told apart.
  // Those rows are moved aside, not dropped.
  let outages = named;
  let otherStation: EneOutage[] | null = null;
  if (station) {
    const stationTokens = [...new Set(station.routes.flatMap((r) => eneRouteTokens(r)))];
    outages = named.filter((row) => rowMatchesRouteTokens(row, stationTokens) !== false);
    otherStation = named.filter((row) => rowMatchesRouteTokens(row, stationTokens) === false);
  }

  // Caveats only for rows this answer actually returns.
  const dateCaveats = date
    ? [...outages, ...(otherStation ?? [])]
        .filter((row) => caveatOf.has(row))
        .map((row) => ({
          equipment: row.equipment ?? null,
          station: row.station ?? null,
          outagedate: row.outagedate ?? null,
          estimatedreturntoservice: row.estimatedreturntoservice ?? null,
          caveat: caveatOf.get(row) as EneDateCaveat,
        }))
    : null;

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
    matched_by: query
      ? "station name, matched loosely — MTA reports these outages with a free-text station name, not a GTFS stop_id, and the two spellings do not always agree"
      : null,
    outage_count: outages.length,
    rows_in_feed: rows.length,
    rows_without_station: withoutStation,
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
      rows,
      date !== null
    ),
    date_caveats: dateCaveats,
    outages,
    other_station_outages: otherStation,
    ...provenance(fetchedAt),
  };
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
  feedRows: EneOutage[],
  dateFilter: boolean
): string | null {
  if (outageCount > 0 || (!query && !routeId)) return null;
  const retry =
    "Search again with a short, distinctive part of the name, like 'Port Authority' or 'Bedford', and check each row's station and trainno.";
  if (query && otherStationCount > 0) {
    return `'${query}' matched ${otherStationCount} row(s) whose trainno shares no route with this station, so they are probably a different station with the same name. They are in other_station_outages. MTA may also spell this station differently. ${retry}`;
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
    return `No outage row matched '${query}'. That is not proof there is no outage: MTA's elevator feed spells some stations differently from the station list, and this server only normalizes the differences it has seen. ${retry}`;
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
