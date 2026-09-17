"""Build every download cell from its extract, in parallel and resumably.

Each cell is an independent halo-exact build, so they parallelise cleanly. A cell that
already has a manifest is skipped, and one cell failing never aborts the rest — the run is
meant to survive being left alone.
"""

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from grid import cell_id
from region_config import (
    GRID_ZOOM,
    RELEASE_ROOT,
    WINDOW,
    parse_window,
    release_cells,
)


def build_one(job):
    cell, source, output, no_terrain, log_directory, split_nodes = job
    log = log_directory / f"{cell}.log"
    command = [
        "uv",
        "run",
        "scripts/build_region.py",
        "--input",
        str(source),
        "--output",
        str(output),
        "--cell",
        cell,
        "--split-nodes",
        str(split_nodes),
    ]
    if no_terrain:
        command.append("--no-terrain")
    started = time.time()
    with log.open("w") as handle:
        result = subprocess.run(command, stdout=handle, stderr=subprocess.STDOUT)
    elapsed = time.time() - started
    manifest = output / "manifest.json"
    ok = result.returncode == 0 and manifest.exists()
    counts = {}
    if ok:
        try:
            counts = json.loads(manifest.read_text()).get("build", {})
        except (OSError, json.JSONDecodeError):
            ok = False
    status = "ok" if ok else f"FAILED (exit {result.returncode}, see {log})"
    print(
        f"[{cell}] {status} in {elapsed / 60:.1f} min"
        + (
            f" — {counts.get('nodes', 0):,} nodes, {counts.get('edges', 0):,} edges, "
            f"{counts.get('restrictions', 0):,} restrictions, "
            f"halo overshoot {counts.get('haloOvershootKm', '?')} km"
            if ok
            else ""
        ),
        flush=True,
    )
    return cell, ok, elapsed, counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--extracts", default="data/pbf/cells")
    parser.add_argument("--output", default=f"{RELEASE_ROOT}/cells")
    parser.add_argument("--window", default=None)
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--split-nodes", default="data/derived/split-nodes.bin")
    parser.add_argument("--no-terrain", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--only", action="append", default=None)
    args = parser.parse_args()

    zoom, window = parse_window(args.window) if args.window else (GRID_ZOOM, WINDOW)
    extracts = Path(args.extracts)
    output_root = Path(args.output)
    output_root.mkdir(parents=True, exist_ok=True)
    log_directory = output_root / "logs"
    log_directory.mkdir(exist_ok=True)

    if not Path(args.split_nodes).exists():
        raise SystemExit(
            f"{args.split_nodes} missing — run global_splits.py first, or cells will "
            "split ways inconsistently and their edge ids will not match"
        )
    ids = [cell_id(zoom, x, y) for x, y in release_cells(window, zoom)]
    # The window travels with the build so packaging can tell a complete release from a
    # partial one. `--only` builds a subset of it; it does not redefine it.
    (output_root / "window.json").write_text(
        json.dumps({"zoom": zoom, "window": list(window), "cellIds": ids}, indent=2) + "\n"
    )
    if args.only:
        wanted = set(args.only)
        ids = [i for i in ids if i in wanted]

    # Build the biggest extracts first so the long tail does not land at the very end.
    def size(cell):
        path = extracts / f"{cell}.osm.pbf"
        return path.stat().st_size if path.exists() else 0

    jobs, skipped = [], []
    for cell in sorted(ids, key=size, reverse=True):
        source = extracts / f"{cell}.osm.pbf"
        if not source.exists():
            print(f"[{cell}] no extract at {source}; run extract_cells.py", flush=True)
            continue
        output = output_root / cell
        if (output / "manifest.json").exists() and not args.force:
            skipped.append(cell)
            continue
        jobs.append(
            (cell, source, output, args.no_terrain, log_directory, args.split_nodes)
        )

    if skipped:
        print(f"Already built, skipping {len(skipped)}: {' '.join(skipped)}", flush=True)
    if not jobs:
        print("Nothing to build.")
        return 0
    print(f"Building {len(jobs)} cells with {args.jobs} parallel jobs\n", flush=True)

    started = time.time()
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        results = list(pool.map(build_one, jobs))

    failed = [cell for cell, ok, _, _ in results if not ok]
    total_nodes = sum(c.get("nodes", 0) for _, ok, _, c in results if ok)
    total_edges = sum(c.get("edges", 0) for _, ok, _, c in results if ok)
    print(
        f"\n{len(results) - len(failed)}/{len(results)} cells built in "
        f"{(time.time() - started) / 60:.1f} min — "
        f"{total_nodes:,} nodes, {total_edges:,} directed edges"
    )
    if failed:
        print(f"FAILED: {' '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
