import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SNAPSHOTS,
  assessFreshness,
  setSnapshotClock,
  snapshotFooter,
  snapshotWarning,
  startupNotice,
} from "../dist/freshness.js";
import { callTool } from "../dist/tools.js";
import { ENE_CURRENT_URL, EQUIPMENT, STATIONS, STATION_ADA, SUBWAY_ALERTS_URL } from "../dist/mta.js";

// No network: fetch is stubbed with the committed fixtures, and "now" is pinned
// with setSnapshotClock so the ages do not drift with the calendar.

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const bodies = {
  [SUBWAY_ALERTS_URL]: fixture("subway-alerts.json"),
  [ENE_CURRENT_URL]: fixture("nyct_ene.json"),
};
globalThis.fetch = async (url) => {
  const body = bodies[url];
  if (body === undefined) throw new Error(`test stub: unexpected URL ${url}`);
  return new Response(JSON.stringify(body), { status: 200 });
};
process.env.MTA_MCP_MIN_INTERVAL_MS = "0";

// Noon in New York, so the calendar date is unambiguous.
const at = (isoDate) => Date.parse(`${isoDate}T16:00:00Z`);

after(() => setSnapshotClock(null));

// ─── assessFreshness ─────────────────────────────────────────────────────────

test("fresh: younger than the threshold", () => {
  const f = assessFreshness("2026-09-22T12:00:00Z", 30, at("2026-10-12"));
  assert.deepEqual(f, { as_of: "2026-09-22", age_days: 20, threshold_days: 30, stale: false });
});

test("exactly at the threshold is not stale yet", () => {
  const f = assessFreshness("2026-09-22T12:00:00Z", 30, at("2026-10-22"));
  assert.equal(f.age_days, 30);
  assert.equal(f.stale, false);
});

test("one day past the threshold is stale", () => {
  const f = assessFreshness("2026-09-22T12:00:00Z", 30, at("2026-10-23"));
  assert.equal(f.age_days, 31);
  assert.equal(f.stale, true);
});

test("the as-of date is the New York calendar date of the pull", () => {
  // 02:54 UTC on 09-23 is 22:54 on 09-22 in New York.
  const f = assessFreshness("2026-09-23T02:54:06.424Z", 30, at("2026-10-12"));
  assert.equal(f.as_of, "2026-09-22");
});

test("a bare date is taken as written", () => {
  assert.equal(assessFreshness("2026-09-22", 30, at("2026-10-12")).as_of, "2026-09-22");
});

test("missing or unparseable date: unknown, and counted as stale", () => {
  for (const raw of [undefined, null, "", "not a date"]) {
    const f = assessFreshness(raw, 30, at("2026-10-12"));
    assert.deepEqual(f, { as_of: null, age_days: null, threshold_days: 30, stale: true }, String(raw));
  }
});

// ─── Strict parsing, midnight, DST ──────────────────────────────────────────

test("junk that Date.parse would accept is unreadable", () => {
  for (const raw of ["pulled 1", "2026-02-30", "2026-02-30T12:00:00Z", "2026-09-22T12:00:00", "2026/09/22", "1"]) {
    assert.equal(assessFreshness(raw, 30, at("2026-10-12")).as_of, null, raw);
  }
});

test("a date in the future is treated as unreadable and warned about", () => {
  const f = assessFreshness("2026-10-13T16:00:00Z", 30, at("2026-10-12"));
  assert.deepEqual(f, { as_of: null, age_days: null, threshold_days: 30, stale: true });
});

test("around midnight in New York", () => {
  // 03:59Z is 23:59 EDT the day before; 04:00Z is midnight.
  assert.equal(assessFreshness("2026-09-23T03:59:59Z", 30, at("2026-10-12")).as_of, "2026-09-22");
  assert.equal(assessFreshness("2026-09-23T04:00:00Z", 30, at("2026-10-12")).as_of, "2026-09-23");
  // A minute before New York midnight it is still the pull day: 0 days old.
  assert.equal(assessFreshness("2026-09-22T12:00:00Z", 30, Date.parse("2026-09-23T03:59:00Z")).age_days, 0);
  assert.equal(assessFreshness("2026-09-22T12:00:00Z", 30, Date.parse("2026-09-23T04:00:00Z")).age_days, 1);
});

test("across the end of daylight saving time", () => {
  // DST ends 2026-11-01. Midnight is 04:00Z before it and 05:00Z after.
  const pulled = "2026-10-31T16:00:00Z";
  assert.equal(assessFreshness(pulled, 30, Date.parse("2026-11-02T04:30:00Z")).age_days, 1); // 23:30 EST 11-01
  assert.equal(assessFreshness(pulled, 30, Date.parse("2026-11-02T05:00:00Z")).age_days, 2); // 00:00 EST 11-02
  // Across the start of DST, 2027-03-14: midnight moves from 05:00Z to 04:00Z.
  assert.equal(assessFreshness("2027-03-13T17:00:00Z", 30, Date.parse("2027-03-15T04:00:00Z")).age_days, 2);
  assert.equal(assessFreshness("2027-03-13T17:00:00Z", 30, Date.parse("2027-03-15T03:59:00Z")).age_days, 1);
});

// ─── Pinned snapshot dates ───────────────────────────────────────────────────
//
// The bundled files change on every `npm run refresh-data`, so the tests below
// pin their dates in memory and restore them after. Only the last test reads
// the real dates, and it computes what to expect from the files themselves.

const PINNED = {
  stations: "2026-09-17T04:49:10.816Z", // 2026-09-17 in New York
  station_ada: "2026-09-23T02:54:06.424Z", // 2026-09-22 in New York
  equipment: "2026-09-23T02:54:06.617Z",
};

function pinDates(dates = PINNED) {
  const saved = [STATIONS.generated_at, STATION_ADA.source.data_pulled_at, EQUIPMENT.source.data_pulled_at];
  STATIONS.generated_at = dates.stations;
  STATION_ADA.source.data_pulled_at = dates.station_ada;
  EQUIPMENT.source.data_pulled_at = dates.equipment;
  return () => {
    [STATIONS.generated_at, STATION_ADA.source.data_pulled_at, EQUIPMENT.source.data_pulled_at] = saved;
  };
}

function pinned(name, fn) {
  test(name, async () => {
    const restore = pinDates();
    try {
      await fn();
    } finally {
      restore();
      setSnapshotClock(null);
    }
  });
}

test("thresholds: 90 days for the station list, 30 for the data.ny.gov files", () => {
  assert.equal(SNAPSHOTS.stations.thresholdDays, 90);
  assert.equal(SNAPSHOTS.station_ada.thresholdDays, 30);
  assert.equal(SNAPSHOTS.equipment.thresholdDays, 30);
});

pinned("no warning while every snapshot is within its threshold", () => {
  assert.equal(snapshotWarning(["stations", "station_ada", "equipment"], at("2026-10-12")), null);
});

pinned("warning names the date, the age, and the refresh command", () => {
  const w = snapshotWarning(["station_ada"], at("2026-11-08"));
  assert.equal(
    w,
    "Station accessibility data is from 2026-09-22 (47 days old). Run `npm run accessibility-data` in your mta-mcp folder to refresh."
  );
});

pinned("a shared refresh command is listed once", () => {
  const w = snapshotWarning(["station_ada", "equipment", "stations"], at("2027-01-01"));
  assert.match(w, /Station list is from 2026-09-17/);
  assert.match(w, /Elevator and escalator inventory is from 2026-09-22/);
  assert.equal(w.match(/npm run accessibility-data/g).length, 1);
  assert.match(w, /Run `npm run stations` and `npm run accessibility-data` in your mta-mcp folder/);
});

pinned("an unreadable date gives an 'unknown date' warning", () => {
  STATION_ADA.source.data_pulled_at = "garbage";
  const w = snapshotWarning(["station_ada"], at("2026-10-12"));
  assert.equal(
    w,
    "Station accessibility data has no readable as-of date. Run `npm run accessibility-data` in your mta-mcp folder to refresh."
  );
  assert.deepEqual(snapshotFooter(["station_ada"]).snapshot_as_of, { station_ada: null });
});

pinned("startup notice lists every snapshot and flags stale ones", () => {
  const fresh = startupNotice(at("2026-10-12"));
  assert.equal(fresh.length, 4);
  assert.match(fresh[0], /^Station list snapshot: 2026-09-17, 25 days old \(refresh after 90 days\)$/);
  assert.doesNotMatch(fresh.join("\n"), /STALE/);
  assert.match(fresh[3], /^Snapshots are within their refresh thresholds\./);

  const stale = startupNotice(at("2026-11-08"));
  assert.match(stale[1], /Station accessibility data snapshot: 2026-09-22, 47 days old \(refresh after 30 days, STALE\)/);
  assert.match(stale[3], /Run `npm run accessibility-data`/);
});

// ─── Tool answers ────────────────────────────────────────────────────────────

async function call(name, args) {
  const result = await callTool(name, args);
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

pinned("resolve_station carries the as-of dates, and no warning while fresh", async () => {
  setSnapshotClock(() => at("2026-10-12"));
  const r = await call("resolve_station", { query: "68 St", route_id: "6" });
  assert.deepEqual(r.snapshot_as_of, { stations: "2026-09-17", station_ada: "2026-09-22" });
  assert.equal(r.snapshot_warning, null);
});

pinned("resolve_station warns once a snapshot is stale", async () => {
  setSnapshotClock(() => at("2026-11-08"));
  const r = await call("resolve_station", { query: "68 St", route_id: "6" });
  assert.match(r.snapshot_warning, /Station accessibility data is from 2026-09-22 \(47 days old\)/);
  assert.doesNotMatch(r.snapshot_warning, /Station list/); // 52 days, under 90
});

pinned("get_accessibility_outages lists only the snapshots it read", async () => {
  setSnapshotClock(() => at("2026-11-08"));
  const all = await call("get_accessibility_outages", {});
  assert.deepEqual(all.snapshot_as_of, {});
  assert.equal(all.snapshot_warning, null);

  const named = await call("get_accessibility_outages", { station: "Bedford" });
  assert.deepEqual(named.snapshot_as_of, { equipment: "2026-09-22" });
  assert.match(named.snapshot_warning, /Elevator and escalator inventory is from 2026-09-22 \(47 days old\)/);

  const s = await call("get_accessibility_outages", { stop_id: "628" });
  assert.deepEqual(Object.keys(s.snapshot_as_of).sort(), ["equipment", "station_ada", "stations"]);
});

pinned("check_route_on_date and get_service_alerts warn when the station list is stale", async () => {
  setSnapshotClock(() => at("2027-01-01"));
  const c = await call("check_route_on_date", { route_id: "6", date: "2026-09-19", stop_id: "628" });
  assert.deepEqual(Object.keys(c.snapshot_as_of).sort(), ["station_ada", "stations"]);
  assert.match(c.snapshot_warning, /Station list is from 2026-09-17 \(106 days old\)/);
  assert.match(c.snapshot_warning, /`npm run stations`/);

  const a = await call("get_service_alerts", { date: "2026-09-19" });
  assert.deepEqual(a.snapshot_as_of, { stations: "2026-09-17" });
  assert.match(a.snapshot_warning, /Station list is from 2026-09-17/);
});

pinned("an unknown stop_id error gives the station list's date and the refresh command", async () => {
  setSnapshotClock(() => at("2027-01-01"));
  for (const [tool, args] of [
    ["check_route_on_date", { route_id: "6", date: "2026-09-19", stop_id: "ZZZ" }],
    ["get_accessibility_outages", { stop_id: "ZZZ" }],
  ]) {
    const result = await callTool(tool, args);
    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /The bundled station list is from 2026-09-17 \(106 days old\)\. If the station is new or renamed, run `npm run stations`/,
      tool
    );
  }
});

test("answers report the real bundled dates, whatever they are", async () => {
  // Expected values come from the files, so a refresh never breaks this.
  const ny = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
  const r = await call("resolve_station", { query: "68 St", route_id: "6" });
  assert.deepEqual(r.snapshot_as_of, {
    stations: ny(STATIONS.generated_at),
    station_ada: ny(STATION_ADA.source.data_pulled_at),
  });
});

test("the startup notice goes to stderr, never stdout", async () => {
  const { spawnSync } = await import("node:child_process");
  const server = new URL("../dist/index.js", import.meta.url).pathname;
  // stdin closes at once, so the server starts, logs, and exits. No tool is
  // called, so nothing is fetched.
  const run = spawnSync(process.execPath, [server], { input: "", encoding: "utf8", timeout: 10_000 });
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /snapshot_check: Station list snapshot: \d{4}-\d{2}-\d{2}/);
});
