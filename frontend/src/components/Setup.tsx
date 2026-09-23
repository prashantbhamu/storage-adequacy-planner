import { CircleAlert, FileSpreadsheet, FlaskConical, Link2, Link2Off, Play, RefreshCw, Square, Upload, Wand2 } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { num } from "../format";
import type { SocSuggestion, StorageInputs, Validation } from "../types";
import type { FieldErrors } from "../inputs";

type FieldProps = {
  id: keyof StorageInputs;
  label: string;
  unit: string;
  value: string;
  error?: string;
  hint?: ReactNode;
  disabled?: boolean;
  onChange: (value: string) => void;
};

function Field({ id, label, unit, value, error, hint, disabled, onChange }: FieldProps) {
  return (
    <div className={`field ${error ? "has-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <div className="input-unit">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          step="any"
          min="0"
          value={value}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error || hint ? `${id}-note` : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        <span>{unit}</span>
      </div>
      {error ? <p id={`${id}-note`} className="field-note error">{error}</p>
        : hint ? <p id={`${id}-note`} className="field-note">{hint}</p> : null}
    </div>
  );
}

/** Lowest gap per day across the upload; red below zero. */
function Sparkline({ days }: { days: Validation["daily_minimum_gap_gw"] }) {
  if (days.length < 2) return null;
  const values = days.map((item) => item.gap_gw);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const y = (value: number) => 36 - ((value - low) / (high - low || 1)) * 32;
  const x = (index: number) => (index / (days.length - 1)) * 200;
  const line = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  const zero = y(0);
  return (
    <figure className="sparkline">
      <svg viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
        <clipPath id="spark-below"><rect x="0" y={zero} width="200" height={40 - zero} /></clipPath>
        <path d={`${line} L200 ${zero} L0 ${zero} Z`} className="spark-deficit" clipPath="url(#spark-below)" />
        <line x1="0" x2="200" y1={zero} y2={zero} className="spark-zero" />
        <path d={line} className="spark-line" />
      </svg>
      <figcaption>Lowest gap each day, before storage</figcaption>
    </figure>
  );
}

function Section({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <section className="setup-section" aria-labelledby={`setup-${step}`}>
      <h2 id={`setup-${step}`}><span>{step}</span>{title}</h2>
      {children}
    </section>
  );
}

export function Setup(props: {
  file: File | null;
  validation: Validation | null;
  validating: boolean;
  validationError: string;
  onFile: (file: File | null) => void;
  onExample: () => void;
  loadingExample: boolean;
  storage: StorageInputs;
  errors: FieldErrors;
  onStorage: (field: keyof StorageInputs, value: string) => void;
  linkedPower: boolean;
  onLinkedPower: (linked: boolean) => void;
  surplusOnly: boolean;
  onSurplusOnly: (value: boolean) => void;
  suggestion: SocSuggestion | null;
  suggesting: boolean;
  suggestError: string;
  canSuggest: boolean;
  onSuggest: () => void;
  readiness: string;
  canRun: boolean;
  running: boolean;
  hasResult: boolean;
  stale: boolean;
  onRun: () => void;
  onCancel: () => void;
}) {
  const { storage, errors, onStorage } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const energy = Number(storage.energy_gwh);
  const discharge = Number(storage.discharge_power_gw);
  const duration = energy > 0 && discharge > 0 ? energy / discharge : null;
  const field = (id: keyof StorageInputs, label: string, unit: string, hint?: ReactNode, disabled?: boolean) => (
    <Field id={id} label={label} unit={unit} value={storage[id]} error={errors[id]} hint={hint}
      disabled={disabled} onChange={(value) => onStorage(id, value)} />
  );

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) props.onFile(dropped);
  };

  return (
    <aside className="setup" aria-label="Study setup">
      <div className="setup-scroll">
        <Section step={1} title="Hourly data">
          <div
            className={`dropzone ${dragging ? "is-dragging" : ""} ${props.validation ? "is-loaded" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
          >
            <input
              ref={inputRef}
              id="upload"
              type="file"
              accept=".xlsx,.csv"
              className="visually-hidden"
              onChange={(event) => props.onFile(event.target.files?.[0] ?? null)}
            />
            {props.file ? (
              <div className="file-line">
                <FileSpreadsheet size={18} aria-hidden="true" />
                <span className="file-name" title={props.file.name}>{props.file.name}</span>
                <button type="button" className="link-button" onClick={() => inputRef.current?.click()}>Replace</button>
              </div>
            ) : (
              <button type="button" className="dropzone-empty" onClick={() => inputRef.current?.click()}>
                <Upload size={20} aria-hidden="true" />
                <strong>Choose or drop a file</strong>
                <span>.xlsx or .csv · Timestamp, Demand (GW), Available Supply (GW)</span>
              </button>
            )}
            {!props.file ? (
              <button type="button" className="link-button example-link" onClick={props.onExample} disabled={props.loadingExample}>
                <FlaskConical size={13} aria-hidden="true" /> {props.loadingExample ? "Loading example…" : "or try the example year"}
              </button>
            ) : null}
            {props.validating ? <p className="dropzone-status">Checking the file…</p> : null}
            {props.validation ? (
              <dl className="data-facts">
                <div><dt>Period</dt><dd>{props.validation.period_label}</dd></div>
                <div><dt>Hours</dt><dd>{props.validation.row_count.toLocaleString("en-IN")}</dd></div>
                <div><dt>Lowest gap</dt><dd className={props.validation.raw.minimum_gap_gw < 0 ? "negative" : ""}>{num(props.validation.raw.minimum_gap_gw)} GW</dd></div>
                <div><dt>Shortage</dt><dd>{num(props.validation.raw.shortage_energy_gwh, 0)} GWh<small>{props.validation.raw.shortage_hours.toLocaleString("en-IN")} short hours</small></dd></div>
              </dl>
            ) : null}
            {props.validation ? <Sparkline days={props.validation.daily_minimum_gap_gw} /> : null}
          </div>
          {props.validationError ? (
            <p className="inline-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{props.validationError}</p>
          ) : null}
        </Section>

        <Section step={2} title="Storage">
          <div className="field-grid">
            {field("charge_power_gw", "Charge power", "GW")}
            <div className="field-with-action">
              {field("discharge_power_gw", "Discharge power", "GW", undefined, props.linkedPower)}
              <button
                type="button"
                className={`icon-toggle ${props.linkedPower ? "is-on" : ""}`}
                aria-pressed={props.linkedPower}
                title={props.linkedPower ? "Discharge power follows charge power" : "Set discharge power separately"}
                onClick={() => props.onLinkedPower(!props.linkedPower)}
              >
                {props.linkedPower ? <Link2 size={14} /> : <Link2Off size={14} />}
                <span className="visually-hidden">Same as charge power</span>
              </button>
            </div>
            {field("energy_gwh", "Energy capacity", "GWh", duration ? `${num(duration, 1)} h at full discharge` : undefined)}
            {field("rte_percent", "Round-trip efficiency", "%")}
          </div>
          {field("max_cycles_per_accounting_day", "Maximum cycles per day", "cycles", "Equivalent full cycles per 06:00–06:00 day")}
        </Section>

        <Section step={3} title="Operation">
          <div className="field-grid">
            {field("initial_soc_percent", "Initial SOC", "%")}
            {field("final_soc_percent", "Final SOC", "%")}
          </div>
          <div className="suggest-row">
            <button type="button" className="secondary-button" disabled={!props.canSuggest || props.suggesting} onClick={props.onSuggest}>
              {props.suggesting ? <RefreshCw size={14} className="spin" aria-hidden="true" /> : <Wand2 size={14} aria-hidden="true" />}
              Suggest a cyclic level
            </button>
          </div>
          {props.suggestion ? (
            <p className="field-note suggest-result">
              Start = end at {num(props.suggestion.soc_percent, 1)}% gives the best whole-period result
              (lowest gap {num(props.suggestion.floor_gw, 2)} GW).
            </p>
          ) : null}
          {props.suggestError ? <p className="inline-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{props.suggestError}</p> : null}
          <div className="field-grid">
            {field("min_soc_percent", "Minimum SOC", "%")}
            {field("max_soc_percent", "Maximum SOC", "%")}
          </div>
          <label className="switch-row">
            <input type="checkbox" role="switch" checked={props.surplusOnly} onChange={(event) => props.onSurplusOnly(event.target.checked)} />
            <span className="switch" aria-hidden="true" />
            <span>
              <strong>Charge only from surplus</strong>
              <small>{props.surplusOnly ? "Storage never charges in an hour that is already short." : "Storage may charge in deficit hours to lift a worse hour."}</small>
            </span>
          </label>
        </Section>
      </div>

      <div className="setup-footer">
        <p className={`readiness ${props.canRun ? "is-ready" : ""}`} aria-live="polite">
          {props.stale && props.hasResult && props.canRun ? "Inputs changed since the last run." : props.readiness}
        </p>
        {props.running ? (
          <button type="button" className="run-button is-cancel" onClick={props.onCancel}>
            <Square size={15} aria-hidden="true" /> Stop waiting
          </button>
        ) : (
          <button type="button" className="run-button" disabled={!props.canRun} onClick={props.onRun}>
            {props.hasResult ? <RefreshCw size={16} aria-hidden="true" /> : <Play size={16} fill="currentColor" aria-hidden="true" />}
            {props.hasResult ? "Run again" : "Run optimisation"}
          </button>
        )}
      </div>
    </aside>
  );
}
