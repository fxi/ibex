"""Publish a checked cell release to an immutable S3 prefix. Dry-run by default.

The unit of publication is a catalogue and every cell it lists, so the tree that ships is
exactly the tree the application reads: `catalogue.json` at the release root, and one
directory per cell holding `manifest.json`, `index.ibx` and `graph.ibx`. Every file is
verified against the size and digest its manifest declares before anything is uploaded.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import boto3
from dotenv import load_dotenv


def collect(directory: Path):
    """Return (prefix, [(local path, key suffix, bytes)]) after verifying every digest."""
    catalogue = json.loads((directory / "catalogue.json").read_text())
    release = catalogue["release"]
    uploads = [(directory / "catalogue.json", "catalogue.json", None)]
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
        if manifest["version"] != cell["version"]:
            raise ValueError(f"Cell {cell['id']} version disagrees with the catalogue")
        uploads.append((manifest_path, cell["manifest"], None))
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
                (
                    path,
                    f"{Path(cell['manifest']).parent}/{file['path']}",
                    file["bytes"],
                )
            )
    return f"cyclatractor/packs/{release}", uploads


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", default="public/packs/geneva-grid")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--create-bucket", action="store_true")
    parser.add_argument("--configure-cors", action="store_true")
    args = parser.parse_args()
    load_dotenv()
    directory = Path(args.release)
    prefix, uploads = collect(directory)
    print(
        json.dumps(
            {
                "prefix": prefix,
                "files": len(uploads),
                "bytes": sum(u[2] or 0 for u in uploads),
                "mode": "publish" if args.publish else "dry-run",
            },
            indent=2,
        )
    )
    if not args.publish and not args.inspect and not args.configure_cors:
        return
    client = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        aws_access_key_id=os.environ["S3_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET"],
    )
    bucket = os.environ["S3_BUCKET"]
    if args.inspect:
        print(
            json.dumps(
                {
                    "endpointHost": urlparse(os.environ["S3_ENDPOINT"]).hostname,
                    "configuredBucket": bucket,
                    "accessibleBuckets": [
                        b["Name"] for b in client.list_buckets()["Buckets"]
                    ],
                },
                indent=2,
            )
        )
        return
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
    if not args.publish:
        print("Public release CORS configured.")
        return
    for path, key, _ in uploads:
        client.upload_file(
            str(path),
            bucket,
            f"{prefix}/{key}",
            ExtraArgs={
                "ContentType": "application/json"
                if key.endswith(".json")
                else "application/octet-stream",
                # The catalogue names a new release directory whenever content changes,
                # so every object under it is safe to cache forever.
                "CacheControl": "public, max-age=31536000, immutable",
                "ACL": "public-read",
            },
        )
    public = os.getenv("S3_PUBLIC_URL")
    if public:
        print(f"Catalogue: {public.rstrip('/')}/{prefix}/catalogue.json")
    print(
        "Publication complete. Check public GET, Range and CORS before configuring the app URL."
    )


if __name__ == "__main__":
    main()
