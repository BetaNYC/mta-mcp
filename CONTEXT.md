# MTA MCP build vocabulary

The words this codebase uses, and what they mean in MTA's data. Most of the bugs this server is built to avoid come from mixing up two terms that sound alike but aren't, which produces a wrong answer that looks right.

Read this before changing anything in `src/mta.ts`.

## Identifiers

### Route

A single service, identified by `route_id`: `"6"`, `"A"`, `"7X"`. The subway feed has 29 of them. A route is what a rider means by "the 6 train," and every tool here works in routes.

**Use `route_id`, never `route_short_name`.** Two different routes, `GS` (42 St Shuttle) and `FS` (Franklin Avenue Shuttle), both have `route_short_name: "S"`.

**Express variants are separate routes.** `6` is the Lexington Avenue Local, and `6X` is the Pelham Bay Park Express, which riders know as the diamond 6. Likewise `7` and `7X`. A question about "the 6" usually means both, and station route membership in `data/stations.json` reflects that: stop `628` lists `["4", "6", "6X"]`.

### Line

A physical stretch of track, named for the street it runs under, like the Lexington Avenue Line or the 8th Avenue Line. Several routes share one line.

**This codebase doesn't model lines.** `route_long_name` hints at them ("Lexington Avenue Local", "8 Avenue Express") but there is no line identifier in the feed and no tool takes one. When someone asks "what's happening on the Lexington line this weekend," that becomes `get_service_alerts` calls for the 4, 5, 6, and 6X. A line abstraction isn't needed for that phrasing.

### Parent station vs. platform

`stops.txt` carries both, distinguished by `location_type`:

- **Parent station** (`location_type=1`): the station as a rider thinks of it. `628` is 68 St–Hunter College.
- **Platform** (`location_type` empty, with a `parent_station`): one direction, such as `628N` or `628S`.

**The alerts feed emits parent stations only.** In the 2026-09-16 sample: 402 distinct `stop_id` values, zero with an `N`/`S` suffix. Direction, where MTA provides it, arrives separately as `direction_id` on the informed entity (`0` northbound, `1` southbound, **omitted means both**).

`data/stations.json` holds the 496 parent stations. The generator folds platform rows up to their parent when joining route membership, which is why it strips a trailing `N`/`S` before matching.

### Station complex

Several parent stations a rider can transfer between without leaving fare control. In the data they're separate stations. Two naming problems sit next to this idea, and this server handles only the first.

**Same name, several stations.** This one is usually not a complex at all. 193 of 496 parent stations share a name with another, across 76 distinct names. `125 St` is four stations on four unrelated lines: `116` (1), `225` (2/3), `621` (4/5/6/6X), and `A15` (A/B/C/D). `Times Sq-42 St` is four. `14 St` is three. This is why `resolve_station` returns every candidate and never picks, and why the `route_id` filter has to work.

**Different names, linked only by `transfers.txt`.** There are 60 such pairs, including `Times Sq-42 St (127)` ↔ `42 St-Port Authority Bus Terminal (A27)` and `Park Place (228)` ↔ `World Trade Center (E01)`. **We don't model these.** Asking about one name won't surface alerts filed against its connected neighbor. The README documents the gap. We haven't coded around it because BetaNYC's use hasn't needed it.

### MRN (Master Reference Number)

MTA's own internal ids for stations and complexes, used across its data.ny.gov
datasets. **They are not GTFS ids.**

- **Station MRN**: `station_id` in the station dataset (`39hk-dx4f`),
  `station_mrn` in the equipment inventory (`94fv-bak7`).
- **Complex MRN**: `complex_id` in the station dataset, `station_complex_mrn`
  in the inventory.

The inventory zero-pads MRNs (`"026"`) and the station dataset doesn't
(`"26"`). **Compare them as integers.** As strings, 645 of 759 inventory rows
join; as integers, 736. Three station MRNs are two GTFS stations each (W 4 St,
145 St, Queensboro Plaza), so an MRN maps to a list of `stop_id`s.

### Equipment code

MTA's id for one elevator or escalator: `EL433`, `ES258X`. It's `equipment` in
the outage feed and `equipment_code` in the inventory, and it's the only ID the
outage feed gives. Joining it to the inventory, then the inventory's station
MRN to a `stop_id`, is how we place an outage at a station without trusting its
free-text `station` name. See [docs/data-sources.md](docs/data-sources.md#how-they-join).

### ADA status: station vs. complex

MTA publishes accessibility per station (`39hk-dx4f`) and per complex
(`5f5g-n3cz`). **We use per station, always.** In 7 complexes the stations
differ. At 14 St-Union Sq, the L and N/Q/R/W stations are accessible and the
4/5/6 station (`635`) isn't, so a complex-level answer would be wrong for
someone at the 6 platform.

| `ada` | our `status` | means |
|---|---|---|
| `1` | `fully_accessible` | accessible in both directions |
| `2` | `partially_accessible` | accessible in **one direction only**, per `ada_northbound`/`ada_southbound`. All 9 in the 2026-09-22 snapshot. MTA's `ada_notes` can narrow it further ("Uptown local only") |
| `0` | `not_accessible` | no accessible path |

An ADA status is a designation, not a working state. An elevator outage can
make a `fully_accessible` station unusable, and no listed outage doesn't make
it usable. **Never infer station accessibility from elevators:** four
`not_accessible` stations have ADA-compliant elevators in the inventory.

Equipment is coded to one station even inside a complex. The Port Authority
elevator EL290X is coded to 42 St-Port Authority (`A27`), so a `stop_id` query
for Times Sq-42 St (`127`) lists it in `complex_outages`. "Outages at this
station" and "outages in this complex" are different lists, and the tool
returns both.

## Alerts

### Entity

One item in the feed's `entity` array: an `id` plus an `alert`. The 2026-09-16 sample held 150; a 2026-09-17 pull held 199. **The feed is `FULL_DATASET`.** Each fetch is the complete current picture, so there's no state to keep or reconcile between fetches.

Entity IDs come in two shapes:

- `lmm:planned_work:33826`: scheduled work, announced ahead. 149 of 150 in the sample.
- `lmm:alert:267678:26`: a live incident, happening now.

### Informed entity

An entry in `alert.informed_entity[]` saying who the alert is about. Always carries `route_id` and `agency_id` (`"MTASBWY"`); carries `stop_id` only when MTA chose to tag stations, and `direction_id` only sometimes.

**This is the only reliable list of what an alert affects.** See the traps below.

### Active period

`alert.active_period[]`, a list of `{start, end}` epoch-second pairs. Recurring weekend work shows up as several periods, so the test is whether any period overlaps the event day. Evaluate that in `America/New_York`. UTC is a different day for four hours every night.

Alongside it, `mercury_alert.human_readable_active_period` carries MTA's own rider-facing phrasing: *"Sep 18 - Oct 19, Fri 9:30 PM to Mon 5:00 AM"*. Use it in anything a person will read. It's MTA's own wording, and it says more than a reformatted timestamp can.

### Alert type, and effect

`mercury_alert.alert_type` is MTA's status string: `"Planned - Part Suspended"`, `"Planned - Express to Local"`, `"Delays"`. **Effect** is ours: what that status means for a rider at a tagged station, defined in `src/mta.ts`.

| effect | means |
|---|---|
| `reduced` | fewer trains, or none |
| `added` / `added_at_local_stops` | **more** service at the tagged stations |
| `changed` | different, not clearly better or worse |
| `delay` | running late |
| `informational` | a notice, not a service change |
| `unknown` | a status string we have never seen |

`unknown` counts as a disruption and applies to every station on the route, not only tagged ones. If we don't know what a status means, we can't trust its station tagging either.

### Mercury

MTA's custom GTFS-Realtime extension, which carries everything above that isn't in the base spec. In protobuf it needs a `.proto` file. **In the `.json` version of the feed, it arrives as ordinary keys** named by their full extension name, such as `"transit_realtime.mercury_alert"` and `"transit_realtime.mercury_entity_selector"`.

That's why this server can stay small. We read the JSON feed and never compile a protobuf.

Six documented Mercury fields never appeared in any live sample: `no_affected_stations`, `clone_id`, `screens_summary`, `directionality`, `service_plan_number`, and `general_order_number`. Don't build on them.

## The traps, in vocabulary terms

**`affected_stations` lists the whole route.** On `lmm:planned_work:33826` ("No 6 between Hunts Point Av and 125 St"), `mercury_alert.affected_stations` lists 32 stations, including 68 St–Hunter College, which is nowhere near the suspension. The real impact list is `informed_entity`, which names six stops.

**"Affected" can mean better.** A station tagged by a `Planned - Express to Local` alert is gaining service. Two such alerts tag stop 628 on 2026-09-19, and both mean more trains. The useful question is what the status does to your station, not whether your station is mentioned.

**A station without a tag may still be affected.** MTA tags stations only when it decides a change is significant enough. Its own spec says so:

> "Consumers should not assume that every alert will include Stations Affected data."

So every response includes `station_level_detail`, which reports whether MTA tagged stations at all. `disrupted: false` with `station_level_detail: false` means we found nothing station-specific. It doesn't mean your station is fine.

## Data sources

| What | Where | Notes |
|---|---|---|
| Subway service alerts | `api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json` | No key. Published at [api.mta.info](https://api.mta.info/#/serviceAlerts) |
| Elevator/escalator outages | `…/nyct%2Fnyct_ene.json`, `…/nyct%2Fnyct_ene_upcoming.json` | Flat JSON arrays, not GTFS-RT. `station` is free text rather than a `stop_id` |
| Static GTFS | `rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip` | Build-time only, via `scripts/update-stations.mjs`. Never fetched at runtime |
| Station ADA status | data.ny.gov `39hk-dx4f` | Build-time only, via `scripts/update-accessibility-data.mjs`, into `data/station_ada.json`. OPEN-NY terms |
| Elevator and escalator inventory | data.ny.gov `94fv-bak7` | Build-time only, same script, into `data/equipment.json`. Asset list, not outage status. OPEN-NY terms |
| MTA's own feed documentation | [github.com/nymta/gtfs-documentation](https://github.com/nymta/gtfs-documentation) | Sparse, and doesn't always match the live feed. See the README on the entity-id status rank |
| Terms | [mta.info/developers/terms-and-conditions](https://www.mta.info/developers/terms-and-conditions) | Why this is not on npm: [docs/terms-compliance.md](docs/terms-compliance.md) |

All of it, with join coverage and terms: [docs/data-sources.md](docs/data-sources.md).

Nothing here needs an API key. Bus Time, for live bus positions and arrivals, is the one MTA product that needs an account, and it's out of scope.
