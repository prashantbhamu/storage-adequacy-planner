from __future__ import annotations

import json
import uuid
from collections import OrderedDict
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from .data_io import preview_table, validate_uploaded_table, validation_response
from .exporter import build_results_workbook
from .optimizer import METHOD_OBJECTIVES, VERSION, StorageSpec, optimize_storage, storage_spec_dict


APP_ROOT = Path(__file__).resolve().parents[1]
DIST_DIR = APP_ROOT / "frontend" / "dist"
MAX_STORED_EXPORTS = 5

app = FastAPI(title="Storage Floor-Lifting Optimiser v2", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_exports: OrderedDict[str, tuple[str, bytes]] = OrderedDict()


def _error(error: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(error))


async def _file_bytes(file: UploadFile) -> bytes:
    return await file.read()


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
                "solar_gw": float(result.solar[index]) if validated.solar_provided else None,
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
        "daily_performance": result.daily_performance,
        "hourly": hourly,
        "method": {
            "version": VERSION,
            "algorithm": "progressive leximin",
            "rolling_horizon_hours": 48,
            "commit_hours": 24,
            "soc": "continuous; zero only at study start and end",
            "accounting_boundary": "06:00-to-06:00",
            "objective": list(METHOD_OBJECTIVES),
            "solar": "optional legacy reference only; not required or used to select dispatch",
            "hour_count_tolerance_gw": 1e-6,
        },
    }


@app.post("/api/optimize")
async def optimize(
    file: UploadFile = File(...),
    mapping: str | None = Form(None),
    settings: str = Form(...),
) -> dict:
    try:
        parsed_mapping = json.loads(mapping) if mapping else None
        parsed_settings = json.loads(settings)
        validated = validate_uploaded_table(
            await _file_bytes(file), file.filename or "upload", parsed_mapping
        )
        spec = StorageSpec(
            charge_power_gw=float(parsed_settings["charge_power_gw"]),
            discharge_power_gw=float(parsed_settings["discharge_power_gw"]),
            energy_gwh=float(parsed_settings["energy_gwh"]),
            rte=float(parsed_settings["rte_percent"]) / 100.0,
            max_cycles_per_accounting_day=float(
                parsed_settings["max_cycles_per_accounting_day"]
            ),
        )
        result = optimize_storage(
            validated.timestamps,
            validated.demand,
            validated.supply,
            validated.solar,
            spec,
        )
        run_id = uuid.uuid4().hex
        export = build_results_workbook(validated, spec, result)
        filename = f"storage_optimisation_v2_{validated.period_label.replace(' ', '_')}.xlsx"
        _exports[run_id] = (filename, export)
        while len(_exports) > MAX_STORED_EXPORTS:
            _exports.popitem(last=False)
        return _json_safe_result(run_id, validated, spec, result)
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
