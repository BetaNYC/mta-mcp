# MTA MCP — build vocabulary

The words this codebase uses, and what they mean in MTA's data specifically. Most of the bugs this server exists to prevent are vocabulary errors: two things that sound like the same thing, are not, and produce a confident wrong answer when confused.

Read this before changing anything in `src/mta.ts`.

## Identifiers

### Route

A single service, identified by `route_id`: `"6"`, `"A"`, `"7X"`. There are **29** of them in the subway feed. This is what a rider means by "the 6 train", and it is the unit every tool here speaks.

**`route_id` is the identifier. `route_short_name` is not.** Two different routes — `GS` (42 St Shuttle) and `FS` (Franklin Avenue Shuttle) — both carry `route_short_name: "S"`. Never key anything on the short name.

**Express variants are separate routes**, not a flag on the parent. `6` is the Lexington Avenue Local; `6X` is the Pelham Bay Park Express — what riders know as the diamond 6. Likewise `7` and `7X`. A question about "the 6" usually means both, and station route membership in `data/stations.json` reflects that: stop `628` lists `["4", "6", "6X"]`.

### Line

A physical trunk of track, named for the street it runs under — the Lexington Avenue Line, the 8th Avenue Line. Several routes share one line.

**This codebase does not model lines.** `route_long_name` gestures at them ("Lexington Avenue Local", "8 Avenue Express") but there is no line identifier in the feed and no tool takes one. When a human asks "what's happening on the Lexington line this weekend," that resolves to a `get_service_alerts` call across the 4, 5, 6, and 6X. Do not invent a line abstraction to make that one phrasing tidier.

### Parent station vs. platform

`stops.txt` carries both, distinguished by `location_type`:

- **Parent station** (`location_type=1`) — the station as a rider thinks of it. `628` is 68 St–Hunter College.
- **Platform** (`location_type` empty, with a `parent_station`) — one direction. `628N` and `628S`.

**The alerts feed emits parent stations only.** In the 2026-09-16 sample: 402 distinct `stop_id` values, zero with an `N`/`S` suffix. Direction, where MTA provides it, arrives separately as `direction_id` on the informed entity (`0` northbound, `1` southbound, **omitted means both**).

`data/stations.json` holds the 496 parent stations. The generator folds platform rows up to their parent when joining route membership, which is why it strips a trailing `N`/`S` before matching.

### Station complex

Several parent stations a rider can transfer between without leaving fare control. These are **not** one station in the data, and they come in two flavors, only one of which this server handles:

**Same name, several IDs.** 76 of 496 parent stations share a `stop_name` with at least one other. `125 St` is four stations on four unrelated lines — `116` (1), `225` (2/3), `621` (4/5/6/6X), `A15` (A/B/C/D). `Times Sq-42 St` is four. `14 St` is three. This is why `resolve_station` returns every candidate and never picks, and why the `route_id` filter has to work.

**Different names, linked only by `transfers.txt`.** 60 such pairs — `Times Sq-42 St (127)` ↔ `42 St-Port Authority Bus Terminal (A27)`, `Park Place (228)` ↔ `World Trade Center (E01)`. **We deliberately do not model these.** Asking about one name will not surface alerts filed against its connected neighbor under a different name. The gap is documented in the README rather than coded around, because nothing in BetaNYC's actual use has needed it.

## Alerts

### Entity

One item in the feed's `entity` array: an `id` plus an `alert`. The 2026-09-16 sample held 150; a 2026-09-17 pull held 199. **The feed is `FULL_DATASET`** — each fetch is the complete current picture, not a delta. There is no state to accumulate and nothing to reconcile between fetches.

Entity IDs come in two shapes, and the split matters:

- `lmm:planned_work:33826` — scheduled work, announced ahead. **149 of 150** in the sample.
- `lmm:alert:267678:26` — a live incident, happening now.

### Informed entity

An entry in `alert.informed_entity[]` saying who the alert is about. Always carries `route_id` and `agency_id` (`"MTASBWY"`); carries `stop_id` only when MTA chose to tag stations, and `direction_id` only sometimes.

**This is the authoritative impact list, and it is the only one.** See the trap below.

### Active period

`alert.active_period[]`, a list of `{start, end}` epoch-second pairs. Recurring weekend work appears as **several** periods, so the test is "does any period overlap the event day," evaluated in `America/New_York` — not UTC, which is a different day for four hours every night.

Alongside it, `mercury_alert.human_readable_active_period` carries MTA's own rider-facing phrasing: *"Sep 18 - Oct 19, Fri 9:30 PM to Mon 5:00 AM"*. **Prefer it in anything a human reads.** It says what a reformatted timestamp cannot, and it is MTA's wording rather than ours.

### Alert type, and effect

`mercury_alert.alert_type` is MTA's status string: `"Planned - Part Suspended"`, `"Planned - Express to Local"`, `"Delays"`. **Effect** is ours — a classification of what that status means for a rider at a tagged station, defined in `src/mta.ts`:

| effect | means |
|---|---|
| `reduced` | fewer trains, or none |
| `added` / `added_at_local_stops` | **more** service at the tagged stations |
| `changed` | different, not clearly better or worse |
| `delay` | running late |
| `informational` | a notice, not a service change |
| `unknown` | a status string we have never seen |

`unknown` counts as a disruption, and widens to every station on the route rather than only tagged ones. If we cannot say what a status means, we cannot claim to know what its station tagging means either.

### Mercury

MTA's custom GTFS-Realtime extension carrying everything above beyond the base spec. In protobuf it needs a `.proto` file; **in the `.json` variant of the feed it arrives as ordinary keys** named by their fully-qualified extension name — `"transit_realtime.mercury_alert"`, `"transit_realtime.mercury_entity_selector"`.

That is the single fact that makes this server small. We consume the JSON feed and never compile a protobuf.

Six documented Mercury fields never appeared in any live sample: `no_affected_stations`, `clone_id`, `screens_summary`, `directionality`, `service_plan_number`, `general_order_number`. Do not build on them.

## The traps, in vocabulary terms

**`affected_stations` is not the affected stations.** `mercury_alert.affected_stations` on `lmm:planned_work:33826` — "No 6 between Hunts Point Av and 125 St" — lists **32 stations including 68 St–Hunter College**, which is six miles from the suspended segment. It enumerates the route. The real impact list is `informed_entity`, which names six stops. The field is well-named, parses cleanly, and is wrong.

**"Affected" is not "worse".** A station tagged by a `Planned - Express to Local` alert is *gaining* service. Two such alerts tag stop 628 on 2026-09-19 and both mean more trains. "Is my station mentioned" is not the question; "what does this status do to my station" is.

**"Not tagged" is not "not affected".** MTA tags stations only when a change is significant enough to warrant the detail. Their own spec says so:

> "Consumers should not assume that every alert will include Stations Affected data."

So every response carries `station_level_detail`, reporting whether MTA tagged stations at all. A `disrupted: false` with `station_level_detail: false` means "we found nothing station-specific," not "your station is fine."

## Data sources

| What | Where | Notes |
|---|---|---|
| Subway service alerts | `api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json` | No key. Published at [api.mta.info](https://api.mta.info/#/serviceAlerts) |
| Elevator/escalator outages | `…/nyct%2Fnyct_ene.json`, `…/nyct%2Fnyct_ene_upcoming.json` | Flat JSON arrays, **not** GTFS-RT. `station` is free text, not a `stop_id` |
| Static GTFS | `rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip` | Build-time only, via `scripts/update-stations.mjs`. Never fetched at runtime |
| MTA's own feed documentation | [github.com/nymta/gtfs-documentation](https://github.com/nymta/gtfs-documentation) | Sparse, and not always true of the live feed — see the README on the entity-id rank suffix |
| Terms | [mta.info/developers/terms-and-conditions](https://www.mta.info/developers/terms-and-conditions) | Why this is not on npm: [docs/terms-compliance.md](docs/terms-compliance.md) |

No API key is required for anything here. Bus Time — live bus positions and arrivals — is the one MTA product that needs an account, and it is out of scope.
