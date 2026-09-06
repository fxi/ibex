"""Download a cached cross-border Overpass snapshot; never run at route time."""

import argparse
import hashlib
import json
from pathlib import Path

import httpx

BBOX = [5.80, 45.95, 6.55, 46.45]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="data/osm.json")
    parser.add_argument("--endpoint", default="https://overpass-api.de/api/interpreter")
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        print(f"Using cached {output}; remove it explicitly to fetch a new snapshot.")
        return
    w, s, e, n = BBOX
    box = f"{s},{w},{n},{e}"
    query = f"""[out:json][timeout:240][maxsize:536870912];
way[highway]({box})->.roads;
(.roads;rel(bw.roads)[type=restriction];node(w.roads)[barrier];
way[natural=water]({box});way[waterway]({box});node[place~"^(city|town|village)$"]({box}););
out geom;"""
    output.parent.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=300, follow_redirects=True) as client:
        response = client.get(args.endpoint, params={"data": query})
        response.raise_for_status()
    value = response.json()
    if value.get("remark") or not value.get("elements"):
        raise RuntimeError(
            f"Incomplete OSM response: {value.get('remark', 'empty data')}"
        )
    output.write_bytes(response.content)
    output.with_suffix(".source.json").write_text(
        json.dumps(
            {
                "endpoint": args.endpoint,
                "bbox": BBOX,
                "query": query,
                "sha256": hashlib.sha256(response.content).hexdigest(),
                "osmTimestamp": value.get("osm3s", {}).get("timestamp_osm_base"),
            },
            indent=2,
        )
    )
    print(f"Saved {len(value['elements'])} elements to {output}")


if __name__ == "__main__":
    main()
