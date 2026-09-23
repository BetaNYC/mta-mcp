import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOOLS, callTool } from "../dist/tools.js";
import {
  ENE_CURRENT_URL,
  ENE_UPCOMING_URL,
  SUBWAY_ALERTS_URL,
} from "../dist/mta.js";
import { parseStops, routesByParentStation, splitCsvLine } from "../scripts/update-stations.mjs";

// ─── No network, ever ────────────────────────────────────────────────────────
//
// Every test in this suite runs against committed fixtures with fetch stubbed.
// That is correctness (the answers are pinned to a known feed) and it is the
// denial-of-service guard: CI must never reach api-endpoint.mta.info. The one
// live request this repo makes is `npm run smoke`, which is not part of npm test.

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const ALERTS = fixture("subway-alerts.json");
const ENE_CURRENT = fixture("nyct_ene.json");
const ENE_UPCOMING = fixture("nyct_ene_upcoming.json");

let alertsBody = ALERTS;
let eneCurrentBody = ENE_CURRENT;
let fetchCount = 0;

globalThis.fetch = async (url) => {
  fetchCount += 1;
  const bodies = {
    [SUBWAY_ALERTS_URL]: alertsBody,
    [ENE_CURRENT_URL]: eneCurrentBody,
    [ENE_UPCOMING_URL]: ENE_UPCOMING,
  };
  const body = bodies[url];
  if (body === undefined) throw new Error(`test stub: unexpected URL ${url}`);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

// The 1 s politeness gate is real and tested in rate-limit.test.mjs. Here it
// would only add dead time between stubbed calls.
process.env.MTA_MCP_MIN_INTERVAL_MS = "0";

const SAT = "2026-09-19"; // CityCamp NYC, Hunter College

async function call(name, args) {
  const result = await callTool(name, args);
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

async function callExpectingError(name, args) {
  const result = await callTool(name, args);
  assert.equal(result.isError, true, `expected an error, got: ${result.content[0].text}`);
  return result.content[0].text;
}

// ─── Caching ─────────────────────────────────────────────────────────────────

test("a burst of tool calls collapses to one upstream fetch", async () => {
  fetchCount = 0;
  await call("check_route_on_date", { route_id: "6", date: SAT });
  await call("check_route_on_date", { route_id: "4", date: SAT });
  await call("get_service_alerts", { date: SAT });
  assert.equal(fetchCount, 1, "three tool calls must not become three requests");
});

// ─── The CityCamp regression, pinned ─────────────────────────────────────────

test("route 6 on 2026-09-19 returns the Bronx suspension and only that", async () => {
  const result = await call("check_route_on_date", { route_id: "6", date: SAT });
  assert.equal(result.alert_count, 1);
  const alert = result.alerts[0];
  assert.equal(alert.entity_id, "lmm:planned_work:33826");
  assert.equal(alert.alert_type, "Planned - Part Suspended");
  assert.equal(alert.effect, "reduced");
  assert.equal(result.disrupted, true, "the 6 IS disrupted somewhere on this date");
  assert.match(alert.header_text, /No \[6\] between Hunts Point Av and 125 St/);
  assert.equal(alert.human_readable_active_period, "Sep 18 - Oct 19, Fri 9:30 PM to Mon 5:00 AM");
});

test("the affected stops are exactly 614-619, and 628 is not among them", async () => {
  const result = await call("check_route_on_date", { route_id: "6", date: SAT });
  const stops = result.alerts[0].affected_stops.map((s) => s.stop_id).sort();
  assert.deepEqual(stops, ["614", "615", "616", "617", "618", "619"]);
  assert.equal(stops.includes("628"), false, "68 St-Hunter College is NOT affected");
  // mercury_alert.affected_stations on this same entity DOES list 628 — it
  // enumerates the whole route. Shaping from informed_entity is what keeps the
  // answer right; this assertion fails the moment someone switches fields.
  assert.deepEqual(
    result.alerts[0].affected_stops.map((s) => s.stop_name),
    [
      "Longwood Av",
      "E 149 St",
      "E 143 St-St Mary's St",
      "Cypress Av",
      "Brook Av",
      "3 Av-138 St",
    ]
  );
});

test("the 6 serves 68 St-Hunter College normally that Saturday", async () => {
  const result = await call("check_route_on_date", {
    route_id: "6",
    date: SAT,
    station: "68 St-Hunter College",
  });
  assert.equal(result.station.stop_id, "628");
  assert.equal(result.disrupted, false);
  assert.equal(result.station_level_detail, true);
  assert.equal(result.alerts[0].affects_this_station, false);
});

// ─── The false-positive guard ────────────────────────────────────────────────

test("an express-to-local alert tags 628 but is not a disruption there", async () => {
  for (const [route, entityId] of [
    ["4", "lmm:planned_work:33827"],
    ["5", "lmm:planned_work:34003"],
  ]) {
    const result = await call("check_route_on_date", {
      route_id: route,
      date: SAT,
      stop_id: "628",
    });
    const alert = result.alerts.find((a) => a.entity_id === entityId);
    assert.ok(alert, `route ${route} should surface ${entityId}`);
    assert.equal(alert.alert_type, "Planned - Express to Local");
    assert.equal(alert.effect, "added_at_local_stops");
    assert.equal(alert.affects_this_station, true, "the station IS named in the alert");
    assert.equal(alert.counts_as_disruption, false);
    assert.equal(
      result.disrupted,
      false,
      `route ${route} at 628 gains service; a station-mention check would call this a disruption`
    );
  }
});

// ─── Station names are not unique ────────────────────────────────────────────

test("check_route_on_date refuses to guess when a route serves two stations of one name", async () => {
  // The N serves two different stations named 86 St: N10 in Brooklyn and Q04
  // on Second Avenue. Route filtering cannot separate them, so nothing is picked.
  const result = await call("check_route_on_date", { route_id: "N", date: SAT, station: "86 St" });
  assert.equal(result.resolved, false);
  assert.match(result.reason, /more than one station/);
  assert.deepEqual(
    result.candidates.map((c) => c.stop_id).sort(),
    ["N10", "Q04"]
  );
  assert.equal(result.alerts, undefined, "no answer is given when the station is not resolved");
});

test("the call's route_id narrows a shared station name to one station", async () => {
  const six = await call("check_route_on_date", { route_id: "6", date: SAT, station: "125 St" });
  assert.equal(six.station.stop_id, "621");
  assert.equal(six.station_serves_route, true);

  const one = await call("check_route_on_date", { route_id: "1", date: SAT, station: "125 St" });
  // Route 1's 125 St is a different station entirely.
  assert.notEqual(one.station?.stop_id, "621");
});

test("a station that exists but not on this route says so", async () => {
  const result = await call("check_route_on_date", {
    route_id: "6",
    date: SAT,
    station: "Times Sq-42 St",
  });
  assert.equal(result.resolved, false);
  assert.match(result.reason, /not served by route 6|none of the matches is served by route 6/);
  assert.ok(result.candidates.length > 0);
});

test("an unknown stop_id fails loudly instead of widening the answer", async () => {
  const message = await callExpectingError("check_route_on_date", {
    route_id: "6",
    date: SAT,
    stop_id: "999999",
  });
  assert.match(message, /999999/);
  assert.match(message, /resolve_station|npm run stations/);
});

// ─── resolve_station ─────────────────────────────────────────────────────────

test("resolve_station('68 St') resolves to 628, not 629 or 630", async () => {
  const result = await call("resolve_station", { query: "68 St" });
  assert.equal(result.candidates[0].stop_id, "628");
  assert.equal(result.candidates[0].stop_name, "68 St-Hunter College");
  assert.equal(result.unambiguous, true);

  // The exact near-misses from the report that shipped wrong.
  const fiftyNine = await call("resolve_station", { query: "59 St" });
  assert.ok(fiftyNine.candidates.some((c) => c.stop_id === "629"));
  const fiftyOne = await call("resolve_station", { query: "51 St" });
  assert.deepEqual(
    fiftyOne.candidates.map((c) => c.stop_id),
    ["630"]
  );
});

test("resolve_station returns every station sharing a name, never one", async () => {
  const all = await call("resolve_station", { query: "125 St" });
  assert.equal(all.match_count, 4);
  assert.equal(all.unambiguous, false);
  assert.deepEqual(
    all.candidates.map((c) => c.stop_id).sort(),
    ["116", "225", "621", "A15"]
  );
  assert.match(all.note, /route_id/);

  const narrowed = await call("resolve_station", { query: "125 St", route_id: "6" });
  assert.equal(narrowed.match_count, 1);
  assert.equal(narrowed.candidates[0].stop_id, "621");
  assert.deepEqual(narrowed.candidates[0].routes, ["4", "5", "6", "6X"]);
});

// ─── Station-level detail ────────────────────────────────────────────────────

test("station_level_detail is false when MTA tagged no stations", async () => {
  // lmm:planned_work:34110, route Q, Reduced Service, zero stop_id entries.
  const result = await call("check_route_on_date", { route_id: "Q", date: SAT });
  assert.equal(result.alert_count, 1);
  assert.equal(result.alerts[0].affected_stops.length, 0);
  assert.equal(result.station_level_detail, false);
  assert.match(result.station_level_detail_note, /should not assume every alert includes/);
});

test("with no station tagging, a route-level alert still counts against a station", async () => {
  const result = await call("check_route_on_date", {
    route_id: "Q",
    date: SAT,
    stop_id: "628", // not a Q station, but the point is the untagged alert
  });
  assert.equal(result.alerts[0].relevant_to_station, true);
  assert.equal(result.disrupted, true);
  assert.equal(result.station_serves_route, false);
});

test("no matching alert is reported as a route-level answer, not an all-clear", async () => {
  const result = await call("check_route_on_date", { route_id: "6", date: "2026-12-25" });
  assert.equal(result.alert_count, 0);
  assert.equal(result.disrupted, false);
  assert.match(result.station_level_detail_note, /MTA does not publish an all-clear/);
});

// ─── get_service_alerts ──────────────────────────────────────────────────────

test("get_service_alerts filters by date, route, type, effect and planned_only", async () => {
  const sat = await call("get_service_alerts", { date: SAT });
  assert.equal(sat.alert_count, 9);

  const six = await call("get_service_alerts", { date: SAT, route_id: "6" });
  assert.equal(six.alert_count, 1);
  assert.equal(six.alerts[0].entity_id, "lmm:planned_work:33826");

  const byType = await call("get_service_alerts", {
    date: SAT,
    alert_type: "Planned - Express to Local",
  });
  assert.equal(byType.alert_count, 2);

  const added = await call("get_service_alerts", { date: SAT, effect: "added" });
  assert.deepEqual(
    added.alerts.map((a) => a.alert_type),
    ["Extra Service"]
  );

  // 2026-09-16 holds the one live incident (lmm:alert:*) plus a Station Notice.
  const wed = await call("get_service_alerts", { date: "2026-09-16" });
  assert.equal(wed.alert_count, 2);
  const planned = await call("get_service_alerts", { date: "2026-09-16", planned_only: true });
  assert.equal(planned.alert_count, 1);
  assert.equal(planned.alerts[0].planned, true);
  assert.equal(planned.alerts[0].entity_id, "lmm:planned_work:33366");
});

test("every payload carries provenance and refuses to claim it is realtime", async () => {
  const result = await call("get_service_alerts", { date: SAT });
  assert.equal(result.may_not_be_realtime, true);
  assert.match(result.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.feed_timestamp, 1789570389);
  assert.match(result.data_source, /api\.mta\.info/);
  assert.match(result.disclaimer, /Unofficial/);
  assert.match(result.staleness_note, /cache/);
});

// ─── Accessibility outages ───────────────────────────────────────────────────

test("the current ene feed excludes its upcoming-flagged rows", async () => {
  const current = await call("get_accessibility_outages", {});
  assert.equal(current.rows_in_feed, 79, "126 rows in the feed, 47 of them flagged upcoming");
  assert.equal(current.outages.every((o) => o.isupcomingoutage !== "Y"), true);

  const upcoming = await call("get_accessibility_outages", { upcoming: true });
  assert.equal(upcoming.rows_in_feed, 47);
  assert.equal(upcoming.feed_url, ENE_UPCOMING_URL);
});

test("ene rows are matched by free-text station name, and say so", async () => {
  const byName = await call("get_accessibility_outages", {
    station: "Jamaica-179 St",
    upcoming: true,
  });
  assert.equal(byName.outage_count, 3);
  assert.match(byName.matched_by, /free-text station name/);

  const byId = await call("get_accessibility_outages", { stop_id: "F01" });
  assert.equal(byId.query, "Jamaica-179 St");

  const unknownId = await callExpectingError("get_accessibility_outages", { stop_id: "999999" });
  assert.match(unknownId, /999999/);
});

test("stations MTA spells differently are found by GTFS name and by stop_id", async () => {
  // Before the elevator-feed normalization, every one of these returned zero.
  const bedford = await call("get_accessibility_outages", { station: "Bedford Park Blvd" });
  assert.deepEqual(bedford.outages.map((o) => o.station), ["Bedford Pk Blvd"]);
  const d03 = await call("get_accessibility_outages", { stop_id: "D03" });
  assert.equal(d03.outage_count, 1);
  assert.equal(d03.no_match_note, null);

  const a27 = await call("get_accessibility_outages", { stop_id: "A27" });
  assert.equal(a27.query, "42 St-Port Authority Bus Terminal");
  assert.deepEqual(a27.outages.map((o) => o.equipment).sort(), ["EL290X", "ES607X"]);
});

test("a stop_id finds a feed name shorter than its GTFS name, on a shared route", async () => {
  // GTFS 138 is "WTC Cortlandt"; the feed says "Cortlandt St" on the 1. That is
  // also the GTFS name of R25 on the N/R/W, and within "Van Cortlandt Park-242
  // St" (101), also on the 1. Only the closest name on the shared route wins.
  const wtc = await call("get_accessibility_outages", { stop_id: "138" });
  assert.deepEqual(wtc.outages.map((o) => o.station), ["Cortlandt St"]);
  const vanCortlandt = await call("get_accessibility_outages", { stop_id: "101" });
  assert.equal(vanCortlandt.outages.some((o) => o.station === "Cortlandt St"), false);
  // R25's own forward match still finds it and moves it aside: the 1 isn't there.
  const r25 = await call("get_accessibility_outages", { stop_id: "R25" });
  assert.deepEqual(r25.other_station_outages.map((o) => o.station), ["Cortlandt St"]);

  // F09 is "Court Sq-23 St" (E/F); the feed says "Court Sq" with E/F/G/7.
  const f09 = await call("get_accessibility_outages", { stop_id: "F09" });
  assert.ok(f09.outage_count > 0);
  assert.ok(f09.outages.every((o) => o.station === "Court Sq"));
});

test("ordinals typed by a person still match", async () => {
  const pa = await call("get_accessibility_outages", { station: "42nd St Port Authority" });
  assert.equal(pa.outage_count, 2);
  const thirtyFourth = await call("get_accessibility_outages", { station: "34th St" });
  assert.ok(thirtyFourth.outage_count > 0);
  assert.equal(thirtyFourth.no_match_note, null);
});

test("a row with no station name is kept and counted, not dropped", async () => {
  const mutated = structuredClone(ENE_CURRENT);
  const target = mutated.find((r) => r.isupcomingoutage === "N");
  delete target.station;
  const previousTtl = process.env.MTA_MCP_CACHE_TTL_MS;
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  eneCurrentBody = mutated;
  try {
    const result = await call("get_accessibility_outages", { station: "Hoboken Terminal" });
    assert.equal(result.rows_without_station, 1);
    assert.deepEqual(result.outages.map((o) => o.equipment), [target.equipment]);
  } finally {
    eneCurrentBody = ENE_CURRENT;
    // Refill the cache with the real fixture before the TTL goes back up, or
    // the mutated body would be served to every later test.
    await callTool("get_accessibility_outages", {});
    if (previousTtl === undefined) delete process.env.MTA_MCP_CACHE_TTL_MS;
    else process.env.MTA_MCP_CACHE_TTL_MS = previousTtl;
  }
});

test("an empty route search carries a note too", async () => {
  const unknown = await call("get_accessibility_outages", { route_id: "ZZ" });
  assert.equal(unknown.outage_count, 0);
  assert.match(unknown.no_match_note, /No row in the feed lists route 'ZZ'/);

  // The 6 has outages in the feed, but none scheduled to start by 2020.
  const early = await call("get_accessibility_outages", { route_id: "6", date: "2020-01-01" });
  assert.equal(early.outage_count, 0);
  assert.match(early.no_match_note, /passes the date filter/);

  const some = await call("get_accessibility_outages", { route_id: "6" });
  assert.equal(some.no_match_note, null);
});

test("a zero from a name search carries a note, never a bare empty list", async () => {
  const none = await call("get_accessibility_outages", { station: "Hoboken Terminal" });
  assert.equal(none.outage_count, 0);
  assert.match(none.no_match_note, /not proof there is no outage/);
  assert.match(none.no_match_note, /short, distinctive part of the name/);

  const found = await call("get_accessibility_outages", { station: "Port Authority" });
  assert.equal(found.no_match_note, null);
});

test("with a stop_id, a same-named station on other routes is moved aside", async () => {
  // Two 125 St rows on 2026-09-19: EL144 (A/C/B/D) and ES102 (the 1).
  const a15 = await call("get_accessibility_outages", { stop_id: "A15", date: SAT });
  assert.deepEqual(a15.outages.map((o) => o.equipment), ["EL144"]);
  assert.deepEqual(a15.other_station_outages.map((o) => o.equipment), ["ES102"]);

  const s116 = await call("get_accessibility_outages", { stop_id: "116", date: SAT });
  assert.deepEqual(s116.outages.map((o) => o.equipment), ["ES102"]);
  assert.deepEqual(s116.other_station_outages.map((o) => o.equipment), ["EL144"]);

  // By name alone nothing is known about routes, so nothing is moved.
  const byName = await call("get_accessibility_outages", { station: "125 St", date: SAT });
  assert.equal(byName.outage_count, 2);
  assert.equal(byName.other_station_outages, null);
});

test("route_id filters on trainno, with express and shuttle ids mapped", async () => {
  const six = await call("get_accessibility_outages", { route_id: "6" });
  assert.equal(six.outage_count, 7);
  assert.ok(six.outages.every((o) => o.trainno.split("/").includes("6")));
  assert.equal(six.route_note, null);

  // No trainno says 6X; the diamond 6 shares the 6's stations.
  const diamond = await call("get_accessibility_outages", { route_id: "6X" });
  assert.deepEqual(diamond.route_tokens_matched, ["6X", "6"]);
  assert.equal(diamond.outage_count, 7);

  // The 42 St Shuttle is "S" in the feed.
  const gs = await call("get_accessibility_outages", { route_id: "GS" });
  assert.equal(gs.outage_count, 5);
  assert.ok(gs.outages.every((o) => o.trainno.split("/").includes("S")));
  assert.match(gs.route_note, /every shuttle as 'S'/);

  // "L" must not match "LIRR".
  const l = await call("get_accessibility_outages", { route_id: "L" });
  assert.ok(l.outages.every((o) => o.trainno.split("/").includes("L")));
});

test("date returns in-effect and scheduled outages overlapping that day, in one request", async () => {
  fetchCount = 0;
  const previousTtl = process.env.MTA_MCP_CACHE_TTL_MS;
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  try {
    // Jamaica-179 St's three elevators are scheduled out 9/28 10 PM to 9/29 6 AM.
    const on28 = await call("get_accessibility_outages", { station: "Jamaica-179 St", date: "2026-09-28" });
    assert.equal(fetchCount, 1, "a date query reads one feed");
    assert.equal(on28.feed_url, ENE_CURRENT_URL);
    assert.equal(on28.upcoming, null);
    assert.equal(on28.date, "2026-09-28");
    assert.deepEqual(on28.outages.map((o) => o.equipment).sort(), ["EL431", "EL432", "EL433"]);
    assert.ok(on28.outages.every((o) => o.isupcomingoutage === "Y"));
    assert.match(on28.feed_note, /New York time/);
    assert.match(on28.feed_note, /MTA does not document it/);

    const on27 = await call("get_accessibility_outages", { station: "Jamaica-179 St", date: "2026-09-27" });
    assert.equal(on27.outage_count, 0);
    assert.match(on27.no_match_note, /date or route filter/);
  } finally {
    if (previousTtl === undefined) delete process.env.MTA_MCP_CACHE_TTL_MS;
    else process.env.MTA_MCP_CACHE_TTL_MS = previousTtl;
  }
});

test("date keeps an overdue outage and says why", async () => {
  // ES102 at 125 St was due back 9/18 10 PM and is still listed, so it counts
  // on 9/19. Stable for any run after the fixture was pulled.
  const result = await call("get_accessibility_outages", { stop_id: "116", date: SAT });
  assert.deepEqual(result.date_caveats.map((c) => [c.equipment, c.caveat]), [
    ["ES102", "estimate_passed"],
  ]);
});

test("date and upcoming together are rejected, and date is validated", async () => {
  const both = await callExpectingError("get_accessibility_outages", { date: SAT, upcoming: true });
  assert.match(both, /date or upcoming:true, not both/);
  // upcoming:false is the default, so it is accepted alongside date.
  const withDefault = await call("get_accessibility_outages", { date: SAT, upcoming: false });
  const without = await call("get_accessibility_outages", { date: SAT });
  assert.equal(withDefault.outage_count, without.outage_count);
  assert.equal(withDefault.feed_url, ENE_CURRENT_URL);
  const bad = await callExpectingError("get_accessibility_outages", { date: "9/19/2026" });
  assert.match(bad, /expected YYYY-MM-DD/);
});

// ─── Station accessibility (ADA) ─────────────────────────────────────────────

test("resolve_station candidates carry each station's own ADA status", async () => {
  // One complex, three answers: at Union Sq the 4/5/6 station (635) is not
  // accessible while L03 and R20 are. A complex-level status would get 635 wrong.
  const union = await call("resolve_station", { query: "14 St-Union Sq" });
  const status = Object.fromEntries(union.candidates.map((c) => [c.stop_id, c.accessibility.status]));
  assert.deepEqual(status, {
    "635": "not_accessible",
    L03: "fully_accessible",
    R20: "fully_accessible",
  });
  assert.match(union.ada_data.source_url, /39hk-dx4f/);
  assert.match(union.ada_data.note, /not whether that path works today/);
});

test("partially accessible says which direction, with MTA's note verbatim", async () => {
  const hoyt = await call("resolve_station", { query: "Hoyt St" });
  const h = hoyt.candidates.find((c) => c.stop_id === "233");
  assert.deepEqual(h.accessibility, {
    status: "partially_accessible",
    mta_notes: "Outbound only",
    accessible_direction: "Outbound",
  });
  // GTFS calls Court Sq-23 St's Manhattan-bound side "southbound". We use
  // MTA's rider label instead, never the compass word.
  const court = await call("resolve_station", { query: "Court Sq-23 St" });
  assert.deepEqual(court.candidates[0].accessibility, {
    status: "partially_accessible",
    mta_notes: "Manhattan-bound only",
    accessible_direction: "Manhattan",
  });
  // MTA's note can be narrower than the direction flag: the local platform only.
  const eightySix = await call("resolve_station", { query: "86 St", route_id: "6" });
  assert.deepEqual(eightySix.candidates[0].accessibility, {
    status: "partially_accessible",
    mta_notes: "Uptown local only",
    accessible_direction: "Uptown",
  });
  // Fully and not accessible stations carry no direction field.
  const f01 = await call("resolve_station", { query: "Jamaica-179 St" });
  assert.deepEqual(f01.candidates[0].accessibility, { status: "fully_accessible", mta_notes: null });
});

test("check_route_on_date reports the station's ADA status without an extra request", async () => {
  fetchCount = 0;
  const previousTtl = process.env.MTA_MCP_CACHE_TTL_MS;
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  try {
    const result = await call("check_route_on_date", { route_id: "6", date: SAT, stop_id: "628" });
    assert.equal(fetchCount, 1, "the ADA status is bundled; only the alerts feed is read");
    assert.equal(result.station.accessibility.status, "fully_accessible");
    assert.match(result.accessibility_note, /not whether it works on 2026-09-19/);
    assert.match(result.accessibility_note, /include_accessibility:true/);
    assert.equal(result.accessibility_outages, null);

    const routeOnly = await call("check_route_on_date", { route_id: "6", date: SAT });
    assert.equal(routeOnly.accessibility_note, null);
  } finally {
    if (previousTtl === undefined) delete process.env.MTA_MCP_CACHE_TTL_MS;
    else process.env.MTA_MCP_CACHE_TTL_MS = previousTtl;
  }
});

// ─── Elevator outages in route checks ────────────────────────────────────────

test("include_accessibility adds the station's outages that day, for one extra request", async () => {
  fetchCount = 0;
  const previousTtl = process.env.MTA_MCP_CACHE_TTL_MS;
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  try {
    const result = await call("check_route_on_date", {
      route_id: "F",
      date: "2026-09-28",
      stop_id: "F01",
      include_accessibility: true,
    });
    assert.equal(fetchCount, 2, "alerts plus the current elevator feed, nothing else");
    const acc = result.accessibility_outages;
    assert.equal(acc.feed_url, ENE_CURRENT_URL);
    assert.deepEqual(acc.outages.map((o) => o.equipment).sort(), ["EL431", "EL432", "EL433"]);
    assert.ok(acc.outages.every((o) => o.matched_by === "equipment id"));
    const el433 = acc.outages.find((o) => o.equipment === "EL433");
    assert.match(el433.alternative_route, /Kew Gardens-Union Tpke/);
    assert.match(acc.note, /can lag/);
    assert.match(acc.note, /mta\.info\/elevator-escalator-status/);
    assert.equal(acc.complex_outages, null, "F01 is not part of a complex");
    // The route answer itself is unchanged.
    assert.equal(typeof result.disrupted, "boolean");
  } finally {
    if (previousTtl === undefined) delete process.env.MTA_MCP_CACHE_TTL_MS;
    else process.env.MTA_MCP_CACHE_TTL_MS = previousTtl;
  }
});

test("include_accessibility with no outages says that is not proof", async () => {
  // 238 St (103) is not accessible and has nothing in the feed.
  const result = await call("check_route_on_date", {
    route_id: "1",
    date: SAT,
    stop_id: "103",
    include_accessibility: true,
  });
  assert.equal(result.accessibility_outages.outage_count, 0);
  assert.match(result.accessibility_outages.note, /codes no ADA-compliant elevator here, so there may be no elevator/);
  assert.match(result.accessibility_outages.note, /not proof the station is usable/);
});

test("include_accessibility needs a station, and an unresolved one fetches nothing", async () => {
  const noStation = await callExpectingError("check_route_on_date", {
    route_id: "6",
    date: SAT,
    include_accessibility: true,
  });
  assert.match(noStation, /include_accessibility needs a station/);

  fetchCount = 0;
  const previousTtl = process.env.MTA_MCP_CACHE_TTL_MS;
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  try {
    // The N serves two stations named 86 St; the answer is candidates.
    const ambiguous = await call("check_route_on_date", {
      route_id: "N",
      date: SAT,
      station: "86 St",
      include_accessibility: true,
    });
    assert.equal(ambiguous.resolved, false);
    assert.equal(fetchCount, 0);
    assert.ok(ambiguous.candidates.every((c) => typeof c.accessibility.status === "string"));
  } finally {
    if (previousTtl === undefined) delete process.env.MTA_MCP_CACHE_TTL_MS;
    else process.env.MTA_MCP_CACHE_TTL_MS = previousTtl;
  }
});

// ─── Placing outages by equipment ID ─────────────────────────────────────────

test("with a stop_id, outage rows are placed by equipment ID and carry the inventory", async () => {
  const f01 = await call("get_accessibility_outages", { stop_id: "F01", upcoming: true });
  assert.match(f01.matched_by, /^equipment id first/);
  assert.equal(f01.station_accessibility.status, "fully_accessible");
  assert.ok(f01.outages.length > 0);
  for (const o of f01.outages) {
    assert.equal(o.matched_by, "equipment id");
    assert.deepEqual(o.inventory.stop_ids, ["F01"]);
    assert.equal(o.inventory.ada_compliant, "YES");
  }
  assert.match(f01.inventory_data.source_url, /94fv-bak7/);
  assert.match(f01.inventory_data.note, /can lag/);
  assert.match(f01.ada_data.source_url, /39hk-dx4f/);
});

test("the ID join drops name-only false positives and finds what names missed", async () => {
  // "Union St" (R32) used to pick up the 14 St-Union Sq rows on its shared R.
  // The inventory puts them at R20, so they move to other_station_outages.
  const unionSt = await call("get_accessibility_outages", { stop_id: "R32" });
  assert.equal(unionSt.outage_count, 0);
  assert.deepEqual(unionSt.other_station_outages.map((o) => o.station), ["14 St-Union Sq", "14 St-Union Sq"]);
  assert.ok(unionSt.other_station_outages.every((o) => /places .* at 14 St-Union Sq/.test(o.match_note)));
  assert.match(unionSt.no_match_note, /not proof the station is usable/);
  assert.match(unionSt.no_match_note, /not accessible/);

  // "168 St" in the feed was only ever found from A09. EL113 is coded to 112.
  const s112 = await call("get_accessibility_outages", { stop_id: "112" });
  assert.deepEqual(s112.outages.map((o) => [o.equipment, o.matched_by]), [["EL113", "equipment id"]]);
  // A09 still lists it, because the feed names it, with where the inventory puts it.
  const a09 = await call("get_accessibility_outages", { stop_id: "A09" });
  const el113 = a09.outages.find((o) => o.equipment === "EL113");
  assert.equal(el113.matched_by, "name");
  assert.match(el113.match_note, /168 St-Washington Hts \(112\), another station in this complex/);
});

test("outages elsewhere in a complex are listed apart, not dropped", async () => {
  // EL290X is "42St/Port Authority" in the feed and A27 in the inventory, in
  // the same complex as Times Sq-42 St (127).
  const times = await call("get_accessibility_outages", { stop_id: "127" });
  assert.ok(times.complex_outages.some((o) => o.equipment === "EL290X" && o.matched_by === "equipment id"));
  assert.equal(times.outages.some((o) => o.equipment === "EL290X"), false);
  // A station outside any complex gets null, not an empty list.
  const f01 = await call("get_accessibility_outages", { stop_id: "F01" });
  assert.equal(f01.complex_outages, null);
});

test("rows the inventory doesn't know fall back to names, and say so", async () => {
  const mutated = structuredClone(ENE_CURRENT);
  const cortlandt = mutated.find((r) => r.station === "Cortlandt St");
  cortlandt.equipment = "EL-NOT-IN-INVENTORY";
  const previousTtl = process.env.MTA_MCP_CACHE_TTL_MS;
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  eneCurrentBody = mutated;
  try {
    const wtc = await call("get_accessibility_outages", { stop_id: "138" });
    const row = wtc.outages.find((o) => o.equipment === "EL-NOT-IN-INVENTORY");
    assert.equal(row.matched_by, "partial name");
    assert.equal("inventory" in row, false, "no inventory entry, so the field is omitted");
    assert.equal("match_note" in row, false, "138 is the closest name, so nothing to flag");

    // Van Cortlandt Park-242 St also contains "Cortlandt" on the 1. It used to
    // lose the tie-break silently. Now it gets the row, flagged.
    const van = await call("get_accessibility_outages", { stop_id: "101" });
    const flagged = van.outages.find((o) => o.equipment === "EL-NOT-IN-INVENTORY");
    assert.equal(flagged.matched_by, "partial name");
    assert.match(flagged.match_note, /WTC Cortlandt \(138\).*matches 'Cortlandt St' more closely/);
  } finally {
    eneCurrentBody = ENE_CURRENT;
    await callTool("get_accessibility_outages", {});
    if (previousTtl === undefined) delete process.env.MTA_MCP_CACHE_TTL_MS;
    else process.env.MTA_MCP_CACHE_TTL_MS = previousTtl;
  }
});

test("a free-text station search tags rows as name matches and shows the inventory's station", async () => {
  const byName = await call("get_accessibility_outages", { station: "125 St", date: SAT });
  assert.ok(byName.outages.every((o) => o.matched_by === "name"));
  assert.deepEqual(
    byName.outages.map((o) => [o.equipment, o.inventory.stop_ids]).sort(),
    [["EL144", ["A15"]], ["ES102", ["116"]]]
  );
  assert.equal(byName.station_accessibility, null);
  assert.equal(byName.complex_outages, null);
});

test("a not-accessible station with ADA elevators isn't told it may have none", async () => {
  // 149 St-Hostos (415) is listed not accessible, but the inventory codes
  // ADA-compliant EL100-EL102 there. No outage there on this date.
  const hostos = await call("get_accessibility_outages", { stop_id: "415", date: SAT });
  assert.equal(hostos.outage_count, 0);
  assert.match(hostos.no_match_note, /codes 3 ADA-compliant elevator\(s\) here \(EL100, EL101, EL102\)/);
  assert.doesNotMatch(hostos.no_match_note, /may be no elevator/);
  assert.match(hostos.no_match_note, /not proof the station is usable/);

  const route = await call("check_route_on_date", {
    route_id: "4",
    date: SAT,
    stop_id: "415",
    include_accessibility: true,
  });
  assert.match(route.accessibility_outages.note, /codes 3 ADA-compliant elevator/);
  assert.match(route.accessibility_outages.note, /not proof the station is usable/);
});

test("unfiltered and route-only answers carry no inventory and no null extras", async () => {
  for (const args of [{}, { route_id: "6" }]) {
    const result = await call("get_accessibility_outages", args);
    assert.ok(result.outages.length > 0);
    for (const o of result.outages) {
      assert.equal("inventory" in o, false);
      assert.equal("matched_by" in o, false);
      assert.equal("match_note" in o, false);
    }
  }
  // With a station, the inventory is there.
  const byName = await call("get_accessibility_outages", { station: "Jamaica-179 St", upcoming: true });
  assert.ok(byName.outages.every((o) => o.inventory && o.matched_by === "name"));
});

// ─── Alerts with no active_period ────────────────────────────────────────────

test("an alert with no active_period is reported on every date", async () => {
  const mutated = structuredClone(ALERTS);
  const target = mutated.entity.find((e) => e.id === "lmm:planned_work:33826");
  delete target.alert.active_period;

  const previousTtl = process.env.MTA_MCP_CACHE_TTL_MS;
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  alertsBody = mutated;
  try {
    // Christmas has no 6 alert in the fixture; with no period, this one applies.
    const result = await call("check_route_on_date", { route_id: "6", date: "2026-12-25" });
    assert.equal(result.alert_count, 1);
    assert.equal(result.alerts[0].entity_id, "lmm:planned_work:33826");
    assert.deepEqual(result.alerts[0].active_periods, []);
    assert.equal(result.disrupted, true);

    const listed = await call("get_service_alerts", { route_id: "6", date: "2027-03-01" });
    assert.equal(listed.alert_count, 1);
  } finally {
    alertsBody = ALERTS;
    await callTool("get_service_alerts", { date: SAT }); // refill the cache
    if (previousTtl === undefined) delete process.env.MTA_MCP_CACHE_TTL_MS;
    else process.env.MTA_MCP_CACHE_TTL_MS = previousTtl;
  }
});

// ─── Output size ─────────────────────────────────────────────────────────────

test("tool output is compact JSON, one line", async () => {
  const result = await callTool("get_service_alerts", { date: SAT });
  const text = result.content[0].text;
  assert.equal(text.includes("\n"), false);
  assert.equal(text, JSON.stringify(JSON.parse(text)));
});

// ─── Failing toward caution ──────────────────────────────────────────────────

test("an alert_type this server has never seen counts as a disruption", async () => {
  const mutated = structuredClone(ALERTS);
  const target = mutated.entity.find((e) => e.id === "lmm:planned_work:33826");
  target.alert["transit_realtime.mercury_alert"].alert_type =
    "Planned - Something MTA Invented In 2027";

  const previousTtl = process.env.MTA_MCP_CACHE_TTL_MS;
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  alertsBody = mutated;
  try {
    const routeLevel = await call("check_route_on_date", { route_id: "6", date: SAT });
    assert.equal(routeLevel.alerts[0].effect, "unknown");
    assert.equal(routeLevel.alerts[0].alert_type_recognized, false);
    assert.equal(routeLevel.disrupted, true);
    assert.deepEqual(routeLevel.unknown_alert_types, ["Planned - Something MTA Invented In 2027"]);

    // The same alert tags 614-619 and not 628. For a status we recognize, that
    // clears 628. For one we do not, it does not: we cannot claim to know what
    // an unknown alert's station tagging means.
    const atStation = await call("check_route_on_date", {
      route_id: "6",
      date: SAT,
      station: "68 St-Hunter College",
    });
    assert.equal(atStation.alerts[0].affects_this_station, false);
    assert.equal(atStation.alerts[0].relevant_to_station, true);
    assert.equal(
      atStation.disrupted,
      true,
      "an unrecognized status must fail toward caution even at an untagged station"
    );
  } finally {
    alertsBody = ALERTS;
    if (previousTtl === undefined) delete process.env.MTA_MCP_CACHE_TTL_MS;
    else process.env.MTA_MCP_CACHE_TTL_MS = previousTtl;
  }
});

// ─── The generated station file ──────────────────────────────────────────────

test("splitCsvLine handles quoted fields with embedded commas", () => {
  assert.deepEqual(splitCsvLine("a,b,c"), ["a", "b", "c"]);
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ["a", "b,c", "d"]);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ["a", 'say "hi"', "c"]);
  assert.deepEqual(splitCsvLine("a,,c"), ["a", "", "c"]);
});

test("parseStops keeps parent stations and indexes platforms to them", () => {
  const stopsTxt = readFileSync(new URL("./fixtures/stops.txt", import.meta.url), "utf8");
  const { stations, parentOf } = parseStops(stopsTxt);
  assert.equal(stations.length, 496);
  assert.equal(stations.find((s) => s.stop_id === "628").stop_name, "68 St-Hunter College");
  // Platform rows are excluded from the station list but do index to a parent.
  assert.equal(stations.some((s) => s.stop_id === "628N"), false);
  assert.equal(parentOf.get("628N"), "628");
  assert.equal(parentOf.get("628"), "628");
});

test("routesByParentStation folds platform rows up to the station", () => {
  const trips = ["route_id,trip_id,service_id", "6,T1,Weekday", "4,T2,Weekday"].join("\n");
  const stopTimes = [
    "trip_id,stop_id,arrival_time,departure_time,stop_sequence",
    "T1,628N,00:06:00,00:06:00,1",
    "T1,628S,00:07:00,00:07:00,2",
    "T2,628N,00:08:00,00:08:00,1",
    "T9,101S,00:09:00,00:09:00,1", // trip with no route: ignored, not crashed on
  ].join("\n");
  const parentOf = new Map([
    ["628N", "628"],
    ["628S", "628"],
    ["101S", "101"],
  ]);
  const routes = routesByParentStation(trips, stopTimes, parentOf);
  assert.deepEqual([...routes.get("628")].sort(), ["4", "6"]);
  assert.equal(routes.has("101"), false);
});

// ─── Schema surface ──────────────────────────────────────────────────────────

test("four tools are advertised, with the names the docs use", () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name).sort(),
    ["check_route_on_date", "get_accessibility_outages", "get_service_alerts", "resolve_station"]
  );
});
