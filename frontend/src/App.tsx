import {
  ArrowDownToLine,
  BatteryCharging,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileSpreadsheet,
  Play,
  RotateCcw,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StorageCharts } from "./StorageCharts";
import type {
  Preview,
  RunResult,
  StorageInputs,
  Validation,
} from "./types";

const EMPTY_STORAGE: StorageInputs = {
  charge_power_gw: "",
  discharge_power_gw: "",
  energy_gwh: "",
  rte_percent: "",
  max_cycles_per_accounting_day: "",
};

const METHOD_STEPS = [
  "Charge in surplus hours",
  "Discharge in tight hours",
  "Reduce shortages",
  "Smooth supply and demand",
  "Avoid extra cycling",
];

const STORAGE_FIELDS: Array<[
  keyof StorageInputs,
  string,
  string,
  string,
]> = [
  ["charge_power_gw", "Maximum charge", "GW", "0.00"],
  ["discharge_power_gw", "Maximum discharge", "GW", "0.00"],
  ["energy_gwh", "Energy capacity", "GWh", "0.00"],
  ["rte_percent", "Round-trip efficiency", "%", "0.0"],
  [
    "max_cycles_per_accounting_day",
    "Maximum equivalent cycles per 06:00–06:00 day",
    "cycles",
    "0.00",
  ],
];

async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail ?? "The local service returned an error.");
  }
  return payload as T;
}

function formatNumber(value: number, digits = 2) {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function NumberField({
  label,
  unit,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="number-row">
      <span>{label}<b aria-hidden="true">*</b></span>
      <span className="number-control">
        <input
          aria-label={`${label} ${unit}`}
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <em>{unit}</em>
      </span>
    </label>
  );
}

function ValidationRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="validation-row">
      <span className="validation-icon"><Check size={13} strokeWidth={3} /></span>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StorageFlowGraphic() {
  return (
    <div
      className="storage-flow-art"
      role="img"
      aria-label="A supply wave rises above demand to charge the battery, then the battery discharges when supply falls below demand"
    >
      <svg viewBox="0 0 356 88" aria-hidden="true">
        <defs>
          <linearGradient id="stored-energy" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#087f85" />
            <stop offset="100%" stopColor="#67c7bf" />
          </linearGradient>
          <clipPath id="battery-window">
            <rect x="157" y="24" width="38" height="16" rx="3" />
          </clipPath>
        </defs>

        <g className="profile-panel surplus-panel">
          <rect className="profile-frame" x="2" y="4" width="96" height="54" rx="11" />
          <g className="surplus-profile">
            <path className="profile-area surplus-area" d="M16 39C30 39 34 17 50 17C66 17 70 39 84 39Z" />
            <path className="supply-wave" d="M16 39C30 39 34 17 50 17C66 17 70 39 84 39" />
          </g>
          <path className="demand-line" d="M16 39H84" />
        </g>

        <g className="flow-arrow flow-arrow-charge">
          <path className="flow-track" d="M106 31H122" />
          <path d="M118 27L122 31L118 35" />
        </g>

        <g className="flow-battery storage-panel">
          <rect className="profile-frame" x="130" y="4" width="96" height="54" rx="11" />
          <rect className="battery-shell" x="152" y="19" width="48" height="26" rx="6" />
          <path className="battery-terminal" d="M200 27H204V37H200" />
          <g clipPath="url(#battery-window)">
            <rect className="flow-battery-level" x="157" y="24" width="38" height="16" rx="3" />
          </g>
          <path className="flow-bolt" d="M179 25L172 33H177L174 39L182 30H177Z" />
        </g>

        <g className="flow-arrow flow-arrow-discharge">
          <path className="flow-track" d="M234 31H250" />
          <path d="M246 27L250 31L246 35" />
        </g>

        <g className="profile-panel deficit-panel">
          <rect className="profile-frame" x="258" y="4" width="96" height="54" rx="11" />
          <g className="deficit-profile">
            <path className="profile-area deficit-area" d="M272 23C286 23 290 45 306 45C322 45 326 23 340 23Z" />
            <path className="supply-wave" d="M272 23C286 23 290 45 306 45C322 45 326 23 340 23" />
          </g>
          <path className="demand-line" d="M272 23H340" />
        </g>

        <text x="50" y="77">SURPLUS HOURS</text>
        <text x="178" y="77">STORAGE</text>
        <text x="306" y="77">DEFICIT HOURS</text>
      </svg>
    </div>
  );
}

function EmptyWorkspace() {
  return (
    <section className="empty-workspace">
      <StorageFlowGraphic />
      <h2>Plan when storage should charge and discharge to balance supply and demand.</h2>
      <div className="method-lock">Looks 48 hours ahead · updates every 24 hours · tracks stored energy continuously</div>
      <h3>How it works</h3>
      <ol className="method-sequence">
        {METHOD_STEPS.map((step, index) => (
          <li key={step}>
            <span>{index + 1}</span>
            <strong>{step}</strong>
          </li>
        ))}
      </ol>
      <div className="empty-note">
        <span>Upload hourly Timestamp, Demand (GW) and Available Supply (GW) for a full month or financial year, then enter storage power (GW), capacity (GWh), efficiency (%) and daily cycle limit.</span>
      </div>
    </section>
  );
}

function MetricCard({
  title,
  before,
  after,
  unit,
}: {
  title: string;
  before: number;
  after: number;
  unit: string;
}) {
  return (
    <div className="metric-card">
      <h3>{title}</h3>
      <div className="metric-values">
        <div><span>Before</span><strong>{formatNumber(before)} <small>{unit}</small></strong></div>
        <div><span>After</span><strong className="after-value">{formatNumber(after)} <small>{unit}</small></strong></div>
      </div>
    </div>
  );
}

function ResultsWorkspace({ result }: { result: RunResult }) {
  const dates = useMemo(
    () => Array.from(new Set(result.hourly.map((row) => row.timestamp.slice(0, 10)))),
    [result.hourly],
  );
  const [selectedDate, setSelectedDate] = useState(dates[0]);
  useEffect(() => setSelectedDate(dates[0]), [result.run_id, dates]);
  const dayIndex = Math.max(0, dates.indexOf(selectedDate));
  const chartRows = useMemo(
    () => result.hourly.filter((row) => row.timestamp.startsWith(selectedDate)),
    [result.hourly, selectedDate],
  );

  const changeDay = (offset: number) => {
    const next = Math.min(dates.length - 1, Math.max(0, dayIndex + offset));
    setSelectedDate(dates[next]);
  };

  const download = async () => {
    const response = await fetch(`/api/download/${result.run_id}`);
    if (!response.ok) return;
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = match?.[1] ?? "storage_dispatch_optimiser_results.xlsx";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };

  const summary = result.summary;
  const diagnostics = result.validation.diagnostics;
  const checks = result.validation.checks;
  const daily = result.daily_performance;

  return (
    <section className="results-workspace">
      <div className="results-title-row">
        <div>
          <h2>Results for {result.period.label}</h2>
          <span>{result.period.hours.toLocaleString("en-IN")} hourly records</span>
        </div>
        <button className="download-button" onClick={download}>
          <ArrowDownToLine size={17} /> Download .xlsx
        </button>
      </div>

      <div className="metrics-band">
        <MetricCard
          title="Minimum gap"
          before={summary.minimum_gap_before_gw}
          after={summary.minimum_gap_after_gw}
          unit="GW"
        />
        <MetricCard
          title="Shortage energy"
          before={summary.shortage_energy_before_gwh}
          after={summary.shortage_energy_after_gwh}
          unit="GWh"
        />
        <MetricCard
          title="Shortage hours"
          before={summary.shortage_hours_before}
          after={summary.shortage_hours_after}
          unit="h"
        />
        <div className="metric-card">
          <h3>Equivalent cycles</h3>
          <div className="single-metric">{formatNumber(summary.equivalent_cycles, 3)}</div>
          <span className="metric-caption">over the selected period</span>
        </div>
      </div>

      <div className="chart-heading">
        <div>
          <h3>Residual gap and storage dispatch</h3>
          <span>Before/after gap with signed combined-storage operation</span>
        </div>
        <div className="date-control">
          <button aria-label="Previous day" onClick={() => changeDay(-1)} disabled={dayIndex === 0}>
            <ChevronLeft size={17} />
          </button>
          <select aria-label="Chart day" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)}>
            {dates.map((date) => <option key={date}>{date}</option>)}
          </select>
          <button aria-label="Next day" onClick={() => changeDay(1)} disabled={dayIndex === dates.length - 1}>
            <ChevronRight size={17} />
          </button>
        </div>
      </div>

      <StorageCharts rows={chartRows} energyCapacity={result.storage.energy_gwh}
        chargePower={result.storage.charge_power_gw} dischargePower={result.storage.discharge_power_gw} />

      <div className="results-lower">
        <section className="data-panel">
          <h3>06:00–06:00 accounting-day performance</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Accounting day</th>
                  <th>Min gap<br /><small>before → after</small></th>
                  <th>Shortage GWh<br /><small>before → after</small></th>
                  <th>Hours<br /><small>before → after</small></th>
                  <th>Cycles</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((row) => (
                  <tr key={row.date} className={row.date === selectedDate ? "selected-row" : ""}>
                    <td>{row.date}</td>
                    <td>{formatNumber(row.minimum_gap_before_gw)} → <b>{formatNumber(row.minimum_gap_after_gw)}</b></td>
                    <td>{formatNumber(row.shortage_energy_before_gwh)} → <b>{formatNumber(row.shortage_energy_after_gwh)}</b></td>
                    <td>{row.shortage_hours_before} → <b>{row.shortage_hours_after}</b></td>
                    <td>{formatNumber(row.equivalent_cycles, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="data-panel checks-panel">
          <h3>Constraint checks</h3>
          <CheckRow label="SOC limits" value={`0.00 – ${formatNumber(result.storage.energy_gwh, 2)} GWh`} />
          <CheckRow label="Charge power" value={`${formatNumber(diagnostics.maximum_charge_gw, 3)} GW`} />
          <CheckRow label="Discharge power" value={`${formatNumber(diagnostics.maximum_discharge_gw, 3)} GW`} />
          <CheckRow label="Daily internal charge" value={`${formatNumber(diagnostics.maximum_06_day_internal_charge_gwh, 3)} GWh`} />
          <CheckRow label="Daily internal discharge" value={`${formatNumber(diagnostics.maximum_06_day_internal_discharge_gwh, 3)} GWh`} />
          <CheckRow label="Simultaneous operation" value={`${checks.simultaneous_charge_discharge_gw.toExponential(1)} GW`} />
          <CheckRow label="Terminal SOC" value={`${checks.final_soc_abs_gwh.toExponential(1)} GWh`} />
        </section>
      </div>

      <div className="method-footer">Looks 48 hours ahead · updates every 24 hours · tracks stored energy continuously</div>
    </section>
  );
}

function CheckRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="check-row">
      <span>{label}</span>
      <strong>{value}</strong>
      <em><Check size={13} strokeWidth={3} /> Passed</em>
    </div>
  );
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [storage, setStorage] = useState<StorageInputs>(EMPTY_STORAGE);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [validationError, setValidationError] = useState("");
  const [runError, setRunError] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  const assumptionsValid = Object.entries(storage).every(([key, value]) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return false;
    return key !== "rte_percent" || number <= 100;
  });
  const runReadiness = !file
    ? "Upload a valid input file to continue."
    : !validation
      ? "Waiting for the input file to pass validation."
      : !assumptionsValid
        ? "Enter all five storage assumptions to enable the run."
        : "Ready to optimise locally.";

  const upload = (selected: File | null) => {
    setFile(selected);
    setPreview(null);
    setValidation(null);
    setValidationError("");
    setRunError("");
    setResult(null);
  };

  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    const validateUpload = async () => {
      try {
        const body = new FormData();
        body.append("file", file);
        const [nextPreview, nextValidation] = await Promise.all([
          fetch("/api/preview", { method: "POST", body, signal: controller.signal }).then(responseJson<Preview>),
          fetch("/api/validate", { method: "POST", body, signal: controller.signal }).then(responseJson<Validation>),
        ]);
        if (controller.signal.aborted) return;
        setPreview(nextPreview);
        setValidation(nextValidation);
        setValidationError("");
      } catch (error) {
        if (!controller.signal.aborted) {
          setValidation(null);
          setValidationError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void validateUpload();
    return () => controller.abort();
  }, [file]);

  const run = async () => {
    if (!file || !validation || !assumptionsValid) return;
    setLoading(true);
    setRunError("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("settings", JSON.stringify(storage));
      const response = await fetch("/api/optimize", { method: "POST", body });
      setResult(await responseJson<RunResult>(response));
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const resetResult = () => {
    setResult(null);
    setRunError("");
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <span className="brand-symbol" aria-hidden="true"><BatteryCharging size={22} strokeWidth={1.6} /></span>
          <h1>Storage Dispatch Optimiser</h1>
        </div>
      </header>

      <div className="main-layout">
        <aside className="control-rail">
          <section className="rail-section upload-section">
            <h2>1. Upload hourly data</h2>
            <p>Choose .xlsx or .csv</p>
            <p className="input-requirements">Required headers: <strong>Timestamp</strong>, <strong>Demand (GW)</strong>, <strong>Available Supply (GW)</strong>.</p>
            <label className="upload-box">
              <input
                type="file"
                accept=".xlsx,.csv"
                onChange={(event) => upload(event.target.files?.[0] ?? null)}
              />
              <Upload size={28} strokeWidth={1.7} />
              <span className="choose-file">Choose file</span>
              <strong>{file?.name ?? "No file selected"}</strong>
              {preview ? <small>{preview.row_count.toLocaleString("en-IN")} rows · {preview.sheet_name ?? "CSV"}</small> : null}
            </label>
          </section>

          <section className="rail-section assumptions-section">
            <h2>2. Storage assumptions</h2>
            {STORAGE_FIELDS.map(([field, label, unit, placeholder]) => (
              <NumberField
                key={field}
                label={label}
                unit={unit}
                placeholder={placeholder}
                value={storage[field]}
                onChange={(value) => setStorage((current) => ({ ...current, [field]: value }))}
              />
            ))}
          </section>

          <section className="rail-section validation-section">
            <h2>Validation</h2>
            {validation ? (
              <>
                <ValidationRow label="Complete-hour chronology" value="OK" />
                <ValidationRow label="Month / FY detection" value={validation.period_label} />
                <ValidationRow label="No missing timestamps" value="OK" />
              </>
            ) : (
              <p className="validation-hint">
                Expected: one complete calendar month or one April–March financial year. All timestamps hourly.
              </p>
            )}
            {validationError ? <div className="error-message" role="alert"><CircleAlert size={16} />{validationError}</div> : null}
            {runError ? <div className="error-message" role="alert"><CircleAlert size={16} />{runError}</div> : null}
            <p
              id="run-readiness"
              className={`run-readiness ${validation && assumptionsValid ? "is-ready" : ""}`}
              aria-live="polite"
            >
              {runReadiness}
            </p>
            <button
              className="run-button"
              aria-describedby="run-readiness"
              disabled={!validation || !assumptionsValid || loading}
              onClick={result ? resetResult : run}
            >
              {result ? <RotateCcw size={19} /> : <Play size={19} fill="currentColor" />}
              {result ? "Run again" : loading ? "Optimising…" : "Run optimisation"}
            </button>
          </section>
        </aside>

        <main className="workspace">
          {loading ? (
            <div className="loading-state">
              <BatteryCharging size={48} />
              <h2>Optimising {validation?.period_label}</h2>
              <p>HiGHS is solving the rolling 48-hour horizons locally. A full financial year may take several minutes.</p>
              <div className="loading-line"><span /></div>
            </div>
          ) : result ? <ResultsWorkspace result={result} /> : <EmptyWorkspace />}
        </main>
      </div>

      <footer className="statusbar">
        <span className="status-ready"><Check size={14} strokeWidth={3} /> Solver status: <b>{loading ? "Running" : result ? "Completed" : "Ready"}</b></span>
        <span>Engine: <b>SciPy</b></span>
        <span>Solver: <b>HiGHS</b></span>
        <span>Time step: <b>1 hour</b></span>
        <span className="status-file"><FileSpreadsheet size={14} /> {file?.name ?? "No file loaded"}</span>
      </footer>
    </div>
  );
}
