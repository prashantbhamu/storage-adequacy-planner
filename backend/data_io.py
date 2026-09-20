from __future__ import annotations

import io
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd


MAX_UPLOAD_BYTES = 100 * 1024 * 1024
REQUIRED_HEADERS = {
    "timestamp": ("Timestamp", {"timestamp", "datetime", "datehour"}),
    "demand": ("Demand (GW)", {"demand", "demandgw", "currentdemand", "currentdemandgw", "load", "loadgw"}),
    "supply": ("Available Supply (GW)", {"availablesupply", "availablesupplygw", "supply", "supplygw", "maxdispatch", "maxdispatchgw"}),
}


def _normalise_header(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def detect_columns(columns: list[str]) -> dict[str, str]:
    """Match known headers, never choose the first of several plausible columns."""
    mapping = {}
    for field, (label, aliases) in REQUIRED_HEADERS.items():
        # Pandas suffixes duplicate input headers with .1, .2, ...; these still
        # represent ambiguous candidates, not unrelated columns to ignore.
        matches = [column for column in columns
                   if _normalise_header(re.sub(r"\.\d+$", "", column)) in aliases]
        if not matches:
            raise ValueError(
                f"Missing recognised {label} column. Use the headers Timestamp, "
                "Demand (GW), Available Supply (GW). Power values must be in GW."
            )
        if len(matches) > 1:
            raise ValueError(
                f"Ambiguous {label} columns: {', '.join(matches)}. "
                "Keep one scenario and one column for each required input."
            )
        mapping[field] = matches[0]
    return mapping


@dataclass
class ValidatedInput:
    filename: str
    sheet_name: str | None
    period_type: str
    period_label: str
    timestamps: list[datetime]
    demand: np.ndarray
    supply: np.ndarray
    solar: np.ndarray
    raw_frame: pd.DataFrame
    mapping: dict[str, str]
    solar_provided: bool = True


def read_uploaded_table(data: bytes, filename: str) -> tuple[pd.DataFrame, str | None]:
    if not data:
        raise ValueError("The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError("The uploaded file exceeds the 100 MB local-tool limit.")

    suffix = Path(filename).suffix.lower()
    stream = io.BytesIO(data)
    if suffix == ".csv":
        try:
            frame = pd.read_csv(stream)
        except UnicodeDecodeError:
            stream.seek(0)
            frame = pd.read_csv(stream, encoding="latin-1")
        sheet_name = None
    elif suffix == ".xlsx":
        workbook = pd.ExcelFile(stream, engine="openpyxl")
        if not workbook.sheet_names:
            raise ValueError("The workbook has no worksheets.")
        sheet_name = workbook.sheet_names[0]
        frame = pd.read_excel(workbook, sheet_name=sheet_name)
    else:
        raise ValueError("Upload a .xlsx or .csv file.")

    if frame.empty:
        raise ValueError("The first worksheet/table contains no data rows.")
    frame.columns = [str(column).strip() for column in frame.columns]
    if any(not column for column in frame.columns):
        raise ValueError("Every input column must have a header.")
    if len(set(frame.columns)) != len(frame.columns):
        raise ValueError("Duplicate column headers are not supported.")
    return frame, sheet_name


def preview_table(data: bytes, filename: str) -> dict:
    frame, sheet_name = read_uploaded_table(data, filename)
    sample = frame.head(5).copy()
    for column in sample.columns:
        sample[column] = sample[column].map(
            lambda value: None if pd.isna(value) else str(value)
        )
    return {
        "filename": filename,
        "sheet_name": sheet_name,
        "row_count": int(len(frame)),
        "columns": list(frame.columns),
        "sample": sample.to_dict(orient="records"),
    }


def _parse_timestamps(series: pd.Series) -> pd.DatetimeIndex:
    if pd.api.types.is_numeric_dtype(series):
        parsed = pd.to_datetime(series, unit="D", origin="1899-12-30", errors="coerce")
    else:
        parsed = pd.to_datetime(series, errors="coerce", dayfirst=False)
    if parsed.isna().any():
        rows = [str(index + 2) for index in np.flatnonzero(parsed.isna().to_numpy())[:8]]
        raise ValueError(f"Timestamp conversion failed at spreadsheet row(s): {', '.join(rows)}.")
    if getattr(parsed.dt, "tz", None) is not None:
        parsed = parsed.dt.tz_localize(None)
    return pd.DatetimeIndex(parsed)


def _expected_month_range(start: pd.Timestamp) -> pd.DatetimeIndex:
    next_month = start + pd.offsets.MonthBegin(1)
    end = next_month - pd.Timedelta(hours=1)
    return pd.date_range(start=start, end=end, freq="h")


def _expected_fy_range(start: pd.Timestamp) -> pd.DatetimeIndex:
    end = pd.Timestamp(year=start.year + 1, month=4, day=1) - pd.Timedelta(hours=1)
    return pd.date_range(start=start, end=end, freq="h")


def detect_and_validate_period(timestamps: pd.DatetimeIndex) -> tuple[str, str]:
    if len(timestamps) == 0:
        raise ValueError("No timestamps were supplied.")
    if timestamps.has_duplicates:
        raise ValueError("Duplicate timestamps were found.")
    if not timestamps.is_monotonic_increasing:
        raise ValueError("Timestamps must already be sorted in chronological order.")
    if any(
        timestamp.minute != 0
        or timestamp.second != 0
        or timestamp.microsecond != 0
        for timestamp in timestamps
    ):
        raise ValueError("Every timestamp must fall exactly on an hourly boundary.")
    differences = timestamps[1:] - timestamps[:-1]
    if len(differences) and not np.all(differences == pd.Timedelta(hours=1)):
        raise ValueError("The chronology contains one or more missing or irregular hours.")

    first = timestamps[0]
    last = timestamps[-1]
    if first.day == 1 and first.hour == 0:
        expected_month = _expected_month_range(first)
        if len(timestamps) == len(expected_month) and timestamps.equals(expected_month):
            return "month", first.strftime("%B %Y")

    if first.month == 4 and first.day == 1 and first.hour == 0:
        expected_fy = _expected_fy_range(first)
        if len(timestamps) == len(expected_fy) and timestamps.equals(expected_fy):
            return "financial_year", f"FY {first.year}-{str(first.year + 1)[-2:]}"

    raise ValueError(
        "Input must be one complete calendar month or one complete April–March financial year."
    )


def validate_uploaded_table(
    data: bytes,
    filename: str,
    mapping: dict[str, str] | None = None,
) -> ValidatedInput:
    frame, sheet_name = read_uploaded_table(data, filename)
    if mapping is None:
        mapping = detect_columns(list(frame.columns))
    if not isinstance(mapping, dict):
        raise ValueError("Column mapping must be an object.")
    mapping = dict(mapping)
    required = ("timestamp", "demand", "supply")
    missing = [field for field in required if not mapping.get(field)]
    if missing:
        raise ValueError(f"Missing column mapping for: {', '.join(missing)}.")
    selected = [mapping[field] for field in required]
    if len(set(selected)) != len(selected):
        raise ValueError("Each required field must map to a different input column.")
    unknown = [column for column in selected if column not in frame.columns]
    if unknown:
        raise ValueError(f"Mapped column(s) not found: {', '.join(unknown)}.")

    timestamps = _parse_timestamps(frame[mapping["timestamp"]])
    period_type, period_label = detect_and_validate_period(timestamps)

    arrays: dict[str, np.ndarray] = {}
    for field in ("demand", "supply"):
        converted = pd.to_numeric(frame[mapping[field]], errors="coerce")
        invalid = converted.isna() | ~np.isfinite(converted.to_numpy(dtype=float))
        if invalid.any():
            rows = [str(index + 2) for index in np.flatnonzero(invalid.to_numpy())[:8]]
            raise ValueError(
                f"{field.title()} contains invalid numerical values at spreadsheet row(s): "
                f"{', '.join(rows)}."
            )
        arrays[field] = converted.to_numpy(dtype=float)

    if np.any(arrays["demand"] < 0):
        raise ValueError("Demand values cannot be negative.")
    if np.any(arrays["supply"] < 0):
        raise ValueError("Available-supply values cannot be negative.")

    # Solar is no longer an input requirement or a solver signal. Retain a
    # valid legacy reference column when present; unrelated/invalid extras must
    # not block an otherwise valid upload. Missing reference data is exported
    # as blank, never as an observed zero-generation series.
    solar_columns = [column for column in frame.columns if _normalise_header(column)
                     in {"solar", "solargw", "solargeneration", "solargenerationgw"}]
    solar_column = mapping.get("solar") or (solar_columns[0] if len(solar_columns) == 1 else None)
    solar = np.zeros(len(frame), dtype=float)
    solar_provided = False
    if solar_column in frame.columns and solar_column not in selected:
        reference = pd.to_numeric(frame[solar_column], errors="coerce").to_numpy(dtype=float)
        if np.all(np.isfinite(reference)) and np.all(reference >= 0):
            solar = reference
            solar_provided = True
            mapping["solar"] = solar_column
    if not solar_provided:
        mapping.pop("solar", None)

    return ValidatedInput(
        filename=filename,
        sheet_name=sheet_name,
        period_type=period_type,
        period_label=period_label,
        timestamps=[timestamp.to_pydatetime() for timestamp in timestamps],
        demand=arrays["demand"],
        supply=arrays["supply"],
        solar=solar,
        raw_frame=frame,
        mapping=mapping,
        solar_provided=solar_provided,
    )


def validation_response(validated: ValidatedInput) -> dict:
    return {
        "valid": True,
        "period_type": validated.period_type,
        "period_label": validated.period_label,
        "row_count": len(validated.timestamps),
        "start": validated.timestamps[0].isoformat(sep=" "),
        "end": validated.timestamps[-1].isoformat(sep=" "),
        "checks": {
            "complete_hour_chronology": True,
            "period_detected": True,
            "no_missing_timestamps": True,
            "one_scenario": True,
        },
    }
