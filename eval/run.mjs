#!/usr/bin/env node
// Runs eval/questions.json against the saved MTA feeds in test/fixtures/. No request goes to
// MTA: fetch is replaced before the tools load. Prints one line per question and a total;
// with --out FILE, writes the same to FILE. Exit 1 if any question fails.
//
//   npm run eval                                   (builds first)
//   node eval/run.mjs --out eval/runs/YYYY-MM-DD.txt

import { readFileSync, writeFileSync } from "node:fs";

const fixtures = new URL("../test/fixtures/", import.meta.url);
const byFeed = {
  "camsys%2Fsubway-alerts.json": "subway-alerts.json",
  "nyct%2Fnyct_ene.json": "nyct_ene.json",
  "nyct%2Fnyct_ene_upcoming.json": "nyct_ene_upcoming.json",
};
globalThis.fetch = async (url) => {
  const feed = Object.keys(byFeed).find((k) => String(url).endsWith(k));
  if (!feed) throw new Error(`eval: no fixture for ${url}`);
  return new Response(readFileSync(new URL(byFeed[feed], fixtures)), { status: 200 });
};
process.env.MTA_MCP_MIN_INTERVAL_MS = "0";

const { callTool } = await import("../dist/tools.js");
const { questions } = JSON.parse(readFileSync(new URL("questions.json", import.meta.url), "utf8"));

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function problems(answer, check) {
  const out = [];
  for (const [path, want] of check.equals ?? []) {
    if (!same(get(answer, path), want)) out.push(`${path} is ${JSON.stringify(get(answer, path))}, expected ${JSON.stringify(want)}`);
  }
  for (const [path, want] of check.includes ?? []) {
    const got = get(answer, path);
    if (!(Array.isArray(got) || typeof got === "string") || !got.includes(want)) out.push(`${path} does not include ${JSON.stringify(want)}`);
  }
  for (const [path, n] of check.length ?? []) {
    if (get(answer, path)?.length !== n) out.push(`${path} has length ${get(answer, path)?.length}, expected ${n}`);
  }
  for (const [path, field, want] of check.sorted ?? []) {
    const got = (get(answer, path) ?? []).map((x) => x[field]).sort();
    if (!same(got, want)) out.push(`${path}[].${field} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  return out;
}

const lines = [];
let passed = 0;
for (const q of questions) {
  const found = [];
  for (const step of q.steps) {
    const r = await callTool(step.tool, step.args);
    if (r.isError) {
      found.push(`${step.tool} failed: ${r.content[0].text}`);
      continue;
    }
    found.push(...problems(JSON.parse(r.content[0].text), step.check).map((p) => `${step.tool}: ${p}`));
  }
  if (found.length === 0) passed += 1;
  lines.push(`${found.length === 0 ? "PASS" : "FAIL"} ${q.id} ${q.q}`, ...found.map((p) => `     ${p}`));
}
lines.push(`${passed} of ${questions.length} passed`);
const text = `${lines.join("\n")}\n`;
process.stdout.write(text);
const outIdx = process.argv.indexOf("--out");
if (outIdx !== -1) writeFileSync(process.argv[outIdx + 1], text);
process.exit(passed === questions.length ? 0 : 1);
