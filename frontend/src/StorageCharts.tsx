import { memo, useEffect, useMemo, useState } from "react";
import {
  Area, Bar, CartesianGrid, Cell, ComposedChart, Legend, Line,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { HourlyResult } from "./types";
import { residualPoints } from "./chartData";

const COLOURS = { before: "#171717", after: "#16803d", charge: "#0284c7", discharge: "#ed850c", soc: "#dc2626" };
const MARGIN = { top: 12, right: 24, left: 0, bottom: 0 };
const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 23];
const timeLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
const number = (value: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(value);

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

function syncHour(ticks: Array<{ value: number }>, state: { activeLabel?: number }) {
  const hour = Math.round(Number(state.activeLabel));
  return ticks.findIndex((tick) => Number(tick.value) === hour);
}

function HourTooltip({ active, label, rows, kind }: {
  active?: boolean; label?: number | string; rows: HourlyResult[]; kind: "residual" | "dispatch" | "soc";
}) {
  if (!active || label === undefined) return null;
  const hour = Math.round(Number(label));
  const row = rows.find((item) => Number(item.timestamp.slice(11, 13)) === hour);
  if (!row) return null;
  const entries = kind === "residual"
    ? [["Before storage", row.raw_gap_gw, COLOURS.before], ["After storage", row.residual_gap_gw, COLOURS.after]] as const
    : kind === "dispatch"
      ? [[row.dispatch_gw < 0 ? "Charging −" : "Discharging +", row.dispatch_gw, row.dispatch_gw < 0 ? COLOURS.charge : COLOURS.discharge]] as const
      : [["SOC · end of hour", row.soc_end_gwh, COLOURS.soc]] as const;
  return <div className="chart-tooltip">
    <strong>{row.timestamp.slice(0, 10)} · {timeLabel(hour)}</strong>
    {entries.map(([name, value, colour]) => <div key={name} style={{ color: colour }}>
      <span>{name}</span><b>{number(value)} {kind === "soc" ? "GWh" : "GW"}</b>
    </div>)}
  </div>;
}

export const StorageCharts = memo(function StorageCharts({ rows, energyCapacity, chargePower, dischargePower }: {
  rows: HourlyResult[]; energyCapacity: number; chargePower: number; dischargePower: number;
}) {
  const reducedMotion = useReducedMotion();
  const residual = useMemo(() => residualPoints(rows), [rows]);
  const hourly = useMemo(() => rows.map((row) => ({ ...row, hour: Number(row.timestamp.slice(11, 13)) })), [rows]);
  const animation = { isAnimationActive: !reducedMotion, animationDuration: 1500, animationBegin: 0, animationEasing: "ease" as const };
  const xAxis = { dataKey: "hour", type: "number" as const, domain: [0, 23], ticks: TICKS, tickFormatter: timeLabel,
    tick: { fontSize: 11, fill: "#263d58" }, axisLine: { stroke: "#a4adb6" }, tickLine: { stroke: "#a4adb6" }, height: 30 };
  const yAxis = { width: 54, tick: { fontSize: 11, fill: "#263d58" }, tickFormatter: number,
    axisLine: { stroke: "#a4adb6" }, tickLine: false };
  const common = { margin: MARGIN, syncId: "storage-hour", syncMethod: syncHour };
  const legendStyle = { fontSize: 12, paddingTop: 4 };
  return <div className="chart-scroll" role="region" aria-label="Hourly storage charts" tabIndex={0}>
    <div className="chart-panel" data-testid="storage-charts">
      <section className="chart-lane residual-lane" aria-label="Residual gap">
        <h4>Residual gap · GW</h4>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={residual} {...common}>
            <CartesianGrid stroke="#e4ebf0" strokeDasharray="4 4" vertical={false} />
            <XAxis {...xAxis} /><YAxis {...yAxis} domain={["auto", "auto"]} />
            <ReferenceLine y={0} stroke="#8b9bab" strokeDasharray="5 4" />
            <Area type="linear" dataKey="chargingBand" fill={COLOURS.charge} fillOpacity={0.16} stroke="none" legendType="none" tooltipType="none" activeDot={false} {...animation} />
            <Area type="linear" dataKey="dischargingBand" fill={COLOURS.discharge} fillOpacity={0.2} stroke="none" legendType="none" tooltipType="none" activeDot={false} {...animation} />
            <Line type="linear" dataKey="raw_gap_gw" name="Before storage" stroke={COLOURS.before} strokeWidth={2.5} dot={false} activeDot={{ r: 5, stroke: "white", strokeWidth: 2 }} {...animation} />
            <Line type="linear" dataKey="residual_gap_gw" name="After storage" stroke={COLOURS.after} strokeWidth={3} dot={false} activeDot={{ r: 5, stroke: "white", strokeWidth: 2 }} {...animation} />
            <Tooltip content={<HourTooltip rows={rows} kind="residual" />} cursor={{ stroke: "#8192a4", strokeDasharray: "3 3" }} />
            <Legend wrapperStyle={legendStyle} payload={[
              { value: "Before storage", type: "plainline", color: COLOURS.before, payload: { strokeDasharray: "" } },
              { value: "After storage", type: "plainline", color: COLOURS.after, payload: { strokeDasharray: "" } },
            ]} />
          </ComposedChart>
        </ResponsiveContainer>
      </section>
      <section className="chart-lane dispatch-lane" aria-label="Storage dispatch">
        <h4>Storage dispatch · GW</h4>
        <ResponsiveContainer width="100%" height={145}>
          <ComposedChart data={hourly} {...common}>
            <CartesianGrid stroke="#e4ebf0" vertical={false} />
            <XAxis {...xAxis} /><YAxis {...yAxis} domain={[-chargePower, dischargePower]} ticks={[-chargePower, 0, dischargePower]} />
            <ReferenceLine y={0} stroke="#8b9bab" />
            <Bar dataKey="dispatch_gw" name="Storage dispatch" barSize={17} {...animation}>
              {hourly.map((row) => <Cell key={row.hour} fill={row.dispatch_gw < 0 ? COLOURS.charge : COLOURS.discharge} />)}
            </Bar>
            <Tooltip content={<HourTooltip rows={rows} kind="dispatch" />} cursor={{ fill: "#0b2b50", fillOpacity: 0.035 }} />
            <Legend wrapperStyle={legendStyle} payload={[
              { value: "Charging −", type: "square", color: COLOURS.charge },
              { value: "Discharging +", type: "square", color: COLOURS.discharge },
            ]} />
          </ComposedChart>
        </ResponsiveContainer>
      </section>
      <section className="chart-lane soc-lane" aria-label="Stored energy">
        <h4>SOC · GWh <span>end of hour</span></h4>
        <ResponsiveContainer width="100%" height={135}>
          <ComposedChart data={hourly} {...common}>
            <CartesianGrid stroke="#e4ebf0" strokeDasharray="4 4" vertical={false} />
            <XAxis {...xAxis} /><YAxis {...yAxis} domain={[0, energyCapacity]} ticks={[0, energyCapacity / 2, energyCapacity]} />
            <ReferenceLine y={energyCapacity} stroke={COLOURS.soc} strokeOpacity={0.6} strokeDasharray="5 4" />
            <Area type="linear" dataKey="soc_end_gwh" name="SOC" stroke={COLOURS.soc} strokeWidth={2.5} fill={COLOURS.soc} fillOpacity={0.11} dot={false} activeDot={{ r: 5, stroke: "white", strokeWidth: 2 }} {...animation} />
            <Tooltip content={<HourTooltip rows={rows} kind="soc" />} cursor={{ stroke: "#8192a4", strokeDasharray: "3 3" }} />
          </ComposedChart>
        </ResponsiveContainer>
      </section>
    </div>
  </div>;
});
