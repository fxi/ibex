"""Read-only verification of published data: pointer, hashes, cache headers, Range and CORS.

Takes the public data root (the value of `VITE_DATA_URL`, e.g. `https://host/ibex/data`) or
a `latest.json` URL, follows the pointer to the current release, and walks every cell it
lists. Range support is probed against a real `graph.ibx`, because partial reads of that
file are how the router loads a z13 block without downloading the whole cell.

    uv run scripts/verify_public_release.py https://host/ibex/data [--cells 2]
"""

import argparse
import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin

import httpx
from dotenv import load_dotenv

DATA_VERSION = 1


def main():
    load_dotenv(Path(".env"))
    parser = argparse.ArgumentParser()
    parser.add_argument("url", help="Data root or its v<N>/latest.json")
    parser.add_argument("--cells", type=int, default=0, help="Verify only the first N")
    parser.add_argument(
        "--origin",
        default=os.getenv("APP_ORIGIN") or "https://fxi.io",
        help="Origin the app is served from, for the CORS check",
    )
    args = parser.parse_args()
    latest = (
        args.url
        if args.url.endswith(".json")
        else f"{args.url.rstrip('/')}/v{DATA_VERSION}/latest.json"
    )
    origin = args.origin

    def cors_ok(response) -> bool:
        return response.headers.get("access-control-allow-origin") in (origin, "*")

    def get(client, url, **headers):
        response = client.get(url, headers={"Origin": origin, **headers})
        response.raise_for_status()
        if not cors_ok(response):
            raise ValueError(f"CORS failed: {url}")
        return response

    def immutable(response) -> bool:
        return "immutable" in response.headers.get("cache-control", "")

    with httpx.Client(timeout=60, follow_redirects=True) as client:
        response = get(client, latest)
        if immutable(response):
            raise ValueError("latest.json must not be cached as immutable")
        pointer = response.json()
        if pointer["dataVersion"] != DATA_VERSION:
            raise ValueError(f"Pointer is for data version {pointer['dataVersion']}")
        catalogue_url = urljoin(latest, pointer["catalogue"])
        response = get(client, catalogue_url)
        if not immutable(response):
            raise ValueError("Release catalogue is not cached as immutable")
        catalogue = response.json()
        if catalogue["release"] != pointer["release"]:
            raise ValueError("Pointer and catalogue disagree on the release")
        cells = catalogue["cells"]
        if args.cells:
            cells = cells[: args.cells]

        def check_file(base, file):
            r = get(client, urljoin(base, file["path"]))
            if (
                len(r.content) != file["bytes"]
                or hashlib.sha256(r.content).hexdigest() != file["sha256"]
            ):
                raise ValueError(f"Integrity mismatch: {base} {file['path']}")
            if not immutable(r):
                raise ValueError(f"Not cached as immutable: {base} {file['path']}")

        def check_cell(cell):
            base = urljoin(catalogue_url, cell["manifest"])
            manifest = get(client, base).json()
            if manifest["release"] != catalogue["release"]:
                raise ValueError(f"Cell {cell['id']} is from another release")
            for file in manifest["files"]:
                check_file(base, file)
            return cell["id"]

        with ThreadPoolExecutor(max_workers=4) as pool:
            verified = list(pool.map(check_cell, cells))

        # Partial reads of graph.ibx are the router's hot path; prove the host honours them.
        graph = urljoin(urljoin(catalogue_url, cells[0]["manifest"]), "graph.ibx")
        r = get(client, graph, Range="bytes=0-63")
        if r.status_code != 206 or len(r.content) != 64:
            raise ValueError("Range verification failed on graph.ibx")

    report = {
        "pointer": latest,
        "release": catalogue["release"],
        "verifiedCells": len(verified),
        "cors": origin,
        "rangeStatus": 206,
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
