import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EFFECT_BY_ALERT_TYPE,
  USER_AGENT,
  assertIsoDate,
  effectFor,
  englishText,
  eneOverlapsEtDay,
  eneRouteTokens,
  eneTokens,
  etDayBounds,
  filterEneRows,
  parseEneDateMs,
  eneRowWithinStation,
  feedNameWithin,
  rowMatchesRouteTokens,
  scoreEneStation,
  trainnoRoutes,
  isDisrupting,
  isKnownAlertType,
  overlapsEtDay,
  resolveStationMatches,
  resolveStationStrict,
  STATIONS,
  retryAfterMs,
  scoreStation,
  stationById,
  todayIso,
} from "./mta.js";

// Nothing in this file touches the network. It exercises pure functions only.

// ─── Eastern Time ────────────────────────────────────────────────────────────

test("todayIso returns today's date in America/New_York", () => {
  const now = new Date();
  const expected = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(now);
  assert.equal(todayIso(now), expected);
  assert.match(todayIso(now), /^\d{4}-\d{2}-\d{2}$/);
});

test("todayIso diverges from UTC at 23:30 ET in winter (EST, UTC-5)", () => {
  const lateEveningEst = new Date("2026-01-15T04:30:00Z"); // 2026-01-14 23:30 ET
  assert.equal(todayIso(lateEveningEst), "2026-01-14");
  assert.equal(lateEveningEst.toISOString().split("T")[0], "2026-01-15");
});

test("todayIso diverges from UTC at 23:30 ET in summer (EDT, UTC-4)", () => {
  const lateEveningEdt = new Date("2026-07-06T03:30:00Z"); // 2026-07-05 23:30 ET
  assert.equal(todayIso(lateEveningEdt), "2026-07-05");
  assert.equal(lateEveningEdt.toISOString().split("T")[0], "2026-07-06");
});

test("etDayBounds uses the offset in force on the day, not a fixed one", () => {
  // EDT, UTC-4
  const sep = etDayBounds("2026-09-19");
  assert.equal(new Date(sep.start * 1000).toISOString(), "2026-09-19T04:00:00.000Z");
  assert.equal(new Date(sep.end * 1000).toISOString(), "2026-09-20T04:00:00.000Z");
  // EST, UTC-5
  const jan = etDayBounds("2026-01-15");
  assert.equal(new Date(jan.start * 1000).toISOString(), "2026-01-15T05:00:00.000Z");
  assert.equal(new Date(jan.end * 1000).toISOString(), "2026-01-16T05:00:00.000Z");
});

test("etDayBounds handles the spring-forward and fall-back days", () => {
  // 2026-03-08: EST → EDT. The day starts at 05:00Z and is 23 hours long.
  const spring = etDayBounds("2026-03-08");
  assert.equal(new Date(spring.start * 1000).toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(spring.end - spring.start, 23 * 3600);
  // 2026-11-01: EDT → EST. Starts at 04:00Z and is 25 hours long.
  const fall = etDayBounds("2026-11-01");
  assert.equal(new Date(fall.start * 1000).toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(fall.end - fall.start, 25 * 3600);
});

test("assertIsoDate rejects anything that is not YYYY-MM-DD", () => {
  assert.equal(assertIsoDate("2026-09-19"), "2026-09-19");
  for (const bad of ["9/19/2026", "20260919", "2026-9-19", "", "today"]) {
    assert.throws(() => assertIsoDate(bad), /expected YYYY-MM-DD/, `should reject '${bad}'`);
  }
});

// ─── Active-period overlap ───────────────────────────────────────────────────

const SAT = "2026-09-19";
const satStart = etDayBounds(SAT).start; // 2026-09-19T04:00:00Z
const satEnd = etDayBounds(SAT).end; // 2026-09-20T04:00:00Z

test("a Friday-night to Monday-morning period overlaps the Saturday", () => {
  // Fri 9:30 PM ET through Mon 5:00 AM ET, the shape all weekend work takes.
  const period = [
    {
      start: Math.floor(Date.parse("2026-09-19T01:30:00Z") / 1000),
      end: Math.floor(Date.parse("2026-09-22T09:00:00Z") / 1000),
    },
  ];
  assert.equal(overlapsEtDay(period, SAT), true);
});

test("day bounds are half-open: ending exactly at the opening midnight does not overlap", () => {
  assert.equal(overlapsEtDay([{ start: satStart - 7200, end: satStart }], SAT), false);
  assert.equal(overlapsEtDay([{ start: satStart - 7200, end: satStart + 1 }], SAT), true);
});

test("day bounds are half-open: ending exactly at the closing midnight does overlap", () => {
  assert.equal(overlapsEtDay([{ start: satEnd - 3600, end: satEnd }], SAT), true);
  assert.equal(overlapsEtDay([{ start: satEnd, end: satEnd + 3600 }], SAT), false);
});

test("any one of several periods overlapping is enough", () => {
  const periods = [
    { start: satStart - 700_000, end: satStart - 600_000 },
    { start: satStart + 3600, end: satStart + 7200 },
  ];
  assert.equal(overlapsEtDay(periods, SAT), true);
});

test("a period with no end is open-ended", () => {
  assert.equal(overlapsEtDay([{ start: satStart - 86_400 }], SAT), true);
  assert.equal(overlapsEtDay([{ start: satEnd + 86_400 }], SAT), false);
});

test("an alert with no active_period is active on every date", () => {
  // GTFS-realtime: "If missing, the alert will be shown as long as it appears
  // in the feed." Returning false here silently dropped such an alert.
  for (const date of [SAT, "2026-01-15", "2027-06-30"]) {
    assert.equal(overlapsEtDay([], date), true, date);
    assert.equal(overlapsEtDay(undefined, date), true, date);
  }
});

// ─── Effect classification ───────────────────────────────────────────────────

test("every observed alert_type maps to an effect", () => {
  assert.equal(Object.keys(EFFECT_BY_ALERT_TYPE).length, 11);
  assert.equal(effectFor("Planned - Part Suspended"), "reduced");
  assert.equal(effectFor("Planned - Express to Local"), "added_at_local_stops");
  assert.equal(effectFor("Extra Service"), "added");
  assert.equal(effectFor("Delays"), "delay");
  assert.equal(effectFor("Station Notice"), "informational");
});

test("added service is not a disruption", () => {
  assert.equal(isDisrupting(effectFor("Planned - Express to Local")), false);
  assert.equal(isDisrupting(effectFor("Extra Service")), false);
  assert.equal(isDisrupting(effectFor("Station Notice")), false);
});

test("an unrecognized alert_type fails toward caution", () => {
  assert.equal(effectFor("Planned - Something MTA Invented In 2027"), "unknown");
  assert.equal(effectFor(undefined), "unknown");
  assert.equal(isDisrupting("unknown"), true);
  assert.equal(isKnownAlertType("Planned - Something MTA Invented In 2027"), false);
  assert.equal(isKnownAlertType("Delays"), true);
});

// ─── Translations ────────────────────────────────────────────────────────────

test("englishText prefers language 'en' even when 'en-html' sorts first", () => {
  const value = {
    translation: [
      { text: "<p>No <strong>[6]</strong></p>", language: "en-html" },
      { text: "No [6] between Hunts Point Av and 125 St", language: "en" },
    ],
  };
  assert.equal(englishText(value), "No [6] between Hunts Point Av and 125 St");
});

test("englishText falls back to the only entry when there is no 'en'", () => {
  assert.equal(englishText({ translation: [{ text: "only", language: "es" }] }), "only");
  assert.equal(englishText({ translation: [] }), null);
  assert.equal(englishText(undefined), null);
});

// ─── Station resolution ──────────────────────────────────────────────────────

test("the stop ids that shipped wrong once are pinned", () => {
  // A prior BetaNYC report wrote 629 for 68 St-Hunter College and still reached
  // the right conclusion, so the error survived review. This is the guard.
  assert.equal(stationById("628")?.stop_name, "68 St-Hunter College");
  assert.equal(stationById("629")?.stop_name, "59 St");
  assert.equal(stationById("630")?.stop_name, "51 St");
  assert.equal(stationById("640")?.stop_name, "Brooklyn Bridge-City Hall");
});

test("route membership is joined into the bundled snapshot", () => {
  assert.equal(STATIONS.route_membership, true);
  assert.equal(STATIONS.count, 496);
  assert.deepEqual(STATIONS.stations_without_routes, []);
  // The 4 runs local overnight, so 628 legitimately serves 4 as well as 6/6X.
  assert.deepEqual(stationById("628")?.routes, ["4", "6", "6X"]);
  assert.deepEqual(stationById("621")?.routes, ["4", "5", "6", "6X"]);
  assert.deepEqual(stationById("A15")?.routes, ["A", "B", "C", "D"]);
  assert.deepEqual(stationById("725")?.routes, ["7", "7X"]);
});

test("station names are not unique, and '125 St' is the proof", () => {
  const matches = resolveStationMatches("125 St");
  assert.deepEqual(
    matches.map((m) => m.stop_id).sort(),
    ["116", "225", "621", "A15"]
  );
  // Every one is an exact name match, so nothing may be picked on score.
  assert.ok(matches.every((m) => m.score === 100));
});

test("route_id narrows an ambiguous name to one station", () => {
  assert.deepEqual(
    resolveStationMatches("125 St", { routeId: "6" }).map((m) => m.stop_id),
    ["621"]
  );
  assert.deepEqual(
    resolveStationMatches("125 St", { routeId: "A" }).map((m) => m.stop_id),
    ["A15"]
  );
  assert.deepEqual(
    resolveStationMatches("125 St", { routeId: "1" }).map((m) => m.stop_id),
    ["116"]
  );
});

test("resolve_station('68 St') ranks 68 St-Hunter College first", () => {
  const matches = resolveStationMatches("68 St");
  assert.equal(matches[0].stop_id, "628");
  assert.equal(matches[0].stop_name, "68 St-Hunter College");
});

test("token matching keeps 168 St out of a '68 St' search", () => {
  // "68 St" IS a substring of "168 St-Washington Hts". Substring matching would
  // offer a station 100 blocks uptown as a candidate; token matching does not.
  assert.equal(scoreStation("68 St", "168 St-Washington Hts"), 0);
  assert.ok(scoreStation("68 St", "68 St-Hunter College") > 0);
  assert.equal(resolveStationMatches("68 St").some((m) => m.stop_id === "112"), false);
});

test("an exact name scores above a prefix, which scores above a fragment", () => {
  assert.equal(scoreStation("68 St-Hunter College", "68 St-Hunter College"), 100);
  assert.equal(scoreStation("68 St", "68 St-Hunter College"), 80);
  assert.equal(scoreStation("Hunter College", "68 St-Hunter College"), 60);
  assert.equal(scoreStation("College Hunter", "68 St-Hunter College"), 40);
  assert.equal(scoreStation("Coney Island", "68 St-Hunter College"), 0);
});

test("resolveStationStrict returns candidates instead of guessing when tied", () => {
  const exact = resolveStationStrict("68 St-Hunter College");
  assert.ok("station" in exact && exact.station.stop_id === "628");

  const tied = resolveStationStrict("125 St");
  assert.ok("candidates" in tied, "125 St must not resolve to a single station");
  assert.equal(tied.reason, "ambiguous");
  assert.equal(tied.candidates.length, 4);

  const narrowed = resolveStationStrict("125 St", "6");
  assert.ok("station" in narrowed && narrowed.station.stop_id === "621");

  const none = resolveStationStrict("Hoboken Terminal");
  assert.ok("candidates" in none && none.reason === "no-match");
  assert.equal(none.candidates.length, 0);
});

test("a real station on the wrong route is reported as such, not as missing", () => {
  // Times Sq-42 St exists; no part of it is on the 6.
  const offRoute = resolveStationStrict("Times Sq-42 St", "6");
  assert.ok("candidates" in offRoute);
  assert.equal(offRoute.reason, "not-on-route");
  assert.ok(offRoute.candidates.length > 0, "the name matches should still be shown");
});

// ─── Elevator and escalator feeds ────────────────────────────────────────────

test("the current ene feed's upcoming-flagged rows are filtered out", () => {
  const rows = [
    { equipment: "EL190", isupcomingoutage: "N" },
    { equipment: "EL433", isupcomingoutage: "Y" },
  ];
  assert.deepEqual(
    filterEneRows(rows, false).map((r) => r.equipment),
    ["EL190"]
  );
  // The upcoming feed is already only upcoming rows; nothing to strip.
  assert.equal(filterEneRows(rows, true).length, 2);
});

// ─── Retry-After ─────────────────────────────────────────────────────────────

test("retryAfterMs honors delta-seconds, capped at 10s", () => {
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs("60"), 10_000);
  assert.equal(retryAfterMs("0"), 0);
  assert.equal(retryAfterMs("-5"), 0);
});

test("retryAfterMs handles the HTTP-date form, capped at 10s", () => {
  const soon = new Date(Date.now() + 3000).toUTCString();
  const ms = retryAfterMs(soon);
  assert.ok(ms > 0 && ms <= 10_000, `got ${ms}`);
  assert.equal(retryAfterMs(new Date(Date.now() + 60_000).toUTCString()), 10_000);
  assert.equal(retryAfterMs(new Date(Date.now() - 60_000).toUTCString()), 0);
});

test("retryAfterMs defaults to 1s when the header is absent or unparseable", () => {
  assert.equal(retryAfterMs(null), 1000);
  assert.equal(retryAfterMs("soon"), 1000);
});

// ─── Identification ──────────────────────────────────────────────────────────

test("requests identify themselves to MTA", () => {
  assert.match(USER_AGENT, /^mta-mcp\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/BetaNYC\/mta-mcp\)$/);
});

// ─── Elevator-feed station names ─────────────────────────────────────────────

test("elevator-feed names that miss GTFS by spelling now match exactly", () => {
  // The two misses counted in the 2026-09-17 fixtures. Both scored 0 before.
  assert.equal(scoreStation("Bedford Park Blvd", "Bedford Pk Blvd"), 0);
  assert.equal(scoreEneStation("Bedford Park Blvd", "Bedford Pk Blvd"), 100);
  assert.equal(
    scoreStation("42 St-Port Authority Bus Terminal", "42St/Port Authority-Bus Terminal"),
    0
  );
  assert.equal(
    scoreEneStation("42 St-Port Authority Bus Terminal", "42St/Port Authority-Bus Terminal"),
    100
  );
  assert.equal(scoreEneStation("Jamaica-Van Wyck", "Jamaica Van Wyck"), 100);
});

test("elevator-feed normalization splits glued digits and expands pk only", () => {
  assert.deepEqual(eneTokens("42St/Port Authority"), ["42", "st", "port", "authority"]);
  assert.deepEqual(eneTokens("42 St-Bryant Pk"), ["42", "st", "bryant", "park"]);
  // Digits are never split from each other, so 68 St still misses 168 St.
  assert.equal(scoreEneStation("68 St", "168 St-Washington Hts"), 0);
});

test("ordinal suffixes after a number are dropped; st is kept", () => {
  assert.deepEqual(eneTokens("34th St"), ["34", "st"]);
  assert.deepEqual(eneTokens("42nd St"), ["42", "st"]);
  assert.deepEqual(eneTokens("3rd Av"), ["3", "av"]);
  assert.deepEqual(eneTokens("1st Av"), ["1", "st", "av"]);
  // Only after a number: "Gun Hill Rd" keeps its road.
  assert.deepEqual(eneTokens("Gun Hill Rd"), ["gun", "hill", "rd"]);
  assert.equal(scoreEneStation("42nd St Port Authority", "42St/Port Authority-Bus Terminal"), 80);
  // resolve_station is untouched.
  assert.equal(scoreStation("34th St", "34 St-Herald Sq"), 0);
});

test("feedNameWithin needs a word that is not a number or a street type", () => {
  assert.equal(feedNameWithin("WTC Cortlandt", "Cortlandt St"), true);
  assert.equal(feedNameWithin("Court Sq-23 St", "Court Sq"), true);
  assert.equal(feedNameWithin("125 St", "125 St"), false);
  assert.equal(feedNameWithin("Jamaica-179 St", "179 St"), false);
  assert.equal(feedNameWithin("Court Sq-23 St", "Queens Plaza"), false);
});

test("a shorter feed name goes to the closest station on the shared route", () => {
  const row = { station: "Cortlandt St", trainno: "1" };
  assert.equal(eneRowWithinStation("138", row), true); // WTC Cortlandt, 1 word over
  assert.equal(eneRowWithinStation("101", row), false); // Van Cortlandt Park-242 St
  assert.equal(eneRowWithinStation("R25", row), false); // no shared route
  assert.equal(eneRowWithinStation("138", { station: "Cortlandt St", trainno: "" }), false);
  assert.equal(eneRowWithinStation("138", { trainno: "1" }), false);
});

test("trainno splits on slashes, commas, and spaces", () => {
  assert.deepEqual(trainnoRoutes("A/C/E/L"), ["A", "C", "E", "L"]);
  assert.deepEqual(trainnoRoutes("A, C / e"), ["A", "C", "E"]);
  assert.deepEqual(trainnoRoutes(""), []);
});

test("resolve_station's own matching is unchanged by the elevator rules", () => {
  assert.equal(scoreStation("Bryant Park", "42 St-Bryant Pk"), 0);
  assert.equal(scoreStation("68 St", "68 St-Hunter College"), 80);
});

// ─── Elevator-feed routes ────────────────────────────────────────────────────

test("express and shuttle route_ids map to the tokens trainno uses", () => {
  assert.deepEqual(eneRouteTokens("6X"), ["6X", "6"]);
  assert.deepEqual(eneRouteTokens("7X"), ["7X", "7"]);
  assert.deepEqual(eneRouteTokens("FX"), ["FX", "F"]);
  assert.deepEqual(eneRouteTokens("GS"), ["GS", "S"]);
  assert.deepEqual(eneRouteTokens("h"), ["H", "S"]);
  assert.deepEqual(eneRouteTokens("A"), ["A"]);
});

test("route matching is by whole trainno token, and an empty trainno is unknown", () => {
  const row = { trainno: "A/C/E/N/Q/R/W/1/2/3/7/S" };
  assert.equal(rowMatchesRouteTokens(row, eneRouteTokens("7X")), true);
  assert.equal(rowMatchesRouteTokens(row, eneRouteTokens("GS")), true);
  assert.equal(rowMatchesRouteTokens(row, eneRouteTokens("L")), false);
  // "1" must not match "LIRR" or "11" by substring.
  assert.equal(rowMatchesRouteTokens({ trainno: "7/LIRR" }, ["L"]), false);
  assert.equal(rowMatchesRouteTokens({ trainno: "" }, ["6"]), null);
  assert.equal(rowMatchesRouteTokens({}, ["6"]), null);
});

// ─── Elevator-feed dates ─────────────────────────────────────────────────────

test("parseEneDateMs reads MTA's format as New York wall-clock time", () => {
  // EDT: 11:55 PM on 9/16 is 03:55Z on 9/17.
  assert.equal(
    new Date(parseEneDateMs("09/16/2026 11:55:00 PM") as number).toISOString(),
    "2026-09-17T03:55:00.000Z"
  );
  // EST, and the 12 AM / 12 PM edge cases.
  assert.equal(
    new Date(parseEneDateMs("01/15/2026 12:00:00 AM") as number).toISOString(),
    "2026-01-15T05:00:00.000Z"
  );
  assert.equal(
    new Date(parseEneDateMs("01/15/2026 12:30:00 PM") as number).toISOString(),
    "2026-01-15T17:30:00.000Z"
  );
});

test("parseEneDateMs returns null rather than guessing", () => {
  for (const bad of [undefined, "", "2026-09-16", "09/16/2026", "13/01/2026 01:00:00 AM", "02/31/2026 01:00:00 AM", "09/16/2026 13:00:00 PM"]) {
    assert.equal(parseEneDateMs(bad), null, String(bad));
  }
});

const FETCHED = Date.parse("2026-09-17T16:00:00Z"); // when the fixtures were pulled

test("an outage window overlaps the New York day, half-open", () => {
  // Overnight work, 10 PM Friday to 6 AM Saturday.
  const row = { outagedate: "09/18/2026 10:00:00 PM", estimatedreturntoservice: "09/19/2026 06:00:00 AM" };
  assert.deepEqual(eneOverlapsEtDay(row, "2026-09-18", FETCHED), { overlaps: true, caveat: null });
  assert.deepEqual(eneOverlapsEtDay(row, "2026-09-19", FETCHED), { overlaps: true, caveat: null });
  assert.equal(eneOverlapsEtDay(row, "2026-09-20", FETCHED).overlaps, false);
  assert.equal(eneOverlapsEtDay(row, "2026-09-17", FETCHED).overlaps, false);
  // Returning exactly at midnight does not touch the next day.
  const toMidnight = { outagedate: "09/18/2026 10:00:00 PM", estimatedreturntoservice: "09/19/2026 12:00:00 AM" };
  assert.equal(eneOverlapsEtDay(toMidnight, "2026-09-19", FETCHED).overlaps, false);
});

test("missing or unreadable outage dates keep the row and flag it", () => {
  for (const row of [
    {},
    { outagedate: "09/18/2026 10:00:00 PM" },
    { outagedate: "soon", estimatedreturntoservice: "09/19/2026 06:00:00 AM" },
  ]) {
    assert.deepEqual(eneOverlapsEtDay(row, "2030-01-01", FETCHED), {
      overlaps: true,
      caveat: "unparseable_date",
    });
  }
  const backwards = { outagedate: "09/19/2026 10:00:00 PM", estimatedreturntoservice: "09/18/2026 06:00:00 AM" };
  assert.deepEqual(eneOverlapsEtDay(backwards, "2030-01-01", FETCHED), {
    overlaps: true,
    caveat: "inconsistent_dates",
  });
});

test("an outage still listed after its estimated return is treated as ongoing", () => {
  // Listed in a feed fetched 9/17 afternoon, due back 9/17 at 6 AM.
  const overdue = { outagedate: "09/16/2026 10:30:00 PM", estimatedreturntoservice: "09/17/2026 06:00:00 AM" };
  assert.deepEqual(eneOverlapsEtDay(overdue, "2026-09-25", FETCHED), {
    overlaps: true,
    caveat: "estimate_passed",
  });
  // Days its own window already covers get no caveat.
  assert.deepEqual(eneOverlapsEtDay(overdue, "2026-09-16", FETCHED), { overlaps: true, caveat: null });
  // Before it started, it still does not overlap.
  assert.equal(eneOverlapsEtDay(overdue, "2026-09-15", FETCHED).overlaps, false);
  // Fetched before the estimate, the estimate is trusted.
  const early = Date.parse("2026-09-17T09:00:00Z");
  assert.equal(eneOverlapsEtDay(overdue, "2026-09-25", early).overlaps, false);
});
