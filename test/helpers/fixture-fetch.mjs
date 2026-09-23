// Preloaded with `node --import` by skill-cli.test.mjs. Replaces fetch before
// the skill script loads, so the script's child process never reaches MTA.
//
// FIXTURE_FETCH=serve  answers from test/fixtures/ and counts calls in
//                      FIXTURE_FETCH_LOG, one line per call
// FIXTURE_FETCH=block  throws on any call, to prove a run used the disk cache

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const byFeed = {
  "camsys%2Fsubway-alerts.json": "subway-alerts.json",
  "nyct%2Fnyct_ene.json": "nyct_ene.json",
  "nyct%2Fnyct_ene_upcoming.json": "nyct_ene_upcoming.json",
};

globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (process.env.FIXTURE_FETCH !== "serve") throw new Error(`network blocked in test: ${url}`);
  if (process.env.FIXTURE_FETCH_LOG) appendFileSync(process.env.FIXTURE_FETCH_LOG, url + "\n");
  const feed = Object.keys(byFeed).find((k) => url.endsWith(k));
  if (!feed) throw new Error(`no fixture for ${url}`);
  return new Response(readFileSync(join(fixtures, byFeed[feed])), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
