# Contributing

Thanks for considering a contribution. Before you start, please:

- Read this guide, and the two "not negotiable" sections below in particular
- Read the [README](README.md) for what the server does and how to run it
- Read [docs/terms-compliance.md](docs/terms-compliance.md), which explains why this package is not on npm
- Review the open [issues](https://github.com/BetaNYC/mta-mcp/issues) and [pull requests](https://github.com/BetaNYC/mta-mcp/pulls)
- For anything substantial, open an issue first so we can agree on the approach before you write code

## Where to ask what

This repository covers the MCP server only. Questions about the MTA feeds themselves go to the MTA, which has no dedicated developer support team but does actively monitor a public group.

| Topic | Where |
|---|---|
| A tool returns the wrong shape, a schema is wrong, the server crashes | [Our issue tracker](https://github.com/BetaNYC/mta-mcp/issues) |
| A feed field is undocumented, an alert looks wrong, the API behaves unexpectedly | [MTA Developer Google Group](https://groups.google.com/g/mtadeveloperresources) |
| MTA's GTFS and GTFS-RT implementation notes | [github.com/nymta/gtfs-documentation](https://github.com/nymta/gtfs-documentation) |
| Actual service on an actual day | [mta.info](https://www.mta.info) — always, and this server says so in every response |

Asking feed questions in MTA's open group rather than in our tracker gets you a better answer and helps everyone else building against the same data.

## Ground rules specific to this project

This server reads a live public feed run by a public agency, and it answers questions people use to decide how to travel. Two sets of rules follow from that. Neither is negotiable in review.

### Do not publish this to npm

`package.json` sets `"private": true`. That is not a placeholder to be cleaned up — it is the mechanism enforcing a deliberate decision, and a pull request that removes it will be closed.

MTA's [data feed terms](https://www.mta.info/developers/terms-and-conditions), term 1, require that users of a distributed app obtain the data from *your* non-MTA server:

> "In developing your app, you will provide that the MTA data feed is available to others only from a non-MTA server. Accordingly, you will download and store the MTA data feed on a non-MTA server which users of your app will access in order to obtain data. MTA prohibits the development of an app that would make the data available to others directly from MTA's server(s)."

Shipping a package that makes third parties' machines fetch from `api-endpoint.mta.info` is the shape that clause forbids. Running it yourself, for yourself, is not. Clone it and build it; that is the supported path, and it is why there is no `npx` option in the README. The full reasoning, including the counter-argument we considered and rejected, is in [docs/terms-compliance.md](docs/terms-compliance.md).

The same terms mean **no MTA route bullets or roundels** in this repo, its docs, or any output. Those are licensed intellectual property, separate from the free data terms. Write "the 6 train". Quoting MTA's own alert text verbatim — which contains ASCII `[6]` — is fine; that is their text, not their logo.

### Be gentle with the feed

MTA publishes **no rate limit and no refresh cadence**, and the response carries no `Cache-Control`, `ETag`, or `Expires`. We cannot negotiate politeness with the server, so we impose it ourselves. Six mechanisms in `src/mta.ts` do that: a TTL cache, single-flight de-duplication, a global minimum interval between requests, bounded retry honoring `Retry-After`, a request timeout, and an identifying `User-Agent`.

Do not add a code path that bypasses any of them, and in particular:

- **Never add background polling, a prefetch, a warm-up fetch, or a cron.** The server fetches only in direct response to a tool call. A process that fetches when nobody asked is what a denial of service looks like from the far end.
- **Never fetch static GTFS at runtime.** Station data is generated offline into `data/stations.json` by `scripts/update-stations.mjs`. Runtime makes zero network calls for station lookup.
- **Tests must not touch the network.** The suite runs against fixtures in `test/fixtures/`. This is both a correctness rule and the reason CI can run on every push without anyone noticing us.

### Build against documentation, never against a guess

Every endpoint, field name, enum value, and response shape in this codebase should be traceable to MTA's own documentation or to a counted observation of the live feed, and the code comments cite which. A mock built on a guessed field name passes its tests and is still wrong.

Where documentation and the live feed disagree, **the live feed wins and the disagreement gets written down.** There is at least one live example: MTA documents a status rank appended to `entity.id`, and we measured it present on 1 of 150 entities. See the README's "Do not build on the entity-id rank suffix" section.

## The three traps

If you change how alerts are matched to stations, you will meet these. Each has a test that fails the moment it is reintroduced. They are not style preferences — each one is a bug that shipped, or nearly shipped, in a real BetaNYC deliverable.

**1. `mercury_alert.affected_stations` does not mean what its name says.** On alert `lmm:planned_work:33826` ("No 6 between Hunts Point Av and 125 St") it lists **32 stations, including 68 St–Hunter College**, which is nowhere near the suspended segment. It enumerates the route, not the impact. Shape `affected_stops` from `informed_entity` instead. A one-line field swap here silently breaks every answer the server gives.

**2. A station being mentioned in an alert does not mean its service got worse.** `Planned - Express to Local` alerts tag the stations that *gain* service. On 2026-09-19, stop 628 is tagged in two alerts — both are the 4 and the 5 running local through it, which is more trains, not fewer. Classify on `mercury_alert.alert_type` through the effect map in `src/mta.ts`; never on station mention alone.

**3. Station names are not unique.** 193 of 496 parent stations share a name with another, across 76 distinct names. `125 St` is four different stations on four different lines. `resolve_station` returns every candidate and never picks one; the `route_id` filter is the disambiguator. If you add a code path that collapses candidates to a single station, it will be wrong roughly a quarter of the time on the most common names in the system.

A fourth thing worth knowing, though it has no test because it is a design stance rather than a bug: **an alert type we do not recognize counts as a disruption**, and it widens to every station on the route. If we cannot say what a status means, we cannot claim to know what its station tagging means either. Fail toward caution.

## How to contribute

### Reporting issues

A useful bug report includes the tool you called, the arguments you passed, what you expected, and what came back. Paste any error string verbatim. If it is an alert-matching question, include the `entity_id` from the response — it makes the alert findable in the raw feed.

### Feature requests

Say what travel question you are trying to answer, not only which parameter you want added. The feeds have far more surface than this server exposes, and knowing the goal helps us decide whether the answer is a new parameter, a new tool, or a note in the README saying we deliberately do not do that.

Two things are out of scope by design: trip updates and vehicle positions (protobuf-only, and they would drag in three custom `.proto` files for a feature nobody has asked for), and anything requiring a Bus Time API key.

### Code contributions

Open a pull request against `main`. Please make sure:

- `npm test` passes, which builds and runs the full suite
- New logic comes with a test, and the test does not touch the network
- Behavior changes are reflected in the README in the same commit
- No new dependencies. Runtime is `@modelcontextprotocol/sdk` and `zod`; that is deliberate, and a library that saves twenty lines while adding a transitive tree is a net loss here
- Commits are scoped to one change

Expect questions on anything touching `src/mta.ts` — the request path and the alert-matching logic both live there.

### Generative AI

We neither encourage nor prohibit AI coding tools here. This project was itself largely written with [Claude](https://claude.ai), and the README says so.

If you used a generative tool for any part of a contribution, say so in the pull request. Generated code needs more review, not less, and in this codebase specifically: the most common failure we have seen is reaching for the field with the obvious-sounding name. `affected_stations` is right there, it is well-named, it parses cleanly, and it is wrong. Verify against the live feed before you submit rather than leaving that for a reviewer.

## License

This project is licensed under the [MIT License](LICENSE). By submitting a pull request, you agree that your contribution is licensed under the same terms.

The MIT license covers *this code*. It does not cover MTA's data, which is governed by [MTA's terms](https://www.mta.info/developers/terms-and-conditions), or MTA's intellectual property, which requires a [separate license](https://www.mta.info/doing-business-with-us/licensing-program).
