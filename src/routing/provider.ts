/**
 * Installed-pack graph provider.
 *
 * Replaces the single-pack load in the route worker. Blocks are read by byte range from
 * each cell's graph.ibx and merged by identity — never by coordinate proximity — so a road
 * crossing a cell boundary, present in both adjacent packs, becomes one edge.
 */
import {
  blockEdge,
  compactBlock,
  type CompactBlock,
} from "../offline/ibex/block";
import { validateEdge, validateNode } from "../offline/validate";
import { toGraph, type LegGraph } from "./legGraph";
import { decodeIndex } from "../offline/ibex/index";
import { IbexError, type BlockRef, type IbexIndex } from "../offline/ibex/spec";
import {
  isCellManifest,
  readFile as browserReadFile,
  readRange as browserReadRange,
  type Installed,
} from "../offline/store";
import { bboxIntersects, cellId, type BBox } from "../geo/grid";
import { type Graph, type Restriction } from "./types";

export type ProviderStats = {
  cells: string[];
  blocks: number;
  rangeReads: number;
  storedBytes: number;
  decodedBytes: number;
  duplicateEdges: number;
  seamConflicts: number;
};

type Loaded = { pack: Installed; index: IbexIndex };

/**
 * How pack bytes are obtained. The app supplies the IndexedDB/OPFS implementation; tests
 * supply one backed by the filesystem, which is what lets the whole routing core — codec,
 * merge, snapping, corridor, reference — be exercised in Node rather than a browser.
 */
export type PackReader = {
  readFile(pack: Installed, path: string): Promise<ArrayBuffer>;
  readRange(
    pack: Installed,
    path: string,
    offset: number,
    length: number,
  ): Promise<ArrayBuffer>;
};

export const browserPackReader: PackReader = {
  readFile: browserReadFile,
  readRange: browserReadRange,
};

const restrictionKey = (r: Restriction) =>
  `${r.ways.join(",")}|${r.via ?? ""}|${r.only ? 1 : 0}|${r.uTurn ? 1 : 0}`;

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class CellGraphProvider {
  private loaded: Loaded[] = [];
  private readonly cache = new Map<
    string,
    { bbox: BBox; block: CompactBlock }
  >();
  readonly stats: ProviderStats = {
    cells: [],
    blocks: 0,
    rangeReads: 0,
    storedBytes: 0,
    decodedBytes: 0,
    duplicateEdges: 0,
    seamConflicts: 0,
  };

  constructor(
    private readonly packs: Installed[],
    readonly generation: string,
    /** Published coverage, so an uninstalled cell is distinguishable from open water. */
    private readonly published: { id: string; bbox: BBox }[] = [],
    private readonly reader: PackReader = browserPackReader,
  ) {}

  /**
   * Read every installed cell's index once.
   *
   * A pack built by another generation is skipped rather than fatal: cells are downloaded
   * one at a time over weeks, and one left over from an older builder must not stop the
   * rest of the map routing. Its own header carries the tag, so no manifest is consulted.
   */
  async open(): Promise<void> {
    for (const pack of this.packs) {
      if (!isCellManifest(pack.manifest)) continue;
      const bytes = new Uint8Array(
        await this.reader.readFile(pack, "index.ibx"),
      );
      let index;
      try {
        index = decodeIndex(bytes, {
          release: this.generation,
          cell: pack.manifest.cell,
        });
      } catch (error) {
        if (error instanceof IbexError && error.kind === "release") continue;
        throw error;
      }
      this.loaded.push({ pack, index });
    }
    this.loaded.sort((a, b) =>
      a.pack.manifest.id.localeCompare(b.pack.manifest.id),
    );
    this.stats.cells = this.loaded.map((l) => l.pack.manifest.id);
  }

  get installedCells(): string[] {
    return this.loaded.map((l) => l.pack.manifest.id);
  }

  /** Union of installed coverage; the merged graph's bbox. */
  envelope(): BBox | undefined {
    if (!this.loaded.length) return undefined;
    return this.loaded.reduce<BBox>(
      (acc, l) => [
        Math.min(acc[0], l.index.bbox[0]),
        Math.min(acc[1], l.index.bbox[1]),
        Math.max(acc[2], l.index.bbox[2]),
        Math.max(acc[3], l.index.bbox[3]),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
  }

  contains(point: [number, number]): boolean {
    return this.loaded.some(
      (l) =>
        point[0] >= l.index.bbox[0] &&
        point[0] <= l.index.bbox[2] &&
        point[1] >= l.index.bbox[1] &&
        point[1] <= l.index.bbox[3],
    );
  }

  /** Published cells overlapping the area that are not installed. */
  missing(bbox: BBox): string[] {
    const installed = new Set(this.installedCells);
    return this.published
      .filter((c) => !installed.has(c.id) && bboxIntersects(c.bbox, bbox))
      .map((c) => c.id);
  }

  private async block(entry: Loaded, ref: BlockRef): Promise<CompactBlock> {
    const key = `${entry.pack.manifest.id}:${ref.x}:${ref.y}`;
    const hit = this.cache.get(key);
    if (hit) return hit.block;
    const stored = new Uint8Array(
      await this.reader.readRange(
        entry.pack,
        "graph.ibx",
        ref.offset,
        ref.length,
      ),
    );
    this.stats.rangeReads++;
    this.stats.storedBytes += stored.length;
    const raw = await inflate(stored);
    this.stats.decodedBytes += raw.length;
    // Every record is decoded and checked here, once; what is kept is the bytes.
    const block = compactBlock(
      raw,
      entry.index.strings,
      {
        releaseTag: entry.index.releaseTag,
        block: { x: ref.x, y: ref.y },
        crc: ref.crc,
      },
      { node: validateNode, edge: validateEdge },
    );
    this.cache.set(key, { bbox: ref.bbox, block });
    this.stats.blocks++;
    return block;
  }

  /** Forget decoded blocks outside `bbox`, so routing leg by leg keeps memory bounded. */
  retain(bbox: BBox): void {
    for (const [key, block] of this.cache)
      if (!bboxIntersects(block.bbox, bbox)) this.cache.delete(key);
  }

  /** The area's graph as objects, for scripts and audits; routing uses `loadLeg`. */
  async load(bbox: BBox): Promise<Graph> {
    return toGraph(await this.loadLeg(bbox));
  }

  /**
   * Merge every block intersecting the area into one leg graph. Nodes key on OSM id and
   * edges on their deterministic id, so a boundary segment carried by two packs collapses
   * to one.
   */
  async loadLeg(bbox: BBox): Promise<LegGraph> {
    const restrictions = new Map<string, Restriction>();
    const blocks: CompactBlock[] = [];
    for (const entry of this.loaded) {
      if (!bboxIntersects(entry.index.bbox, bbox)) continue;
      for (const rule of entry.index.restrictions)
        restrictions.set(restrictionKey(rule), rule);
      for (const ref of entry.index.blocks)
        if (bboxIntersects(ref.bbox, bbox))
          blocks.push(await this.block(entry, ref));
    }
    const envelope = this.envelope();
    if (!envelope) throw new IbexError("cell", "No installed cells here");

    // The first block to describe a node wins. A node in more than one block is on a
    // seam, and only an edge with both ends there can be carried twice.
    const of = new Map<number, number>(),
      ids: number[] = [],
      lon: number[] = [],
      lat: number[] = [],
      elevation: number[] = [],
      shared: number[] = [];
    const locals = blocks.map((block) => {
      const local = new Int32Array(block.nodeId.length);
      for (let i = 0; i < local.length; i++) {
        const id = block.nodeId[i];
        let g = of.get(id);
        if (g === undefined) {
          g = ids.length;
          of.set(id, g);
          ids.push(id);
          lon.push(block.lon[i]);
          lat.push(block.lat[i]);
          elevation.push(block.elevation[i]);
          shared.push(0);
        } else shared[g] = 1;
        local[i] = g;
      }
      return local;
    });
    of.clear();

    const total = blocks.reduce((sum, b) => sum + b.edgeId.length, 0);
    const edgeBlock = new Int32Array(total),
      edgeLocal = new Int32Array(total),
      from = new Int32Array(total),
      to = new Int32Array(total);
    const tiles: string[] = [],
      tileOf = blocks.map((block) => {
        const t = tiles.indexOf(block.tile);
        return t === -1 ? tiles.push(block.tile) - 1 : t;
      });
    const seam = new Map<number, number>();
    let count = 0;
    for (const [b, block] of blocks.entries()) {
      const local = locals[b];
      for (let i = 0; i < block.edgeId.length; i++) {
        const f = local[block.from[i]],
          t = local[block.to[i]];
        if (shared[f] && shared[t]) {
          const id = block.edgeId[i];
          const existing = seam.get(id);
          if (existing !== undefined) {
            this.stats.duplicateEdges++;
            // Identical by construction; a difference means the two packs disagree,
            // which is worth surfacing rather than silently preferring one.
            if (
              blockEdge(blocks[edgeBlock[existing]], edgeLocal[existing])
                .length !== blockEdge(block, i).length
            )
              this.stats.seamConflicts++;
            continue;
          }
          seam.set(id, count);
        }
        edgeBlock[count] = b;
        edgeLocal[count] = i;
        from[count] = f;
        to[count] = t;
        count++;
      }
    }
    return {
      schemaVersion: 1,
      bbox: envelope,
      restrictions: [...restrictions.values()],
      nodeId: Float64Array.from(ids),
      lon: Float64Array.from(lon),
      lat: Float64Array.from(lat),
      elevation: Float64Array.from(elevation),
      from: from.slice(0, count),
      to: to.slice(0, count),
      tile: Int32Array.from(edgeBlock.subarray(0, count), (b) => tileOf[b]),
      tiles,
      ...decoders(blocks, edgeBlock.slice(0, count), edgeLocal.slice(0, count)),
    };
  }
}

/**
 * The leg graph's edge accessors, made apart from the merge: a closure keeps its whole
 * enclosing scope alive, and the merge's scope holds a JS array per node column.
 */
function decoders(
  blocks: CompactBlock[],
  edgeBlock: Int32Array,
  edgeLocal: Int32Array,
): Pick<LegGraph, "way" | "edge"> {
  return {
    way: (e) =>
      String(Math.floor(blocks[edgeBlock[e]].edgeId[edgeLocal[e]] / 8192)),
    edge: (e) => blockEdge(blocks[edgeBlock[e]], edgeLocal[e]),
  };
}

/** Grow an anchor bbox so the corridor has room, with a floor for short requests. */
export function searchArea(anchors: [number, number][], minKm = 12): BBox {
  const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of anchors) {
    bbox[0] = Math.min(bbox[0], lon);
    bbox[1] = Math.min(bbox[1], lat);
    bbox[2] = Math.max(bbox[2], lon);
    bbox[3] = Math.max(bbox[3], lat);
  }
  const lat = (bbox[1] + bbox[3]) / 2;
  const padLat = Math.max(minKm / 111.32, (bbox[3] - bbox[1]) * 0.25);
  const padLon = Math.max(
    minKm / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180))),
    (bbox[2] - bbox[0]) * 0.25,
  );
  return [
    bbox[0] - padLon,
    bbox[1] - padLat,
    bbox[2] + padLon,
    bbox[3] + padLat,
  ];
}

export { cellId };
