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
- Either of those for one station, by name or by `stop_id`.

## What it doesn't answer

- **Whether a station is accessible at all.** MTA publishes that separately.
  See [Gaps](#gaps).
- **What to do instead.** MTA's equipment feed has an alternate route for each
  elevator. This tool doesn't read it yet.
- **Whether an elevator will be out on a given date.** The tool can't filter by
  date. You compare the dates yourself.
- **Anything outside the subway.** No LIRR, Metro-North, or bus data.

For all of these, [MTA's elevator and escalator status page](https://www.mta.info/elevator-escalator-status)
is the official source.

## Where the data comes from

Two MTA feeds, neither needing a key:

| Feed | Returned when | What's in it |
|---|---|---|
| `nyct%2Fnyct_ene.json` | `upcoming: false` (the default) | Outages in effect now, plus scheduled ones |
| `nyct%2Fnyct_ene_upcoming.json` | `upcoming: true` | Scheduled outages only |

The two overlap. In the saved feed, the current feed had 126 rows: 79 in effect
now and 47 flagged `isupcomingoutage: "Y"`. The upcoming feed had exactly those
47. So `upcoming: false` reads the current feed and removes the 47, and
`upcoming: true` reads the upcoming feed. Each outage shows up in one answer or
the other, never both.

Unlike the service alerts, these feeds are plain lists, not GTFS-realtime. Each
row names its station in free text rather than with a `stop_id`, and that's
the root of most of the problems below.

## Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `station` | string | none | Station name as free text, matched loosely |
| `stop_id` | string | none | GTFS parent-station id. The tool looks up its name in the station list, then matches that name loosely |
| `upcoming` | boolean | `false` | `false` for outages in effect now, `true` for scheduled ones |

With no `station` or `stop_id`, you get every outage in the feed.

An unknown `stop_id` returns an error rather than an empty list.

## The answer

```json
{
  "upcoming": false,
  "feed_url": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json",
  "query": "Port Authority",
  "stop_id": null,
  "matched_by": "station name, matched loosely — ...",
  "outage_count": 2,
  "rows_in_feed": 79,
  "feed_note": "Outages in effect now. ...",
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
  "fetched_at": "...",
  "may_not_be_realtime": true,
  "staleness_note": "...",
  "data_source": "...",
  "disclaimer": "Unofficial. ..."
}
```

| Field | Meaning |
|---|---|
| `upcoming` | Which of the two feeds this answer came from |
| `feed_url` | The exact MTA feed read |
| `query` | The name that was matched. With `stop_id`, this is that station's GTFS name |
| `stop_id` | The `stop_id` you passed, or `null` |
| `matched_by` | Says the match was by name, and why. `null` if you didn't filter |
| `outage_count` | Outages returned |
| `rows_in_feed` | Outages in the feed before filtering by station |
| `feed_note` | Which kind of outage this answer covers |
| `outages` | MTA's rows, unchanged. When filtered by name, best matches come first. The example above shows one of the two |

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
| `trainno` | Routes at the station, slash-separated, like `"B/D"` or `"A/C/E/L"`. Sometimes includes other services, like `LIRR` | Observed |
| `equipment` | MTA's id for the elevator or escalator, like `"EL433"` | Observed |
| `equipmenttype` | `"EL"` for elevator, `"ES"` for escalator | Observed |
| `serving` | Which parts of the station it connects, like `"mezzanine to Manhattan-bound platform"` or a street corner. This is the most useful field for a rider | Observed |
| `outagedate` | When the outage started or starts, as `MM/DD/YYYY hh:mm:ss AM`. The time zone isn't stated, and the tool passes it through without converting it | Observed |
| `estimatedreturntoservice` | MTA's estimate for the fix, same format. An estimate, not a promise | Observed |
| `reason` | Free text. Seen values: `Maintenance`, `Capital Replacement`, `Repair`, `Inspection`, `Planned Work`, `Con Edison Power Issue`, `Station is Under Rehabilitation` | Observed |
| `isupcomingoutage` | `"Y"` for a scheduled outage, `"N"` for one in effect | Observed |
| `ismaintenanceoutage` | `"Y"` or `"N"`. Every row in our sample was `"N"`, including rows with `reason: "Maintenance"`, so we don't rely on it | Observed |
| `borough` | Empty in every row we've seen | Observed |

In the saved feed: 81 elevator rows and 45 escalator rows, and 80 rows with
`ADA: "Y"` against 46 with `"N"`.

## How station matching works

Both the query and each row's `station` are lowercased and split into words,
with punctuation removed. `"42St/Port Authority-Bus Terminal"` becomes
`42st port authority bus terminal`. Then each row gets a score:

| Score | When |
|---|---|
| 100 | Same words, same order |
| 80 | The row's name starts with your words |
| 60 | Your words appear together somewhere in the row's name |
| 40 | All your words appear, in any order |
| 0 | Otherwise. The row is left out |

Rows scoring above 0 are returned, highest first.

## Gaps

These are real problems in the current tool. Each one can produce a confident
wrong answer.

### 1. Some stations' outages can't be found by their full name

MTA spells some station names differently in this feed than in the station
list. Checked against the saved feed, 3 of 58 station names didn't match
exactly:

| Station list (GTFS) | This feed | Full name finds it? |
|---|---|---|
| `Bedford Park Blvd` | `Bedford Pk Blvd` | No |
| `42 St-Port Authority Bus Terminal` | `42St/Port Authority-Bus Terminal` | No |
| `Jamaica-Van Wyck` | `Jamaica Van Wyck` | Yes |

Passing the `stop_id` doesn't help, because the tool looks up the GTFS name and
matches that. `stop_id: "A27"` returns zero outages for Port Authority even when
the feed lists two.

**Until this is fixed:** when a search returns nothing, try a short, distinctive
part of the name, like `"Bedford"` or `"Port Authority"`, and check what comes
back. Never report "no outages" from one full-name search.

This is 3 names in one sample. Others may appear as the feed changes.

### 2. Same name, different station

`"125 St"` is four different subway stations. A search for it can return an
outage at any of them, and the tool has no route filter to narrow it. Check
each row's `trainno` against the route you care about.

### 3. No date filter

For an event, you need to know whether an elevator will be out on that day.
The tool returns every scheduled outage, and you compare `outagedate` and
`estimatedreturntoservice` to the date yourself. Run both `upcoming: false` and
`upcoming: true`, since an outage in effect now may still be in effect later.

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
2. `get_accessibility_outages` for the station, once with `upcoming: false` and
   once with `upcoming: true`.
3. If step 2 finds nothing, search again with a short part of the name.
4. For each row, check `trainno` is the right station, `ADA` is `"Y"`, and the
   dates cover your event.
5. Confirm on [mta.info](https://www.mta.info/elevator-escalator-status), which
   also says whether the station is accessible at all.
6. In the copy, name the station and entrance, say when you checked, and tell
   people to confirm before they travel.

## Accessibility of this project itself

MTA's alerts page shows route names as images, so a screen reader or a
copy-paste loses which train an alert is about. This server returns routes as
text (`"6"`, `"A"`), and quotes MTA's `header_text`, which writes routes as
`[6]`. Answers work with a screen reader and paste cleanly into email.
