import type { Settings } from "./api";
import type { StorageInputs } from "./types";

export type FieldErrors = Partial<Record<keyof StorageInputs, string>>;

export const EMPTY_STORAGE: StorageInputs = {
  charge_power_gw: "",
  discharge_power_gw: "",
  energy_gwh: "",
  rte_percent: "",
  max_cycles_per_accounting_day: "",
  initial_soc_percent: "",
  final_soc_percent: "",
  min_soc_percent: "0",
  max_soc_percent: "100",
};

const POSITIVE: Array<keyof StorageInputs> = [
  "charge_power_gw",
  "discharge_power_gw",
  "energy_gwh",
  "rte_percent",
  "max_cycles_per_accounting_day",
];

function parse(value: string) {
  return value.trim() === "" ? NaN : Number(value);
}

/**
 * Check the entered assumptions. ``skip`` names fields chosen by the sizing
 * model, which may be empty. Only filled-in fields get error messages, so an
 * untouched form stays quiet; ``complete`` says whether everything needed is set.
 */
export function checkInputs(storage: StorageInputs, skip: Array<keyof StorageInputs> = []) {
  const errors: FieldErrors = {};
  const values = Object.fromEntries(
    Object.entries(storage).map(([key, value]) => [key, parse(value)]),
  ) as Record<keyof StorageInputs, number>;
  let complete = true;
  for (const key of Object.keys(storage) as Array<keyof StorageInputs>) {
    if (skip.includes(key)) continue;
    if (!Number.isFinite(values[key])) {
      if (storage[key].trim() !== "") errors[key] = "Enter a number.";
      complete = false;
    }
  }
  for (const key of POSITIVE) {
    if (!skip.includes(key) && Number.isFinite(values[key]) && values[key] <= 0) errors[key] = "Must be greater than zero.";
  }
  if (values.rte_percent > 100) errors.rte_percent = "At most 100%.";
  const { min_soc_percent: min, max_soc_percent: max } = values;
  if (min < 0 || min > 100) errors.min_soc_percent = "Between 0 and 100%.";
  if (max < 0 || max > 100) errors.max_soc_percent = "Between 0 and 100%.";
  if (Number.isFinite(min) && Number.isFinite(max) && min >= max) errors.max_soc_percent = "Must exceed the minimum.";
  for (const key of ["initial_soc_percent", "final_soc_percent"] as const) {
    const level = values[key];
    if (Number.isFinite(level) && (level < (Number.isFinite(min) ? min : 0) || level > (Number.isFinite(max) ? max : 100))) {
      errors[key] = "Outside the SOC range.";
    }
  }
  return { errors, complete, valid: complete && Object.keys(errors).length === 0 };
}

export function toSettings(storage: StorageInputs, surplusOnly: boolean, skip: Array<keyof StorageInputs> = []): Settings {
  const settings: Settings = { charge_from_surplus_only: surplusOnly };
  for (const [key, value] of Object.entries(storage)) {
    if (!skip.includes(key as keyof StorageInputs) && value.trim() !== "") settings[key] = Number(value);
  }
  return settings;
}
