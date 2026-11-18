import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DATA_DIR, SUMS_PATH, checksumsText } from "../scripts/data-checksums.mjs";

// Bundled data provenance (issue #15): each snapshot in data/ records when it was pulled,
// and data/SHA256SUMS records its exact bytes. A hand edit, a half-written file, or a
// refresh that skipped the checksum step fails here.

test("data/SHA256SUMS matches every bundled snapshot", () => {
  assert.equal(
    readFileSync(SUMS_PATH, "utf8"),
    checksumsText(),
    "data/ changed without its checksums: run node scripts/data-checksums.mjs (the update scripts do this)"
  );
});

test("every bundled snapshot records when it was pulled, and from where", () => {
  for (const f of readdirSync(DATA_DIR).filter((n) => n.endsWith(".json"))) {
    const d = JSON.parse(readFileSync(`${DATA_DIR}/${f}`, "utf8"));
    const pulled = d.source?.data_pulled_at ?? d.generated_at;
    assert.match(pulled ?? "", /^\d{4}-\d{2}-\d{2}T/, `${f} has no pull date`);
    assert.match(d.source?.page_url ?? d.source_url ?? "", /^https:\/\//, `${f} has no source link`);
  }
});
