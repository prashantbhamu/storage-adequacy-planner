"""Minimum storage size that lifts the residual-gap floor to a target.

One perfect-foresight LP over the whole study with the storage size as a
decision variable. Every operating rule of the dispatch model applies: SOC
balance and operating range, user-defined initial/final SOC, prorated
06:00-day throughput caps, surplus-only charging and the power envelope.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
from datetime import datetime
from typing import Sequence

import numpy as np
from scipy.optimize import linprog
from scipy.sparse import coo_matrix

from .optimizer import (
    StorageSpec,
    accounting_day,
    accounting_day_caps,
    perfect_foresight,
)

SIZING_MODES = {
    "energy": "Minimum energy capacity at the entered charge/discharge power",
    "power": "Minimum power (charge = discharge) at the entered energy capacity",
    "duration": "Minimum power (charge = discharge) at a fixed duration",
}


def size_storage(
    timestamps: Sequence[datetime],
    demand: Sequence[float],
    supply: Sequence[float],
    spec: StorageSpec,
    mode: str,
    target_floor_gw: float,
    duration_hours: float | None = None,
) -> dict:
    """Return the smallest storage meeting ``residual >= target_floor_gw`` every hour.

    ``spec`` supplies efficiency, cycle limit, SOC fractions and the charging
    rule, plus the fixed dimension: power for ``energy`` mode and energy for
    ``power`` mode. The sized dimension in ``spec`` is ignored.
    """
    if mode not in SIZING_MODES:
        raise ValueError(f"Sizing mode must be one of: {', '.join(SIZING_MODES)}.")
    if not np.isfinite(target_floor_gw):
        raise ValueError("The target floor must be a finite number.")
    if mode == "duration" and not (duration_hours and duration_hours > 0):
        raise ValueError("Duration sizing needs a duration greater than zero hours.")
    spec.validate()

    timestamps = list(timestamps)
    gap = np.asarray(supply, dtype=float) - np.asarray(demand, dtype=float)
    n = len(gap)
    eta = spec.eta
    deepest = target_floor_gw - float(np.min(gap))
    if mode == "energy" and deepest > spec.discharge_power_gw + 1e-9:
        raise ValueError(
            f"The target needs {deepest:,.3f} GW of discharge in the tightest hour, "
            f"above the entered {spec.discharge_power_gw:,.3f} GW. Size power instead."
        )

    c0, d0, e0 = 0, n, 2 * n
    power, energy = 3 * n + 1, 3 * n + 2
    variables = 3 * n + 3
    variable_power = mode in ("power", "duration")

    bounds: list[tuple[float | None, float | None]] = []
    for value in gap:
        upper = None if variable_power else spec.charge_power_gw
        if spec.charge_from_surplus_only:
            surplus = max(float(value), 0.0)
            upper = surplus if upper is None else min(upper, surplus)
        bounds.append((0.0, upper))
    bounds.extend((0.0, None if variable_power else spec.discharge_power_gw) for _ in range(n))
    bounds.extend((0.0, None) for _ in range(n + 1))
    bounds.append((0.0, None) if variable_power else (0.0, 0.0))
    bounds.append((spec.energy_gwh, spec.energy_gwh) if mode == "power" else (0.0, None))

    eq_r: list[int] = []
    eq_c: list[int] = []
    eq_v: list[float] = []
    b_eq: list[float] = []

    def add_eq(entries, rhs: float) -> None:
        row = len(b_eq)
        for column, coefficient in entries:
            eq_r.append(row)
            eq_c.append(column)
            eq_v.append(coefficient)
        b_eq.append(rhs)

    for hour in range(n):
        add_eq(((e0 + hour + 1, 1.0), (e0 + hour, -1.0), (c0 + hour, -eta), (d0 + hour, 1.0 / eta)), 0.0)
    add_eq(((e0, 1.0), (energy, -spec.initial_soc_fraction)), 0.0)
    add_eq(((e0 + n, 1.0), (energy, -spec.final_soc_fraction)), 0.0)
    if mode == "duration":
        add_eq(((energy, 1.0), (power, -float(duration_hours))), 0.0)

    ub_r: list[int] = []
    ub_c: list[int] = []
    ub_v: list[float] = []
    b_ub: list[float] = []

    def add_ub(entries, rhs: float) -> None:
        row = len(b_ub)
        for column, coefficient in entries:
            ub_r.append(row)
            ub_c.append(column)
            ub_v.append(coefficient)
        b_ub.append(rhs)

    for hour, value in enumerate(gap):
        # residual = gap + d - c >= target
        add_ub(((c0 + hour, 1.0), (d0 + hour, -1.0)), float(value) - target_floor_gw)
        if variable_power:
            add_ub(((c0 + hour, 1.0), (d0 + hour, 1.0), (power, -1.0)), 0.0)
        else:
            add_ub(((c0 + hour, 1.0 / spec.charge_power_gw), (d0 + hour, 1.0 / spec.discharge_power_gw)), 1.0)
    for index in range(n + 1):
        add_ub(((e0 + index, 1.0), (energy, -spec.max_soc_fraction)), 0.0)
        add_ub(((e0 + index, -1.0), (energy, spec.min_soc_fraction)), 0.0)

    # Prorated 06:00-day caps scale with the (possibly variable) energy capacity.
    unit_caps = accounting_day_caps(
        timestamps, replace(spec, energy_gwh=1.0)
    )
    grouped: dict[str, list[int]] = defaultdict(list)
    for hour, timestamp in enumerate(timestamps):
        grouped[accounting_day(timestamp)].append(hour)
    for day, hours in grouped.items():
        add_ub(tuple((c0 + hour, eta) for hour in hours) + ((energy, -unit_caps[day]),), 0.0)
        add_ub(tuple((d0 + hour, 1.0 / eta) for hour in hours) + ((energy, -unit_caps[day]),), 0.0)

    objective = np.zeros(variables)
    objective[power if variable_power else energy] = 1.0
    result = linprog(
        objective,
        A_ub=coo_matrix((ub_v, (ub_r, ub_c)), shape=(len(b_ub), variables)).tocsr(),
        b_ub=np.asarray(b_ub),
        A_eq=coo_matrix((eq_v, (eq_r, eq_c)), shape=(len(b_eq), variables)).tocsr(),
        b_eq=np.asarray(b_eq),
        bounds=bounds,
        method="highs",
        options={"primal_feasibility_tolerance": 1e-9, "dual_feasibility_tolerance": 1e-9},
    )
    if result.status == 2:
        raise ValueError(
            f"No storage size can hold the residual gap at or above {target_floor_gw:,.3f} GW "
            "under these rules: there is not enough surplus energy (or charging time "
            "within the cycle limit) to cover the deficits. Lower the target or relax "
            "surplus-only charging, the cycle limit or the SOC levels."
        )
    if not result.success:
        raise RuntimeError(f"HiGHS failure {result.status}: {result.message}")

    power_gw = float(result.x[power]) if variable_power else None
    energy_gwh = float(result.x[energy])
    if variable_power:
        sized = replace(spec, charge_power_gw=power_gw, discharge_power_gw=power_gw, energy_gwh=energy_gwh)
    else:
        sized = replace(spec, energy_gwh=energy_gwh)
    # Independent check with the dispatch model's own perfect-foresight LP.
    check = perfect_foresight(timestamps, gap, sized) if energy_gwh > 1e-9 and (power_gw is None or power_gw > 1e-9) else None
    return {
        "mode": mode,
        "description": SIZING_MODES[mode],
        "target_floor_gw": target_floor_gw,
        "duration_hours": duration_hours if mode == "duration" else None,
        "charge_power_gw": sized.charge_power_gw,
        "discharge_power_gw": sized.discharge_power_gw,
        "energy_gwh": energy_gwh,
        "raw_floor_gw": float(np.min(gap)),
        "check_floor_gw": check["floor_gw"] if check else float(np.min(gap)),
        "check_shortage_gwh": check["shortage_gwh"] if check else float(np.sum(np.maximum(-gap, 0.0))),
    }
