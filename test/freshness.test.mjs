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
import { ENE_CURRENT_URL, SUBWAY_ALERTS_URL, STATION_ADA } from "../dist/mta.js";

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

// ─── snapshotWarning ─────────────────────────────────────────────────────────

test("thresholds: 90 days for the station list, 30 for the data.ny.gov files", () => {
  assert.equal(SNAPSHOTS.stations.thresholdDays, 90);
  assert.equal(SNAPSHOTS.station_ada.thresholdDays, 30);
  assert.equal(SNAPSHOTS.equipment.thresholdDays, 30);
});

test("no warning while every snapshot is within its threshold", () => {
  // The bundled files were pulled 2026-09-17 (stations) and 2026-09-22.
  assert.equal(snapshotWarning(["stations", "station_ada", "equipment"], at("2026-10-12")), null);
});

test("warning names the date, the age, and the refresh command", () => {
  const w = snapshotWarning(["station_ada"], at("2026-11-08"));
  assert.equal(
    w,
    "Station accessibility data is from 2026-09-22 (47 days old). Run `npm run accessibility-data` in your mta-mcp folder to refresh."
  );
});

test("a shared refresh command is listed once", () => {
  const w = snapshotWarning(["station_ada", "equipment", "stations"], at("2027-01-01"));
  assert.match(w, /Station list is from 2026-09-17/);
  assert.match(w, /Elevator and escalator inventory is from 2026-09-22/);
  assert.equal(w.match(/npm run accessibility-data/g).length, 1);
  assert.match(w, /Run `npm run stations` and `npm run accessibility-data` in your mta-mcp folder/);
});

test("an unreadable date gives an 'unknown date' warning", () => {
  const saved = STATION_ADA.source.data_pulled_at;
  try {
    STATION_ADA.source.data_pulled_at = "garbage";
    const w = snapshotWarning(["station_ada"], at("2026-10-12"));
    assert.equal(
      w,
      "Station accessibility data has no readable as-of date. Run `npm run accessibility-data` in your mta-mcp folder to refresh."
    );
    assert.deepEqual(snapshotFooter(["station_ada"]).snapshot_as_of, { station_ada: null });
  } finally {
    STATION_ADA.source.data_pulled_at = saved;
  }
});

test("startup notice lists every snapshot and flags stale ones", () => {
  const fresh = startupNotice(at("2026-10-12"));
  assert.equal(fresh.length, 4);
  assert.match(fresh[0], /^Station list snapshot: 2026-09-17, 25 days old \(refresh after 90 days\)$/);
  assert.doesNotMatch(fresh.join("\n"), /STALE/);

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

test("resolve_station carries the as-of dates, and no warning while fresh", async () => {
  setSnapshotClock(() => at("2026-10-12"));
  const r = await call("resolve_station", { query: "68 St", route_id: "6" });
  assert.deepEqual(r.snapshot_as_of, { stations: "2026-09-17", station_ada: "2026-09-22" });
  assert.equal(r.snapshot_warning, null);
});

test("resolve_station warns once a snapshot is stale", async () => {
  setSnapshotClock(() => at("2026-11-08"));
  const r = await call("resolve_station", { query: "68 St", route_id: "6" });
  assert.match(r.snapshot_warning, /Station accessibility data is from 2026-09-22 \(47 days old\)/);
  assert.doesNotMatch(r.snapshot_warning, /Station list/); // 52 days, under 90
});

test("get_accessibility_outages warns about the inventory", async () => {
  setSnapshotClock(() => at("2026-11-08"));
  const r = await call("get_accessibility_outages", {});
  assert.deepEqual(r.snapshot_as_of, { equipment: "2026-09-22" });
  assert.match(r.snapshot_warning, /Elevator and escalator inventory is from 2026-09-22 \(47 days old\)/);

  const s = await call("get_accessibility_outages", { stop_id: "628" });
  assert.deepEqual(Object.keys(s.snapshot_as_of).sort(), ["equipment", "station_ada", "stations"]);
});

test("check_route_on_date and get_service_alerts warn when the station list is stale", async () => {
  setSnapshotClock(() => at("2027-01-01"));
  const c = await call("check_route_on_date", { route_id: "6", date: "2026-09-19", stop_id: "628" });
  assert.deepEqual(Object.keys(c.snapshot_as_of).sort(), ["station_ada", "stations"]);
  assert.match(c.snapshot_warning, /Station list is from 2026-09-17 \(106 days old\)/);
  assert.match(c.snapshot_warning, /`npm run stations`/);

  const a = await call("get_service_alerts", { date: "2026-09-19" });
  assert.deepEqual(a.snapshot_as_of, { stations: "2026-09-17" });
  assert.match(a.snapshot_warning, /Station list is from 2026-09-17/);
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
