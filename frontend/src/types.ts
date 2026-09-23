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

export type Preview = {
  filename: string;
  sheet_name: string | null;
  row_count: number;
  columns: string[];
  sample: Record<string, string | null>[];
};

export type Validation = {
  valid: boolean;
  period_type: "month" | "financial_year";
  period_label: string;
  row_count: number;
  start: string;
  end: string;
  checks: Record<string, boolean>;
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

export type RunResult = {
  run_id: string;
  period: {
    type: string;
    label: string;
    hours: number;
    start: string;
    end: string;
  };
  storage: Record<string, number>;
  summary: Record<string, number>;
  validation: {
    passed: boolean;
    maximum_constraint_violation: number;
    checks: Record<string, number>;
    diagnostics: Record<string, number>;
  };
  benchmark: Record<string, number>;
  limits: {
    labels: Record<string, string>;
    shortage_hours: Record<string, number>;
    shortage_energy_gwh: Record<string, number>;
    floor_hour: { timestamp: string; residual_gap_gw: number; limit: string };
    most_effective_increase: string | null;
  };
  sensitivity: Array<{
    parameter: string;
    unit: string;
    from: number;
    to: number;
    floor_change_gw: number;
    shortage_change_gwh: number;
  }>;
  daily_performance: DailyResult[];
  hourly: HourlyResult[];
};
