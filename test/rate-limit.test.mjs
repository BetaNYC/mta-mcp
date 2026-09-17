import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheTtlMs, fetchFeed, minIntervalMs, retryAfterMs } from "../dist/mta.js";

// The politeness mechanisms, exercised against a counting stub. No network.
//
// MTA publishes no rate limit and no refresh cadence, so these are the only
// thing standing between a chatty conversation and something that reads as a
// denial of service from the far end. A failure here is not a style issue.

let fetchCount = 0;
let requestedAt = [];
let nextResponses = [];

function ok(body = { entity: [] }) {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function status(code, headers = {}) {
  return () => new Response("upstream says no", { status: code, headers });
}

globalThis.fetch = async () => {
  fetchCount += 1;
  requestedAt.push(Date.now());
  const next = nextResponses.length > 0 ? nextResponses.shift() : ok();
  return next();
};

function reset() {
  fetchCount = 0;
  requestedAt = [];
  nextResponses = [];
}

// Distinct URLs per test so the TTL cache never crosses between them. The
// stub answers any URL, and the min-interval gate is global by design, so
// using different URLs also proves the gate is not merely per-URL.
const url = (n) => `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/test-${n}.json`;

// ─── Defaults ────────────────────────────────────────────────────────────────

test("the shipped defaults are a 60s cache and a 1s minimum interval", () => {
  delete process.env.MTA_MCP_CACHE_TTL_MS;
  delete process.env.MTA_MCP_MIN_INTERVAL_MS;
  assert.equal(cacheTtlMs(), 60_000);
  assert.equal(minIntervalMs(), 1000);
});

test("overrides are read, and nonsense falls back to the default", () => {
  process.env.MTA_MCP_CACHE_TTL_MS = "5000";
  assert.equal(cacheTtlMs(), 5000);
  process.env.MTA_MCP_CACHE_TTL_MS = "not-a-number";
  assert.equal(cacheTtlMs(), 60_000);
  process.env.MTA_MCP_CACHE_TTL_MS = "-1";
  assert.equal(cacheTtlMs(), 60_000);
  delete process.env.MTA_MCP_CACHE_TTL_MS;
});

// ─── Mechanism 1: TTL cache ──────────────────────────────────────────────────

test("two calls inside the TTL window make one request", async () => {
  reset();
  process.env.MTA_MCP_MIN_INTERVAL_MS = "0";
  const u = url("ttl");
  const first = await fetchFeed(u);
  const second = await fetchFeed(u);
  assert.equal(fetchCount, 1);
  assert.equal(second.fromCache, true);
  assert.equal(first.fetchedAt, second.fetchedAt, "a cache hit reports when MTA served it");
});

test("an expired entry is refetched", async () => {
  reset();
  process.env.MTA_MCP_MIN_INTERVAL_MS = "0";
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  const u = url("ttl-expired");
  await fetchFeed(u);
  await fetchFeed(u);
  assert.equal(fetchCount, 2);
  delete process.env.MTA_MCP_CACHE_TTL_MS;
});

// ─── Mechanism 2: single flight ──────────────────────────────────────────────

test("concurrent calls for one URL share a single request", async () => {
  reset();
  process.env.MTA_MCP_MIN_INTERVAL_MS = "0";
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  const u = url("single-flight");
  const [a, b, c, d] = await Promise.all([fetchFeed(u), fetchFeed(u), fetchFeed(u), fetchFeed(u)]);
  assert.equal(fetchCount, 1, "four tools firing at once must not become four requests");
  assert.deepEqual([a.fetchedAt, b.fetchedAt, c.fetchedAt, d.fetchedAt].map(Boolean), [
    true,
    true,
    true,
    true,
  ]);
  delete process.env.MTA_MCP_CACHE_TTL_MS;
});

// ─── Mechanism 3: global minimum interval ────────────────────────────────────

test("sequential requests are spaced by at least the minimum interval", async () => {
  reset();
  process.env.MTA_MCP_MIN_INTERVAL_MS = "150";
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  await fetchFeed(url("gap-a"));
  await fetchFeed(url("gap-b"));
  assert.equal(fetchCount, 2);
  const gap = requestedAt[1] - requestedAt[0];
  assert.ok(gap >= 150, `expected >= 150ms between requests, got ${gap}ms`);
  delete process.env.MTA_MCP_CACHE_TTL_MS;
});

test("the gate is global: different URLs fired at once still queue", async () => {
  reset();
  process.env.MTA_MCP_MIN_INTERVAL_MS = "150";
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  await Promise.all([fetchFeed(url("global-a")), fetchFeed(url("global-b"))]);
  assert.equal(fetchCount, 2);
  const gap = requestedAt[1] - requestedAt[0];
  assert.ok(gap >= 150, `expected >= 150ms between two different URLs, got ${gap}ms`);
  delete process.env.MTA_MCP_CACHE_TTL_MS;
});

// ─── Mechanism 4: bounded retry ──────────────────────────────────────────────

test("a 404 is not retried — it is our bug, not congestion", async () => {
  reset();
  process.env.MTA_MCP_MIN_INTERVAL_MS = "0";
  nextResponses = [status(404)];
  await assert.rejects(() => fetchFeed(url("not-found")), /404/);
  assert.equal(fetchCount, 1, "a 404 must cost exactly one request");
});

test("a 400 is not retried either", async () => {
  reset();
  process.env.MTA_MCP_MIN_INTERVAL_MS = "0";
  nextResponses = [status(400)];
  await assert.rejects(() => fetchFeed(url("bad-request")), /400/);
  assert.equal(fetchCount, 1);
});

test("a 429 is retried, honoring Retry-After", async () => {
  reset();
  process.env.MTA_MCP_MIN_INTERVAL_MS = "0";
  nextResponses = [status(429, { "retry-after": "0" }), ok()];
  const started = Date.now();
  const result = await fetchFeed(url("throttled"));
  assert.equal(fetchCount, 2);
  assert.equal(result.fromCache, false);
  // Retry-After: 0 cannot shorten the 1s backoff floor.
  assert.ok(Date.now() - started >= 1000, "backoff is a floor, not a ceiling");
});

test("retries are bounded — a persistent 500 stops after two", async () => {
  reset();
  process.env.MTA_MCP_MIN_INTERVAL_MS = "0";
  nextResponses = [status(500), status(500), status(500), ok()];
  await assert.rejects(() => fetchFeed(url("broken")), /500/);
  assert.equal(fetchCount, 3, "one attempt plus at most two retries");
});

// ─── Retry-After parsing ─────────────────────────────────────────────────────

test("Retry-After is parsed in both documented forms and clamped at 10s", () => {
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs("600"), 10_000);
  assert.equal(retryAfterMs(new Date(Date.now() + 600_000).toUTCString()), 10_000);
  assert.equal(retryAfterMs(null), 1000);
});
