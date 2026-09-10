"""Supplement a newer base extract without replacing it with older OSM roads."""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="data/osm.json")
    parser.add_argument("--features", default="data/osm-profiles-v4.json")
    parser.add_argument("--output", default="data/osm-profiles-v4-merged.json")
    args = parser.parse_args()
    feature_path, base_path, output = Path(args.features), Path(args.base), Path(args.output)
    feature_meta = json.loads(feature_path.with_suffix(".source.json").read_text())
    if feature_meta.get("extractVersion") != 4:
        raise ValueError("Profile features require the version-4 extract query.")
    features, base = json.loads(feature_path.read_bytes()), json.loads(base_path.read_bytes())
    feature_date, base_date = features["osm3s"]["timestamp_osm_base"], base["osm3s"]["timestamp_osm_base"]
    # Relations downloaded for new capabilities remain available; newer matching
    # roads, node IDs, access tags, and geometries win on duplicate elements.
    if feature_date < base_date:
        elements = {(e["type"], e["id"]): e for e in base["elements"]}
        for e in features["elements"]:
            tags = e.get("tags", {})
            supplemental = tags.get("route") in {"ferry", "bicycle", "mtb"} or tags.get("landuse") in {"residential", "commercial", "industrial", "retail", "garages", "construction"}
            # The base already fetched all highways/barriers/restrictions. Missing
            # ones may have been deleted; do not resurrect them from an older layer.
            if supplemental and ("highway" not in tags or tags.get("route") == "ferry"):
                elements.setdefault((e["type"], e["id"]), e)
    else:
        elements = {(e["type"], e["id"]): e for e in features["elements"]}
    provenance = [{"file": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "osmTimestamp": date} for p, date in [(base_path, base_date), (feature_path, feature_date)]]
    merged = {"osm3s": {"timestamp_osm_base": min(base_date, feature_date)}, "sources": provenance, "elements": list(elements.values())}
    output.write_text(json.dumps(merged, separators=(",", ":")))
    output.with_suffix(".source.json").write_text(json.dumps({"extractVersion": 4, "sources": provenance, "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}, indent=2))
    print(json.dumps({"output": str(output), "elements": len(elements), "sources": provenance}, indent=2))


if __name__ == "__main__":
    main()
