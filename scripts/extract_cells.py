"""Cut the filtered release pbf into one complete pbf per download cell.

Each cell is extracted with its halo so the bounded post-passes (utility 1 km, reward
2,347 m) and terrain sampling see every neighbour that can influence an edge the cell owns.
`complete_ways` keeps ways crossing the boundary whole, which is what lets a boundary edge
carry the same deterministic identity in both adjacent cells.

osmium reads the input once for all cells, so this costs one pass rather than sixteen.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from grid import cell_bbox, cell_id
from region_config import (
    GRID_ZOOM,
    HALO_KM,
    WINDOW,
    halo_degrees,
    parse_window,
    release_cells,
)


def cell_source_bbox(zoom, x, y, halo_km):
    """A cell's own bounds grown by the halo."""
    bbox = cell_bbox(zoom, x, y)
    dx, dy = halo_degrees(bbox, halo_km)
    return [bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="data/pbf/release.osm.pbf")
    parser.add_argument("--directory", default="data/pbf/cells")
    parser.add_argument("--window", default=None)
    parser.add_argument("--halo-km", type=float, default=HALO_KM)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if not shutil.which("osmium"):
        raise SystemExit("osmium-tool is required (brew install osmium-tool)")
    source = Path(args.input)
    if not source.exists():
        raise SystemExit(f"{source} missing — run clip_region.py first")

    zoom, window = parse_window(args.window) if args.window else (GRID_ZOOM, WINDOW)
    directory = Path(args.directory)
    directory.mkdir(parents=True, exist_ok=True)
    cells = release_cells(window, zoom)

    extracts = [
        {
            "output": f"{cell_id(zoom, x, y)}.osm.pbf",
            "bbox": cell_source_bbox(zoom, x, y, args.halo_km),
        }
        for x, y in cells
    ]
    state = {
        "input": str(source),
        "inputBytes": source.stat().st_size,
        "haloKm": args.halo_km,
        "window": list(window),
        "zoom": zoom,
    }
    stamp = directory / "cells.source.json"
    if stamp.exists() and not args.force:
        previous = json.loads(stamp.read_text())
        if previous.get("inputs") == state and all(
            (directory / e["output"]).exists() for e in extracts
        ):
            print(f"Using cached cell extracts in {directory}")
            for entry in previous["cells"]:
                print(f"  {entry['id']:<12} {entry['bytes'] / 1e6:>6.1f} MB")
            return 0

    config = directory / "extract-config.json"
    config.write_text(
        json.dumps({"directory": str(directory), "extracts": extracts}, indent=2) + "\n"
    )
    command = [
        "osmium",
        "extract",
        "--config",
        str(config),
        "--strategy",
        "complete_ways",
        "--overwrite",
        str(source),
    ]
    print("$ " + " ".join(command))
    subprocess.run(command, check=True)

    # Give each cell the release provenance so a cell build records a real edition.
    release_stamp = source.with_suffix(".source.json")
    osm_timestamp = ""
    if release_stamp.exists():
        osm_timestamp = json.loads(release_stamp.read_text()).get("osmTimestamp", "")

    entries = []
    for (x, y), extract in zip(cells, extracts):
        path = directory / extract["output"]
        (directory / f"{cell_id(zoom, x, y)}.osm.source.json").write_text(
            json.dumps({"osmTimestamp": osm_timestamp}, indent=2) + "\n"
        )
        entries.append(
            {
                "id": cell_id(zoom, x, y),
                "x": x,
                "y": y,
                "file": str(path),
                "bytes": path.stat().st_size,
                "sourceBbox": [round(v, 6) for v in extract["bbox"]],
            }
        )
    stamp.write_text(
        json.dumps({"inputs": state, "cells": entries}, indent=2, sort_keys=True) + "\n"
    )
    total = sum(e["bytes"] for e in entries)
    print(f"\n{len(entries)} cell extracts, {total / 1e6:.0f} MB total")
    for entry in sorted(entries, key=lambda e: -e["bytes"]):
        print(f"  {entry['id']:<12} {entry['bytes'] / 1e6:>6.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
