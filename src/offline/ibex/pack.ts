/**
 * One built cell, turned into the two files the app downloads.
 *
 * `index.ibx` is a 64-byte header plus the block directory; `graph.ibx` is the z13 blocks
 * deflated and concatenated, each addressable by the byte range the directory records. The
 * router never reads a whole cell — it reads the blocks its search area touches — which is
 * why the block grid exists at all and why the cell zoom is only a download unit.
 *
 * Lifted out of `scripts/package_cells.ts` so a builder can pack a cell the moment it has
 * it. Going through a `graph.json` on disk first cost a hundred megabytes per cell, which
 * a region could afford and a continent cannot.
 */
import { deflateRawSync } from "node:zlib";
import { cellBBox, type Cell } from "../../geo/grid";
import { tileOf } from "../../geo/grid";
import { encodeBlock, stringTable } from "./block";
import { encodeIndex } from "./index";
import { crc32 } from "./varint";
import { releaseTag, type BlockRef } from "./spec";
import type { Edge, Graph, Node } from "../../routing/types";

export const BLOCK_ZOOM = 13;
export const FIELD_ZOOM = 15;
/** Above this a cell is unwieldy to download and something has gone wrong upstream. */
export const CELL_BYTE_LIMIT = 50_000_000;

export type PackedCell = {
  index: Uint8Array;
  graph: Uint8Array;
  blocks: number;
};

export function packCell(
  graph: Graph,
  cell: Cell,
  generation: string,
  meta: Record<string, unknown> = {},
): PackedCell {
  const tag = releaseTag(generation);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // A block owns the edges whose first geometry point falls in it — the same rule the cell
  // itself uses, one zoom finer, so ownership is consistent at both levels.
  const grouped = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    const tile = tileOf(edge.geometry[0], BLOCK_ZOOM);
    const key = `${tile.x}/${tile.y}`;
    const list = grouped.get(key);
    if (list) list.push(edge);
    else grouped.set(key, [edge]);
  }

  const strings = stringTable();
  const blocks: BlockRef[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const key of [...grouped.keys()].sort()) {
    const edges = grouped.get(key)!;
    const [x, y] = key.split("/").map(Number);
    const nodes: Node[] = [];
    const seen = new Set<number>();
    for (const edge of edges)
      for (const nodeId of [edge.from, edge.to])
        if (!seen.has(nodeId)) {
          seen.add(nodeId);
          const node = byId.get(nodeId);
          if (!node) throw new Error(`edge ${edge.id} references missing node ${nodeId}`);
          nodes.push(node);
        }
    const raw = encodeBlock({ x, y }, nodes, edges, strings, tag);
    const stored = deflateRawSync(raw, { level: 9 });
    const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const edge of edges)
      for (const p of edge.geometry) {
        bbox[0] = Math.min(bbox[0], p[0]);
        bbox[1] = Math.min(bbox[1], p[1]);
        bbox[2] = Math.max(bbox[2], p[0]);
        bbox[3] = Math.max(bbox[3], p[1]);
      }
    blocks.push({
      x,
      y,
      offset,
      length: stored.length,
      rawLength: raw.length,
      crc: crc32(raw),
      nodes: nodes.length,
      edges: edges.length,
      bbox,
    });
    chunks.push(stored);
    offset += stored.length;
  }

  const graphBytes = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    graphBytes.set(chunk, at);
    at += chunk.length;
  }
  const indexBytes = encodeIndex({
    release: generation,
    cell,
    blockZoom: BLOCK_ZOOM,
    fieldZoom: FIELD_ZOOM,
    bbox: cellBBox(cell),
    strings: strings.values(),
    blocks,
    restrictions: graph.restrictions,
    fields: {},
    meta: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      restrictions: graph.restrictions.length,
      ...meta,
    },
  });

  const total = indexBytes.length + graphBytes.length;
  if (total > CELL_BYTE_LIMIT)
    throw new Error(
      `cell is ${(total / 1e6).toFixed(1)} MB, above the ${CELL_BYTE_LIMIT / 1e6} MB limit`,
    );
  return { index: indexBytes, graph: graphBytes, blocks: blocks.length };
}
