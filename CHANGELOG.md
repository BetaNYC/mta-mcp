# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This package is not published to npm. Version numbers track the local build. See [docs/terms-compliance.md](docs/terms-compliance.md).

## [Unreleased]

### Added

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

### Changed

- Rewrote the README, CONTRIBUTING, CONTEXT, terms-compliance, and landing page
  in BetaNYC's voice. Facts are unchanged except where they disagreed: the npm
  server count is seven everywhere, and the landing page now says Node 18.
- Every tool returns compact JSON instead of indented JSON, to save tokens.
  In a sample of four answers, 13 to 34 percent fewer characters.
- An alert with no `active_period` now counts as active on every date, as the
  GTFS-realtime reference says. It used to count on none.

### Fixed

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
