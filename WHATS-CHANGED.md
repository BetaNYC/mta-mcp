# What's changed

This page lists the changes to mta-mcp that a reader would notice: new tools, new data, changes to the website, and corrections when the server gave a wrong answer. Newest first. Routine data refreshes are not listed.

- **History begins:** 2026-09-17, the first version. Corrections made before this date may be missing.
- **Data refresh:** Service alerts and elevator and escalator outages come from MTA's live feeds each time a tool is called. Station names, each station's accessibility status and MTA's elevator inventory are snapshots kept in the repository and refreshed by hand when needed.

mta-mcp is not published to npm. You run it from your own copy of the repository, so a change reaches you when you update that copy and rebuild it. To report a bug in this server or ask for a new feature, [open an issue on GitHub](https://github.com/BetaNYC/mta-mcp/issues).

## Unreleased: A What's changed page, and two tools that explain the server

- **Tags:** Site, MCP
- **What changed:** The website has a new page that lists every change a reader would notice. Two new tools let your AI assistant answer "what's new in this server?" and "who built this?" with links to BetaNYC and to the place to report a bug in this server or ask for a new feature. Version 0.2.0 is the first new version number since 0.1.0, so it also carries the September and October changes listed below.
- **MCP version:** [mta-mcp 0.2.0](CHANGELOG.md)
- **More detail:** [What's changed on the website](https://betanyc.github.io/mta-mcp/whats-changed.html) · [Release notes](CHANGELOG.md)

## 2026-10-12: Answers warn when the station and elevator data are old

- **Tags:** MCP, Data
- **What changed:** Station names, accessibility status and the elevator inventory come from copies of MTA's data kept in the repository, and nothing updates them on its own. Every answer that uses one now gives the date it was pulled, and warns when the station accessibility or elevator copy is more than 30 days old or the station list more than 90 days old.
- **MCP version:** [mta-mcp](CHANGELOG.md) as built from the main branch from October 12, 2026 on. The version number was still 0.1.0; the release notes list this under 0.2.0.
- **More detail:** [Pull request](https://github.com/BetaNYC/mta-mcp/pull/5) · [Keep your data current](https://github.com/BetaNYC/mta-mcp#keep-your-data-current)

## 2026-09-23: Station accessibility status, and MTA's routes around broken elevators

- **Tags:** MCP, Data
- **What changed:** Every station the server looks up now says whether MTA lists it as fully accessible, partly accessible or not accessible. When you ask about one station, each elevator or escalator outage there carries MTA's own alternate route, and outages are placed at the station by MTA's equipment number first, with names only as a fallback. A route check can also include the station's elevator outages that day.
- **MCP version:** [mta-mcp](CHANGELOG.md) as built from the main branch from September 23, 2026 on. The version number was still 0.1.0; the release notes list this under 0.2.0.
- **More detail:** [Pull request](https://github.com/BetaNYC/mta-mcp/pull/2) · [Elevators, escalators and accessibility](docs/accessibility.md) · [Data sources](docs/data-sources.md)

## 2026-09-23: Some elevator outages were missed or shown at the wrong station

- **Tags:** MCP, Correction
- **What changed:** From September 17 to September 23, 2026, MTA's elevator feed spelled some stations differently from the station list, and the server did not match them. Searches for Bedford Park Blvd and 42 St-Port Authority returned no outages when there were some. Matching by name also put some outages at a different station with a similar name: against the saved feeds, 13 such pairings were wrong. The fixes on September 23 match the different spellings and place outages by MTA's equipment number first.
- **If you used the old numbers:** If you checked elevators or escalators at a station during that week, for example to tell people which station to use, check the station again with the current version. Elevator status changes often, so an answer from that week is out of date in any case.
- **MCP version:** [mta-mcp](CHANGELOG.md) as built from the main branch from September 23, 2026 on. The version number was still 0.1.0; the release notes list this under 0.2.0.
- **More detail:** [The first fix](https://github.com/BetaNYC/mta-mcp/pull/1) · [The second fix](https://github.com/BetaNYC/mta-mcp/pull/2) · [Elevators, escalators and accessibility](docs/accessibility.md)

## 2026-09-23: Service alerts that gave no dates were left out of every date

- **Tags:** MCP, Correction
- **What changed:** From September 17 to September 23, 2026, a service alert that gave no dates was counted as active on no date at all, so a route check could miss it. The GTFS-realtime reference says such an alert is active all the time, and since September 23 the server counts it on every date.
- **If you used the old numbers:** If you checked a route for a date during that week and the answer said it was not disrupted, check it again with the current version. The record does not show whether MTA's feed carried an alert with no dates that week.
- **MCP version:** [mta-mcp](CHANGELOG.md) as built from the main branch from September 23, 2026 on. The version number was still 0.1.0; the release notes list this under 0.2.0.
- **More detail:** [The fix](https://github.com/BetaNYC/mta-mcp/pull/1)

## 2026-09-23: Elevator outages by date and by line, and a way to use the tools without MCP

- **Tags:** MCP
- **What changed:** The elevator and escalator tool can now list outages for a given date or a given subway line, and says what to try next when a search finds nothing. A skill for Claude Code runs the same tools from the command line, with no MCP server. Every tool now returns shorter answers.
- **MCP version:** [mta-mcp](CHANGELOG.md) as built from the main branch from September 23, 2026 on. The version number was still 0.1.0; the release notes list this under 0.2.0.
- **More detail:** [Pull request](https://github.com/BetaNYC/mta-mcp/pull/1) · [Every tool and field](docs/tools.md) · [The skill](skills/README.md)

## 2026-09-21: A website for the server

- **Tags:** Site
- **What changed:** The website went live, with what the server does and cannot do, worked examples, how to run it, and other subway servers to try for live arrivals.
- **More detail:** [The website](https://betanyc.github.io/mta-mcp/)

## 2026-09-17: First version, with four tools for subway alerts, elevators and stations

- **Tags:** MCP
- **What changed:** The first version went up on GitHub. Its four tools check whether a subway line is disrupted on a date at a station, list the service alerts for a date, find a station by name, and list elevator and escalator outages. It is not on npm, because MTA's data terms rule out a published package.
- **MCP version:** [mta-mcp 0.1.0](CHANGELOG.md#010--2026-09-17)
- **More detail:** [Release notes](CHANGELOG.md#010--2026-09-17) · [Why this is not on npm](docs/terms-compliance.md)
