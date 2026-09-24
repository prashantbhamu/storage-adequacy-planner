import { CircleAlert, Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadWorkbook, loadExample, runOptimisation, suggestSoc, validateFile } from "./api";
import { DailyTable } from "./components/DailyTable";
import { DayDetail } from "./components/DayDetail";
import { ChecksCard, LimitsCard, Tornado } from "./components/Diagnostics";
import { DurationCurve } from "./components/DurationCurve";
import { EmptyState } from "./components/EmptyState";
import { Logo } from "./components/Logo";
import { Heatmap } from "./components/Heatmap";
import { Progress } from "./components/Progress";
import { Setup } from "./components/Setup";
import { Sizing } from "./components/Sizing";
import { Verdict } from "./components/Verdict";
import { num } from "./format";
import { EMPTY_STORAGE, checkInputs, toSettings } from "./inputs";
import { calendarDates, clampStart, tightestDate, type WindowDays } from "./timeWindow";
import type { JobStatus, RunResult, SocSuggestion, StorageInputs, Validation } from "./types";

type ThemeChoice = "system" | "light" | "dark";
type Tab = "results" | "sizing";

function readTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem("theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const resolved = choice === "system" ? (systemDark ? "dark" : "light") : choice;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    try {
      if (choice === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", choice);
    } catch {
      /* storage unavailable; the choice lasts for this session */
    }
  }, [choice, resolved]);
  const next = () => setChoice((current) => (current === "system" ? "light" : current === "light" ? "dark" : "system"));
  return { choice, resolved, next };
}

const RUNS_LOCALLY = ["127.0.0.1", "localhost"].includes(window.location.hostname);
const fileKey = (file: File | null) => (file ? `${file.name}:${file.size}:${file.lastModified}` : "");

export default function App() {
  const theme = useTheme();
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState("");
  const [loadingExample, setLoadingExample] = useState(false);
  const [storage, setStorage] = useState<StorageInputs>(EMPTY_STORAGE);
  const [linkedPower, setLinkedPower] = useState(true);
  const [surplusOnly, setSurplusOnly] = useState(true);
  const [suggestion, setSuggestion] = useState<SocSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState("");
  const [tab, setTab] = useState<Tab>("results");
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [resultKey, setResultKey] = useState("");
  const [selectedDay, setSelectedDay] = useState("");
  const [windowDays, setWindowDays] = useState<WindowDays>(1);
  const [downloadError, setDownloadError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const inputs = checkInputs(storage);
  const settings = useMemo(() => toSettings(storage, surplusOnly), [storage, surplusOnly]);
  const currentKey = `${fileKey(file)}|${JSON.stringify(settings)}`;
  const stale = Boolean(result) && currentKey !== resultKey;
  const canRun = Boolean(file && validation && inputs.valid && !running);
  const readiness = !file ? "Upload hourly data to begin."
    : validating ? "Checking the file…"
      : !validation ? "The file needs fixing before a run."
        : !inputs.complete ? "Fill in every storage and operation input."
          : !inputs.valid ? "Fix the highlighted inputs."
            : "Ready to optimise.";
  const soc = checkInputs(storage, ["initial_soc_percent", "final_soc_percent"]);

  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    setValidating(true);
    validateFile(file, controller.signal)
      .then((next) => { setValidation(next); setValidationError(""); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setValidation(null);
        setValidationError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (!controller.signal.aborted) setValidating(false); });
    return () => controller.abort();
  }, [file]);

  const chooseFile = (next: File | null) => {
    setFile(next);
    setValidation(null);
    setValidationError("");
    setSuggestion(null);
  };

  const example = async () => {
    setLoadingExample(true);
    try {
      chooseFile(await loadExample());
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingExample(false);
    }
  };

  const updateStorage = (field: keyof StorageInputs, value: string) => {
    setStorage((current) => ({
      ...current,
      [field]: value,
      ...(linkedPower && field === "charge_power_gw" ? { discharge_power_gw: value } : {}),
    }));
    if (field !== "initial_soc_percent" && field !== "final_soc_percent") setSuggestion(null);
  };

  const toggleLinked = (linked: boolean) => {
    setLinkedPower(linked);
    if (linked) setStorage((current) => ({ ...current, discharge_power_gw: current.charge_power_gw }));
  };

  const suggest = async () => {
    if (!file) return;
    setSuggesting(true);
    setSuggestError("");
    try {
      const next = await suggestSoc(file, toSettings(storage, surplusOnly, ["initial_soc_percent", "final_soc_percent"]));
      const level = String(Math.round(next.soc_percent * 10) / 10);
      setSuggestion(next);
      setStorage((current) => ({ ...current, initial_soc_percent: level, final_soc_percent: level }));
    } catch (error) {
      setSuggestError(error instanceof Error ? error.message : String(error));
    } finally {
      setSuggesting(false);
    }
  };

  const run = async () => {
    if (!file || !canRun) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const key = currentKey;
    setRunning(true);
    setRunError("");
    setStatus(null);
    setTab("results");
    try {
      const next = await runOptimisation(file, settings, setStatus, controller.signal);
      setResult(next);
      setResultKey(key);
      setDownloadError("");
      setSelectedDay(clampStart(calendarDates(next.hourly), tightestDate(next.hourly), windowDays));
    } catch (error) {
      if (!controller.signal.aborted) setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const download = useCallback(async () => {
    if (!result) return;
    try {
      setDownloadError("");
      await downloadWorkbook(result.run_id);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error));
    }
  }, [result]);

  const days = useMemo(() => (result ? calendarDates(result.hourly) : []), [result]);
  const showDate = useCallback((date: string) => setSelectedDay(clampStart(days, date, windowDays)), [days, windowDays]);
  const ThemeIcon = theme.choice === "system" ? Monitor : theme.choice === "light" ? Sun : Moon;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <h1>Storage Adequacy Planner</h1>
          <span className="brand-tag">hourly storage dispatch</span>
        </div>
        <div className="topbar-right">
          <span className="engine">SciPy · HiGHS · {RUNS_LOCALLY ? "local" : "hosted"}</span>
          <button type="button" className="icon-button" onClick={theme.next}
            aria-label={`Colour theme: ${theme.choice}. Change theme`} title={`Theme: ${theme.choice}`}>
            <ThemeIcon size={16} />
          </button>
        </div>
      </header>

      <div className="layout">
        <Setup
          file={file}
          validation={validation}
          validating={validating}
          validationError={validationError}
          onFile={chooseFile}
          onExample={example}
          loadingExample={loadingExample}
          storage={storage}
          errors={inputs.errors}
          onStorage={updateStorage}
          linkedPower={linkedPower}
          onLinkedPower={toggleLinked}
          surplusOnly={surplusOnly}
          onSurplusOnly={(value) => { setSurplusOnly(value); setSuggestion(null); }}
          suggestion={suggestion}
          suggesting={suggesting}
          suggestError={suggestError}
          canSuggest={Boolean(file && validation && soc.valid)}
          onSuggest={suggest}
          readiness={readiness}
          canRun={canRun}
          running={running}
          hasResult={Boolean(result)}
          stale={stale}
          onRun={run}
          onCancel={cancel}
        />

        <main className="workspace">
          <nav className="tabs" role="tablist" aria-label="Workspace">
            <button type="button" role="tab" aria-selected={tab === "results"} onClick={() => setTab("results")}>Dispatch results</button>
            <button type="button" role="tab" aria-selected={tab === "sizing"} onClick={() => setTab("sizing")}>Size storage</button>
          </nav>

          {tab === "sizing" ? (
            <Sizing file={file} validation={validation} storage={storage} surplusOnly={surplusOnly}
              onApply={(values) => {
                if (values.charge_power_gw !== undefined) setLinkedPower(true);
                setStorage((current) => ({ ...current, ...values }));
              }} />
          ) : running ? (
            <Progress status={status} periodLabel={validation?.period_label ?? ""} />
          ) : (
            <>
              {runError ? (
                <div className="banner is-error" role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{runError}</span></div>
              ) : null}
              {result ? (
                <div className="results">
                  {stale ? (
                    <div className="banner"><CircleAlert size={16} aria-hidden="true" />
                      <span>These results are for the previous inputs. Run again to update them.</span></div>
                  ) : null}
                  <Verdict result={result} onDownload={download} downloadError={downloadError} />
                  <Heatmap hourly={result.hourly} days={days} selectedDay={selectedDay} selectedDays={windowDays} onSelectDay={showDate} theme={theme.resolved} />
                  <div className="grid-2">
                    <DurationCurve hourly={result.hourly} />
                    <LimitsCard result={result} onSelectDay={showDate} />
                  </div>
                  <DayDetail result={result} dates={days} start={selectedDay} days={windowDays} onStart={setSelectedDay} onDays={setWindowDays} />
                  <div className="grid-2">
                    <Tornado result={result} />
                    <ChecksCard result={result} />
                  </div>
                  <DailyTable daily={result.daily_performance} selectedDay={selectedDay} onSelectDay={showDate} />
                </div>
              ) : validation ? (
                <section className="ready">
                  <p className="eyebrow">{validation.period_label} loaded</p>
                  <h2>{readiness}</h2>
                  <dl className="ready-facts">
                    <div><dt>Lowest gap without storage</dt><dd className={validation.raw.minimum_gap_gw < 0 ? "negative" : ""}>{num(validation.raw.minimum_gap_gw, 2)} GW</dd></div>
                    <div><dt>Shortage energy</dt><dd>{num(validation.raw.shortage_energy_gwh, 0)} GWh</dd></div>
                    <div><dt>Short hours</dt><dd>{validation.raw.shortage_hours.toLocaleString("en-IN")}</dd></div>
                    <div><dt>Surplus energy available</dt><dd>{num(validation.raw.surplus_energy_gwh, 0)} GWh</dd></div>
                  </dl>
                  <p>Describe the storage on the left, then run the optimisation. The heatmap, duration curve and daily detail appear here.</p>
                </section>
              ) : (
                <EmptyState onExample={example} loadingExample={loadingExample} />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
