// How old the bundled snapshots in data/ are, and what to say about it.
//
// The server never refreshes these files itself (docs/terms-compliance.md), so
// keeping them current is the user's job. Every answer that uses a snapshot
// carries its as-of date, and a warning with the refresh command once the
// snapshot is past its threshold. The server logs the same at startup.

import { EQUIPMENT, STATION_ADA, STATIONS, todayIso } from "./mta.js";

export type SnapshotName = "stations" | "station_ada" | "equipment";

type SnapshotSpec = {
  label: string;
  command: string;
  thresholdDays: number;
  asOf: () => string | undefined;
};

// Thresholds, in days. The two data.ny.gov datasets post "As needed" (ADA
// status) and "Daily" (equipment inventory), so a month-old copy can already
// miss a newly accessible station or a renumbered elevator: 30 days. MTA
// updates the static subway GTFS a few times a year, so a 90-day-old station
// list has missed at most about one release: 90 days.
//
// The as-of date is the pull time each update script writes into the file:
// source.data_pulled_at for the data.ny.gov files, generated_at for the
// station list. Read lazily so a test can swap a file's value.
export const SNAPSHOTS: Record<SnapshotName, SnapshotSpec> = {
  stations: {
    label: "Station list",
    command: "npm run stations",
    thresholdDays: 90,
    asOf: () => STATIONS.generated_at,
  },
  station_ada: {
    label: "Station accessibility data",
    command: "npm run accessibility-data",
    thresholdDays: 30,
    asOf: () => STATION_ADA.source?.data_pulled_at,
  },
  equipment: {
    label: "Elevator and escalator inventory",
    command: "npm run accessibility-data",
    thresholdDays: 30,
    asOf: () => EQUIPMENT.source?.data_pulled_at,
  },
};

export type Freshness = {
  /** New York calendar date of the pull, or null if it can't be read. */
  as_of: string | null;
  age_days: number | null;
  threshold_days: number;
  stale: boolean;
};

const DAY_MS = 86_400_000;

/** Whole days between two YYYY-MM-DD dates, b minus a. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

// YYYY-MM-DD, or a full ISO 8601 timestamp with an explicit zone, as the
// update scripts write it (toISOString). Anything else is unreadable: Date.parse
// alone accepts "pulled 1" and "2026-02-30".
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/** True if y-m-d is a real calendar date (no 2026-02-30). */
function realDate(y: string, m: string, d: string): boolean {
  const t = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return t.getUTCFullYear() === Number(y) && t.getUTCMonth() === Number(m) - 1 && t.getUTCDate() === Number(d);
}

/** New York calendar date of a recorded pull time, or null if unreadable. */
export function parseAsOf(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const date = ISO_DATE.exec(raw);
  // A bare date is already a calendar date.
  if (date) return realDate(date[1], date[2], date[3]) ? raw : null;
  const dt = ISO_DATETIME.exec(raw);
  if (!dt || !realDate(dt[1], dt[2], dt[3])) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? todayIso(new Date(ms)) : null;
}

/**
 * Age of one snapshot. Stale means older than the threshold: a snapshot
 * exactly thresholdDays old is not stale yet. A missing or unreadable date
 * counts as stale, since nothing says the data is current, and so does a date
 * after today, which can only be a bad clock or a hand edit.
 */
export function assessFreshness(
  asOfRaw: string | undefined | null,
  thresholdDays: number,
  nowMs: number
): Freshness {
  const asOf = parseAsOf(asOfRaw);
  const age = asOf === null ? NaN : daysBetween(asOf, todayIso(new Date(nowMs)));
  if (asOf === null || age < 0) {
    return { as_of: null, age_days: null, threshold_days: thresholdDays, stale: true };
  }
  return { as_of: asOf, age_days: age, threshold_days: thresholdDays, stale: age > thresholdDays };
}

/**
 * For an unknown stop_id: the station list's date and how to refresh it. A
 * station missing from an old list is the most likely cause.
 */
export function stationListHint(): string {
  const spec = SNAPSHOTS.stations;
  const f = assessFreshness(spec.asOf(), spec.thresholdDays, clock());
  const when = f.as_of === null ? "has no readable as-of date" : `is from ${f.as_of} (${f.age_days} days old)`;
  return `The bundled station list ${when}. If the station is new or renamed, run \`${spec.command}\` in your mta-mcp folder to refresh.`;
}

/** The warning for some snapshots, or null when none is stale. */
export function snapshotWarning(names: SnapshotName[], nowMs: number): string | null {
  const sentences: string[] = [];
  const commands: string[] = [];
  // A fixed order, whatever order the caller lists them in.
  const ordered = (Object.keys(SNAPSHOTS) as SnapshotName[]).filter((n) => names.includes(n));
  for (const name of ordered) {
    const spec = SNAPSHOTS[name];
    const f = assessFreshness(spec.asOf(), spec.thresholdDays, nowMs);
    if (!f.stale) continue;
    sentences.push(
      f.as_of === null
        ? `${spec.label} has no readable as-of date.`
        : `${spec.label} is from ${f.as_of} (${f.age_days} days old).`
    );
    if (!commands.includes(spec.command)) commands.push(spec.command);
  }
  if (sentences.length === 0) return null;
  const run = commands.map((c) => `\`${c}\``).join(" and ");
  return `${sentences.join(" ")} Run ${run} in your mta-mcp folder to refresh.`;
}

let clock: () => number = () => Date.now();

/** Tests only: pin "now" for snapshot ages. Pass null to restore the real clock. */
export function setSnapshotClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/**
 * Footer fields for a tool answer that used these snapshots: each one's as-of
 * date, always, and a warning once any is past its threshold.
 */
export function snapshotFooter(names: SnapshotName[]) {
  const nowMs = clock();
  const unique = [...new Set(names)];
  const asOf: Partial<Record<SnapshotName, string | null>> = {};
  for (const name of unique) {
    const spec = SNAPSHOTS[name];
    asOf[name] = assessFreshness(spec.asOf(), spec.thresholdDays, nowMs).as_of;
  }
  return {
    snapshot_as_of: asOf,
    snapshot_warning: snapshotWarning(unique, nowMs),
  };
}

/** Lines for the startup log on stderr. */
export function startupNotice(nowMs: number): string[] {
  const names = Object.keys(SNAPSHOTS) as SnapshotName[];
  const lines = names.map((name) => {
    const spec = SNAPSHOTS[name];
    const f = assessFreshness(spec.asOf(), spec.thresholdDays, nowMs);
    const when = f.as_of === null ? "date unknown" : `${f.as_of}, ${f.age_days} days old`;
    return `${spec.label} snapshot: ${when} (refresh after ${spec.thresholdDays} days${f.stale ? ", STALE" : ""})`;
  });
  const warning = snapshotWarning(names, nowMs);
  if (warning) lines.push(warning);
  else lines.push("Snapshots are within their refresh thresholds. Refresh with `npm run refresh-data` after a git pull or monthly.");
  return lines;
}
