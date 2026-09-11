/** Pure Web Mercator XYZ grid maths. Download cells and graph blocks are both XYZ tiles. */
import type { Point } from "../routing/types";

export type BBox = [number, number, number, number];
export type CellId = string;
export type Cell = { zoom: number; x: number; y: number };

/** Web Mercator cannot represent the poles; this is the standard cut-off. */
export const MAX_LATITUDE = 85.0511287798066;
const MAX_ZOOM = 24;
const cellPattern = /^(\d{1,2})-(\d{1,8})-(\d{1,8})$/;

export function mercatorX(lon: number): number {
  return (lon + 180) / 360;
}
export function mercatorY(lat: number): number {
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  return (1 - Math.asinh(Math.tan((clamped * Math.PI) / 180)) / Math.PI) / 2;
}
export function lonOfMercator(x: number): number {
  return x * 360 - 180;
}
export function latOfMercator(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

function count(zoom: number): number {
  return 2 ** zoom;
}
function checkZoom(zoom: number): number {
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > MAX_ZOOM)
    throw new Error(`Invalid grid zoom: ${zoom}`);
  return zoom;
}
/** Tiles wrap in x and clamp in y, so a cell always exists for any coordinate. */
function clampX(x: number, zoom: number): number {
  const n = count(zoom);
  return ((Math.floor(x) % n) + n) % n;
}
function clampY(y: number, zoom: number): number {
  return Math.max(0, Math.min(count(zoom) - 1, Math.floor(y)));
}

export function tileOf(p: Point, zoom: number): Cell {
  const n = count(checkZoom(zoom));
  return {
    zoom,
    x: clampX(mercatorX(p[0]) * n, zoom),
    y: clampY(mercatorY(p[1]) * n, zoom),
  };
}

export function cellId(c: Cell): CellId {
  checkZoom(c.zoom);
  return `${c.zoom}-${c.x}-${c.y}`;
}

/** Display form only; never used as a storage key or manifest id. */
export function cellLabel(c: Cell): string {
  return `${c.zoom}/${c.x}/${c.y}`;
}

export function parseCellId(id: CellId): Cell {
  const match = cellPattern.exec(id);
  if (!match) throw new Error(`Invalid cell id: ${id}`);
  const zoom = checkZoom(Number(match[1])),
    x = Number(match[2]),
    y = Number(match[3]),
    n = count(zoom);
  if (x >= n || y >= n) throw new Error(`Cell outside zoom ${zoom}: ${id}`);
  return { zoom, x, y };
}

export function cellBBox(c: Cell): BBox {
  const n = count(checkZoom(c.zoom));
  return [
    lonOfMercator(c.x / n),
    latOfMercator((c.y + 1) / n),
    lonOfMercator((c.x + 1) / n),
    latOfMercator(c.y / n),
  ];
}

/**
 * Cells covering a bbox. A bbox edge lying exactly on a tile boundary belongs to
 * the tile it closes, never to the next one. The epsilon absorbs the round-trip
 * error of latOfMercator/mercatorY so a cell's own bbox maps back to that cell.
 */
export function cellsInBBox(b: BBox, zoom: number): Cell[] {
  const n = count(checkZoom(zoom)),
    epsilon = 1e-9;
  const [w, s, e, north] = b;
  const x0 = clampX(mercatorX(w) * n + epsilon, zoom),
    y0 = clampY(mercatorY(north) * n + epsilon, zoom);
  const x1 = Math.max(
      x0,
      clampX(Math.ceil(mercatorX(e) * n - epsilon) - 1, zoom),
    ),
    y1 = Math.max(y0, clampY(Math.ceil(mercatorY(s) * n - epsilon) - 1, zoom));
  const cells: Cell[] = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) cells.push({ zoom, x, y });
  return cells;
}

export function childCells(c: Cell, zoom: number): Cell[] {
  checkZoom(c.zoom);
  if (checkZoom(zoom) < c.zoom)
    throw new Error(`Zoom ${zoom} is coarser than cell zoom ${c.zoom}`);
  const factor = count(zoom - c.zoom),
    cells: Cell[] = [];
  for (let dy = 0; dy < factor; dy++)
    for (let dx = 0; dx < factor; dx++)
      cells.push({ zoom, x: c.x * factor + dx, y: c.y * factor + dy });
  return cells;
}

export function parentCell(c: Cell, zoom: number): Cell {
  checkZoom(c.zoom);
  if (checkZoom(zoom) > c.zoom)
    throw new Error(`Zoom ${zoom} is finer than cell zoom ${c.zoom}`);
  const factor = count(c.zoom - zoom);
  return { zoom, x: Math.floor(c.x / factor), y: Math.floor(c.y / factor) };
}

/** The eight surrounding cells, wrapping in x and dropping cells beyond the poles. */
export function neighbours(c: Cell): Cell[] {
  const n = count(checkZoom(c.zoom)),
    cells: Cell[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const y = c.y + dy;
      if (y < 0 || y >= n) continue;
      cells.push({ zoom: c.zoom, x: (((c.x + dx) % n) + n) % n, y });
    }
  return cells;
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export function unionBBox(boxes: BBox[]): BBox {
  if (!boxes.length) throw new Error("Cannot union an empty bbox list");
  return boxes.reduce(
    (acc, b): BBox => [
      Math.min(acc[0], b[0]),
      Math.min(acc[1], b[1]),
      Math.max(acc[2], b[2]),
      Math.max(acc[3], b[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity] as BBox,
  );
}

/** Nominal ground size of a cell at its centre latitude, for size reporting only. */
export function cellSizeM(c: Cell): number {
  const [, s, , n] = cellBBox(c),
    lat = (s + n) / 2;
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / count(c.zoom);
}
