# Tool reference

Every tool, every parameter, and every field in every answer. The
[README](../README.md#tools-reference) has the short version with examples.
Elevators and escalators have their own page:
[docs/accessibility.md](accessibility.md).

This page describes the code in `src/tools.ts` and `src/mta.ts`. If the two
ever disagree, the code is right and this page needs fixing.

## Rules that apply to every tool

- **Unknown parameters are rejected.** A misspelled parameter returns an error
  naming it and listing the accepted ones. It is never silently ignored.
- **Dates are `YYYY-MM-DD`** and read as a full day in New York time
  (midnight to midnight, America/New_York). Only the format is checked.
- **Answers are compact JSON,** one line with no indentation, to save tokens.
  In a sample of four answers from the fixtures, that cut 13 to 34 percent of
  the characters.
- **Errors come back as text starting with `Error:`,** with `isError: true`.
- **Nothing is fetched until a tool is called,** and a fetched feed is reused
  for 60 seconds. See [Responsible use](../README.md#responsible-use).

## Provenance on every answer

Every tool that reads a live feed adds these fields:

| Field | Meaning |
|---|---|
| `fetched_at` | When the feed was downloaded from MTA (ISO 8601, UTC). A cached answer shows the original download time |
| `feed_timestamp` | The feed's own timestamp, in epoch seconds, if it has one. Service alerts do. The elevator feeds don't, so it's `null` there |
| `feed_timestamp_iso` | The same, as ISO 8601 |
| `may_not_be_realtime` | Always `true`. MTA publishes no refresh cadence, and the cache alone can add a minute |
| `staleness_note` | The same point, in words, with the cache length |
| `data_source` | Where the data came from |
| `disclaimer` | That this is unofficial and riders should confirm at mta.info. Required by MTA's terms |

`resolve_station` reads no feed, so it has a `station_data` block instead.

Answers that use a bundled data.ny.gov snapshot also carry `ada_data` (station
ADA status) or `inventory_data` (the elevator and escalator inventory):
`data_pulled_at`, `source_url`, and a note on what the data does and doesn't
say. Those snapshots are never fetched at runtime. See
[data-sources.md](data-sources.md).

## The alert fields

`check_route_on_date` and `get_service_alerts` describe each alert with these
fields:

| Field | Meaning |
|---|---|
| `entity_id` | MTA's id for the alert. `lmm:planned_work:…` is scheduled work, `lmm:alert:…` is a live incident. Include it in bug reports |
| `alert_type` | MTA's status, like `"Planned - Part Suspended"` |
| `alert_type_recognized` | `false` if this server doesn't know that status yet |
| `effect` | What the status means for riders. See [Effects](#effects) |
| `counts_as_disruption` | Whether this alert makes the route "disrupted" |
| `planned` | `true` if the id starts `lmm:planned_work:`. That's an observed pattern, not something MTA documents |
| `routes` | Every route the alert names |
| `header_text` | MTA's headline, in English. Routes appear as `[6]` |
| `description_text` | MTA's longer text, in English, or `null` |
| `human_readable_active_period` | MTA's own wording for when it applies, like `"Sep 18 - Oct 19, Fri 9:30 PM to Mon 5:00 AM"`. Use this in anything a person reads |
| `affected_stops` | Stations MTA tagged, as `{stop_id, stop_name}`, from `informed_entity`. When you asked about one route, only that route's stops. Empty if MTA tagged none |
| `active_periods` | MTA's raw periods, as `{start, end}` in epoch seconds. A missing `start` or `end` means open-ended |

An alert is active on a date if any of its periods overlaps that day in New
York time. An alert with no periods at all is active on every date. The
[GTFS-realtime reference](https://gtfs.org/documentation/realtime/reference/#message-alert)
says such an alert is shown "as long as it appears in the feed," and the feed
only holds alerts that are live now. It hasn't come up yet: all 159 alerts in
the 2026-09-22 pull had periods.

`affected_stops` deliberately ignores MTA's `affected_stations` field, which
lists the whole route. See [CONTEXT.md](../CONTEXT.md#the-traps-in-vocabulary-terms).

## Effects

| `alert_type` | `effect` | Counts as disruption |
|---|---|---|
| `Planned - Stops Skipped` | `reduced` | yes |
| `Planned - Part Suspended` | `reduced` | yes |
| `Planned - Suspended` | `reduced` | yes |
| `Reduced Service` | `reduced` | yes |
| `Planned - Reroute` | `changed` | yes |
| `Boarding Change` | `changed` | yes |
| `Special Schedule` | `changed` | yes |
| `Delays` | `delay` | yes |
| `Planned - Express to Local` | `added_at_local_stops` | no |
| `Extra Service` | `added` | no |
| `Station Notice` | `informational` | no |
| anything else | `unknown` | yes |

These are the 11 statuses seen in a full feed pull on 2026-09-16. MTA's own
table has 35, so more will turn up. An `unknown` status also applies to every
station on the route, since we can't trust station tags on a status we don't
understand.

## `check_route_on_date`

Is a route disrupted on a date, optionally at one station?

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `route_id` | string | yes | Route as MTA writes it: `"6"`, `"6X"`, `"A"`, `"SI"` |
| `date` | string | yes | `YYYY-MM-DD` |
| `stop_id` | string | no | GTFS parent-station id. Wins over `station` if you pass both |
| `station` | string | no | Station name, matched among the stations `route_id` serves |
| `include_accessibility` | boolean | no | Also list elevator and escalator outages at the station that day. Needs `stop_id` or `station`. One extra request, so it's off by default |

### How the station is found

- **`stop_id`** is looked up in the bundled station list. An unknown id is an
  error, so a typo can't widen the answer to the whole route.
- **`station`** is matched by name among stations on `route_id` (see
  [resolve_station](#resolve_station) for the scoring). If one station scores
  highest, it's used, even for a partial name: `"14 St"` on the 6 picks
  `14 St-Union Sq`, because no station on the 6 is named exactly `14 St`.
  Check `station.stop_name` in the answer. If two or more tie, or none match,
  you get the non-answer below.

### The answer

| Field | Meaning |
|---|---|
| `route_id`, `date` | What you asked |
| `disrupted` | `true` if any relevant alert counts as a disruption |
| `station` | `{stop_id, stop_name, routes, accessibility}` for the station used, or `null`. `accessibility` is MTA's ADA status; see [docs/accessibility.md](accessibility.md#station-accessibility) |
| `station_matched_by` | `"stop_id"`, `"station name, narrowed to route …"`, or `null` |
| `station_serves_route` | Whether that station is on this route in MTA's schedule data. `null` with no station |
| `station_level_detail` | `true` only if there was at least one alert and every one named its stations |
| `station_level_detail_note` | What `station_level_detail` means for this answer, in words |
| `alert_count` | Alerts on this route that day |
| `unknown_alert_types` | Statuses this server didn't recognize. Non-empty means the effect table needs updating |
| `alerts` | The alerts, with the [alert fields](#the-alert-fields) plus the three below |
| `accessibility_note` | With a station, what `station.accessibility` means and doesn't. Otherwise `null` |
| `accessibility_outages` | With `include_accessibility: true`, the station's elevator and escalator outages that day, with MTA's alternate routes. Otherwise `null`. Fields in [docs/accessibility.md](accessibility.md#elevators-in-check_route_on_date) |

Extra fields on each alert:

| Field | Meaning |
|---|---|
| `affects_this_station` | `true` if MTA tagged your station. `null` if you didn't ask about a station |
| `relevant_to_station` | Whether the alert counts toward your station's answer. `true` if MTA tagged it, if the alert tags no stations at all, or if its status is unknown |
| `station_level_detail` | Whether this alert names any stations on this route |

**How `disrupted` is decided.** With no station, any disrupting alert on the
route makes it `true`. With a station, only alerts with
`relevant_to_station: true` count. So an alert that names other stations and
not yours is left out, but an alert that names no stations is counted, because
it could affect anywhere on the route.

### The non-answer

If the station name can't be narrowed to one station, you get this instead,
with no `disrupted` field:

| Field | Meaning |
|---|---|
| `resolved` | `false` |
| `reason` | Which case this is: no station has that name, the name exists but not on this route, or several stations on this route tie |
| `candidates` | The matching stations, with their routes, scores, and ADA status |

Pick one and call again with its `stop_id`. With `include_accessibility`, no
elevator request is made until the station is resolved.

## `get_service_alerts`

Every alert active on a date, with optional filters.

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `route_id` | string | no | Only alerts naming this route |
| `date` | string | no | `YYYY-MM-DD`. Defaults to today in New York |
| `alert_type` | string | no | Exact MTA status, like `"Planned - Stops Skipped"`. Must match exactly |
| `planned_only` | boolean | no | Only scheduled work (`lmm:planned_work:` ids) |
| `effect` | string | no | One of `reduced`, `changed`, `delay`, `informational`, `added`, `added_at_local_stops`, `unknown` |

All filters combine. With none, you get every alert on every route that day.
On 2026-09-22 that was about 20,000 tokens, so filter when you can.

### The answer

| Field | Meaning |
|---|---|
| `date` | The date used |
| `filters` | The filters applied |
| `alert_count` | Alerts returned |
| `disrupting_alert_count` | How many of those count as disruptions |
| `unknown_alert_types` | Statuses this server didn't recognize |
| `known_alert_types` | Every status in the effect table, so you can see what `alert_type` accepts |
| `alerts` | The alerts, with the [alert fields](#the-alert-fields) |

With `route_id`, each alert's `affected_stops` shows only that route's stops,
but `routes` still lists every route the alert names.

## `resolve_station`

Turns a station name into GTFS ids. Reads the bundled station list and makes
no network call.

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Station name or part of one |
| `route_id` | string | no | Only stations this route serves |

### How names are matched

The query and each station name are lowercased and split into words, with
punctuation removed. Then:

| Score | When |
|---|---|
| 100 | Same words, same order |
| 80 | The station's name starts with your words |
| 60 | Your words appear together somewhere in the name |
| 40 | All your words appear, in any order |

Matches are sorted by score, then shorter names first, then by `stop_id`. At
most 10 are returned.

### The answer

| Field | Meaning |
|---|---|
| `query`, `route_id` | What you asked |
| `match_count` | Candidates returned (at most 10) |
| `unambiguous` | `true` if there's one candidate, or the first scores higher than the second |
| `candidates` | `{stop_id, stop_name, lat, lon, routes, score, accessibility}`, best first |
| `note` | What to do when it's ambiguous, otherwise `null` |
| `station_data` | When and where the station list came from: `generated_at`, `source_url`, `station_count`, `route_membership`, and a note |
| `ada_data` | When and where the ADA status came from, and what it means |

`accessibility` is `{status, mta_notes}`, plus `accessible_direction` for a
partially accessible station: MTA's label for that side, like `"Manhattan"`.
Lead with `mta_notes`. `status` is `fully_accessible`,
`partially_accessible`, `not_accessible`, or `unknown`. At 14 St-Union Sq, the
4/5/6 station is `not_accessible` and the other two are `fully_accessible`,
because the status is per station. Full detail in
[docs/accessibility.md](accessibility.md#station-accessibility).

`routes` comes from MTA's regular schedule, so it can include more than the
map shows. `628` (68 St–Hunter College) lists the 4, because the 4 runs local
there overnight.

## `get_accessibility_outages`

Elevator and escalator outages. Documented in full, including its known gaps,
in [docs/accessibility.md](accessibility.md).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `station` | string | no | Station name, matched loosely |
| `stop_id` | string | no | GTFS parent-station id. Rows are placed by equipment ID from MTA's inventory, with name matching as a fallback. Outages elsewhere in the station's complex go to `complex_outages`, and name matches that belong to another station to `other_station_outages` |
| `route_id` | string | no | Only rows whose `trainno` includes this route. `6X`, `7X`, and `FX` count as `6`, `7`, and `F`; `GS`, `FS`, and `H` count as `S` |
| `date` | string | no | `YYYY-MM-DD`. Outages in effect now or scheduled whose window overlaps that day in New York time |
| `upcoming` | boolean | no | `false` (default) for outages in effect now, `true` for scheduled ones |

`date` with `upcoming: true` is an error. `upcoming: false`, the default, is
accepted with `date`. A date query reads the current feed alone, which relies on
that feed containing every scheduled outage; MTA doesn't document that.

Each outage row is MTA's row plus, where they apply, `matched_by`
(`"equipment id"`, `"name"`, or `"partial name"`), `match_note`, and
`inventory` (`stop_ids`, `ada_compliant`, `redundant_elevator`,
`alternative_route`). Fields with nothing to say are left out, and
`inventory` comes only with `station` or `stop_id`. Alongside the rows,
the answer has `date`, `route_id`, `route_tokens_matched`, `route_note`,
`station_accessibility`, `rows_without_station`, `no_match_note`,
`date_caveats`, `complex_outages`, `other_station_outages`, `inventory_data`,
and `ada_data`. Each is described in
[docs/accessibility.md](accessibility.md#the-answer).

**Before relying on it:** no listed outage doesn't mean a station is usable,
the ADA status and alternate routes come from dated snapshots, and the dates
are MTA's estimates. Read the [gaps](accessibility.md#gaps) first.
