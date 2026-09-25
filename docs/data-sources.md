# Data sources

Every piece of data this server uses, where it comes from, what it gives us,
how the pieces join, the terms each comes under, and how to refresh it.

There are two kinds. Two MTA feeds, served from three URLs, are read live when
a tool is called. Three snapshots are bundled in `data/` and read from disk, so
they never cost a network request at runtime.

| Source | Publisher | Read | Terms |
|---|---|---|---|
| Subway service alerts | MTA | Live, per tool call | [MTA data feed terms](https://www.mta.info/developers/terms-and-conditions) |
| Elevator and escalator outages | MTA | Live, per tool call | MTA data feed terms |
| Static subway GTFS | MTA | Bundled, `data/stations.json` | MTA data feed terms |
| MTA Subway Stations (`39hk-dx4f`) | MTA, on data.ny.gov | Bundled, `data/station_ada.json` | [OPEN-NY Terms of Use](https://data.ny.gov/dataset/OPEN-NY-Terms-Of-Use/77gx-ii52) |
| MTA Subway Elevator and Escalator Asset Inventory (`94fv-bak7`) | MTA, on data.ny.gov | Bundled, `data/equipment.json` | OPEN-NY Terms of Use |

## The live MTA feeds

### Subway service alerts

- URL: `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json`
- Documentation: [api.mta.info](https://api.mta.info/#/serviceAlerts)
- Format: GTFS-realtime as JSON, with MTA's Mercury extensions.
- Gives us: every planned and live service alert, the routes and stations
  each one names, and when it applies. Used by `check_route_on_date` and
  `get_service_alerts`.
- Refresh: MTA doesn't publish a cadence, and responses carry no cache
  headers. We cache each response for 60 seconds.

### Elevator and escalator outages

- URLs: `…/nyct%2Fnyct_ene.json` (in effect now, plus scheduled) and
  `…/nyct%2Fnyct_ene_upcoming.json` (scheduled only)
- Documentation: [api.mta.info](https://api.mta.info/#/EAndEFeeds) and MTA's
  [developer page for these feeds](https://www.mta.info/developers/display-elevators-NYCT)
- Format: flat JSON arrays, not GTFS-realtime.
- Gives us: each outage's equipment code, a free-text station name, the routes
  at the station, what the equipment connects, and MTA's dates. Used by
  `get_accessibility_outages`, and by `check_route_on_date` when you pass
  `include_accessibility: true`.
- Refresh: not published, as above.

Neither feed needs an API key. The terms for both are
[MTA's data feed terms](https://www.mta.info/developers/terms-and-conditions),
and they are why this server isn't on npm. See
[terms-compliance.md](terms-compliance.md).

## The bundled snapshots

### Static subway GTFS → `data/stations.json`

- Source: `https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip`, linked from
  [mta.info/developers](https://www.mta.info/developers)
- Gives us: the 496 parent stations, their names and coordinates, and the
  routes serving each (joined from `trips.txt` and `stop_times.txt`).
- Refresh: MTA's developer page describes the regular subway GTFS as updated
  a few times a year. Regenerate with `npm run stations`.
- Terms: MTA's data feed terms, since this is one of MTA's own feeds.

### MTA Subway Stations → `data/station_ada.json`

- Dataset: [`39hk-dx4f` on data.ny.gov](https://data.ny.gov/Transportation/MTA-Subway-Stations/39hk-dx4f),
  API `https://data.ny.gov/resource/39hk-dx4f.json`
- MTA's own [developer page](https://www.mta.info/developers/display-elevators-NYCT)
  names this dataset as the source for station accessibility.
- Gives us, per station: `ada` (0 not accessible, 1 fully accessible, 2
  partially accessible), `ada_northbound` and `ada_southbound` (0 or 1),
  `ada_notes`, the direction labels, the station MRN, and the complex MRN.
- Refresh: the dataset page lists its posting frequency as "As needed." The
  dataset's overview PDF, `MTA_SubwayStations_Overview.pdf`, says "ADA, ADA
  Northbound, ADA Southbound, and ADA Notes are adjusted as parts of stations
  or entire stations are made ADA-accessible." So a newly accessible station
  can lag.

On the 2026-09-22 pull, 324 stations are not accessible, 163 fully
accessible, and 9 partially accessible. All 9 partial stations are accessible
in exactly one direction, and MTA's note can narrow that further: 86 St on the
Lexington Avenue line (626) is "Uptown local only."

### Elevator and Escalator Asset Inventory → `data/equipment.json`

- Dataset: [`94fv-bak7` on data.ny.gov](https://data.ny.gov/d/94fv-bak7),
  API `https://data.ny.gov/resource/94fv-bak7.json`
- Gives us, per piece of equipment: `equipment_code`, whether it's an elevator
  or escalator, the station and complex MRNs, `ada_compliant`, `notes`,
  `redundant_elevator` (`"+"` if another elevator provides the same service),
  and `alternative_route`, MTA's directions for when it's out.
- It's an asset list, not outage status. Its `service_status` field is the
  asset's installed state, and we don't use it.
- Refresh: the dataset page lists its posting frequency as "Daily." Its
  overview PDF, `MTA_SubwayElevatorEscalatorAssetInventory_Overview.pdf`, says
  "This dataset refreshes daily, but updates on features that are populated by
  hand may be lagged." `alternative_route` is one of those features, and some
  of its text describes one particular outage. Treat it as MTA's text,
  possibly out of date.
- First released 2025-12-23 (version 1.0.0). Both overview PDFs say the
  dataset "may be restructured and/or combined with other similar datasets in
  the future," so the tests pin the field names we read.

### What the bundled files change

The bundled rows are not copies of MTA's rows. The script keeps only the
fields listed in each file's header, and reshapes them:

- In `data/station_ada.json`, `gtfs_stop_id` becomes `stop_id`, `station_id`
  becomes `station_mrn`, and `complex_id` becomes `complex_mrn`. MRNs become
  integers, and `ada`, `ada_northbound`, and `ada_southbound` become numbers.
  `stop_name` is requested only to check it against `data/stations.json` and
  is dropped.
- In `data/equipment.json`, MRNs become integers, and `stop_ids` is added:
  the GTFS stations each piece of equipment sits at, from the join below.
- Empty strings become `null`, and rows are sorted by id.

Each file's header records the exact query, the time the rows were pulled,
and the terms.

## How they join

```
outage row                    equipment inventory             station data           stations.json
equipment  ────────────────>  equipment_code
                              station_mrn (e.g. "026") ──int──> station_id ("26")
                                                                gtfs_stop_id  ──────>  stop_id
```

Station ADA status joins to our station list directly, on
`gtfs_stop_id` = `stop_id`.

- 496 of 496 stations match, with identical names. None missing, none extra.

Outage rows join to stations through the inventory:

- The outage feed's `equipment` equals the inventory's `equipment_code`. All
  122 distinct codes in our saved outage feed are in the inventory, including
  ones with an `X` suffix like `EL290X`.
- The inventory's `station_mrn` is MTA's Station Master Reference Number,
  the same as `station_id` in the station dataset. The inventory zero-pads it
  (`"026"`) and the station dataset doesn't (`"26"`), so we compare them as
  integers. As strings, 645 of 759 rows join; as integers, 736 do.
- The other 23 have no station MRN. Most are yard, shop, relay-room, and
  power-control elevators, but EL787 and EL788 are street elevators at New
  Dorp on the Staten Island Railway, and four more are described only as
  "3 Landings." An outage on any of these falls back to name matching.
- Three MRNs are two GTFS stations each: W 4 St (A32, D20), 145 St (A12,
  D13), and Queensboro Plaza (R09, 718). So each piece of equipment gets a
  list of `stop_ids`.
- 427 of 481 elevators have an `alternative_route`. No escalator does. All 77
  elevators in our saved outage feed have one.

What that changed, counted against the saved outage feeds (126 current rows,
47 upcoming), asking once for every one of the 496 stations by `stop_id`:

- Every outage row is now placed at a station by equipment ID. Before, rows
  were matched by name only.
- 13 station-row pairings that name matching produced were wrong, and now go
  to `other_station_outages`. For example, `Union St` (R32) no longer picks up
  the 14 St-Union Sq rows, and the Gun Hill Rd and 86 St rows no longer
  appear at the other station with that name.
- 3 pairings are new. `168 St` in the feed is EL113, at
  168 St-Washington Hts (112) on the 1, and two `6 Av` elevators are at the
  14 St stations (D19 and 132).

### Station vs. complex

Both datasets use station level and complex level, and they are not the same
thing. A complex is a group of stations you can transfer between without
leaving fare control, like 14 St-Union Sq (the L, the N/Q/R/W, and the
4/5/6).

We use station-level ADA status on purpose. In 7 complexes, the stations have
different ADA values. At Union Sq, the L and N/Q/R/W stations are accessible
and the 4/5/6 station isn't. A complex-level status, like the one in
data.ny.gov's `5f5g-n3cz`, would tell someone at the 6 platform there's an
accessible path when there isn't.

Equipment belongs to one station in the inventory, even when it serves the
whole complex. The Port Authority elevator EL290X is coded to 42 St-Port
Authority (A27), so a `stop_id` query for Times Sq-42 St (`127`) lists it in
`complex_outages`.

### Where the sources disagree

- Four stations MTA lists as not accessible have an ADA-compliant elevator
  coded to them: 149 St-Hostos (415), 14 St-Union Sq (635), 42 St-Bryant Pk
  (D16), and Fresh Pond Rd (M04). That could be a
  new elevator the station status hasn't caught up with, or an elevator that
  serves a different part of the complex. We report the station's ADA status
  as MTA publishes it, and never infer accessibility from elevators.
- 13 of the 172 stations MTA lists as fully or partially accessible have no
  ADA-compliant elevator in the inventory, at the station or in its complex.
  Six are on the Staten Island Railway, where the inventory has few rows and
  New Dorp's two elevators carry no station MRN. The others are Hoyt St,
  Harlem-148 St, Avenue H, Wilson Av, Canarsie-Rockaway Pkwy,
  Middle Village-Metropolitan Av, and Park Pl. They may be step-free by ramp
  or at street level. We haven't confirmed that.

## Terms

The live feeds and the static GTFS come under
[MTA's data feed terms](https://www.mta.info/developers/terms-and-conditions).
[terms-compliance.md](terms-compliance.md) covers what they require of us.

The two data.ny.gov datasets come under the
[OPEN-NY Terms of Use](https://data.ny.gov/dataset/OPEN-NY-Terms-Of-Use/77gx-ii52),
a separate document from New York State. We read the terms in the PDF
attached to that page, `OPEN-NY_20Terms_20of_20Use.pdf`. What matters here:

- They "do not contain restrictions requiring members of the public to use
  attribution, to re-post the license terms with any re-uses of the data, to
  impose share-alike or technical restrictions, nor require the public to
  obtain pre-approval before re-use of the data."
- "The State grants you a non-exclusive, revocable license to use the
  Content contained on this website in a manner consistent with the Terms of
  Use."
- "Other terms may apply generally to the OPEN-NY website, such as its
  Privacy Policy, or may be imposed specifically on specific Content." Both
  datasets' overview PDFs (`MTA_SubwayStations_Overview.pdf` and
  `MTA_SubwayElevatorEscalatorAssetInventory_Overview.pdf`) say, under
  Limitations of Data Use, "There are no limitations on the data at this
  time."
- Neither dataset declares a license in its Socrata metadata.

Each quote above was checked word for word against the PDFs downloaded from
data.ny.gov on 2026-09-22.

We bundle dated snapshots of both, with the source and pull time in each
file's header. We think that's permitted, and it's the same posture as
`data/stations.json`. It isn't certain. The license can be revoked, and we
haven't found anything saying whether MTA's feed terms also cover MTA data
republished on data.ny.gov. If they do, a stored snapshot served from our own
copy still fits them.

The disclaimer MTA's terms require goes on the ADA status and alternate routes
too. Every answer says it's unofficial and may be out of date.

## Regenerating the snapshots

```bash
npm run stations            # data/stations.json, from MTA's static GTFS zip
npm run accessibility-data  # data/station_ada.json and data/equipment.json
```

`npm run accessibility-data` runs `scripts/update-accessibility-data.mjs`. It
makes two requests to data.ny.gov's Socrata API, one per dataset, one after
the other, each asking for named fields with `$select` and a `$limit` of
5,000. It refuses to write a file if a response reaches that limit, since
rows would be missing. It then checks the result against `data/stations.json`
and prints the coverage counts above.

To rebuild from responses you've already saved, as
`<dir>/39hk-dx4f.json` and `<dir>/94fv-bak7.json`:

```bash
node scripts/update-accessibility-data.mjs --from-dir <dir>
```

After regenerating, run `npm test`. The tests check that every station has an
ADA row, that every equipment code in the saved outage feeds is placed at a
station, and that the field names haven't changed. Review the diff: each
record is on its own line, so a refresh shows only what changed.

There's no schedule. Refresh when you need current data: before relying on an
answer for an event or a publication, or when MTA announces a newly accessible
station. Every answer that uses a snapshot says when it was pulled, so check
that date first.
