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

### Changed

- Rewrote the README, CONTRIBUTING, CONTEXT, terms-compliance, and landing page
  in BetaNYC's voice. Facts are unchanged except where they disagreed: the npm
  server count is seven everywhere, and the landing page now says Node 18.

### Known issues

- `get_accessibility_outages` can miss outages at stations MTA spells
  differently in its elevator feed, such as `Bedford Pk Blvd` and
  `42St/Port Authority-Bus Terminal`. Searching by `stop_id` has the same
  problem. See `docs/accessibility.md`.

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
