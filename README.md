# Storage Floor-Lifting Optimiser

A local, open-source decision-support tool for exploring how a single combined
storage resource can reshape an hourly supply–demand residual profile.

![Storage optimiser interface](docs/interface.png)

## What it does

The tool accepts one complete calendar month or April–March financial year of
hourly demand and available supply. Users can set charge power, discharge power,
energy capacity, round-trip efficiency and a daily throughput limit. Results
include before/after headroom, shortage energy and hours, storage dispatch,
state of charge, daily cycle use, constraint checks and a downloadable workbook.

This is a **floor-lifting** model, not a merchant revenue optimiser. Its ordered
objectives are:

1. maximise the minimum storage-adjusted residual gap;
2. minimise remaining shortage energy without sacrificing that floor;
3. preserve a soft terminal-SOC value for the next commitment window;
4. progressively level the remaining residual gaps (leximin); and
5. minimise unnecessary throughput.

## Model formulation

- One combined storage lump.
- Linear programming with SciPy's bundled HiGHS solver.
- 48-hour rolling horizon with the first 24 hours committed.
- Continuous state of charge (SOC), fixed at zero only at the study start and end.
- Separate user-defined charge/discharge power limits and energy capacity.
- Symmetric one-way efficiency equal to `sqrt(round-trip efficiency)`.
- No simultaneous charge and discharge.
- Maximum internal charging and discharging throughput per 06:00–06:00
  accounting day; the boundary does not reset SOC.

The optimiser uses demand and available supply only. Solar is not an objective
signal or tie-breaker. If a compatible Solar column exists, it is retained only
as an optional reference in the exported workbook.

## Input format

Upload `.csv` or `.xlsx` with these columns:

| Column | Meaning |
| --- | --- |
| `Timestamp` | Consecutive hourly timestamps |
| `Demand (GW)` | Hourly demand in GW |
| `Available Supply (GW)` | Hourly supply in GW before storage |

The series must cover exactly one calendar month or one April–March financial
year, with no duplicate, missing or irregular hours. Common aliases are detected
automatically; missing or ambiguous columns fail with an explicit message.

Generate the included non-sensitive example:

```bash
python examples/generate_synthetic_input.py
```

## Run locally

Requirements: Python 3.11+ and Node.js 20+.

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

cd frontend
npm install
npm run build
cd ..

python start_tool.py
```

Open `http://127.0.0.1:8765`. On Windows, `start_tool.bat` provides the same
launcher after dependencies and the frontend build are available.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest tests -q

cd frontend
npm test
npm run build
```

The public regression suite uses deterministic synthetic data. It pins all 720
hourly charge, discharge, SOC and residual-gap values to six decimal places,
checks objective behaviour and physical constraints, exercises three-column
CSV/XLSX uploads, and verifies the complete downloadable workbook. No private or
operational dataset is required.

## Scope and limitations

- This is a deterministic planning and scenario-analysis tool, not an operational
  scheduling instruction or market-bidding system.
- It optimises one perfect-foresight scenario at a time; forecast uncertainty,
  reserves, network constraints, unit commitment and degradation cost are out of
  scope.
- Power and energy units are GW and GWh. The tool does not silently convert MW.
- Large annual cases can take several minutes because progressive leximin solves
  multiple LP stages within each rolling horizon.
- Results depend on the supplied data and assumptions and should be reviewed by
  a qualified planner before use in decisions.

## Technology

FastAPI · React · TypeScript · Recharts · NumPy · SciPy/HiGHS · pandas · openpyxl

Licensed under the [MIT License](LICENSE).
