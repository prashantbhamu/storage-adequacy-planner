"""Create a deterministic, non-sensitive calendar-month example input."""

from __future__ import annotations

import csv
import math
from datetime import datetime, timedelta
from pathlib import Path


OUTPUT = Path(__file__).with_name("synthetic_april_2031.csv")


def main() -> None:
    start = datetime(2031, 4, 1)
    rows = []
    for index in range(30 * 24):
        timestamp = start + timedelta(hours=index)
        hour = timestamp.hour
        weekly = 5.0 * math.sin(2.0 * math.pi * index / (24.0 * 7.0))
        demand = 250.0 + weekly + 30.0 * math.sin(2.0 * math.pi * (hour - 15) / 24.0)
        solar_shape = max(0.0, math.sin(math.pi * (hour - 6) / 12.0))
        supply = 235.0 + 92.0 * solar_shape
        rows.append((timestamp.isoformat(sep=" "), round(demand, 6), round(supply, 6)))

    with OUTPUT.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(("Timestamp", "Demand (GW)", "Available Supply (GW)"))
        writer.writerows(rows)
    print(f"Wrote {len(rows)} hourly rows to {OUTPUT}")


if __name__ == "__main__":
    main()
