import { ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import {
  Area, Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { residualPoints } from "../chartData";
import { dayLabel, num, shortDay } from "../format";
import { WINDOW_OPTIONS, clampStart, tightestDate, windowRows, type WindowDays } from "../timeWindow";
import type { HourlyResult, RunResult } from "../types";

const MARGIN = { top: 10, right: 18, left: 0, bottom: 0 };
const MORPH_MS = 650;

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** A readable scale from ``low`` to ``high`` whose ticks always include zero. */
function niceScale(low: number, high: number) {
  const rough = Math.max(high - low, 1) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let tick = start; tick <= end + step / 2; tick += step) ticks.push(Math.round(tick * 1e6) / 1e6);
  return { domain: [start, end] as [number, number], ticks };
}

function tickLabel(row: HourlyResult | undefined, days: WindowDays) {
  if (!row) return "";
  const hour = row.timestamp.slice(11, 16);
  if (days === 1) return hour;
  if (hour === "00:00") {
    const date = new Date(`${row.timestamp.slice(0, 10)}T00:00:00`);
    return days === 7
      ? date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" })
      : shortDay(row.timestamp.slice(0, 10));
  }
  return hour;
}

function HourTooltip({ active, label, rows, kind }: {
  active?: boolean; label?: number; rows: HourlyResult[]; kind: "gap" | "dispatch" | "soc";
}) {
  if (!active || label === undefined) return null;
  const row = rows[Math.round(Number(label))];
  if (!row) return null;
  return (
    <div className="chart-tooltip">
      <strong>{dayLabel(row.timestamp.slice(0, 10))} · {row.timestamp.slice(11, 16)}</strong>
      {kind === "gap" ? (
        <>
          <div><span><i className="line-key is-before" />Before storage</span><b>{num(row.raw_gap_gw, 2)} GW</b></div>
          <div><span><i className="line-key is-after" />After storage</span><b>{num(row.residual_gap_gw, 2)} GW</b></div>
          <div className="tooltip-sub"><span>Demand · supply</span><b>{num(row.demand_gw, 1)} · {num(row.supply_gw, 1)} GW</b></div>
        </>
      ) : kind === "dispatch" ? (
        <div><span><i className={`dot-key ${row.dispatch_gw < 0 ? "is-charge" : "is-discharge"}`} />{row.dispatch_gw < 0 ? "Charging" : row.dispatch_gw > 0 ? "Discharging" : "Idle"}</span>
          <b>{num(Math.abs(row.dispatch_gw), 2)} GW</b></div>
      ) : (
        <div><span><i className="dot-key is-soc" />Stored at hour end</span><b>{num(row.soc_end_gwh, 1)} GWh</b></div>
      )}
    </div>
  );
}

/**
 * Three linked charts. The number of points and every y-scale stay fixed for
 * a given window length, so stepping between dates morphs the lines, bands
 * and bars from one period to the next instead of redrawing them.
 */
const WindowCharts = memo(function WindowCharts({ rows, days, result, gapScale }: {
  rows: HourlyResult[]; days: WindowDays; result: RunResult; gapScale: { domain: [number, number]; ticks: number[] };
}) {
  const gapDomain = gapScale.domain;
  const reduced = useReducedMotion();
  const narrow = useMedia("(max-width: 640px)");
  const residual = useMemo(() => residualPoints(rows), [rows]);
  const hourly = useMemo(() => rows.map((row, hour) => ({ ...row, hour })), [rows]);
  const every = (days === 1 ? 3 : days === 2 ? 6 : 24) * (narrow && days !== 7 ? 2 : 1);
  const ticks = hourly.filter((_, index) => index % every === 0).map((row) => row.hour);
  const storage = result.storage;
  const motion = {
    isAnimationActive: !reduced,
    animationDuration: MORPH_MS,
    animationEasing: "ease-in-out" as const,
    animationBegin: 0,
  };
  const xAxis = {
    dataKey: "hour", type: "number" as const, domain: [0, Math.max(rows.length - 1, 1)], ticks,
    tickFormatter: (hour: number) => tickLabel(rows[Math.round(hour)], days),
    tick: { fontSize: 11, fill: "var(--muted)" }, axisLine: { stroke: "var(--axis)" }, tickLine: false, height: 24,
    interval: 0 as const,
  };
  const yAxis = { width: 48, tick: { fontSize: 11, fill: "var(--muted)" }, axisLine: false, tickLine: false,
    tickFormatter: (value: number) => num(value, 0) };
  const common = { margin: MARGIN, syncId: "window", syncMethod: "value" as const };
  const cursor = { stroke: "var(--axis-strong)", strokeDasharray: "3 3" };
  const barSize = days === 1 ? 20 : days === 2 ? 10 : 3;
  const midnights = days === 1 ? [] : hourly.filter((row) => row.hour > 0 && row.timestamp.slice(11, 13) === "00").map((row) => row.hour);
  const dayLines = midnights.map((hour) => <ReferenceLine key={hour} x={hour} stroke="var(--axis)" strokeDasharray="2 4" />);

  return (
    <div className="day-charts">
      <div className="lane">
        <div className="lane-head">
          <h4>Supply − demand <small>GW</small></h4>
          <div className="legend-inline" aria-hidden="true">
            <span><i className="line-key is-before" />Before</span>
            <span><i className="line-key is-after" />After</span>
            <span><i className="band-key is-charge" />Charging</span>
            <span><i className="band-key is-discharge" />Discharging</span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={250}>
          <ComposedChart data={residual} {...common}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            {gapDomain[0] < 0 ? <ReferenceArea y1={gapDomain[0]} y2={0} fill="var(--c-deficit)" fillOpacity={0.06} /> : null}
            {dayLines}
            <XAxis {...xAxis} />
            <YAxis {...yAxis} domain={gapDomain} ticks={gapScale.ticks} allowDataOverflow />
            <ReferenceLine y={0} stroke="var(--axis-strong)" />
            <Area type="linear" dataKey="chargingBand" fill="var(--c-charge)" fillOpacity={0.22} stroke="none" activeDot={false} {...motion} />
            <Area type="linear" dataKey="dischargingBand" fill="var(--c-discharge)" fillOpacity={0.26} stroke="none" activeDot={false} {...motion} />
            <Line type="linear" dataKey="raw_gap_gw" stroke="var(--c-before)" strokeWidth={1.75} strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} {...motion} />
            <Line type="linear" dataKey="residual_gap_gw" stroke="var(--c-after)" strokeWidth={3} dot={false} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }} {...motion} />
            <Tooltip content={<HourTooltip rows={rows} kind="gap" />} cursor={cursor} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="lane">
        <div className="lane-head"><h4>Storage operation <small>GW · up = discharge, down = charge</small></h4></div>
        <ResponsiveContainer width="100%" height={130}>
          <ComposedChart data={hourly} {...common}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            {dayLines}
            <XAxis {...xAxis} />
            <YAxis {...yAxis} domain={[-storage.charge_power_gw, storage.discharge_power_gw]}
              ticks={[-storage.charge_power_gw, 0, storage.discharge_power_gw]} />
            <ReferenceLine y={0} stroke="var(--axis-strong)" />
            <Bar dataKey="dispatch_gw" radius={days === 7 ? 1 : 3} maxBarSize={barSize} {...motion}>
              {hourly.map((row) => <Cell key={row.hour} fill={row.dispatch_gw < 0 ? "var(--c-charge)" : "var(--c-discharge)"} />)}
            </Bar>
            <Tooltip content={<HourTooltip rows={rows} kind="dispatch" />} cursor={{ fill: "var(--hover)" }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="lane">
        <div className="lane-head"><h4>Stored energy <small>GWh at hour end</small></h4></div>
        <ResponsiveContainer width="100%" height={130}>
          <ComposedChart data={hourly} {...common}>
            <defs>
              <linearGradient id="soc-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--c-soc)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--c-soc)" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            {dayLines}
            <XAxis {...xAxis} />
            <YAxis {...yAxis} domain={[0, storage.energy_gwh]} ticks={[0, storage.energy_gwh / 2, storage.energy_gwh]} />
            {storage.soc_min_gwh > 0 ? <ReferenceLine y={storage.soc_min_gwh} stroke="var(--c-soc)" strokeDasharray="4 4" strokeOpacity={0.6} /> : null}
            {storage.soc_max_gwh < storage.energy_gwh ? <ReferenceLine y={storage.soc_max_gwh} stroke="var(--c-soc)" strokeDasharray="4 4" strokeOpacity={0.6} /> : null}
            <Area type="monotone" dataKey="soc_end_gwh" stroke="var(--c-soc)" strokeWidth={2.25} fill="url(#soc-fill)" dot={false}
              activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }} {...motion} />
            <Tooltip content={<HourTooltip rows={rows} kind="soc" />} cursor={cursor} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
});

export function DayDetail({ result, dates, start, days, onStart, onDays }: {
  result: RunResult;
  dates: string[];
  start: string;
  days: WindowDays;
  onStart: (date: string) => void;
  onDays: (days: WindowDays) => void;
}) {
  const rows = useMemo(() => windowRows(result.hourly, start, days), [result.hourly, start, days]);
  const tightest = useMemo(() => tightestDate(result.hourly), [result.hourly]);
  const gapScale = useMemo(() => {
    let low = 0;
    let high = 0;
    for (const row of result.hourly) {
      low = Math.min(low, row.raw_gap_gw, row.residual_gap_gw);
      high = Math.max(high, row.raw_gap_gw, row.residual_gap_gw);
    }
    return niceScale(low, high);
  }, [result.hourly]);
  const index = dates.indexOf(start);
  const last = Math.max(0, dates.length - days);
  const eta = Math.sqrt(result.storage.rte);
  const stats = useMemo(() => {
    const lowBefore = Math.min(...rows.map((row) => row.raw_gap_gw));
    const lowAfter = Math.min(...rows.map((row) => row.residual_gap_gw));
    const short = (value: number) => Math.max(-value, 0);
    return {
      lowBefore,
      lowAfter,
      shortBefore: rows.reduce((sum, row) => sum + short(row.raw_gap_gw), 0),
      shortAfter: rows.reduce((sum, row) => sum + short(row.residual_gap_gw), 0),
      hoursBefore: rows.filter((row) => row.raw_gap_gw < -1e-6).length,
      hoursAfter: rows.filter((row) => row.residual_gap_gw < -1e-6).length,
      cycles: rows.reduce((sum, row) => sum + eta * row.charge_gw + row.discharge_gw / eta, 0) / (2 * result.storage.energy_gwh),
    };
  }, [rows, eta, result.storage.energy_gwh]);
  const endDate = dates[Math.min(index + days - 1, dates.length - 1)];
  const title = days === 1 ? dayLabel(start) : `${shortDay(start)} – ${dayLabel(endDate)}`;
  const step = (direction: 1 | -1) => onStart(dates[Math.min(Math.max(index + direction * days, 0), last)]);

  return (
    <section className="panel day-panel" id="day-detail" aria-labelledby="day-title">
      <header className="panel-head">
        <div>
          <h3 id="day-title">{title}</h3>
          <p>{days === 1 ? "Midnight to midnight, hour by hour." : `${days * 24} hours from midnight.`}</p>
        </div>
        <div className="day-nav">
          <div className="segmented" role="tablist" aria-label="Chart window">
            {WINDOW_OPTIONS.map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={days === value}
                onClick={() => { onDays(value); onStart(clampStart(dates, start, value)); }}>{label}</button>
            ))}
          </div>
          <button type="button" className="icon-button" aria-label="Earlier" disabled={index <= 0} onClick={() => step(-1)}><ChevronLeft size={16} /></button>
          <select aria-label="Start date" value={start} onChange={(event) => onStart(clampStart(dates, event.target.value, days))}>
            {dates.slice(0, last + 1).map((item) => <option key={item} value={item}>{dayLabel(item)}</option>)}
          </select>
          <button type="button" className="icon-button" aria-label="Later" disabled={index >= last} onClick={() => step(1)}><ChevronRight size={16} /></button>
          <button type="button" className="secondary-button" disabled={start === clampStart(dates, tightest, days)}
            onClick={() => onStart(clampStart(dates, tightest, days))}>
            <TriangleAlert size={14} aria-hidden="true" /> Tightest day
          </button>
        </div>
      </header>
      <dl className="day-stats">
        <div><dt>Lowest gap</dt><dd><span className="was">{num(stats.lowBefore, 1)}</span> → <b className={stats.lowAfter < 0 ? "negative" : ""}>{num(stats.lowAfter, 1)}</b> GW</dd></div>
        <div><dt>Shortage</dt><dd><span className="was">{num(stats.shortBefore, 1)}</span> → <b>{num(stats.shortAfter, 1)}</b> GWh</dd></div>
        <div><dt>Short hours</dt><dd><span className="was">{stats.hoursBefore}</span> → <b>{stats.hoursAfter}</b></dd></div>
        <div><dt>Cycles</dt><dd><b>{num(stats.cycles, 2)}</b></dd></div>
      </dl>
      <WindowCharts rows={rows} days={days} result={result} gapScale={gapScale} />
    </section>
  );
}
