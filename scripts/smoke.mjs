#!/usr/bin/env node
// The ONE live request this repo makes. Everything else runs against fixtures.
//
// Deliberately not part of `npm test` and not in CI: the test suite must never
// reach api-endpoint.mta.info, both because pinned fixtures are what make the
// assertions meaningful and because a test suite that fetches on every push is
// how a polite client turns impolite.
//
//   npm run build && npm run smoke
//
// It issues exactly one GET, through the same rate-limited path the tools use,
// and prints what came back.

import { SUBWAY_ALERTS_URL, USER_AGENT, fetchFeed } from "../dist/mta.js";
import { callTool } from "../dist/tools.js";

const started = Date.now();
process.stdout.write(`GET ${SUBWAY_ALERTS_URL}\nUser-Agent: ${USER_AGENT}\n\n`);

const { body, fetchedAt } = await fetchFeed(SUBWAY_ALERTS_URL);
const elapsed = Date.now() - started;

const entities = body.entity ?? [];
const types = new Map();
for (const e of entities) {
  const t = e.alert?.["transit_realtime.mercury_alert"]?.alert_type ?? "(none)";
  types.set(t, (types.get(t) ?? 0) + 1);
}

process.stdout.write(
  [
    `HTTP 200 in ${elapsed}ms, ${JSON.stringify(body).length.toLocaleString()} bytes of JSON`,
    `fetched_at:       ${new Date(fetchedAt).toISOString()}`,
    `feed timestamp:   ${body.header?.timestamp} (${new Date(
      (body.header?.timestamp ?? 0) * 1000
    ).toISOString()})`,
    `mercury version:  ${body.header?.["transit_realtime.mercury_feed_header"]?.mercury_version}`,
    `entities:         ${entities.length}`,
    "",
    "alert_type counts:",
    ...[...types.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `  ${String(n).padStart(4)}  ${t}`),
    "",
  ].join("\n")
);

// Second half: prove the tool surface answers off the live body. This reuses
// the cached response — it does NOT issue another request.
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const result = await callTool("check_route_on_date", { route_id: "6", date: today });
const parsed = JSON.parse(result.content[0].text);
process.stdout.write(
  [
    `check_route_on_date(route_id="6", date="${today}")`,
    `  disrupted:             ${parsed.disrupted}`,
    `  alert_count:           ${parsed.alert_count}`,
    `  station_level_detail:  ${parsed.station_level_detail}`,
    `  unknown_alert_types:   ${JSON.stringify(parsed.unknown_alert_types)}`,
    ...parsed.alerts.map((a) => `  - ${a.entity_id} [${a.effect}] ${a.header_text}`),
    "",
  ].join("\n")
);

if (parsed.unknown_alert_types.length > 0) {
  process.stdout.write(
    "NOTE: MTA is emitting an alert_type this server does not recognize. It is being\n" +
      "counted as a disruption (fail toward caution). Add it to EFFECT_BY_ALERT_TYPE\n" +
      "in src/mta.ts once its meaning is confirmed.\n"
  );
}
