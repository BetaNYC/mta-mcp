import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The skill's command-line script, run as a real child process against
// fixtures. No network: the preload replaces fetch before the script loads.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "skills", "mta-subway", "scripts", "mta.mjs");
const preload = join(root, "test", "helpers", "fixture-fetch.mjs");

function run(args, env = {}) {
  const res = spawnSync(process.execPath, ["--import", preload, script, ...args], {
    encoding: "utf8",
    env: { ...process.env, MTA_MCP_DIR: undefined, ...env },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function freshCache() {
  const dir = mkdtempSync(join(tmpdir(), "mta-skill-test-"));
  return { MTA_SKILL_CACHE_DIR: dir, FIXTURE_FETCH_LOG: join(dir, "fetches.log") };
}

const CITYCAMP = ["check_route_on_date", JSON.stringify({ route_id: "6", date: "2026-09-19", stop_id: "628" })];

test("answers from the server's own code, as compact JSON", () => {
  const r = run(CITYCAMP, { ...freshCache(), FIXTURE_FETCH: "serve" });
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.trim().includes("\n"), "output should be one line of compact JSON");
  const body = JSON.parse(r.out);
  // The CityCamp regression, same as the server's tests: the 6 is suspended in
  // the Bronx that weekend and 68 St-Hunter College is not affected.
  assert.equal(body.disrupted, false);
  assert.equal(body.station.stop_id, "628");
  assert.equal(body.may_not_be_realtime, true);
  assert.match(body.disclaimer, /Unofficial/);
});

test("a second run inside the TTL uses the disk cache and keeps the real fetch time", () => {
  const env = freshCache();
  const first = run(CITYCAMP, { ...env, FIXTURE_FETCH: "serve" });
  assert.equal(first.code, 0, first.err);
  assert.equal(readFileSync(env.FIXTURE_FETCH_LOG, "utf8").trim().split("\n").length, 1);

  const second = run(CITYCAMP, { ...env, FIXTURE_FETCH: "block" });
  assert.equal(second.code, 0, second.err);
  // The cached answer must not claim to be newer than the download it came from.
  assert.ok(
    Date.parse(JSON.parse(second.out).fetched_at) <= Date.now() &&
      Date.parse(JSON.parse(second.out).fetched_at) >= Date.parse(JSON.parse(first.out).fetched_at) - 1000
  );
});

test("an expired cache fetches again", () => {
  const env = { ...freshCache(), MTA_MCP_CACHE_TTL_MS: "0", FIXTURE_FETCH: "serve" };
  run(CITYCAMP, env);
  run(CITYCAMP, env);
  assert.equal(readFileSync(env.FIXTURE_FETCH_LOG, "utf8").trim().split("\n").length, 2);
});

test("station lookup makes no request at all", () => {
  const r = run(["resolve_station", JSON.stringify({ query: "125 St" })], { ...freshCache(), FIXTURE_FETCH: "block" });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).match_count, 4);
});

test("elevator outages come through the same cache", () => {
  const env = { ...freshCache(), FIXTURE_FETCH: "serve" };
  const r = run(["get_accessibility_outages", JSON.stringify({ station: "Port Authority" })], env);
  assert.equal(r.code, 0, r.err);
  assert.ok(JSON.parse(r.out).outage_count > 0);
});

test("bad JSON arguments exit 2 with an example", () => {
  const r = run(["get_service_alerts", "{route:6}"], freshCache());
  assert.equal(r.code, 2);
  assert.match(r.err, /one JSON object/);
});

test("server errors, like an unknown parameter, exit 1 on stderr", () => {
  const r = run(["get_service_alerts", JSON.stringify({ route: "6" })], freshCache());
  assert.equal(r.code, 1);
  assert.match(r.err, /does not accept 'route'/);
});

test("a missing build exits 2 and says how to fix it", () => {
  const r = run(["resolve_station", "{}"], { ...freshCache(), MTA_MCP_DIR: join(tmpdir(), "no-such-mta-mcp") });
  assert.equal(r.code, 2);
  assert.match(r.err, /npm install/);
});

test("--help lists all four tools", () => {
  const r = run(["--help"], freshCache());
  assert.equal(r.code, 0, r.err);
  for (const name of ["check_route_on_date", "get_service_alerts", "resolve_station", "get_accessibility_outages"]) {
    assert.ok(r.out.includes(name), name);
  }
  assert.ok(existsSync(script));
});
