/**
 * Checks against the generated release. Skipped when it has not been built, so CI stays
 * green without 154 MB of packs, while a local run exercises the real data end to end in
 * Node — no browser, no clicking.
 *
 * Build it with:
 *   uv run scripts/fetch_extracts.py && uv run scripts/clip_region.py
 *   uv run scripts/global_splits.py && uv run scripts/extract_cells.py
 *   uv run scripts/build_cells.py && node --import tsx scripts/package_cells.ts
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { catalogueSchema } from "../src/offline/catalogue";
import { decodeIndex } from "../src/offline/ibex/index";
import { decodeBlock } from "../src/offline/ibex/block";
import { crc32 } from "../src/offline/ibex/varint";
import {
  CellGraphProvider,
  searchArea,
  type PackReader,
} from "../src/routing/provider";
import { cellBBox, parseCellId } from "../src/geo/grid";
import { route } from "../src/routing/engine";
import { compileProfile } from "../src/routing/compile";
import { GRAVEL, ROAD, WANDERER, withPreferences } from "./helpers";
import { validateEdge, validateNode } from "../src/offline/validate";
import type { Installed } from "../src/offline/store";
import type { Point } from "../src/routing/types";
import { DATA_VERSION } from "../src/offline/version";

const DIR = process.env.IBEX_RELEASE ?? "data/build/geneva-toulon-v7/packs";
const present = existsSync(`${DIR}/catalogue.json`);
const CELL_LIMIT = 50_000_000;

const read = (path: string) => new Uint8Array(readFileSync(path));
const catalogue = present
  ? catalogueSchema.parse(
      JSON.parse(readFileSync(`${DIR}/catalogue.json`, "utf8")),
    )
  : undefined;

function installedFor(ids: string[]): {
  packs: Installed[];
  reader: PackReader;
} {
  const packs = ids.map(
    (id) =>
      ({
        manifest: JSON.parse(
          readFileSync(`${DIR}/${id}/manifest.json`, "utf8"),
        ),
        installedAt: "1970-01-01T00:00:00.000Z",
        directory: id,
        backend: "idb",
      }) as Installed,
  );
  const reader: PackReader = {
    async readFile(pack, path) {
      return read(`${DIR}/${pack.manifest.id}/${path}`).buffer.slice(
        0,
      ) as ArrayBuffer;
    },
    async readRange(pack, path, offset, length) {
      const bytes = read(`${DIR}/${pack.manifest.id}/${path}`);
      return bytes.slice(offset, offset + length).buffer as ArrayBuffer;
    },
  };
  return { packs, reader };
}

describe.skipIf(!present)("generated release", () => {
  it("publishes a catalogue that validates and is grid-consistent", () => {
    expect(catalogue!.cells.length).toBeGreaterThan(0);
    expect(catalogue!.grid).toMatchObject({ scheme: "xyz", blockZoom: 13 });
    // `<osm edition>-<hash of inputs>`; pin the shape, not a value that moves with the data.
    expect(catalogue!.release).toMatch(/^\d{8}-[0-9a-f]{8}$/);
    for (const cell of catalogue!.cells) {
      const derived = cellBBox(parseCellId(cell.id));
      derived.forEach((v, i) => expect(cell.bbox[i]).toBeCloseTo(v, 6));
    }
  });

  it("keeps every cell under the download limit", () => {
    for (const cell of catalogue!.cells)
      expect(cell.bytes).toBeLessThan(CELL_LIMIT);
  });

  it("agrees between the catalogue and each cell manifest", () => {
    for (const cell of catalogue!.cells) {
      const manifest = JSON.parse(
        readFileSync(`${DIR}/${cell.id}/manifest.json`, "utf8"),
      );
      expect(manifest.release).toBe(catalogue!.release);
      expect(manifest.version).toBe(cell.version);
      expect(manifest.id).toBe(cell.id);
      expect(manifest.dataVersion).toBe(DATA_VERSION);
      const total = manifest.files.reduce(
        (sum: number, f: { bytes: number }) => sum + f.bytes,
        0,
      );
      expect(total).toBe(cell.bytes);
    }
  });

  it("decodes every cell index against the release", () => {
    for (const cell of catalogue!.cells) {
      const index = decodeIndex(read(`${DIR}/${cell.id}/index.ibx`), {
        release: catalogue!.release,
        cell: parseCellId(cell.id),
      });
      expect(index.blocks.length).toBeGreaterThan(0);
      expect(index.strings.length).toBeGreaterThan(0);
      // Byte ranges must tile the graph file without gaps or overlaps.
      const sorted = [...index.blocks].sort((a, b) => a.offset - b.offset);
      let at = 0;
      for (const block of sorted) {
        expect(block.offset).toBe(at);
        at += block.length;
      }
      const graphBytes = readFileSync(`${DIR}/${cell.id}/graph.ibx`).length;
      expect(at).toBe(graphBytes);
    }
  });

  it("verifies and decodes every block of one cell", () => {
    const id = catalogue!.cells[0].id;
    const index = decodeIndex(read(`${DIR}/${id}/index.ibx`), {
      release: catalogue!.release,
    });
    const graph = readFileSync(`${DIR}/${id}/graph.ibx`);
    let nodes = 0;
    let edges = 0;
    for (const ref of index.blocks) {
      const raw = new Uint8Array(
        inflateRawSync(graph.subarray(ref.offset, ref.offset + ref.length)),
      );
      expect(raw.length).toBe(ref.rawLength);
      expect(crc32(raw)).toBe(ref.crc);
      const decoded = decodeBlock(raw, index.strings, {
        releaseTag: index.releaseTag,
        block: { x: ref.x, y: ref.y },
        crc: ref.crc,
      });
      expect(decoded.nodes).toHaveLength(ref.nodes);
      expect(decoded.edges).toHaveLength(ref.edges);
      nodes += decoded.nodes.length;
      edges += decoded.edges.length;
    }
    expect(edges).toBeGreaterThan(1000);
    expect(nodes).toBeGreaterThan(1000);
  });

  it("decodes data every validator accepts", () => {
    const id = catalogue!.cells[0].id;
    const index = decodeIndex(read(`${DIR}/${id}/index.ibx`), {
      release: catalogue!.release,
    });
    const graph = readFileSync(`${DIR}/${id}/graph.ibx`);
    for (const ref of index.blocks.slice(0, 12)) {
      const decoded = decodeBlock(
        new Uint8Array(
          inflateRawSync(graph.subarray(ref.offset, ref.offset + ref.length)),
        ),
        index.strings,
        { releaseTag: index.releaseTag, crc: ref.crc },
      );
      for (const node of decoded.nodes) validateNode(node);
      for (const edge of decoded.edges) validateEdge(edge);
    }
  });

  describe("routing on real data", () => {
    // Geneva to Les Voirons: crosses the 9-264-181 / 9-265-181 boundary at 6.328125.
    const anchors: Point[] = [
      [6.151, 46.201],
      [6.37, 46.22],
    ];
    const ids = ["9-264-181", "9-265-181"];
    const hasCells =
      present && ids.every((id) => existsSync(`${DIR}/${id}/index.ibx`));

    it.skipIf(!hasCells)(
      "routes across the cell boundary",
      async () => {
        const { packs, reader } = installedFor(ids);
        const provider = new CellGraphProvider(
          packs,
          catalogue!.release,
          catalogue!.cells.map((c) => ({ id: c.id, bbox: c.bbox })),
          reader,
        );
        await provider.open();
        expect(provider.installedCells).toEqual(ids);
        const graph = await provider.load(searchArea(anchors));
        expect(graph.edges.length).toBeGreaterThan(50_000);
        const result = route(graph, { anchors, profile: GRAVEL }, "reference");
        expect(result.status).toBe("ok");
        expect(result.distanceM).toBeGreaterThan(15_000);
        expect(result.distanceM).toBeLessThan(80_000);
        // The route must actually use both cells' data.
        expect(result.geometry[0][0]).toBeLessThan(6.328125);
        expect(result.geometry.at(-1)![0]).toBeGreaterThan(6.328125);
        expect(provider.stats.seamConflicts).toBe(0);

        // Segments must survive the real codec, not only synthetic graphs: surface,
        // highway, tags and grades all have to decode for the classification to mean
        // anything on the map.
        expect(result.segments.length).toBeGreaterThan(0);
        expect(result.segments[0].start).toBe(0);
        expect(result.segments.at(-1)!.end).toBe(result.geometry.length - 1);
        for (let i = 1; i < result.segments.length; i++)
          expect(result.segments[i].start).toBe(result.segments[i - 1].end);
        const covered = result.segments.reduce((sum, s) => sum + s.lengthM, 0);
        expect(covered).toBeGreaterThan(result.distanceM * 0.98);
        expect(covered).toBeLessThan(result.distanceM * 1.02);
        // Real terrain is not uniform, and every segment names a real surface.
        expect(
          new Set(result.segments.map((s) => s.ride)).size,
        ).toBeGreaterThan(1);
        expect(result.segments.every((s) => s.surface.length > 0)).toBe(true);
      },
      120_000,
    );

    /**
     * The reported four-waypoint track, verbatim. It failed with "No route connects these
     * waypoints under this model" because the leg from Monnetier to the Prieuré crosses
     * the Menoge on small road bridges. Terrain grades below those decks made the
     * structures unusable to a grade-limited model, so it could not cross a bridge.
     */
    it.skipIf(!hasCells)(
      "solves the reported Voirons track under a grade-limited model",
      async () => {
        const track: Point[] = [
          [6.1934, 46.197],
          [6.3062, 46.242],
          [6.3576, 46.2289],
          [6.3545, 46.2285],
        ];
        const { packs, reader } = installedFor(ids);
        const provider = new CellGraphProvider(
          packs,
          catalogue!.release,
          catalogue!.cells.map((c) => ({ id: c.id, bbox: c.bbox })),
          reader,
        );
        await provider.open();
        const graph = await provider.load(searchArea(track));
        const result = route(
          graph,
          { anchors: track, profile: WANDERER },
          "reference",
        );
        expect(result.failedLeg).toBeUndefined();
        expect(result.status).toBe("ok");
        expect(result.distanceM).toBeGreaterThan(20_000);
        expect(result.distanceM).toBeLessThan(45_000);
        // Grades are no longer capped — they are priced — so the guarantee is that the
        // wanderer stays within its detour budget rather than that it dodges gradients.
        const direct = route(
          graph,
          { anchors: track, profile: GRAVEL },
          "reference",
        );
        expect(result.distanceM).toBeLessThan(
          direct.distanceM * compileProfile(WANDERER).detour.budget_ratio,
        );
      },
      120_000,
    );

    /**
     * Geneva to Saxel on a 28 mm road bike that strongly avoids traffic, unpaved ground,
     * roughness and technicality. The ride that sets the standard follows signed route 23
     * through Route de Couty on tarmac. A traffic hazard that charged every tertiary sent
     * the router over the Voirons instead, onto 4.9 km of untagged track above Lucinges.
     */
    it.skipIf(!hasCells)(
      "keeps a traffic-shy road bike to tarmac and the signed route on the way to Saxel",
      async () => {
        const trip: Point[] = [
          [6.1967, 46.1971],
          [6.3965, 46.2433],
        ];
        const { packs, reader } = installedFor(ids);
        const provider = new CellGraphProvider(
          packs,
          catalogue!.release,
          catalogue!.cells.map((c) => ({ id: c.id, bbox: c.bbox })),
          reader,
        );
        await provider.open();
        const graph = await provider.load(searchArea(trip));
        const profile = withPreferences(ROAD, {
          detour: "prefer",
          traffic_stress: "strongly_avoid",
          unpaved: "strongly_avoid",
          surface_difficulty: "strongly_avoid",
          climbing: "neutral",
          scenic: "neutral",
          urbanity: "neutral",
          cycle_infrastructure: "prefer",
        });
        const result = route(graph, { anchors: trip, profile }, "reference");
        expect(result.status).toBe("ok");
        const byId = new Map(graph.edges.map((e) => [e.id, e]));
        const metres = (test: (e: (typeof graph.edges)[number]) => boolean) =>
          result.edgeIds.reduce((sum, id) => {
            const e = byId.get(id);
            return e && test(e) ? sum + e.length : sum;
          }, 0);
        expect(
          metres((e) => ["track", "path"].includes(e.highway)),
        ).toBeLessThan(200);
        expect(
          metres((e) => ["primary", "secondary"].includes(e.highway)),
        ).toBeLessThan(100);
        expect(metres((e) => e.name === "Route de Couty")).toBeGreaterThan(500);
      },
      120_000,
    );

    it.skipIf(!hasCells)(
      "reports the missing cell when only one is installed",
      async () => {
        const { packs, reader } = installedFor([ids[0]]);
        const provider = new CellGraphProvider(
          packs,
          catalogue!.release,
          catalogue!.cells.map((c) => ({ id: c.id, bbox: c.bbox })),
          reader,
        );
        await provider.open();
        expect(provider.contains(anchors[0])).toBe(true);
        expect(provider.contains(anchors[1])).toBe(false);
        expect(provider.missing(searchArea(anchors))).toContain(ids[1]);
      },
      120_000,
    );
  });
});
