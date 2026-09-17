"""Publish a checked cell release to S3 under the versioned data layout. Dry-run by default.

Layout (see docs/data-format.md), below the optional `$S3_PREFIX` in `$S3_BUCKET`:

    data/v<dataVersion>/latest.json                    mutable pointer, short cache
    data/v<dataVersion>/releases/<release>/...         immutable, cached forever

The unit of publication is a catalogue and every cell it lists, so the tree that ships is
exactly the tree the application reads. Every file is verified against the size and digest
its manifest declares before anything is uploaded. Uploads skip objects already present
with the same size: a release directory never changes, so a rerun only fills gaps.

    uv run scripts/publish_release.py --release <packs dir>             # verify only
    uv run scripts/publish_release.py --release <packs dir> --publish   # upload
    uv run scripts/publish_release.py --release <packs dir> --publish --promote
    uv run scripts/publish_release.py --promote-id <release>            # repoint only
    uv run scripts/publish_release.py --prune 3                         # keep 3 newest
"""

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

IMMUTABLE = "public, max-age=31536000, immutable"
# Long enough to absorb traffic, short enough that a promotion reaches clients quickly.
POINTER = "public, max-age=300, must-revalidate"


def data_root(prefix: str, data_version: int) -> str:
    return f"{prefix.strip('/')}/data/v{data_version}".lstrip("/")


def release_root(prefix: str, data_version: int, release: str) -> str:
    return f"{data_root(prefix, data_version)}/releases/{release}"


def pointer(data_version: int, release: str, published: str) -> dict:
    return {
        "dataVersion": data_version,
        "release": release,
        "catalogue": f"releases/{release}/catalogue.json",
        "published": published,
    }


def collect(directory: Path):
    """Return (catalogue, [(local path, key suffix, bytes)]) after verifying every digest.

    The catalogue comes last so that, uploaded in order, it never names a missing cell.
    """
    catalogue = json.loads((directory / "catalogue.json").read_text())
    release = catalogue["release"]
    data_version = catalogue["dataVersion"]
    uploads = []
    for cell in catalogue["cells"]:
        manifest_path = directory / cell["manifest"]
        # The catalogue must not reach outside its own release directory.
        if not manifest_path.resolve().is_relative_to(directory.resolve()):
            raise ValueError(f"Manifest path escapes the release: {cell['manifest']}")
        manifest = json.loads(manifest_path.read_text())
        if manifest["release"] != release:
            raise ValueError(
                f"Cell {cell['id']} declares release {manifest['release']}, "
                f"but the catalogue is {release}"
            )
        if manifest["dataVersion"] != data_version:
            raise ValueError(f"Cell {cell['id']} data version disagrees with the catalogue")
        if manifest["version"] != cell["version"]:
            raise ValueError(f"Cell {cell['id']} version disagrees with the catalogue")
        for file in manifest["files"]:
            path = manifest_path.parent / file["path"]
            if (
                path.parent != manifest_path.parent
                or path.stat().st_size != file["bytes"]
                or hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
                != file["sha256"]
            ):
                raise ValueError(f"Integrity check failed: {path}")
            uploads.append(
                (path, f"{Path(cell['manifest']).parent}/{file['path']}", file["bytes"])
            )
        uploads.append((manifest_path, cell["manifest"], manifest_path.stat().st_size))
    catalogue_path = directory / "catalogue.json"
    uploads.append((catalogue_path, "catalogue.json", catalogue_path.stat().st_size))
    return catalogue, uploads


def releases(client, bucket: str, root: str) -> list[str]:
    """Release ids under a data root, oldest first (ids start with their OSM edition)."""
    found = []
    for page in client.get_paginator("list_objects_v2").paginate(
        Bucket=bucket, Prefix=f"{root}/releases/", Delimiter="/"
    ):
        for common in page.get("CommonPrefixes", []):
            found.append(common["Prefix"].rstrip("/").rsplit("/", 1)[-1])
    return sorted(found)


def exists(client, bucket: str, key: str, size: int | None = None) -> bool:
    try:
        head = client.head_object(Bucket=bucket, Key=key)
    except client.exceptions.ClientError as error:
        if error.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise
    return size is None or head["ContentLength"] == size


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--release", help="Local packs directory holding catalogue.json")
    parser.add_argument("--publish", action="store_true", help="Upload the release")
    parser.add_argument(
        "--promote", action="store_true", help="Point latest.json at --release"
    )
    parser.add_argument(
        "--promote-id", help="Point latest.json at an already uploaded release id"
    )
    parser.add_argument(
        "--data-version", type=int, default=1, help="With --promote-id or --prune"
    )
    parser.add_argument("--prune", type=int, metavar="KEEP", help="Delete older releases")
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--create-bucket", action="store_true")
    parser.add_argument("--configure-cors", action="store_true")
    args = parser.parse_args()
    load_dotenv(Path(".env"))
    prefix = os.getenv("S3_PREFIX", "")

    catalogue, uploads = None, []
    if args.release:
        catalogue, uploads = collect(Path(args.release))
        data_version = catalogue["dataVersion"]
        print(
            json.dumps(
                {
                    "prefix": release_root(prefix, data_version, catalogue["release"]),
                    "files": len(uploads),
                    "bytes": sum(u[2] for u in uploads),
                    "mode": "publish" if args.publish else "verified",
                },
                indent=2,
            )
        )
    else:
        data_version = args.data_version
    if args.promote and not catalogue:
        parser.error("--promote needs --release (or use --promote-id)")
    if args.publish and not catalogue:
        parser.error("--publish needs --release")
    remote = (
        args.publish
        or args.promote
        or args.promote_id
        or args.prune is not None
        or args.inspect
        or args.create_bucket
        or args.configure_cors
    )
    if not remote:
        return

    import boto3

    client = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        aws_access_key_id=os.environ["S3_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET"],
    )
    bucket = os.environ["S3_BUCKET"]
    root = data_root(prefix, data_version)
    public = (os.getenv("S3_PUBLIC_URL") or "").rstrip("/")

    if args.inspect:
        print(
            json.dumps(
                {
                    "endpointHost": urlparse(os.environ["S3_ENDPOINT"]).hostname,
                    "bucket": bucket,
                    "dataRoot": root,
                    "releases": releases(client, bucket, root),
                },
                indent=2,
            )
        )
    if args.create_bucket:
        client.create_bucket(Bucket=bucket)
    if args.create_bucket or args.configure_cors:
        client.put_bucket_cors(
            Bucket=bucket,
            CORSConfiguration={
                "CORSRules": [
                    {
                        "AllowedOrigins": ["*"],
                        "AllowedMethods": ["GET", "HEAD"],
                        "AllowedHeaders": ["Range", "If-Match", "If-None-Match"],
                        "ExposeHeaders": ["ETag", "Content-Length", "Content-Range"],
                        "MaxAgeSeconds": 3600,
                    }
                ]
            },
        )
        print("Bucket CORS configured.")

    if args.publish:
        base = release_root(prefix, data_version, catalogue["release"])
        skipped = 0
        for path, key, size in uploads:
            if exists(client, bucket, f"{base}/{key}", size):
                skipped += 1
                continue
            client.upload_file(
                str(path),
                bucket,
                f"{base}/{key}",
                ExtraArgs={
                    "ContentType": "application/json"
                    if key.endswith(".json")
                    else "application/octet-stream",
                    "CacheControl": IMMUTABLE,
                    "ACL": "public-read",
                },
            )
        print(f"Uploaded {len(uploads) - skipped}, already present {skipped}.")

    promoted = catalogue["release"] if args.promote else args.promote_id
    if promoted:
        catalogue_key = f"{root}/releases/{promoted}/catalogue.json"
        if not exists(client, bucket, catalogue_key):
            raise SystemExit(f"Refusing to promote: {catalogue_key} is not uploaded")
        published = datetime.now(timezone.utc).isoformat(timespec="seconds")
        client.put_object(
            Bucket=bucket,
            Key=f"{root}/latest.json",
            Body=json.dumps(pointer(data_version, promoted, published), indent=2) + "\n",
            ContentType="application/json",
            CacheControl=POINTER,
            ACL="public-read",
        )
        print(f"Promoted {promoted}.")
        if public:
            print(f"Pointer: {public}/{root}/latest.json")
            print(f"VITE_DATA_URL={public}/{root.rsplit('/', 1)[0]}")

    if args.prune is not None:
        if args.prune < 1:
            parser.error("--prune must keep at least one release")
        current = None
        if exists(client, bucket, f"{root}/latest.json"):
            body = client.get_object(Bucket=bucket, Key=f"{root}/latest.json")["Body"]
            current = json.loads(body.read())["release"]
        known = releases(client, bucket, root)
        keep = set(known[-args.prune :]) | ({current} if current else set())
        for release in known:
            if release in keep:
                continue
            paginator = client.get_paginator("list_objects_v2")
            for page in paginator.paginate(
                Bucket=bucket, Prefix=f"{root}/releases/{release}/"
            ):
                objects = [{"Key": o["Key"]} for o in page.get("Contents", [])]
                if objects:
                    client.delete_objects(Bucket=bucket, Delete={"Objects": objects})
            print(f"Pruned {release}.")


if __name__ == "__main__":
    main()
