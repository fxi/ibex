"""Download a cached cross-border Overpass snapshot; never run at route time."""

import argparse
import hashlib
import json
from pathlib import Path

import httpx

BBOX = [5.80, 45.95, 6.55, 46.45]
EXTRACT_VERSION = 4


def query_for_region():
    w, s, e, n = BBOX
    box = f"{s},{w},{n},{e}"
    return f"""[out:json][timeout:360][maxsize:805306368];
way[highway]({box})->.roads;
relation[route=ferry]({box})->.ferry_routes;
(way[route=ferry]({box});way(r.ferry_routes);)->.ferries;
relation(bw.roads)[type=route][route~"^(bicycle|mtb)$"]->.cycling;
(.roads;.ferries;rel(bw.roads)[type=restriction];node(w.roads)[barrier];
way[natural=water]({box});way[waterway]({box});node[place~"^(city|town|village)$"]({box});
node[tourism=viewpoint]({box});node[natural=peak]({box});
way[landuse~"^(forest|residential|commercial|industrial|retail|garages|construction)$"]({box});
way[natural=wood]({box});
relation[landuse~"^(forest|residential|commercial|industrial|retail|garages|construction)$"]({box});
relation[natural=wood]({box}););
out geom;
(.cycling;.ferry_routes;);out body;"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="data/osm-profiles-v4.json")
    parser.add_argument("--endpoint", default="https://overpass-api.de/api/interpreter")
    args = parser.parse_args()
    output = Path(args.output)
    query = query_for_region()
    if output.exists():
        metadata = output.with_suffix(".source.json")
        if not metadata.exists() or json.loads(metadata.read_text()).get("query") != query:
            raise RuntimeError("Cached extract uses another query. Choose a new --output path.")
        print(f"Using cached {output}")
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=420, follow_redirects=True) as client:
        response = client.get(args.endpoint, params={"data": query})
        response.raise_for_status()
    value = response.json()
    if value.get("remark") or not value.get("elements"):
        raise RuntimeError(f"Incomplete OSM response: {value.get('remark', 'empty data')}")
    temporary = output.with_suffix(".partial")
    temporary.write_bytes(response.content)
    temporary.replace(output)
    output.with_suffix(".source.json").write_text(json.dumps({
        "extractVersion": EXTRACT_VERSION,
        "endpoint": args.endpoint, "bbox": BBOX, "query": query,
        "sha256": hashlib.sha256(response.content).hexdigest(),
        "osmTimestamp": value.get("osm3s", {}).get("timestamp_osm_base"),
    }, indent=2))
    print(f"Saved {len(value['elements'])} elements to {output}")


if __name__ == "__main__":
    main()
