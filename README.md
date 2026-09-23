# mta-mcp

> ⚠️ **Alpha, v0.1.0.** This is early code. We are sharing it now to find out
> what breaks. Tool names, parameters, and response shapes may change without
> notice, so please don't build anything important on it yet.
>
> What we haven't settled:
>
> - We have only inspected the subway alerts feed. Bus, Long Island Rail Road,
>   and Metro-North alerts are untested. MTA says all four feeds follow the same
>   conventions, and we have already found one place where they don't.
> - The effect classification covers 11 `alert_type` values, the ones we saw
>   across two live pulls. MTA can send others. An unrecognized value counts as
>   a disruption, which keeps answers cautious but isn't the same as coverage.
> - We have tested it against a handful of real dates and stations.
>
> Found something wrong? [Open an issue](https://github.com/BetaNYC/mta-mcp/issues).

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for
MTA subway service alerts: planned weekend work, suspensions, reroutes, and
elevator and escalator outages.

We built it to answer a question we ask before every BetaNYC event: is the
train we're telling people to take disrupted on that date, at that station?

This server runs from a local build and is not on npm. MTA's data terms rule
out a published package, and [docs/terms-compliance.md](docs/terms-compliance.md)
explains why.

This is an unofficial tool. BetaNYC is not the MTA, and we make no claim that
the data is accurate, complete, or timely. Riders should confirm service at
[mta.info](https://www.mta.info).

Vibe coded with [Claude](https://claude.ai) by [BetaNYC](https://beta.nyc).

---

## What it does

Exposes 4 tools over MCP:

| Tool | Description |
|---|---|
| `check_route_on_date` | Is a route disrupted on a date, optionally at one station? The one to use for event planning |
| `get_service_alerts` | All alerts active on a date, filterable by route, type, and effect |
| `resolve_station` | Free-text station name to GTFS parent-station id, with the routes serving it and its ADA status |
| `get_accessibility_outages` | Elevator and escalator outages, current, upcoming, or on a date, with MTA's alternate routes |

Every field in every answer is documented in [docs/tools.md](docs/tools.md).
Elevators and escalators have their own guide, including known gaps:
[docs/accessibility.md](docs/accessibility.md).

Don't use MCP? The same tools also come as a [skill](#use-it-without-mcp-the-skill)
for Claude Code.

It reads two MTA feeds. Neither needs a key.

- `camsys%2Fsubway-alerts.json`: GTFS-realtime service alerts with MTA's
  Mercury extensions, published at [api.mta.info](https://api.mta.info/#/serviceAlerts)
- `nyct%2Fnyct_ene.json` and `nyct%2Fnyct_ene_upcoming.json`: elevator and
  escalator outages, as flat JSON

Station names and route membership come from a snapshot of MTA's static GTFS
that ships with the repo, so looking up a station makes no network call. Two
more snapshots come from MTA's datasets on data.ny.gov: each station's ADA
status, and MTA's elevator and escalator inventory, which places each outage
at a station by ID and gives its alternate route. Those are under the OPEN-NY
Terms of Use, and they're never fetched at runtime either. Every source, how
they join, and their terms: [docs/data-sources.md](docs/data-sources.md).

**Out of scope:** trip updates, vehicle positions, and anything in the
`nyct%2Fgtfs-*` family. Those feeds are protobuf-only and would need three
custom `.proto` files, and nobody has asked for them. Bus, LIRR, and
Metro-North alerts use the same format and would be a small addition, but
they aren't wired up yet.

---

## Tools reference

### `check_route_on_date`

Is a route disrupted on a date, optionally at one station?

| Parameter | Type | Required | Description |
|---|---|---|---|
| `route_id` | string | yes | Route as MTA writes it: `"6"`, `"4"`, `"A"`, `"SI"` |
| `date` | string | yes | `YYYY-MM-DD`, in America/New_York time |
| `stop_id` | string | no | GTFS parent-station id, e.g. `"628"` |
| `station` | string | no | Station name as free text, matched among the stations `route_id` serves |
| `include_accessibility` | boolean | no | Also list elevator and escalator outages at the station that day, with MTA's alternate routes. Needs a station. One extra request |

Returns `disrupted`, the matching `alerts`, and a provenance block. Each alert
carries its classified `effect`, the stops MTA named, and MTA's own
rider-facing date string. The station carries MTA's ADA status. Elevator
outages are included only when you ask, to keep the default answer small.

```json
{ "route_id": "6", "date": "2026-09-19", "station": "68 St-Hunter College" }
```

```json
{
  "route_id": "6",
  "date": "2026-09-19",
  "disrupted": false,
  "station": {
    "stop_id": "628",
    "stop_name": "68 St-Hunter College",
    "routes": ["4", "6", "6X"],
    "accessibility": { "status": "fully_accessible", "mta_notes": null }
  },
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

That weekend the 6 is suspended in the Bronx, and the alert doesn't name
68 St–Hunter College. One call returns both facts.

If `station` matches more than one station, the tool doesn't pick one. It
returns `resolved: false` with the candidates and a reason. See
[Station names are not unique](#station-names-are-not-unique).

### `get_service_alerts`

All alerts active on a date, with optional filters. Use it for open-ended
questions like *what's going on with the Lexington Avenue line this weekend?*

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

Turns free text into GTFS parent-station ids, best match first, with the routes
serving each. It reads the bundled station list and makes no network call.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Station name or fragment, e.g. `"68 St"` |
| `route_id` | string | no | Restrict to stations this route serves. This is how you narrow an ambiguous name |

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
    {
      "stop_id": "621", "stop_name": "125 St", "lat": 40.804138, "lon": -73.937594,
      "routes": ["4", "5", "6", "6X"], "score": 100,
      "accessibility": { "status": "fully_accessible", "mta_notes": null }
    }
  ]
}
```

Without `route_id`, the same query returns four stations.

`accessibility` is MTA's ADA status for that station: `fully_accessible`,
`partially_accessible` (with the one direction that is, and MTA's note), or
`not_accessible`. It's per station, not per complex, and it's a dated
snapshot. It says a station has an accessible path, not that the path is
working today.

### `get_accessibility_outages`

Elevator and escalator outages.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `station` | string | no | Station name as free text, matched loosely |
| `stop_id` | string | no | GTFS parent-station id. Outages are placed by equipment ID using MTA's inventory, with name matching as a fallback |
| `route_id` | string | no | Only outages whose `trainno` includes this route. `6X`, `7X`, and `FX` count as `6`, `7`, and `F`; the shuttles `GS`, `FS`, and `H` count as `S` |
| `date` | string | no | `YYYY-MM-DD`. Outages in effect now or scheduled that overlap that day in New York time. Can't be combined with `upcoming: true` |
| `upcoming` | boolean | no | `false` (default) for outages in effect now, `true` for scheduled ones |

```json
{ "stop_id": "A27", "date": "2026-09-26" }
```

Returns MTA's outage rows as they are, each followed by `matched_by` (how it
was tied to the station), `match_note`, and `inventory`, which holds MTA's
`alternative_route` for the elevator. With `stop_id`, the answer also has the
station's ADA status and a `complex_outages` list for other stations in the
same complex. MTA's fields that matter most:

- `ADA`: `"Y"` if the elevator is part of the station's accessible path. An
  outage on one of these can make the station unusable for someone who can't
  use stairs.
- `equipmenttype`: `"EL"` for elevator, `"ES"` for escalator.
- `serving`: which part of the station it connects, like
  `"mezzanine to Manhattan-bound platform"`.
- `outagedate` and `estimatedreturntoservice`: when it went out and MTA's
  estimate for the fix.
- `trainno`: the routes at that station, which tells apart stations that share
  a name.

Please read [docs/accessibility.md](docs/accessibility.md) before relying on
this tool. In short:

- **No outage isn't the same as usable.** The feed can lag. A station MTA
  lists as not accessible may have no elevator to report, though some such
  stations do have ADA-compliant elevators, and the answer names them. An
  empty answer comes with a `no_match_note` that says so.
- **Use `stop_id`.** It places rows by equipment ID. A `station` search is by
  name only, and MTA names stations its own way in this feed. We handle the
  spellings we've seen, like `"Bedford Pk Blvd"`, but new ones can appear.
- **The ADA status and alternate routes are dated snapshots.** MTA keeps the
  alternate routes by hand and says they can lag. Quote them as MTA's, and
  confirm on [MTA's status page](https://www.mta.info/elevator-escalator-status).
- **Dates are MTA's estimates.** With `date`, an outage still listed after its
  estimated return counts as ongoing, and `date_caveats` says which rows that
  applies to.

---

## Prerequisites

- Node.js 18 or newer. CI tests on 20.x and 22.x.
- No API key. From api.mta.info: *"Accounts and API keys are no longer required
  to access these feeds."* There's nothing to put in your MCP config's `env`
  block. (MTA Bus Time, for live bus positions, does need a key, and it's out
  of scope here. Bus alerts don't.)

---

## Installation

Build from source:

```bash
git clone https://github.com/BetaNYC/mta-mcp.git
cd mta-mcp
npm install    # also builds, via the prepare script
```

That leaves a runnable server at `dist/index.js`. Run `npm run build` to
rebuild after a change.

There is no `npx` option. See [docs/terms-compliance.md](docs/terms-compliance.md).

---

## Configuration

### Claude Code

```bash
claude mcp add mta-mcp -- node /absolute/path/to/mta-mcp/dist/index.js
```

Or in a project's `.mcp.json`, with a path that works across machines:

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

Claude Desktop doesn't expand `${HOME}`, so use an absolute path.

### Optional environment variables

| Variable | Default | What it does |
|---|---|---|
| `MTA_MCP_CACHE_TTL_MS` | `60000` | How long a fetched feed is reused |
| `MTA_MCP_MIN_INTERVAL_MS` | `1000` | Minimum gap between any two requests to MTA |

These exist for testing and for making the server gentler. Please don't lower
them. See [Responsible use](#responsible-use).

---

## Use it without MCP: the skill

If you use [Claude Code](https://claude.com/claude-code), you can skip the MCP
server and use the [`mta-subway` skill](skills/mta-subway/SKILL.md) instead.
It's a set of instructions plus a small script that runs this server's code
from the command line:

```bash
node skills/mta-subway/scripts/mta.mjs check_route_on_date '{"route_id":"6","date":"2026-09-26","station":"68 St-Hunter College"}'
```

The answers are the same. The difference is where it works and what it costs:

- **The skill** loads its full instructions only when a subway question comes
  up. It needs an agent that can run commands, so it doesn't work in Claude
  Desktop or other chat apps.
- **The MCP server** works in any app that supports MCP, and spaces out every
  request to MTA in one place. It adds about 1,000 tokens of tool descriptions
  to every conversation.

Setup and a fuller comparison: [skills/README.md](skills/README.md).

---

## Example usage

> Is the 6 train running normally to 68 St–Hunter College on September 19?

> What's happening on the Lexington Avenue line this weekend?

> Which station is "125 St" on the 6, and is it affected?

> Are any elevators out at Jamaica–179 St?

> Is 86 St on the 6 accessible, and are any of its elevators out on Saturday?

> The event flyer says "6 train to 68 St." Should we add a travel warning?

---

## Responsible use

MTA publishes no rate limit and no refresh cadence, and its responses carry no
`Cache-Control`, `ETag`, or `Expires` header. So the server sets its own limits.
All six are on by default:

1. **A 60-second response cache**, keyed by URL. Several tool calls in one
   conversation become one request to MTA.
2. **Single-flight.** Simultaneous calls for the same URL share one request.
3. **A 1-second minimum gap** between any two requests to MTA, across all
   feeds, enforced by a queue.
4. **Bounded retry.** At most 2 retries, waiting 1 second and then 2. It
   honors `Retry-After` in both its seconds and HTTP-date forms, up to 10
   seconds, and never waits less than MTA asks. A 4xx other than 429 is never
   retried, since that means our request was wrong.
5. **A 15-second timeout**, so one hung request can't block the queue.
6. **An identifying `User-Agent`:** `mta-mcp/<version> (+https://github.com/BetaNYC/mta-mcp)`,
   so MTA can reach us about load.

The server never fetches on its own. There's no background polling, prefetch,
warm-up fetch, or cron. It makes a request only when a tool is called.

Station lookup makes no network requests, since the station list ships with
the repo. The test suite makes none either: it runs against saved fixtures with
`fetch` stubbed, so CI never reaches MTA. The only live request in the repo is
`npm run smoke`, which you run by hand.

---

## Notes & limitations

Please read this section before you pass an answer along to anyone.

### A station with no alert may still be affected

MTA's own [Stations Affected spec](https://github.com/nymta/gtfs-documentation/blob/main/feeds/subway/gtfs-rt/stations_affected.md)
says so twice:

> "Consumers should not assume that every alert will include Stations Affected
> data."

> "Consumers should not infer that all stations on a route or route segment are
> affected solely because one or more station-specific `informed_entity` entries
> are present."

So `disrupted: false` at a stop is not a guarantee if MTA didn't tag stations.
Every `check_route_on_date` response includes `station_level_detail` and a
plain-language `station_level_detail_note` saying which case you're in. When no
alert tags stations, a route-level alert counts against the station.

The feed never sends an all-clear. No alert doesn't mean service is normal.

### Added service is not a disruption

`Planned - Express to Local` alerts tag the stations that gain service. An
express train making local stops means more trains at those stations. A check
that only asks "is this station named in an alert?" would report a disruption
there. This server classifies on `alert_type` instead. It reports these alerts
as `effect: "added_at_local_stops"` with `counts_as_disruption: false`, and
still sets `affects_this_station: true` so you can see the change.

### Unknown alert types count as disruptions

The `alert_type` to effect map covers the 11 values we saw in a full feed
snapshot. MTA's status table lists 35, and the list isn't a documented, fixed
set. Any value the map doesn't recognize gets `effect: "unknown"`, counts as a
disruption, appears in the response's `unknown_alert_types`, and applies to
every station on the route. If we don't know what a status means, we can't
trust its station tagging either.

A non-empty `unknown_alert_types` means it's time to extend
`EFFECT_BY_ALERT_TYPE` in `src/mta.ts`.

### Station names are not unique

193 of the 496 parent stations share a `stop_name` with another station, across
76 names. `125 St` is four stations on four lines: `116` on the 1, `225` on the
2/3, `621` on the 4/5/6, and `A15` on the A/B/C/D. `Times Sq-42 St`,
`Grand Central-42 St`, `14 St`, and `14 St-Union Sq` each cover more than one
station too.

So the server doesn't guess. `resolve_station` returns every candidate, and
`check_route_on_date` returns the candidate list without an answer when a name
matches more than one station. Pass `route_id` to narrow it. Route membership
comes from MTA's static GTFS.

### Connected stations with different names aren't linked

`transfers.txt` in MTA's static GTFS links 60 pairs of parent stations with
different names, such as `Times Sq-42 St (127)` ↔ `42 St-Port Authority Bus Terminal (A27)`
and `Park Place (228)` ↔ `World Trade Center (E01)`. This server only groups
stations with the same name. Asking about one name won't surface an alert filed
against a connected station with a different name. For event travel this
hasn't mattered yet, and we can add it if it does.

### The station list is a dated snapshot

`data/stations.json` is generated from MTA's `gtfs_subway.zip`, which MTA
updates a few times a year. A new or renamed station won't resolve
until the file is regenerated. An unrecognized `stop_id` returns a clear error
instead of quietly answering for the whole route.

```bash
npm run stations            # re-download and rebuild data/stations.json
npm run accessibility-data  # rebuild the ADA status and equipment inventory
```

The ADA status and equipment inventory are snapshots too, from data.ny.gov.
MTA posts station ADA status as needed, so a newly accessible station can
lag. We refresh them when we need them, not on a schedule: before relying on
an answer for an event, run `npm run accessibility-data`. See
[docs/data-sources.md](docs/data-sources.md).

Some stations serve more routes than the subway map shows. `628`
(68 St–Hunter College) returns `4`, `6`, and `6X`, because the 4 runs local
overnight. That's the regular schedule.

### Refresh cadence is undocumented

Neither `mta.info/developers` nor `api.mta.info` gives a refresh interval for
any realtime feed, and responses carry no cache headers. That's why
`may_not_be_realtime` is `true` in every response, on top of the local cache.

### Don't rely on the status rank in entity ids

MTA's [`service_changes.md`](https://github.com/nymta/gtfs-documentation/blob/main/feeds/service_changes.md)
says a status rank is appended to `entity.id` after a colon, "uniformly across
all four agency feeds; no agency-specific exceptions apply." In a live
snapshot, 1 of 150 entities had it. None of the 149 `lmm:planned_work:*`
entries did, and planned work is what event planning depends on.

Parsing for it fails quietly. `"lmm:planned_work:34707".split(":").pop()`
returns `"34707"`, a plausible number that matches nothing in the 35-row table
and falls through to a default. We classify on `alert_type` instead. If a rank
is ever needed, the last segment of `mercury_entity_selector.sort_order`
(`"MTASBWY:7:14"` → 14) is where we've seen it.

### Route bullets are licensed

MTA's logos, maps, and symbols are licensed separately from the free data
terms. Write "the 6 train" in prose, and don't paste a route bullet into an
email or graphic. MTA's own `header_text`, which writes the route as ASCII
`[6]`, is their text and fine to quote.

---

## Development

```bash
npm install          # install + build
npm run build        # tsc
npm test             # build, then the full suite, with no network access
npm run smoke        # ONE live request to MTA. Not in npm test, not in CI.
npm run stations     # regenerate data/stations.json from MTA's static GTFS
npm run accessibility-data  # regenerate data/station_ada.json and data/equipment.json from data.ny.gov
```

The suite runs against saved fixtures in `test/fixtures/` with `fetch` stubbed.
That pins the assertions to a known feed, including the CityCamp regression and
the express-to-local false positive, and it keeps CI from ever calling MTA.

`npm run smoke` makes one GET to MTA and prints what came back. Run it by hand
to confirm the server can still reach the feed.

Layout:

| Path | What |
|---|---|
| `src/index.ts` | stdio server wiring, nothing else |
| `src/tools.ts` | tool schemas, strict argument parsing, dispatch |
| `src/mta.ts` | fetch, rate limiting, parsing, effect classification, station matching |
| `src/mta.test.ts` | unit tests for the pure functions |
| `test/*.test.mjs` | tool-level, schema, rate-limiter, and skill tests against fixtures |
| `test/helpers/fixture-fetch.mjs` | stands in for `fetch` when the skill tests run the script |
| `skills/mta-subway/` | the skill: `SKILL.md` and the command-line script |
| `docs/tools.md` | full tool reference |
| `docs/accessibility.md` | elevator, escalator, and station accessibility guide, with known gaps |
| `docs/data-sources.md` | every data source, how they join, their terms, and how to refresh them |
| `data/stations.json` | generated station list with route membership |
| `data/station_ada.json` | generated station ADA status, from data.ny.gov `39hk-dx4f` |
| `data/equipment.json` | generated elevator and escalator inventory, from data.ny.gov `94fv-bak7` |
| `scripts/update-stations.mjs` | regenerates `data/stations.json` from MTA's static GTFS |
| `scripts/update-accessibility-data.mjs` | regenerates the two data.ny.gov snapshots |
| `scripts/smoke.mjs` | the single live request |

Tool schemas reject unknown parameters, with an error that names the bad key
and lists the accepted ones. Quietly dropping a mistyped filter would return
results that look right but answer a different question.

---

## Data source and terms

Data from the [MTA developer feeds](https://www.mta.info/developers), used under
MTA's [terms and conditions](https://www.mta.info/developers/terms-and-conditions).
Free to use, no account required.

The terms bind this repo and anything built on it:

- Never state or imply that the data is accurate, complete, or timely.
- Say when output may be stale. Answers can lag the feed by more than a minute,
  so every response says so.
- Logos, maps, and symbols are licensed separately. Free data doesn't make the
  route bullets free.

MTA can change these terms or shut off the feeds at any time, without notice.
If you use this for event-day travel, keep a manual fallback.

The station ADA status and the elevator inventory come from MTA's datasets on
[data.ny.gov](https://data.ny.gov), under the
[OPEN-NY Terms of Use](https://data.ny.gov/dataset/OPEN-NY-Terms-Of-Use/77gx-ii52),
a separate document from MTA's feed terms. We bundle dated snapshots with
their source recorded. Details in [docs/data-sources.md](docs/data-sources.md#terms).

---

## Related BetaNYC MCP servers

BetaNYC maintains a set of open-source MCP servers for NYC and NYS civic data.
Those are published to npm. See the full directory at
[beta.nyc/ai-tools](https://beta.nyc/ai-tools).

- **[nyc-311-mcp](https://github.com/BetaNYC/nyc-311-mcp)**: city-services calendar, emergency status, service requests
- **[nyc-council-mcp](https://github.com/BetaNYC/nyc-council-mcp)**: City Council legislation, hearings, votes, members
- **[nyc-record-mcp](https://github.com/BetaNYC/nyc-record-mcp)**: City Record notices: procurement, awards, public hearings
- **[nyc-checkbook-mcp](https://github.com/BetaNYC/nyc-checkbook-mcp)**: city spending, contracts, budget, payroll, revenue
- **[nyc-budget-mcp](https://github.com/BetaNYC/New-York-City-Budget)**: discretionary funding (Schedule C) and the Council members who direct it
- **[nyc-charter-laws-rules](https://github.com/BetaNYC/nyc-charter-laws-rules)**: NYC Charter, Administrative Code, Rules of the City of New York
- **[nys-openlegislation-mcp](https://github.com/BetaNYC/nys-openlegislation-mcp)**: New York State bills, laws, members, committees

---

## About BetaNYC

[BetaNYC](https://beta.nyc) builds and maintains this project. We're New York's
civic technology and open data community, and we work to improve lives in New
York through civic design, technology, and data.

We run public events, meetups, and hands-on data classes all year, including
[NYC School of Data](https://www.schoolofdata.nyc/) and
[CityCamp NYC](https://citycamp.nyc). See what's coming up on our
[events calendar](https://www.beta.nyc/events/).

## Building on this? Tell us!

If you build something with this project, we'd love to hear about it, and we
can help other New Yorkers find it. BetaNYC publishes a weekly newsletter,
*This Week in NYC's Civic Technology and Open Data*.

- [Subscribe to the newsletter](https://beta.nyc/newsletter) to keep up with
  NYC civic tech and open data.
- Built something, or found a story worth sharing?
  [Submit a link](https://www.beta.nyc/newsletter-inbox/) and we'll consider it
  for an upcoming issue.

---

## Contributing

Issues and pull requests are welcome at
[github.com/BetaNYC/mta-mcp](https://github.com/BetaNYC/mta-mcp).

Please start with [CONTRIBUTING.md](CONTRIBUTING.md). It covers where to ask
what, the project's firm rules, and three traps in MTA's data that have each
produced a wrong answer in real BetaNYC work.

[CONTEXT.md](CONTEXT.md) defines the vocabulary: route vs. line, parent station
vs. platform, and what "affected" does and doesn't mean. Read it before changing
`src/mta.ts`. Most bugs here come from mixing those terms up.

Two things a pull request must not do:

- Add a release workflow or remove `"private": true`. See
  [docs/terms-compliance.md](docs/terms-compliance.md).
- Add a network call to the test suite.

Version history is in [CHANGELOG.md](CHANGELOG.md).

## Support our work

Freedom isn't free. [Support BetaNYC](https://beta.nyc/donate/).

---

## License

MIT License

Copyright (c) 2026 BetaNYC
