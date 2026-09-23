# Why this is not on npm

BetaNYC publishes seven MCP servers to npm under `@betanyc`. This one is
intentionally not one of them. `package.json` sets `"private": true`, so an
accidental `npm publish` fails.

We wrote this down so the reasoning outlasts the conversation where we decided it.

## The clause

Term 1 of MTA's [data feed terms and conditions](https://www.mta.info/developers/terms-and-conditions):

> "In developing your app, you will provide that the MTA data feed is available
> to others only from a non-MTA server. Accordingly, you will download and store
> the MTA data feed on a non-MTA server **which users of your app will access in
> order to obtain data**. MTA prohibits the development of an app that would make
> the data available to others directly from MTA's server(s)." (Emphasis ours.)

The same page repeats the prohibition as the framing for the whole agreement:

> "MTA prohibits the development of an app that would make the data available to
> others directly from MTA's server(s)."

## Why this rules out publishing, but not running it

The terms describe one setup: fetch the feed, store it on your own server, and
serve it to others from there.

A published MCP server works the other way. Everyone who installs it fetches
from `api-endpoint.mta.info` directly on every tool call. There's no BetaNYC
server in between and no stored copy. Distributing a package that sends other
people's machines to MTA's servers fits a reasonable reading of what the clause
prohibits.

BetaNYC running this for our own use is different. That's one organization
using MTA's public data, which is what the feeds are for.

There is a counter-argument. Someone who runs it with `npx` is fetching on their
own machine, no differently than running `curl`. We considered that and
decided against publishing anyway, for three reasons. MTA is the only data
publisher behind BetaNYC's MCP servers with a clause that forbids this setup.
The clause is about *developing the app*, not about who runs it. And the terms
let MTA act at its sole discretion:

> "Permanently or temporarily terminate your access to the data feed because MTA
> has determined in its sole discretion that you have violated this agreement."

An `npx` one-liner isn't worth that risk.

If publishing is ever worth doing, there are two ways to get there. The first is
the setup the terms describe: cache the feed on a BetaNYC-hosted endpoint and
have the published package read from it. That would be a separate project. The
second is a written answer from MTA, which we'd ask for through the
[MTA Developers Google Group](https://groups.google.com/g/mtadeveloperresources).

## What this means in the code

- `"private": true` in `package.json`.
- No `release.yml`, no npm tag workflow, and no `NPM_TOKEN`. The release protocol
  for public MCP repos, in the BetaNYC workspace's
  `platform/system/engineering-standards.md`, does not apply to this repo.
- Installation is build-from-source only, and the README explains why.

## Three more obligations, however this is run

**1. No accuracy claim** (term 3): "You will not state or imply that the data is
accurate, complete, or timely." Every tool result has a `disclaimer` field
saying this is unofficial and riders should confirm at mta.info. The README says
the same.

**2. Say when data may be stale** (term 2): if output can lag the live feed by
more than a minute, the app must say it "may not be real time." The 60-second
cache alone can cause that lag, and MTA doesn't publish a refresh cadence for the
feed. So every response sets `may_not_be_realtime` to `true` and includes a
`staleness_note`.

**3. Logos, maps, and symbols are licensed separately** from the free data terms.
From MTA: "Our data feeds are free to use. But to use our logos, maps, symbols or
other intellectual property, you need to apply for a license."
([licensing program](https://www.mta.info/doing-business-with-us/licensing-program)).
That includes the route bullets, like the circled 6 or the 4 and 5 roundels. This
repo writes "the 6 train" in prose and never reproduces a bullet. MTA's own
`header_text`, which writes the route as ASCII `[6]`, is their text and fine to
quote.

MTA can also change these terms or shut off the feeds at any time, without
notice. If you use this for event-day travel, keep a manual fallback.
