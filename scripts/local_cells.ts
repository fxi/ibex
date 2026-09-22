import fs from "node:fs";
import { catalogueSchema, toManifest } from "../src/offline/catalogue";
import type { Installed } from "../src/offline/store";
import { CellGraphProvider, searchArea } from "../src/routing/provider";
import { GENERATION } from "../src/offline/version";
import type { Graph, Point } from "../src/routing/types";

/**
 * Where `npm run data:build` writes, and where `npm run dev` serves from.
 *
 * Nothing about a region or a release: it is a directory of cells and one catalogue, the
 * same shape the bucket holds. Gitignored — the only data in the repo is the small
 * fixture under `tests/fixtures`.
 */
export const DEFAULT_CELLS = process.env.IBEX_DATA_DIR ?? ".cache/cells";

/**
 * Merge a local build's cells around the anchors exactly as the app merges installed ones,
 * so scripts route on the same seam-deduplicated graph the browser sees.
 */
export async function loadReleaseGraph(dir: string, anchors: Point[]): Promise<Graph> {
  const catalogue = catalogueSchema.parse(
    JSON.parse(fs.readFileSync(`${dir}/catalog.json`, "utf8")),
  );
  // Files are published under the cell's hash so they can be cached forever; a reader
  // asks for the plain name, as it would on a device.
  const file = (pack: Installed, path: string) =>
    `${dir}/cells/${pack.manifest.id}/${pack.manifest.hash}.${path}`;
  const packs = catalogue.cells.map(
    (cell) =>
      ({
        manifest: toManifest(catalogue, cell),
        installedAt: new Date().toISOString(),
        directory: cell.id,
        backend: "idb",
      }) as Installed,
  );
  const reader = {
    async readFile(pack: Installed, path: string) {
      return Uint8Array.from(fs.readFileSync(file(pack, path))).buffer;
    },
    async readRange(pack: Installed, path: string, offset: number, length: number) {
      const handle = fs.openSync(file(pack, path), "r");
      try {
        const data = new Uint8Array(length);
        fs.readSync(handle, data, 0, length, offset);
        return data.buffer;
      } finally {
        fs.closeSync(handle);
      }
    },
  };
  const provider = new CellGraphProvider(
    packs,
    GENERATION,
    catalogue.cells.map((c) => ({ id: c.id, bbox: c.bbox })),
    reader,
  );
  await provider.open();
  return provider.load(searchArea(anchors));
}
