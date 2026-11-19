import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTRUCTIONS, TOOLS } from "../dist/tools.js";
import { assertEveryToolAnnotated, toolListSize } from "../dist/betanyc-tools.js";

// Read-only annotations (issue #10). readOnlyHint defaults to false in the MCP spec, so a
// tool without it must be treated as possibly writing. Every tool here only reads.
test("every tool is annotated read-only, with an explicit openWorldHint", () => {
  assertEveryToolAnnotated(TOOLS);
  for (const t of TOOLS) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.ok(t.annotations.title, `${t.name} has no title`);
  }
});

test("openWorldHint is true exactly for the tools that call MTA's live feeds", () => {
  const open = TOOLS.filter((t) => t.annotations.openWorldHint).map((t) => t.name).sort();
  assert.deepEqual(open, ["check_route_on_date", "get_accessibility_outages", "get_service_alerts"]);
});

// Tool-list size (issue #11). Every tool definition plus the instructions is sent to the
// model on every turn, so its size is a cost. Same measure as nyc-311-mcp's
// test/tool-size.test.mjs. Measured 2026-11-18 at 17,974 characters (shared module 1.5.0,
// annotations added); the budget is that plus about 5%. Raise it only on purpose, with a
// dated line here saying why, and put text several tools share in the instructions.
// Raised on purpose 2026-11-18 (issue #14): limit and offset on three list tools, with their
// bounds in the schema. Measured 18,827 characters; the budget is that plus about 5%.
const BUDGET_CHARS = 19_800;

test("tools/list plus instructions stays within the size budget", () => {
  const size = toolListSize(TOOLS, INSTRUCTIONS);
  assert.ok(size <= BUDGET_CHARS, `tools/list JSON + instructions is ${size} characters, over the ${BUDGET_CHARS} budget`);
});
