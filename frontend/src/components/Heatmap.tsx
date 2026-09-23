import { useEffect, useMemo, useRef, useState } from "react";
import { num, shortDay } from "../format";
import type { HourlyResult } from "../types";

export type HeatmapView = "after" | "before" | "dispatch";

const ROW_HEIGHT = 9;
const ROWS = 24;
const LABEL_W = 34;

type Cell = { day: number; row: number; value: number; hourly: HourlyResult };

function cssColor(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const value = parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mix(a: [number, number, number], b: [number, number, number], t: number) {
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
}

/**
 * Carpet plot: one column per calendar day, one row per hour (midnight at the
 * top). Deficits shade red and surpluses shade green on a shared scale so
 * before and after views compare directly.
 */
export function Heatmap({ hourly, days, selectedDay, selectedDays, onSelectDay, theme }: {
  hourly: HourlyResult[];
  days: string[];
  selectedDay: string;
  selectedDays: number;
  onSelectDay: (day: string) => void;
  theme: string;
}) {
  const [view, setView] = useState<HeatmapView>("after");
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<{ x: number; y: number; cell: Cell } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { cells, grid, deficitScale, surplusScale, dispatchScale } = useMemo(() => {
    const index = new Map(days.map((day, i) => [day, i]));
    const grid: Array<Array<Cell | undefined>> = days.map(() => Array(ROWS));
    const cells: Cell[] = [];
    let low = 0;
    let high = 0;
    let dispatch = 0;
    for (const row of hourly) {
      const day = index.get(row.timestamp.slice(0, 10));
      if (day === undefined) continue;
      const position = Number(row.timestamp.slice(11, 13));
      const cell = { day, row: position, value: 0, hourly: row };
      grid[day][position] = cell;
      cells.push(cell);
      low = Math.min(low, row.raw_gap_gw, row.residual_gap_gw);
      high = Math.max(high, row.raw_gap_gw, row.residual_gap_gw);
      dispatch = Math.max(dispatch, Math.abs(row.dispatch_gw));
    }
    return { cells, grid, deficitScale: -low || 1, surplusScale: high || 1, dispatchScale: dispatch || 1 };
  }, [hourly, days]);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plotWidth = width - LABEL_W;
  const cellWidth = plotWidth / Math.max(days.length, 1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const height = ROWS * ROW_HEIGHT;
    canvas.width = Math.round(plotWidth * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${plotWidth}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const neutral = hexToRgb(cssColor("--heat-neutral"));
    const deficit = hexToRgb(cssColor("--heat-deficit"));
    const surplus = hexToRgb(cssColor("--heat-surplus"));
    const charge = hexToRgb(cssColor("--c-charge"));
    const discharge = hexToRgb(cssColor("--c-discharge"));
    context.fillStyle = cssColor("--surface-2");
    context.fillRect(0, 0, plotWidth, height);
    const gapX = cellWidth > 4 ? 0.5 : 0;
    for (const cell of cells) {
      const row = cell.hourly;
      let colour: string;
      if (view === "dispatch") {
        const value = row.dispatch_gw;
        colour = value >= 0
          ? mix(neutral, discharge, Math.sqrt(value / dispatchScale))
          : mix(neutral, charge, Math.sqrt(-value / dispatchScale));
      } else {
        const value = view === "after" ? row.residual_gap_gw : row.raw_gap_gw;
        colour = value < 0
          ? mix(neutral, deficit, Math.min(1, 0.25 + 0.75 * Math.sqrt(-value / deficitScale)))
          : mix(neutral, surplus, Math.sqrt(value / surplusScale) * 0.85);
      }
      context.fillStyle = colour;
      context.fillRect(cell.day * cellWidth, cell.row * ROW_HEIGHT, cellWidth - gapX, ROW_HEIGHT - 0.5);
    }
    const selected = days.indexOf(selectedDay);
    if (selected >= 0) {
      context.strokeStyle = cssColor("--text");
      context.lineWidth = 1.5;
      const span = Math.min(selectedDays, days.length - selected);
      context.strokeRect(selected * cellWidth - 1, 0.75, Math.max(cellWidth * span, 2) + 2, height - 1.5);
    }
  }, [cells, view, plotWidth, cellWidth, days, selectedDay, selectedDays, deficitScale, surplusScale, dispatchScale, theme]);

  const locate = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const day = Math.floor((event.clientX - rect.left) / cellWidth);
    const row = Math.floor((event.clientY - rect.top) / ROW_HEIGHT);
    return { day, row, x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const monthTicks = useMemo(() => {
    const ticks: Array<{ index: number; label: string }> = [];
    let previous = "";
    days.forEach((day, index) => {
      const month = day.slice(0, 7);
      if (month !== previous && day.slice(8) <= "07") {
        const label = new Date(`${day}T00:00:00`).toLocaleDateString("en-IN", { month: "short" });
        ticks.push({ index, label });
      }
      previous = month;
    });
    return days.length <= 40
      ? days.map((day, index) => ({ index, label: day.slice(8) })).filter((_, i) => i % 5 === 1)
      : ticks;
  }, [days]);

  const hoverValue = hover ? (view === "after" ? hover.cell.hourly.residual_gap_gw
    : view === "before" ? hover.cell.hourly.raw_gap_gw : hover.cell.hourly.dispatch_gw) : 0;

  return (
    <section className="panel heat-panel" aria-labelledby="heat-title">
      <header className="panel-head">
        <div>
          <h3 id="heat-title">Every hour of the period</h3>
          <p>Each column is a day, each row an hour from midnight. Click a day to inspect it.</p>
        </div>
        <div className="segmented" role="tablist" aria-label="Heatmap view">
          {([["before", "Before storage"], ["after", "After storage"], ["dispatch", "Storage operation"]] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="heat-body" ref={wrapRef}>
        <div className="heat-hours" aria-hidden="true">
          {["00:00", "06:00", "12:00", "18:00"].map((label, i) => (
            <span key={label} style={{ top: i * 6 * ROW_HEIGHT }}>{label}</span>
          ))}
        </div>
        <div className="heat-canvas-wrap" style={{ marginLeft: LABEL_W }}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`Hourly ${view === "dispatch" ? "storage operation" : `supply minus demand ${view} storage`} heatmap, ${days.length} days`}
            onMouseMove={(event) => {
              const { day, row, x, y } = locate(event);
              const cell = grid[day]?.[row];
              setHover(cell ? { x, y, cell } : null);
            }}
            onMouseLeave={() => setHover(null)}
            onClick={(event) => {
              const { day } = locate(event);
              if (days[day]) onSelectDay(days[day]);
            }}
          />
          {hover ? (
            <div className="chart-tooltip heat-tooltip" style={{ left: Math.min(hover.x + 12, plotWidth - 190), top: hover.y + 14 }}>
              <strong>{shortDay(hover.cell.hourly.timestamp.slice(0, 10))} · {hover.cell.hourly.timestamp.slice(11, 16)}</strong>
              <div><span>{view === "dispatch" ? (hoverValue >= 0 ? "Discharging" : "Charging") : view === "after" ? "Gap after storage" : "Gap before storage"}</span>
                <b>{num(view === "dispatch" ? Math.abs(hoverValue) : hoverValue, 2)} GW</b></div>
              {view !== "dispatch" ? null : <div><span>Stored energy</span><b>{num(hover.cell.hourly.soc_end_gwh, 1)} GWh</b></div>}
            </div>
          ) : null}
          <div className="heat-months" aria-hidden="true">
            {monthTicks.map((tick) => (
              <span key={tick.index} style={{ left: tick.index * cellWidth }}>{tick.label}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="heat-legend" aria-hidden="true">
        {view === "dispatch" ? (
          <>
            <span className="legend-swatch" style={{ background: "var(--c-charge)" }} /> Charging
            <span className="legend-ramp is-dispatch" />
            <span className="legend-swatch" style={{ background: "var(--c-discharge)" }} /> Discharging
            <span className="legend-note">up to {num(dispatchScale, 0)} GW</span>
          </>
        ) : (
          <>
            <span>Shortage {num(-deficitScale, 0)} GW</span>
            <span className="legend-ramp" />
            <span>Surplus +{num(surplusScale, 0)} GW</span>
          </>
        )}
      </div>
    </section>
  );
}
