import { Check, LoaderCircle } from "lucide-react";
import type { JobStatus } from "../types";

const STAGES: Array<{ key: JobStatus["stage"]; label: string; weight: number }> = [
  { key: "benchmark", label: "Whole-period optimum", weight: 0.06 },
  { key: "horizons", label: "Rolling 48-hour windows", weight: 0.8 },
  { key: "sensitivity", label: "Sensitivity of each limit", weight: 0.14 },
];

export function Progress({ status, periodLabel }: { status: JobStatus | null; periodLabel: string }) {
  const current = STAGES.findIndex((stage) => stage.key === status?.stage);
  const fraction = status && status.total > 0 ? status.done / status.total : 0;
  const overall = STAGES.reduce((sum, stage, index) => {
    if (index < current) return sum + stage.weight;
    if (index === current) return sum + stage.weight * fraction;
    return sum;
  }, 0);
  const elapsed = status?.elapsed_seconds ?? 0;
  const remaining = overall > 0.08 ? Math.max(0, elapsed / overall - elapsed) : null;

  return (
    <section className="progress-card" aria-live="polite" aria-label="Optimisation progress">
      <p className="eyebrow">Optimising {periodLabel}</p>
      <h2>{Math.round(overall * 100)}%</h2>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall * 100)}>
        <span style={{ width: `${overall * 100}%` }} />
      </div>
      <ol className="stage-list">
        {STAGES.map((stage, index) => {
          const state = index < current ? "done" : index === current ? "active" : "waiting";
          return (
            <li key={stage.key} className={`is-${state}`}>
              {state === "done" ? <Check size={15} strokeWidth={3} aria-hidden="true" />
                : state === "active" ? <LoaderCircle size={15} className="spin" aria-hidden="true" />
                  : <span className="stage-dot" aria-hidden="true" />}
              <span>{stage.label}</span>
              {state === "active" && stage.key !== "benchmark" && status ? <em>{status.done} / {status.total}</em> : null}
            </li>
          );
        })}
      </ol>
      <p className="progress-time">
        {Math.round(elapsed)} s elapsed{remaining !== null ? ` · about ${Math.max(1, Math.round(remaining))} s left` : ""} · solved locally with HiGHS
      </p>
    </section>
  );
}
