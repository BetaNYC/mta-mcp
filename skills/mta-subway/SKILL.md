---
name: mta-subway
description: Check NYC subway service alerts for a date and station, look up stations and whether MTA lists them as accessible, and find elevator or escalator outages with MTA's alternate routes, using MTA's public data. Use when someone asks whether a subway line is running normally on a date, whether a station is affected by planned work, what is happening on a line this weekend, which station a name like "125 St" means, or whether elevators are out at a station. Also use before putting subway directions in event copy.
---

# MTA subway alerts

This skill answers subway questions by running a script. The script does the
fetching and the tricky parts, and prints a small JSON answer. Don't fetch
MTA's feeds yourself: the raw alerts feed is about 200,000 tokens, and reading
it by hand runs into the traps below.

## Setup

The script needs a built copy of [BetaNYC/mta-mcp](https://github.com/BetaNYC/mta-mcp).
It looks for one in `MTA_MCP_DIR`, then in the repo the script lives in, then in
`~/Code/mta-mcp`. If the script says the build is missing, tell the user and
show them:

```bash
git clone https://github.com/BetaNYC/mta-mcp.git ~/Code/mta-mcp && cd ~/Code/mta-mcp && npm install
```

No API key is needed.

## How to run it

```bash
node scripts/mta.mjs <tool> '<json args>'
node scripts/mta.mjs --help      # every tool and parameter
```

Run it from this skill's folder, or use the full path to `scripts/mta.mjs`.

| Question | Tool | Example args |
|---|---|---|
| Is this route disrupted on this date, at this station? | `check_route_on_date` | `'{"route_id":"6","date":"2026-09-26","station":"68 St-Hunter College"}'` |
| What's going on with a route on a date? | `get_service_alerts` | `'{"route_id":"6","date":"2026-09-26"}'` |
| Which station does this name mean? | `resolve_station` | `'{"query":"125 St","route_id":"6"}'` |
| Are any elevators or escalators out now? | `get_accessibility_outages` | `'{"station":"Jamaica-179 St"}'` |
| Any elevator work scheduled? | `get_accessibility_outages` | `'{"station":"Jamaica-179 St","upcoming":true}'` |
| Any outages on this date? | `get_accessibility_outages` | `'{"stop_id":"F01","date":"2026-09-28"}'` |
| Route check plus elevators at the station | `check_route_on_date` | `'{"route_id":"F","date":"2026-09-28","stop_id":"F01","include_accessibility":true}'` |
| Is this station accessible? | `resolve_station` | `'{"query":"86 St","route_id":"6"}'` |

- Dates are `YYYY-MM-DD`, in New York time.
- `route_id` is how MTA writes the route: `"6"`, `"A"`, `"SI"`. The diamond 6
  is `"6X"`, and the 7 express is `"7X"`.
- A "line" is several routes. For "the Lexington Avenue line," check the 4, 5,
  6, and 6X one at a time.
- Pass a `route_id`. Without one, `get_service_alerts` returns every alert on
  every route, about 20,000 tokens on 2026-09-22.

## Reading the answer

Check these before you tell anyone a train is fine:

1. **`resolved: false`** means the station name matched more than one station.
   Don't pick one. Show the candidates, or ask which route they mean and rerun
   with `route_id`.
2. **`station_level_detail: false`** means MTA didn't say which stations an
   alert covers. `disrupted: false` is then not a guarantee. Say so.
3. **`effect: "added_at_local_stops"`** means the station gets *more* trains
   (an express running local). It's listed but isn't a disruption. Don't report
   it as a problem.
4. **A non-empty `unknown_alert_types`** means MTA used a status the script
   doesn't know. It's counted as a disruption to be safe. Mention it.
5. **`human_readable_active_period`** is MTA's own wording for when the work
   happens. Quote it rather than rewriting timestamps.

## Elevators and escalators

`get_accessibility_outages` needs the most care, because a wrong "no outages"
can strand someone who uses a wheelchair.

- **Every station has MTA's ADA status** in `accessibility` (or
  `station_accessibility`): `fully_accessible`, `partially_accessible`, or
  `not_accessible`. For a partial station, lead with MTA's words in
  `mta_notes` ("Manhattan-bound only", "Uptown local only").
  `accessible_direction` is MTA's label for that side. Never say
  "northbound" or "southbound" to a rider.
  It's per station, not per complex: at 14 St-Union Sq the 4/5/6 station is
  not accessible and the others are. It's a dated snapshot, and it says a
  station has an accessible path, not that the path works today. The answer
  says when the snapshot was pulled. If it's old and the answer matters, such
  as event directions, suggest running `npm run accessibility-data` first.
- **No outage isn't proof the station is usable.** Never write "the elevators
  are working." Write what MTA lists, and when you checked.
- **Use `stop_id`.** Rows are then placed by equipment ID from MTA's inventory,
  and each row's `matched_by` says `"equipment id"`, `"name"`, or
  `"partial name"`. Read any `match_note`. Outages elsewhere in the same
  station complex are in `complex_outages`; mention them, since a rider may
  pass through.
- **Alternate routes** are in each row's `inventory.alternative_route`, which
  appears only when you pass `station` or `stop_id`. Quote
  them as MTA's, word for word. MTA keeps them by hand and says they can lag,
  and some describe one past outage. Tell people to confirm on mta.info.
- **In a route check,** pass `include_accessibility: true` with the station to
  get that day's outages in `accessibility_outages`. It costs one more request,
  so only ask when accessibility matters to the question.

- **For an event, pass the date.** `date` returns every outage, in effect now
  or scheduled, whose window overlaps that day. Don't combine it with
  `upcoming: true`; that's an error. Rows whose dates can't be trusted are
  still returned and listed in `date_caveats`. Mention them.
- **Zero results from a name search is not proof.** MTA names stations its
  own way here. The script handles the spellings we've seen, like
  `"Bedford Pk Blvd"`, but new ones can appear. An empty station or route
  search has a `no_match_note`. When you see it, pass `stop_id` instead, or
  try a short, distinctive part of the name (`"Port Authority"`, `"Van Wyck"`)
  and check the `station` and `trainno` of what comes back.
- **Same name, different stations.** Use `stop_id` when you can. Rows that
  belong to a same-named station elsewhere move to `other_station_outages`.
  With a name alone, `"125 St"` can return an outage at a different 125 St,
  so check each row's `inventory.stop_ids` and `trainno`.
- **`route_id`** filters by the row's `trainno`. `6X` counts as `6`, and every
  shuttle (`GS`, `FS`, `H`) counts as `S`, which the feed doesn't tell apart.
- **`ADA: "Y"`** means the elevator is part of the station's accessible path,
  per MTA. An outage on one of these can make the station unusable for
  wheelchair users. Say that plainly.
- **`equipmenttype`** is `EL` for elevator and `ES` for escalator.
- **`serving`** says which part of the station the equipment connects. Quote
  it, since it tells a rider which entrance or platform is affected.
- Point people to
  [MTA's elevator and escalator status page](https://www.mta.info/elevator-escalator-status)
  to confirm before they travel.

## What to tell people

- Every answer is unofficial and may be out of date. Say that riders should
  confirm at [mta.info](https://www.mta.info). This is required by MTA's data
  terms, not just good manners.
- Write "the 6 train," not a route bullet or emoji. MTA's route symbols are
  licensed separately.
- For event copy, give the travel note and the check date, e.g. "As of
  September 22, MTA lists planned work on the 6 that weekend."

## What it can't do

- Next-train times, live arrivals, and bus locations.
- Bus, LIRR, and Metro-North alerts.
- Linking stations with different names that connect underground, such as
  Times Sq-42 St and 42 St-Port Authority. Check each name separately.
- Saying whether a station is usable today. It gives MTA's ADA status and the
  outages MTA lists, and neither one is a guarantee.

## Being polite to MTA

The script caches each feed on disk for 60 seconds and makes at most one
request per second. Several questions in a row reuse one download. Don't loop
over dates or stations faster than you need to, and never run it on a schedule.
