#!/usr/bin/env node
// Regenerates the two bundled accessibility snapshots:
//
//   data/station_ada.json  each station's ADA status, from data.ny.gov 39hk-dx4f
//                          ("MTA Subway Stations"), keyed by GTFS stop_id
//   data/equipment.json    every subway elevator and escalator, from data.ny.gov
//                          94fv-bak7 ("MTA Subway Elevator and Escalator Asset
//                          Inventory"), with the GTFS stop_id(s) it sits at and
//                          MTA's alternate route for when it is out
//
// Like data/stations.json, these are generated here and read from disk at
// runtime. The server never calls data.ny.gov. This is a maintenance script.
//
// Usage:
//   node scripts/update-accessibility-data.mjs              # two Socrata requests
//   node scripts/update-accessibility-data.mjs --from-dir D # D/39hk-dx4f.json and
//                                                           # D/94fv-bak7.json, saved
//                                                           # from the same URLs
//
// Field names below are the Socrata API names in each dataset's column
// metadata (https://data.ny.gov/api/views/<id>.json), read on 2026-09-22.
// The join rules are from the research note in the BetaNYC workspace,
// people/noel/projects/mta-mcp/research/2026-09-22-mta-accessibility-data-sources.md,
// and every count the script prints is recomputed from the data it just read.
//
// Terms: both datasets are published on data.ny.gov under the OPEN-NY Terms of
// Use (https://data.ny.gov/dataset/OPEN-NY-Terms-Of-Use/77gx-ii52). That is a
// different document from MTA's feed terms, which cover the live feeds. See
// docs/data-sources.md.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "..", "data");

// $select, $order and $limit are standard SoQL parameters
// (https://dev.socrata.com/docs/queries/). $limit is set well above the row
// counts (496 and 759 on 2026-09-22), and the script refuses to write a file if
// a response reaches it, since that would mean rows were cut off.
const ROW_LIMIT = 5000;

export const STATIONS_DATASET = {
  id: "39hk-dx4f",
  name: "MTA Subway Stations",
  page_url: "https://data.ny.gov/Transportation/MTA-Subway-Stations/39hk-dx4f",
  api_url: "https://data.ny.gov/resource/39hk-dx4f.json",
  fields: [
    "gtfs_stop_id",
    "station_id",
    "complex_id",
    "stop_name",
    "ada",
    "ada_northbound",
    "ada_southbound",
    "ada_notes",
    "north_direction_label",
    "south_direction_label",
  ],
  order: "gtfs_stop_id",
};

export const EQUIPMENT_DATASET = {
  id: "94fv-bak7",
  name: "MTA Subway Elevator and Escalator Asset Inventory",
  page_url: "https://data.ny.gov/d/94fv-bak7",
  api_url: "https://data.ny.gov/resource/94fv-bak7.json",
  fields: [
    "equipment_code",
    "elevator_or_escalator",
    "station_mrn",
    "station_complex_mrn",
    "station_description",
    "ada_compliant",
    "notes",
    "redundant_elevator",
    "alternative_route",
  ],
  order: "equipment_code",
};

const TERMS = {
  name: "OPEN-NY Terms of Use",
  url: "https://data.ny.gov/dataset/OPEN-NY-Terms-Of-Use/77gx-ii52",
};

export function queryUrl(dataset) {
  const params = new URLSearchParams({
    $select: dataset.fields.join(","),
    $order: dataset.order,
    $limit: String(ROW_LIMIT),
  });
  return `${dataset.api_url}?${params}`;
}

/**
 * An MRN as an integer. 94fv-bak7 zero-pads station_mrn ("026") and 39hk-dx4f
 * does not ("26"), so a string join matches 645 of 759 rows instead of 736.
 * Anything that is not a whole number is treated as missing.
 */
export function mrn(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

/** 39hk-dx4f writes ada as "0", "1" or "2", and the directions as "0" or "1". */
function code(value, allowed, field, stopId) {
  const n = Number(value);
  if (!allowed.includes(n)) {
    throw new Error(`39hk-dx4f row ${stopId}: ${field} is '${value}', expected one of ${allowed.join(", ")}.`);
  }
  return n;
}

const text = (value) => {
  if (value === undefined || value === null) return null;
  const t = String(value).trim();
  return t === "" ? null : t;
};

/**
 * One record per GTFS stop_id, checked against data/stations.json.
 *
 * Station level, never complex level. In 7 complexes the stations have
 * different ada values, and 14 St-Union Sq is the example that matters: L03
 * and R20 are accessible, 635 (the 4/5/6) is not.
 */
export function buildStationAda(rows, stations) {
  const seen = new Set();
  const records = rows.map((row) => {
    const stopId = text(row.gtfs_stop_id);
    if (!stopId) throw new Error(`39hk-dx4f row without gtfs_stop_id: ${JSON.stringify(row)}`);
    if (seen.has(stopId)) throw new Error(`39hk-dx4f has gtfs_stop_id ${stopId} twice.`);
    seen.add(stopId);
    return {
      stop_id: stopId,
      station_mrn: mrn(row.station_id),
      complex_mrn: mrn(row.complex_id),
      ada: code(row.ada, [0, 1, 2], "ada", stopId),
      ada_northbound: code(row.ada_northbound, [0, 1], "ada_northbound", stopId),
      ada_southbound: code(row.ada_southbound, [0, 1], "ada_southbound", stopId),
      ada_notes: text(row.ada_notes),
      north_direction_label: text(row.north_direction_label),
      south_direction_label: text(row.south_direction_label),
    };
  });
  records.sort((a, b) => (a.stop_id < b.stop_id ? -1 : a.stop_id > b.stop_id ? 1 : 0));

  const ours = new Set(stations.map((s) => s.stop_id));
  const nameById = new Map(stations.map((s) => [s.stop_id, s.stop_name]));
  const nameDiffers = rows
    .filter((row) => nameById.has(text(row.gtfs_stop_id)) && nameById.get(text(row.gtfs_stop_id)) !== text(row.stop_name))
    .map((row) => text(row.gtfs_stop_id));
  const missing = [...ours].filter((id) => !seen.has(id)).sort();
  const extra = records.map((r) => r.stop_id).filter((id) => !ours.has(id));

  const byAda = { 0: 0, 1: 0, 2: 0 };
  for (const r of records) byAda[r.ada] += 1;

  // What "partially accessible" means in this snapshot. MTA's column notes say
  // ada_notes names "the direction a station is accessible in if it is only
  // accessible in one direction". We count rather than assume.
  const partial = records.filter((r) => r.ada === 2);
  const oneDirection = partial.filter((r) => r.ada_northbound + r.ada_southbound === 1);
  const inconsistent = records
    .filter(
      (r) =>
        (r.ada === 1 && (r.ada_northbound !== 1 || r.ada_southbound !== 1)) ||
        (r.ada === 0 && (r.ada_northbound !== 0 || r.ada_southbound !== 0))
    )
    .map((r) => r.stop_id);

  return {
    records,
    summary: {
      stations_in_stations_json: ours.size,
      matched: records.length - extra.length,
      missing_from_dataset: missing,
      not_in_stations_json: extra,
      stop_name_differs_from_stations_json: nameDiffers,
      ada_counts: { not_accessible: byAda[0], fully_accessible: byAda[1], partially_accessible: byAda[2] },
      partially_accessible_one_direction_only: oneDirection.length,
      directional_flags_disagree_with_ada: inconsistent,
    },
  };
}

/**
 * One record per equipment_code, with the GTFS stop_id(s) it sits at.
 *
 * The join is station_mrn -> 39hk-dx4f.station_id -> gtfs_stop_id, compared
 * as integers. Three MRNs map to two GTFS ids each (W 4 St, 145 St, and
 * Queensboro Plaza), so stop_ids is a list. Rows with no station MRN are kept
 * with an empty list. Most are yard and shop elevators, but not all: EL787
 * and EL788 are street elevators at New Dorp on the Staten Island Railway.
 */
export function buildEquipment(rows, adaRecords) {
  const stopIdsByMrn = new Map();
  for (const r of adaRecords) {
    if (r.station_mrn === null) continue;
    const list = stopIdsByMrn.get(r.station_mrn) ?? [];
    list.push(r.stop_id);
    stopIdsByMrn.set(r.station_mrn, list);
  }

  const seen = new Set();
  const records = rows.map((row) => {
    const codeValue = text(row.equipment_code);
    if (!codeValue) throw new Error(`94fv-bak7 row without equipment_code: ${JSON.stringify(row)}`);
    if (seen.has(codeValue)) throw new Error(`94fv-bak7 has equipment_code ${codeValue} twice.`);
    seen.add(codeValue);
    const stationMrn = mrn(row.station_mrn);
    return {
      equipment_code: codeValue,
      elevator_or_escalator: text(row.elevator_or_escalator),
      station_mrn: stationMrn,
      station_complex_mrn: mrn(row.station_complex_mrn),
      stop_ids: stationMrn === null ? [] : [...(stopIdsByMrn.get(stationMrn) ?? [])].sort(),
      station_description: text(row.station_description),
      ada_compliant: text(row.ada_compliant),
      notes: text(row.notes),
      redundant_elevator: text(row.redundant_elevator),
      alternative_route: text(row.alternative_route),
    };
  });
  records.sort((a, b) =>
    a.equipment_code < b.equipment_code ? -1 : a.equipment_code > b.equipment_code ? 1 : 0
  );

  const unresolved = records.filter((r) => r.stop_ids.length === 0);
  const elevators = records.filter((r) => r.elevator_or_escalator === "Elevator");
  return {
    records,
    summary: {
      rows: records.length,
      elevators: elevators.length,
      escalators: records.filter((r) => r.elevator_or_escalator === "Escalator").length,
      resolved_to_stop_id: records.length - unresolved.length,
      unresolved: unresolved.map((r) => r.equipment_code),
      stations_reached: new Set(records.flatMap((r) => r.stop_ids)).size,
      elevators_with_alternative_route: elevators.filter((r) => r.alternative_route !== null).length,
    },
  };
}

/**
 * JSON with one record per line: small enough to commit, and a refresh shows
 * up in a diff as the records that actually changed.
 */
export function serialize(header, key, records) {
  const head = JSON.stringify(header, null, 2).replace(/\n}$/, "");
  const body = records.map((r) => `    ${JSON.stringify(r)}`).join(",\n");
  return `${head},\n  "${key}": [\n${body}\n  ]\n}\n`;
}

async function fetchRows(dataset) {
  const url = queryUrl(dataset);
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "mta-mcp data generator (+https://github.com/BetaNYC/mta-mcp)",
    },
  });
  if (!res.ok) {
    throw new Error(`data.ny.gov returned ${res.status} ${res.statusText} for ${url}`);
  }
  return { rows: await res.json(), from: url, pulledAt: new Date().toISOString() };
}

function readRows(dir, dataset) {
  const path = join(dir, `${dataset.id}.json`);
  // Record the query the file was saved from, not a path on one machine.
  return {
    rows: JSON.parse(readFileSync(path, "utf8")),
    from: `saved response of ${queryUrl(dataset)}`,
    // The file's modification time, which is when it was saved.
    pulledAt: statSync(path).mtime.toISOString(),
  };
}

function checkLimit(dataset, rows) {
  if (!Array.isArray(rows)) throw new Error(`${dataset.id}: expected a JSON array of rows.`);
  if (rows.length >= ROW_LIMIT) {
    throw new Error(
      `${dataset.id} returned ${rows.length} rows, the $limit. Rows may be missing; raise ROW_LIMIT and run again.`
    );
  }
}

function source(dataset, from, pulledAt) {
  return {
    data_pulled_at: pulledAt,
    dataset_id: dataset.id,
    name: dataset.name,
    page_url: dataset.page_url,
    api_url: dataset.api_url,
    fields: dataset.fields,
    generated_from: from,
    terms: TERMS,
  };
}

async function main(argv) {
  const dirIdx = argv.indexOf("--from-dir");
  const dir = dirIdx !== -1 ? argv[dirIdx + 1] : null;
  if (dirIdx !== -1 && !dir) throw new Error("--from-dir needs a directory");

  const stations = JSON.parse(readFileSync(join(DATA_DIR, "stations.json"), "utf8")).stations;

  // One request per dataset, one after the other.
  const st = dir ? readRows(dir, STATIONS_DATASET) : await fetchRows(STATIONS_DATASET);
  checkLimit(STATIONS_DATASET, st.rows);
  const eq = dir ? readRows(dir, EQUIPMENT_DATASET) : await fetchRows(EQUIPMENT_DATASET);
  checkLimit(EQUIPMENT_DATASET, eq.rows);

  const generatedAt = new Date().toISOString();
  const ada = buildStationAda(st.rows, stations);
  const equipment = buildEquipment(eq.rows, ada.records);

  if (ada.summary.missing_from_dataset.length > 0) {
    process.stderr.write(
      `Warning: ${ada.summary.missing_from_dataset.length} stations in stations.json have no ADA row: ${ada.summary.missing_from_dataset.join(", ")}\n`
    );
  }

  writeFileSync(
    join(DATA_DIR, "station_ada.json"),
    serialize(
      {
        generated_at: generatedAt,
        source: source(STATIONS_DATASET, st.from, st.pulledAt),
        ada_codes: {
          0: "not accessible",
          1: "fully accessible",
          2: "partially accessible",
        },
        note: "Station-level ADA status as MTA publishes it. It says whether a station has an accessible path, not whether that path is working today: an elevator outage can make a fully accessible station unusable. MTA updates it 'as needed', so it can lag a newly accessible station.",
        coverage: ada.summary,
        count: ada.records.length,
      },
      "stations",
      ada.records
    )
  );

  writeFileSync(
    join(DATA_DIR, "equipment.json"),
    serialize(
      {
        generated_at: generatedAt,
        source: source(EQUIPMENT_DATASET, eq.from, eq.pulledAt),
        join: "station_mrn, as an integer, to station_mrn in data/station_ada.json (39hk-dx4f station_id), giving stop_ids. Empty stop_ids means the asset has no station MRN.",
        note: "Asset inventory, not outage status. alternative_route, notes and redundant_elevator are maintained by hand, and MTA says hand-populated fields may lag.",
        coverage: equipment.summary,
        count: equipment.records.length,
      },
      "equipment",
      equipment.records
    )
  );

  process.stdout.write(
    `${JSON.stringify({ station_ada: ada.summary, equipment: { ...equipment.summary, unresolved: equipment.summary.unresolved.length } }, null, 2)}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
