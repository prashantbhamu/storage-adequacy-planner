"""V2 policy and full-year golden regressions. No user-facing presets."""
from dataclasses import replace
from datetime import datetime, timedelta
import hashlib
import io
from pathlib import Path

import numpy as np
import pytest
from openpyxl import load_workbook

from backend.data_io import validate_uploaded_table
from backend.exporter import build_results_workbook
from backend.optimizer import StorageSpec, _solve_horizon, optimize_storage
from tests.test_tool import synthetic_run

APP_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("gaps,expected", [
    ([100., 5., 10., 20.], [80., 17.5, 17.5, 20.]),
    ([5., 100., 10., 20., 40.], [5., 80., 25., 25., 40.]),
    ([100., 90., 0., 0.], [85., 85., 10., 10.]),
])
def test_progressive_leveling_and_blocked_hours(gaps, expected):
    timestamps = [datetime(2031, 5, 1, 6) + timedelta(hours=i) for i in range(len(gaps))]
    spec = StorageSpec(100, 100, 20, 1, 1)
    gap = np.asarray(gaps)
    solved = _solve_horizon(gap, np.zeros(len(gap)), timestamps, 0, {}, {}, spec, [], True)
    np.testing.assert_allclose(gap + solved["discharge"] - solved["charge"], expected, atol=1e-6)
    assert len(solved["levels"]) > 1
    assert max(np.minimum(solved["charge"], solved["discharge"])) < 1e-7


def test_solar_cannot_change_dispatch():
    times, demand, supply, solar, spec = synthetic_run()
    first = optimize_storage(times, demand, supply, solar, spec)
    second = optimize_storage(times, demand, supply, np.arange(len(times)) * 100, spec)
    np.testing.assert_array_equal(first.dispatch, second.dispatch)
    np.testing.assert_array_equal(first.soc_end, second.soc_end)


@pytest.mark.parametrize("spec", [
    StorageSpec(1, 3, 5, .5, .5),
    StorageSpec(3, 1, 5, .81, .75),
    StorageSpec(2, 2, 8, 1, 1.5),
    StorageSpec(.1, .1, .2, .9, 1),
    StorageSpec(100, 100, 1000, .9, 1),
])
def test_custom_storage_limits(spec):
    times, demand, supply, solar, _ = synthetic_run()
    result = optimize_storage(times, demand, supply, solar, spec)
    assert result.validation["passed"]
    assert result.validation["checks"]["simultaneous_charge_discharge_gw"] < 1e-7
    assert max(x["equivalent_cycles"] for x in result.daily_performance) <= spec.max_cycles_per_accounting_day + 2e-6


@pytest.mark.parametrize("field", ["charge_power_gw", "discharge_power_gw", "energy_gwh", "rte", "max_cycles_per_accounting_day"])
@pytest.mark.parametrize("value", [float("nan"), float("inf")])
def test_nonfinite_assumptions_rejected(field, value):
    with pytest.raises(ValueError, match="finite"):
        replace(StorageSpec(2, 2, 8, .9, 1), **{field: value}).validate()


def test_public_synthetic_month_full_hourly_regression():
    """Pin every dispatch array to a deterministic, non-sensitive example."""
    path = APP_ROOT / "examples/synthetic_april_2031.csv"
    source = path.read_bytes()
    validated = validate_uploaded_table(source, path.name)
    assert len(validated.timestamps) == 720
    assert validated.timestamps[0] == datetime(2031, 4, 1)
    assert validated.timestamps[-1] == datetime(2031, 4, 30, 23)

    spec = StorageSpec(40, 40, 200, .85, 1)
    result = optimize_storage(
        validated.timestamps, validated.demand, validated.supply, validated.solar, spec
    )

    def rounded_hash(values):
        payload = np.round(np.asarray(values, dtype="<f8"), 6).tobytes()
        return hashlib.sha256(payload).hexdigest()

    assert rounded_hash(result.charge) == "2787a2eadf45e16a979f8bb29937fd209221ad780456c488776652b1babfed8a"
    assert rounded_hash(result.discharge) == "e178de1ceb66ef9821028d0caa5fe228ad7329c240811659de254c332480564a"
    assert rounded_hash(result.soc_end) == "4f5fe2625d2c0ba212a1e33635489715d28adfeb5e45762d5f0b1753ea1aa4bf"
    assert rounded_hash(result.residual_gap) == "b0719663495a42fd6b3c9352fad0f46663ce1629878b30208f8aa449a20cf398"

    assert result.validation["passed"]
    assert result.summary["shortage_hours_before"] == 378
    assert result.summary["shortage_hours_after"] == 378
    assert abs(result.summary["shortage_energy_after_gwh"] - 5655.532282146026) < 2e-6
    assert abs(result.summary["equivalent_cycles"] - 29.999999997179785) < 2e-6
    assert result.validation["checks"]["simultaneous_charge_discharge_gw"] == 0

    # Verify the complete downloadable workbook, including blank optional Solar.
    workbook = load_workbook(io.BytesIO(build_results_workbook(validated, spec, result)))
    assert workbook.sheetnames == ["Summary", "Hourly Results"]
    hourly = workbook["Hourly Results"]
    assert hourly.max_row == 721 and hourly.max_column == 12
    assert hourly.tables["HourlyStorageResults"].ref == "A1:L721"
    rows = list(hourly.iter_rows(min_row=2, values_only=True))
    assert [row[0] for row in rows] == validated.timestamps
    assert [row[11] for row in rows] == result.accounting_days
    assert all(row[3] is None for row in rows)
    np.testing.assert_allclose([row[8] for row in rows], result.adjusted_supply, atol=1e-10)
    np.testing.assert_allclose([row[9] for row in rows], result.residual_gap, atol=1e-10)
    assert not any(cell.data_type in ("e", "f") for sheet in workbook for row in sheet for cell in row)
    assert workbook["Summary"]["C19"].value == 378
    assert hashlib.sha256(path.read_bytes()).hexdigest() == hashlib.sha256(source).hexdigest()
    workbook.close()
