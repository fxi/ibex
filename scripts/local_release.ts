import fs from "node:fs";
import { catalogueSchema } from "../src/offline/catalogue";
import type { Installed } from "../src/offline/store";
import { CellGraphProvider, searchArea } from "../src/routing/provider";
import type { Graph, Point } from "../src/routing/types";

/** The current local build. `cells/` holds the builder's output, `packs/` the packaged release. */
export const DEFAULT_RELEASE_ROOT = "data/build/geneva-toulon-v7";
export const DEFAULT_RELEASE = `${DEFAULT_RELEASE_ROOT}/packs`;

/**
 * Merge a local release's packs around the anchors exactly as the app merges installed
 * cells, so scripts route on the same seam-deduplicated graph the browser sees.
 */
export async function loadReleaseGraph(
  dir: string,
  anchors: Point[],
): Promise<Graph> {
  const catalogue = catalogueSchema.parse(
    JSON.parse(fs.readFileSync(`${dir}/catalogue.json`, "utf8")),
  );
  const packs = catalogue.cells.map(
    (cell) =>
      ({
        manifest: JSON.parse(
          fs.readFileSync(`${dir}/${cell.id}/manifest.json`, "utf8"),
        ),
        installedAt: new Date().toISOString(),
        directory: cell.id,
        backend: "idb",
      }) as Installed,
  );
  const reader = {
    async readFile(pack: Installed, path: string) {
      return Uint8Array.from(
        fs.readFileSync(`${dir}/${pack.manifest.id}/${path}`),
      ).buffer;
    },
    async readRange(
      pack: Installed,
      path: string,
      offset: number,
      length: number,
    ) {
      const handle = fs.openSync(`${dir}/${pack.manifest.id}/${path}`, "r");
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
    catalogue.release,
    catalogue.cells.map((c) => ({ id: c.id, bbox: c.bbox })),
    reader,
  );
  await provider.open();
  return provider.load(searchArea(anchors));
}
