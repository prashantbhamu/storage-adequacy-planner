import { Check, CircleCheck, X } from "lucide-react";
import { dayLabel, num, tiny } from "../format";
import type { LimitKey, RunResult } from "../types";

const LIMIT_ORDER: LimitKey[] = ["discharge_power", "stored_energy", "daily_cycle_limit", "energy_rationed"];
const LIMIT_HINT: Record<LimitKey, string> = {
  discharge_power: "Discharging at full power and still short.",
  stored_energy: "Storage empty (at its minimum SOC).",
  daily_cycle_limit: "The day's discharge allowance was used up.",
  energy_rationed: "Energy held back for a deeper or longer deficit.",
};

export function LimitsCard({ result, onSelectDay }: { result: RunResult; onSelectDay: (day: string) => void }) {
  const { limits } = result;
  const total = LIMIT_ORDER.reduce((sum, key) => sum + limits.shortage_hours[key], 0);
  const floor = limits.floor_hour;
  return (
    <section className="panel" aria-labelledby="limits-title">
      <header className="panel-head"><div><h3 id="limits-title">Why shortage remains</h3>
        <p>What stopped storage in each remaining short hour.</p></div></header>
      {total === 0 ? (
        <div className="all-clear"><CircleCheck size={22} aria-hidden="true" /><div><strong>No short hours remain.</strong>
          <span>Storage covers every deficit in the period.</span></div></div>
      ) : (
        <>
          <div className="stack-bar" role="img" aria-label="Short hours by cause">
            {LIMIT_ORDER.filter((key) => limits.shortage_hours[key] > 0).map((key) => (
              <span key={key} className={`seg-${key}`} style={{ flexGrow: limits.shortage_hours[key] }} title={`${limits.labels[key]}: ${limits.shortage_hours[key]} h`} />
            ))}
          </div>
          <ul className="cause-list">
            {LIMIT_ORDER.map((key) => (
              <li key={key} className={limits.shortage_hours[key] ? "" : "is-zero"}>
                <i className={`seg-${key}`} aria-hidden="true" />
                <div><strong>{limits.labels[key]}</strong><span>{LIMIT_HINT[key]}</span></div>
                <b>{limits.shortage_hours[key]} h</b>
                <em>{num(limits.shortage_energy_gwh[key], 1)} GWh</em>
              </li>
            ))}
          </ul>
        </>
      )}
      <button type="button" className="floor-hour" onClick={() => onSelectDay(floor.timestamp.slice(0, 10))}>
        <span>Tightest hour</span>
        <strong>{dayLabel(floor.timestamp.slice(0, 10))} · {floor.timestamp.slice(11, 16)}</strong>
        <b className={floor.residual_gap_gw < 0 ? "negative" : ""}>{num(floor.residual_gap_gw, 2)} GW</b>
        <small>{limits.labels[floor.limit]} · view day →</small>
      </button>
    </section>
  );
}

export function Tornado({ result }: { result: RunResult }) {
  const rows = result.sensitivity;
  const floorMax = Math.max(...rows.map((row) => Math.max(row.floor_change_gw, 0)), 1e-9);
  const shortageMax = Math.max(...rows.map((row) => Math.max(-row.shortage_change_gwh, 0)), 1e-9);
  const best = result.limits.most_effective_increase;
  return (
    <section className="panel" aria-labelledby="tornado-title">
      <header className="panel-head"><div><h3 id="tornado-title">What if each limit were 10% larger?</h3>
        <p>Whole-period optimum with one limit raised at a time.</p></div></header>
      <div className="tornado">
        <div className="tornado-axis"><span>Shortage removed</span><span /><span>Tightest hour lifted</span></div>
        {rows.map((row) => {
          const saved = Math.max(-row.shortage_change_gwh, 0);
          const lifted = Math.max(row.floor_change_gw, 0);
          return (
            <div key={row.parameter} className={`tornado-row ${row.parameter === best ? "is-best" : ""}`}>
              <div className="tornado-side is-left">
                <em>{saved > 0 ? `${num(saved, 1)} GWh` : "—"}</em>
                <span style={{ width: `${(saved / shortageMax) * 100}%` }} />
              </div>
              <div className="tornado-label">
                <strong>{row.parameter}</strong>
                <small>{num(row.from, row.unit === "cycles" ? 2 : 0)} → {num(row.to, row.unit === "cycles" ? 2 : 0)} {row.unit}</small>
              </div>
              <div className="tornado-side">
                <span style={{ width: `${(lifted / floorMax) * 100}%` }} />
                <em>{lifted > 0 ? `+${num(lifted, 2)} GW` : "—"}</em>
              </div>
            </div>
          );
        })}
      </div>
      <p className="panel-foot">{best ? `${best} gives the largest gain; limits showing “—” are not binding.` : "None of the four limits improves the result by itself."}</p>
    </section>
  );
}

export function ChecksCard({ result }: { result: RunResult }) {
  const { checks, diagnostics } = result.validation;
  const storage = result.storage;
  const b = result.benchmark;
  const tolerance = 2e-6;
  const items: Array<[string, string, boolean]> = [
    ["Stored energy within range", `${num(diagnostics.minimum_soc_gwh, 1)}–${num(diagnostics.maximum_soc_gwh, 1)} of ${num(storage.soc_min_gwh, 0)}–${num(storage.soc_max_gwh, 0)} GWh`,
      checks.soc_lower_violation_gwh <= tolerance && checks.soc_upper_violation_gwh <= tolerance],
    ["Ends at the final SOC", `${num(diagnostics.final_soc_gwh, 2)} GWh`, checks.final_soc_abs_gwh <= tolerance],
    ["Charge power", `peak ${num(diagnostics.maximum_charge_gw, 2)} of ${num(storage.charge_power_gw, 1)} GW`, checks.charge_power_violation_gw <= tolerance],
    ["Discharge power", `peak ${num(diagnostics.maximum_discharge_gw, 2)} of ${num(storage.discharge_power_gw, 1)} GW`, checks.discharge_power_violation_gw <= tolerance],
    ["Daily cycle limit", `max ${num(diagnostics.maximum_06_day_internal_discharge_gwh, 1)} of ${num(storage.daily_internal_throughput_cap_gwh, 1)} GWh`,
      checks.daily_internal_charge_violation_gwh <= tolerance && checks.daily_internal_discharge_violation_gwh <= tolerance],
    ["No simultaneous charge and discharge", `${tiny(checks.simultaneous_charge_discharge_gw)} GW`, checks.simultaneous_charge_discharge_gw <= tolerance],
    ["Charging only from surplus", storage.charge_from_surplus_only ? "enforced" : "not required", checks.surplus_charging_violation_gw <= tolerance],
    ["Energy balance every hour", `${tiny(checks.soc_balance_max_abs_gwh)} GWh error`, checks.soc_balance_max_abs_gwh <= tolerance],
  ];
  return (
    <section className="panel" aria-labelledby="checks-title">
      <header className="panel-head"><div><h3 id="checks-title">Checks</h3><p>Recomputed from the final schedule.</p></div></header>
      <div className="optimum">
        <div><span>Tightest hour</span><strong>{num(b.rolling_floor_gw, 2)}</strong><small>optimum {num(b.perfect_foresight_floor_gw, 2)} GW</small></div>
        <div><span>Shortage</span><strong>{num(b.rolling_shortage_gwh, 1)}</strong><small>optimum {num(b.perfect_foresight_shortage_gwh, 1)} GWh</small></div>
      </div>
      <ul className="check-list">
        {items.map(([label, value, passed]) => (
          <li key={label} className={passed ? "" : "is-fail"}>
            {passed ? <Check size={14} strokeWidth={3} aria-label="Passed" /> : <X size={14} strokeWidth={3} aria-label="Failed" />}
            <span>{label}</span><em>{value}</em>
          </li>
        ))}
      </ul>
    </section>
  );
}
