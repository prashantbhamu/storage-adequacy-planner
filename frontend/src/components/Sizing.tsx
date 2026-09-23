import { CircleAlert, Ruler } from "lucide-react";
import { useState } from "react";
import { sizeStorage } from "../api";
import { num } from "../format";
import { checkInputs, toSettings } from "../inputs";
import type { SizingMode, SizingResult, StorageInputs, Validation } from "../types";

const MODES: Array<{ key: SizingMode; label: string; detail: string; skip: Array<keyof StorageInputs> }> = [
  { key: "energy", label: "Energy", detail: "Minimum GWh at the entered charge and discharge power", skip: ["energy_gwh"] },
  { key: "power", label: "Power", detail: "Minimum GW (charge = discharge) at the entered energy capacity", skip: ["charge_power_gw", "discharge_power_gw"] },
  { key: "duration", label: "Power at a duration", detail: "Minimum GW with energy fixed at power × hours", skip: ["charge_power_gw", "discharge_power_gw", "energy_gwh"] },
];

export function Sizing({ file, validation, storage, surplusOnly, onApply }: {
  file: File | null;
  validation: Validation | null;
  storage: StorageInputs;
  surplusOnly: boolean;
  onApply: (values: Partial<StorageInputs>) => void;
}) {
  const [mode, setMode] = useState<SizingMode>("energy");
  const [target, setTarget] = useState("0");
  const [duration, setDuration] = useState("4");
  const [result, setResult] = useState<SizingResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const selected = MODES.find((item) => item.key === mode)!;
  const inputs = checkInputs(storage, selected.skip);
  const targetValue = Number(target);
  const durationValue = Number(duration);
  const ready = Boolean(file && validation && inputs.valid && target.trim() !== "" && Number.isFinite(targetValue)
    && (mode !== "duration" || durationValue > 0));

  const run = async () => {
    if (!file || !ready) return;
    setBusy(true);
    setError("");
    setApplied(false);
    try {
      setResult(await sizeStorage(file, toSettings(storage, surplusOnly, selected.skip), {
        mode, target_floor_gw: targetValue, ...(mode === "duration" ? { duration_hours: durationValue } : {}),
      }));
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!result) return;
    const round = (value: number) => String(Math.ceil(value * 100) / 100);
    onApply(result.mode === "energy"
      ? { energy_gwh: round(result.energy_gwh) }
      : { charge_power_gw: round(result.charge_power_gw), discharge_power_gw: round(result.discharge_power_gw), energy_gwh: round(result.energy_gwh) });
    setApplied(true);
  };

  const entered = { power: Number(storage.discharge_power_gw), energy: Number(storage.energy_gwh) };

  return (
    <div className="sizing">
      <section className="panel sizing-form">
        <header className="panel-head"><div>
          <h3>Size storage for a target</h3>
          <p>Finds the smallest storage that keeps supply − demand at or above the target in <em>every</em> hour, using the efficiency, cycle limit, SOC levels and charging rule entered on the left.</p>
        </div></header>
        <div className="mode-cards" role="radiogroup" aria-label="What to size">
          {MODES.map((item) => (
            <button key={item.key} type="button" role="radio" aria-checked={mode === item.key}
              className={mode === item.key ? "is-selected" : ""} onClick={() => { setMode(item.key); setResult(null); setError(""); }}>
              <strong>{item.label}</strong><span>{item.detail}</span>
            </button>
          ))}
        </div>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="target-floor">Target lowest gap</label>
            <div className="input-unit"><input id="target-floor" type="number" step="any" value={target} onChange={(event) => setTarget(event.target.value)} /><span>GW</span></div>
            <p className="field-note">0 means no shortage in any hour.</p>
          </div>
          {mode === "duration" ? (
            <div className="field">
              <label htmlFor="target-duration">Duration</label>
              <div className="input-unit"><input id="target-duration" type="number" step="any" min="0" value={duration} onChange={(event) => setDuration(event.target.value)} /><span>h</span></div>
            </div>
          ) : null}
        </div>
        {!file || !validation ? <p className="field-note">Upload hourly data first.</p>
          : !inputs.valid ? <p className="field-note">Complete the other storage and operation inputs on the left.</p> : null}
        {validation ? <p className="field-note">Without storage the lowest gap is {num(validation.raw.minimum_gap_gw, 2)} GW.</p> : null}
        <button type="button" className="run-button" disabled={!ready || busy} onClick={run}>
          <Ruler size={16} aria-hidden="true" /> {busy ? "Sizing…" : "Find minimum size"}
        </button>
        {error ? <p className="inline-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{error}</p> : null}
      </section>

      <section className="panel sizing-result" aria-live="polite">
        {result ? (
          <>
            <p className="eyebrow">Minimum storage for a lowest gap of {num(result.target_floor_gw, 2)} GW</p>
            <div className="size-figures">
              <div className={result.mode !== "energy" ? "is-sized" : ""}><span>Power</span><strong>{num(result.discharge_power_gw, 2)}</strong><small>GW</small></div>
              <div className={result.mode !== "power" ? "is-sized" : ""}><span>Energy</span><strong>{num(result.energy_gwh, 1)}</strong><small>GWh</small></div>
              <div><span>Duration</span><strong>{num(result.energy_gwh / result.discharge_power_gw, 2)}</strong><small>h</small></div>
            </div>
            {Number.isFinite(entered.energy) && entered.energy > 0 && result.mode === "energy" ? (
              <SizeCompare label="Energy" entered={entered.energy} required={result.energy_gwh} unit="GWh" />
            ) : null}
            {Number.isFinite(entered.power) && entered.power > 0 && result.mode !== "energy" ? (
              <SizeCompare label="Power" entered={entered.power} required={result.discharge_power_gw} unit="GW" />
            ) : null}
            <p className="verdict-note">Check with the dispatch model: lowest gap {num(result.check_floor_gw, 3)} GW, shortage {num(result.check_shortage_gwh, 2)} GWh (whole-period optimum).</p>
            <button type="button" className="secondary-button" onClick={apply}>{applied ? "Applied — run the optimisation to see the schedule" : "Use this size"}</button>
          </>
        ) : (
          <div className="sizing-empty">
            <Ruler size={28} aria-hidden="true" />
            <p>The required size appears here, checked against the dispatch model.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function SizeCompare({ label, entered, required, unit }: { label: string; entered: number; required: number; unit: string }) {
  const top = Math.max(entered, required);
  const ratio = required / entered;
  return (
    <div className="compare">
      <div className="compare-head"><span>{label} vs entered</span><b>{ratio >= 1 ? `${num((ratio - 1) * 100, 0)}% more needed` : `${num((1 - ratio) * 100, 0)}% less needed`}</b></div>
      <div className="compare-row"><span>Entered</span><div className="compare-track"><div className="compare-bar is-before" style={{ width: `${(entered / top) * 100}%` }} /></div><strong>{num(entered, 1)} <small>{unit}</small></strong></div>
      <div className="compare-row"><span>Required</span><div className="compare-track"><div className="compare-bar is-after" style={{ width: `${(required / top) * 100}%` }} /></div><strong>{num(required, 1)} <small>{unit}</small></strong></div>
    </div>
  );
}
