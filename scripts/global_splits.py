"""Compute the way-split node set once for the whole release.

A way is cut into edges at every "kept" node: a way endpoint, a barrier, a turn-restriction
via node, or a node shared by more than one road. Derived per cell, that set depends on which
ways happen to be inside the cell's extract, so a way could split differently in two adjacent
cells and the same physical segment would get two different deterministic ids — breaking the
deduplication the whole multi-pack design rests on.

Computing it once over the release removes halo size from the question entirely: every cell
splits identically by construction. No node locations are needed, so this is a cheap pass.
"""

import argparse
import json
import sys
from array import array
from pathlib import Path

import osmium

from build_region import permitted


def collect(path):
    path = str(path)

    # Pass 1: relations. Conditional restrictions have their from-ways dropped entirely, and
    # restriction via nodes are always split points.
    conditional_from = set()
    via_nodes = set()
    for obj in osmium.FileProcessor(path).with_filter(
        osmium.filter.EntityFilter(osmium.osm.RELATION)
    ):
        tags = {tag.k: tag.v for tag in obj.tags}
        if any("conditional" in key for key in tags):
            conditional_from.update(
                m.ref for m in obj.members if m.type == "w" and m.role == "from"
            )
        if tags.get("type") == "restriction":
            via_nodes.update(
                m.ref for m in obj.members if m.type == "n" and m.role == "via"
            )

    # Pass 2: road ways. Endpoints are always kept; a node seen twice is a junction.
    seen = set()
    shared = set()
    endpoints = set()
    ways = 0
    for obj in osmium.FileProcessor(path).with_filter(
        osmium.filter.EntityFilter(osmium.osm.WAY)
    ):
        tags = {tag.k: tag.v for tag in obj.tags}
        if "highway" not in tags or obj.id in conditional_from:
            continue
        if not permitted(tags):
            continue
        refs = [node.ref for node in obj.nodes]
        if len(refs) < 2:
            continue
        ways += 1
        endpoints.add(refs[0])
        endpoints.add(refs[-1])
        for ref in refs:
            if ref in seen:
                shared.add(ref)
            else:
                seen.add(ref)

    # Pass 3: barrier nodes.
    barriers = set()
    for obj in osmium.FileProcessor(path).with_filter(
        osmium.filter.EntityFilter(osmium.osm.NODE)
    ):
        if any(tag.k == "barrier" for tag in obj.tags):
            barriers.add(obj.id)

    kept = endpoints | shared | barriers | via_nodes
    return kept, {
        "roadWays": ways,
        "distinctNodes": len(seen),
        "endpoints": len(endpoints),
        "sharedNodes": len(shared),
        "barriers": len(barriers),
        "viaNodes": len(via_nodes),
        "kept": len(kept),
        "conditionalFromWays": len(conditional_from),
    }


def write(kept, output):
    """Sorted uint64 so a build can load it with array.fromfile and no parsing."""
    values = array("q", sorted(kept))
    with Path(output).open("wb") as handle:
        values.tofile(handle)


def load(path):
    values = array("q")
    size = Path(path).stat().st_size
    with Path(path).open("rb") as handle:
        values.fromfile(handle, size // values.itemsize)
    return set(values)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="data/pbf/release.osm.pbf")
    parser.add_argument("--output", default="data/derived/split-nodes.bin")
    args = parser.parse_args()
    source = Path(args.input)
    if not source.exists():
        raise SystemExit(f"{source} missing — run clip_region.py first")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    kept, stats = collect(source)
    write(kept, output)
    stats["bytes"] = output.stat().st_size
    output.with_suffix(".json").write_text(json.dumps(stats, indent=2, sort_keys=True) + "\n")
    print(json.dumps(stats, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
