# Why this is not on npm

BetaNYC publishes six MCP servers to npm under `@betanyc`. This one is
deliberately not among them, and `package.json` sets `"private": true` so an
accidental `npm publish` fails rather than succeeding quietly.

This document exists so the reason survives the session that decided it.

## The clause

MTA's [data feed terms and conditions](https://www.mta.info/developers/terms-and-conditions),
term 1, verbatim:

> "In developing your app, you will provide that the MTA data feed is available
> to others only from a non-MTA server. Accordingly, you will download and store
> the MTA data feed on a non-MTA server **which users of your app will access in
> order to obtain data**. MTA prohibits the development of an app that would make
> the data available to others directly from MTA's server(s)."

The same page states the prohibition a second time, as the framing for the whole
agreement:

> "MTA prohibits the development of an app that would make the data available to
> others directly from MTA's server(s)."

## Why that rules out publishing, and not running

The architecture the terms describe is: **fetch → store on your own server →
serve to others from there.**

A published MCP server is the opposite shape. It is distributed to third
parties, and on each tool call every one of those third parties' machines
fetches from `api-endpoint.mta.info` and reads the response directly. There is
no intermediate BetaNYC server and no stored copy. Distributing a package whose
normal operation makes other people's machines pull from MTA's servers is a
reasonable reading of the prohibited pattern.

BetaNYC running this for BetaNYC is not that. It is one organization consuming
MTA's public data for its own use, which is exactly what the feeds are for.

There is a counter-argument worth stating honestly: an `npx` user runs the code
on their own machine and is themselves the party accessing MTA, no differently
than if they ran `curl`. But MTA is the only publisher behind BetaNYC's MCP
fleet with an explicit clause forbidding this shape, the clause is about
*developing the app* rather than about who runs it, and the terms give MTA sole
discretion to act:

> "Permanently or temporarily terminate your access to the data feed because MTA
> has determined in its sole discretion that you have violated this agreement."

Ambiguity plus sole discretion is not a risk worth taking for the convenience of
an `npx` one-liner.

**If publishing ever becomes worth it**, the clean route is the one the terms
actually describe: cache the feed on a BetaNYC-hosted endpoint and have the
published package read from that. That is a different project. A written answer
from MTA, via the
[MTA Developers Google Group](https://groups.google.com/g/mtadeveloperresources),
would be the other route.

## What follows from this, in code

- `"private": true` in `package.json`.
- No `release.yml`, no npm tag workflow, no `NPM_TOKEN`. The release protocol in
  the BetaNYC workspace's `platform/system/engineering-standards.md` §
  "Release protocol — public MCP repos" **does not apply to this repo.**
- Installation is build-from-source only, and the README says so and says why.

## Three further obligations, which bind however this is run

**1. No accuracy claim** (term 3): "You will not state or imply that the data is
accurate, complete, or timely." Every tool result carries a `disclaimer` field
saying this is unofficial and that riders should confirm at mta.info, and the
README says the same.

**2. Staleness disclosure** (term 2): if output can lag the live feed by more
than a minute, the app must indicate that the information "may not be real
time." The 60-second response cache alone can do that, and MTA publishes no
refresh cadence for the feed itself, so `may_not_be_realtime` is `true` in every
payload, unconditionally, alongside a `staleness_note`.

**3. Logos, maps and symbols are separately licensed** and are *not* covered by
the free data terms. MTA: "Our data feeds are free to use. But to use our logos,
maps, symbols or other intellectual property, you need to apply for a license."
([licensing program](https://www.mta.info/doing-business-with-us/licensing-program)).
**The route bullets — the circled 6, the 4/5 roundels — are licensed IP, not
free data.** This repo writes "the 6 train" in prose and never reproduces a
bullet. Quoting MTA's own `header_text` verbatim, which contains ASCII `[6]`, is
their text rather than their logo and is fine.

MTA also reserves the right to change these terms, or terminate the feeds, at
any time and without notice. Do not put this on an event-day critical path
without a manual fallback.
