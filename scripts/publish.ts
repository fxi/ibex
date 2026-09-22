/**
 * Put a local build of cells into the bucket the app reads.
 *
 * Every published object is named after the hash of its own bytes, so nothing is ever
 * overwritten and everything but the catalogue can be cached forever. That is also what
 * makes publishing safe to interrupt: the cells go up first and the catalogue last, so the
 * catalogue never names a file that is not there, and a half-finished run leaves unreferenced
 * objects rather than a broken tree.
 *
 *   node --import tsx scripts/publish.ts --dry-run
 *   node --import tsx scripts/publish.ts
 *   node --import tsx scripts/publish.ts --setup-bucket
 *   node --import tsx scripts/publish.ts --verify https://bucket.example/ibex
 *
 * Credentials come from `.env` and are never printed. `--dry-run` sends nothing.
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { CreateBucketCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { catalogueSchema, type Catalogue } from "../src/offline/catalogue";
import { DEFAULT_CELLS } from "./local_cells";
import { client, putCatalogue, putCellFile } from "./s3";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const from = option("from") ?? DEFAULT_CELLS;
const dryRun = flag("dry-run");

async function readCatalogue(): Promise<Catalogue> {
  const text = await fs.readFile(`${from}/catalog.json`, "utf8").catch(() => {
    throw new Error(`No catalog.json in ${from} — build some cells first`);
  });
  return catalogueSchema.parse(JSON.parse(text));
}

/** Every object a catalogue implies, named but not yet read. */
function* planned(catalogue: Catalogue) {
  for (const cell of catalogue.cells)
    for (const file of cell.files)
      yield {
        path: `cells/${cell.id}/${cell.hash}.${file.path}`,
        bytes: file.bytes,
        sha256: file.sha256,
      };
}

/**
 * One file's bytes, checked against what the catalogue claims.
 *
 * Read at the moment of sending rather than up front: a build of any size is several
 * gigabytes, and holding all of it to upload one file at a time is how this ran out of
 * memory long before it ran out of cells.
 */
async function bodyOf(object: { path: string; bytes: number; sha256: string }) {
  const body = new Uint8Array(await fs.readFile(`${from}/${object.path}`));
  if (body.length !== object.bytes)
    throw new Error(`${object.path}: ${body.length} bytes, catalogue says ${object.bytes}`);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== object.sha256) throw new Error(`${object.path}: checksum does not match`);
  return body;
}

async function publish() {
  const catalogue = await readCatalogue();
  const objects = [...planned(catalogue)];
  const total = objects.reduce((sum, o) => sum + o.bytes, 0);
  console.log(
    `${catalogue.cells.length} cells, ${objects.length} files, ` +
      `${(total / 1e6).toFixed(1)} MB, plus catalog.json`,
  );

  if (dryRun) {
    for (const object of objects)
      console.log(`  PUT ${object.path}  ${(object.bytes / 1e6).toFixed(2)} MB`);
    console.log("  PUT catalog.json  (last)");
    console.log("\n--dry-run: nothing sent");
    return;
  }

  const at = client();
  let sent = 0;
  let skipped = 0;
  for (const object of objects) {
    // Verified even when it turns out to be up already: a local file that no longer matches
    // the catalogue is worth hearing about whichever side of the wire it is on.
    const result = await putCellFile(at, object.path, await bodyOf(object));
    if (result === "skipped") skipped++;
    else {
      sent++;
      console.log(`  sent ${object.path}`);
    }
  }

  // Last, so it never names a file that is not up yet.
  await putCatalogue(at, catalogue);
  console.log(`\nsent ${sent} files, ${skipped} already there, then catalog.json`);
  if (process.env.S3_PUBLIC_URL)
    console.log(
      `VITE_DATA_URL=${process.env.S3_PUBLIC_URL.replace(/\/+$/, "")}${at.prefix ? `/${at.prefix}` : ""}`,
    );
}

async function setupBucket() {
  const { s3, bucket } = client();
  await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch((error: Error) => {
    console.log(`  bucket: ${error.name} (assuming it exists)`);
  });
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ["*"],
            AllowedMethods: ["GET", "HEAD"],
            // The router reads graph blocks by range, and revalidates the catalogue.
            AllowedHeaders: ["Range", "If-Match", "If-None-Match"],
            ExposeHeaders: ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
  console.log("  CORS set: GET/HEAD from any origin, Range allowed");
}

/**
 * Read the published tree back as the app would.
 *
 * Checks what a browser actually depends on: the catalogue parses, every file is the size
 * and digest it claims, release objects are immutable and the catalogue is not, CORS
 * answers, and a range read returns the right bytes — not merely a 206 of the right length,
 * which a misbehaving proxy passes.
 */
async function verify(root: string) {
  const origin = process.env.APP_ORIGIN ?? "https://fxi.io";
  const base = root.replace(/\/+$/, "");
  const head = { origin };
  const response = await fetch(`${base}/catalog.json`, { headers: head });
  if (!response.ok) throw new Error(`catalog.json: HTTP ${response.status}`);
  const cors = response.headers.get("access-control-allow-origin");
  if (cors !== origin && cors !== "*") throw new Error(`catalog.json: CORS is ${cors}`);
  if (/immutable/.test(response.headers.get("cache-control") ?? ""))
    throw new Error("catalog.json must not be immutable — it is the one thing that changes");
  const catalogue = catalogueSchema.parse(await response.json());
  console.log(`catalog.json: ${catalogue.cells.length} cells, grid z${catalogue.grid.zoom}`);

  let checked = 0;
  for (const cell of catalogue.cells)
    for (const file of cell.files) {
      const url = `${base}/cells/${cell.id}/${cell.hash}.${file.path}`;
      const got = await fetch(url, { headers: head });
      if (!got.ok) throw new Error(`${url}: HTTP ${got.status}`);
      if (!/immutable/.test(got.headers.get("cache-control") ?? ""))
        throw new Error(`${url}: not cacheable forever`);
      const bytes = new Uint8Array(await got.arrayBuffer());
      if (bytes.length !== file.bytes) throw new Error(`${url}: wrong size`);
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        throw new Error(`${url}: checksum does not match`);
      checked++;

      if (file.path !== "graph.ibx") continue;
      const ranged = await fetch(url, { headers: { ...head, Range: "bytes=16-79" } });
      if (ranged.status !== 206) throw new Error(`${url}: range read gave ${ranged.status}`);
      const range = ranged.headers.get("content-range");
      if (range !== `bytes 16-79/${file.bytes}`)
        throw new Error(`${url}: Content-Range is ${range}`);
      const part = new Uint8Array(await ranged.arrayBuffer());
      if (part.length !== 64 || !part.every((b, i) => b === bytes[16 + i]))
        throw new Error(`${url}: range read returned the wrong bytes`);
    }
  console.log(`verified ${checked} files, and one range read against its own bytes — ok`);
}

const verifyURL = option("verify");
if (verifyURL) await verify(verifyURL);
else if (flag("setup-bucket")) await setupBucket();
else await publish();
