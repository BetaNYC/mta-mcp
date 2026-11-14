// about_data: "where does this data come from?" (betanyc-ai-workspace
// platform/system/about-data-standard.md). The answer is built from DATA-SOURCES.json by the
// shared module (src/betanyc-tools.ts, a copy: never edit it here). These tests keep the promises
// that matter for this server: every tool has a documented source, MTA's feeds are read live,
// the bundled snapshots report the same pull dates the tools do, and nothing is fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callTool, TOOLS } from "../dist/tools.js";
import { assertEveryToolExplained } from "../dist/betanyc-tools.js";
import { EQUIPMENT, STATION_ADA, STATIONS } from "../dist/mta.js";

globalThis.fetch = async (url) => {
  throw new Error(`about_data must not fetch, but fetched ${url}`);
};

const DS_TEXT = readFileSync(new URL("../DATA-SOURCES.json", import.meta.url), "utf8");
const TOOL_NAMES = TOOLS.map((t) => t.name);
const ask = async (args = {}) => {
  const r = await callTool("about_data", args);
  assert.notEqual(r.isError, true, r.content[0].text);
  return r;
};
const one = (body, topic) => body.sources.find((s) => s.topic === topic);

test("every tool says where its data comes from, so a new tool cannot ship unexplained", () => {
  assertEveryToolExplained(DS_TEXT, TOOL_NAMES);
  assert.throws(() => assertEveryToolExplained(DS_TEXT, [...TOOL_NAMES, "brand_new_tool"]), /brand_new_tool/);
});

test("about_data is advertised, read-only, and lists this server's topics", () => {
  const t = TOOLS.find((x) => x.name === "about_data");
  assert.ok(t);
  assert.equal(t.annotations.readOnlyHint, true);
  assert.match(t.description, /Topics on this server: service-alerts, elevator-outages, stations, station-accessibility, elevator-inventory\./);
});

test("five sources, all MTA's, each with a link and whether it is official", async () => {
  const { structuredContent: body } = await ask();
  assert.deepEqual(body.topics, ["service-alerts", "elevator-outages", "stations", "station-accessibility", "elevator-inventory"]);
  for (const s of body.sources) {
    assert.equal(s.publisher, "Metropolitan Transportation Authority", s.topic);
    assert.equal(s.official, true, s.topic);
    assert.match(s.source_url, /^https:\/\//, s.topic);
  }
});

test("about_data gives BetaNYC's contact address, lab@beta.nyc", async () => {
  const r = await ask();
  assert.equal(r.structuredContent.contact_email, "lab@beta.nyc");
  assert.match(r.content[0].text, /^Questions or error reports about this data, to BetaNYC: lab@beta\.nyc$/m);
});

test("the two MTA feeds are read live, and BetaNYC's added fields make the figures not official", async () => {
  for (const topic of ["service-alerts", "elevator-outages"]) {
    const s = one((await ask({ topic })).structuredContent, topic);
    assert.equal(s.as_of_status, "live", topic);
    assert.equal(s.figures_official, false, topic);
    assert.match(s.terms.terms_url, /mta\.info\/developers\/terms-and-conditions/, topic);
  }
});

test("the bundled snapshots report the pull times in data/, the same ones the tools give", async () => {
  const want = {
    stations: STATIONS.generated_at,
    "station-accessibility": STATION_ADA.source.data_pulled_at,
    "elevator-inventory": EQUIPMENT.source.data_pulled_at,
  };
  for (const [topic, asOf] of Object.entries(want)) {
    const s = one((await ask({ topic })).structuredContent, topic);
    assert.equal(s.as_of_status, "read", topic);
    assert.equal(s.as_of, asOf, topic);
  }
});

test("station accessibility is MTA's record with fields left out, values unchanged", async () => {
  const r = await ask({ topic: "station-accessibility" });
  const s = one(r.structuredContent, "station-accessibility");
  assert.equal(s.figures_official, true);
  assert.match(r.content[0].text, /reshaped by BetaNYC with some fields left out \(values unchanged\)/);
  assert.equal(s.report_errors.in_the_data_email, "OpenData@mtahq.org");
});

test("asking by tool name returns the sources behind that tool", async () => {
  const { structuredContent: body } = await ask({ topic: "resolve_station" });
  assert.deepEqual(body.sources.map((s) => s.topic).sort(), ["station-accessibility", "stations"]);
});

test("corrections link to their What's changed entries", async () => {
  const s = one((await ask({ topic: "service-alerts" })).structuredContent, "service-alerts");
  assert.equal(s.corrections.length, 1);
  assert.match(s.corrections[0].url, /^https:\/\/betanyc\.github\.io\/mta-mcp\/whats-changed\.html#2026-09-23-/);
});

test("an unknown topic is an error that lists the topics", async () => {
  const r = await callTool("about_data", { topic: "bus-time" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /service-alerts/);
});

test("service alerts: MTA's values are not altered, and BetaNYC's reading is named as BetaNYC's", async () => {
  const s = one((await ask({ topic: "service-alerts" })).structuredContent, "service-alerts");
  assert.deepEqual(s.changed_by_betanyc.steps, ["filtered", "fields-removed", "merged", "counted"]);
  assert.match(s.changed_by_betanyc.detail, /^BetaNYC does not alter MTA's values\./);
  assert.match(s.changed_by_betanyc.detail, /separate betanyc object/);
  assert.doesNotMatch(s.changed_by_betanyc.detail, /word for word/, "englishText falls back to MTA's first version");
});

test("the MTA credit line says BetaNYC is not the MTA and makes no accuracy claim (terms 2 and 3)", async () => {
  const { structuredContent: body } = await ask();
  for (const topic of ["service-alerts", "elevator-outages", "stations"]) {
    assert.equal(
      one(body, topic).terms.credit_line,
      "Data obtained from the MTA and passed on by BetaNYC, which is not the MTA and makes no claim that it is accurate, complete or timely.",
      topic,
    );
  }
});
