import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOOLS, callTool } from "../dist/tools.js";

// These tests never touch the live MTA feeds. fetch is stubbed so anything that
// escapes argument validation is served locally instead of reaching
// api-endpoint.mta.info, and the politeness gate is disabled so a suite of
// rejections does not sit idle for a second each.

process.env.MTA_MCP_MIN_INTERVAL_MS = "0";

const ALERTS = JSON.parse(
  readFileSync(new URL("./fixtures/subway-alerts.json", import.meta.url), "utf8")
);
globalThis.fetch = async () =>
  new Response(JSON.stringify(ALERTS), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("every advertised tool schema rejects unknown parameters", () => {
  for (const tool of TOOLS) {
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `${tool.name}.inputSchema is missing additionalProperties: false`
    );
  }
});

test("every advertised parameter is a declared property", () => {
  for (const tool of TOOLS) {
    for (const required of tool.inputSchema.required ?? []) {
      assert.ok(
        Object.hasOwn(tool.inputSchema.properties, required),
        `${tool.name} requires '${required}' but does not declare it`
      );
    }
  }
});

const UNKNOWN_PARAM_CASES = [
  ["check_route_on_date", { route_id: "6", date: "2026-09-19" }, "route_id"],
  ["get_service_alerts", { date: "2026-09-19" }, "route_id"],
  ["resolve_station", { query: "68 St" }, "query"],
  ["get_accessibility_outages", {}, "station"],
];

for (const [tool, validArgs, expectedParamInMessage] of UNKNOWN_PARAM_CASES) {
  test(`${tool} rejects an unknown parameter instead of silently dropping it`, async () => {
    const result = await callTool(tool, { ...validArgs, bogus_unknown_param: "SHOULD_REJECT" });
    const text = result.content[0].text;
    assert.equal(result.isError, true, `expected an error, got: ${text}`);
    // The message must name the offending key and the accepted ones.
    assert.match(text, /bogus_unknown_param/);
    assert.match(text, new RegExp(`\\b${expectedParamInMessage}\\b`));
    assert.match(text, /answer a different question/);
  });
}

test("a valid call still answers", async () => {
  const result = await callTool("resolve_station", { query: "68 St-Hunter College" });
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(JSON.parse(result.content[0].text).candidates[0].stop_id, "628");
});

test("a missing required parameter is rejected by name", async () => {
  const missingDate = await callTool("check_route_on_date", { route_id: "6" });
  assert.equal(missingDate.isError, true);
  assert.match(missingDate.content[0].text, /date/);

  const missingQuery = await callTool("resolve_station", {});
  assert.equal(missingQuery.isError, true);
  assert.match(missingQuery.content[0].text, /query/);
});

test("a wrongly-typed parameter is rejected, not coerced", async () => {
  const result = await callTool("get_service_alerts", { planned_only: "yes" });
  assert.equal(result.isError, true, result.content[0].text);
});

test("an out-of-enum effect is rejected", async () => {
  const result = await callTool("get_service_alerts", { effect: "catastrophic" });
  assert.equal(result.isError, true, result.content[0].text);
});

test("an unknown tool name is an error, not a crash", async () => {
  const result = await callTool("get_bus_positions", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown tool/);
});
