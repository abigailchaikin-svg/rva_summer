#!/usr/bin/env python3
"""
GTFS -> GeoJSON (GRTC)
Outputs:
  - data/grtc_stops.geojson
  - data/grtc_day_routes.geojson
  - data/grtc_night_routes.geojson

Requirements: Python 3.x (standard library only)

Assumptions:
- Your GTFS zip includes: routes, trips, stops, stop_times, shapes (with or without .txt extension)
- shapes provides the polyline geometry (LineString)
- "Night" is inferred from stop_times:
    >= 21:00, or <= 04:30, or any time >= 24:00 (after-midnight GTFS format)
"""

import os
import json
import csv
import zipfile
from collections import defaultdict

# -----------------------
# CONFIG: edit these
# -----------------------
GTFS_ZIP_PATH = "data/gtfs/grtc_gtfs.zip"  # <-- put your GTFS zip here

OUT_STOPS = "data/grtc_stops.geojson"
OUT_DAY = "data/grtc_day_routes.geojson"
OUT_NIGHT = "data/grtc_night_routes.geojson"


# -----------------------
# Helpers
# -----------------------
def ensure_dir(path):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)

def pick_member(zf: zipfile.ZipFile, base: str) -> str:
    """
    Supports GTFS feeds where files are named either 'routes.txt' or 'routes'
    (your listing shows names without .txt).
    """
    candidates = (f"{base}.txt", base)
    for name in candidates:
        if name in zf.namelist():
            return name
    raise FileNotFoundError(f"Missing {base}.txt (or {base}) in GTFS zip")

def iter_csv_rows(zf: zipfile.ZipFile, member_name: str):
    with zf.open(member_name) as f:
        # GTFS is UTF-8 typically; errors='replace' avoids crashes on odd chars
        text = (line.decode("utf-8", errors="replace") for line in f)
        reader = csv.DictReader(text)
        for row in reader:
            yield row

def parse_gtfs_time_to_minutes(t: str):
    """
    GTFS allows times beyond 24:00:00 (e.g., 25:15:00).
    Returns minutes since 00:00, can exceed 1440.
    """
    if not t or ":" not in t:
        return None
    parts = t.strip().split(":")
    if len(parts) < 2:
        return None
    try:
        h = int(parts[0])
        m = int(parts[1])
        s = int(parts[2]) if len(parts) > 2 else 0
        mins = h * 60 + m
        # optional rounding for seconds
        if s >= 30:
            mins += 1
        return mins
    except ValueError:
        return None

def is_night_minutes(mins: int) -> bool:
    """
    Night definition:
      - >= 21:00
      - OR between 00:00 and 04:30
      - OR any time >= 24:00 (after midnight GTFS representation)
    """
    if mins is None:
        return False
    if mins >= 1440:
        return True
    if mins >= 21 * 60:
        return True
    if mins <= (4 * 60 + 30):
        return True
    return False

def feature_collection(features):
    return {"type": "FeatureCollection", "features": features}

def point_feature(lon, lat, props):
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "Point", "coordinates": [lon, lat]}}

def line_feature(coords, props):
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "LineString", "coordinates": coords}}

def safe_float(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


# -----------------------
# Main conversion
# -----------------------
def main():
    if not os.path.exists(GTFS_ZIP_PATH):
        raise FileNotFoundError(f"GTFS zip not found at: {GTFS_ZIP_PATH}")

    ensure_dir(OUT_STOPS)
    ensure_dir(OUT_DAY)
    ensure_dir(OUT_NIGHT)

    with zipfile.ZipFile(GTFS_ZIP_PATH) as zf:
        # Resolve members (support .txt or no extension)
        m_routes = pick_member(zf, "routes")
        m_trips = pick_member(zf, "trips")
        m_stops = pick_member(zf, "stops")
        m_stop_times = pick_member(zf, "stop_times")
        m_shapes = pick_member(zf, "shapes")

        # -----------------------
        # 1) Stops -> GeoJSON
        # -----------------------
        stop_features = []
        for r in iter_csv_rows(zf, m_stops):
            lat = safe_float(r.get("stop_lat"))
            lon = safe_float(r.get("stop_lon"))
            if lat is None or lon is None:
                continue
            props = {"stop_id": r.get("stop_id"), "stop_name": r.get("stop_name")}
            stop_features.append(point_feature(lon, lat, props))

        with open(OUT_STOPS, "w", encoding="utf-8") as f:
            json.dump(feature_collection(stop_features), f)

        # -----------------------
        # 2) Identify night trips using stop_times
        # -----------------------
        # Trip is "night" if ANY stop_time is in the night window.
        night_trip_ids = set()
        time_field = "departure_time"  # prefer departure_time
        # We do not assume both exist; check header via first row peek:
        # (csv.DictReader doesn't expose fieldnames until read)
        # We'll just handle fallback row-by-row.
        for r in iter_csv_rows(zf, m_stop_times):
            trip_id = r.get("trip_id")
            if not trip_id or trip_id in night_trip_ids:
                continue

            t = r.get(time_field) or r.get("arrival_time")
            mins = parse_gtfs_time_to_minutes(t)
            if is_night_minutes(mins):
                night_trip_ids.add(trip_id)

        # -----------------------
        # 3) Load routes (names) and trips (route/direction/shape)
        # -----------------------
        route_info = {}  # route_id -> {short,long,type}
        for r in iter_csv_rows(zf, m_routes):
            rid = r.get("route_id")
            if not rid:
                continue
            route_info[rid] = {
                "route_short_name": (r.get("route_short_name") or "").strip(),
                "route_long_name": (r.get("route_long_name") or "").strip(),
                "route_type": r.get("route_type"),
            }

        # We'll choose a representative shape per (route_id, direction_id) separately for day and night.
        # To do that, we need point counts per shape_id:
        shape_pt_counts = defaultdict(int)
        for r in iter_csv_rows(zf, m_shapes):
            sid = r.get("shape_id")
            if sid:
                shape_pt_counts[sid] += 1

        # Now process trips and record candidate shape_ids with counts:
        best_shape_day = {}    # (route_id, direction_id) -> (shape_id, count)
        best_shape_night = {}  # (route_id, direction_id) -> (shape_id, count)

        for r in iter_csv_rows(zf, m_trips):
            trip_id = r.get("trip_id")
            route_id = r.get("route_id")
            shape_id = r.get("shape_id")
            direction_id = (r.get("direction_id") or "0").strip()
            if not trip_id or not route_id or not shape_id:
                continue

            key = (route_id, direction_id)
            count = shape_pt_counts.get(shape_id, 0)
            is_night = trip_id in night_trip_ids

            target = best_shape_night if is_night else best_shape_day
            current = target.get(key)
            if current is None or count > current[1]:
                target[key] = (shape_id, count)

        # Collect the shape_ids we actually need to output
        needed_shape_ids_day = set(sid for (sid, _c) in best_shape_day.values())
        needed_shape_ids_night = set(sid for (sid, _c) in best_shape_night.values())
        needed_shape_ids = needed_shape_ids_day | needed_shape_ids_night

        # -----------------------
        # 4) Second pass through shapes: collect only needed shapes with sequences
        # -----------------------
        shape_points = defaultdict(list)  # shape_id -> list[(seq, lon, lat)]
        for r in iter_csv_rows(zf, m_shapes):
            sid = r.get("shape_id")
            if sid not in needed_shape_ids:
                continue
            lat = safe_float(r.get("shape_pt_lat"))
            lon = safe_float(r.get("shape_pt_lon"))
            seq = r.get("shape_pt_sequence")
            try:
                seq = int(float(seq)) if seq is not None else None
            except ValueError:
                seq = None
            if lat is None or lon is None or seq is None:
                continue
            shape_points[sid].append((seq, lon, lat))

        # Sort points by sequence and build coords
        shape_coords = {}
        for sid, pts in shape_points.items():
            pts.sort(key=lambda x: x[0])
            coords = [[lon, lat] for (_seq, lon, lat) in pts]
            if len(coords) >= 2:
                shape_coords[sid] = coords

        # -----------------------
        # 5) Build GeoJSON features (day + night)
        # -----------------------
        day_features = []
        for (route_id, direction_id), (shape_id, _count) in best_shape_day.items():
            coords = shape_coords.get(shape_id)
            if not coords:
                continue
            ri = route_info.get(route_id, {})
            props = {
                "route_id": route_id,
                "route_short_name": ri.get("route_short_name", ""),
                "route_long_name": ri.get("route_long_name", ""),
                "direction_id": direction_id,
                "service": "day",
            }
            day_features.append(line_feature(coords, props))

        night_features = []
        for (route_id, direction_id), (shape_id, _count) in best_shape_night.items():
            coords = shape_coords.get(shape_id)
            if not coords:
                continue
            ri = route_info.get(route_id, {})
            props = {
                "route_id": route_id,
                "route_short_name": ri.get("route_short_name", ""),
                "route_long_name": ri.get("route_long_name", ""),
                "direction_id": direction_id,
                "service": "night",
            }
            night_features.append(line_feature(coords, props))

        with open(OUT_DAY, "w", encoding="utf-8") as f:
            json.dump(feature_collection(day_features), f)

        with open(OUT_NIGHT, "w", encoding="utf-8") as f:
            json.dump(feature_collection(night_features), f)

    # Print a useful summary
    print("✅ Done. Wrote:")
    print(f"  {OUT_STOPS}  ({len(stop_features)} stops)")
    print(f"  {OUT_DAY}    ({len(day_features)} route-direction lines)")
    print(f"  {OUT_NIGHT}  ({len(night_features)} route-direction lines)")


if __name__ == "__main__":
    main()
