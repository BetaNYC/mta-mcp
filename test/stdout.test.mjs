import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Clean stdout (issue #17). In server mode stdout is the MCP stdio channel: every line on it
// must be a JSON-RPC message. Diagnostics, such as the snapshot dates logged at startup, go
// to stderr. The server fetches nothing at startup or for tools/list, so this makes no
// request to MTA.

const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("in server mode, stdout carries only JSON-RPC; startup notes go to stderr", async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const listed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no tools/list answer; stdout so far: ${out}`)), 10_000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.split("\n").some((l) => l.includes('"id":2'))) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdout-test", version: "0" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  try {
    await listed;
  } finally {
    child.kill();
  }
  const lines = out.split("\n").filter(Boolean);
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    const msg = JSON.parse(line); // throws on anything that is not JSON
    assert.equal(msg.jsonrpc, "2.0", line);
  }
  assert.match(err, /snapshot_check/, "startup notes are written to stderr");
});

// Live tests kept apart: the one live request is scripts/smoke.mjs (npm run smoke). Neither
// npm test nor CI may run it, so the suite never reaches MTA.
test("npm test and CI never run the live smoke check", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.doesNotMatch(pkg.scripts.test, /smoke|live/);
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const runs = ci.split("\n").filter((l) => /^\s*(- )?run:|^\s{10,}\S/.test(l) && !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(runs, /npm run smoke|smoke\.mjs/);
});
