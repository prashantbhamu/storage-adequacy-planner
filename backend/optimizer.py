from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta
from typing import Callable, Sequence

import numpy as np
from scipy.optimize import linprog
from scipy.sparse import coo_matrix, csr_matrix, hstack, vstack


HORIZON_HOURS = 48
COMMIT_HOURS = 24
ACCOUNTING_BOUNDARY_HOUR = 6
SOLVER_TOLERANCE = 2e-6
VERSION = "3.0.0"
LEXIMIN_LEVEL_TOLERANCE = 1e-8
SENSITIVITY_STEP = 0.10
METHOD_OBJECTIVES = (
    "Maximise the residual-gap floor",
    "Minimise shortage energy",
    "Approach the perfect-foresight terminal SOC (soft target)",
    "Progressively level remaining residual gaps (leximin)",
    "Minimise unnecessary throughput",
)


@dataclass(frozen=True)
class StorageSpec:
    charge_power_gw: float
    discharge_power_gw: float
    energy_gwh: float
    rte: float
    max_cycles_per_accounting_day: float
    initial_soc_fraction: float = 0.0
    final_soc_fraction: float = 0.0
    min_soc_fraction: float = 0.0
    max_soc_fraction: float = 1.0
    charge_from_surplus_only: bool = True

    def validate(self) -> None:
        numbers = [value for value in asdict(self).values() if not isinstance(value, bool)]
        if not all(math.isfinite(value) for value in numbers):
            raise ValueError("All storage assumptions must be finite numbers.")
        if self.charge_power_gw <= 0:
            raise ValueError("Maximum charge power must be greater than zero.")
        if self.discharge_power_gw <= 0:
            raise ValueError("Maximum discharge power must be greater than zero.")
        if self.energy_gwh <= 0:
            raise ValueError("Energy capacity must be greater than zero.")
        if not 0 < self.rte <= 1:
            raise ValueError("Round-trip efficiency must be greater than 0 and at most 100%.")
        if self.max_cycles_per_accounting_day <= 0:
            raise ValueError("Maximum equivalent cycles per day must be greater than zero.")
        if not 0 <= self.min_soc_fraction < self.max_soc_fraction <= 1:
            raise ValueError("The SOC operating range must satisfy 0% <= minimum < maximum <= 100%.")
        for label, value in (("Initial", self.initial_soc_fraction), ("Final", self.final_soc_fraction)):
            if not self.min_soc_fraction <= value <= self.max_soc_fraction:
                raise ValueError(f"{label} SOC must lie within the SOC operating range.")

    @property
    def eta(self) -> float:
        return math.sqrt(self.rte)

    @property
    def daily_internal_throughput_cap_gwh(self) -> float:
        return self.energy_gwh * self.max_cycles_per_accounting_day

    @property
    def soc_min_gwh(self) -> float:
        return self.energy_gwh * self.min_soc_fraction

    @property
    def soc_max_gwh(self) -> float:
        return self.energy_gwh * self.max_soc_fraction

    @property
    def initial_soc_gwh(self) -> float:
        return self.energy_gwh * self.initial_soc_fraction

    @property
    def final_soc_gwh(self) -> float:
        return self.energy_gwh * self.final_soc_fraction


@dataclass
class OptimizationResult:
    timestamps: list[datetime]
    demand: np.ndarray
    supply: np.ndarray
    raw_gap: np.ndarray
    charge: np.ndarray
    discharge: np.ndarray
    dispatch: np.ndarray
    adjusted_supply: np.ndarray
    residual_gap: np.ndarray
    soc_end: np.ndarray
    accounting_days: list[str]
    horizon_log: list[dict]
    validation: dict
    summary: dict
    daily_performance: list[dict]
    noise_cleanup: dict
    benchmark: dict
    limits: dict
    sensitivity: list[dict]


class InfeasibleError(ValueError):
    """The requested storage levels or targets cannot be met."""


def accounting_day(timestamp: datetime) -> str:
    return (timestamp - timedelta(hours=ACCOUNTING_BOUNDARY_HOUR)).date().isoformat()


def accounting_day_caps(timestamps: Sequence[datetime], spec: StorageSpec) -> dict[str, float]:
    """Per-direction internal throughput cap, prorated for partial study days.

    A study starting at 00:00 holds only the last six hours of the first
    06:00 accounting day, so that day receives 6/24 of the daily allowance.
    """
    hours: dict[str, int] = defaultdict(int)
    for timestamp in timestamps:
        hours[accounting_day(timestamp)] += 1
    cap = spec.daily_internal_throughput_cap_gwh
    return {day: cap * min(count, 24) / 24.0 for day, count in hours.items()}


def _build_problem(
    gap: np.ndarray,
    timestamps: Sequence[datetime],
    soc0: float,
    committed_charge: dict[str, float],
    committed_discharge: dict[str, float],
    spec: StorageSpec,
    day_caps: dict[str, float],
    terminal_target: float,
    final_soc: float | None = None,
    floor_lower: float | None = None,
    shortage_limit: float | None = None,
    terminal_shortfall_limit: float | None = None,
    cyclic: bool = False,
) -> dict:
    """Build one LP using grid-side charge/discharge variables.

    ``final_soc`` fixes the SOC at the end of the window (study end);
    otherwise the end SOC is free and a soft ``terminal_target`` applies.
    ``cyclic`` frees the start SOC and requires it to equal the end SOC.
    """

    n = len(gap)
    eta = spec.eta
    c0, d0, e0 = 0, n, 2 * n
    u0 = 3 * n + 1
    shortfall, floor = 4 * n + 1, 4 * n + 2
    variables = 4 * n + 3

    bounds: list[tuple[float | None, float | None]] = []
    for value in gap:
        upper = spec.charge_power_gw
        if spec.charge_from_surplus_only:
            upper = min(upper, max(float(value), 0.0))
        bounds.append((0.0, upper))
    bounds.extend((0.0, spec.discharge_power_gw) for _ in range(n))
    soc_range = (spec.soc_min_gwh, spec.soc_max_gwh)
    for index in range(n + 1):
        if index == 0 and not cyclic:
            bounds.append((soc0, soc0))
        elif index == n and final_soc is not None:
            bounds.append((final_soc, final_soc))
        else:
            bounds.append(soc_range)
    bounds.extend((0.0, None) for _ in range(n))
    bounds.append((0.0, None))
    bounds.append((None, None))

    eq_r: list[int] = []
    eq_c: list[int] = []
    eq_v: list[float] = []
    for hour in range(n):
        eq_r.extend((hour, hour, hour, hour))
        eq_c.extend((e0 + hour + 1, e0 + hour, c0 + hour, d0 + hour))
        eq_v.extend((1.0, -1.0, -eta, 1.0 / eta))
    rows = n
    if cyclic:
        eq_r.extend((n, n))
        eq_c.extend((e0, e0 + n))
        eq_v.extend((1.0, -1.0))
        rows += 1
    a_eq = coo_matrix((eq_v, (eq_r, eq_c)), shape=(rows, variables)).tocsr()

    ub_r: list[int] = []
    ub_c: list[int] = []
    ub_v: list[float] = []
    b_ub: list[float] = []

    def add_ub(entries: Sequence[tuple[int, float]], rhs: float) -> None:
        row = len(b_ub)
        for column, coefficient in entries:
            ub_r.append(row)
            ub_c.append(column)
            ub_v.append(coefficient)
        b_ub.append(float(rhs))

    for hour, value in enumerate(gap):
        # Preserve the production model's native scaling when the two power
        # limits are equal.  The normalised form is algebraically identical,
        # but its different coefficient scaling can select another point from
        # an otherwise-degenerate optimal face.  For asymmetric limits, the
        # normalised envelope remains the natural combined-lump constraint.
        if math.isclose(
            spec.charge_power_gw,
            spec.discharge_power_gw,
            rel_tol=0.0,
            abs_tol=1e-12,
        ):
            add_ub(
                ((c0 + hour, 1.0), (d0 + hour, 1.0)),
                spec.charge_power_gw,
            )
        else:
            add_ub(
                (
                    (c0 + hour, 1.0 / spec.charge_power_gw),
                    (d0 + hour, 1.0 / spec.discharge_power_gw),
                ),
                1.0,
            )
        # floor <= gap + discharge - charge
        add_ub(((c0 + hour, 1.0), (d0 + hour, -1.0), (floor, 1.0)), value)
        # shortage >= -(gap + discharge - charge)
        add_ub(((c0 + hour, 1.0), (d0 + hour, -1.0), (u0 + hour, -1.0)), value)

    grouped_hours: dict[str, list[int]] = defaultdict(list)
    for hour, timestamp in enumerate(timestamps):
        grouped_hours[accounting_day(timestamp)].append(hour)
    for day, hours in grouped_hours.items():
        charge_remaining = day_caps[day] - committed_charge.get(day, 0.0)
        discharge_remaining = day_caps[day] - committed_discharge.get(day, 0.0)
        if charge_remaining < -1e-7 or discharge_remaining < -1e-7:
            raise ValueError(
                f"Committed throughput exceeds the 06:00-day limit for {day}."
            )
        add_ub(tuple((c0 + hour, eta) for hour in hours), max(0.0, charge_remaining))
        add_ub(
            tuple((d0 + hour, 1.0 / eta) for hour in hours),
            max(0.0, discharge_remaining),
        )

    # e_terminal + shortfall >= terminal_target
    add_ub(((e0 + n, -1.0), (shortfall, -1.0)), -terminal_target)

    if floor_lower is not None:
        add_ub(((floor, -1.0),), -floor_lower)
    if shortage_limit is not None:
        add_ub(tuple((u0 + hour, 1.0) for hour in range(n)), shortage_limit)
    if terminal_shortfall_limit is not None:
        add_ub(((shortfall, 1.0),), terminal_shortfall_limit)

    a_ub = coo_matrix((ub_v, (ub_r, ub_c)), shape=(len(b_ub), variables)).tocsr()
    return {
        "n": n,
        "variables": variables,
        "bounds": bounds,
        "A_eq": a_eq,
        "b_eq": np.zeros(rows),
        "A_ub": a_ub,
        "b_ub": np.asarray(b_ub),
        "indices": {
            "c": c0,
            "d": d0,
            "e": e0,
            "u": u0,
            "shortfall": shortfall,
            "floor": floor,
        },
    }


def _solve_lp(problem: dict, objective: np.ndarray):
    result = linprog(
        objective,
        A_ub=problem["A_ub"],
        b_ub=problem["b_ub"],
        A_eq=problem["A_eq"],
        b_eq=problem["b_eq"],
        bounds=problem["bounds"],
        method="highs",
        options={
            "primal_feasibility_tolerance": 1e-9,
            "dual_feasibility_tolerance": 1e-9,
        },
    )
    if result.status == 2:
        raise InfeasibleError(
            "No feasible storage schedule exists for these assumptions. Check that "
            "the final SOC can be reached from the initial SOC within the power, "
            "cycle and surplus-charging limits."
        )
    if not result.success:
        raise RuntimeError(f"HiGHS failure {result.status}: {result.message}")
    return result


def _progressive_leximin(problem: dict, gap: np.ndarray) -> tuple[np.ndarray, list[dict]]:
    """Progressively maximize the lowest unfrozen chronological residuals.

    Retain the production floor/shortage/soft-terminal safeguards. A negative
    dual on z <= residual[i] certifies that hour as binding in EVERY optimum
    at that level; do not freeze arbitrary tied rows of one solver solution.
    Repeating this LP allows later hours to improve past an immovable hour.
    All SOC, power and accounting-day constraints remain joint and chronological.
    """
    n, variables = problem["n"], problem["variables"]
    indices = problem["indices"]
    residual_map = np.zeros((n, variables))
    residual_map[np.arange(n), indices["c"] + np.arange(n)] = -1.0
    residual_map[np.arange(n), indices["d"] + np.arange(n)] = 1.0
    base_ub = hstack(
        [problem["A_ub"], csr_matrix((len(problem["b_ub"]), 1))], format="csr"
    )
    equality = hstack(
        [problem["A_eq"], csr_matrix((len(problem["b_eq"]), 1))], format="csr"
    )
    objective = np.zeros(variables + 1)
    objective[-1] = -1.0
    active = list(range(n))
    frozen: dict[int, float] = {}
    levels: list[dict] = []
    previous_level = -np.inf
    tolerance = LEXIMIN_LEVEL_TOLERANCE
    while active:
        fixed_hours = list(frozen)
        rows, rhs = [], []
        if fixed_hours:
            fixed_map = residual_map[fixed_hours]
            fixed_target = np.array([frozen[i] - gap[i] for i in fixed_hours])
            rows.extend([
                np.c_[fixed_map, np.zeros(len(fixed_hours))],
                np.c_[-fixed_map, np.zeros(len(fixed_hours))],
            ])
            rhs.extend([fixed_target + tolerance, -fixed_target + tolerance])
        rows.append(np.c_[-residual_map[active], np.ones(len(active))])
        rhs.append(gap[active])
        stage = dict(
            problem,
            A_ub=vstack([base_ub] + [csr_matrix(row) for row in rows], format="csr"),
            b_ub=np.r_[problem["b_ub"], *rhs],
            A_eq=equality,
            bounds=problem["bounds"] + [(None, None)],
        )
        solved = _solve_lp(stage, objective)
        level = float(solved.x[-1])
        if level < previous_level - 5e-7:
            raise RuntimeError("Progressive residual levels decreased beyond solver tolerance.")
        previous_level = level
        duals = solved.ineqlin.marginals[-len(active):]
        bottlenecks = [hour for hour, dual in zip(active, duals) if dual < -1e-8]
        if not bottlenecks:
            raise RuntimeError("HiGHS did not certify a progressive-leveling bottleneck.")
        for hour in bottlenecks:
            frozen[hour] = level
        levels.append({"level_gw": level, "hours": bottlenecks})
        active = [hour for hour in active if hour not in frozen]

    # Cycling is a FINAL tie-break; it cannot prevent another useful level.
    target = np.array([frozen[i] - gap[i] for i in range(n)])
    final_stage = dict(
        problem,
        A_ub=vstack([problem["A_ub"], csr_matrix(residual_map), csr_matrix(-residual_map)], format="csr"),
        b_ub=np.r_[problem["b_ub"], target + tolerance, -target + tolerance],
    )
    throughput = np.zeros(variables)
    throughput[indices["c"]:indices["c"] + n] = 1.0
    throughput[indices["d"]:indices["d"] + n] = 1.0
    return _solve_lp(final_stage, throughput).x, levels


def _lexicographic_floor_shortage(problem_args: dict) -> tuple[dict, float, float, object]:
    """Stages 1-2: maximise the floor, then minimise shortage at that floor."""
    base = _build_problem(**problem_args)
    indices = base["indices"]
    objective1 = np.zeros(base["variables"])
    objective1[indices["floor"]] = -1.0
    floor_opt = float(_solve_lp(base, objective1).x[indices["floor"]])
    floor_lock = floor_opt - 1e-10 * (1.0 + abs(floor_opt))
    stage2 = _build_problem(**problem_args, floor_lower=floor_lock)
    objective2 = np.zeros(stage2["variables"])
    objective2[indices["u"] : indices["u"] + base["n"]] = 1.0
    second = _solve_lp(stage2, objective2)
    return stage2, floor_opt, float(objective2 @ second.x), second


def _solve_horizon(
    gap: np.ndarray,
    timestamps: Sequence[datetime],
    soc0: float,
    committed_charge: dict[str, float],
    committed_discharge: dict[str, float],
    spec: StorageSpec,
    day_caps: dict[str, float],
    terminal_target: float,
    final_soc: float | None,
) -> dict:
    args = dict(
        gap=gap,
        timestamps=timestamps,
        soc0=soc0,
        committed_charge=committed_charge,
        committed_discharge=committed_discharge,
        spec=spec,
        day_caps=day_caps,
        terminal_target=terminal_target if final_soc is None else final_soc,
        final_soc=final_soc,
    )
    # 1-2. Maximise the residual-gap floor, then minimise shortage energy.
    stage2, floor_opt, shortage_opt, _ = _lexicographic_floor_shortage(args)
    n, indices = stage2["n"], stage2["indices"]
    floor_lock = floor_opt - 1e-10 * (1.0 + abs(floor_opt))
    shortage_lock = shortage_opt + 1e-8 * (1.0 + abs(shortage_opt))

    # 3. Approach the soft terminal-SOC target without sacrificing stages 1-2.
    stage3 = _build_problem(**args, floor_lower=floor_lock, shortage_limit=shortage_lock)
    objective3 = np.zeros(stage3["variables"])
    objective3[indices["shortfall"]] = 1.0
    third = _solve_lp(stage3, objective3)
    shortfall_opt = float(third.x[indices["shortfall"]])
    shortfall_tol = 1e-8 * (1.0 + abs(shortfall_opt))

    # 4. Keep improving feasible residual levels before minimizing cycling.
    stage4 = _build_problem(
        **args,
        floor_lower=floor_lock,
        shortage_limit=shortage_lock,
        terminal_shortfall_limit=shortfall_opt + shortfall_tol,
    )
    values, levels = _progressive_leximin(stage4, np.asarray(gap, dtype=float))
    charge = values[indices["c"] : indices["c"] + n]
    discharge = values[indices["d"] : indices["d"] + n]
    residual = gap + discharge - charge
    return {
        "charge": charge,
        "discharge": discharge,
        "soc": values[indices["e"] : indices["e"] + n + 1],
        "floor": float(np.min(residual)),
        "ceiling": float(np.max(residual)),
        "terminal_target": float(args["terminal_target"]),
        "terminal_shortfall": float(values[indices["shortfall"]]),
        "floor_opt": floor_opt,
        "shortage_opt": shortage_opt,
        "throughput_opt": float(np.sum(charge) + np.sum(discharge)),
        "level_count": len(levels),
        "levels": levels,
    }


def perfect_foresight(
    timestamps: Sequence[datetime],
    raw_gap: np.ndarray,
    spec: StorageSpec,
    cyclic: bool = False,
) -> dict:
    """Whole-period LP for the floor and shortage objectives.

    It is the benchmark the rolling horizon is checked against, and its SOC
    trajectory anchors each rolling window's soft terminal target.  With
    ``cyclic`` the start SOC is free and equal to the end SOC; the lowest
    such start level that keeps both objectives optimal is returned.
    """
    args = dict(
        gap=np.asarray(raw_gap, dtype=float),
        timestamps=list(timestamps),
        soc0=spec.initial_soc_gwh,
        committed_charge={},
        committed_discharge={},
        spec=spec,
        day_caps=accounting_day_caps(timestamps, spec),
        terminal_target=0.0,
        final_soc=None if cyclic else spec.final_soc_gwh,
        cyclic=cyclic,
    )
    stage2, floor_opt, shortage_opt, solved = _lexicographic_floor_shortage(args)
    indices = stage2["indices"]
    if cyclic:
        stage3 = _build_problem(
            **args,
            floor_lower=floor_opt - 1e-10 * (1.0 + abs(floor_opt)),
            shortage_limit=shortage_opt + 1e-8 * (1.0 + abs(shortage_opt)),
        )
        objective3 = np.zeros(stage3["variables"])
        objective3[indices["e"]] = 1.0
        solved = _solve_lp(stage3, objective3)
    soc = solved.x[indices["e"] : indices["e"] + stage2["n"] + 1]
    return {
        "floor_gw": floor_opt,
        "shortage_gwh": shortage_opt,
        "soc": np.asarray(soc),
        "start_soc_gwh": float(soc[0]),
    }


def suggest_cyclic_soc(
    timestamps: Sequence[datetime],
    demand: Sequence[float],
    supply: Sequence[float],
    spec: StorageSpec,
) -> dict:
    """Suggest an initial = final SOC so the study neither borrows nor banks energy."""
    probe = replace(
        spec,
        initial_soc_fraction=spec.min_soc_fraction,
        final_soc_fraction=spec.min_soc_fraction,
    )
    probe.validate()
    raw_gap = np.asarray(supply, dtype=float) - np.asarray(demand, dtype=float)
    plan = perfect_foresight(timestamps, raw_gap, probe, cyclic=True)
    return {
        "soc_percent": 100.0 * plan["start_soc_gwh"] / spec.energy_gwh,
        "soc_gwh": plan["start_soc_gwh"],
        "floor_gw": plan["floor_gw"],
        "shortage_gwh": plan["shortage_gwh"],
    }


def _clean_solver_noise(
    raw_gap: np.ndarray,
    supply: np.ndarray,
    charge: np.ndarray,
    discharge: np.ndarray,
    spec: StorageSpec,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, dict]:
    charge = charge.copy()
    discharge = discharge.copy()
    simultaneous_hours_netted = 0
    for index in range(len(charge)):
        overlap = min(charge[index], discharge[index])
        if 0.0 < overlap < 1e-7:
            charge[index] -= overlap
            discharge[index] -= overlap
            simultaneous_hours_netted += 1

    dispatch = discharge - charge
    residual = raw_gap + dispatch
    snap_mask = (residual < 0.0) & (residual > -1e-7)
    negative_noise_gwh = float(-np.sum(residual[snap_mask]))
    dispatch[snap_mask] = -raw_gap[snap_mask]
    charge = np.maximum(-dispatch, 0.0)
    discharge = np.maximum(dispatch, 0.0)
    residual = raw_gap + dispatch
    adjusted = supply + dispatch
    soc_end = spec.initial_soc_gwh + np.cumsum(spec.eta * charge - discharge / spec.eta)
    return charge, discharge, dispatch, adjusted, residual, {
        "simultaneous_noise_hours_netted": simultaneous_hours_netted,
        "negative_residual_noise_hours_snapped": int(np.sum(snap_mask)),
        "negative_residual_noise_gwh_snapped": negative_noise_gwh,
        "soc_end": soc_end,
    }


def _daily_internal_throughput(
    timestamps: Sequence[datetime],
    charge: np.ndarray,
    discharge: np.ndarray,
    spec: StorageSpec,
) -> tuple[dict[str, float], dict[str, float]]:
    daily_charge: dict[str, float] = defaultdict(float)
    daily_discharge: dict[str, float] = defaultdict(float)
    for index, timestamp in enumerate(timestamps):
        day = accounting_day(timestamp)
        daily_charge[day] += spec.eta * float(charge[index])
        daily_discharge[day] += float(discharge[index]) / spec.eta
    return daily_charge, daily_discharge


def _calculate_validation(
    timestamps: Sequence[datetime],
    raw_gap: np.ndarray,
    supply: np.ndarray,
    charge: np.ndarray,
    discharge: np.ndarray,
    dispatch: np.ndarray,
    adjusted: np.ndarray,
    residual: np.ndarray,
    soc_end: np.ndarray,
    spec: StorageSpec,
    day_caps: dict[str, float],
) -> dict:
    start_soc = np.r_[spec.initial_soc_gwh, soc_end[:-1]]
    balance = soc_end - start_soc - spec.eta * charge + discharge / spec.eta
    daily_charge, daily_discharge = _daily_internal_throughput(
        timestamps, charge, discharge, spec
    )
    surplus_charge_violation = 0.0
    if spec.charge_from_surplus_only:
        surplus_charge_violation = max(
            0.0, float(np.max(charge - np.maximum(raw_gap, 0.0)))
        )

    checks = {
        "final_soc_abs_gwh": abs(float(soc_end[-1]) - spec.final_soc_gwh),
        "soc_balance_max_abs_gwh": float(np.max(np.abs(balance))),
        "soc_upper_violation_gwh": max(0.0, float(np.max(soc_end) - spec.soc_max_gwh)),
        "soc_lower_violation_gwh": max(0.0, float(spec.soc_min_gwh - np.min(soc_end))),
        "charge_power_violation_gw": max(
            0.0, float(np.max(charge) - spec.charge_power_gw)
        ),
        "discharge_power_violation_gw": max(
            0.0, float(np.max(discharge) - spec.discharge_power_gw)
        ),
        "combined_envelope_violation": max(
            0.0,
            float(
                np.max(
                    charge / spec.charge_power_gw
                    + discharge / spec.discharge_power_gw
                )
                - 1.0
            ),
        ),
        "simultaneous_charge_discharge_gw": float(np.max(np.minimum(charge, discharge))),
        "surplus_charging_violation_gw": surplus_charge_violation,
        "daily_internal_charge_violation_gwh": max(
            0.0, max(value - day_caps[day] for day, value in daily_charge.items())
        ),
        "daily_internal_discharge_violation_gwh": max(
            0.0, max(value - day_caps[day] for day, value in daily_discharge.items())
        ),
        "negative_charge_violation_gw": max(0.0, float(-np.min(charge))),
        "negative_discharge_violation_gw": max(0.0, float(-np.min(discharge))),
        "residual_identity_max_abs_gw": float(
            np.max(np.abs(residual - (raw_gap + dispatch)))
        ),
        "adjusted_supply_identity_max_abs_gw": float(
            np.max(np.abs(adjusted - (supply + dispatch)))
        ),
    }
    maximum_violation = max(checks.values())
    return {
        "passed": maximum_violation <= SOLVER_TOLERANCE,
        "maximum_constraint_violation": maximum_violation,
        "checks": checks,
        "diagnostics": {
            "initial_soc_gwh": spec.initial_soc_gwh,
            "final_soc_gwh": float(soc_end[-1]),
            "minimum_soc_gwh": float(min(spec.initial_soc_gwh, np.min(soc_end))),
            "maximum_soc_gwh": float(np.max(soc_end)),
            "maximum_charge_gw": float(np.max(charge)),
            "maximum_discharge_gw": float(np.max(discharge)),
            "maximum_06_day_internal_charge_gwh": float(max(daily_charge.values())),
            "maximum_06_day_internal_discharge_gwh": float(max(daily_discharge.values())),
            "accounting_day_count": len(daily_charge),
        },
    }


LIMIT_LABELS = {
    "discharge_power": "Discharge power",
    "stored_energy": "Stored energy exhausted",
    "daily_cycle_limit": "Daily discharge allowance used up",
    "energy_rationed": "Energy spread across a longer deficit",
}


def _limiting_factors(
    timestamps: Sequence[datetime],
    residual: np.ndarray,
    discharge: np.ndarray,
    soc_end: np.ndarray,
    spec: StorageSpec,
    daily_discharge: dict[str, float],
    day_caps: dict[str, float],
) -> dict:
    """Classify what stopped storage lifting each shortage hour further.

    Checked in order: discharge at its power limit; SOC at its minimum by the
    end of the hour; the 06:00-day discharge allowance fully used; otherwise
    the stored energy was deliberately spread over a longer or deeper deficit.
    """

    def classify(index: int) -> str:
        power_tol = 1e-5 * (1.0 + spec.discharge_power_gw)
        energy_tol = 1e-5 * (1.0 + spec.energy_gwh)
        day = accounting_day(timestamps[index])
        if discharge[index] >= spec.discharge_power_gw - power_tol:
            return "discharge_power"
        if soc_end[index] <= spec.soc_min_gwh + energy_tol:
            return "stored_energy"
        if daily_discharge[day] >= day_caps[day] - energy_tol:
            return "daily_cycle_limit"
        return "energy_rationed"

    hours = {key: 0 for key in LIMIT_LABELS}
    energy = {key: 0.0 for key in LIMIT_LABELS}
    for index in np.flatnonzero(residual < -1e-6):
        key = classify(int(index))
        hours[key] += 1
        energy[key] += float(-residual[index])
    floor_index = int(np.argmin(residual))
    return {
        "labels": LIMIT_LABELS,
        "shortage_hours": hours,
        "shortage_energy_gwh": energy,
        "floor_hour": {
            "timestamp": timestamps[floor_index].isoformat(sep=" "),
            "residual_gap_gw": float(residual[floor_index]),
            "limit": classify(floor_index),
        },
    }


def _sensitivity(
    timestamps: Sequence[datetime],
    raw_gap: np.ndarray,
    spec: StorageSpec,
    base: dict,
    report: Callable[[str, int, int], None],
) -> list[dict]:
    """Perfect-foresight change in floor and shortage for +10% of each limit."""
    rows = []
    limits = (
        ("charge_power_gw", "Charge power", "GW"),
        ("discharge_power_gw", "Discharge power", "GW"),
        ("energy_gwh", "Energy capacity", "GWh"),
        ("max_cycles_per_accounting_day", "Daily cycle limit", "cycles"),
    )
    for done, (field, label, unit) in enumerate(limits):
        report("sensitivity", done, len(limits))
        value = getattr(spec, field)
        changed = replace(spec, **{field: value * (1.0 + SENSITIVITY_STEP)})
        try:
            plan = perfect_foresight(timestamps, raw_gap, changed)
        except InfeasibleError:
            continue
        rows.append({
            "parameter": label,
            "unit": unit,
            "from": value,
            "to": value * (1.0 + SENSITIVITY_STEP),
            "floor_change_gw": _clean(plan["floor_gw"] - base["floor_gw"]),
            "shortage_change_gwh": _clean(plan["shortage_gwh"] - base["shortage_gwh"]),
        })
    report("sensitivity", len(limits), len(limits))
    return rows


def _clean(value: float, tolerance: float = 1e-6) -> float:
    return 0.0 if abs(value) < tolerance else value


def _most_effective_increase(sensitivity: list[dict]) -> str | None:
    """The limit whose +10% most improves the floor, then shortage energy.

    This is the binding limit in the planning sense: per-hour labels describe
    what was observed, but only relaxing a limit shows whether it matters.
    """
    improving = [
        row for row in sensitivity
        if row["floor_change_gw"] > 0 or row["shortage_change_gwh"] < 0
    ]
    if not improving:
        return None
    best = max(improving, key=lambda row: (row["floor_change_gw"], -row["shortage_change_gwh"]))
    return best["parameter"]


def _metric_block(
    raw_gap: np.ndarray,
    residual: np.ndarray,
    charge: np.ndarray,
    discharge: np.ndarray,
    spec: StorageSpec,
) -> dict:
    before_shortage = np.maximum(-raw_gap, 0.0)
    after_shortage = np.maximum(-residual, 0.0)
    internal_charge = spec.eta * charge
    internal_discharge = discharge / spec.eta
    return {
        "minimum_gap_before_gw": float(np.min(raw_gap)),
        "minimum_gap_after_gw": float(np.min(residual)),
        "maximum_gap_before_gw": float(np.max(raw_gap)),
        "maximum_gap_after_gw": float(np.max(residual)),
        "average_gap_before_gw": float(np.mean(raw_gap)),
        "average_gap_after_gw": float(np.mean(residual)),
        "shortage_hours_before": int(np.sum(raw_gap < -1e-6)),
        "shortage_hours_after": int(np.sum(residual < -1e-6)),
        "shortage_energy_before_gwh": float(np.sum(before_shortage)),
        "shortage_energy_after_gwh": float(np.sum(after_shortage)),
        "peak_charge_gw": float(np.max(charge)),
        "peak_discharge_gw": float(np.max(discharge)),
        "total_charge_gwh": float(np.sum(charge)),
        "total_discharge_gwh": float(np.sum(discharge)),
        "conversion_losses_gwh": float(np.sum(charge) - np.sum(discharge)),
        "equivalent_cycles": float(
            (np.sum(internal_charge) + np.sum(internal_discharge))
            / (2.0 * spec.energy_gwh)
        ),
        "charging_hours": int(np.sum(charge > 1e-6)),
        "discharging_hours": int(np.sum(discharge > 1e-6)),
    }


def _daily_performance(
    timestamps: Sequence[datetime],
    raw_gap: np.ndarray,
    residual: np.ndarray,
    charge: np.ndarray,
    discharge: np.ndarray,
    spec: StorageSpec,
) -> list[dict]:
    grouped: dict[str, list[int]] = defaultdict(list)
    for index, timestamp in enumerate(timestamps):
        grouped[accounting_day(timestamp)].append(index)
    result: list[dict] = []
    for day, indices in grouped.items():
        idx = np.asarray(indices)
        metrics = _metric_block(
            raw_gap[idx], residual[idx], charge[idx], discharge[idx], spec
        )
        result.append({"date": day, **metrics})
    return result


def optimize_storage(
    timestamps: Sequence[datetime],
    demand: Sequence[float],
    supply: Sequence[float],
    spec: StorageSpec,
    progress: Callable[[str, int, int], None] | None = None,
    sensitivity: bool = True,
) -> OptimizationResult:
    """Run the rolling-horizon dispatch.

    ``progress(stage, done, total)`` is called with stage ``benchmark``,
    ``horizons`` or ``sensitivity``.
    """
    spec.validate()
    timestamps = list(timestamps)
    if not timestamps or len(timestamps) % COMMIT_HOURS != 0:
        raise ValueError("The input period must contain complete 24-hour blocks.")
    demand_array = np.asarray(demand, dtype=float)
    supply_array = np.asarray(supply, dtype=float)
    if not len(timestamps) == len(demand_array) == len(supply_array):
        raise ValueError("Timestamp, demand and supply arrays must have equal length.")
    if not all(np.all(np.isfinite(array)) for array in (demand_array, supply_array)):
        raise ValueError("All hourly numerical inputs must be finite.")

    raw_gap = supply_array - demand_array
    total = len(timestamps)
    day_caps = accounting_day_caps(timestamps, spec)

    report = progress or (lambda stage, done, total: None)

    # The whole-period optimum is the benchmark and the rolling-horizon anchor:
    # each window's soft terminal target follows its SOC trajectory.
    report("benchmark", 0, 1)
    plan = perfect_foresight(timestamps, raw_gap, spec)
    report("benchmark", 1, 1)

    charge = np.zeros(total)
    discharge = np.zeros(total)
    committed_charge: dict[str, float] = defaultdict(float)
    committed_discharge: dict[str, float] = defaultdict(float)
    carried_soc = spec.initial_soc_gwh
    horizon_log: list[dict] = []
    starts = list(range(0, total, COMMIT_HOURS))

    for horizon_number, start in enumerate(starts, 1):
        end = min(total, start + HORIZON_HOURS)
        commit_end = min(total, start + COMMIT_HOURS)
        solved = _solve_horizon(
            raw_gap[start:end],
            timestamps[start:end],
            carried_soc,
            committed_charge,
            committed_discharge,
            spec,
            day_caps,
            terminal_target=float(plan["soc"][end]),
            final_soc=spec.final_soc_gwh if end == total else None,
        )
        simultaneous = float(np.max(np.minimum(solved["charge"], solved["discharge"])))
        if simultaneous > 2e-7:
            raise ValueError(
                f"Horizon {horizon_number} has simultaneous operation of {simultaneous:.3e} GW."
            )
        take = commit_end - start
        charge[start:commit_end] = solved["charge"][:take]
        discharge[start:commit_end] = solved["discharge"][:take]
        for local in range(take):
            day = accounting_day(timestamps[start + local])
            committed_charge[day] += spec.eta * float(solved["charge"][local])
            committed_discharge[day] += float(solved["discharge"][local]) / spec.eta
        carried_soc = float(solved["soc"][take])
        horizon_log.append(
            {
                "start": timestamps[start].isoformat(sep=" "),
                "end": (timestamps[end - 1] + timedelta(hours=1)).isoformat(sep=" "),
                "commit_hours": take,
                "initial_soc_gwh": float(solved["soc"][0]),
                "committed_end_soc_gwh": carried_soc,
                "terminal_soc_gwh": float(solved["soc"][-1]),
                "terminal_target_gwh": solved["terminal_target"],
                "terminal_shortfall_gwh": solved["terminal_shortfall"],
                "optimal_floor_gw": solved["floor_opt"],
                "final_floor_gw": solved["floor"],
                "final_ceiling_gw": solved["ceiling"],
                "shortage_opt_gwh": solved["shortage_opt"],
                "throughput_opt_gwh": solved["throughput_opt"],
                "level_count": solved["level_count"],
                "levels": solved["levels"],
            }
        )
        report("horizons", horizon_number, len(starts))

    (
        charge,
        discharge,
        dispatch,
        adjusted,
        residual,
        cleanup,
    ) = _clean_solver_noise(raw_gap, supply_array, charge, discharge, spec)
    soc_end = cleanup.pop("soc_end")
    validation = _calculate_validation(
        timestamps,
        raw_gap,
        supply_array,
        charge,
        discharge,
        dispatch,
        adjusted,
        residual,
        soc_end,
        spec,
        day_caps,
    )
    if not validation["passed"]:
        raise ValueError(f"Optimisation validation failed: {validation}")

    summary = _metric_block(raw_gap, residual, charge, discharge, spec)
    daily = _daily_performance(
        timestamps, raw_gap, residual, charge, discharge, spec
    )
    rolling_floor = float(np.min(residual))
    rolling_shortage = float(np.sum(np.maximum(-residual, 0.0)))
    benchmark = {
        "perfect_foresight_floor_gw": plan["floor_gw"],
        "perfect_foresight_shortage_gwh": plan["shortage_gwh"],
        "rolling_floor_gw": rolling_floor,
        "rolling_shortage_gwh": rolling_shortage,
        "floor_shortfall_gw": _clean(max(0.0, plan["floor_gw"] - rolling_floor)),
        "excess_shortage_gwh": _clean(max(0.0, rolling_shortage - plan["shortage_gwh"])),
    }
    _, daily_discharge = _daily_internal_throughput(timestamps, charge, discharge, spec)
    limits = _limiting_factors(
        timestamps, residual, discharge, soc_end, spec, daily_discharge, day_caps
    )
    sensitivity_rows = (
        _sensitivity(timestamps, raw_gap, spec, plan, report) if sensitivity else []
    )
    limits["most_effective_increase"] = _most_effective_increase(sensitivity_rows)
    return OptimizationResult(
        timestamps=timestamps,
        demand=demand_array,
        supply=supply_array,
        raw_gap=raw_gap,
        charge=charge,
        discharge=discharge,
        dispatch=dispatch,
        adjusted_supply=adjusted,
        residual_gap=residual,
        soc_end=soc_end,
        accounting_days=[accounting_day(timestamp) for timestamp in timestamps],
        horizon_log=horizon_log,
        validation=validation,
        summary=summary,
        daily_performance=daily,
        noise_cleanup=cleanup,
        benchmark=benchmark,
        limits=limits,
        sensitivity=sensitivity_rows,
    )


def storage_spec_dict(spec: StorageSpec) -> dict:
    result = asdict(spec)
    result["charge_efficiency"] = spec.eta
    result["discharge_efficiency"] = spec.eta
    result["daily_internal_throughput_cap_gwh"] = (
        spec.daily_internal_throughput_cap_gwh
    )
    result["initial_soc_gwh"] = spec.initial_soc_gwh
    result["final_soc_gwh"] = spec.final_soc_gwh
    result["soc_min_gwh"] = spec.soc_min_gwh
    result["soc_max_gwh"] = spec.soc_max_gwh
    return result
