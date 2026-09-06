"""Read-only verification of a published pack's hashes, Range and CORS."""

import argparse
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    args = parser.parse_args()
    with httpx.Client(timeout=40, follow_redirects=True) as client:
        response = client.get(args.manifest, headers={"Origin": "https://fxi.io"})
        response.raise_for_status()
        if response.headers.get("access-control-allow-origin") not in (
            "https://fxi.io",
            "*",
        ):
            raise ValueError("Manifest CORS failed")
        manifest = response.json()

        def check(file):
            r = client.get(
                urljoin(args.manifest, file["path"]),
                headers={"Origin": "https://fxi.io"},
            )
            r.raise_for_status()
            if (
                len(r.content) != file["bytes"]
                or hashlib.sha256(r.content).hexdigest() != file["sha256"]
            ):
                raise ValueError(f"Integrity mismatch: {file['path']}")
            if r.headers.get("access-control-allow-origin") not in (
                "https://fxi.io",
                "*",
            ):
                raise ValueError("File CORS failed")
            return file["path"]

        with ThreadPoolExecutor(max_workers=4) as pool:
            verified = list(pool.map(check, manifest["files"]))
        r = client.get(
            urljoin(args.manifest, "basemap.pmtiles"),
            headers={"Range": "bytes=0-126", "Origin": "https://fxi.io"},
        )
        r.raise_for_status()
        if r.status_code != 206 or len(r.content) != 127 or r.content[:7] != b"PMTiles":
            raise ValueError("PMTiles Range verification failed")
    report = {
        "manifest": args.manifest,
        "version": manifest["version"],
        "verifiedFiles": len(verified),
        "cors": "https://fxi.io",
        "rangeStatus": 206,
    }
    Path("data/derived/publication.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
