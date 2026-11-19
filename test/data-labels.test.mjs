import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ENE_CURRENT_URL, ENE_UPCOMING_URL, SUBWAY_ALERTS_URL } from "../dist/mta.js";
import { BETANYC_CHANGES, callTool } from "../dist/tools.js";

// BetaNYC's rule: when BetaNYC changes a publisher's data in any way, the answer says so, and it
// says so the way about_data does. about_data answers "BetaNYC modified this data" for all five
// MTA sources, so every MTA tool answer carries one such line per source it used
// (data_provenance), naming the same official record. No network: fetch answers from fixtures.

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const BODIES = {
  [SUBWAY_ALERTS_URL]: fixture("subway-alerts.json"),
  [ENE_CURRENT_URL]: fixture("nyct_ene.json"),
  [ENE_UPCOMING_URL]: fixture("nyct_ene_upcoming.json"),
};
process.env.MTA_MCP_MIN_INTERVAL_MS = "0";
globalThis.fetch = async (url) => {
  const body = BODIES[url];
  if (!body) throw new Error(`test stub: unexpected URL ${url}`);
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
};

const DAY = "2026-09-19";
const DATA_SOURCES = JSON.parse(readFileSync(new URL("../DATA-SOURCES.json", import.meta.url), "utf8"));

async function answer(name, args) {
  const r = await callTool(name, args);
  assert.notEqual(r.isError, true, r.content[0].text);
  return JSON.parse(r.content[0].text);
}

/** about_data's "Official record: …" line for one topic. */
async function aboutDataRecordLine(topic) {
  const r = await callTool("about_data", { topic });
  const line = r.content[0].text.split("\n").find((l) => l.startsWith("BetaNYC modified this data: "));
  assert.ok(line, `about_data says BetaNYC modified ${topic}`);
  return line.slice(line.indexOf("Official record: "));
}

// Every MTA tool, and each kind of answer that reads a different set of sources.
const CASES = [
  ["check_route_on_date", { route_id: "6", date: DAY }, ["service-alerts", "stations"]],
  [
    "check_route_on_date",
    { route_id: "6", date: DAY, stop_id: "628", include_accessibility: true },
    ["service-alerts", "elevator-outages", "stations", "station-accessibility", "elevator-inventory"],
  ],
  ["check_route_on_date", { route_id: "N", date: DAY, station: "86 St" }, ["stations", "station-accessibility"]],
  ["get_service_alerts", { date: DAY }, ["service-alerts", "stations"]],
  ["resolve_station", { query: "125 St" }, ["stations", "station-accessibility"]],
  ["get_accessibility_outages", {}, ["elevator-outages"]],
  [
    "get_accessibility_outages",
    { stop_id: "A27" },
    ["elevator-outages", "elevator-inventory", "stations", "station-accessibility"],
  ],
];

test("every MTA tool answer says BetaNYC modified the data, for each source it used", async () => {
  for (const [name, args, want] of CASES) {
    const label = `${name} ${JSON.stringify(args)}`;
    const a = await answer(name, args);
    assert.ok(Array.isArray(a.data_provenance), `${label}: data_provenance`);
    assert.deepEqual(a.data_provenance.map((p) => p.id).sort(), [...want].sort(), label);
    for (const p of a.data_provenance) {
      assert.ok(p.text.startsWith("BetaNYC modified this data: "), `${label} ${p.id}: ${p.text}`);
      assert.match(p.text, /This copy should not be considered the official record\./, `${label} ${p.id}`);
      assert.equal(p.changed_by_betanyc?.kind, "modified-by-betanyc", `${label} ${p.id}`);
      assert.equal(p.changed_by_betanyc.detail, BETANYC_CHANGES[p.id], `${label} ${p.id}`);
      // The same official record, word for word, as about_data names.
      assert.ok(p.text.endsWith(await aboutDataRecordLine(p.id)), `${label} ${p.id}: ${p.text}`);
    }
  }
});

test("every source BetaNYC labels in an answer is one about_data calls modified", () => {
  for (const id of Object.keys(BETANYC_CHANGES)) {
    const s = DATA_SOURCES.sources.find((x) => x.id === id);
    assert.ok(s, id);
    assert.equal(s.official, true, id);
    assert.equal(s.changes.changed, true, `${id}: DATA-SOURCES.json must say BetaNYC changed it`);
  }
});

test("the labels say what BetaNYC does that MTA's file does not", () => {
  // The station list: BetaNYC built it, routes are BetaNYC's, order and score are BetaNYC's.
  for (const text of [BETANYC_CHANGES.stations, DATA_SOURCES.sources.find((s) => s.id === "stations").changes.detail]) {
    assert.match(text, /buil(t|ds) (this|its own) station list from MTA's GTFS file/i);
    assert.match(text, /routes.*(worked out by BetaNYC|from MTA's trips and stop times)/);
    assert.match(text, /order and each (candidate's )?score are BetaNYC's own ranking/);
  }
  // Outage rows: MTA's, in BetaNYC's order.
  assert.match(BETANYC_CHANGES["elevator-outages"], /its own order/);
  assert.match(DATA_SOURCES.sources.find((s) => s.id === "elevator-outages").changes.detail, /order of the rows is BetaNYC's/);
  // Alert text: English only, under MTA's field names; nothing claims "unaltered".
  for (const text of [BETANYC_CHANGES["service-alerts"], DATA_SOURCES.sources.find((s) => s.id === "service-alerts").changes.detail]) {
    assert.match(text, /header_text, description_text and human_readable_active_period.*keeps one translation as plain text under MTA's field names \(MTA's English one, or MTA's first one when there is no English\) and drops the other/);
  }
  assert.doesNotMatch(JSON.stringify(DATA_SOURCES), /passed on unaltered/);
});

test("resolve_station's own note calls the list BetaNYC's, built from MTA's GTFS", async () => {
  const a = await answer("resolve_station", { query: "125 St" });
  assert.match(a.station_data.note, /^A station list BetaNYC built from a dated copy of MTA's subway GTFS file/);
  assert.match(a.station_data.note, /order of the candidates and each score are BetaNYC's own ranking/);
  assert.doesNotMatch(a.station_data.note, /^Static snapshot of MTA's subway GTFS/);
});
