#!/usr/bin/env node
// SHA-256 of each bundled snapshot in data/, kept in data/SHA256SUMS (the format
// `shasum -a 256 -c` reads, run from the repo root). Each snapshot records its own
// pull date (generated_at, source.data_pulled_at); this records its exact bytes,
// so a hand edit or a half-written file fails test/data-checksums.test.mjs.
// The update scripts rewrite it after they write; run it by hand after any
// other change to data/. Issue #15.
//
//   node scripts/data-checksums.mjs           rewrite data/SHA256SUMS
//   node scripts/data-checksums.mjs --check   exit 1 if it is out of date

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
export const SUMS_PATH = join(DATA_DIR, "SHA256SUMS");

/** The SHA256SUMS text for every .json file in data/, sorted by name. */
export function checksumsText(dir = DATA_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => `${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}  data/${f}\n`)
    .join("");
}

export function writeChecksums() {
  writeFileSync(SUMS_PATH, checksumsText());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const ok = readFileSync(SUMS_PATH, "utf8") === checksumsText();
    process.stdout.write(ok ? "data/SHA256SUMS is current\n" : "data/SHA256SUMS is out of date: run node scripts/data-checksums.mjs\n");
    process.exit(ok ? 0 : 1);
  }
  writeChecksums();
  process.stdout.write(`Wrote ${SUMS_PATH}\n`);
}
