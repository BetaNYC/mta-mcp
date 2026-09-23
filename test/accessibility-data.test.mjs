import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EQUIPMENT_DATASET,
  STATIONS_DATASET,
  buildEquipment,
  buildStationAda,
  mrn,
  queryUrl,
  serialize,
} from "../scripts/update-accessibility-data.mjs";

// The generator's pure parts, and the committed snapshots it wrote. No request
// to data.ny.gov or to MTA is made here.

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const STATION_ADA = read("../data/station_ada.json");
const EQUIPMENT = read("../data/equipment.json");
const STATIONS = read("../data/stations.json");
const ENE = [...read("./fixtures/nyct_ene.json"), ...read("./fixtures/nyct_ene_upcoming.json")];

test("MRNs compare as integers, so zero-padding can't break the join", () => {
  assert.equal(mrn("026"), 26);
  assert.equal(mrn("26"), 26);
  assert.equal(mrn(""), null);
  assert.equal(mrn(undefined), null);
  assert.equal(mrn("26A"), null);
});

test("buildStationAda keeps directions and notes, and checks coverage", () => {
  const stations = [{ stop_id: "233", stop_name: "Hoyt St" }, { stop_id: "X01", stop_name: "Nowhere" }];
  const { records, summary } = buildStationAda(
    [
      {
        gtfs_stop_id: "233",
        station_id: "336",
        complex_id: "336",
        stop_name: "Hoyt St",
        ada: "2",
        ada_northbound: "0",
        ada_southbound: "1",
        ada_notes: "Outbound only",
        south_direction_label: "Outbound",
      },
    ],
    stations
  );
  assert.deepEqual(records[0], {
    stop_id: "233",
    station_mrn: 336,
    complex_mrn: 336,
    ada: 2,
    ada_northbound: 0,
    ada_southbound: 1,
    ada_notes: "Outbound only",
    north_direction_label: null,
    south_direction_label: "Outbound",
  });
  assert.deepEqual(summary.missing_from_dataset, ["X01"]);
  assert.equal(summary.partially_accessible_one_direction_only, 1);
  assert.throws(
    () => buildStationAda([{ gtfs_stop_id: "233", ada: "3", ada_northbound: "0", ada_southbound: "0" }], stations),
    /ada is '3'/
  );
});

test("buildEquipment maps one MRN to two stop_ids and keeps yard assets unplaced", () => {
  const ada = [
    { stop_id: "A32", station_mrn: 167 },
    { stop_id: "D20", station_mrn: 167 },
  ];
  const { records, summary } = buildEquipment(
    [
      { equipment_code: "EL333", station_mrn: "167", elevator_or_escalator: "Elevator", alternative_route: "Take..." },
      { equipment_code: "EL150", elevator_or_escalator: "Elevator" },
    ],
    ada
  );
  assert.deepEqual(records.find((r) => r.equipment_code === "EL333").stop_ids, ["A32", "D20"]);
  assert.deepEqual(records.find((r) => r.equipment_code === "EL150").stop_ids, []);
  assert.deepEqual(summary.unresolved, ["EL150"]);
  assert.equal(summary.elevators_with_alternative_route, 1);
});

test("serialize writes valid JSON with one record per line", () => {
  const out = serialize({ a: 1 }, "rows", [{ x: 1 }, { x: 2 }]);
  assert.deepEqual(JSON.parse(out), { a: 1, rows: [{ x: 1 }, { x: 2 }] });
  assert.match(out, /\n {4}\{"x":1\},\n {4}\{"x":2\}\n/);
});

test("the generator asks Socrata for named fields, in one request per dataset", () => {
  const url = new URL(queryUrl(STATIONS_DATASET));
  assert.equal(url.origin + url.pathname, "https://data.ny.gov/resource/39hk-dx4f.json");
  assert.equal(url.searchParams.get("$select"), STATIONS_DATASET.fields.join(","));
  assert.equal(url.searchParams.get("$limit"), "5000");
});

// ─── The committed snapshots ─────────────────────────────────────────────────
//
// Field names are pinned here because 94fv-bak7 is young (v1.0.0, 2025-12-23)
// and MTA says its datasets may be restructured. A regenerated file with a
// renamed column fails these instead of quietly dropping data.

test("station_ada.json covers every bundled station and records its source", () => {
  assert.equal(STATION_ADA.source.dataset_id, "39hk-dx4f");
  assert.equal(STATION_ADA.source.terms.name, "OPEN-NY Terms of Use");
  assert.deepEqual(STATION_ADA.source.fields, STATIONS_DATASET.fields);
  assert.ok(!Number.isNaN(Date.parse(STATION_ADA.generated_at)));
  const ids = new Set(STATION_ADA.stations.map((s) => s.stop_id));
  assert.equal(ids.size, STATION_ADA.stations.length);
  for (const s of STATIONS.stations) assert.ok(ids.has(s.stop_id), s.stop_id);
  const counts = STATION_ADA.coverage.ada_counts;
  assert.equal(counts.not_accessible + counts.fully_accessible + counts.partially_accessible, 496);
});

test("equipment.json places every equipment code in the saved outage feeds", () => {
  assert.equal(EQUIPMENT.source.dataset_id, "94fv-bak7");
  assert.deepEqual(EQUIPMENT.source.fields, EQUIPMENT_DATASET.fields);
  const byCode = new Map(EQUIPMENT.equipment.map((e) => [e.equipment_code, e]));
  const codes = [...new Set(ENE.map((r) => r.equipment))];
  assert.equal(codes.length, 122);
  const unplaced = codes.filter((c) => !(byCode.get(c)?.stop_ids.length > 0));
  assert.deepEqual(unplaced, []);
  // Every elevator in the saved feeds has an alternate route in the snapshot.
  const elevators = codes.filter((c) => c.startsWith("EL"));
  assert.deepEqual(elevators.filter((c) => !byCode.get(c).alternative_route), []);
  // stop_ids only ever name stations we know.
  const known = new Set(STATIONS.stations.map((s) => s.stop_id));
  for (const e of EQUIPMENT.equipment) for (const id of e.stop_ids) assert.ok(known.has(id), `${e.equipment_code} -> ${id}`);
});
