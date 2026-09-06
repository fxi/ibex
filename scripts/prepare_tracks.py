"""Stream private source tracks into clean, clipped evaluation portions."""

import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

import ijson

BBOX = [5.80, 45.95, 6.55, 46.45]


def distance(a, b):
    x = math.radians(b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2))
    y = math.radians(b[1] - a[1])
    return 6371000 * math.hypot(x, y)


def clip(a, b, bbox=BBOX):
    """Liang–Barsky segment clipping; retain exact artificial boundary points."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    low, high = 0.0, 1.0
    for p, q in [
        (-dx, a[0] - bbox[0]),
        (dx, bbox[2] - a[0]),
        (-dy, a[1] - bbox[1]),
        (dy, bbox[3] - a[1]),
    ]:
        if p == 0:
            if q < 0:
                return None
        else:
            t = q / p
            if p < 0:
                low = max(low, t)
            else:
                high = min(high, t)
    if low > high:
        return None
    return [
        [a[0] + low * dx, a[1] + low * dy],
        [a[0] + high * dx, a[1] + high * dy],
    ], low > 0 or high < 1


def portions(coords):
    segment, reasons = [], set()
    for a, b in zip(coords, coords[1:]):
        if a == b:
            continue
        if distance(a, b) > 1000:
            if len(segment) > 1:
                yield segment, sorted(reasons | {"gps-gap"})
            segment, reasons = [], {"gps-gap"}
            continue
        result = clip(a, b)
        if result is None:
            if len(segment) > 1:
                yield segment, sorted(reasons | {"boundary"})
            segment, reasons = [], {"boundary"}
            continue
        (start, end), cut = result
        if segment and distance(segment[-1], start) > 0.1:
            if len(segment) > 1:
                yield segment, sorted(reasons | {"boundary"})
            segment = []
        if not segment:
            segment = [start]
        segment.append(end)
        if cut:
            reasons.add("boundary")
    if len(segment) > 1:
        yield segment, sorted(reasons)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="data/heatmap.geojson")
    parser.add_argument("--output", default="data/derived")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    counts = Counter()
    features = []
    with open(args.input, "rb") as handle:
        for feature in ijson.items(handle, "features.item", use_float=True):
            counts["sourceActivities"] += 1
            props = feature["properties"]
            if props.get("sport_type") not in {
                "Ride",
                "GravelRide",
                "MountainBikeRide",
            }:
                continue
            counts["cyclingActivities"] += 1
            for index, (coords, cuts) in enumerate(
                portions(feature["geometry"]["coordinates"])
            ):
                length = sum(distance(a, b) for a, b in zip(coords, coords[1:]))
                if length < 2000:
                    continue
                # Keep the original detailed geometry for matching. No public output here.
                features.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "activityId": str(props["id"]),
                            "portionId": f"{props['id']}:{index}",
                            "date": props["date"],
                            "sport": props["sport_type"],
                            "cuts": cuts,
                            "lengthM": round(length),
                            "closed": distance(coords[0], coords[-1]) < 250,
                        },
                        "geometry": {"type": "LineString", "coordinates": coords},
                    }
                )
    counts["portions"] = len(features)
    target = output / "tracks.geojson"
    target.write_text(
        json.dumps(
            {"type": "FeatureCollection", "features": features}, separators=(",", ":")
        )
    )
    report = {
        "schemaVersion": 1,
        "bbox": BBOX,
        "gapThresholdM": 1000,
        "minimumPortionM": 2000,
        "counts": dict(counts),
        "sourceSha256": hashlib.file_digest(
            open(args.input, "rb"), "sha256"
        ).hexdigest(),
    }
    (output / "tracks-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
