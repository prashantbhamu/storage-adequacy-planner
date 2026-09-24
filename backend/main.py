from __future__ import annotations

import json
import sys
import threading
import time
import uuid
from collections import OrderedDict
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .data_io import preview_table, validate_uploaded_table, validation_response
from .exporter import build_results_workbook
from .optimizer import (
    METHOD_OBJECTIVES,
    VERSION,
    StorageSpec,
    optimize_storage,
    storage_spec_dict,
    suggest_cyclic_soc,
)
from .sizing import size_storage


# In the packaged Windows app, bundled files live in PyInstaller's unpack folder.
APP_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
DIST_DIR = APP_ROOT / "frontend" / "dist"
EXAMPLE_FILE = APP_ROOT / "examples" / "synthetic_fy2029_30.csv"
MAX_STORED_EXPORTS = 20
MAX_STORED_JOBS = 20

app = FastAPI(title="Storage Adequacy Planner", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

LOCAL_HOSTS = {"127.0.0.1", "localhost"}
DEV_ORIGINS = {"http://127.0.0.1:5173", "http://localhost:5173"}
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


@app.middleware("http")
async def local_requests_only(request, call_next):
    """Serve only this computer's own pages.

    The Host check defeats DNS rebinding (a website pointing its own name at
    127.0.0.1 to read results); the Origin check stops other websites from
    starting work here through the visitor's browser.
    """
    host = request.headers.get("host", "")
    if host.rsplit(":", 1)[0] not in LOCAL_HOSTS:
        return JSONResponse({"detail": "Only local requests are accepted."}, status_code=403)
    origin = request.headers.get("origin")
    if origin and origin not in {f"http://{host}"} | DEV_ORIGINS:
        return JSONResponse({"detail": "Requests from other websites are not accepted."}, status_code=403)
    return await call_next(request)


_exports: OrderedDict[str, tuple[str, bytes]] = OrderedDict()
_jobs: OrderedDict[str, dict] = OrderedDict()
_jobs_lock = threading.Lock()

# One heavy calculation at a time, off the request thread, so the interface stays
# responsive while a full-year run keeps a CPU busy; later requests wait in order.
_compute = threading.Lock()
_queue: list[str] = []


@contextmanager
def _compute_turn(ticket: str, on_start=None):
    with _jobs_lock:
        _queue.append(ticket)
    try:
        with _compute:
            with _jobs_lock:
                _queue.remove(ticket)
            if on_start is not None:
                on_start()
            yield
    finally:
        with _jobs_lock:
            if ticket in _queue:
                _queue.remove(ticket)


def _runs_ahead(ticket: str) -> int:
    """Calculations that will finish before this one starts (including the running one)."""
    with _jobs_lock:
        if ticket not in _queue:
            return 0
        return _queue.index(ticket) + (1 if _compute.locked() else 0)


def _in_turn(work):
    """Run ``work`` in a worker thread once it is this request's turn to compute."""
    def run():
        with _compute_turn(uuid.uuid4().hex):
            return work()
    return run_in_threadpool(run)


def _error(error: Exception) -> HTTPException:
    if isinstance(error, HTTPException):
        return error
    return HTTPException(status_code=400, detail=str(error))


async def _file_bytes(file: UploadFile) -> bytes:
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The file is larger than 25 MB.")
    return content


def _spec_from_settings(settings: dict, sized: tuple[str, ...] = ()) -> StorageSpec:
    """Build a StorageSpec from API settings.

    Initial and final SOC are required; the SOC operating range defaults to
    0-100% and charging defaults to surplus hours only. Fields listed in
    ``sized`` are chosen by the sizing LP and may be omitted.
    """

    def value(key: str, default: float | None = None) -> float:
        raw = settings.get(key)
        if raw in (None, ""):
            if key in sized:
                return 1.0
            if default is None:
                raise ValueError(f"Missing storage setting: {key}.")
            return default
        return float(raw)

    surplus_only = settings.get("charge_from_surplus_only", True)
    if not isinstance(surplus_only, bool):
        raise ValueError("charge_from_surplus_only must be true or false.")
    spec = StorageSpec(
        charge_power_gw=value("charge_power_gw"),
        discharge_power_gw=value("discharge_power_gw"),
        energy_gwh=value("energy_gwh"),
        rte=value("rte_percent") / 100.0,
        max_cycles_per_accounting_day=value("max_cycles_per_accounting_day"),
        initial_soc_fraction=value("initial_soc_percent") / 100.0,
        final_soc_fraction=value("final_soc_percent") / 100.0,
        min_soc_fraction=value("min_soc_percent", 0.0) / 100.0,
        max_soc_fraction=value("max_soc_percent", 100.0) / 100.0,
        charge_from_surplus_only=surplus_only,
    )
    spec.validate()
    return spec


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ready",
        "version": VERSION,
        "algorithm": "progressive leximin",
        "engine": "SciPy",
        "solver": "HiGHS",
        "time_step": "1 hour",
        "horizon_hours": 48,
        "commit_hours": 24,
    }


@app.get("/api/example")
def example() -> FileResponse:
    """The public synthetic financial year, for trying the tool without private data."""
    return FileResponse(EXAMPLE_FILE, media_type="text/csv", filename=EXAMPLE_FILE.name,
                        headers={"Cache-Control": "no-store"})


@app.post("/api/preview")
async def preview(file: UploadFile = File(...)) -> dict:
    try:
        return preview_table(await _file_bytes(file), file.filename or "upload")
    except Exception as error:
        raise _error(error) from error


@app.post("/api/validate")
async def validate(
    file: UploadFile = File(...),
    mapping: str | None = Form(None),
) -> dict:
    try:
        parsed_mapping = json.loads(mapping) if mapping else None
        validated = validate_uploaded_table(
            await _file_bytes(file), file.filename or "upload", parsed_mapping
        )
        return validation_response(validated)
    except Exception as error:
        raise _error(error) from error


def _json_safe_result(run_id: str, validated, spec: StorageSpec, result) -> dict:
    hourly = []
    for index, timestamp in enumerate(result.timestamps):
        hourly.append(
            {
                "timestamp": timestamp.isoformat(sep=" "),
                "demand_gw": float(result.demand[index]),
                "supply_gw": float(result.supply[index]),
                "raw_gap_gw": float(result.raw_gap[index]),
                "charge_gw": float(result.charge[index]),
                "discharge_gw": float(result.discharge[index]),
                "dispatch_gw": float(result.dispatch[index]),
                "adjusted_supply_gw": float(result.adjusted_supply[index]),
                "residual_gap_gw": float(result.residual_gap[index]),
                "soc_end_gwh": float(result.soc_end[index]),
                "accounting_day": result.accounting_days[index],
            }
        )
    return {
        "run_id": run_id,
        "period": {
            "type": validated.period_type,
            "label": validated.period_label,
            "hours": len(validated.timestamps),
            "start": validated.timestamps[0].isoformat(sep=" "),
            "end": validated.timestamps[-1].isoformat(sep=" "),
        },
        "storage": storage_spec_dict(spec),
        "summary": result.summary,
        "validation": result.validation,
        "benchmark": result.benchmark,
        "limits": result.limits,
        "sensitivity": result.sensitivity,
        "daily_performance": result.daily_performance,
        "hourly": hourly,
        "method": {
            "version": VERSION,
            "algorithm": "progressive leximin",
            "rolling_horizon_hours": 48,
            "commit_hours": 24,
            "soc": (
                f"user-defined: starts at {100 * spec.initial_soc_fraction:g}% and ends at "
                f"{100 * spec.final_soc_fraction:g}% of energy capacity; operating range "
                f"{100 * spec.min_soc_fraction:g}-{100 * spec.max_soc_fraction:g}%"
            ),
            "charging": (
                "surplus hours only" if spec.charge_from_surplus_only else "any hour"
            ),
            "accounting_boundary": "06:00-to-06:00; partial days receive a prorated cycle allowance",
            "anchor": "rolling windows follow the whole-period perfect-foresight SOC trajectory",
            "objective": list(METHOD_OBJECTIVES),
            "hour_count_tolerance_gw": 1e-6,
        },
    }


def _run_optimization(content: bytes, filename: str, mapping: str | None,
                      settings: str, progress=None) -> dict:
    parsed_mapping = json.loads(mapping) if mapping else None
    spec = _spec_from_settings(json.loads(settings))
    validated = validate_uploaded_table(content, filename, parsed_mapping)
    result = optimize_storage(
        validated.timestamps,
        validated.demand,
        validated.supply,
        spec,
        progress=progress,
    )
    run_id = uuid.uuid4().hex
    export = build_results_workbook(validated, spec, result)
    export_name = f"storage_adequacy_planner_{validated.period_label.replace(' ', '_')}.xlsx"
    with _jobs_lock:
        _exports[run_id] = (export_name, export)
        while len(_exports) > MAX_STORED_EXPORTS:
            _exports.popitem(last=False)
    return _json_safe_result(run_id, validated, spec, result)


@app.post("/api/optimize")
async def optimize(
    file: UploadFile = File(...),
    mapping: str | None = Form(None),
    settings: str = Form(...),
) -> dict:
    content = await _file_bytes(file)
    try:
        return await _in_turn(lambda: _run_optimization(
            content, file.filename or "upload", mapping, settings
        ))
    except Exception as error:
        raise _error(error) from error


@app.post("/api/jobs")
async def start_job(
    file: UploadFile = File(...),
    mapping: str | None = Form(None),
    settings: str = Form(...),
) -> dict:
    """Start an optimisation in the background; poll ``/api/jobs/{id}``."""
    content = await _file_bytes(file)
    filename = file.filename or "upload"
    try:
        # Fail fast on bad settings or input before starting a thread.
        _spec_from_settings(json.loads(settings))
        validate_uploaded_table(content, filename, json.loads(mapping) if mapping else None)
    except Exception as error:
        raise _error(error) from error

    job_id = uuid.uuid4().hex
    job = {"state": "running", "stage": "queued", "done": 0, "total": 1,
           "started": time.time(), "result": None, "error": None}
    with _jobs_lock:
        _jobs[job_id] = job
        while len(_jobs) > MAX_STORED_JOBS:
            _jobs.popitem(last=False)

    def progress(stage: str, done: int, total: int) -> None:
        job.update(stage=stage, done=done, total=total)

    def work() -> None:
        try:
            # The clock starts when the job's turn comes, so time estimates exclude waiting.
            with _compute_turn(job_id, on_start=lambda: job.update(started=time.time())):
                job["result"] = _run_optimization(content, filename, mapping, settings, progress)
            job["state"] = "done"
        except Exception as error:  # reported to the client, not raised
            job["error"] = str(error)
            job["state"] = "error"

    threading.Thread(target=work, daemon=True).start()
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="This run is no longer available.")
    return {
        "state": job["state"],
        "stage": job["stage"],
        "done": job["done"],
        "total": job["total"],
        "elapsed_seconds": time.time() - job["started"],
        "runs_ahead": _runs_ahead(job_id),
        "error": job["error"],
        "result": job["result"] if job["state"] == "done" else None,
    }


@app.post("/api/suggest-soc")
async def suggest_soc(
    file: UploadFile = File(...),
    mapping: str | None = Form(None),
    settings: str = Form(...),
) -> dict:
    """Cyclic SOC (start = end) for the entered storage; initial/final are ignored."""
    try:
        parsed_mapping = json.loads(mapping) if mapping else None
        parsed = json.loads(settings)
        parsed.setdefault("initial_soc_percent", parsed.get("min_soc_percent") or 0)
        parsed.setdefault("final_soc_percent", parsed.get("min_soc_percent") or 0)
        spec = _spec_from_settings(parsed)
        validated = validate_uploaded_table(
            await _file_bytes(file), file.filename or "upload", parsed_mapping
        )
        return await _in_turn(lambda: suggest_cyclic_soc(
            validated.timestamps, validated.demand, validated.supply, spec
        ))
    except Exception as error:
        raise _error(error) from error


@app.post("/api/size")
async def size(
    file: UploadFile = File(...),
    mapping: str | None = Form(None),
    settings: str = Form(...),
    sizing: str = Form(...),
) -> dict:
    try:
        parsed_mapping = json.loads(mapping) if mapping else None
        parsed_sizing = json.loads(sizing)
        mode = parsed_sizing.get("mode")
        sized = {
            "energy": ("energy_gwh",),
            "power": ("charge_power_gw", "discharge_power_gw"),
            "duration": ("charge_power_gw", "discharge_power_gw", "energy_gwh"),
        }.get(mode, ())
        spec = _spec_from_settings(json.loads(settings), sized)
        validated = validate_uploaded_table(
            await _file_bytes(file), file.filename or "upload", parsed_mapping
        )
        duration = parsed_sizing.get("duration_hours")
        target = float(parsed_sizing.get("target_floor_gw", 0.0))
        return await _in_turn(lambda: size_storage(
            validated.timestamps,
            validated.demand,
            validated.supply,
            spec,
            mode,
            target,
            float(duration) if duration not in (None, "") else None,
        ))
    except Exception as error:
        raise _error(error) from error


@app.get("/api/download/{run_id}")
def download(run_id: str) -> Response:
    if run_id not in _exports:
        raise HTTPException(status_code=404, detail="This result is no longer available.")
    filename, content = _exports[run_id]
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")
