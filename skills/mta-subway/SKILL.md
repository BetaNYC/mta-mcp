---
name: mta-subway
description: Check NYC subway service alerts for a date and station, look up stations, and find elevator or escalator outages, using MTA's public feeds. Use when someone asks whether a subway line is running normally on a date, whether a station is affected by planned work, what is happening on a line this weekend, which station a name like "125 St" means, or whether elevators work at a station. Also use before putting subway directions in event copy.
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
| Are the elevators working now? | `get_accessibility_outages` | `'{"station":"Jamaica-179 St"}'` |
| Any elevator work scheduled? | `get_accessibility_outages` | `'{"station":"Jamaica-179 St","upcoming":true}'` |

- Dates are `YYYY-MM-DD`, in New York time.
- `route_id` is how MTA writes the route: `"6"`, `"A"`, `"SI"`. The diamond 6
  is `"6X"`, and the 7 express is `"7X"`.
- A "line" is several routes. For "the Lexington Avenue line," check the 4, 5,
  6, and 6X one at a time.
- Always pass a date. Leaving it off `get_service_alerts` returns every alert on
  every route today, which is about 20,000 tokens.

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

- **Check both current and upcoming.** `upcoming: false` (the default) returns
  outages in effect now. For an event date, also run it with `upcoming: true`
  and compare each row's `outagedate` and `estimatedreturntoservice` to the
  event date yourself. The tool doesn't filter by date.
- **Zero results is not proof.** MTA names stations its own way here, and
  sometimes differently from the station list. `"Bedford Park Blvd"` finds
  nothing, but MTA's row says `"Bedford Pk Blvd"`. Before saying a station has
  no outages, also try a short, distinctive part of the name (`"Bedford"`,
  `"Port Authority"`, `"Van Wyck"`) and check the `station` and `trainno` of
  what comes back.
- **Same name, different stations.** `"125 St"` can return an outage at a
  different 125 St. Check the row's `trainno` against the route you mean.
- **`ADA: "Y"`** means the elevator is part of the station's accessible path,
  per MTA. An outage on one of these can make the station unusable for
  wheelchair users. Say that plainly.
- **`equipmenttype`** is `EL` for elevator and `ES` for escalator.
- **`serving`** says which part of the station the equipment connects. Quote
  it, since it tells a rider which entrance or platform is affected.
- The tool doesn't say whether a station is accessible at all, or suggest an
  alternate route. Point people to
  [MTA's elevator and escalator status page](https://www.mta.info/elevator-escalator-status)
  for that.

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
- Saying whether a station is accessible, or what the alternate route is when
  an elevator is out.

## Being polite to MTA

The script caches each feed on disk for 60 seconds and makes at most one
request per second. Several questions in a row reuse one download. Don't loop
over dates or stations faster than you need to, and never run it on a schedule.
