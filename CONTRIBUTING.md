# Contributing

Thanks for considering a contribution. Before you start, please:

- Read this guide, especially the ground rules below
- Read the [README](README.md) for what the server does and how to run it
- Read [docs/terms-compliance.md](docs/terms-compliance.md), which explains why this package is not on npm
- Look through the open [issues](https://github.com/BetaNYC/mta-mcp/issues) and [pull requests](https://github.com/BetaNYC/mta-mcp/pulls)
- For anything substantial, open an issue first so we can agree on the approach before you write code

## Where to ask what

This repository covers the MCP server only. Questions about the MTA feeds themselves go to the MTA. MTA points developers to a public Google Group.

| Topic | Where |
|---|---|
| A tool returns the wrong shape, a schema is wrong, the server crashes | [Our issue tracker](https://github.com/BetaNYC/mta-mcp/issues) |
| A feed field is undocumented, an alert looks wrong, the API behaves unexpectedly | [MTA Developer Google Group](https://groups.google.com/g/mtadeveloperresources) |
| MTA's GTFS and GTFS-RT implementation notes | [github.com/nymta/gtfs-documentation](https://github.com/nymta/gtfs-documentation) |
| Actual service on an actual day | [mta.info](https://www.mta.info). Every response from this server says so too |

Feed questions get better answers in MTA's group than in our tracker, and the answers help everyone else building on the same data.

## Ground rules

This server reads a live public feed run by a public agency, and people use its answers to decide how to travel. That leads to a few rules we hold firm on in review.

### Don't publish this to npm

`package.json` sets `"private": true` on purpose, so an accidental publish fails. We'll close a pull request that removes it.

Term 1 of MTA's [data feed terms](https://www.mta.info/developers/terms-and-conditions) requires that users of a distributed app get the data from *your* server, not MTA's:

> "In developing your app, you will provide that the MTA data feed is available to others only from a non-MTA server. Accordingly, you will download and store the MTA data feed on a non-MTA server which users of your app will access in order to obtain data. MTA prohibits the development of an app that would make the data available to others directly from MTA's server(s)."

A published package would have every user's machine fetch from `api-endpoint.mta.info`, which is what that clause rules out. Cloning and running it yourself, for yourself, is fine, and it's the only install path the README offers. [docs/terms-compliance.md](docs/terms-compliance.md) has the full reasoning, including the counter-argument we considered.

The same terms mean no MTA route bullets or roundels anywhere in this repo, its docs, or its output. They're licensed separately from the free data. Write "the 6 train." Quoting MTA's own alert text, which writes the route as ASCII `[6]`, is fine.

### Be gentle with the feed

MTA publishes no rate limit and no refresh cadence, and its responses carry no `Cache-Control`, `ETag`, or `Expires` header. So we set limits ourselves. Six mechanisms in `src/mta.ts` handle it: a TTL cache, single-flight de-duplication, a minimum gap between requests, bounded retry that honors `Retry-After`, a request timeout, and an identifying `User-Agent`.

Please don't add a code path that skips any of them. In particular:

- **No background polling, prefetch, warm-up fetch, or cron.** The server fetches only when a tool is called.
- **No fetching static GTFS or data.ny.gov at runtime.** `scripts/update-stations.mjs` generates `data/stations.json`, and `scripts/update-accessibility-data.mjs` generates `data/station_ada.json` and `data/equipment.json`, all offline. Station lookup, ADA status, and alternate routes make no network calls. See [docs/data-sources.md](docs/data-sources.md).
- **No network access in tests.** The suite runs against fixtures in `test/fixtures/`. That keeps the tests correct and lets CI run on every push without touching MTA.

### Build against documentation

Every endpoint, field name, enum value, and response shape in this codebase should trace back to MTA's documentation or to a counted observation of the live feed, and code comments say which. A mock built on a guessed field name will pass its tests and still be wrong.

When the documentation and the live feed disagree, go with the live feed and write down the difference. One example: MTA documents a status rank appended to `entity.id`, and we found it on 1 of 150 entities. See "Don't rely on the status rank in entity ids" in the README.

## Three traps

If you change how alerts are matched to stations, you'll run into these. Each has a test that fails if it comes back, and each was a real bug in BetaNYC work, shipped or caught just before.

**1. `mercury_alert.affected_stations` lists the whole route.** On alert `lmm:planned_work:33826` ("No 6 between Hunts Point Av and 125 St") it lists 32 stations, including 68 St–Hunter College, which is nowhere near the suspension. Build `affected_stops` from `informed_entity` instead.

**2. A station named in an alert may be gaining service.** `Planned - Express to Local` alerts tag the stations that get more trains. On 2026-09-19, stop 628 is tagged in two alerts, and both are the 4 and 5 running local through it. Classify on `mercury_alert.alert_type` using the effect map in `src/mta.ts`, never on whether a station is mentioned.

**3. Station names are not unique.** 193 of 496 parent stations share a name with another, across 76 names. `125 St` is four stations on four lines. `resolve_station` returns every candidate and never picks one, and `route_id` narrows the list.

One more design choice, which has no test because it isn't a bug: an alert type we don't recognize counts as a disruption and applies to every station on the route. If we don't know what a status means, we can't trust its station tagging either.

## How to contribute

### Reporting issues

A useful bug report includes the tool you called, the arguments you passed, what you expected, and what came back. Paste any error message exactly. For an alert-matching question, include the `entity_id` from the response so we can find the alert in the raw feed.

### Feature requests

Tell us the travel question you're trying to answer, as well as the parameter you want. The feeds offer much more than this server uses, and knowing the goal helps us decide between a new parameter, a new tool, or a note in the README explaining why we don't.

Two things are out of scope: trip updates and vehicle positions (protobuf-only, needing three custom `.proto` files that nobody has asked for), and anything that needs a Bus Time API key.

### Code contributions

Open a pull request against `main`. Please make sure:

- `npm test` passes. It builds and runs the full suite
- New logic comes with a test, and the test doesn't touch the network
- Behavior changes are reflected in the README in the same commit
- No new dependencies. The runtime uses `@modelcontextprotocol/sdk` and `zod` and nothing else, and we'd rather write twenty lines than take on a new dependency tree
- Each commit covers one change

Expect questions on anything in `src/mta.ts`. The request path and the alert-matching logic both live there.

### Generative AI

We don't encourage or prohibit AI coding tools. This project was largely written with [Claude](https://claude.ai), and the README says so.

If you used a generative tool for any part of a contribution, say so in the pull request. Generated code needs more review, not less. The most common mistake we've seen in this codebase is picking the field with the obvious name: `affected_stations` is well-named, parses cleanly, and gives the wrong answer. Check your change against the live feed before you submit.

## License

This project is licensed under the [MIT License](LICENSE). By submitting a pull request, you agree that your contribution is licensed under the same terms.

The MIT license covers this code. MTA's data is governed by [MTA's terms](https://www.mta.info/developers/terms-and-conditions), and MTA's logos and symbols need a [separate license](https://www.mta.info/doing-business-with-us/licensing-program).
