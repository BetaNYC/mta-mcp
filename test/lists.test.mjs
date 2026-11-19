import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ENE_DATA_SOURCE, ENE_CURRENT_URL, SUBWAY_ALERTS_URL } from "../dist/mta.js";
import { LIMITS, callTool } from "../dist/tools.js";

// Lists (issue #14): a default limit, a hard maximum, "showing N of M" and how to get the
// rest, against a large fixture. And each answer names the feed it read (issue #13).
// No network: fetch answers from fixtures multiplied out to 500 rows.

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const ALERTS = fixture("subway-alerts.json");
const ENE = fixture("nyct_ene.json");
const DAY = "2026-09-19";

// 500 alerts active all day on DAY, on the 6, each with its own id.
const template = ALERTS.entity[0];
const bigAlerts = {
  header: ALERTS.header,
  entity: Array.from({ length: 500 }, (_, i) => ({
    ...template,
    id: `lmm:planned_work:${900000 + i}`,
    alert: {
      ...template.alert,
      active_period: [{ start: Date.parse(`${DAY}T00:00:00-04:00`) / 1000, end: Date.parse(`${DAY}T23:59:00-04:00`) / 1000 }],
      informed_entity: [{ agency_id: "MTASBWY", route_id: "6" }],
    },
  })),
};
// 500 current outage rows: copies of the feed's current rows with distinct equipment ids.
const current = ENE.filter((r) => r.isupcomingoutage !== "Y");
const bigEne = Array.from({ length: 500 }, (_, i) => ({ ...current[i % current.length], equipment: `EQ${i}` }));

process.env.MTA_MCP_MIN_INTERVAL_MS = "0";
globalThis.fetch = async (url) => {
  const body = url === SUBWAY_ALERTS_URL ? bigAlerts : url === ENE_CURRENT_URL ? bigEne : null;
  if (!body) throw new Error(`no fixture for ${url}`);
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

async function call(name, args) {
  const r = await callTool(name, args);
  assert.notEqual(r.isError, true, r.content[0].text);
  return JSON.parse(r.content[0].text);
}

test("get_service_alerts: default page, counts cover every alert, next_offset pages on", async () => {
  const first = await call("get_service_alerts", { date: DAY, route_id: "6" });
  assert.equal(first.alert_count, 500);
  assert.equal(first.alerts.length, LIMITS.get_service_alerts.default);
  assert.equal(first.paging.total, 500);
  assert.equal(first.paging.next_offset, 20);
  assert.match(first.paging.showing, /^Showing 20 of 500 alerts \(1 to 20\)\. More are available: call again with offset 20\.$/);

  const last = await call("get_service_alerts", { date: DAY, route_id: "6", offset: 480, limit: 100 });
  assert.equal(last.alerts.length, 20);
  assert.equal(last.paging.next_offset, null);
  assert.equal(last.alerts[0].entity_id, "lmm:planned_work:900480");
  assert.doesNotMatch(last.paging.showing, /More are available/);
});

test("a limit over the maximum is refused, not quietly cut", async () => {
  for (const [tool, args] of [
    ["get_service_alerts", { date: DAY }],
    ["get_accessibility_outages", {}],
    ["resolve_station", { query: "St" }],
  ]) {
    const r = await callTool(tool, { ...args, limit: LIMITS[tool].max + 1 });
    assert.equal(r.isError, true, tool);
    assert.match(r.content[0].text, /'limit'/);
  }
});

test("get_accessibility_outages: 500 rows page 50 at a time, and name the elevator feed", async () => {
  const r = await call("get_accessibility_outages", {});
  assert.equal(r.outage_count, 500);
  assert.equal(r.outages.length, LIMITS.get_accessibility_outages.default);
  assert.equal(r.paging.next_offset, 50);
  assert.equal(r.data_source, ENE_DATA_SOURCE);
  assert.match(r.data_source, /EAndEFeeds/);
  const max = await call("get_accessibility_outages", { limit: 200, offset: 400 });
  assert.equal(max.outages.length, 100);
  assert.equal(max.paging.next_offset, null);
});

test("resolve_station counts every match, not just the first ten", async () => {
  const r = await call("resolve_station", { query: "St" });
  assert.ok(r.match_count > 100, `match_count ${r.match_count}`);
  assert.equal(r.candidates.length, 10);
  assert.equal(r.paging.total, r.match_count);
  assert.match(r.data_source, /gtfs_subway\.zip/);
  assert.match(r.disclaimer, /Unofficial/);
});

test("check_route_on_date names both feeds when it reads both", async () => {
  const r = await call("check_route_on_date", { route_id: "6", date: DAY, stop_id: "628", include_accessibility: true });
  assert.match(r.data_source, /serviceAlerts.*EAndEFeeds/);
  const alone = await call("check_route_on_date", { route_id: "6", date: DAY });
  assert.doesNotMatch(alone.data_source, /EAndEFeeds/);
});
