import { useMemo, useState } from "react";
import { dayLabel, num } from "../format";
import type { DailyResult } from "../types";

type Sort = "date" | "tightest" | "shortage";

export function DailyTable({ daily, selectedDay, onSelectDay }: {
  daily: DailyResult[]; selectedDay: string; onSelectDay: (day: string) => void;
}) {
  const [sort, setSort] = useState<Sort>("tightest");
  const rows = useMemo(() => {
    const copy = [...daily];
    if (sort === "tightest") copy.sort((a, b) => a.minimum_gap_after_gw - b.minimum_gap_after_gw);
    if (sort === "shortage") copy.sort((a, b) => b.shortage_energy_after_gwh - a.shortage_energy_after_gwh);
    return copy;
  }, [daily, sort]);
  const low = Math.min(0, ...daily.map((row) => Math.min(row.minimum_gap_before_gw, row.minimum_gap_after_gw)));
  const high = Math.max(0, ...daily.map((row) => Math.max(row.minimum_gap_before_gw, row.minimum_gap_after_gw)));
  const position = (value: number) => ((value - low) / (high - low || 1)) * 100;

  return (
    <details className="panel table-panel">
      <summary>
        <span><h3>All days</h3><small>{daily.length} accounting days, 06:00–06:00 · click a row to chart that date</small></span>
      </summary>
      <div className="table-tools">
        <div className="segmented" role="tablist" aria-label="Sort days">
          {([["tightest", "Tightest first"], ["shortage", "Most shortage"], ["date", "By date"]] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={sort === key} onClick={() => setSort(key)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th className="range-col">Lowest gap, before ○ → after ●</th>
              <th>Lowest gap</th>
              <th>Shortage GWh</th>
              <th>Short hours</th>
              <th>Cycles</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date} className={row.date === selectedDay ? "is-selected" : ""}
                onClick={() => { onSelectDay(row.date); document.getElementById("day-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                <td>{dayLabel(row.date)}</td>
                <td className="range-col">
                  <div className="range-track" aria-hidden="true">
                    <span className="range-zero" style={{ left: `${position(0)}%` }} />
                    <span className="range-line" style={{
                      left: `${Math.min(position(row.minimum_gap_before_gw), position(row.minimum_gap_after_gw))}%`,
                      width: `${Math.abs(position(row.minimum_gap_after_gw) - position(row.minimum_gap_before_gw))}%`,
                    }} />
                    <span className="range-dot is-before" style={{ left: `${position(row.minimum_gap_before_gw)}%` }} />
                    <span className="range-dot is-after" style={{ left: `${position(row.minimum_gap_after_gw)}%` }} />
                  </div>
                </td>
                <td><span className="was">{num(row.minimum_gap_before_gw, 1)}</span> → <b className={row.minimum_gap_after_gw < 0 ? "negative" : ""}>{num(row.minimum_gap_after_gw, 1)}</b></td>
                <td><span className="was">{num(row.shortage_energy_before_gwh, 1)}</span> → <b>{num(row.shortage_energy_after_gwh, 1)}</b></td>
                <td><span className="was">{row.shortage_hours_before}</span> → <b>{row.shortage_hours_after}</b></td>
                <td>{num(row.equivalent_cycles, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
