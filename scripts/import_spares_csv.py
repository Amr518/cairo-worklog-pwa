#!/usr/bin/env python3
"""
JD Edwards Daily Spare Parts CSV -> spare_parts_data.json Converter
For Servier Egypt Maintenance Unified PWA (cairo-worklog-pwa)

Usage:
  python3 scripts/import_spares_csv.py /path/to/Spars_Parts.csv [spare_parts_data.json]

Handles:
- Deduplicating JDE multi-warehouse placeholder rows (P) and depleted lots (S)
- Smart JDE 25-char Description + Description Line 2 reconstruction
- Extracting latest receipt date from YYYYMMDD Lot/Serial numbers
- Mapping Business Units (SPW01..SPW05) and Bin Location prefixes to equipment groups
- Compact JSON output (~350 KB for 2,382 SKUs) optimized for offline PWA caching
"""

import csv
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

WAREHOUSE_NAMES = {
    "SPW01": "SPW01 — Acacia",
    "SPW02": "SPW02 — Palmier",
    "SPW03": "SPW03 — Store 03",
    "SPW04": "SPW04 — Store 04",
    "SPW05": "SPW05 — Store 05",
}

EQUIP_GROUP_MAP = {
    "CAM": "CAM Packaging",
    "FE": "Fette Compression",
    "GEASP": "GEA Granulation",
    "BLISTER": "Blister Lines",
    "MANESTY": "Manesty Coating",
    "GUK": "GUK Folder",
    "QC": "QC Lab",
    "BUNDLING": "Bundling",
    "HVAC": "HVAC & AHU",
    "FORKLIFT": "Forklift",
    "IMAFLEXA": "IMA Flexa Cartoner",
    "BMS": "BMS / EMS",
    "STEAMBOI": "Steam Boiler",
    "BOILER": "Steam Boiler",
    "PWP": "Purified Water (PW)",
    "DMXTHEM": "DMX / Thermoforming",
    "GS": "GS Coating",
    "CHILLER": "Chillers",
    "LABELING": "Labeling",
    "AIRBOXER": "Airboxer",
    "COUNTING": "Counting (PPS)",
    "MG": "MG2 Capsule Filling",
    "ATLASCOP": "Compressed Air",
    "COMAIRL": "Compressed Air",
    "KARLVILE": "Karlville",
    "PRODIECO": "Prodieco",
    "NERI": "Neri",
    "PUC": "PUC",
    "SEAV": "Sea Vision",
    "SEAVSION": "Sea Vision",
    "STANDGEN": "Standby Generator",
    "LIGHTING": "Lighting",
    "SVIAC": "Sviac Compression",
    "FILTERS": "Filters",
    "BOHLE": "Bohle Blender",
    "CLEANTEK": "CleanTek",
    "ELECTRIC": "Electrical Distribution",
    "POWERFAC": "Electrical Distribution",
    "FIREFITG": "Fire Fighting",
    "CHEMICAL": "Chemicals",
    "SAMPBOTH": "Sampling Booth",
    "WEIGHING": "Weighing",
    "BATTERY": "Batteries",
}


def merge_description(raw_d1: str, raw_d2: str):
    """Smartly reconstruct JDE 25-char split Description + Line 2, and detect catalog/OEM code."""
    d1 = (raw_d1 or "").strip()
    d2 = (raw_d2 or "").strip()
    if not d2:
        return d1, ""
    if d2.lower() == d1.lower():
        return d1, ""

    # Detect if Line 2 is a standalone OEM / catalog reference code
    ref_code = ""
    if len(d1) < 24 and re.match(r"^[A-Z0-9][A-Z0-9\-\./]{4,}$", d2):
        ref_code = d2
        return d1, ref_code

    # JDE wraps mid-word at exactly 25 chars without trailing/leading whitespace
    if (
        len(raw_d1) >= 25
        and not raw_d1.endswith(" ")
        and not raw_d2.startswith(" ")
        and (d2[0].islower() or d2[0] in ".-/)" or (raw_d1[-1] in "-./("))
    ):
        full = (d1 + d2).strip()
    else:
        full = f"{d1} {d2}".strip()

    full = re.sub(r"\s+", " ", full)
    return full, ref_code


def parse_lot_date(lot: str) -> str:
    """Extract YYYY-MM-DD receipt date if Lot/Serial starts with a valid YYYYMMDD."""
    m = re.match(r"^(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])", (lot or "").strip())
    if not m:
        return ""
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"


def resolve_equip_group(loc: str) -> str:
    if not loc:
        return "General Store"
    m = re.match(r"^([A-Za-z]+)", loc)
    if not m:
        return "General Store"
    pref = m.group(1).upper()
    return EQUIP_GROUP_MAP.get(pref, "General Store")


def convert_csv(csv_path: str, out_path: str, source_date: str = ""):
    with open(csv_path, "r", encoding="utf-8-sig", errors="replace") as f:
        rows = list(csv.DictReader(f))

    items = {}
    anomalies = []

    for r in rows:
        code = (r.get("[Item Number]") or "").strip()
        if not code:
            continue

        bu = (r.get("[Business Unit]") or "").strip()
        raw_loc = (r.get("[Location]") or "").strip()
        loc = re.sub(r"\s+", " ", raw_loc)
        raw_d1 = r.get("[Description]") or ""
        raw_d2 = r.get("[Description - Line 2]") or ""
        lot = (r.get("[Lot/Serial Number]") or "").strip()
        ps = (r.get("[Primary Location (P/S)]") or "").strip()

        q_raw = (r.get("[Quantity on Hand - Primary units]") or "0").replace(",", "").strip()
        try:
            qf = float(q_raw) if q_raw else 0.0
            qty = int(qf) if qf == int(qf) else round(qf, 2)
        except ValueError:
            qty = 0

        if qty < 0:
            anomalies.append({"code": code, "bu": bu, "loc": loc, "qty": qty, "lot": lot})

        if code not in items:
            full_name, ref_code = merge_description(raw_d1, raw_d2)
            items[code] = {
                "code": code,
                "name": full_name,
                "ref": ref_code,
                "qty": 0,
                "primary_bu": "",
                "primary_loc": "",
                "all_locs": set(),
                "bu_qty": defaultdict(int),
                "bin_qty": defaultdict(int),
                "last_date": "",
                "all_dates": [],
            }

        it = items[code]
        if not it["name"] and raw_d1.strip():
            it["name"], it["ref"] = merge_description(raw_d1, raw_d2)

        it["qty"] += qty
        if loc:
            it["all_locs"].add(loc)
            if not it["primary_loc"] and ps == "P":
                it["primary_loc"] = loc

        lot_dt = parse_lot_date(lot)
        if lot_dt:
            it["all_dates"].append(lot_dt)

        if qty > 0:
            if bu:
                it["bu_qty"][bu] += qty
            it["bin_qty"][(bu, loc)] += qty
            if lot_dt and lot_dt > it["last_date"]:
                it["last_date"] = lot_dt

    parts_list = []
    bu_counts = defaultdict(lambda: {"skus": 0, "in_stock": 0, "units": 0})
    group_counts = defaultdict(int)

    in_stock_count = 0
    low_stock_count = 0
    zero_stock_count = 0
    total_units = 0

    for code, it in items.items():
        qty = max(0, it["qty"])
        if qty > 0:
            in_stock_count += 1
            total_units += qty
            if qty <= 2:
                low_stock_count += 1
        else:
            zero_stock_count += 1

        # Determine primary warehouse (highest in-stock qty, else SPW01/first available)
        if it["bu_qty"]:
            main_bu = sorted(it["bu_qty"].items(), key=lambda x: (-x[1], x[0]))[0][0]
        else:
            main_bu = "SPW01"

        # Determine primary bin (highest qty active bin, else primary_loc, else first loc)
        if it["bin_qty"]:
            main_bu_bin, main_loc = sorted(it["bin_qty"].items(), key=lambda x: (-x[1], x[0][0], x[0][1]))[0][0]
            if main_bu_bin:
                main_bu = main_bu_bin
            loc = main_loc or it["primary_loc"] or (sorted(it["all_locs"])[0] if it["all_locs"] else "")
        else:
            loc = it["primary_loc"] or (sorted(it["all_locs"])[0] if it["all_locs"] else "")

        group = resolve_equip_group(loc)
        group_counts[group] += 1

        bins = []
        if it["bin_qty"]:
            for (b_bu, b_loc), b_q in sorted(it["bin_qty"].items(), key=lambda x: (-x[1], x[0][0], x[0][1])):
                bins.append({"bu": b_bu, "loc": b_loc, "qty": b_q})
                bu_counts[b_bu]["in_stock"] += 1
                bu_counts[b_bu]["units"] += b_q

        bu_counts[main_bu]["skus"] += 1

        last_date = it["last_date"] or (max(it["all_dates"]) if it["all_dates"] else "")

        rec = {
            "code": code,
            "name": it["name"] or code,
            "qty": qty,
            "bu": main_bu,
            "loc": loc,
            "grp": group,
        }
        if it["ref"]:
            rec["ref"] = it["ref"]
        if last_date:
            rec["dt"] = last_date
        if len(bins) > 1:
            rec["bins"] = bins

        parts_list.append(rec)

    # Sort: In Stock first (highest qty), then Zero Stock alphabetically
    parts_list.sort(key=lambda p: (0 if p["qty"] > 0 else 1, -p["qty"], p["grp"], p["code"]))

    # Load previous snapshot (if any) to compute simple daily changes
    prev_map = {}
    had_prev = False
    if os.path.exists(out_path):
        try:
            with open(out_path, "r", encoding="utf-8") as pf:
                prev_data = json.load(pf)
            prev_parts = prev_data.get("parts") or []
            if prev_parts:
                had_prev = True
                for pp in prev_parts:
                    p_code = str(pp.get("code") or "").strip()
                    if p_code:
                        prev_map[p_code] = {
                            "qty": pp.get("qty", 0),
                            "bu": pp.get("bu", ""),
                            "loc": pp.get("loc", ""),
                            "name": pp.get("name", ""),
                        }
        except Exception:
            had_prev = False

    changes = {"total": 0, "added": 0, "increased": 0, "decreased": 0, "newly_out": 0}
    any_data_diff = not had_prev

    if had_prev:
        new_codes = set()
        for rec in parts_list:
            code = rec["code"]
            new_codes.add(code)
            qty = rec["qty"]
            if code not in prev_map:
                rec["chg"] = "new"
                changes["added"] += 1
                changes["total"] += 1
                any_data_diff = True
            else:
                prev = prev_map[code]
                p_qty = prev["qty"]
                if qty > p_qty:
                    rec["chg"] = "up"
                    rec["prev"] = p_qty
                    changes["increased"] += 1
                    changes["total"] += 1
                    any_data_diff = True
                elif qty == 0 and p_qty > 0:
                    rec["chg"] = "out"
                    rec["prev"] = p_qty
                    changes["newly_out"] += 1
                    changes["total"] += 1
                    any_data_diff = True
                elif qty < p_qty:
                    rec["chg"] = "down"
                    rec["prev"] = p_qty
                    changes["decreased"] += 1
                    changes["total"] += 1
                    any_data_diff = True
                elif rec["bu"] != prev["bu"] or rec["loc"] != prev["loc"] or rec["name"] != prev["name"]:
                    any_data_diff = True

        if len(new_codes) != len(prev_map):
            any_data_diff = True

        if not any_data_diff:
            print("No inventory changes detected vs existing spare_parts_data.json; keeping existing file.")
            return

    warehouses = [
        {"code": bu, "name": WAREHOUSE_NAMES.get(bu, bu)}
        for bu in sorted(WAREHOUSE_NAMES.keys())
        if bu in bu_counts or bu in ("SPW01", "SPW02", "SPW03", "SPW04", "SPW05")
    ]

    groups = [
        {"name": g, "count": c}
        for g, c in sorted(group_counts.items(), key=lambda x: (-x[1], x[0]))
    ]

    exported_at = source_date or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    payload = {
        "version": "2.1",
        "source": "JDE Daily Inventory Report",
        "exported_at": exported_at,
        "stats": {
            "total_skus": len(parts_list),
            "in_stock": in_stock_count,
            "low_stock": low_stock_count,
            "zero_stock": zero_stock_count,
            "total_units": total_units,
            "anomalies": len(anomalies),
        },
        "changes": changes,
        "warehouses": warehouses,
        "groups": groups,
        "parts": parts_list,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(out_path) / 1024
    print(f"Exported {len(parts_list)} unique SKUs to {out_path} ({size_kb:.1f} KB)")
    print("Stats:", payload["stats"])
    print("Changes:", changes)
    if anomalies:
        print("Anomalies (negative stock rows ignored/clamped):", anomalies)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/import_spares_csv.py <input.csv> [output.json]")
        sys.exit(1)
    inp = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "spare_parts_data.json"
    convert_csv(inp, out)
