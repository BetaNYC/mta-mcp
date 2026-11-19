import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedError, setRequestTimeoutForTests } from "../dist/mta.js";
import { callTool, errorResult } from "../dist/tools.js";

// Every failure is an isError result with a plain sentence saying what went wrong and what
// to try; MTA's response body is cut to 500 characters; no stack trace (issue #12). No
// network: fetch is stubbed, and each case runs in this file's own process.

process.env.MTA_MCP_MIN_INTERVAL_MS = "0";
let respond = () => new Response("{}", { status: 200 });
globalThis.fetch = async () => respond();

const textOf = (r) => r.content[0].text;
const STACK = /^\s+at\s/m;

test("a wrongly typed argument is a sentence, not zod's JSON", async () => {
  const r = await callTool("resolve_station", { query: 6 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^Error: resolve_station cannot use these arguments: 'query': Expected string, received number\. /);
  assert.doesNotMatch(textOf(r), /[[{]/, "no JSON in the message");
});

test("a missing argument is named as required", async () => {
  const r = await callTool("check_route_on_date", { route_id: "6" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /'date' is required/);
});

test("an unknown tool lists the tools there are", async () => {
  const r = await callTool("get_bus_positions", {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Unknown tool: get_bus_positions\. This server's tools are: check_route_on_date, /);
});

test("an MTA error says what to do, and MTA's body is cut to 500 characters", async () => {
  respond = () => new Response("x".repeat(2000), { status: 404, statusText: "Not Found" });
  const r = await callTool("get_service_alerts", { date: "2026-09-19" });
  assert.equal(r.isError, true);
  const text = textOf(r);
  assert.match(text, /^Error: MTA's feed answered 404 Not Found.*report a bug in this server at https:\/\/github\.com\/BetaNYC\/mta-mcp\/issues/);
  const said = text.split("The source said: ")[1];
  assert.ok(said, "MTA's body is passed on");
  assert.ok(said.replace(/… \(cut at 500 characters\)$/, "").length <= 500, `body is ${said.length} characters`);
  respond = () => new Response("{}", { status: 200 });
});

test("a network failure says to check the connection", async () => {
  respond = () => {
    throw new TypeError("fetch failed");
  };
  const r = await callTool("get_accessibility_outages", {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^Error: Could not reach MTA's feed \(fetch failed\)\. Check this computer's internet connection/);
  respond = () => new Response("{}", { status: 200 });
});

test("a timeout, a 429 and a 5xx each say what to try", () => {
  const url = "https://api-endpoint.mta.info/x.json";
  const cases = [
    [new FeedError("t", url, null, "", true), /did not answer within 15 seconds\. Try again in a minute/],
    [new FeedError("t", url, 429, ""), /fewer requests \(HTTP 429\).*Wait a minute/],
    [new FeedError("t", url, 503, "down"), /HTTP 503.*Try again in a few minutes.*The source said: down$/s],
    [new FeedError("t", url, 400, ""), /refused the request \(HTTP 400\).*report it/],
  ];
  for (const [err, re] of cases) {
    const r = errorResult(err);
    assert.equal(r.isError, true);
    assert.match(textOf(r), re);
  }
});

test("no stack trace reaches the answer", () => {
  const err = new Error("something broke");
  err.message += `\n${err.stack}`;
  const r = errorResult(err);
  assert.match(textOf(r), /^Error: something broke/);
  assert.doesNotMatch(textOf(r), STACK);
});

// A 200 that is not JSON, and a body that stalls. Each runs with the cache off, so the stub
// is what answers.
async function uncached(fn) {
  const ttl = process.env.MTA_MCP_CACHE_TTL_MS;
  process.env.MTA_MCP_CACHE_TTL_MS = "0";
  try {
    return await fn();
  } finally {
    if (ttl === undefined) delete process.env.MTA_MCP_CACHE_TTL_MS;
    else process.env.MTA_MCP_CACHE_TTL_MS = ttl;
    respond = () => new Response("{}", { status: 200 });
  }
}

test("a 200 maintenance page is a plain sentence, not a JSON parse error", async () => {
  await uncached(async () => {
    let calls = 0;
    const page = `<!doctype html><html><body><h1>Down for maintenance</h1>${"x".repeat(2000)}</body></html>`;
    respond = () => {
      calls += 1;
      return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
    };
    const r = await callTool("get_service_alerts", { date: "2026-09-19" });
    assert.equal(r.isError, true);
    const text = textOf(r);
    assert.match(text, /^Error: MTA's feed answered, but with a web page or other text instead of data\./);
    assert.match(text, /maintenance\. Try again in a few minutes\. For service right now, check https:\/\/www\.mta\.info\./);
    assert.doesNotMatch(text, /SyntaxError|Unexpected token|is not valid JSON/);
    assert.doesNotMatch(text, STACK);
    const said = text.split("The source said: ")[1] ?? "";
    assert.match(said, /Down for maintenance/);
    assert.ok(said.replace(/… \(cut at 500 characters\)$/, "").length <= 500, `body is ${said.length} characters`);
    assert.equal(calls, 1, "a non-JSON 200 is not retried");
  });
});

test("a body that stalls after the headers times out with the timeout sentence", async () => {
  setRequestTimeoutForTests(50);
  try {
    await uncached(async () => {
      respond = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"entity": ['));
              // Never closes: MTA sent the headers and part of the body, then stalled.
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      const started = Date.now();
      const r = await callTool("get_service_alerts", { date: "2026-09-19" });
      assert.ok(Date.now() - started < 5000, "the deadline covers the body");
      assert.equal(r.isError, true);
      assert.match(textOf(r), /^Error: MTA's feed did not answer within 15 seconds\. Try again in a minute/);
      assert.doesNotMatch(textOf(r), /SyntaxError|Unexpected end/);
    });
  } finally {
    setRequestTimeoutForTests(null);
  }
});
