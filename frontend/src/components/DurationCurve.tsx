import { useMemo } from "react";
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { num } from "../format";
import type { HourlyResult } from "../types";

const POINTS = 400;

type Point = { share: number; before: number; after: number };

/** Sorted (duration) curves, sampled so a full year stays light to draw. */
function durationPoints(hourly: HourlyResult[]): Point[] {
  const before = hourly.map((row) => row.raw_gap_gw).sort((a, b) => b - a);
  const after = hourly.map((row) => row.residual_gap_gw).sort((a, b) => b - a);
  const n = before.length;
  const steps = Math.min(POINTS, n);
  return Array.from({ length: steps }, (_, i) => {
    const index = Math.round((i / (steps - 1)) * (n - 1));
    return { share: (index / (n - 1)) * 100, before: before[index], after: after[index] };
  });
}

export function DurationCurve({ hourly }: { hourly: HourlyResult[] }) {
  const points = useMemo(() => durationPoints(hourly), [hourly]);
  const hours = hourly.length;
  const shortBefore = hourly.filter((row) => row.raw_gap_gw < -1e-6).length;
  const shortAfter = hourly.filter((row) => row.residual_gap_gw < -1e-6).length;

  return (
    <section className="panel" aria-labelledby="duration-title">
      <header className="panel-head">
        <div>
          <h3 id="duration-title">Duration curve</h3>
          <p>Supply − demand margin for every hour, sorted from largest surplus to deepest shortage. Below 0 is a shortage.</p>
        </div>
        <div className="legend-inline" aria-hidden="true">
          <span><i className="line-key is-before" />Before storage</span>
          <span><i className="line-key is-after" />After storage</span>
        </div>
      </header>
      <div className="duration-callouts">
        <div><span>Hours in shortage</span><strong>{shortBefore.toLocaleString("en-IN")} → {shortAfter.toLocaleString("en-IN")}</strong>
          <small>{num((shortBefore / hours) * 100, 1)}% → {num((shortAfter / hours) * 100, 1)}% of hours</small></div>
        <div><span>Deepest hour</span><strong>{num(points[points.length - 1].before, 1)} → {num(points[points.length - 1].after, 1)} GW</strong></div>
        <div><span>Largest surplus</span><strong>{num(points[0].before, 1)} → {num(points[0].after, 1)} GW</strong><small>shaved by charging</small></div>
      </div>
      <ResponsiveContainer width="100%" height={230}>
        <ComposedChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="duration-after" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--c-after)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--c-after)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="share" type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]}
            tickFormatter={(value: number) => `${value}%`} tick={{ fontSize: 11, fill: "var(--muted)" }}
            axisLine={{ stroke: "var(--axis)" }} tickLine={false} />
          <YAxis width={48} tick={{ fontSize: 11, fill: "var(--muted)" }} tickFormatter={(value: number) => num(value, 0)}
            axisLine={false} tickLine={false} domain={["auto", "auto"]} tickCount={6} />
          <ReferenceLine y={0} stroke="var(--axis-strong)" strokeWidth={1.5} />
          <Area type="monotone" dataKey="after" stroke="none" fill="url(#duration-after)" isAnimationActive={false} />
          <Line type="monotone" dataKey="before" stroke="var(--c-before)" strokeWidth={1.75} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="after" stroke="var(--c-after)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
          <Tooltip
            cursor={{ stroke: "var(--axis-strong)", strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              const point = active ? (payload?.[0]?.payload as Point | undefined) : undefined;
              if (!point) return null;
              return (
                <div className="chart-tooltip">
                  <strong>{num(point.share, 1)}% of hours at or above</strong>
                  <div><span><i className="line-key is-before" />Margin before storage</span><b>{num(point.before, 2)} GW</b></div>
                  <div><span><i className="line-key is-after" />Margin after storage</span><b>{num(point.after, 2)} GW</b></div>
                </div>
              );
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </section>
  );
}
