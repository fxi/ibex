/**
 * Stage a local packs directory as a data tree the dev and preview servers serve at
 * `<base>data/`, with the same `v<N>/latest.json` + `releases/<id>/` layout as S3.
 *
 *   npm run data:stage -- [packs dir] [data root]
 *
 * The release is linked, not copied, so staging a few hundred MB is instant.
 */
import fs from "node:fs/promises";
import { resolve } from "node:path";
import { catalogueSchema } from "../src/offline/catalogue";
import { DEFAULT_RELEASE } from "./local_release";

const packs = resolve(process.argv[2] ?? DEFAULT_RELEASE);
const root = process.argv[3] ?? "data/publish";
const catalogue = catalogueSchema.parse(
  JSON.parse(await fs.readFile(`${packs}/catalogue.json`, "utf8")),
);
const version = `${root}/v${catalogue.dataVersion}`;
const target = `${version}/releases/${catalogue.release}`;
await fs.mkdir(`${version}/releases`, { recursive: true });
await fs.rm(target, { recursive: true, force: true });
await fs.symlink(packs, target, "dir");
await fs.writeFile(
  `${version}/latest.json`,
  JSON.stringify(
    {
      dataVersion: catalogue.dataVersion,
      release: catalogue.release,
      catalogue: `releases/${catalogue.release}/catalogue.json`,
      published: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `staged ${catalogue.release} (${catalogue.cells.length} cells) at ${target}\n` +
    `run with VITE_DATA_URL unset (or /ibex/data) to use it`,
);
