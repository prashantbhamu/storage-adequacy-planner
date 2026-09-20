from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Callable, Sequence

import numpy as np
from scipy.optimize import linprog
from scipy.sparse import coo_matrix, csr_matrix, hstack, vstack


HORIZON_HOURS = 48
COMMIT_HOURS = 24
ACCOUNTING_BOUNDARY_HOUR = 6
SOLVER_TOLERANCE = 2e-6
VERSION = "2.0.0"
LEXIMIN_LEVEL_TOLERANCE = 1e-8
METHOD_OBJECTIVES = (
    "Maximise the residual-gap floor",
    "Minimise shortage energy",
    "Preserve soft terminal SOC value",
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

    def validate(self) -> None:
        if not all(math.isfinite(value) for value in asdict(self).values()):
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

    @property
    def eta(self) -> float:
        return math.sqrt(self.rte)

    @property
    def daily_internal_throughput_cap_gwh(self) -> float:
        return self.energy_gwh * self.max_cycles_per_accounting_day


@dataclass
class OptimizationResult:
    timestamps: list[datetime]
    demand: np.ndarray
    supply: np.ndarray
    solar: np.ndarray
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


def accounting_day(timestamp: datetime) -> str:
    return (timestamp - timedelta(hours=ACCOUNTING_BOUNDARY_HOUR)).date().isoformat()


def _build_problem(
    gap: np.ndarray,
    timestamps: Sequence[datetime],
    soc0: float,
    committed_charge: dict[str, float],
    committed_discharge: dict[str, float],
    spec: StorageSpec,
    terminal_target: float,
    force_final_zero: bool = False,
    floor_lower: float | None = None,
    shortage_limit: float | None = None,
    terminal_shortfall_limit: float | None = None,
    ceiling_upper: float | None = None,
    throughput_limit: float | None = None,
    charge_segment_bounds: list[tuple[int, int, float, float]] | None = None,
    discharge_segment_bounds: list[tuple[int, int, float, float]] | None = None,
) -> dict:
    """Build one rolling-horizon LP using grid-side charge/discharge variables."""

    n = len(gap)
    eta = spec.eta
    c0, d0, e0 = 0, n, 2 * n
    u0 = 3 * n + 1
    shortfall, floor, ceiling = 4 * n + 1, 4 * n + 2, 4 * n + 3
    variables = 4 * n + 4

    bounds: list[tuple[float | None, float | None]] = []
    bounds.extend((0.0, spec.charge_power_gw) for _ in range(n))
    bounds.extend((0.0, spec.discharge_power_gw) for _ in range(n))
    for index in range(n + 1):
        if index == 0:
            bounds.append((soc0, soc0))
        elif index == n and force_final_zero:
            bounds.append((0.0, 0.0))
        else:
            bounds.append((0.0, spec.energy_gwh))
    bounds.extend((0.0, None) for _ in range(n))
    bounds.append((0.0, None))
    bounds.append((None, None))
    bounds.append((None, None))

    eq_r: list[int] = []
    eq_c: list[int] = []
    eq_v: list[float] = []
    b_eq: list[float] = []
    for hour in range(n):
        row = len(b_eq)
        eq_r.extend((row, row, row, row))
        eq_c.extend((e0 + hour + 1, e0 + hour, c0 + hour, d0 + hour))
        eq_v.extend((1.0, -1.0, -eta, 1.0 / eta))
        b_eq.append(0.0)
    a_eq = coo_matrix((eq_v, (eq_r, eq_c)), shape=(n, variables)).tocsr()

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
        # gap + discharge - charge <= ceiling
        add_ub(((c0 + hour, -1.0), (d0 + hour, 1.0), (ceiling, -1.0)), -value)
        # shortage >= -(gap + discharge - charge)
        add_ub(((c0 + hour, 1.0), (d0 + hour, -1.0), (u0 + hour, -1.0)), value)

    grouped_hours: dict[str, list[int]] = defaultdict(list)
    for hour, timestamp in enumerate(timestamps):
        grouped_hours[accounting_day(timestamp)].append(hour)
    cap = spec.daily_internal_throughput_cap_gwh
    for day, hours in grouped_hours.items():
        charge_remaining = cap - committed_charge.get(day, 0.0)
        discharge_remaining = cap - committed_discharge.get(day, 0.0)
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
    if ceiling_upper is not None:
        add_ub(((ceiling, 1.0),), ceiling_upper)
    if throughput_limit is not None:
        add_ub(
            tuple((c0 + hour, 1.0) for hour in range(n))
            + tuple((d0 + hour, 1.0) for hour in range(n)),
            throughput_limit,
        )
    if charge_segment_bounds is not None:
        for start, end, lower, upper in charge_segment_bounds:
            add_ub(tuple((c0 + hour, 1.0) for hour in range(start, end)), upper)
            add_ub(tuple((c0 + hour, -1.0) for hour in range(start, end)), -lower)
    if discharge_segment_bounds is not None:
        for start, end, lower, upper in discharge_segment_bounds:
            add_ub(tuple((d0 + hour, 1.0) for hour in range(start, end)), upper)
            add_ub(tuple((d0 + hour, -1.0) for hour in range(start, end)), -lower)

    a_ub = coo_matrix((ub_v, (ub_r, ub_c)), shape=(len(b_ub), variables)).tocsr()
    return {
        "n": n,
        "variables": variables,
        "bounds": bounds,
        "A_eq": a_eq,
        "b_eq": np.asarray(b_eq),
        "A_ub": a_ub,
        "b_ub": np.asarray(b_ub),
        "indices": {
            "c": c0,
            "d": d0,
            "e": e0,
            "u": u0,
            "shortfall": shortfall,
            "floor": floor,
            "ceiling": ceiling,
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


def _solve_horizon(
    gap: np.ndarray,
    solar: np.ndarray,
    timestamps: Sequence[datetime],
    soc0: float,
    committed_charge: dict[str, float],
    committed_discharge: dict[str, float],
    spec: StorageSpec,
    next_gap: Sequence[float],
    force_final_zero: bool,
) -> dict:
    base = _build_problem(
        gap,
        timestamps,
        soc0,
        committed_charge,
        committed_discharge,
        spec,
        terminal_target=0.0,
        force_final_zero=force_final_zero,
    )
    n, indices = base["n"], base["indices"]

    # 1. Maximise the firm residual-headroom floor.
    objective1 = np.zeros(base["variables"])
    objective1[indices["floor"]] = -1.0
    first = _solve_lp(base, objective1)
    floor_opt = float(first.x[indices["floor"]])
    floor_tol = 1e-10 * (1.0 + abs(floor_opt))

    if force_final_zero:
        terminal_target = 0.0
    else:
        terminal_target = min(
            spec.energy_gwh,
            sum(max(floor_opt - value, 0.0) for value in next_gap) / spec.eta,
        )

    # 2. Lock the floor and minimise remaining shortage energy.
    stage2 = _build_problem(
        gap,
        timestamps,
        soc0,
        committed_charge,
        committed_discharge,
        spec,
        terminal_target,
        force_final_zero,
        floor_lower=floor_opt - floor_tol,
    )
    objective2 = np.zeros(stage2["variables"])
    objective2[indices["u"] : indices["u"] + n] = 1.0
    second = _solve_lp(stage2, objective2)
    shortage_opt = float(objective2 @ second.x)
    shortage_tol = 1e-8 * (1.0 + abs(shortage_opt))

    # 3. Preserve the soft terminal-SOC value without sacrificing stages 1-2.
    stage3 = _build_problem(
        gap,
        timestamps,
        soc0,
        committed_charge,
        committed_discharge,
        spec,
        terminal_target,
        force_final_zero,
        floor_lower=floor_opt - floor_tol,
        shortage_limit=shortage_opt + shortage_tol,
    )
    objective3 = np.zeros(stage3["variables"])
    objective3[indices["shortfall"]] = 1.0
    third = _solve_lp(stage3, objective3)
    shortfall_opt = float(third.x[indices["shortfall"]])
    shortfall_tol = 1e-8 * (1.0 + abs(shortfall_opt))

    # 4. Keep improving feasible residual levels before minimizing cycling.
    stage4 = _build_problem(
        gap,
        timestamps,
        soc0,
        committed_charge,
        committed_discharge,
        spec,
        terminal_target,
        force_final_zero,
        floor_lower=floor_opt - floor_tol,
        shortage_limit=shortage_opt + shortage_tol,
        terminal_shortfall_limit=shortfall_opt + shortfall_tol,
    )
    # Solar is retained as reference input for backwards-compatible exports;
    # it has no objective coefficient and cannot change a v2 schedule.
    values, levels = _progressive_leximin(stage4, np.asarray(gap, dtype=float))
    charge = values[indices["c"] : indices["c"] + n]
    discharge = values[indices["d"] : indices["d"] + n]
    residual = gap + discharge - charge
    throughput_opt = float(np.sum(charge) + np.sum(discharge))
    ceiling_opt = float(np.max(residual))
    return {
        "charge": values[indices["c"] : indices["c"] + n],
        "discharge": values[indices["d"] : indices["d"] + n],
        "soc": values[indices["e"] : indices["e"] + n + 1],
        "floor": float(np.min(residual)),
        "ceiling": ceiling_opt,
        "terminal_target": float(terminal_target),
        "terminal_shortfall": float(values[indices["shortfall"]]),
        "floor_opt": floor_opt,
        "shortage_opt": shortage_opt,
        "throughput_opt": throughput_opt,
        "ceiling_opt": ceiling_opt,
        "level_count": len(levels),
        "levels": levels,
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
    soc_end = np.cumsum(spec.eta * charge - discharge / spec.eta)
    return charge, discharge, dispatch, adjusted, residual, {
        "simultaneous_noise_hours_netted": simultaneous_hours_netted,
        "negative_residual_noise_hours_snapped": int(np.sum(snap_mask)),
        "negative_residual_noise_gwh_snapped": negative_noise_gwh,
        "soc_end": soc_end,
    }


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
) -> dict:
    start_soc = np.r_[0.0, soc_end[:-1]]
    balance = soc_end - start_soc - spec.eta * charge + discharge / spec.eta
    daily_charge: dict[str, float] = defaultdict(float)
    daily_discharge: dict[str, float] = defaultdict(float)
    for index, timestamp in enumerate(timestamps):
        day = accounting_day(timestamp)
        daily_charge[day] += spec.eta * float(charge[index])
        daily_discharge[day] += float(discharge[index]) / spec.eta

    cap = spec.daily_internal_throughput_cap_gwh
    checks = {
        "initial_soc_abs_gwh": abs(float(start_soc[0])),
        "final_soc_abs_gwh": abs(float(soc_end[-1])),
        "soc_balance_max_abs_gwh": float(np.max(np.abs(balance))),
        "soc_upper_violation_gwh": max(0.0, float(np.max(soc_end) - spec.energy_gwh)),
        "soc_lower_violation_gwh": max(0.0, float(-np.min(soc_end))),
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
        "daily_internal_charge_violation_gwh": max(
            0.0, float(max(daily_charge.values(), default=0.0) - cap)
        ),
        "daily_internal_discharge_violation_gwh": max(
            0.0, float(max(daily_discharge.values(), default=0.0) - cap)
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
            "minimum_soc_gwh": float(np.min(soc_end)),
            "maximum_soc_gwh": float(np.max(soc_end)),
            "maximum_charge_gw": float(np.max(charge)),
            "maximum_discharge_gw": float(np.max(discharge)),
            "maximum_06_day_internal_charge_gwh": float(max(daily_charge.values())),
            "maximum_06_day_internal_discharge_gwh": float(max(daily_discharge.values())),
            "accounting_day_count": len(daily_charge),
        },
    }


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
    solar: Sequence[float],
    spec: StorageSpec,
    progress: Callable[[int, int], None] | None = None,
) -> OptimizationResult:
    spec.validate()
    timestamps = list(timestamps)
    if not timestamps or len(timestamps) % COMMIT_HOURS != 0:
        raise ValueError("The input period must contain complete 24-hour blocks.")
    demand_array = np.asarray(demand, dtype=float)
    supply_array = np.asarray(supply, dtype=float)
    solar_array = np.asarray(solar, dtype=float)
    if not (
        len(timestamps)
        == len(demand_array)
        == len(supply_array)
        == len(solar_array)
    ):
        raise ValueError("Timestamp, demand, supply and solar arrays must have equal length.")
    if not all(np.all(np.isfinite(array)) for array in (demand_array, supply_array, solar_array)):
        raise ValueError("All hourly numerical inputs must be finite.")

    raw_gap = supply_array - demand_array
    total = len(timestamps)
    charge = np.zeros(total)
    discharge = np.zeros(total)
    soc_end = np.zeros(total)
    committed_charge: dict[str, float] = defaultdict(float)
    committed_discharge: dict[str, float] = defaultdict(float)
    carried_soc = 0.0
    horizon_log: list[dict] = []
    starts = list(range(0, total, COMMIT_HOURS))

    for horizon_number, start in enumerate(starts, 1):
        end = min(total, start + HORIZON_HOURS)
        commit_end = min(total, start + COMMIT_HOURS)
        next_gap = raw_gap[end : min(total, end + COMMIT_HOURS)]
        solved = _solve_horizon(
            raw_gap[start:end],
            solar_array[start:end],
            timestamps[start:end],
            carried_soc,
            committed_charge,
            committed_discharge,
            spec,
            next_gap,
            force_final_zero=end == total,
        )
        simultaneous = float(np.max(np.minimum(solved["charge"], solved["discharge"])))
        if simultaneous > 2e-7:
            raise ValueError(
                f"Horizon {horizon_number} has simultaneous operation of {simultaneous:.3e} GW."
            )
        take = commit_end - start
        charge[start:commit_end] = solved["charge"][:take]
        discharge[start:commit_end] = solved["discharge"][:take]
        soc_end[start:commit_end] = solved["soc"][1 : take + 1]
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
                "optimal_ceiling_gw": solved["ceiling_opt"],
                "final_ceiling_gw": solved["ceiling"],
                "shortage_opt_gwh": solved["shortage_opt"],
                "throughput_opt_gwh": solved["throughput_opt"],
                "level_count": solved["level_count"],
                "levels": solved["levels"],
            }
        )
        if progress is not None:
            progress(horizon_number, len(starts))

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
    )
    if not validation["passed"]:
        raise ValueError(f"Optimisation validation failed: {validation}")

    summary = _metric_block(raw_gap, residual, charge, discharge, spec)
    daily = _daily_performance(
        timestamps, raw_gap, residual, charge, discharge, spec
    )
    return OptimizationResult(
        timestamps=timestamps,
        demand=demand_array,
        supply=supply_array,
        solar=solar_array,
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
    )


def storage_spec_dict(spec: StorageSpec) -> dict:
    result = asdict(spec)
    result["charge_efficiency"] = spec.eta
    result["discharge_efficiency"] = spec.eta
    result["daily_internal_throughput_cap_gwh"] = (
        spec.daily_internal_throughput_cap_gwh
    )
    return result
