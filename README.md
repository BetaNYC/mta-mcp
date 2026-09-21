# mta-mcp

> # ⚠️ Alpha. v0.1.0.
>
> **This is early code, shared to find out what breaks.** It is in active
> development, it has not been used in anger by anyone outside BetaNYC, and
> **tool names, parameters, and response shapes can change without notice.**
> Do not build anything you care about on this yet.
>
> Specifically not settled:
>
> - **Only the subway alerts feed has been inspected.** Bus, Long Island Rail
>   Road, and Metro-North alerts are untested and may not share the same
>   conventions. MTA claims they do; we have already found one place that claim
>   does not hold.
> - **The effect classification covers 11 `alert_type` values** observed across
>   two live pulls. MTA can emit others. An unrecognized one is treated as a
>   disruption on purpose, but that is a safety net, not coverage.
> - **Tested against a handful of real dates and stations**, not a broad corpus.
>
> Found something wrong? [Open an issue](https://github.com/BetaNYC/mta-mcp/issues).
> That is the point of sharing it this early.

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for
**MTA subway service alerts** — planned weekend work, suspensions, reroutes, and
elevator and escalator outages.

It answers the question BetaNYC actually keeps asking before an event: *is the
line we are telling people to take disrupted on that date, at that station?*

> **Not published to npm, and never will be.** This runs from a local build.
> The reason is legal, not a matter of taste, and it is written down in
> [docs/terms-compliance.md](docs/terms-compliance.md). `package.json` sets
> `"private": true` so an accidental publish fails.

> **Unofficial.** BetaNYC is not the MTA. This makes no claim that the data is
> accurate, complete, or timely. Riders should confirm service at
> [mta.info](https://www.mta.info).

Vibe coded with [Claude](https://claude.ai) by [BetaNYC](https://beta.nyc).

---

## What it does

Exposes 4 tools over MCP:

| Tool | Description |
|---|---|
| `check_route_on_date` | Is a route disrupted on a date, optionally at one station? The event-planning primitive |
| `get_service_alerts` | All alerts active on a date, filterable by route, type, and effect |
| `resolve_station` | Free-text station name to GTFS parent-station id, with the routes serving it |
| `get_accessibility_outages` | Elevator and escalator outages, current or upcoming |

It reads two MTA feeds, both keyless:

- `camsys%2Fsubway-alerts.json` — GTFS-realtime service alerts with MTA's
  Mercury extensions, published at [api.mta.info](https://api.mta.info/#/serviceAlerts)
- `nyct%2Fnyct_ene.json` and `nyct%2Fnyct_ene_upcoming.json` — elevator and
  escalator outages, flat JSON

Station names and route membership come from a **bundled snapshot** of MTA's
static GTFS, so station lookup makes no network call at all.

**Out of scope:** trip updates, vehicle positions, and anything in the
`nyct%2Fgtfs-*` family. Those are protobuf-only and would drag in three custom
`.proto` files for a feature nobody has asked for. Bus, LIRR and Metro-North
alerts are published in the same shape and would be a small addition, but are
not wired up.

---

## Tools reference

### `check_route_on_date`

Is a route disrupted on a date, optionally at one station?

| Parameter | Type | Required | Description |
|---|---|---|---|
| `route_id` | string | yes | Route as MTA emits it: `"6"`, `"4"`, `"A"`, `"SI"` |
| `date` | string | yes | `YYYY-MM-DD`, interpreted in America/New_York |
| `stop_id` | string | no | GTFS parent-station id, e.g. `"628"` |
| `station` | string | no | Station name as free text, resolved among the stations serving `route_id` |

Returns `disrupted`, the matching `alerts` (each with its classified `effect`,
the stops MTA named, and MTA's own rider-facing date string), and the
provenance block every tool carries.

```json
{ "route_id": "6", "date": "2026-09-19", "station": "68 St-Hunter College" }
```

```json
{
  "route_id": "6",
  "date": "2026-09-19",
  "disrupted": false,
  "station": { "stop_id": "628", "stop_name": "68 St-Hunter College", "routes": ["4", "6", "6X"] },
  "station_serves_route": true,
  "station_level_detail": true,
  "station_level_detail_note": "Every matching alert names the stations it affects, so the station-level answer rests on MTA's own tagging.",
  "alert_count": 1,
  "unknown_alert_types": [],
  "alerts": [
    {
      "entity_id": "lmm:planned_work:33826",
      "alert_type": "Planned - Part Suspended",
      "effect": "reduced",
      "counts_as_disruption": true,
      "affects_this_station": false,
      "header_text": "No [6] between Hunts Point Av and 125 St",
      "human_readable_active_period": "Sep 18 - Oct 19, Fri 9:30 PM to Mon 5:00 AM",
      "affected_stops": [
        { "stop_id": "614", "stop_name": "Longwood Av" },
        { "stop_id": "615", "stop_name": "E 149 St" }
      ]
    }
  ],
  "may_not_be_realtime": true,
  "data_source": "...",
  "disclaimer": "Unofficial. ..."
}
```

The 6 is disrupted in the Bronx that weekend and serves 68 St–Hunter College
normally. Both facts are in one answer, which is the point.

If `station` cannot be narrowed to one station, **no answer is given**: the
response is `resolved: false` with the candidate list and a reason. See
[Station names are not unique](#station-names-are-not-unique).

### `get_service_alerts`

All alerts active on a date, filterable. The conversational surface — *what is
going on with the Lexington Avenue line this weekend?*

| Parameter | Type | Required | Description |
|---|---|---|---|
| `route_id` | string | no | Restrict to one route |
| `date` | string | no | `YYYY-MM-DD`. Defaults to today in America/New_York |
| `alert_type` | string | no | Exact MTA `alert_type`, e.g. `"Planned - Stops Skipped"` |
| `planned_only` | boolean | no | Only planned work (entity id begins `lmm:planned_work:`) |
| `effect` | string | no | One of `reduced`, `changed`, `delay`, `informational`, `added`, `added_at_local_stops`, `unknown` |

```json
{ "route_id": "6", "date": "2026-09-19" }
```

### `resolve_station`

Free text to GTFS parent-station ids, ranked best first, with the routes serving
each. Reads the bundled snapshot; **no network call**.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Station name or fragment, e.g. `"68 St"` |
| `route_id` | string | no | Restrict to stations served by this route — the disambiguator |

```json
{ "query": "125 St", "route_id": "6" }
```

```json
{
  "query": "125 St",
  "route_id": "6",
  "match_count": 1,
  "unambiguous": true,
  "candidates": [
    { "stop_id": "621", "stop_name": "125 St", "lat": 40.804138, "lon": -73.937594, "routes": ["4", "5", "6", "6X"], "score": 100 }
  ]
}
```

Without `route_id`, that same query returns **four** stations. It never collapses
them to one.

### `get_accessibility_outages`

Elevator and escalator outages.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `station` | string | no | Station name as free text, matched loosely |
| `stop_id` | string | no | GTFS parent-station id; its name is looked up, then matched loosely |
| `upcoming` | boolean | no | `false` (default) = in effect now; `true` = scheduled future outages |

MTA reports these rows with a **free-text station name, not a `stop_id`**, and
the spelling does not always match GTFS. Matching is therefore by name, and every
response says so in `matched_by`.

---

## Prerequisites

- **Node.js 18 or newer.** Tested in CI on 20.x and 22.x.
- **No API key.** api.mta.info states: *"Accounts and API keys are no longer
  required to access these feeds."* There are no credentials to configure, no
  `.env`, and nothing to put in your MCP config's `env` block.
  (MTA Bus Time, for live bus positions, does require a key — it is out of scope
  here. Bus *alerts* are keyless, like subway alerts.)

---

## Installation

**Build from source. There is no `npx` option, and there will not be one** —
this package is private and is never published to npm. See
[docs/terms-compliance.md](docs/terms-compliance.md) for why.

```bash
git clone https://github.com/BetaNYC/mta-mcp.git
cd mta-mcp
npm install    # also builds, via the prepare script
```

`npm install` leaves a runnable server at `dist/index.js`. To rebuild after a
change, `npm run build`.

---

## Configuration

### Claude Code

```bash
claude mcp add mta-mcp -- node /absolute/path/to/mta-mcp/dist/index.js
```

Or in a project's `.mcp.json`, keeping the path portable across machines:

```json
{
  "mcpServers": {
    "mta-mcp": {
      "command": "node",
      "args": ["${HOME}/Code/mta-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mta-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/mta-mcp/dist/index.js"]
    }
  }
}
```

Claude Desktop does not expand `${HOME}`; use an absolute path there.

### Optional environment variables

| Variable | Default | What it does |
|---|---|---|
| `MTA_MCP_CACHE_TTL_MS` | `60000` | How long a fetched feed is reused |
| `MTA_MCP_MIN_INTERVAL_MS` | `1000` | Minimum gap between any two upstream requests |

Both exist for testing and for turning politeness **up**. Lowering them is
discouraged; see below.

---

## Example usage

> Is the 6 train running normally to 68 St–Hunter College on September 19?

> What's happening on the Lexington Avenue line this weekend?

> Which station is "125 St" on the 6, and is it affected?

> Are the elevators working at Jamaica–179 St?

> The event flyer says "6 train to 68 St." Should we add a travel warning?

---

## Responsible use

MTA publishes **no rate limit and no refresh cadence**, and the response carries
no `Cache-Control`, `ETag`, or `Expires` header. Politeness cannot be negotiated
with the server, so this client imposes it. Six mechanisms, all of them on by
default:

1. **Response cache, 60 seconds**, keyed by URL, in process. A burst of tool
   calls in one conversation collapses to **one** upstream fetch.
2. **Single-flight.** Concurrent calls for the same URL share one in-flight
   request. Four tools firing at once produce one request, not four.
3. **Global minimum interval, 1000 ms**, enforced process-wide across *all*
   upstream URLs by a serialized queue. The client never bursts.
4. **Bounded retry:** at most 2 retries, backing off 1 s then 2 s, honoring
   `Retry-After` in both its delta-seconds and HTTP-date forms and capped at
   10 s. A `Retry-After` can extend the wait but never shorten it. **A 4xx other
   than 429 is never retried** — that is our bug, not congestion.
5. **Request timeout, 15 seconds**, so a hung request cannot pin the queue.
6. **Identifying `User-Agent`:** `mta-mcp/<version> (+https://github.com/BetaNYC/mta-mcp)`.
   If MTA ever wants to talk to us about load, they can.

And one thing that is absent on purpose:

**No background polling, no prefetch, no warm-up fetch, no cron.** The server
issues a request only in direct response to a tool call. A client that fetches
when nobody asked is what a denial of service looks like from the far end.

Station lookup makes **zero** network requests — the station list is bundled.

The test suite makes **zero** network requests; it runs entirely against
committed fixtures with `fetch` stubbed, and CI never reaches MTA. The one live
request this repo makes is `npm run smoke`, run by hand.

---

## Notes & limitations

Read this section before quoting an answer to anyone.

### Station-level absence is not absence of impact

MTA's own [Stations Affected spec](https://github.com/nymta/gtfs-documentation/blob/main/feeds/subway/gtfs-rt/stations_affected.md)
says it twice:

> "Consumers should not assume that every alert will include Stations Affected
> data."

> "Consumers should not infer that all stations on a route or route segment are
> affected solely because one or more station-specific `informed_entity` entries
> are present."

So `disrupted: false` at a specific stop is **not** a guarantee when MTA simply
did not tag stations. Every `check_route_on_date` response carries
`station_level_detail` and a plain-language `station_level_detail_note` saying
which case you are in. When no alert tags stations, a route-level alert is
counted against the station rather than dismissed.

There is no all-clear in this feed. The absence of an alert is not a statement
that service is normal.

### Added service is not a disruption

`Planned - Express to Local` alerts tag the stations that **gain** service — an
express train stopping locally means *more* trains, not fewer. A naive "is this
station named in any alert" check reports a disruption that does not exist. This
server classifies on `alert_type` and reports those as
`effect: "added_at_local_stops"` with `counts_as_disruption: false`, while still
setting `affects_this_station: true` so the fact is visible.

### Unknown statuses fail toward caution

The `alert_type` → effect map covers the 11 values observed in a full feed
snapshot. It is **not a documented enum** — MTA publishes a 35-status table, and
the feed exercised 11 of them. Any value the map does not recognize becomes
`effect: "unknown"`, **counts as a disruption**, is listed in the response's
`unknown_alert_types`, and makes the alert relevant to every station on the
route: if we do not know what the status means, we cannot claim to know what its
station tagging means either.

If you see a non-empty `unknown_alert_types`, that is the signal to extend
`EFFECT_BY_ALERT_TYPE` in `src/mta.ts`.

### Station names are not unique

**193 of the 496 parent stations share a `stop_name` with another station**, in
76 name groups. `125 St` is four different stations on four different lines
(`116` on the 1, `225` on the 2/3, `621` on the 4/5/6, `A15` on the A/B/C/D).
`Times Sq-42 St`, `Grand Central-42 St`, `14 St` and `14 St-Union Sq` are all
multi-station names too.

A bare name lookup is therefore a guess, and this server does not guess:
`resolve_station` returns every candidate, and `check_route_on_date` returns the
candidate list and no answer when the name cannot be narrowed to one station.
`route_id` is the disambiguator, and it is backed by real route membership
joined from MTA's static GTFS.

### Connected stations under different names are not linked

`transfers.txt` in MTA's static GTFS links **60 pairs of differently-named**
parent stations — `Times Sq-42 St (127)` ↔ `42 St-Port Authority Bus Terminal (A27)`,
`Park Place (228)` ↔ `World Trade Center (E01)`, and so on. This server groups
stations by identical name only. **Asking about one name will not surface an
alert filed against a connected station under a different name.** For event
travel, name grouping covers the cases that matter; the gap is recorded here
rather than solved, and can be closed if it ever bites.

### The station list is a dated snapshot

`data/stations.json` is generated from MTA's `gtfs_subway.zip`, which MTA updates
"typically a few times a year." A brand-new or renamed station will not resolve
until it is regenerated. An unrecognized `stop_id` is rejected with a clear
error rather than silently widening the answer to the whole route.

```bash
npm run stations    # re-download and rebuild data/stations.json
```

Expect some stations to serve more routes than the line map suggests: `628`
(68 St–Hunter College) returns `4`, `6` and `6X`, because the 4 runs local
overnight. That is the regular schedule, not a bug.

### Refresh cadence is undocumented

Nothing on `mta.info/developers` or `api.mta.info` gives a refresh interval for
any realtime feed, and the response carries no cache headers. `may_not_be_realtime`
is `true` in every payload for that reason, not only because of the local cache.

### Do not build on the entity-id rank suffix

MTA's [`service_changes.md`](https://github.com/nymta/gtfs-documentation/blob/main/feeds/service_changes.md)
documents a status rank appended to `entity.id` after a colon, "uniformly across
all four agency feeds; no agency-specific exceptions apply." **In a live
snapshot, 1 of 150 entities carried it.** All 149 `lmm:planned_work:*` entries
lacked it, and planned work is all of what event planning cares about.

The failure is worse than useless: `"lmm:planned_work:34707".split(":").pop()`
returns `"34707"` — not `undefined`, not an error, but a plausible-looking
integer that misses the 35-row table and silently defaults. Classification here
is on `alert_type`. If a rank is ever wanted, the trailing segment of
`mercury_entity_selector.sort_order` (`"MTASBWY:7:14"` → 14) is the observed
carrier.

### Route bullets are licensed IP

MTA's logos, maps and symbols are **separately licensed** and are not covered by
the free data terms. Write "the 6 train" in prose; do not paste a route bullet
into an email or a graphic on the strength of these feeds. Quoting MTA's own
`header_text`, which contains ASCII `[6]`, is their text rather than their logo.

---

## Development

```bash
npm install          # install + build
npm run build        # tsc
npm test             # build, then the full suite — no network at all
npm run smoke        # ONE live request to MTA. Not in npm test, not in CI.
npm run stations     # regenerate data/stations.json from MTA's static GTFS
```

The suite runs against committed fixtures in `test/fixtures/` with `fetch`
stubbed. That is both correctness — the assertions are pinned to a known feed,
including the CityCamp regression and the express-to-local false-positive guard
— and the denial-of-service guard, since CI must never reach MTA.

`npm run smoke` is the one live call, run by hand, to prove the server really
talks to MTA. It issues exactly one GET and prints what came back.

Layout:

| Path | What |
|---|---|
| `src/index.ts` | stdio server wiring, nothing else |
| `src/tools.ts` | tool schemas, strict argument parsing, dispatch |
| `src/mta.ts` | fetch, rate limiting, parsing, effect classification, station matching |
| `src/mta.test.ts` | unit tests for the pure functions |
| `test/*.test.mjs` | tool-level, schema, and rate-limiter tests against fixtures |
| `data/stations.json` | generated station list with route membership |
| `scripts/update-stations.mjs` | regenerates the above from MTA's static GTFS |
| `scripts/smoke.mjs` | the single live request |

Tool schemas **reject unknown parameters** rather than ignoring them, with a
message naming both the offending key and the accepted ones. Silently dropping a
mistyped filter returns results that look right and answer a different question.

---

## Data source and terms

Data from the [MTA developer feeds](https://www.mta.info/developers), used under
MTA's [terms and conditions](https://www.mta.info/developers/terms-and-conditions).
Free to use, no account required.

Obligations this repo honors, and that anything built on it must honor too:

- **Never state or imply the data is accurate, complete, or timely.**
- **Disclose staleness.** Output can lag the feed by more than a minute, so every
  payload says so.
- **Logos, maps and symbols are separately licensed.** The data being free does
  not make the route bullets free.

MTA may change these terms or terminate the feeds at any time, without notice.
Do not put this on an event-day critical path without a manual fallback.

---

## Related BetaNYC MCP servers

BetaNYC maintains a suite of open-source MCP servers for NYC and NYS civic data.
Unlike this one, those are published to npm. See the full directory at
**[beta.nyc/ai-tools](https://beta.nyc/ai-tools)**.

- **[nyc-311-mcp](https://github.com/BetaNYC/nyc-311-mcp)** — city-services calendar, emergency status, service requests
- **[nyc-council-mcp](https://github.com/BetaNYC/nyc-council-mcp)** — City Council legislation, hearings, votes, members
- **[nyc-record-mcp](https://github.com/BetaNYC/nyc-record-mcp)** — City Record notices: procurement, awards, public hearings
- **[nyc-checkbook-mcp](https://github.com/BetaNYC/nyc-checkbook-mcp)** — city spending, contracts, budget, payroll, revenue
- **[nyc-charter-laws-rules](https://github.com/BetaNYC/nyc-charter-laws-rules)** — NYC Charter, Administrative Code, Rules of the City of New York
- **[nys-openlegislation-mcp](https://github.com/BetaNYC/nys-openlegislation-mcp)** — New York State bills, laws, members, committees

---

## About BetaNYC

This project is built and maintained by [BetaNYC](https://beta.nyc), New York's
civic technology and open-data community. We work to improve lives in New York
through civic design, technology, data, and public-interest technology.

**Come do civic tech with us.** We run public events, meetups, and hands-on data
classes throughout the year — including [NYC School of Data](https://www.schoolofdata.nyc/)
and [CityCamp NYC](https://citycamp.nyc). See what's coming up on our
[events calendar](https://www.beta.nyc/events/).

**Sustain this work.** To help keep it going, please consider
[donating and becoming a Beta Builder](https://beta.nyc/donate).

---

## Contributing

Issues and pull requests welcome at
[github.com/BetaNYC/mta-mcp](https://github.com/BetaNYC/mta-mcp).

Read [CONTRIBUTING.md](CONTRIBUTING.md) first — it covers where to ask what, the
rules this project will not bend on, and the three traps in MTA's data that have
each produced a wrong answer in real BetaNYC work.

[CONTEXT.md](CONTEXT.md) is the vocabulary: route vs. line, parent station vs.
platform, what "affected" does and does not mean. Worth reading before changing
anything in `src/mta.ts`, because most bugs here are vocabulary errors.

Two things a pull request must not do:

- **Do not add a release workflow or remove `"private": true`.** Read
  [docs/terms-compliance.md](docs/terms-compliance.md) first.
- **Do not add a network call to the test suite.** Fixtures exist so CI never
  touches MTA.

Version history lives in [CHANGELOG.md](CHANGELOG.md).

---

## License

MIT License

Copyright (c) 2026 BetaNYC
