/**
 * The published catalogue of downloadable routing cells. Cell ids are derived from the grid
 * definition, never assigned, so the document is self-verifying: a silent change to the grid
 * shows up as a bbox mismatch at parse time rather than as mis-stitched routes later.
 */
import { z } from "zod";
import { COST_MODEL_VERSION } from "../routing/types";
import { cellBBox, cellId, type BBox, type CellId } from "../geo/grid";
import { preference, savePreference } from "./store";

/** Consistent with the existing `ibex-tracks` key; never reuses an existing one. */
const CACHE_KEY = "ibex-catalogue";
/** A cell bbox is stored rounded, so compare against derived bounds with a tolerance. */
const BBOX_TOLERANCE = 1e-6;

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const cellSchema = z.object({
  // Matches the pack manifest id pattern, so a cell id can key the `packs` store directly.
  id: z.string().regex(/^\d{1,2}-\d{1,8}-\d{1,8}$/),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  bbox: bboxSchema,
  // Relative to the catalogue URL so the same tree serves from public/ and from S3.
  manifest: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/)
    .refine(
      (p) => !p.split("/").includes(".."),
      "Manifest path escapes the catalogue",
    ),
  version: z.string().regex(/^[a-zA-Z0-9-]+$/),
  bytes: z.number().int().positive().max(300_000_000),
  available: z.boolean(),
  nodes: z.number().int().nonnegative().optional(),
  edges: z.number().int().nonnegative().optional(),
});

export const catalogueSchema = z
  .object({
    schemaVersion: z.literal(1),
    release: z.string().regex(/^[a-z0-9._-]{1,64}$/),
    grid: z.object({
      scheme: z.literal("xyz"),
      zoom: z.number().int().min(0).max(14),
      blockZoom: z.number().int().min(0).max(20),
      fieldZoom: z.number().int().min(0).max(20),
    }),
    costModelVersion: z.literal(COST_MODEL_VERSION),
    formatVersion: z.number().int().positive(),
    osmTimestamp: z.string(),
    generated: z.string(),
    attribution: z.string(),
    cells: z.array(cellSchema).min(1).max(4096),
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
type Cached = { url: string; fetchedAt: string; catalogue: Catalogue };

/** Resolve a cell's manifest, refusing anything that leaves the catalogue's directory. */
export function resolveCellManifest(
  catalogueURL: string,
  cell: Pick<CatalogueCell, "manifest">,
): string {
  const base = new URL(catalogueURL);
  const resolved = new URL(cell.manifest, base);
  const directory = base.href.slice(0, base.href.lastIndexOf("/") + 1);
  if (resolved.origin !== base.origin || !resolved.href.startsWith(directory))
    throw new Error("Cell manifest is outside the catalogue directory");
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

export function selectedBytes(
  catalogue: Catalogue,
  ids: Iterable<CellId>,
): number {
  const cells = cellById(catalogue);
  let total = 0;
  for (const id of ids) total += cells.get(id)?.bytes ?? 0;
  return total;
}

/** Fetch and cache. The cost-model check precedes parsing so the message is actionable. */
export async function readCatalogue(url: string): Promise<Catalogue> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Pack catalogue unavailable (${response.status})`);
  const value = await response.json();
  if (value?.costModelVersion !== COST_MODEL_VERSION)
    throw new Error(
      "This catalogue uses outdated routing data. Update the application.",
    );
  const catalogue = catalogueSchema.parse(value);
  const cached: Cached = {
    url,
    fetchedAt: new Date().toISOString(),
    catalogue,
  };
  await savePreference(CACHE_KEY, cached).catch(() => {});
  return catalogue;
}

/**
 * The last catalogue that parsed, for offline starts. A catalogue failure must never stop
 * the user routing on or removing what they already installed, so callers treat this as
 * advisory: installed state always comes from `listPacks`, never from here.
 */
export async function cachedCatalogue(
  url: string,
): Promise<Catalogue | undefined> {
  const cached = await preference<Cached>(CACHE_KEY).catch(() => undefined);
  if (!cached || cached.url !== url) return undefined;
  const parsed = catalogueSchema.safeParse(cached.catalogue);
  return parsed.success ? parsed.data : undefined;
}
