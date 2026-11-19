# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This package is not published to npm. Version numbers track the local build. See [docs/terms-compliance.md](docs/terms-compliance.md).

## [Unreleased]

## [0.4.0] — 2026-11-19

BetaNYC's MCP practices (epic #19).

### Added

- **Each answer says what BetaNYC did to the data.** Every answer from the four MTA tools
  has `data_provenance`: one entry per source it used (a live feed or a bundled file), whose
  `text` starts "BetaNYC modified this data:", says what BetaNYC did to that source, and
  names MTA's own feed or file as the official record, word for word as `about_data` does.
  Built with the shared `provenance()` and `changedByBetanyc`. A test checks every tool.
- Every tool carries MCP `annotations`: a `title`, `readOnlyHint: true`, and `openWorldHint`
  (`true` for the three tools that read MTA's feeds, `false` for `resolve_station`). Each MTA
  tool also has a `title`. (#10)
- `limit` and `offset` on `get_service_alerts` (default 20, maximum 100), `resolve_station`
  (default 10, maximum 50) and `get_accessibility_outages` (default 50, maximum 200), with the
  bounds in each input schema. A limit over the maximum is an error. Each answer gains a
  `paging` block: `total`, `returned`, `offset`, `limit`, `next_offset` and `showing` ("Showing
  20 of 63 alerts (1 to 20). More are available: call again with offset 20."). (#14)
- `resolve_station` answers carry `data_source` and `disclaimer`, like the other tools. (#13)
- `data/SHA256SUMS`: the SHA-256 of each bundled snapshot, rewritten by both update scripts
  and by `scripts/data-checksums.mjs`, and checked by `npm test`. (#15)
- A test caps the size of the tool list plus the server instructions. (#11)
- `eval/`: twelve realistic questions with known answers, run offline against the saved feeds
  by `npm run eval`; results saved in `eval/runs/`. (#16)
- Tests that stdout carries only JSON-RPC in server mode (#17), and that neither `npm test`
  nor CI runs the live smoke check.

### Changed

- **Breaking for anyone who read the whole list:** `get_service_alerts` returns 20 alerts per
  call by default, where it used to return every alert. `alert_count` and
  `disrupting_alert_count` still count every match. (#14)
- **Breaking for anyone who read the whole list:** `get_accessibility_outages` returns 50 rows
  per call by default, where it used to return every row. `outage_count` now counts every
  match, not just the rows returned. (#14)
- To get the rest from either tool, call again with `offset: paging.next_offset` until it is
  `null`, or ask for more at once with `limit` (at most 100 alerts or 200 outages).
  `paging.showing` says "Showing N of M". Paging is not stable across feed refreshes: the feed
  is cached for 60 seconds, so a later page can come from a newer copy. (#14)
- `check_route_on_date`, when it cannot pick one station, lists the first 10 candidates at
  most. `candidate_count` gives the full number and the new `candidates_showing` says which
  stations it counts ("Showing 10 of 26 stations on route F tied for the best match to
  'St'.") and that `resolve_station` lists those first, then weaker matches, so its
  `match_count` can be larger. That answer now
  names the bundled station list and ADA status as its `data_source`, dated in
  `snapshot_as_of`, with no `fetched_at`, since no feed is read for it.
- The server `instructions` now say once what every MTA tool shares (MTA's fields vs.
  BetaNYC's `betanyc` object, the dated snapshots and `snapshot_as_of`/`snapshot_warning`,
  paging), and the tool descriptions no longer repeat it. The about_data paragraph is
  unchanged. (#18)
- Errors are one plain sentence saying what went wrong and what to try. A wrongly typed or
  missing argument is named (it used to return zod's raw issue list as JSON). A failed request
  to MTA says whether it timed out, could not connect, or got an HTTP error, and what to do,
  with MTA's response body after it, cut to 500 characters, and no stack trace. An unknown
  tool name lists the tools there are. Uses the shared `toolError`. (#12)
- Shared files updated: `src/betanyc-tools.ts` 1.5.2 (from 1.5.0), `scripts/whats_changed.py`
  and `scripts/mcp_shared/data-sources.schema.json` 1.4.1. Copied unchanged. With 1.5.2,
  `toolError` drops stack-frame lines from the message and caps it at 1,000 characters, and
  `errorResult` passes every error through the shared `errorSummary`: an error's own message,
  a network error's text and a thrown value that is not an Error. (#9)
- `DATA-SOURCES.json` (and `data.json`) say more exactly what BetaNYC does: the station list
  is BetaNYC's, built from MTA's GTFS file, with BetaNYC's `routes`, order and `score`;
  outage rows are MTA's, listed in BetaNYC's order; and for an alert's `header_text`,
  `description_text` and `human_readable_active_period` BetaNYC keeps one translation, MTA's
  English one (or MTA's first when there is no English), and drops the others. It no longer says MTA's values are "passed on unaltered". `reshaped` is added
  to the steps for both feeds. `resolve_station`'s `station_data.note` says the same.
- `scripts/update-stations.mjs --from-zip` records `generated_from` as a local zip the operator
  supplied, said to be a copy of MTA's zip, with its SHA-256. It used to call any such zip a
  "saved copy" of MTA's file. The local path is still never recorded.
- The 15-second request timeout now covers reading the response body too, not only the
  headers.

### Fixed

- `get_accessibility_outages` named the subway service-alerts feed as its `data_source`. It
  now names MTA's elevator and escalator outage feeds, and `check_route_on_date` with
  `include_accessibility` names both feeds it read. (#13)
- `resolve_station`'s `match_count` stopped at 10. It now counts every station that matches,
  and the candidates come in pages. (#14)
- `data/stations.json` recorded the local path of the zip it was built from, which named a
  machine and a user. `scripts/update-stations.mjs` now records the MTA zip's URL and its
  SHA-256 (`source_sha256`) instead, and a test fails if any bundled data file contains a local
  path or username. The current snapshot's field was corrected by hand; its zip is gone, so it
  has no `source_sha256` until the next refresh. Station records are unchanged. (#27)
- MTA answering 200 with something that is not JSON (a maintenance page) surfaced the raw
  JSON parse error. It is now one plain sentence saying the feed sent a web page instead of
  data and to try again in a few minutes. It is not cached or retried.
- `check_route_on_date`'s answer when it cannot pick one station named the service-alerts feed
  as its source and gave a `fetched_at`, though no feed was read for it.
- The local-path test also matched this machine's username anywhere, so `npm test` failed for
  a user whose username is a short word in a station name ("park" and "Park Pl"). It now
  checks path shapes only (now also mounted volumes and Windows user folders), and its folder
  paths work in a checkout whose path has a space.
- A stack-frame filter in `errorResult` dropped a sentence such as "at least one of stop_id
  or station is needed" and let a frame with no leading spaces through. It is gone; the
  shared `toolError` and `errorSummary` do this. The "could not reach MTA" message and a thrown
  value that is not an Error used to pass on their raw text; both now go through
  `errorSummary`.

### Known limits

- The bundled `data/stations.json` still says "saved copy of …" in `generated_from` and has
  no `source_sha256`: refreshing it needs the network, so it was not refreshed here. The
  source checksum will be recorded at the next refresh (`npm run stations`).

## [0.3.0] — 2026-11-16

Adds `about_data`, the third tool BetaNYC is adding to each of its MCP servers, and keeps
BetaNYC's reading of each service alert apart from MTA's fields. **The alert output changes
shape** (see Changed). Tracking: BetaNYC/betanyc-ai-workspace#1655 (epic #1652).

### Added

- `about_data`: where each kind of data comes from, whether it is MTA's record or changed by
  BetaNYC, how current it is on this copy, its terms and credit line, where to check a figure
  and where to report an error, with BetaNYC's contact address for data questions
  (lab@beta.nyc). Optional `topic`: a source id or a tool name. No request to MTA.
- `DATA-SOURCES.json`, the five sources (two live MTA feeds, three snapshots in `data/`),
  every fact checked against MTA's and data.ny.gov's own pages. The snapshots' freshness is
  the pull time already in each file, the same date the tools give in `snapshot_as_of`.
- `data.json`, a DCAT-US 3.0 catalog built from `DATA-SOURCES.json` by
  `scripts/whats_changed.py about-data catalog`. Never edit it by hand.
- The server now sends MCP `instructions` saying when to call `about_data`, `about_betanyc`
  and `whats_changed`.
- `scripts/tests/catalog_validate.py`, `scripts/mcp_shared/data-sources.schema.json` and
  `scripts/mcp_shared/vendor/dcat-us-3.0.0/`, copied unchanged from the BetaNYC workspace.
- CI: an `about-data` job checks that every tool has a source, that `data.json` is current,
  and validates both files against their JSON Schemas (pinned validators, CI only). The
  "What's changed on main is dated" job also runs `about-data check --release`.
- Tests: `test/about-data.test.mjs`; the tool-list tests now expect seven tools.

### Changed

- **Output change, `check_route_on_date` and `get_service_alerts`:** each alert's
  `effect`, `counts_as_disruption`, `planned` and `alert_type_recognized`, and in
  `check_route_on_date` its `affects_this_station`, `relevant_to_station` and
  `station_level_detail`, moved into a new `betanyc` object on the alert. They are BetaNYC's
  reading of MTA's alert, not MTA's data; MTA's fields stay at the top level with MTA's values.
  MTA's terms (term 5) say an app must not modify the data, and the old layout put BetaNYC's
  fields beside MTA's unmarked. Top-level answer fields (`disrupted`, `disrupting_alert_count`,
  the response's `station_level_detail`, `unknown_alert_types`) are unchanged. A client that read
  `alert.effect` now reads `alert.betanyc.effect`. Tool descriptions, README, `docs/tools.md`,
  `docs/index.html` and the skill updated.
- **Output change, `get_accessibility_outages` and `check_route_on_date`'s
  `accessibility_outages`:** the same rule for elevator and escalator outage rows. Each row's
  `matched_by`, `match_note` and `inventory` (in `check_route_on_date`'s short rows:
  `matched_by`, `match_note`, `alternative_route` and `date_caveat`) moved into a `betanyc`
  object on the row, left out when empty. MTA's row fields stay at the top level with MTA's
  values. A client that read `row.inventory.alternative_route` now reads
  `row.betanyc.inventory.alternative_route` (`row.betanyc.alternative_route` in a route check).
  The answer-level `matched_by` that explains how rows were placed stays where it was.
  `docs/accessibility.md` updated too.
- `docs/terms-compliance.md`: a fourth obligation, "Not modifying the data" (term 5).
- `src/betanyc-tools.ts`, `scripts/whats_changed.py`, `scripts/mcp_shared/data-sources.schema.json`
  and `scripts/tests/catalog_validate.py` updated to shared module 1.4.0 (from 1.2.4), copied
  unchanged (BetaNYC/betanyc-ai-workspace#1672). `about_data` gives each source one of three
  answers on whether it is official, naming the source, its publisher and a link. Every MTA
  source here reads "BetaNYC modified this data", because BetaNYC filters, merges or reshapes
  each one. `DATA-SOURCES.json`: the two data.ny.gov sources are named by their own titles,
  "MTA Subway Stations" and "MTA Subway Elevator and Escalator Asset Inventory", without the
  dataset id.

## [0.2.0] — 2026-11-12

The first version number since 0.1.0. Everything below reached the main branch between
2026-09-23 and 2026-10-12 while `package.json` still said 0.1.0, because this server is
installed by building the main branch, not from npm. 0.2.0 adds the two tools BetaNYC is
adding to each of its MCP servers and gathers those earlier changes under one number. Tracking:
BetaNYC/betanyc-ai-workspace#1645 (epic #1637).

### Added

- `whats_changed`: what changed in this server, newest first, from `WHATS-CHANGED.md`
  (filters: `since`, `tag`, `limit`). Answers with readable text and `structuredContent`
  matching a declared `outputSchema`.
- `about_betanyc`: who built the server, the repository, where to report a bug in this server or ask for a new feature, and
  BetaNYC's links.
- `src/betanyc-tools.ts`, copied unchanged from the workspace's
  `scripts/mcp_shared/betanyc-tools.ts` (v1.2.1). Never edit the copy; change the canonical
  file and copy it again.
- `WHATS-CHANGED.md`, the reader-facing record of changes, backfilled to 0.1.0. The server
  reads it from the repository root at run time.
- `docs/whats-changed.html`, built from it by `scripts/whats_changed.py` (copied unchanged
  from the workspace). The landing page links to it in its footer.
- CI: a `whats-changed` job runs `whats_changed.py check --base-ref` (append-only, and a
  version bump needs an entry) and `render --check` on the page. There is no publish step:
  the PR's last commit before merge dates the entry (CONTRIBUTING.md, "Releases"), and a
  `whats-changed-released` job runs `check --release` on every push to main so an undated
  entry on main fails at once.
- A "What's changed" link at the foot of every published page under `docs/`.
- The skill script prints the plain-text answer for the two new tools, which do not return
  JSON.

### Changed

- Six tools instead of four: README, landing page, skill guide and the tool-list tests.
- `package.json` and the alpha notices in the README and on the landing page say 0.2.0.

### Added before 0.2.0 (on main from 2026-09-23 to 2026-10-12)

- Stale-data warnings for the three bundled snapshots in `data/`. Every
  answer that uses one carries `snapshot_as_of` (each snapshot's pull date,
  New York time) and `snapshot_warning`, which is `null` until a snapshot is
  older than its threshold (30 days for `station_ada.json` and
  `equipment.json`, 90 for `stations.json`) or has no readable date, and then
  gives the date, the age, and the refresh command. The server logs each
  snapshot's date and age to stderr at startup. Nothing is refreshed
  automatically; see "Keep your data current" in the README.
- `npm run refresh-data` runs `npm run stations` and
  `npm run accessibility-data`.

- `skills/mta-subway/`: a Claude Code skill that runs the same four tools from
  the command line, with no MCP server. It uses the server's own code, returns
  compact JSON, and keeps a 60-second cache on disk. Setup in
  `skills/README.md`.
- `docs/tools.md`: every parameter and response field for all four tools.
- `docs/accessibility.md`: a full guide to `get_accessibility_outages`,
  including MTA's field meanings and the tool's known gaps.
- 9 tests for the skill script, run against fixtures with no network.
- `get_accessibility_outages` takes `date` (`YYYY-MM-DD`, New York time) and
  returns outages in effect now or scheduled whose window overlaps that day,
  from one request to the current feed. That relies on the current feed
  containing every scheduled outage, which we counted but MTA doesn't
  document, and each date answer says so. MTA's dates carry no time zone; we
  read them as New York time. Rows with dates we can't trust are kept and
  listed in `date_caveats`, and an outage still listed after its estimated
  return counts as ongoing. `date` with `upcoming: true` is an error.
- `get_accessibility_outages` takes `route_id`, matched against each row's
  `trainno`. `6X`, `7X`, and `FX` count as `6`, `7`, and `F`, and the shuttles
  `GS`, `FS`, and `H` count as `S`, the only shuttle name the feed uses.
- `get_accessibility_outages` with `stop_id` checks each name match against
  the station's routes and moves rows at a same-named station on other routes
  to `other_station_outages`. It also matches a feed name that is a shorter
  form of the GTFS name on a shared route, like `Court Sq` for
  `Court Sq-23 St`.
- `no_match_note` on every empty station or route search, saying the result
  isn't proof of no outage and what to search next.
- `rows_without_station`: a row with no `station` name is kept in a name
  search and counted, since it can't be ruled out.
- 27 tests covering these additions and the changes and fixes below.
- Station ADA status. Every station in `resolve_station` and
  `check_route_on_date`, and in `get_accessibility_outages` with a `stop_id`,
  carries MTA's status: `fully_accessible`, `partially_accessible` with the
  one direction that is and MTA's note, or `not_accessible`. It's per station,
  not per complex, from a bundled snapshot of data.ny.gov `39hk-dx4f`
  (`data/station_ada.json`), which matches all 496 stations.
- Alternate routes. Each outage row carries an `inventory` block from MTA's
  elevator and escalator inventory, data.ny.gov `94fv-bak7`
  (`data/equipment.json`): where the equipment is, `ada_compliant`,
  `redundant_elevator`, and MTA's `alternative_route`. Answers say the text is
  kept by hand and can lag.
- `get_accessibility_outages` with a `stop_id` places rows by equipment ID
  first, with name matching as the fallback for rows the inventory doesn't
  cover. Each row says how it matched in `matched_by`: `"equipment id"`,
  `"name"`, or `"partial name"`. Outages elsewhere in the station's complex
  are listed in `complex_outages`. Against the saved feeds, 13 name-only
  pairings that were wrong move to `other_station_outages`, and 3 rows name
  matching missed are found.
- `check_route_on_date` takes `include_accessibility: true`, which adds the
  station's elevator and escalator outages that day, with alternate routes,
  for one extra request. It needs a station and is off by default.
- `scripts/update-accessibility-data.mjs` (`npm run accessibility-data`)
  regenerates both snapshots from data.ny.gov in two requests, or from saved
  responses with `--from-dir`, and records the query, pull time, and terms in
  each file.
- `docs/data-sources.md`: every data source, what it provides, how they join,
  coverage, terms, refresh cadence, and how to regenerate.
- 27 tests for the ADA status, the ID join, the complex and fallback cases,
  `include_accessibility`, the generator, and the committed snapshots.

### Changed before 0.2.0

- The data.ny.gov snapshots are refreshed when needed, not on a schedule.
  The docs now say to check the snapshot's pulled date and run
  `npm run accessibility-data` before relying on an answer for an event.
- `get_accessibility_outages` with a `stop_id` returns different rows than
  before in 13 station-row pairings in the saved feeds, all moved to
  `other_station_outages`, because MTA's inventory places that equipment at
  another station. Each outage row has three new fields after MTA's.

- Rewrote the README, CONTRIBUTING, CONTEXT, terms-compliance, and landing page
  in BetaNYC's voice. Facts are unchanged except where they disagreed: the npm
  server count is seven everywhere, and the landing page now says Node 18.
- Every tool returns compact JSON instead of indented JSON, to save tokens.
  In a sample of four answers, 13 to 34 percent fewer characters.
- An alert with no `active_period` now counts as active on every date, as the
  GTFS-realtime reference says. It used to count on none.

### Fixed before 0.2.0

- `get_accessibility_outages` missed outages at stations MTA spells
  differently in its elevator feed, by name and by `stop_id`. It now splits a
  number glued to letters (`42St`) and reads `Pk` as `Park`, so
  `Bedford Pk Blvd` and `42St/Port Authority-Bus Terminal` match their GTFS
  names, and it drops a typed ordinal (`34th`, `42nd`). All 58 station names
  in the saved feed now match, up from 56.
- `stop_id: "138"` (WTC Cortlandt) and `stop_id: "F09"` (Court Sq-23 St) found
  nothing, because the feed writes those stations with shorter names. Every
  one of the 126 rows in the saved current feed can now be reached from some
  `stop_id`, up from 125.
- `trainno` is split on commas and spaces as well as slashes.
- A shorter feed name that fits two stations on the same route no longer goes
  only to the closer one. The other gets it too, with a `match_note` naming
  the closer station, so a name tie-break can't hide an outage.
- An empty outage answer at a station MTA lists as not accessible no longer
  says "there may be no elevator" when the inventory codes ADA-compliant
  elevators there (149 St-Hostos, 14 St-Union Sq's 4/5/6 station,
  42 St-Bryant Pk, Fresh Pond Rd). It names them, and every empty answer
  keeps the line that a missing outage isn't proof the station is usable.
- A partially accessible station's direction uses MTA's rider label
  (`"Manhattan"`), never GTFS's nominal "northbound" or "southbound".
- Outage rows leave out `matched_by`, `match_note`, and `inventory` when they
  have nothing to say, and carry `inventory` only with a station filter. The
  unfiltered answer on the saved feed is about 29,000 characters, near its old
  size, where carrying alternate routes on every row had doubled it.
- `pl` reads as `place` in elevator-feed matching, like `pk` as `park`. MTA's
  station list has both `Park Pl` and `Park Place`.
- The skill script now reports the real fetch time of the elevator feed in
  `accessibility_outages` when it answers from its disk cache.
- Docs: removed claims we couldn't source, including the size of MTA's
  developer support and what other subway MCP servers do, which now describes
  only what their READMEs say.

## [0.1.0] — 2026-09-17

Initial build. Not released; `package.json` is `"private": true`.

### Added

- MCP server for MTA subway service alerts with four tools:
  `check_route_on_date`, `get_service_alerts`, `resolve_station`, and
  `get_accessibility_outages`.
- Effect classification on `transit_realtime.mercury_alert.alert_type`, covering
  the 11 values observed in a full feed snapshot. `Planned - Express to Local`
  is classified as `added_at_local_stops` and doesn't count as a disruption.
  Those alerts tag the stations that gain service.
- Unrecognized `alert_type` values get `effect: "unknown"`, count as a
  disruption, appear in the response's `unknown_alert_types`, and apply to
  every station on the route.
- `station_level_detail` and a plain-language note in every
  `check_route_on_date` response, so `disrupted: false` at a stop isn't read
  as a guarantee when MTA didn't tag stations.
- Bundled `data/stations.json`: 496 GTFS parent stations with the routes serving
  each, joined offline from `stops.txt`, `trips.txt`, and `stop_times.txt`.
  Station lookup makes zero network calls. Regenerate with `npm run stations`.
- Ambiguous station names return candidates instead of a guess. 193 of 496
  parent stations share a name with another. `resolve_station` returns every
  candidate, and `check_route_on_date` returns the candidate list rather than an
  answer.
- Six rate-limiting mechanisms, all on by default: a 60 s response cache,
  single-flight, a process-wide 1 s minimum interval, bounded retry honoring
  `Retry-After`, a 15 s timeout, and an identifying `User-Agent`. No background
  polling, prefetch, or warm-up fetch.
- Terms compliance in every response: `may_not_be_realtime`, a staleness note, a
  `data_source`, and a disclaimer on every result.
- Strict tool schemas. Unknown parameters are rejected with an error naming the
  bad key and the accepted ones.
- 77 tests across four files, all against committed fixtures with `fetch`
  stubbed, so the suite makes no network calls. Pinned regressions include the
  CityCamp case (route 6 on 2026-09-19 affects stops 614–619 and not 628) and
  the express-to-local false positive at stop 628 on routes 4 and 5.
- `npm run smoke`: one live request against MTA, deliberately outside `npm test`
  and outside CI.
- CI on Node 20.x and 22.x.

### Notes

- Not published to npm. Term 1 of MTA's data feed terms requires that users of
  a distributed app get the data from a non-MTA server, and a published package
  would have every user fetch from `api-endpoint.mta.info`. Full reasoning in
  [docs/terms-compliance.md](docs/terms-compliance.md).
- Classification doesn't use the status rank MTA documents as appended to
  `entity.id`. Only 1 of 150 entities had it, and parsing an id without it
  returns a plausible-looking number instead of an error.
