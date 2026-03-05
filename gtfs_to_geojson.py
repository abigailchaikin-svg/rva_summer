import os
import json
import zipfile
from collections import defaultdict

import pandas as pd

# -----------------------
# Paths (edit if needed)
# -----------------------
GTFS_ZIP_PATH = "data/gtfs/grtc_gtfs.zip"  # put your downloaded GTFS zip here

OUT_STOPS = "data/grtc_stops.geojson"
OUT_DAY = "data/grtc_day_routes.geojson"
OUT_NIGHT = "data/grtc_night_routes.geojson"

# -----------------------
# Helpers
# -----------------------
def pick_name(zf, base):
    """
    Your zip listing shows files like 'calendar', 'routes', etc.
    In practice GTFS uses .txt (calendar.txt). This function supports BOTH.
    """
    candidates = [f"{base}.txt", base]
    for c in candidates:
        if c in zf.namelist():
            return c
    raise KeyError(f"Missing GTFS file: {base}.txt (or {base})")

def read_gtfs(zf, base):
    name = pick_name(zf, base)
    with zf.open(name) as f:
        return pd.read_csv(f, dtype=str)

def to_num(s):
    return pd.to_numeric(s, errors="coerce")

def feature_collection(features):
    return {"type": "FeatureCollection", "features": features}

def point_feature(lon, lat, props):
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
    }

def line_feature(coords, props):
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {"type": "LineString", "coordinates": coords},
    }

def parse_gtfs_time_to_minutes(t):
    """
    GTFS times can exceed 24:00:00 (e.g., 25:30:00) to represent after midnight.
    Returns minutes since 00:00 (can exceed 1440).
    """
    if not isinstance(t, str) or ":" not in t:
        return None
    parts = t.strip().split(":")
    if len(parts) < 2:
        return None
    try:
        h = int(parts[0])
        m = int(parts[1])
        s = int(parts[2]) if len(parts) > 2 else 0
        return h * 60 + m + (1 if s >= 30 else 0)
    except:
        return None

def is_night_minutes(mins):
    """
    Define "night service" by time-of-day:
      - >= 21:00 (1260 minutes)
      - OR between 00:00 and 04:30 (0..270 minutes)
      - OR any time >= 24:00 (1440+) also counts as night (after midnight)
    This is a reasonable GTFS-based rule without relying on external lists.
    """
    if mins is None:
        return False
    if mins >= 1440:
        return True
    if mins >= 21 * 60:
        return True
    if mins <= 4 * 60 + 30:
        return True
    return False

# -----------------------
# Main
# -----------------------
def main():
    if not os.path.exists(GTFS_ZIP_PATH):
        raise FileNotFoundError(f"GTFS zip not found: {GTFS_ZIP_PATH}")

    with zipfile.ZipFile(GTFS_ZIP_PATH) as zf:
        agency = read_gtfs(zf, "agency")
        routes = read_gtfs(zf, "routes")
        trips = read_gtfs(zf, "trips")
        stops = read_gtfs(zf, "stops")
        stop_times = read_gtfs(zf, "stop_times")
        shapes = read_gtfs(zf, "shapes")  # critical for geometry [1](https://venturerichmond.com/our-events/)

    # -----------------------
    # STOPS -> GeoJSON
    # -----------------------
    stops["stop_lat"] = to_num(stops.get("stop_lat"))
    stops["stop_lon"] = to_num(stops.get("stop_lon"))

    stop_features = []
    for _, r in stops.dropna(subset=["stop_lat", "stop_lon"]).iterrows():
        props = {
            "stop_id": r.get("stop_id"),
            "stop_name": r.get("stop_name"),
        }
        stop_features.append(
            point_feature(float(r["stop_lon"]), float(r["stop_lat"]), props)
        )

    os.makedirs(os.path.dirname(OUT_STOPS), exist_ok=True)
    with open(OUT_STOPS, "w", encoding="utf-8") as f:
        json.dump(feature_collection(stop_features), f)

    # -----------------------
    # Determine NIGHT trips using stop_times
    # -----------------------
    # Use departure_time if present, otherwise arrival_time
    time_col = "departure_time" if "departure_time" in stop_times.columns else "arrival_time"
    times = stop_times[[ "trip_id", time_col ]].copy()
    times["mins"] = times[time_col].apply(parse_gtfs_time_to_minutes)

    # Mark a trip as "night" if ANY stop time matches night rule
    trip_is_night = times.groupby("trip_id")["mins"].apply(
        lambda s: any(is_night_minutes(x) for x in s.dropna().tolist())
    )
    night_trip_ids = set(trip_is_night[trip_is_night].index.astype(str))

    # -----------------------
    # Build representative shape per route+direction (separately for day and night)
    # -----------------------
    # Normalize key fields
    if "direction_id" not in trips.columns:
        trips["direction_id"] = "0"
    trips["direction_id"] = trips["direction_id"].fillna("0").astype(str)
    trips["trip_id"] = trips["trip_id"].astype(str)
    trips["route_id"] = trips["route_id"].astype(str)
    trips["shape_id"] = trips["shape_id"].astype(str)

    routes["route_id"] = routes["route_id"].astype(str)
    routes["route_short_name"] = routes.get("route_short_name", "").astype(str)
    routes["route_long_name"] = routes.get("route_long_name", "").astype(str)

    # Shapes points
    shapes["shape_id"] = shapes["shape_id"].astype(str)
    shapes["shape_pt_lat"] = to_num(shapes.get("shape_pt_lat"))
    shapes["shape_pt_lon"] = to_num(shapes.get("shape_pt_lon"))
    shapes["shape_pt_sequence"] = to_num(shapes.get("shape_pt_sequence"))

    shapes = shapes.dropna(subset=["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"])
    shape_counts = shapes.groupby("shape_id")["shape_pt_sequence"].count().rename("pt_count").reset_index()
    shapes_by_id = {sid: df for sid, df in shapes.groupby("shape_id")}

    # Join trips + route info + shape point counts
    trips2 = trips.merge(
        routes[["route_id", "route_short_name", "route_long_name", "route_type"]],
        on="route_id",
        how="left"
    ).merge(shape_counts, on="shape_id", how="left")

    trips2["pt_count"] = trips2["pt_count"].fillna(0)
    trips2["is_night"] = trips2["trip_id"].isin(night_trip_ids)

    def build_features(is_night_flag: bool):
        subset = trips2[trips2["is_night"] == is_night_flag].copy()
        if subset.empty:
            return []

        # Choose the "best" shape per (route_id, direction_id) by max pt_count
        reps = (
            subset.sort_values("pt_count", ascending=False)
            .groupby(["route_id", "direction_id"], as_index=False)
            .first()
        )

        features = []
        for _, rep in reps.iterrows():
            sid = str(rep.get("shape_id"))
            if sid not in shapes_by_id:
                continue
            df = shapes_by_id[sid].sort_values("shape_pt_sequence")
            coords = [
                [float(lon), float(lat)]
                for lon, lat in zip(df["shape_pt_lon"], df["shape_pt_lat"])
            ]
            if len(coords) < 2:
                continue

            props = {
                "route_id": rep.get("route_id"),
                "route_short_name": str(rep.get("route_short_name") or "").strip(),
                "route_long_name": str(rep.get("route_long_name") or "").strip(),
                "direction_id": str(rep.get("direction_id") or "0").strip(),
                "service": "night" if is_night_flag else "day"
            }
            features.append(line_feature(coords, props))
        return features

    night_features = build_features(True)
    day_features = build_features(False)

    with open(OUT_DAY, "w", encoding="utf-8") as f:
        json.dump(feature_collection(day_features), f)

    with open(OUT_NIGHT, "w", encoding="utf-8") as f:
        json.dump(feature_collection(night_features), f)

    print("Wrote GeoJSON:")
    print(" ", OUT_STOPS, f"({len(stop_features)} stops)")
    print(" ", OUT_DAY, f"({len(day_features)} route-direction lines)")
    print(" ", OUT_NIGHT, f"({len(night_features)} route-direction lines)")


if __name__ == "__main__":
    main()
