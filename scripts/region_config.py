"""Single definition of the published release: grid window, source halo, and inputs.

Replaces the BBOX constant once duplicated across the Overpass fetcher and prepare_tracks.py.
Every script derives its geometry from here so a window change is one edit.
"""

import argparse
import json
import math

from grid import cell_bbox, cell_id, cell_size_m, union_bbox

# Download cell, internal graph block, and cost-field raster zooms.
GRID_ZOOM = 9
BLOCK_ZOOM = 13
FIELD_ZOOM = 15
# Terrarium DEM zoom: 6.6 m/px at this latitude, up from zoom 12's 13.2 m/px.
TERRAIN_ZOOM = 13

# Inclusive zoom-9 window from Geneva to Toulon, including the Rhône valley
# and the French Alps through Briançon and Nice (40 cells).
WINDOW = (262, 180, 266, 187)

# The source graph is built with a halo so junctions on a cell edge keep their neighbours
# and the bounded post-passes (utility 1 km, reward 2,347 m) are exact for published cells.
HALO_KM = 5.0

# Geofabrik extracts covering the window plus halo, smallest sufficient set.
EXTRACTS = (
    "europe/france/rhone-alpes",
    "europe/france/franche-comte",
    "europe/france/bourgogne",
    "europe/france/auvergne",
    "europe/france/provence-alpes-cote-d-azur",
    "europe/france/languedoc-roussillon",
    "europe/switzerland",
    "europe/italy/nord-ovest",
)

# The pre-grid single-region bbox, kept for the pipeline regression diff.
LEGACY_BBOX = [5.80, 45.95, 6.55, 46.45]

# Raised whenever the pipeline changes the edge data it publishes; it rides in the release
# tag (see PREPROCESSOR_VERSION in scripts/package_cells.ts, which must match), so every
# installed pack is retired. 6 gives bridges and tunnels a portal-to-portal grade.
PREPROCESSOR_VERSION = 6


def release_cells(window=WINDOW, zoom=GRID_ZOOM):
    x0, y0, x1, y1 = window
    return [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


def release_cell_ids(window=WINDOW, zoom=GRID_ZOOM):
    return [cell_id(zoom, x, y) for x, y in release_cells(window, zoom)]


def release_bbox(window=WINDOW, zoom=GRID_ZOOM):
    """Published coverage: the union of the window's cells, already grid-aligned."""
    return union_bbox([cell_bbox(zoom, x, y) for x, y in release_cells(window, zoom)])


def halo_degrees(bbox, halo_km=HALO_KM):
    """Longitude uses the highest latitude in range, where a degree is shortest."""
    worst = max(abs(bbox[1]), abs(bbox[3]))
    return (
        halo_km / (111.32 * max(0.05, math.cos(math.radians(worst)))),
        halo_km / 111.32,
    )


def source_bbox(window=WINDOW, zoom=GRID_ZOOM, halo_km=HALO_KM):
    """What to clip out of the extracts: published coverage grown by the halo."""
    bbox = release_bbox(window, zoom)
    dx, dy = halo_degrees(bbox, halo_km)
    return [
        max(-180.0, bbox[0] - dx),
        max(-85.0, bbox[1] - dy),
        min(180.0, bbox[2] + dx),
        min(85.0, bbox[3] + dy),
    ]


def parse_window(text):
    """`z,x0,y0,x1,y1` — lets a smaller window be built without editing this file."""
    parts = [int(p) for p in text.split(",")]
    if len(parts) != 5:
        raise ValueError("Window must be z,x0,y0,x1,y1")
    zoom, x0, y0, x1, y1 = parts
    if x1 < x0 or y1 < y0:
        raise ValueError("Window must be ordered x0<=x1, y0<=y1")
    return zoom, (x0, y0, x1, y1)


def add_window_argument(parser):
    parser.add_argument(
        "--window",
        default=f"{GRID_ZOOM},{WINDOW[0]},{WINDOW[1]},{WINDOW[2]},{WINDOW[3]}",
        help="Release window as z,x0,y0,x1,y1",
    )
    return parser


def describe(window=WINDOW, zoom=GRID_ZOOM, halo_km=HALO_KM):
    bbox = release_bbox(window, zoom)
    cells = release_cells(window, zoom)
    size = cell_size_m(zoom, *cells[0]) / 1000
    return {
        "grid": {
            "scheme": "xyz",
            "zoom": zoom,
            "blockZoom": BLOCK_ZOOM,
            "fieldZoom": FIELD_ZOOM,
        },
        "terrainZoom": TERRAIN_ZOOM,
        "window": list(window),
        "cells": len(cells),
        "cellIds": release_cell_ids(window, zoom),
        "cellSizeKm": round(size, 2),
        "releaseBbox": [round(v, 6) for v in bbox],
        "spanKm": [
            round((bbox[2] - bbox[0]) * 111.32 * math.cos(math.radians((bbox[1] + bbox[3]) / 2)), 1),
            round((bbox[3] - bbox[1]) * 111.32, 1),
        ],
        "haloKm": halo_km,
        "sourceBbox": [round(v, 6) for v in source_bbox(window, zoom, halo_km)],
        "extracts": list(EXTRACTS),
        "preprocessorVersion": PREPROCESSOR_VERSION,
    }


def main():
    parser = add_window_argument(argparse.ArgumentParser())
    parser.add_argument("--halo-km", type=float, default=HALO_KM)
    args = parser.parse_args()
    zoom, window = parse_window(args.window)
    print(json.dumps(describe(window, zoom, args.halo_km), indent=2))


if __name__ == "__main__":
    main()
