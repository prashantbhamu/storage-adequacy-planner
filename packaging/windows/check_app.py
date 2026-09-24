"""Check a running packaged app end to end with the bundled example year.

    python packaging/windows/check_app.py http://127.0.0.1:8790

Waits for the app, then loads the page, runs a full-year optimisation, downloads
the workbook, suggests a cyclic SOC and sizes the storage. Standard library only.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
import uuid

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8765"
SETTINGS = {"charge_power_gw": 60, "discharge_power_gw": 60, "energy_gwh": 300, "rte_percent": 85,
            "max_cycles_per_accounting_day": 1, "initial_soc_percent": 1, "final_soc_percent": 1,
            "charge_from_surplus_only": True}


def get(path: str) -> bytes:
    with urllib.request.urlopen(BASE + path, timeout=60) as response:
        return response.read()


def post(path: str, csv: bytes, **fields: object) -> dict:
    boundary = uuid.uuid4().hex
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{json.dumps(value)}\r\n'.encode()
             for key, value in fields.items()]
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="example.csv"\r\n'
                 f"Content-Type: text/csv\r\n\r\n".encode() + csv + b"\r\n")
    body = b"".join(parts) + f"--{boundary}--\r\n".encode()
    request = urllib.request.Request(BASE + path, data=body, method="POST",
                                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(request, timeout=600) as response:
        return json.loads(response.read())


def check(label: str, ok: bool) -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {label}")
    if not ok:
        sys.exit(1)


for _ in range(120):
    try:
        health = json.loads(get("/api/health"))
        break
    except OSError:
        time.sleep(1)
else:
    check("app started within 2 minutes", False)
check(f"health {health['status']} (version {health['version']})", health["status"] == "ready")
check("interface page served", b"<div id=\"root\">" in get("/"))
csv = get("/api/example")
check("example year bundled", csv.count(b"\n") > 8000)

job = post("/api/jobs", csv, settings=SETTINGS)["job_id"]
started = time.time()
while True:
    status = json.loads(get(f"/api/jobs/{job}"))
    if status["state"] != "running":
        break
    time.sleep(2)
check(f"full-year run {status['state']} in {time.time() - started:.0f} s", status["state"] == "done")
summary = status["result"]["summary"]
print(f"     tightest hour {summary['minimum_gap_before_gw']:.1f} -> {summary['minimum_gap_after_gw']:.1f} GW")
workbook = get(f"/api/download/{status['result']['run_id']}")
check("results workbook downloads", workbook[:2] == b"PK")

suggestion = post("/api/suggest-soc", csv, settings=SETTINGS)
check(f"cyclic SOC suggested ({suggestion.get('soc_percent')}%)", "soc_percent" in suggestion)
sizing = post("/api/size", csv, settings=SETTINGS, sizing={"mode": "energy", "target_floor_gw": 0})
check(f"sizing found {sizing.get('energy_gwh', 0):.1f} GWh", sizing.get("energy_gwh", 0) > 0)
print("All checks passed.")
