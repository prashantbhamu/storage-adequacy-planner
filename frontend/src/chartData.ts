import type { HourlyResult } from "./types";

export type ResidualPoint = {
  /** Position within the plotted window: 0 = the first hour. */
  hour: number;
  raw_gap_gw: number;
  residual_gap_gw: number;
  chargingBand: [number, number];
  dischargingBand: [number, number];
};

export type LevelPoint = {
  hour: number;
  demand_gw: number;
  supply_gw: number;
  adjusted_supply_gw: number;
  chargingBand: [number, number];
  dischargingBand: [number, number];
  /** Between supply after storage and demand, where supply still falls short. */
  shortageBand: [number, number];
};

function bands(before: number, after: number) {
  return {
    chargingBand: (after < before ? [after, before] : [before, before]) as [number, number],
    dischargingBand: (after > before ? [before, after] : [before, before]) as [number, number],
  };
}

/**
 * Hourly vertices plus one extra vertex per segment: at the exact point where
 * storage switches between charging and discharging (so the blue and orange
 * bands meet without overlapping), otherwise at the midpoint. The constant
 * point count lets charts morph smoothly between windows of equal length.
 * Extra vertices are for drawing only; tooltips always read the hourly rows.
 */
function withCrossings<T>(
  rows: HourlyResult[],
  change: (row: HourlyResult) => number,
  make: (hour: number, row: HourlyResult, next: HourlyResult | undefined, fraction: number, crossing: boolean) => T,
): T[] {
  const points: T[] = [];
  rows.forEach((row, hour) => {
    points.push(make(hour, row, undefined, 0, false));
    const next = rows[hour + 1];
    if (!next) return;
    const delta = change(row);
    const nextDelta = change(next);
    const crossing = delta * nextDelta < 0;
    points.push(make(hour, row, next, crossing ? delta / (delta - nextDelta) : 0.5, crossing));
  });
  return points;
}

const lerp = (a: number, b: number, t: number) => a + t * (b - a);

/** Supply − demand margin before and after storage. */
export function residualPoints(rows: HourlyResult[]): ResidualPoint[] {
  return withCrossings(rows, (row) => row.residual_gap_gw - row.raw_gap_gw, (hour, row, next, fraction, crossing) => {
    if (!next) {
      return { hour, raw_gap_gw: row.raw_gap_gw, residual_gap_gw: row.residual_gap_gw, ...bands(row.raw_gap_gw, row.residual_gap_gw) };
    }
    const before = lerp(row.raw_gap_gw, next.raw_gap_gw, fraction);
    const after = crossing ? before : lerp(row.residual_gap_gw, next.residual_gap_gw, fraction);
    return { hour: hour + fraction, raw_gap_gw: before, residual_gap_gw: after, ...bands(before, after) };
  });
}

/** Demand, supply before storage and supply after storage, in GW. */
export function levelPoints(rows: HourlyResult[]): LevelPoint[] {
  return withCrossings(rows, (row) => row.adjusted_supply_gw - row.supply_gw, (hour, row, next, fraction, crossing) => {
    const at = (key: "demand_gw" | "supply_gw" | "adjusted_supply_gw") =>
      next ? lerp(row[key], next[key], fraction) : row[key];
    const demand = at("demand_gw");
    const before = at("supply_gw");
    const after = crossing ? before : at("adjusted_supply_gw");
    return {
      hour: hour + fraction,
      demand_gw: demand,
      supply_gw: before,
      adjusted_supply_gw: after,
      ...bands(before, after),
      shortageBand: after < demand ? [after, demand] : [demand, demand],
    };
  });
}
