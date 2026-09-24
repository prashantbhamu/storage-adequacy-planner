import type {
  JobStatus,
  RunResult,
  SizingMode,
  SizingResult,
  SocSuggestion,
  Validation,
} from "./types";

export type Settings = Record<string, number | boolean>;

async function json<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail ?? `The local service returned ${response.status}.`);
  }
  return payload as T;
}

function form(file: File, fields: Record<string, unknown> = {}) {
  const body = new FormData();
  body.append("file", file);
  for (const [key, value] of Object.entries(fields)) body.append(key, JSON.stringify(value));
  return body;
}

export function validateFile(file: File, signal?: AbortSignal) {
  return fetch("/api/validate", { method: "POST", body: form(file), signal }).then(json<Validation>);
}

export async function loadExample() {
  const response = await fetch("/api/example", { cache: "no-store" });
  if (!response.ok) throw new Error("The example file is not available.");
  return new File([await response.blob()], "synthetic_fy2029_30.csv", { type: "text/csv" });
}

export function suggestSoc(file: File, settings: Settings) {
  return fetch("/api/suggest-soc", { method: "POST", body: form(file, { settings }) }).then(json<SocSuggestion>);
}

export function sizeStorage(
  file: File,
  settings: Settings,
  sizing: { mode: SizingMode; target_floor_gw: number; duration_hours?: number },
) {
  return fetch("/api/size", { method: "POST", body: form(file, { settings, sizing }) }).then(json<SizingResult>);
}

/** Start a background run and poll it until it finishes. */
export async function runOptimisation(
  file: File,
  settings: Settings,
  onProgress: (status: JobStatus) => void,
  signal: AbortSignal,
): Promise<RunResult> {
  const { job_id } = await fetch("/api/jobs", {
    method: "POST",
    body: form(file, { settings }),
    signal,
  }).then(json<{ job_id: string }>);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const status = await fetch(`/api/jobs/${job_id}`, { signal }).then(json<JobStatus>);
    onProgress(status);
    if (status.state === "done" && status.result) return status.result;
    if (status.state === "error") throw new Error(status.error ?? "The optimisation failed.");
  }
}

export async function downloadWorkbook(runId: string) {
  const response = await fetch(`/api/download/${runId}`);
  if (!response.ok) throw new Error("This result is no longer available. Run the optimisation again.");
  const blob = await response.blob();
  const match = (response.headers.get("content-disposition") ?? "").match(/filename="([^"]+)"/);
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = match?.[1] ?? "storage_adequacy_planner_results.xlsx";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}
