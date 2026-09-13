"""Clip the Geofabrik extracts down to one filtered release pbf.

The tag selection below is a direct translation of the Overpass query this replaced (the
removed fetch_osm.py; see git history). Every stage is skipped when its output is already
present and its inputs are unchanged, and intermediates are deleted as soon as the next
stage consumes them, because the release only has a few GB of disk to work in.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from region_config import parse_window, source_bbox

# Translation of the Overpass selection, grouped as it appears in the original query.
# osmium includes objects referenced by a match (way nodes, relation members) by default,
# which is what makes way geometry and multipolygons resolvable from the filtered file.
FILTERS = [
    # way[highway] -> the road network
    "w/highway",
    # node(w.roads)[barrier] -> barriers that block traversal
    "n/barrier",
    # rel(bw.roads)[type=restriction] -> turn restrictions
    "r/type=restriction",
    # relation[route=ferry] / way[route=ferry] -> ferry services
    "r/route=ferry",
    "w/route=ferry",
    # relation[type=route][route~"^(bicycle|mtb)$"] -> cycling network membership
    "r/route=bicycle,mtb",
    # way[natural=water] / way[waterway] -> water for the basemap and urban context
    "w/natural=water",
    "w/waterway",
    "r/natural=water",
    # node[place~"^(city|town|village)$"] -> settlement seeds for the urban index
    "n/place=city,town,village",
    # node[tourism=viewpoint] / node[natural=peak] -> reward field seeds
    "n/tourism=viewpoint",
    "n/natural=peak",
    # landuse / natural=wood ways and relations -> urban and forest fractions
    "w/landuse=forest,residential,commercial,industrial,retail,garages,construction",
    "r/landuse=forest,residential,commercial,industrial,retail,garages,construction",
    "w/natural=wood",
    "r/natural=wood",
]


def run(command):
    print("  $ " + " ".join(str(c) for c in command))
    subprocess.run(command, check=True)


def megabytes(path):
    return path.stat().st_size / 1e6 if path.exists() else 0.0


def require_osmium():
    if not shutil.which("osmium"):
        raise SystemExit(
            "osmium-tool is required (brew install osmium-tool). "
            "Checked PATH for `osmium`."
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", default="data/pbf")
    parser.add_argument("--output", default="data/pbf/release.osm.pbf")
    parser.add_argument("--window", default=None)
    parser.add_argument("--halo-km", type=float, default=None)
    parser.add_argument(
        "--bbox",
        default=None,
        help="Clip to w,s,e,n instead of the release window; used for the "
        "pre-grid regression comparison.",
    )
    parser.add_argument(
        "--only",
        action="append",
        default=None,
        help="Restrict to these Geofabrik regions; repeatable.",
    )
    parser.add_argument(
        "--keep-intermediates",
        action="store_true",
        help="Retain the per-extract clips and the merged file for inspection.",
    )
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    require_osmium()

    directory = Path(args.directory)
    output = Path(args.output)
    metadata = directory / "sources.json"
    if not metadata.exists():
        raise SystemExit(f"{metadata} missing — run fetch_extracts.py first")
    sources = json.loads(metadata.read_text())["sources"]

    from region_config import GRID_ZOOM, HALO_KM, WINDOW

    zoom, window = (
        parse_window(args.window) if args.window else (GRID_ZOOM, WINDOW)
    )
    halo = args.halo_km if args.halo_km is not None else HALO_KM
    if args.bbox:
        bbox = [float(v) for v in args.bbox.split(",")]
        if len(bbox) != 4 or bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
            raise SystemExit("--bbox must be w,s,e,n with w<e and s<n")
    else:
        bbox = source_bbox(window, zoom, halo)
    box = ",".join(f"{v:.6f}" for v in bbox)
    if args.only:
        wanted = set(args.only)
        sources = [s for s in sources if s["region"] in wanted]
        if not sources:
            raise SystemExit(f"No downloaded extract matches {sorted(wanted)}")

    state = {
        "bbox": bbox,
        "explicitBbox": bool(args.bbox),
        "window": list(window),
        "zoom": zoom,
        "haloKm": halo,
        "filters": FILTERS,
        "sources": {s["region"]: s["md5"] for s in sources},
    }
    stamp = output.with_suffix(".source.json")
    if output.exists() and stamp.exists() and not args.force:
        if json.loads(stamp.read_text()).get("inputs") == state:
            print(f"Using cached {output} ({megabytes(output):.0f} MB)")
            return 0
        print(f"{output} was built from other inputs; rebuilding")

    print(f"Clipping to {box}")
    clips = []
    for source in sources:
        extract = Path(source["file"])
        if not extract.exists():
            raise SystemExit(
                f"{extract} missing — run fetch_extracts.py (without --prune) first"
            )
        clip = directory / f"clip-{extract.name}"
        if not clip.exists() or args.force:
            run(
                [
                    "osmium",
                    "extract",
                    "--bbox",
                    box,
                    "--strategy",
                    "complete_ways",
                    "--overwrite",
                    "-o",
                    str(clip),
                    str(extract),
                ]
            )
        print(f"  {clip.name}: {megabytes(clip):.0f} MB")
        clips.append(clip)

    merged = directory / "merged.osm.pbf"
    # osmium merge drops objects that appear in more than one extract, which is exactly
    # what complete_ways produces along a shared national border.
    run(["osmium", "merge", "--overwrite", "-o", str(merged), *map(str, clips)])
    print(f"  merged: {megabytes(merged):.0f} MB")
    if not args.keep_intermediates:
        for clip in clips:
            clip.unlink(missing_ok=True)

    run(
        [
            "osmium",
            "tags-filter",
            "--overwrite",
            "-o",
            str(output),
            str(merged),
            *FILTERS,
        ]
    )
    if not args.keep_intermediates:
        merged.unlink(missing_ok=True)

    timestamps = sorted(s["osmTimestamp"] for s in sources if s["osmTimestamp"])
    stamp.write_text(
        json.dumps(
            {
                "inputs": state,
                # The oldest edition bounds how current the release actually is.
                "osmTimestamp": timestamps[0] if timestamps else "",
                "bytes": output.stat().st_size,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    print(f"\n{output}: {megabytes(output):.0f} MB")
    subprocess.run(["osmium", "fileinfo", "-e", str(output)], check=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
