import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTRUCTIONS, TOOLS, betanyc } from "../dist/tools.js";

// Shared text lives once in the server instructions, not in every tool description
// (issue #18). Descriptions are sent with every tool on every turn.

const MTA_TOOLS = TOOLS.filter((t) => !betanyc.handles(t.name));

test("the instructions keep the shared about_data paragraph", () => {
  assert.ok(INSTRUCTIONS.includes(betanyc.instructions));
});

test("what every MTA tool shares is said in the instructions, not in each description", () => {
  for (const phrase of ["snapshot_as_of", "snapshot_warning", "must refresh", "own fields are", "paging"]) {
    assert.ok(INSTRUCTIONS.includes(phrase), `instructions lack '${phrase}'`);
    for (const t of MTA_TOOLS) assert.ok(!t.description.includes(phrase), `${t.name} repeats '${phrase}'`);
  }
});

test("no long sentence appears in two tool descriptions", () => {
  const seen = new Map();
  for (const t of MTA_TOOLS) {
    for (const s of t.description.split(/(?<=[.;]) /).filter((x) => x.length >= 40)) {
      assert.ok(!seen.has(s), `'${s}' is in both ${seen.get(s)} and ${t.name}`);
      seen.set(s, t.name);
    }
  }
});
