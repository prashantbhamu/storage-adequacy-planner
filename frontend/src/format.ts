const cache = new Map<number, Intl.NumberFormat>();

/** en-IN grouping with a fixed number of decimals. */
export function num(value: number, digits = 2) {
  let formatter = cache.get(digits);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    cache.set(digits, formatter);
  }
  // Avoid "-0.00" for values that round to zero.
  const rounded = Number(value.toFixed(digits));
  return formatter.format(rounded === 0 ? 0 : rounded).replace("-", "−");
}

/** Tiny solver residuals: "0" for exact zeros, otherwise one significant digit. */
export function tiny(value: number) {
  return Math.abs(value) < 1e-12 ? "0" : value.toExponential(0).replace("-", "−");
}

export function signed(value: number, digits = 2) {
  const text = num(value, digits);
  return Number(value.toFixed(digits)) > 0 ? `+${text}` : text;
}

export function percent(fraction: number, digits = 1) {
  return `${num(fraction * 100, digits)}%`;
}

export function dayLabel(isoDate: string) {
  const date = new Date(`${isoDate}T00:00:00`);
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function shortDay(isoDate: string) {
  const date = new Date(`${isoDate}T00:00:00`);
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function hourLabel(timestamp: string) {
  return timestamp.slice(11, 16);
}
