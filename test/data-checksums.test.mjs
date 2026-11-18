import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { DATA_DIR, SUMS_PATH, checksumsText } from "../scripts/data-checksums.mjs";
import { GTFS_SUBWAY_ZIP_URL, zipProvenance } from "../scripts/update-stations.mjs";

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

// No bundled file may record where it sat on someone's disk: a local path names a machine
// and often a person. data/stations.json once did (`local zip: /private/tmp/...`).
const LOCAL_PATH = /\/Users\/|-Users-|\/private\/(tmp|var)\/|\/home\/|\/var\/folders\/|\b[A-Za-z]:\\/;
const BUNDLED_DIRS = [DATA_DIR, new URL("./fixtures", import.meta.url).pathname];

function localPathsIn(text, isJson) {
  const hits = [];
  const check = (s) => {
    if (typeof s !== "string") return;
    if (LOCAL_PATH.test(s)) hits.push(s);
    else if (USER.length >= 3 && s.toLowerCase().includes(USER)) hits.push(s);
  };
  // JSON: check decoded strings, so an escape like "\n" is not read as a backslash.
  if (isJson) JSON.parse(text, (k, v) => (check(k), check(v), v));
  else for (const line of text.split("\n")) check(line);
  return hits;
}
const USER = userInfo().username.toLowerCase();

test("no bundled data file contains a local path or this machine's username", () => {
  for (const dir of BUNDLED_DIRS) {
    for (const f of readdirSync(dir)) {
      const hits = localPathsIn(readFileSync(join(dir, f), "utf8"), f.endsWith(".json"));
      assert.deepEqual(hits, [], `${dir}/${f} contains a local path or username`);
    }
  }
});

test("the path check catches the forms it is meant to", () => {
  for (const s of ["/Users/x/a.zip", "/private/tmp/a.zip", "/home/x/a", "C:\\Users\\x", "-Users-x-Code"]) {
    assert.equal(localPathsIn(JSON.stringify({ generated_from: s }), true).length, 1, s);
  }
  assert.deepEqual(localPathsIn(JSON.stringify({ note: "Line one:\nline two", url: "https://a.b/c" }), true), []);
});

test("update-stations records the MTA file and its checksum, never the local zip path", () => {
  const p = zipProvenance(true, Buffer.from("zip bytes"));
  assert.equal(p.generated_from, `saved copy of ${GTFS_SUBWAY_ZIP_URL}`);
  assert.match(p.source_sha256, /^[0-9a-f]{64}$/);
  assert.equal(zipProvenance(false, Buffer.from("")).generated_from, `download of ${GTFS_SUBWAY_ZIP_URL}`);
});
