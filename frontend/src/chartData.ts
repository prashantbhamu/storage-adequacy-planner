import type { HourlyResult } from "./types";

export type ResidualPoint = {
  /** Position within the plotted day: 0 = first hour (06:00 on an accounting day). */
  hour: number;
  raw_gap_gw: number;
  residual_gap_gw: number;
  chargingBand: [number, number];
  dischargingBand: [number, number];
};

function point(hour: number, before: number, after: number): ResidualPoint {
  return {
    hour, raw_gap_gw: before, residual_gap_gw: after,
    chargingBand: after < before ? [after, before] : [before, before],
    dischargingBand: after > before ? [before, after] : [before, before],
  };
}

export function residualPoints(rows: HourlyResult[]): ResidualPoint[] {
  const points: ResidualPoint[] = [];
  rows.forEach((row, hour) => {
    points.push(point(hour, row.raw_gap_gw, row.residual_gap_gw));
    const next = rows[hour + 1];
    if (!next) return;
    const delta = row.residual_gap_gw - row.raw_gap_gw;
    const nextDelta = next.residual_gap_gw - next.raw_gap_gw;
    const crossing = delta * nextDelta < 0;
    const fraction = crossing ? delta / (delta - nextDelta) : 0.5;
    const before = row.raw_gap_gw + fraction * (next.raw_gap_gw - row.raw_gap_gw);
    const after = crossing ? before : row.residual_gap_gw + fraction * (next.residual_gap_gw - row.residual_gap_gw);
    // An exact crossing splits the two colours without overlap. A midpoint on
    // other segments keeps the same point count for smooth day-to-day morphs.
    // These are drawing vertices only; tooltips always use actual hourly data.
    points.push(point(hour + fraction, before, after));
  });
  return points;
}
