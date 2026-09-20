from __future__ import annotations

import io
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

from .data_io import ValidatedInput
from .optimizer import METHOD_OBJECTIVES, VERSION, OptimizationResult, StorageSpec, storage_spec_dict


NAVY = "0B2B50"
TEAL = "078C82"
PALE_TEAL = "E9F7F5"
PALE_BLUE = "EEF5FA"
SLATE = "5D6B7A"
LIGHT_BORDER = "C9D6E2"
WHITE = "FFFFFF"


def _section_title(cell, text: str) -> None:
    cell.value = text
    cell.font = Font(name="Aptos Display", size=14, bold=True, color=NAVY)
    cell.fill = PatternFill("solid", fgColor=PALE_BLUE)
    cell.alignment = Alignment(vertical="center")


def _label(cell, text: str) -> None:
    cell.value = text
    cell.font = Font(name="Aptos", size=10, bold=True, color=NAVY)


def _style_summary_sheet(
    workbook: Workbook,
    validated: ValidatedInput,
    spec: StorageSpec,
    result: OptimizationResult,
) -> None:
    sheet = workbook.active
    sheet.title = "Summary"
    sheet.sheet_view.showGridLines = False
    sheet.freeze_panes = "A4"
    sheet.merge_cells("A1:F1")
    sheet["A1"] = "Storage Dispatch Optimiser v2 — Leximin"
    sheet["A1"].font = Font(name="Aptos Display", size=20, bold=True, color=WHITE)
    sheet["A1"].fill = PatternFill("solid", fgColor=NAVY)
    sheet["A1"].alignment = Alignment(vertical="center")
    sheet.row_dimensions[1].height = 34
    sheet.merge_cells("A2:F2")
    sheet["A2"] = (
        f"{validated.period_label} · 48 h look-ahead · 24 h commitment · continuous SOC"
    )
    sheet["A2"].font = Font(name="Aptos", size=10, color=SLATE)

    _section_title(sheet["A4"], "Run information")
    sheet.merge_cells("A4:B4")
    run_rows = [
        ("Source file", validated.filename),
        ("Source worksheet", validated.sheet_name or "CSV"),
        ("Period", validated.period_label),
        ("Hours", len(validated.timestamps)),
        ("Generated", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
        ("Tool version", VERSION),
        ("Dispatch policy", "Progressive leximin"),
    ]
    for row, (label, value) in enumerate(run_rows, start=5):
        _label(sheet.cell(row, 1), label)
        sheet.cell(row, 2, value)

    _section_title(sheet["D4"], "Storage assumptions")
    sheet.merge_cells("D4:F4")
    assumptions = storage_spec_dict(spec)
    assumption_rows = [
        ("Maximum charge", assumptions["charge_power_gw"], "GW"),
        ("Maximum discharge", assumptions["discharge_power_gw"], "GW"),
        ("Energy capacity", assumptions["energy_gwh"], "GWh"),
        ("Round-trip efficiency", assumptions["rte"], "%"),
        ("One-way efficiency", assumptions["charge_efficiency"], "%"),
        ("Maximum cycles / 06:00 day", assumptions["max_cycles_per_accounting_day"], "cycles"),
        ("Internal throughput cap", assumptions["daily_internal_throughput_cap_gwh"], "GWh/direction"),
    ]
    for row, (label, value, unit) in enumerate(assumption_rows, start=5):
        _label(sheet.cell(row, 4), label)
        cell = sheet.cell(row, 5, value)
        cell.number_format = "0.000"
        if unit == "%":
            cell.number_format = "0.000%"
        sheet.cell(row, 6, unit)

    metric_start = 14
    _section_title(sheet.cell(metric_start, 1), "Before and after")
    sheet.merge_cells(start_row=metric_start, start_column=1, end_row=metric_start, end_column=6)
    headers = ("Metric", "Before", "After", "Change", "Unit", "Interpretation")
    for column, value in enumerate(headers, start=1):
        cell = sheet.cell(metric_start + 1, column, value)
        cell.font = Font(name="Aptos", size=10, bold=True, color=WHITE)
        cell.fill = PatternFill("solid", fgColor=TEAL)
    summary = result.summary
    metric_rows = [
        (
            "Minimum residual gap",
            summary["minimum_gap_before_gw"],
            summary["minimum_gap_after_gw"],
            "GW",
            "Higher is better",
        ),
        (
            "Maximum residual gap",
            summary["maximum_gap_before_gw"],
            summary["maximum_gap_after_gw"],
            "GW",
            "Lower after charging is better",
        ),
        (
            "Shortage energy",
            summary["shortage_energy_before_gwh"],
            summary["shortage_energy_after_gwh"],
            "GWh",
            "Lower is better",
        ),
        (
            "Shortage hours",
            summary["shortage_hours_before"],
            summary["shortage_hours_after"],
            "hours",
            "Lower is better",
        ),
    ]
    for row, (label, before, after, unit, interpretation) in enumerate(
        metric_rows, start=metric_start + 2
    ):
        sheet.cell(row, 1, label)
        sheet.cell(row, 2, before)
        sheet.cell(row, 3, after)
        sheet.cell(row, 4, after - before)
        sheet.cell(row, 5, unit)
        sheet.cell(row, 6, interpretation)
        for column in (2, 3, 4):
            sheet.cell(row, column).number_format = "0.000"

    operation_start = metric_start + 8
    _section_title(sheet.cell(operation_start, 1), "Storage operation")
    sheet.merge_cells(
        start_row=operation_start, start_column=1, end_row=operation_start, end_column=6
    )
    operation_rows = [
        ("Peak charging", summary["peak_charge_gw"], "GW"),
        ("Peak discharging", summary["peak_discharge_gw"], "GW"),
        ("Total grid-side charging", summary["total_charge_gwh"], "GWh"),
        ("Total grid-side discharging", summary["total_discharge_gwh"], "GWh"),
        ("Conversion losses", summary["conversion_losses_gwh"], "GWh"),
        ("Equivalent full cycles", summary["equivalent_cycles"], "cycles"),
    ]
    for row, (label, value, unit) in enumerate(operation_rows, start=operation_start + 1):
        _label(sheet.cell(row, 1), label)
        sheet.cell(row, 2, value).number_format = "0.000"
        sheet.cell(row, 3, unit)

    validation_start = operation_start + 8
    _section_title(sheet.cell(validation_start, 1), "Constraint validation")
    sheet.merge_cells(
        start_row=validation_start, start_column=1, end_row=validation_start, end_column=6
    )
    validation_rows = [
        ("Overall validation", "Passed" if result.validation["passed"] else "Failed"),
        ("Maximum SOC", result.validation["diagnostics"]["maximum_soc_gwh"]),
        ("Maximum charge", result.validation["diagnostics"]["maximum_charge_gw"]),
        ("Maximum discharge", result.validation["diagnostics"]["maximum_discharge_gw"]),
        (
            "Maximum internal charge / 06:00 day",
            result.validation["diagnostics"]["maximum_06_day_internal_charge_gwh"],
        ),
        (
            "Maximum internal discharge / 06:00 day",
            result.validation["diagnostics"]["maximum_06_day_internal_discharge_gwh"],
        ),
        (
            "Simultaneous charge/discharge",
            result.validation["checks"]["simultaneous_charge_discharge_gw"],
        ),
        ("Final SOC", result.validation["checks"]["final_soc_abs_gwh"]),
    ]
    for row, (label, value) in enumerate(validation_rows, start=validation_start + 1):
        _label(sheet.cell(row, 1), label)
        sheet.cell(row, 2, value)
        if isinstance(value, (int, float)):
            sheet.cell(row, 2).number_format = "0.000000"

    daily_start = validation_start + 11
    _section_title(sheet.cell(daily_start, 1), "Daily performance")
    sheet.merge_cells(start_row=daily_start, start_column=1, end_row=daily_start, end_column=6)
    daily_headers = (
        "Date",
        "Minimum gap before (GW)",
        "Minimum gap after (GW)",
        "Shortage before (GWh)",
        "Shortage after (GWh)",
        "Equivalent cycles",
    )
    for column, value in enumerate(daily_headers, start=1):
        cell = sheet.cell(daily_start + 1, column, value)
        cell.font = Font(name="Aptos", bold=True, color=WHITE)
        cell.fill = PatternFill("solid", fgColor=TEAL)
    for row, daily in enumerate(result.daily_performance, start=daily_start + 2):
        values = (
            daily["date"],
            daily["minimum_gap_before_gw"],
            daily["minimum_gap_after_gw"],
            daily["shortage_energy_before_gwh"],
            daily["shortage_energy_after_gwh"],
            daily["equivalent_cycles"],
        )
        for column, value in enumerate(values, start=1):
            sheet.cell(row, column, value)
            if column > 1:
                sheet.cell(row, column).number_format = "0.000"

    widths = {1: 34, 2: 18, 3: 18, 4: 35, 5: 18, 6: 30}
    for column, width in widths.items():
        sheet.column_dimensions[get_column_letter(column)].width = width


def _style_hourly_sheet(
    workbook: Workbook,
    validated: ValidatedInput,
    result: OptimizationResult,
) -> None:
    sheet = workbook.create_sheet("Hourly Results")
    sheet.sheet_view.showGridLines = False
    sheet.freeze_panes = "A2"
    headers = (
        "Timestamp",
        "Demand (GW)",
        "Available Supply (GW)",
        "Solar (GW)",
        "Raw Gap (GW)",
        "Storage Charge (GW)",
        "Storage Discharge (GW)",
        "Storage Dispatch (GW)",
        "Adjusted Supply (GW)",
        "Residual Gap (GW)",
        "SOC End (GWh)",
        "06:00 Accounting Day",
    )
    for column, value in enumerate(headers, start=1):
        cell = sheet.cell(1, column, value)
        cell.font = Font(name="Aptos", bold=True, color=WHITE)
        cell.fill = PatternFill("solid", fgColor=NAVY)
        cell.alignment = Alignment(horizontal="center", vertical="center")

    for index, timestamp in enumerate(result.timestamps, start=2):
        source = index - 2
        values = (
            timestamp,
            result.demand[source],
            result.supply[source],
            result.solar[source] if validated.solar_provided else None,
            result.raw_gap[source],
            result.charge[source],
            result.discharge[source],
            result.dispatch[source],
            result.adjusted_supply[source],
            result.residual_gap[source],
            result.soc_end[source],
            result.accounting_days[source],
        )
        for column, value in enumerate(values, start=1):
            sheet.cell(index, column, value)
        sheet.cell(index, 1).number_format = "yyyy-mm-dd hh:mm"
        for column in range(2, 12):
            sheet.cell(index, column).number_format = "0.000000"

    table = Table(displayName="HourlyStorageResults", ref=f"A1:L{len(result.timestamps) + 1}")
    table.tableStyleInfo = TableStyleInfo(
        name="TableStyleMedium2",
        showFirstColumn=False,
        showLastColumn=False,
        showRowStripes=True,
        showColumnStripes=False,
    )
    sheet.add_table(table)
    widths = (20, 16, 22, 14, 16, 20, 23, 23, 22, 20, 18, 22)
    for column, width in enumerate(widths, start=1):
        sheet.column_dimensions[get_column_letter(column)].width = width


def build_results_workbook(
    validated: ValidatedInput,
    spec: StorageSpec,
    result: OptimizationResult,
) -> bytes:
    workbook = Workbook()
    workbook.properties.title = "Storage Dispatch Optimiser v2 — Progressive Leximin"
    workbook.properties.description = (
        "; ".join(METHOD_OBJECTIVES)
        + ". Solar is optional reference-only; blank means not supplied. "
        "Hour counts use a 1 kW numerical zero tolerance."
    )
    _style_summary_sheet(workbook, validated, spec, result)
    _style_hourly_sheet(workbook, validated, result)
    for sheet in workbook.worksheets:
        sheet.sheet_properties.pageSetUpPr.fitToPage = True
        sheet.page_setup.fitToWidth = 1
        sheet.page_setup.fitToHeight = 0
        sheet.sheet_properties.outlinePr.summaryBelow = True
        for row in sheet.iter_rows():
            for cell in row:
                if cell.row > 1 and cell.font == Font():
                    cell.font = Font(name="Aptos", size=10, color=NAVY)
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()
