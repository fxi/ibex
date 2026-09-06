"""Publish only checked pack artifacts to an immutable S3 prefix. Dry-run by default."""

import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import boto3
from dotenv import load_dotenv


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack", default="public/packs/geneva")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--create-bucket", action="store_true")
    parser.add_argument("--configure-cors", action="store_true")
    args = parser.parse_args()
    load_dotenv()
    directory = Path(args.pack)
    manifest = json.loads((directory / "manifest.json").read_text())
    prefix = f"cyclatractor/packs/{manifest['id']}/{manifest['version']}"
    for file in manifest["files"]:
        path = directory / file["path"]
        if (
            path.parent != directory
            or path.stat().st_size != file["bytes"]
            or hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
            != file["sha256"]
        ):
            raise ValueError("Pack integrity check failed")
    print(
        json.dumps(
            {
                "prefix": prefix,
                "files": len(manifest["files"]) + 1,
                "bytes": sum(f["bytes"] for f in manifest["files"]),
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
        print("Public pack CORS configured.")
        return
    for name in [f["path"] for f in manifest["files"]] + ["manifest.json"]:
        client.upload_file(
            str(directory / name),
            bucket,
            f"{prefix}/{name}",
            ExtraArgs={
                "ContentType": "application/json"
                if name.endswith(".json")
                else "application/octet-stream",
                "CacheControl": "public, max-age=31536000, immutable",
                "ACL": "public-read",
            },
        )
    public = os.getenv("S3_PUBLIC_URL")
    if public:
        print(f"Manifest: {public.rstrip('/')}/{prefix}/manifest.json")
    print(
        "Publication complete. Check public GET, Range and CORS before configuring the app URL."
    )


if __name__ == "__main__":
    main()
