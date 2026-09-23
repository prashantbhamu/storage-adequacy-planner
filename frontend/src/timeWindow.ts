import type { HourlyResult } from "./types";

/** Days shown by the hourly charts: one day, two days or a week. */
export type WindowDays = 1 | 2 | 7;

export const WINDOW_OPTIONS: Array<[WindowDays, string]> = [[1, "1D"], [2, "2D"], [7, "1W"]];

export const calendarDate = (row: HourlyResult) => row.timestamp.slice(0, 10);

export function calendarDates(hourly: HourlyResult[]) {
  const dates: string[] = [];
  for (const row of hourly) {
    const date = calendarDate(row);
    if (dates[dates.length - 1] !== date) dates.push(date);
  }
  return dates;
}

/** Keep a window of ``days`` inside the study period. */
export function clampStart(dates: string[], start: string, days: WindowDays) {
  const last = Math.max(0, dates.length - days);
  const index = Math.min(Math.max(dates.indexOf(start), 0), last);
  return dates[index];
}

/** Hourly rows from 00:00 on ``start`` for ``days`` calendar days. */
export function windowRows(hourly: HourlyResult[], start: string, days: WindowDays) {
  const first = hourly.findIndex((row) => calendarDate(row) === start);
  return first < 0 ? [] : hourly.slice(first, first + days * 24);
}

/** The calendar date holding the lowest gap after storage. */
export function tightestDate(hourly: HourlyResult[]) {
  let worst = hourly[0];
  for (const row of hourly) if (row.residual_gap_gw < worst.residual_gap_gw) worst = row;
  return calendarDate(worst);
}
