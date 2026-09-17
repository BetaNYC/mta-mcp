# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**This package is never published to npm.** Version numbers track the local
build, not a registry release. See [docs/terms-compliance.md](docs/terms-compliance.md).

## [0.1.0] — 2026-09-17

Initial build. Not released; `package.json` is `"private": true`.

### Added

- MCP server for MTA subway service alerts with four tools:
  `check_route_on_date`, `get_service_alerts`, `resolve_station`, and
  `get_accessibility_outages`.
- Effect classification on `transit_realtime.mercury_alert.alert_type`, covering
  the 11 values observed in a full feed snapshot. `Planned - Express to Local`
  is classified as `added_at_local_stops` and does **not** count as a
  disruption: those alerts tag the stations that gain service, so a
  station-mention check reports disruptions that do not exist.
- Unrecognized `alert_type` values fail toward caution — `effect: "unknown"`,
  counted as a disruption, listed in the payload's `unknown_alert_types`, and
  treated as relevant to every station on the route.
- `station_level_detail` and a plain-language note in every
  `check_route_on_date` response, so `disrupted: false` at a stop is never
  mistaken for a guarantee when MTA simply did not tag stations.
- Bundled `data/stations.json`: 496 GTFS parent stations with the routes serving
  each, joined offline from `stops.txt`, `trips.txt` and `stop_times.txt`.
  Station lookup makes zero network calls. Regenerate with `npm run stations`.
- Ambiguous station names are never resolved by guessing. 193 of 496 parent
  stations share a name with another; `resolve_station` returns every candidate
  and `check_route_on_date` returns the candidate list rather than an answer.
- Six rate-limiting mechanisms, all on by default: a 60 s response cache,
  single-flight, a process-wide 1 s minimum interval, bounded retry honoring
  `Retry-After`, a 15 s timeout, and an identifying `User-Agent`. No background
  polling, prefetch, or warm-up fetch of any kind.
- Terms compliance in the payload: `may_not_be_realtime`, a staleness note, a
  `data_source`, and a disclaimer on every result.
- Strict tool schemas. Unknown parameters are rejected with a message naming the
  offending key and the accepted ones, rather than being silently dropped.
- 77 tests across four files, all against committed fixtures with `fetch`
  stubbed — zero network calls in the suite. Pinned regressions include the
  CityCamp case (route 6 on 2026-09-19 affects stops 614–619 and not 628) and
  the express-to-local false positive at stop 628 on routes 4 and 5.
- `npm run smoke`: one live request against MTA, deliberately outside `npm test`
  and outside CI.
- CI on Node 20.x and 22.x.

### Notes

- Not published to npm, by design. MTA's data feed terms, term 1, require that
  users of a distributed app obtain the data from a non-MTA server; a published
  package that makes third parties fetch from `api-endpoint.mta.info` is the
  shape that clause forbids. Full reasoning in
  [docs/terms-compliance.md](docs/terms-compliance.md).
- Classification deliberately does **not** use the status rank MTA documents as
  appended to `entity.id`. Only 1 of 150 entities carried it, and the natural
  parse of an id without it returns a plausible-looking integer rather than an
  error.
