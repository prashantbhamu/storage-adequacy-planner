"""Build the public example year from the statistics of a private scenario.

Only aggregate shape is carried over: the average demand and supply − demand
gap for each month and hour of day, interpolated smoothly through the year, and
the size and persistence of day-to-day and hour-to-hour variation. Every
hourly value is then generated from a fixed random seed, outliers are
clipped and the level is scaled, so no hour of the source series appears in
the output.

Usage (the source workbook is private and not part of this repository):

    python examples/generate_synthetic_year.py SOURCE.xlsx
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

SEED = 2029
LEVEL_SCALE = 0.97
CLIP_SIGMA = 2.0
OUTPUT = Path(__file__).with_name("synthetic_fy2029_30.csv")


def ar1(rng: np.random.Generator, n: int, phi: float, sd: float) -> np.ndarray:
    """Stationary AR(1) series with lag-one correlation ``phi`` and std ``sd``."""
    shocks = rng.normal(0.0, sd * np.sqrt(1.0 - phi**2), n)
    series = np.empty(n)
    series[0] = rng.normal(0.0, sd)
    for i in range(1, n):
        series[i] = phi * series[i - 1] + shocks[i]
    return series


def seasonal_profile(times: pd.DatetimeIndex, values: pd.Series) -> np.ndarray:
    """Month × hour means, interpolated between mid-months so there are no steps."""
    table = values.groupby([times.month, times.hour]).mean().unstack()  # 12 × 24
    centres = np.array([pd.Timestamp(2001, m, 15).dayofyear for m in range(1, 13)], dtype=float)
    # Wrap December and January so the year joins smoothly.
    x = np.r_[centres[-1] - 365, centres, centres[0] + 365]
    doy = times.dayofyear.to_numpy(dtype=float)
    out = np.empty(len(times))
    for hour in range(24):
        column = table[hour].to_numpy()
        y = np.r_[column[-1], column, column[0]]
        mask = times.hour == hour
        out[mask] = np.interp(doy[mask], x, y)
    return out


def variation_stats(times: pd.DatetimeIndex, values: pd.Series, profile: np.ndarray):
    residual = pd.Series(values.to_numpy() - profile, index=times)
    daily = residual.groupby(times.date).mean()
    hourly = residual - daily.reindex(times.date).to_numpy()
    return (
        float(daily.std()),
        float(np.clip(daily.autocorr(), 0.0, 0.95)),
        float(hourly.std()),
        float(np.clip(hourly.autocorr(), 0.0, 0.95)),
    )


def generate(source: Path) -> pd.DataFrame:
    frame = pd.read_excel(source)
    times = pd.DatetimeIndex(pd.to_datetime(frame["Timestamp"]))
    rng = np.random.default_rng(SEED)
    days = pd.Index(times.date)
    day_index = days.factorize()[0]
    n_days = day_index.max() + 1

    # Model demand and the supply − demand gap; in the source their swings
    # partly offset, so the gap varies less than either series alone.
    demand = frame["Demand (GW)"].astype(float)
    series = {"demand": demand, "gap": frame["Available Supply (GW)"].astype(float) - demand}
    columns = {}
    for key, values in series.items():
        profile = seasonal_profile(times, values)
        daily_sd, daily_phi, hourly_sd, hourly_phi = variation_stats(times, values, profile)
        noise = ar1(rng, n_days, daily_phi, daily_sd)[day_index] + ar1(rng, len(times), hourly_phi, hourly_sd)
        limit = CLIP_SIGMA * float(np.std(noise))
        columns[key] = LEVEL_SCALE * (profile + np.clip(noise, -limit, limit))
    columns = {"Demand (GW)": columns["demand"], "Available Supply (GW)": columns["demand"] + columns["gap"]}

    return pd.DataFrame({
        "Timestamp": times.strftime("%Y-%m-%d %H:%M"),
        "Demand (GW)": np.round(columns["Demand (GW)"], 2),
        "Available Supply (GW)": np.round(np.maximum(columns["Available Supply (GW)"], 0.0), 2),
    })


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    result = generate(Path(sys.argv[1]))
    result.to_csv(OUTPUT, index=False, lineterminator="\n")
    gap = result["Available Supply (GW)"] - result["Demand (GW)"]
    print(f"Wrote {OUTPUT.name}: {len(result)} hours, lowest gap {gap.min():.2f} GW, "
          f"{int((gap < 0).sum())} short hours, {(-gap).clip(lower=0).sum():,.0f} GWh shortage")
