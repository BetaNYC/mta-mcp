# Elevators, escalators, and accessibility

This page covers `get_accessibility_outages`: what it can tell you, how to read
it, and where it falls short. Please read the gaps section before telling
anyone a station is accessible. A wrong "no outages" can leave a wheelchair
user at a station with no way to reach the platform.

Everything here was checked against the code in `src/` and against the saved
feed in `test/fixtures/` (pulled 2026-09-17), unless it says otherwise.

## What it answers

- Which elevators and escalators are out of service right now.
- Which outages MTA has scheduled for the future.
- Which outages, current or scheduled, overlap one date.
- Any of those for one station, by name or by `stop_id`, or for one route.

## What it doesn't answer

- **Whether a station is accessible at all.** MTA publishes that separately.
  See [Gaps](#gaps).
- **What to do instead.** MTA's equipment feed has an alternate route for each
  elevator. This tool doesn't read it yet.
- **Whether an elevator will really be back when MTA says.** The dates are
  MTA's estimates.
- **Anything outside the subway.** No LIRR, Metro-North, or bus data.

For all of these, [MTA's elevator and escalator status page](https://www.mta.info/elevator-escalator-status)
is the official source.

## Where the data comes from

Two MTA feeds, neither needing a key:

| Feed | Returned when | What's in it |
|---|---|---|
| `nyct%2Fnyct_ene.json` | `upcoming: false` (the default), or any `date` | Outages in effect now, plus scheduled ones |
| `nyct%2Fnyct_ene_upcoming.json` | `upcoming: true` | Scheduled outages only |

The two overlap. In the saved feed, the current feed had 126 rows: 79 in effect
now and 47 flagged `isupcomingoutage: "Y"`. The upcoming feed had exactly those
47. So `upcoming: false` reads the current feed and removes the 47, and
`upcoming: true` reads the upcoming feed. Each outage shows up in one answer or
the other, never both.

A `date` query reads only the current feed and keeps all 126 rows, then filters
by date. That's one request instead of two. It relies on the current feed
containing every scheduled outage. We counted that in our saved copy of both
feeds, but MTA doesn't document it, and every date answer's `feed_note` says
so. If MTA ever splits the feeds apart, a date query would miss
scheduled outages. A fresh pull that shows upcoming rows missing from the
current feed is the sign to change this.

Unlike the service alerts, these feeds are plain lists, not GTFS-realtime. Each
row names its station in free text rather than with a `stop_id`, and that's
the root of most of the problems below.

## Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `station` | string | none | Station name as free text, matched loosely |
| `stop_id` | string | none | GTFS parent-station id. The tool looks up its name in the station list, matches that name loosely, and sets aside rows on routes the station doesn't serve |
| `route_id` | string | none | Only rows whose `trainno` includes this route. See [Routes](#routes) |
| `date` | string | none | `YYYY-MM-DD`. Outages in effect now or scheduled whose window overlaps that day in New York time. See [Dates](#dates) |
| `upcoming` | boolean | `false` | `false` for outages in effect now, `true` for scheduled ones |

All filters combine. With none, you get every outage in the feed.

`date` and `upcoming: true` can't be used together. A date query already
covers outages in effect now and scheduled ones, so honoring `upcoming: true`
as well would mean ignoring one of them. `upcoming: false` is the default and
is accepted with `date`.

An unknown `stop_id` and a badly formatted `date` return an error rather than
an empty list.

## The answer

```json
{
  "upcoming": false,
  "date": null,
  "feed_url": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json",
  "query": "Port Authority",
  "stop_id": null,
  "route_id": null,
  "route_tokens_matched": null,
  "route_note": null,
  "matched_by": "station name, matched loosely — ...",
  "outage_count": 2,
  "rows_in_feed": 79,
  "rows_without_station": 0,
  "feed_note": "Outages in effect now. ...",
  "no_match_note": null,
  "date_caveats": null,
  "outages": [
    {
      "station": "42St/Port Authority-Bus Terminal",
      "borough": "",
      "trainno": "A/C/E/N/Q/R/W/1/2/3/7/S",
      "equipment": "EL290X",
      "equipmenttype": "EL",
      "serving": "...",
      "ADA": "Y",
      "outagedate": "...",
      "estimatedreturntoservice": "...",
      "reason": "...",
      "isupcomingoutage": "N",
      "ismaintenanceoutage": "N"
    }
  ],
  "other_station_outages": null,
  "fetched_at": "...",
  "may_not_be_realtime": true,
  "staleness_note": "...",
  "data_source": "...",
  "disclaimer": "Unofficial. ..."
}
```

| Field | Meaning |
|---|---|
| `upcoming` | Which of the two feeds this answer came from. `null` for a date query |
| `date` | The date you asked about, or `null` |
| `feed_url` | The exact MTA feed read |
| `query` | The name that was matched. With `stop_id`, this is that station's GTFS name |
| `stop_id` | The `stop_id` you passed, or `null` |
| `route_id` | The `route_id` you passed, or `null` |
| `route_tokens_matched` | The `trainno` values that counted as your route, like `["6X", "6"]`. `null` with no `route_id` |
| `route_note` | A warning when your route matched `S`, since the feed doesn't say which shuttle. Otherwise `null` |
| `matched_by` | Says the match was by name, and why. `null` if you didn't filter by station |
| `outage_count` | Outages returned in `outages` |
| `rows_in_feed` | Rows read from the feed before any filter. For `upcoming: false`, that's after removing the scheduled rows |
| `feed_note` | Which kind of outage this answer covers |
| `no_match_note` | When a station or route search returns nothing, why that isn't proof of no outage and what to try next. `null` otherwise |
| `rows_without_station` | With a station search, how many returned rows had no `station` name and were kept because they can't be ruled out. `null` without one |
| `date_caveats` | For a date query, the returned rows whose dates couldn't be trusted, with the reason. See [Dates](#dates). `null` with no `date` |
| `outages` | MTA's rows, unchanged. When filtered by name, best matches come first. The example above shows one of the two |
| `other_station_outages` | With `stop_id`, rows that matched the name but whose `trainno` shares no route with the station. Probably a different station with the same name, but listed so nothing is hidden. `null` without `stop_id` |

Every answer also carries the provenance fields described in
[docs/tools.md](tools.md#provenance-on-every-answer). `feed_timestamp` is
always `null` here, because these feeds don't include one.

### MTA's fields, row by row

The tool passes MTA's rows through unchanged, with MTA's field names. MTA's
[developer page for these feeds](https://www.mta.info/developers/display-elevators-NYCT)
defines only one of them, `ADA`. The rest are described from what we see in the
data, and marked that way.

| Field | Meaning | Source |
|---|---|---|
| `ADA` | `"Y"` if the elevator is part of the station's accessible path. In MTA's words, it shows "if an elevator is part of an accessible pathway." An outage with `"Y"` can make the station unusable for someone who can't use stairs | MTA |
| `station` | Station name, in MTA's spelling for this feed, which doesn't always match the station list | Observed |
| `trainno` | Routes at the station, slash-separated, like `"B/D"` or `"A/C/E/L"`. Sometimes includes other services, like `LIRR`. Never an express or shuttle id like `6X` or `GS` | Observed |
| `equipment` | MTA's id for the elevator or escalator, like `"EL433"` | Observed |
| `equipmenttype` | `"EL"` for elevator, `"ES"` for escalator | Observed |
| `serving` | Which parts of the station it connects, like `"mezzanine to Manhattan-bound platform"` or a street corner. This is the most useful field for a rider | Observed |
| `outagedate` | When the outage started or starts, as `MM/DD/YYYY hh:mm:ss AM`. The time zone isn't stated. The tool passes it through unchanged, and reads it as New York time for `date` | Observed |
| `estimatedreturntoservice` | MTA's estimate for the fix, same format. An estimate, not a promise | Observed |
| `reason` | Free text. Seen values: `Maintenance`, `Capital Replacement`, `Repair`, `Inspection`, `Planned Work`, `Con Edison Power Issue`, `Station is Under Rehabilitation` | Observed |
| `isupcomingoutage` | `"Y"` for a scheduled outage, `"N"` for one in effect | Observed |
| `ismaintenanceoutage` | `"Y"` or `"N"`. Every row in our sample was `"N"`, including rows with `reason: "Maintenance"`, so we don't rely on it | Observed |
| `borough` | Empty in every row we've seen | Observed |

In the saved feed: 81 elevator rows and 45 escalator rows, and 80 rows with
`ADA: "Y"` against 46 with `"N"`.

## How station matching works

Both the query and each row's `station` are lowercased and split into words,
with punctuation removed. Three more rules even out the ways MTA spells
stations in this feed:

- A number glued to letters is split: `42St` becomes `42 st`.
- `pk` becomes `park`. MTA's own station list uses both spellings (`42 St-Bryant
  Pk` and 13 stations with `Park`), so this is applied on both sides.
- `th`, `nd`, and `rd` right after a number are dropped, so a typed
  `"34th St"` or `"42nd St"` matches. Neither the station list nor the saved
  feed writes an ordinal after a number. `st` stays, since after a number it
  almost always means Street.

So `"42St/Port Authority-Bus Terminal"` becomes
`42 st port authority bus terminal`, the same words as the GTFS name
`42 St-Port Authority Bus Terminal`. Then each row gets a score:

| Score | When |
|---|---|
| 100 | Same words, same order |
| 80 | The row's name starts with your words |
| 60 | Your words appear together somewhere in the row's name |
| 40 | All your words appear, in any order |
| 0 | Otherwise. The row is left out |

Rows scoring above 0 are returned, highest first. These rules apply only to
this tool. `resolve_station` matches GTFS names the way it always has.

In the saved feed there are 58 distinct station names. 55 match a GTFS name
character for character, and 56 word for word under the old matching. With
these rules, all 58 match some GTFS name, though not always the station you
asked about by `stop_id`. See below.

### With a `stop_id`

The tool knows which routes serve that station, so it checks each name match
against the row's `trainno`. A row that shares no route with the station goes
to `other_station_outages`. For example, `stop_id: "A15"` (125 St on the
A/B/C/D) with `date: "2026-09-18"` keeps the `A/C/B/D` row at `125 St` and sets
aside the `1` row, which is the 125 St on Broadway. A row with an empty
`trainno` stays in `outages`, since we can't rule it out. No row in the saved
feed has one.

With a `stop_id`, the tool also matches a row whose name is a shorter form of
the station's GTFS name, like `Court Sq` for `Court Sq-23 St` (`F09`) or
`Cortlandt St` for `WTC Cortlandt` (`138`). Every word of the row's name, other
than street types like `St` and `Av`, has to be in the GTFS name, one of them
has to be something other than a number, and the row's `trainno` has to share a
route with the station. If several stations on that route fit, the closest
name wins: `Cortlandt St` on the 1 goes to `WTC Cortlandt`, not to
`Van Cortlandt Park-242 St`. In the saved feed this finds 3 station names the
plain match missed (Court Sq, Cortlandt St, and South Ferry for `R27`), and
every one of the 126 current-feed rows can be reached from some `stop_id`,
up from 125.

A `station` search doesn't do this, since without a station's routes a shorter
name would match too widely. A row with no `station` at all is kept in every
name search and counted in `rows_without_station`. No row in the saved feed
lacks one.

## Routes

`route_id` keeps rows whose `trainno` includes the route, as a whole value
between slashes, commas, or spaces, so `L` doesn't match `LIRR`. The feed never uses GTFS's
express or shuttle ids, so we map them:

| `route_id` | Matches `trainno` | Basis |
|---|---|---|
| `6X`, `7X`, `FX` | `6`, `7`, `F` | The express stops at its local's stations. None of the 126 rows says `6X`, `7X`, or `FX` |
| `GS` | `S` | Observed. All 6 rows with `S` are at Times Sq-42 St, Grand Central-42 St, and 42St/Port Authority, the 42 St Shuttle and its complex |
| `FS`, `H` | `S` | Not observed. No row is at a Franklin Av or Rockaway Park Shuttle station. We map them so an outage there isn't missed |

The route id itself always matches too, in case MTA starts using it. Because
`S` doesn't say which shuttle, any route that matches `S` gets a `route_note`,
and `FS` or `H` will return the 42 St rows as well. Check each row's `station`.

## Dates

`outagedate` and `estimatedreturntoservice` look like
`09/16/2026 11:55:00 PM`. All 252 values in the saved current feed have that
shape. MTA doesn't say what time zone they're in. We read them as New York
time, like every other date in this server.

An outage counts for a date if its window, from `outagedate` up to
`estimatedreturntoservice`, overlaps that day in New York time. Returning at
exactly midnight doesn't touch the next day.

Rows are kept, not dropped, when the dates can't be trusted. Each one is listed
in `date_caveats` with one of these:

| `caveat` | When |
|---|---|
| `unparseable_date` | A date is missing or isn't in the shape above |
| `inconsistent_dates` | The return estimate is before the start |
| `estimate_passed` | The estimate had already passed when the feed was fetched, and MTA still listed the outage. We treat it as ongoing with no end. Listed only for dates the original window didn't cover |

The reasoning behind `estimate_passed`: an elevator that was due back last
week and is still in the feed is still out. We don't know how often MTA's feed
lags its estimates live. In the saved feed, pulled September 17, 50 of the 79
in-effect rows were due back on September 17 or 18, so a live answer can carry
several of these.

## Gaps

These are real problems in the current tool. Each one can produce a confident
wrong answer.

### 1. Some stations may still be missed by name

We fixed the spellings we found (see
[How station matching works](#how-station-matching-works)), including
`Cortlandt St` for WTC Cortlandt, which needed a `stop_id` and its routes to
place. Others may appear as the feed changes, and a `station` search by the
full GTFS name still misses a row whose name is shorter, like
`"WTC Cortlandt"`.

Every empty station or route search comes with a `no_match_note`. When it
appears, search again with a short, distinctive part of the name, like
`"Cortlandt"`, and check what comes back. Never report "no outages" from one
search.

### 2. Same name, different station, by name alone

A search by `station` doesn't know which routes you mean. `"125 St"` can
return an outage at any of four stations. Use `stop_id`, which sets aside rows
on other routes, or `route_id`, and check each row's `trainno`.

### 3. The dates are MTA's estimates

A date query tells you what MTA's feed says for that day. An outage that
starts later than MTA planned, or runs long without the feed catching up,
won't show. For a date more than a few days out, check again closer to it.

### 4. No station accessibility

MTA's station data has an `ADA` column for every station, where 0 means not
accessible, 1 fully accessible, and 2 partially accessible (per MTA's
developer page). The bundled station list doesn't include it, so this server
can't tell you whether a station is accessible to begin with. A station with
no elevator at all has no elevator outages, and this tool would show it as
clear.

### 5. No alternate routes

MTA's separate equipment feed lists each elevator's alternate route for when
it's out, and a short display name. MTA says to connect the two feeds by
equipment number. This server doesn't read that feed yet.

### 6. Service alerts and elevator outages are separate

`check_route_on_date` doesn't look at elevators. A route can show
`disrupted: false` at a station whose only elevator is out. For accessible
event directions, run both tools.

## Checking accessible directions for an event

1. `check_route_on_date` for each route you're recommending, with the station
   and date.
2. `get_accessibility_outages` with the station's `stop_id` and the event
   `date`.
3. If `no_match_note` appears, search again with a short part of the name.
4. For each row, check `trainno` is the right station and note whether `ADA`
   is `"Y"`. Look at `date_caveats` and `other_station_outages` too.
5. Confirm on [mta.info](https://www.mta.info/elevator-escalator-status), which
   also says whether the station is accessible at all.
6. In the copy, name the station and entrance, say when you checked, and tell
   people to confirm before they travel.

## Accessibility of this project itself

MTA's alerts page shows route names as images, so a screen reader or a
copy-paste loses which train an alert is about. This server returns routes as
text (`"6"`, `"A"`), and quotes MTA's `header_text`, which writes routes as
`[6]`. Answers work with a screen reader and paste cleanly into email.
