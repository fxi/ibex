/**
 * The bucket, for the two scripts that write to it.
 *
 * `publish.ts` sends a finished local build; `build_cells.ts` sends each cell as it comes
 * off the builder, so a wide build never has to hold its own output on disk. Both need the
 * same client, the same key layout and the same cache headers, and getting any of those
 * subtly different between them would publish a tree the app cannot read.
 *
 * Credentials come from `.env` and are never printed.
 */
import fs from "node:fs/promises";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { config as loadEnv } from "dotenv";

// `override` matters: a stray exported S3_BUCKET from another project would otherwise send
// a few hundred megabytes of public objects to the wrong place.
loadEnv({ path: ".env", override: true, quiet: true });

/** Cells are named after their own bytes, so they can be cached for a year. */
export const IMMUTABLE = "public, max-age=31536000, immutable";
/** The catalogue is the one thing that changes, and the index to everything else. */
export const CATALOGUE = "public, max-age=300, must-revalidate";

export type Bucket = { s3: S3Client; bucket: string; prefix: string };

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

export function client(): Bucket {
  const endpoint = required("S3_ENDPOINT");
  const bucket = required("S3_BUCKET");
  const prefix = (process.env.S3_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
  const s3 = new S3Client({
    endpoint,
    // S3-compatible endpoints ignore it, but the SDK insists on one.
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: required("S3_KEY"),
      secretAccessKey: required("S3_SECRET"),
    },
  });
  console.log(`${new URL(endpoint).hostname} bucket=${bucket}${prefix ? ` prefix=${prefix}` : ""}`);
  return { s3, bucket, prefix };
}

export const key = (prefix: string, path: string) => (prefix ? `${prefix}/${path}` : path);

/** The size of an object already there, or `undefined` if it is not. */
export async function objectSize(at: Bucket, path: string): Promise<number | undefined> {
  const existing = await at.s3
    .send(new HeadObjectCommand({ Bucket: at.bucket, Key: key(at.prefix, path) }))
    .catch(() => undefined);
  return existing?.ContentLength;
}

export async function putObject(
  at: Bucket,
  path: string,
  body: Uint8Array | string,
  options: { type: string; cache: string },
): Promise<void> {
  await at.s3.send(
    new PutObjectCommand({
      Bucket: at.bucket,
      Key: key(at.prefix, path),
      Body: body,
      ContentType: options.type,
      CacheControl: options.cache,
      ACL: "public-read",
    }),
  );
}

/**
 * Send a cell file unless the bucket already holds it.
 *
 * Named after its own bytes, so an object that is already there is already right — which is
 * what makes both publishing and building idempotent and safe to interrupt.
 */
export async function putCellFile(
  at: Bucket,
  path: string,
  body: Uint8Array,
): Promise<"sent" | "skipped"> {
  if ((await objectSize(at, path)) === body.length) return "skipped";
  await putObject(at, path, body, { type: "application/octet-stream", cache: IMMUTABLE });
  return "sent";
}

/** The catalogue goes last, so it never names a file that is not up yet. */
export async function putCatalogue(at: Bucket, catalogue: unknown): Promise<void> {
  await putObject(at, "catalog.json", JSON.stringify(catalogue), {
    type: "application/json",
    cache: CATALOGUE,
  });
}

/** Parts of a large upload: S3 allows 10 000, so 64 MB carries files up to 640 GB. */
const PART_BYTES = 64 * 1024 * 1024;

/**
 * Send a file of any size by multipart upload, a part at a time, so a basemap of several
 * gigabytes never has to be in memory. Skipped when an object of the same size is already
 * there — the name is a hash of the bytes, as for cells.
 */
export async function putLargeFile(
  at: Bucket,
  path: string,
  file: string,
  options: { type: string; cache: string },
): Promise<"sent" | "skipped"> {
  const { size } = await fs.stat(file);
  if ((await objectSize(at, path)) === size) return "skipped";
  const target = { Bucket: at.bucket, Key: key(at.prefix, path) };
  const { UploadId } = await at.s3.send(
    new CreateMultipartUploadCommand({
      ...target,
      ContentType: options.type,
      CacheControl: options.cache,
      ACL: "public-read",
    }),
  );
  const handle = await fs.open(file, "r");
  try {
    const parts: { ETag: string; PartNumber: number }[] = [];
    const buffer = new Uint8Array(PART_BYTES);
    for (let offset = 0, part = 1; offset < size; offset += PART_BYTES, part++) {
      const { bytesRead } = await handle.read(buffer, 0, PART_BYTES, offset);
      const { ETag } = await at.s3.send(
        new UploadPartCommand({
          ...target,
          UploadId,
          PartNumber: part,
          Body: buffer.subarray(0, bytesRead),
        }),
      );
      parts.push({ ETag: ETag!, PartNumber: part });
      process.stdout.write(
        `\r  ${path}: ${((offset + bytesRead) / 1e9).toFixed(2)} / ${(size / 1e9).toFixed(2)} GB`,
      );
    }
    process.stdout.write("\n");
    await at.s3.send(
      new CompleteMultipartUploadCommand({
        ...target,
        UploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    return "sent";
  } catch (error) {
    await at.s3.send(new AbortMultipartUploadCommand({ ...target, UploadId })).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

/** The index to the basemap files; mutable like the catalogue, and cached like it. */
export async function readMapIndex(at: Bucket): Promise<Record<string, string>> {
  const response = await at.s3
    .send(new GetObjectCommand({ Bucket: at.bucket, Key: key(at.prefix, "map.json") }))
    .catch(() => undefined);
  const text = await response?.Body?.transformToString();
  return text ? JSON.parse(text) : {};
}

/** Merge entries into `map.json`, after the files they name are up. */
export async function updateMapIndex(at: Bucket, patch: Record<string, string>): Promise<void> {
  const index = { ...(await readMapIndex(at)), ...patch };
  await putObject(at, "map.json", JSON.stringify(index, null, 2), {
    type: "application/json",
    cache: CATALOGUE,
  });
  console.log(`  map.json: ${JSON.stringify(index)}`);
}
