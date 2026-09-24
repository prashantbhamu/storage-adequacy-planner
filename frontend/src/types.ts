export type StorageInputs = {
  charge_power_gw: string;
  discharge_power_gw: string;
  energy_gwh: string;
  rte_percent: string;
  max_cycles_per_accounting_day: string;
  initial_soc_percent: string;
  final_soc_percent: string;
  min_soc_percent: string;
  max_soc_percent: string;
};

export type Validation = {
  valid: boolean;
  period_type: "month" | "financial_year";
  period_label: string;
  row_count: number;
  start: string;
  end: string;
  checks: Record<string, boolean>;
  raw: {
    minimum_gap_gw: number;
    maximum_gap_gw: number;
    shortage_energy_gwh: number;
    shortage_hours: number;
    surplus_energy_gwh: number;
    peak_demand_gw: number;
  };
  daily_minimum_gap_gw: Array<{ day: string; gap_gw: number }>;
};

export type HourlyResult = {
  timestamp: string;
  demand_gw: number;
  supply_gw: number;
  raw_gap_gw: number;
  charge_gw: number;
  discharge_gw: number;
  dispatch_gw: number;
  adjusted_supply_gw: number;
  residual_gap_gw: number;
  soc_end_gwh: number;
  accounting_day: string;
};

export type DailyResult = {
  date: string;
  minimum_gap_before_gw: number;
  minimum_gap_after_gw: number;
  shortage_energy_before_gwh: number;
  shortage_energy_after_gwh: number;
  shortage_hours_before: number;
  shortage_hours_after: number;
  equivalent_cycles: number;
};

export type LimitKey = "discharge_power" | "stored_energy" | "daily_cycle_limit" | "energy_rationed";

export type SensitivityRow = {
  parameter: string;
  unit: string;
  from: number;
  to: number;
  floor_change_gw: number;
  shortage_change_gwh: number;
};

export type RunResult = {
  run_id: string;
  period: { type: string; label: string; hours: number; start: string; end: string };
  storage: {
    charge_power_gw: number;
    discharge_power_gw: number;
    energy_gwh: number;
    rte: number;
    max_cycles_per_accounting_day: number;
    initial_soc_fraction: number;
    final_soc_fraction: number;
    min_soc_fraction: number;
    max_soc_fraction: number;
    charge_from_surplus_only: boolean;
    daily_internal_throughput_cap_gwh: number;
    soc_min_gwh: number;
    soc_max_gwh: number;
  };
  summary: Record<string, number>;
  validation: {
    passed: boolean;
    maximum_constraint_violation: number;
    checks: Record<string, number>;
    diagnostics: Record<string, number>;
  };
  benchmark: {
    perfect_foresight_floor_gw: number;
    perfect_foresight_shortage_gwh: number;
    rolling_floor_gw: number;
    rolling_shortage_gwh: number;
    floor_shortfall_gw: number;
    excess_shortage_gwh: number;
  };
  limits: {
    labels: Record<LimitKey, string>;
    shortage_hours: Record<LimitKey, number>;
    shortage_energy_gwh: Record<LimitKey, number>;
    floor_hour: { timestamp: string; residual_gap_gw: number; limit: LimitKey };
    most_effective_increase: string | null;
  };
  sensitivity: SensitivityRow[];
  daily_performance: DailyResult[];
  hourly: HourlyResult[];
};

export type JobStatus = {
  state: "running" | "done" | "error";
  stage: "queued" | "benchmark" | "horizons" | "sensitivity";
  done: number;
  total: number;
  elapsed_seconds: number;
  runs_ahead?: number;
  error: string | null;
  result: RunResult | null;
};

export type SizingMode = "energy" | "power" | "duration";

export type SizingResult = {
  mode: SizingMode;
  description: string;
  target_floor_gw: number;
  duration_hours: number | null;
  charge_power_gw: number;
  discharge_power_gw: number;
  energy_gwh: number;
  raw_floor_gw: number;
  check_floor_gw: number;
  check_shortage_gwh: number;
};

export type SocSuggestion = {
  soc_percent: number;
  soc_gwh: number;
  floor_gw: number;
  shortage_gwh: number;
};
