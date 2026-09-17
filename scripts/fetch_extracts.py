"""Download and verify the Geofabrik extracts the release is built from.

Replaces the single Overpass query: the enlarged window returns multiple GB of JSON, past
Overpass's maxsize and timeout. Extracts are cached, checksum-verified, and resumable, so a
re-clip never re-downloads and an interrupted run continues where it stopped.
"""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import httpx
from region_config import EXTRACTS

BASE = "https://download.geofabrik.de"
CHUNK = 1 << 20


def remote_md5(client, region):
    """Geofabrik publishes `<md5>  <filename>` beside every extract."""
    response = client.get(f"{BASE}/{region}-latest.osm.pbf.md5")
    response.raise_for_status()
    return response.text.split()[0].strip().lower()


def file_md5(path):
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def replication_timestamp(path):
    try:
        return subprocess.run(
            [
                "osmium",
                "fileinfo",
                "--get",
                "header.option.osmosis_replication_timestamp",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def download(client, region, target, expected):
    """Resume onto a .partial file, then verify before moving it into place."""
    partial = target.with_suffix(".partial")
    have = partial.stat().st_size if partial.exists() else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    with client.stream("GET", f"{BASE}/{region}-latest.osm.pbf", headers=headers) as r:
        if have and r.status_code == 200:
            # Server ignored the range: start over rather than concatenating garbage.
            have = 0
            partial.unlink(missing_ok=True)
        elif have and r.status_code != 206:
            r.raise_for_status()
        else:
            r.raise_for_status()
        total = int(r.headers.get("content-length", 0)) + have
        with partial.open("ab" if have else "wb") as handle:
            done = have
            for block in r.iter_bytes(CHUNK):
                handle.write(block)
                done += len(block)
                if total:
                    print(
                        f"\r  {region}: {done / 1e6:>7.1f} / {total / 1e6:.1f} MB",
                        end="",
                        flush=True,
                    )
        print()
    actual = file_md5(partial)
    if actual != expected:
        partial.unlink(missing_ok=True)
        raise RuntimeError(
            f"{region}: checksum mismatch (expected {expected}, got {actual})"
        )
    partial.replace(target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", default="data/pbf")
    parser.add_argument(
        "--extract",
        action="append",
        default=None,
        help="Geofabrik region path; repeatable. Defaults to the release set.",
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="Delete downloaded extracts (keeps sources.json) once clipping is done.",
    )
    args = parser.parse_args()
    directory = Path(args.directory)
    regions = args.extract or list(EXTRACTS)
    metadata = directory / "sources.json"

    if args.prune:
        for region in regions:
            path = directory / f"{Path(region).name}-latest.osm.pbf"
            if path.exists():
                print(f"removing {path} ({path.stat().st_size / 1e6:.0f} MB)")
                path.unlink()
        return

    directory.mkdir(parents=True, exist_ok=True)
    recorded = {}
    if metadata.exists():
        recorded = {s["region"]: s for s in json.loads(metadata.read_text())["sources"]}
    sources = []
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        for region in regions:
            target = directory / f"{Path(region).name}-latest.osm.pbf"
            expected = remote_md5(client, region)
            previous = recorded.get(region)
            if (
                target.exists()
                and previous
                and previous.get("md5") == expected
                and previous.get("bytes") == target.stat().st_size
            ):
                print(f"cached  {region} ({target.stat().st_size / 1e6:.0f} MB)")
            else:
                if target.exists():
                    print(f"stale   {region}: re-downloading for {expected}")
                    target.unlink()
                print(f"fetch   {region}")
                download(client, region, target, expected)
            sources.append(
                {
                    "region": region,
                    "file": str(target),
                    "md5": expected,
                    "bytes": target.stat().st_size,
                    "osmTimestamp": replication_timestamp(target),
                }
            )
    total = sum(s["bytes"] for s in sources)
    metadata.write_text(
        json.dumps({"base": BASE, "sources": sources}, indent=2, sort_keys=True) + "\n"
    )
    print(f"\n{len(sources)} extracts, {total / 1e6:.0f} MB total")
    for s in sources:
        print(f"  {s['region']:<34} {s['bytes'] / 1e6:>7.0f} MB  {s['osmTimestamp']}")


if __name__ == "__main__":
    sys.exit(main())
