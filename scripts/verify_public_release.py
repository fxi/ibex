"""Read-only verification of a published release's hashes, Range and CORS.

Takes the public `catalogue.json` URL and walks every cell it lists. Range support is
probed against a real `graph.ibx`, because partial reads of that file are how the router
loads a z13 block without downloading the whole cell.
"""

import argparse
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin

import httpx

ORIGIN = "https://fxi.io"


def cors_ok(response) -> bool:
    return response.headers.get("access-control-allow-origin") in (ORIGIN, "*")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("catalogue", help="Public URL of catalogue.json")
    parser.add_argument("--cells", type=int, default=0, help="Verify only the first N")
    args = parser.parse_args()
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        response = client.get(args.catalogue, headers={"Origin": ORIGIN})
        response.raise_for_status()
        if not cors_ok(response):
            raise ValueError("Catalogue CORS failed")
        catalogue = response.json()
        cells = catalogue["cells"]
        if args.cells:
            cells = cells[: args.cells]

        def check_file(base, file):
            r = client.get(urljoin(base, file["path"]), headers={"Origin": ORIGIN})
            r.raise_for_status()
            if (
                len(r.content) != file["bytes"]
                or hashlib.sha256(r.content).hexdigest() != file["sha256"]
            ):
                raise ValueError(f"Integrity mismatch: {base} {file['path']}")
            if not cors_ok(r):
                raise ValueError(f"File CORS failed: {file['path']}")

        def check_cell(cell):
            base = urljoin(args.catalogue, cell["manifest"])
            r = client.get(base, headers={"Origin": ORIGIN})
            r.raise_for_status()
            if not cors_ok(r):
                raise ValueError(f"Manifest CORS failed: {cell['id']}")
            manifest = r.json()
            if manifest["release"] != catalogue["release"]:
                raise ValueError(f"Cell {cell['id']} is from another release")
            for file in manifest["files"]:
                check_file(base, file)
            return cell["id"]

        with ThreadPoolExecutor(max_workers=4) as pool:
            verified = list(pool.map(check_cell, cells))

        # Partial reads of graph.ibx are the router's hot path; prove the CDN honours them.
        graph = urljoin(urljoin(args.catalogue, cells[0]["manifest"]), "graph.ibx")
        r = client.get(graph, headers={"Range": "bytes=0-63", "Origin": ORIGIN})
        r.raise_for_status()
        if r.status_code != 206 or len(r.content) != 64:
            raise ValueError("Range verification failed on graph.ibx")

    report = {
        "catalogue": args.catalogue,
        "release": catalogue["release"],
        "verifiedCells": len(verified),
        "cors": ORIGIN,
        "rangeStatus": 206,
    }
    Path("data/derived").mkdir(parents=True, exist_ok=True)
    Path("data/derived/publication.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
