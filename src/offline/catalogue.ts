/**
 * The published catalogue of built routing cells.
 *
 * One mutable document at the root of the data tree, listing every cell that exists. Cell
 * ids are derived from the grid definition, never assigned, so the document is
 * self-verifying: a silent change to the grid shows up as a bbox mismatch at parse time
 * rather than as mis-stitched routes later.
 *
 * There is no release, no edition and no version in any path. A cell's identity is the
 * `hash` of the bytes it was built from, which is also what names its files, so a rebuilt
 * cell is written beside the old one instead of over it and every published object can be
 * cached forever. A cell whose hash differs from the one installed is stale; that is the
 * whole staleness rule.
 */
import { z } from "zod";
import { DATA_VERSION } from "./version";
import { cellBBox, cellId, type BBox, type CellId } from "../geo/grid";
import { preference, savePreference, type Manifest } from "./store";

/** Consistent with the existing `ibex-tracks` key; never reuses an existing one. */
const CACHE_KEY = "ibex-catalogue";
/** A cell bbox is stored rounded, so compare against derived bounds with a tolerance. */
const BBOX_TOLERANCE = 1e-6;

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/**
 * `path` is the name the file keeps once installed, not the name it is served under: the
 * published object carries the cell's hash in front of it so that it never changes.
 */
const fileSchema = z.object({
  path: z.enum(["index.ibx", "graph.ibx"]),
  bytes: z.number().int().positive().max(300_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const cellSchema = z.object({
  // Matches the pack id pattern, so a cell id can key the `packs` store directly.
  id: z.string().regex(/^\d{1,2}-\d{1,8}-\d{1,8}$/),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  bbox: bboxSchema,
  /** The identity of these bytes: names the published files, and decides staleness. */
  hash: z.string().regex(/^[a-f0-9]{8,64}$/),
  /** When the cell was built, and how old the OpenStreetMap data behind it was. */
  builtAt: z.string(),
  osm: z.string(),
  bytes: z.number().int().positive().max(300_000_000),
  blocks: z.number().int().nonnegative(),
  terrainCoverage: z.number().min(0).max(1),
  files: z.array(fileSchema).length(2),
  nodes: z.number().int().nonnegative().optional(),
  edges: z.number().int().nonnegative().optional(),
});

export const catalogueSchema = z
  .object({
    dataVersion: z.literal(DATA_VERSION),
    generated: z.string(),
    grid: z.object({
      scheme: z.literal("xyz"),
      zoom: z.number().int().min(0).max(14),
      blockZoom: z.number().int().min(0).max(20),
      fieldZoom: z.number().int().min(0).max(20),
    }),
    attribution: z.string(),
    cells: z.array(cellSchema).max(200_000),
  })
  .superRefine((value, ctx) => {
    const { zoom, blockZoom, fieldZoom } = value.grid;
    if (blockZoom < zoom)
      ctx.addIssue({
        code: "custom",
        path: ["grid", "blockZoom"],
        message: "Graph blocks must be finer than download cells",
      });
    if (fieldZoom < zoom)
      ctx.addIssue({
        code: "custom",
        path: ["grid", "fieldZoom"],
        message: "Cost field must be finer than download cells",
      });
    const seen = new Set<string>();
    value.cells.forEach((cell, i) => {
      if (seen.has(cell.id))
        ctx.addIssue({
          code: "custom",
          path: ["cells", i, "id"],
          message: `Duplicate cell ${cell.id}`,
        });
      seen.add(cell.id);
      const derived = cellId({ zoom, x: cell.x, y: cell.y });
      if (cell.id !== derived)
        ctx.addIssue({
          code: "custom",
          path: ["cells", i, "id"],
          message: `Cell id ${cell.id} does not match grid coordinates (${derived})`,
        });
      const bounds = cellBBox({ zoom, x: cell.x, y: cell.y });
      if (bounds.some((v, k) => Math.abs(v - cell.bbox[k]) > BBOX_TOLERANCE))
        ctx.addIssue({
          code: "custom",
          path: ["cells", i, "bbox"],
          message: `Cell ${cell.id} bbox does not match its grid position`,
        });
    });
  });

export type Catalogue = z.infer<typeof catalogueSchema>;
export type CatalogueCell = Catalogue["cells"][number];
/** A catalogue together with the URL its cell files resolve against. */
export type Resolved = { url: string; catalogue: Catalogue };
type Cached = Resolved & { fetchedAt: string };

/** The catalogue URL under a data root such as `https://host/ibex/data`. */
export function catalogueURL(dataRoot: string): string {
  return `${dataRoot.replace(/\/+$/, "")}/catalog.json`;
}

/**
 * Where a cell's file is published.
 *
 * `cells/<id>/<hash>.<name>` — the hash in front is what lets the object be immutable, and
 * what keeps a rebuild from overwriting bytes a client may still be downloading.
 */
export function cellFileURL(
  catalogue: string,
  cell: Pick<CatalogueCell, "id" | "hash">,
  path: string,
): string {
  // Checked here as well as in the schema: this builds a URL, and an id carrying a slash
  // or a dot segment would reach somewhere else entirely.
  if (!/^\d{1,2}-\d{1,8}-\d{1,8}$/.test(cell.id) || !/^[a-f0-9]{8,64}$/.test(cell.hash))
    throw new Error("Cell file is outside the catalogue directory");
  if (path !== "index.ibx" && path !== "graph.ibx")
    throw new Error("Cell file is outside the catalogue directory");
  const base = new URL(catalogue);
  const resolved = new URL(`cells/${cell.id}/${cell.hash}.${path}`, base);
  const directory = base.href.slice(0, base.href.lastIndexOf("/") + 1);
  if (resolved.origin !== base.origin || !resolved.href.startsWith(`${directory}cells/`))
    throw new Error("Cell file is outside the catalogue directory");
  return resolved.href;
}

export function cellById(catalogue: Catalogue): Map<CellId, CatalogueCell> {
  return new Map(catalogue.cells.map((c) => [c.id, c]));
}

export function coverageBBox(catalogue: Catalogue): BBox {
  return catalogue.cells.reduce<BBox>(
    (acc, c) => [
      Math.min(acc[0], c.bbox[0]),
      Math.min(acc[1], c.bbox[1]),
      Math.max(acc[2], c.bbox[2]),
      Math.max(acc[3], c.bbox[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

export function selectedBytes(catalogue: Catalogue, ids: Iterable<CellId>): number {
  const cells = cellById(catalogue);
  let total = 0;
  for (const id of ids) total += cells.get(id)?.bytes ?? 0;
  return total;
}

/**
 * Fetch and cache the catalogue.
 *
 * It is the one mutable object in the tree, so it is never served from an HTTP cache: a
 * cell published a minute ago has to be visible now.
 */
export async function readCatalogue(url: string): Promise<Resolved> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Cell catalogue unavailable (${response.status})`);
  const raw = (await response.json()) as { dataVersion?: unknown };
  if (raw?.dataVersion !== DATA_VERSION)
    throw new Error("The published data is for another version of Ibex.");
  const catalogue = catalogueSchema.parse(raw);
  const cached: Cached = { url, fetchedAt: new Date().toISOString(), catalogue };
  await savePreference(CACHE_KEY, cached).catch(() => {});
  return { url, catalogue };
}

/**
 * The last catalogue that parsed, for offline starts. A catalogue failure must never stop
 * the user routing on or removing what they already installed, so callers treat this as
 * advisory: installed state always comes from `listPacks`, never from here.
 */
export async function cachedCatalogue(url: string): Promise<Resolved | undefined> {
  const cached = await preference<Cached>(CACHE_KEY).catch(() => undefined);
  if (!cached || cached.url !== url) return undefined;
  const parsed = catalogueSchema.safeParse(cached.catalogue);
  return parsed.success ? { url: cached.url, catalogue: parsed.data } : undefined;
}

/**
 * What is kept beside a cell's files once it is installed: its catalogue entry, flattened,
 * plus the few things the catalogue says once for every cell. Nothing is fetched — the
 * catalogue already carries it all, which is why cells no longer publish a manifest.
 */
export function toManifest(catalogue: Catalogue, cell: CatalogueCell): Manifest {
  return {
    dataVersion: catalogue.dataVersion,
    id: cell.id,
    hash: cell.hash,
    builtAt: cell.builtAt,
    cell: { zoom: catalogue.grid.zoom, x: cell.x, y: cell.y },
    bbox: cell.bbox,
    osm: cell.osm,
    terrainCoverage: cell.terrainCoverage,
    attribution: catalogue.attribution,
    blockZoom: catalogue.grid.blockZoom,
    blocks: cell.blocks,
    files: cell.files,
  };
}

/** Where each of a cell's files is served from, keyed by the name it keeps once installed. */
export function cellSources(url: string, cell: CatalogueCell): Record<string, string> {
  return Object.fromEntries(
    cell.files.map((file) => [file.path, cellFileURL(url, cell, file.path)]),
  );
}
