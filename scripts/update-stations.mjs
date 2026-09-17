#!/usr/bin/env node
// Regenerates data/stations.json — the bundled subway station list that
// resolve_station and check_route_on_date match free text against, with the
// routes serving each station.
//
// Why a bundled file at all: runtime must make ZERO network calls for station
// lookup. That removes a fetch (politeness, see README "Responsible use") and
// kills a whole class of bug. A prior BetaNYC session wrote stop_id 629 for
// "68 St-Hunter College" into a finished report; 629 is 59 St and 628 is
// 68 St-Hunter College. The answer still came out right, so the error survived
// review. A committed, generated file with a regeneration command is the fix.
//
// Why routes are joined in here rather than at runtime: 76 of 496 parent
// stations share a stop_name with at least one other parent station. "125 St"
// is FOUR different stations — 116 (1), 225 (2/3), 621 (4/5/6/6X) and A15
// (A/B/C/D) — so a bare name lookup is a 1-in-4 guess. The route each station
// serves is the disambiguator, and it is not in stops.txt.
//
// Usage:
//   node scripts/update-stations.mjs                # download the official zip
//   node scripts/update-stations.mjs --from-zip P   # use a local gtfs_subway.zip
//
// Source: https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip, linked from
// https://www.mta.info/developers ("Subway, regular; typically updated a few
// times a year"). This is a maintenance script, not runtime — it may shell out.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const GTFS_SUBWAY_ZIP_URL =
  "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip";

const OUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "stations.json"
);

/**
 * Split one CSV record into fields, honoring RFC 4180 double-quoting.
 * stops.txt and trips.txt currently contain no quoted fields, but GTFS permits
 * them (routes.txt in the same zip uses them heavily) and a station name
 * gaining a comma would silently shift every later column.
 */
export function splitCsvLine(line) {
  if (line.indexOf('"') === -1) return line.split(",");
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function columnIndexes(headerLine, wanted, fileName) {
  const header = splitCsvLine(headerLine).map((h) => h.trim());
  return wanted.map((name) => {
    const i = header.indexOf(name);
    if (i === -1) {
      throw new Error(
        `${fileName} is missing the '${name}' column. Columns found: ${header.join(", ")}`
      );
    }
    return i;
  });
}

/**
 * Parse GTFS stops.txt into parent stations plus a platform→parent index.
 *
 * GTFS `location_type` 1 is "Station"; 0/blank is a platform ("Stop") whose
 * `parent_station` names its station. MTA's subway feed models each station as
 * one location_type=1 row plus N/S platform children. The alerts feed emits
 * only parent-station ids (402 distinct in the 2026-09-16 pull, zero with an
 * N/S suffix), while stop_times.txt speaks only platform ids — so the join
 * below needs the parent index, taken from GTFS's own `parent_station` column
 * rather than by stripping a trailing letter off the id.
 * Reference: https://gtfs.org/documentation/schedule/reference/#stopstxt
 */
export function parseStops(stopsTxt) {
  const lines = stopsTxt.split(/\r?\n/).filter((l) => l.length > 0);
  const [idIdx, nameIdx, latIdx, lonIdx, typeIdx, parentIdx] = columnIndexes(
    lines[0],
    ["stop_id", "stop_name", "stop_lat", "stop_lon", "location_type", "parent_station"],
    "stops.txt"
  );

  const stations = [];
  const parentOf = new Map();
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const id = f[idIdx];
    const parent = f[parentIdx];
    parentOf.set(id, parent === "" ? id : parent);
    if (f[typeIdx] !== "1") continue;
    stations.push({
      stop_id: id,
      stop_name: f[nameIdx],
      lat: Number(f[latIdx]),
      lon: Number(f[lonIdx]),
    });
  }
  stations.sort((a, b) => (a.stop_id < b.stop_id ? -1 : a.stop_id > b.stop_id ? 1 : 0));
  return { stations, parentOf };
}

/**
 * Which routes serve each parent station, from trips.txt ⋈ stop_times.txt.
 *
 * trips.txt maps trip_id → route_id; stop_times.txt maps trip_id → platform
 * stop_id; `parentOf` folds the platform back to its station. On the 2026-07-31
 * feed that is 20,621 trips and 565,093 stop_times rows, resolving all 496
 * parent stations.
 *
 * Expect some stations to serve more routes than the line map suggests: 628
 * (68 St-Hunter College) returns 4, 6 and 6X, because the 4 runs local
 * overnight. That is the regular schedule, not a defect.
 */
export function routesByParentStation(tripsTxt, stopTimesTxt, parentOf) {
  const tripLines = tripsTxt.split(/\r?\n/);
  const [tRoute, tTrip] = columnIndexes(tripLines[0], ["route_id", "trip_id"], "trips.txt");
  const routeByTrip = new Map();
  for (let i = 1; i < tripLines.length; i++) {
    if (tripLines[i].length === 0) continue;
    const f = splitCsvLine(tripLines[i]);
    routeByTrip.set(f[tTrip], f[tRoute]);
  }

  const stopLines = stopTimesTxt.split(/\r?\n/);
  const [sTrip, sStop] = columnIndexes(stopLines[0], ["trip_id", "stop_id"], "stop_times.txt");
  const routes = new Map();
  for (let i = 1; i < stopLines.length; i++) {
    if (stopLines[i].length === 0) continue;
    const f = splitCsvLine(stopLines[i]);
    const route = routeByTrip.get(f[sTrip]);
    if (route === undefined) continue;
    const parent = parentOf.get(f[sStop]) ?? f[sStop];
    let set = routes.get(parent);
    if (set === undefined) {
      set = new Set();
      routes.set(parent, set);
    }
    set.add(route);
  }
  return routes;
}

function extractZip(zipPath) {
  const dir = mkdtempSync(join(tmpdir(), "mta-gtfs-"));
  try {
    execFileSync(
      "unzip",
      ["-o", "-q", zipPath, "stops.txt", "trips.txt", "stop_times.txt", "-d", dir],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    return {
      stops: readFileSync(join(dir, "stops.txt"), "utf8"),
      trips: readFileSync(join(dir, "trips.txt"), "utf8"),
      stopTimes: readFileSync(join(dir, "stop_times.txt"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function downloadZip() {
  const dir = mkdtempSync(join(tmpdir(), "mta-gtfs-dl-"));
  const zip = join(dir, "gtfs_subway.zip");
  execFileSync("curl", ["-fsSL", "-o", zip, GTFS_SUBWAY_ZIP_URL], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  return { zip, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function main(argv) {
  const fromIdx = argv.indexOf("--from-zip");
  const localZip = fromIdx !== -1 ? argv[fromIdx + 1] : null;
  if (fromIdx !== -1 && !localZip) {
    throw new Error("--from-zip requires a path to a gtfs_subway.zip");
  }

  let zipPath = localZip;
  let cleanup = () => {};
  if (!zipPath) {
    const dl = downloadZip();
    zipPath = dl.zip;
    cleanup = dl.cleanup;
  }

  let payload;
  try {
    const { stops, trips, stopTimes } = extractZip(zipPath);
    const { stations, parentOf } = parseStops(stops);
    const routes = routesByParentStation(trips, stopTimes, parentOf);

    const withRoutes = stations.map((s) => ({
      ...s,
      routes: [...(routes.get(s.stop_id) ?? [])].sort(),
    }));
    const missing = withRoutes.filter((s) => s.routes.length === 0).map((s) => s.stop_id);

    payload = {
      generated_at: new Date().toISOString(),
      source_url: GTFS_SUBWAY_ZIP_URL,
      source_files: ["stops.txt", "trips.txt", "stop_times.txt"],
      generated_from: localZip ? `local zip: ${localZip}` : "downloaded zip",
      filter: "location_type=1 (GTFS parent stations)",
      // resolve_station reads this flag and refuses route_id filtering when it
      // is false, rather than ignoring the parameter and answering a different
      // question than the one asked.
      route_membership: true,
      stations_without_routes: missing,
      count: withRoutes.length,
      stations: withRoutes,
    };
    if (missing.length > 0) {
      process.stderr.write(
        `Warning: ${missing.length} parent stations resolved no routes: ${missing.join(", ")}\n`
      );
    }
  } finally {
    cleanup();
  }

  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`Wrote ${payload.count} stations to ${OUT_PATH}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
