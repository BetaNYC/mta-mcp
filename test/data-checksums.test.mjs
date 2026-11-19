import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
//
// The check is on path shapes only. It once also looked for this machine's username as a
// substring, which failed `npm test` for anyone whose username is a short common word that
// appears in a station name (a user named "park" and "Park Pl"). A path is what leaks a
// username, and every path shape below is caught whatever the username is.
const LOCAL_PATH =
  /\/Users\/|-Users-|\/Volumes\/|\/private\/(tmp|var)\/|\/home\/|\/var\/folders\/|\b[A-Za-z]:[\\/](Users|Documents and Settings)[\\/]|\b[A-Za-z]:\\/;

// A folder next to this file, as a path. fileURLToPath, not URL.pathname: pathname keeps
// percent-escapes, so a checkout in a folder with a space ("mta mcp") would read "mta%20mcp".
function localDir(relative, base = import.meta.url) {
  return fileURLToPath(new URL(relative, base));
}
const BUNDLED_DIRS = [DATA_DIR, localDir("./fixtures")];

function localPathsIn(text, isJson) {
  const hits = [];
  const check = (s) => {
    if (typeof s === "string" && LOCAL_PATH.test(s)) hits.push(s);
  };
  // JSON: check decoded strings, so an escape like "\n" is not read as a backslash.
  if (isJson) JSON.parse(text, (k, v) => (check(k), check(v), v));
  else for (const line of text.split("\n")) check(line);
  return hits;
}

test("no bundled data file contains a local path", () => {
  for (const dir of BUNDLED_DIRS) {
    for (const f of readdirSync(dir)) {
      const hits = localPathsIn(readFileSync(join(dir, f), "utf8"), f.endsWith(".json"));
      assert.deepEqual(hits, [], `${dir}/${f} contains a local path`);
    }
  }
});

// A Python cache file (scripts/__pycache__/*.pyc) records the full path of the checkout that
// made it, so committing one leaks a machine's folder names. One was committed twice, by
// running the What's changed checks. .gitignore keeps them out; this test catches one that is
// added anyway (git add -f). It reads git's own list of tracked files.
const CACHE_FILE = /(^|\/)__pycache__\/|\.pyc$/;

function trackedCacheFiles(files) {
  return files.filter((f) => CACHE_FILE.test(f));
}

function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: localDir("../"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null; // no git, or not a git checkout (a tarball, say)
  }
}

test("no tracked file is a Python cache file", (t) => {
  const files = trackedFiles();
  if (files === null) {
    t.skip("git is not available here, or this is not a git checkout, so tracked files cannot be listed");
    return;
  }
  assert.ok(files.length > 0, "git listed no tracked files");
  assert.deepEqual(
    trackedCacheFiles(files),
    [],
    "a Python cache file is tracked: git rm it (it records the local path of the checkout that made it)"
  );
});

test("the cache-file check catches the forms it is meant to", () => {
  assert.deepEqual(
    trackedCacheFiles([
      "scripts/__pycache__/whats_changed.cpython-315.pyc",
      "__pycache__/x.cpython-312.pyc",
      "scripts/tests/__pycache__/README",
      "a/b/stray.pyc",
      "scripts/whats_changed.py",
      "docs/pycache-notes.md",
    ]),
    [
      "scripts/__pycache__/whats_changed.cpython-315.pyc",
      "__pycache__/x.cpython-312.pyc",
      "scripts/tests/__pycache__/README",
      "a/b/stray.pyc",
    ]
  );
});

test("the path check catches the forms it is meant to", () => {
  const forms = [
    "/Users/x/a.zip",
    "/Volumes/Disk/x/a.zip",
    "/private/tmp/a.zip",
    "/private/var/folders/a",
    "/var/folders/ab/T/a.zip",
    "/home/x/a",
    "C:\\Users\\x",
    "C:/Users/x/a.zip",
    "D:\\data\\a.zip",
    "C:/Documents and Settings/x/a.zip",
    "C:\\Documents and Settings\\x\\a.zip",
    "-Users-x-Code",
    "file:///Users/x/a.zip",
  ];
  for (const s of forms) {
    assert.equal(localPathsIn(JSON.stringify({ generated_from: s }), true).length, 1, s);
  }
  assert.deepEqual(localPathsIn(JSON.stringify({ note: "Line one:\nline two", url: "https://a.b/c" }), true), []);
});

test("a station name holding a short common word is not a hit, whatever the username", () => {
  // Pretend this machine's user is "park", as some people's is. Before the fix the check
  // matched the username anywhere, so "Park Pl" and every other "Park" station failed npm test.
  const real = os.userInfo;
  os.userInfo = (...a) => ({ ...real(...a), username: "park" });
  syncBuiltinESMExports();
  try {
    for (const name of ["Park Pl", "Bay Ridge Av", "Ozone Park-Lefferts Blvd", "Avenue H", "Prospect Av"]) {
      assert.deepEqual(localPathsIn(JSON.stringify({ stop_name: name }), true), [], name);
    }
    const stations = readFileSync(join(DATA_DIR, "stations.json"), "utf8");
    assert.match(stations, /"Park Pl"/, "the station list still has a name with the word in it");
    assert.deepEqual(localPathsIn(stations, true), []);
  } finally {
    os.userInfo = real;
    syncBuiltinESMExports();
  }
});

test("a checkout folder with a space in its name is read as a real path", () => {
  const base = "file:///srv/mta%20mcp/test/data-checksums.test.mjs";
  assert.equal(localDir("./fixtures", base), "/srv/mta mcp/test/fixtures");
});

test("update-stations records the MTA file and its checksum, never the local zip path", () => {
  const bytes = Buffer.from("zip bytes");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const local = zipProvenance(true, bytes);
  // --from-zip: the operator's file is not proven to be MTA's, so the record says whose it is.
  assert.equal(
    local.generated_from,
    `local zip supplied by the operator with --from-zip, said to be a copy of ${GTFS_SUBWAY_ZIP_URL} (sha256 ${sha})`
  );
  assert.doesNotMatch(local.generated_from, /saved copy/);
  assert.equal(local.source_sha256, sha);
  assert.deepEqual(localPathsIn(JSON.stringify(local), true), []);
  const dl = zipProvenance(false, Buffer.from(""));
  assert.equal(dl.generated_from, `download of ${GTFS_SUBWAY_ZIP_URL}`);
  assert.match(dl.source_sha256, /^[0-9a-f]{64}$/);
});
