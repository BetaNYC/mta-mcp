#!/usr/bin/env node
// Command-line front end to mta-mcp, for use from a skill instead of an MCP.
//
// It runs the same code the MCP server runs (dist/tools.js), so the alert
// classification, station matching, and rate limiting are identical. The only
// addition is a small on-disk cache: each CLI run is a new process, so the
// server's in-memory 60-second cache would otherwise reset on every call.
//
//   node mta.mjs <tool> '<json args>'
//   node mta.mjs --help
//
// Needs a built checkout of BetaNYC/mta-mcp. Looks in this order: the
// MTA_MCP_DIR environment variable, the repo this script sits in, then
// ~/Code/mta-mcp.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hereRepo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const repo =
  process.env.MTA_MCP_DIR ??
  (existsSync(join(hereRepo, "dist", "tools.js")) ? hereRepo : join(homedir(), "Code", "mta-mcp"));
const dist = join(repo, "dist");
if (!existsSync(join(dist, "tools.js"))) {
  console.error(
    `mta-mcp build not found at ${dist}.\n` +
      "Clone and build it (git clone https://github.com/BetaNYC/mta-mcp.git && cd mta-mcp && npm install),\n" +
      "or set MTA_MCP_DIR to the checkout."
  );
  process.exit(2);
}

// ─── Disk cache, shared across runs ──────────────────────────────────────────
// Same TTL as the server's in-memory cache. Only successful responses are
// stored, and only for MTA's feed host.

const TTL_MS = Number(process.env.MTA_MCP_CACHE_TTL_MS ?? 60_000);
const CACHE_DIR = process.env.MTA_SKILL_CACHE_DIR ?? join(tmpdir(), "mta-mcp-skill-cache");
mkdirSync(CACHE_DIR, { recursive: true });
const cacheFile = (url) => join(CACHE_DIR, createHash("sha256").update(url).digest("hex") + ".json");

let oldestCacheHit = null; // epoch ms of the oldest cached feed used this run
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api-endpoint.mta.info/")) return realFetch(input, init);

  const file = cacheFile(url);
  if (existsSync(file)) {
    const savedAt = statSync(file).mtimeMs;
    if (Date.now() - savedAt < TTL_MS) {
      oldestCacheHit = Math.min(oldestCacheHit ?? savedAt, savedAt);
      return new Response(readFileSync(file), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  }

  const res = await realFetch(input, init);
  if (res.ok) writeFileSync(file, await res.clone().text());
  return res;
};

// ─── Run one tool ────────────────────────────────────────────────────────────

const { callTool, TOOLS } = await import(pathToFileURL(join(dist, "tools.js")).href);
const [tool, rawArgs = "{}"] = process.argv.slice(2);

if (!tool || tool === "--help" || tool === "-h") {
  for (const t of TOOLS) {
    console.log(`${t.name}\n  ${t.description}`);
    for (const [key, spec] of Object.entries(t.inputSchema.properties)) {
      const req = t.inputSchema.required?.includes(key) ? " (required)" : "";
      console.log(`    ${key}: ${spec.type}${req}. ${spec.description}`);
    }
    console.log();
  }
  process.exit(0);
}

let args;
try {
  args = JSON.parse(rawArgs);
} catch {
  console.error(`Arguments must be one JSON object, e.g. '{"route_id":"6","date":"2026-09-26"}'. Got: ${rawArgs}`);
  process.exit(2);
}

const result = await callTool(tool, args);
const text = result.content[0].text;
if (result.isError) {
  console.error(text);
  process.exit(1);
}

// Compact JSON costs fewer tokens than the server's indented output.
const payload = JSON.parse(text);
// A disk-cache hit looks fresh to the server code, so put the real fetch time
// back. The staleness disclosure MTA's terms require depends on it.
if (oldestCacheHit !== null && "fetched_at" in payload) {
  payload.fetched_at = new Date(oldestCacheHit).toISOString();
}
console.log(JSON.stringify(payload));
