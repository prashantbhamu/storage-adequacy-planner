import { ArrowDownToLine, BadgeCheck, CircleAlert, Target } from "lucide-react";
import { num, signed } from "../format";
import type { RunResult } from "../types";

/** A number line showing the lowest hour before and after storage against zero. */
function FloorLift({ before, after }: { before: number; after: number }) {
  const low = Math.min(before, after, 0);
  const high = Math.max(before, after, 0);
  const pad = (high - low) * 0.12 || 1;
  const scale = (value: number) => ((value - (low - pad)) / (high - low + 2 * pad)) * 100;
  const x0 = scale(0);
  const xb = scale(before);
  const xa = scale(after);
  return (
    <div className="floor-lift" aria-hidden="true">
      <svg viewBox="0 0 100 34" preserveAspectRatio="none">
        <rect x="0" y="14" width={x0} height="6" className="fl-deficit" rx="3" />
        <rect x={x0} y="14" width={100 - x0} height="6" className="fl-surplus" rx="3" />
        <line x1={xb} x2={xa} y1="17" y2="17" className="fl-arrow" />
      </svg>
      <span className="fl-marker fl-before" style={{ left: `${xb}%` }}><i />{num(before, 1)}</span>
      <span className="fl-marker fl-after" style={{ left: `${xa}%` }}><i />{num(after, 1)}</span>
      <span className="fl-zero" style={{ left: `${x0}%` }}>0</span>
    </div>
  );
}

function CompareBars({ label, before, after, unit, digits = 0 }: {
  label: string; before: number; after: number; unit: string; digits?: number;
}) {
  const top = Math.max(before, after) || 1;
  const reduction = before > 0 ? (1 - after / before) * 100 : 0;
  return (
    <div className="compare">
      <div className="compare-head">
        <span>{label}</span>
        <b>{before <= 0 ? "none before" : after === 0 ? "eliminated" : after >= before ? "no change" : `−${num(reduction, 1)}%`}</b>
      </div>
      <div className="compare-row">
        <span>Before</span>
        <div className="compare-track"><div className="compare-bar is-before" style={{ width: `${(before / top) * 100}%` }} /></div>
        <strong>{num(before, before >= 100 ? 0 : digits)} <small>{unit}</small></strong>
      </div>
      <div className="compare-row">
        <span>After</span>
        <div className="compare-track"><div className="compare-bar is-after" style={{ width: `${Math.max((after / top) * 100, after > 0 ? 0.6 : 0)}%` }} /></div>
        <strong>{num(after, after >= 100 ? 0 : digits)} <small>{unit}</small></strong>
      </div>
    </div>
  );
}

export function headline(result: RunResult) {
  const s = result.summary;
  const lift = s.minimum_gap_after_gw - s.minimum_gap_before_gw;
  const floor = `Storage lifts the tightest hour from ${num(s.minimum_gap_before_gw, 1)} GW to ${num(s.minimum_gap_after_gw, 1)} GW`;
  if (s.shortage_energy_before_gwh <= 0) {
    return `${floor}. There was no shortage to remove.`;
  }
  if (s.shortage_hours_after === 0) {
    return `${floor} and removes all ${num(s.shortage_energy_before_gwh, 0)} GWh of shortage.`;
  }
  const cut = (1 - s.shortage_energy_after_gwh / s.shortage_energy_before_gwh) * 100;
  return lift > 0
    ? `${floor} and cuts shortage energy by ${num(cut, 1)}%; ${s.shortage_hours_after.toLocaleString("en-IN")} short hours remain.`
    : `${floor}; shortage energy falls by ${num(cut, 1)}%.`;
}

export function Verdict({ result, onDownload, downloadError }: {
  result: RunResult; onDownload: () => void; downloadError: string;
}) {
  const s = result.summary;
  const storage = result.storage;
  const best = result.sensitivity.find((row) => row.parameter === result.limits.most_effective_increase);
  const optimal = result.benchmark.floor_shortfall_gw === 0 && result.benchmark.excess_shortage_gwh === 0;
  const chips = [
    `${num(storage.charge_power_gw, 1)}${storage.charge_power_gw === storage.discharge_power_gw ? "" : ` / ${num(storage.discharge_power_gw, 1)}`} GW`,
    `${num(storage.energy_gwh, 0)} GWh`,
    `${num(storage.energy_gwh / storage.discharge_power_gw, 1)} h`,
    `RTE ${num(storage.rte * 100, 1)}%`,
    `${num(storage.max_cycles_per_accounting_day, 2)} cycle/day`,
    `SOC ${num(storage.initial_soc_fraction * 100, 1)}% → ${num(storage.final_soc_fraction * 100, 1)}%`,
    storage.min_soc_fraction > 0 || storage.max_soc_fraction < 1
      ? `range ${num(storage.min_soc_fraction * 100, 0)}–${num(storage.max_soc_fraction * 100, 0)}%` : null,
    storage.charge_from_surplus_only ? "surplus charging" : "any-hour charging",
  ].filter(Boolean);

  return (
    <section className="verdict" aria-label="Result summary">
      <div className="verdict-top">
        <div>
          <p className="eyebrow">{result.period.label} · {result.period.hours.toLocaleString("en-IN")} hours</p>
          <h2>{headline(result)}</h2>
          <ul className="chips" aria-label="Storage assumptions">
            {chips.map((chip) => <li key={chip}>{chip}</li>)}
          </ul>
        </div>
        <button type="button" className="secondary-button" onClick={onDownload}>
          <ArrowDownToLine size={15} aria-hidden="true" /> Workbook
        </button>
      </div>
      {downloadError ? <p className="inline-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{downloadError}</p> : null}

      <div className="verdict-grid">
        <div className="verdict-card">
          <div className="compare-head"><span>Tightest hour (GW)</span><b>{signed(s.minimum_gap_after_gw - s.minimum_gap_before_gw, 1)} GW</b></div>
          <FloorLift before={s.minimum_gap_before_gw} after={s.minimum_gap_after_gw} />
          <p className="verdict-note">Lowest supply − demand across the period. Below zero is a shortage.</p>
        </div>
        <div className="verdict-card">
          <CompareBars label="Shortage energy" before={s.shortage_energy_before_gwh} after={s.shortage_energy_after_gwh} unit="GWh" digits={s.shortage_energy_after_gwh < 100 ? 1 : 0} />
        </div>
        <div className="verdict-card">
          <CompareBars label="Shortage hours" before={s.shortage_hours_before} after={s.shortage_hours_after} unit="h" />
        </div>
      </div>

      <div className="verdict-foot">
        <div className={`insight ${best ? "" : "is-neutral"}`}>
          <Target size={16} aria-hidden="true" />
          {best ? (
            <p>
              <strong>{best.parameter} is the binding limit.</strong>{" "}
              +10% ({num(best.from, 1)} → {num(best.to, 1)} {best.unit}) would lift the tightest hour by {num(best.floor_change_gw, 2)} GW
              {best.shortage_change_gwh < 0 ? ` and cut shortage by ${num(-best.shortage_change_gwh, 1)} GWh` : ""}.
            </p>
          ) : (
            <p><strong>No single storage limit binds.</strong> A 10% increase in power, energy or cycles does not improve the result; it is set by the data or the SOC settings.</p>
          )}
        </div>
        <div className={`badge ${optimal ? "is-good" : "is-warn"}`} title="Rolling 48 h / 24 h dispatch compared with a whole-period perfect-foresight solve">
          <BadgeCheck size={15} aria-hidden="true" />
          {optimal ? "Matches the perfect-foresight optimum" : `Within ${num(result.benchmark.floor_shortfall_gw, 3)} GW / ${num(result.benchmark.excess_shortage_gwh, 2)} GWh of the optimum`}
        </div>
      </div>

      <dl className="stat-strip">
        <div><dt>Equivalent cycles</dt><dd>{num(s.equivalent_cycles, 1)}</dd></div>
        <div><dt>Energy discharged</dt><dd>{num(s.total_discharge_gwh, 0)} <small>GWh</small></dd></div>
        <div><dt>Conversion losses</dt><dd>{num(s.conversion_losses_gwh, 0)} <small>GWh</small></dd></div>
        <div><dt>Peak discharge</dt><dd>{num(s.peak_discharge_gw, 1)} <small>GW</small></dd></div>
        <div><dt>Peak charge</dt><dd>{num(s.peak_charge_gw, 1)} <small>GW</small></dd></div>
        <div><dt>Highest gap after</dt><dd>{num(s.maximum_gap_after_gw, 1)} <small>GW</small></dd></div>
      </dl>
    </section>
  );
}
