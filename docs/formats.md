# Current data contracts (pre-grid baseline)

Frozen record of the formats and message protocols as they stand **before** the move to
selectable grid cells, so the migration can be diffed against something. Every claim here
was read out of the code at the commit that introduced this file; line references are
indicative, names are authoritative.

## Pack manifest — `schemaVersion: 1`

Defined by `manifestSchema` in `src/offline/store.ts`, parsed by `readManifest(url)`.

| Field                              | Constraint                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `schemaVersion`                    | literal `1`                                                                                  |
| `id`                               | `^[a-z0-9-]+$` — also the `packs` object-store key, so **one record per id**                 |
| `name`                             | ≤100 chars                                                                                   |
| `version`                          | `^[a-zA-Z0-9-]+$`; `sha256(JSON.stringify(files))[0..16]`, assigned by `package_region.ts`   |
| `bbox`                             | `[west, south, east, north]`                                                                 |
| `osmTimestamp`                     | free string (`timestamp_osm_base` from Overpass)                                             |
| `costModelVersion`                 | literal `COST_MODEL_VERSION` (currently **4**)                                               |
| `terrainCoverage`                  | 0..1 — fraction of edges with non-null `grades`                                              |
| `attribution`                      | free string                                                                                  |
| `files[]`                          | 2..1000 entries of `{ path: /^[a-zA-Z0-9_.-]+$/, bytes: ≤300 MB, sha256: /^[a-f0-9]{64}$/ }` |
| `build`, `source`, `terrainSource` | free-form; `source`/`terrainSource` are **not** in the schema and pass through untyped       |

`path` is deliberately flat — no directory separators, no traversal. Files are fetched as
`new URL(file.path, manifestURL)`.

`readManifest` checks `costModelVersion` _before_ `manifestSchema.parse` so a stale pack gets
the actionable message "This region uses outdated routing data…" instead of a schema error.

### Installation invariants (`installPack`)

1. `files` must contain **both** `index.bin` and `basemap.pmtiles`, with no duplicate paths.
2. Total bytes ≤ **400 MB**.
3. `storageEstimate()` headroom must exceed `total * 1.15`.
4. A pack already installed at the same `version` is returned untouched.
5. Each file is streamed, aborted if `received > bytes`, rejected on `received !== bytes`
   ("Incomplete download") or sha256 mismatch ("Pack checksum mismatch").
6. The `packs` record is written **only after every file verifies**, so a partially
   downloaded pack is never listed as installed.
7. Verified file paths accumulate under preference `download:${directory}` after every file,
   which is what makes a resumed install skip already-verified files.
8. **On abort the staged files and the resume key are deleted**; on other errors they are
   kept. (This is the behaviour the grid work has to change — cancellation should retain
   staged data for resumption.)

## Storage layout

IndexedDB database **`cyclatractor-v1`**, version 1, three object stores:

| Store         | Key                          | Value                                                       |
| ------------- | ---------------------------- | ----------------------------------------------------------- |
| `packs`       | `manifest.id`                | `Installed = { manifest, installedAt, directory, backend }` |
| `files`       | `` `${directory}/${path}` `` | `ArrayBuffer` (only when `backend === "idb"`)               |
| `preferences` | string                       | arbitrary                                                   |

OPFS is preferred when `navigator.storage.getDirectory` exists and a write probe succeeds:
root directory `cyclatractor`, per-pack subdirectory `` `${manifest.id}-${manifest.version}` ``
(= `Installed.directory`), flat files inside. Otherwise `backend` is `"idb"`.

### Preference keys in use

| Key                     | Written by                     | Value                                               |
| ----------------------- | ------------------------------ | --------------------------------------------------- |
| `ibex-tracks`           | `saveTracks` (`src/tracks.ts`) | `TrackCollection`                                   |
| `plan`                  | _legacy, read-only_            | pre-multi-track `{ anchors, profile, attraction? }` |
| `routing-profiles`      | `saveModels` (`src/models.ts`) | `UserProfile[]`                                     |
| `download:${directory}` | `installPack`                  | `string[]` of verified staged paths                 |

Renaming the database or any of these keys is out of bounds; new state gets a new key.

## Graph files

Despite the `.bin` extension these are **gzipped JSON**, written with
`gzipSync(JSON.stringify(value), { level: 6 })` in `scripts/package_region.ts` and read by
`readJSON` in `src/offline/store.ts` via `DecompressionStream("gzip")` with a **32 MB decoded
cap** per file.

### `graph-<tile>.bin`

`{ nodes: Node[], edges: Edge[] }`, where `nodes` is the union of every `from`/`to` of the
member edges — so **boundary nodes are already duplicated across chunks today**, and
`loadGraph` already deduplicates them into a `Map<number, Node>` keyed by OSM node id.

`<tile>` is **not** an XYZ tile. It is `f"{floor(lon * 20)}_{floor(lat * 20)}"` computed from
the edge's **first geometry coordinate** (`scripts/build_region.py`), i.e. a 0.05° graticule
≈ 3.85 × 5.57 km at latitude 46. Geneva yields 147 such chunks. An edge is therefore filed by
where it starts and may extend well outside its own chunk, which is why `index.bin` stores a
per-chunk bbox derived from member geometry rather than from the cell.

### `index.bin`

```ts
type Index = {
  schemaVersion: 1;
  bbox: Graph["bbox"];
  restrictions: Graph["restrictions"]; // ALL of them, release-wide (2684 for Geneva)
  chunks: { path: string; bbox: Graph["bbox"] }[];
  fields: Record<Profile, Field>; // the four bundled presets
};
```

Two facts that matter for the migration:

- **`chunks[].bbox` is never used for spatial selection.** `route.worker.ts` calls
  `loadGraph(pack, index, index.chunks)` — every chunk of the pack is decoded on every route.
- **`fields` is validated and then discarded.** The worker rebuilds the field at runtime with
  `buildField(graph, request)` because a baked field cannot represent arbitrary user
  coefficients. The baked rasters are dead payload for anything but the four presets.

`readRange(pack, path, offset, length)` exists and works on both backends but **has no
caller** — it is the byte-range primitive the block format will need.

## Routing types

`src/routing/types.ts`. `COST_MODEL_VERSION = 4`. `bbox` is `[west, south, east, north]`
everywhere. `Point` is `[lon, lat]`.

- `Node = { id, p: Point, elevation: number | null }` — `id` is the **OSM node id**.
- `Edge` — `id` is currently `len(edges)`, a **per-build sequence number**, not an identity.
  `way` is the OSM way id as a string. `tile` is the 0.05° graticule key above. Direction is
  baked in: each traversable direction of a physical segment is its own `Edge` record.
  Terrain lives in `grades: [meters, grade][] | null`.
- `Restriction = { ways: string[], via?, only, uTurn? }` — `ways` are OSM way ids, so these
  are already globally stable; there is no relation id to dedup on.
- `Field = { width, height, cellM, bbox, costs, paths }` — a dense raster with `cellM = 700`
  sized to and indexed **relative to `graph.bbox`**, via linear (not Mercator) interpolation
  in `cell()` / `center()`. Being bbox-relative is precisely what prevents per-cell rasters
  from tiling.
- `RouteStatus = "ok" | "outside-coverage" | "snap-failed" | "no-path" | "budget-exceeded"` —
  there is no state for "this cell is published but not installed", and `outside-coverage`
  comes from a single rectangular `pointInBounds(p, graph.bbox)` test.

Defensive limits on all of the above now live in `src/offline/validate.ts`
(`LIMITS`, `validateNode`, `validateEdge`, `validateField`, `validateChunk`,
`validateIndexSize`, `validateAnchors`), extracted verbatim from `route.worker.ts` so the
binary reader will inherit the same contract. `LIMITS.fieldCells = 100_000` is load-bearing:
it caps any mosaicked field and is what makes a zoom-16 raster infeasible.

## Worker protocols

### Route worker (`src/workers/route.worker.ts`)

Input — a bare message, one pack per computation:

```ts
{
  id: number;
  pack: Installed;
  request: RouteRequest;
}
```

Output, all carrying the same `id`:

| `type`     | Payload                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `progress` | `label` — `"Preparing your profile…"`, `"Following the semantic corridor…"` (`· expanding` while widening), `"Comparing with the complete graph…"` |
| `partial`  | `route: RouteResult` (the corridor result; **`main.tsx` never handles this message**)                                                              |
| `result`   | `comparison: { reference, corridor, relativeCost, fieldView? }`                                                                                    |
| `error`    | `error: string`                                                                                                                                    |

The worker has no cancellation of its own. `main.tsx` creates a **fresh worker per
computation**, bumps `generation.current`, and `terminate()`s it; stale messages are dropped
on `data.id !== generation.current`. A block cache therefore cannot survive a computation
until the worker becomes persistent.

Corridor search widens through radii `[2, 5, 12, Infinity]`, continuing only when the failure
is `no-path`/`snap-failed` with no `failedLeg` **and** every anchor is inside `index.bbox`.

### Data worker (`src/workers/data.worker.ts`)

| In                             | Out                                                             |
| ------------------------------ | --------------------------------------------------------------- |
| `{ id, type: "install", url }` | `progress` `{ fraction }` … then `installed` `{ pack }`         |
| `{ id, type: "cancel" }`       | — (aborts the `AbortController` for that `id`)                  |
| `{ id, type: "remove", pack }` | `removed`                                                       |
| `{ id, type: "list" }`         | `packs` — **never sent by the UI**                              |
| `{ id, type: "map", pack }`    | `map` — **dead**: reads `basemap.json`, which is in no manifest |

## Track persistence

`src/tracks.ts`. `TrackCollection = { version: 1, activeId, tracks }`; `restoreCollection`
parses `version: z.literal(1)` and throws on anything else. `loadTracks` migrates the legacy
`plan` preference into a single track when `ibex-tracks` is absent.

`acceptResult(track, revision, result, packVersion)` accepts **only** on
`track.revision === revision && result.status === "ok"`. It stores `packVersion`, which is
**never read anywhere in `src/`**. Staleness in the UI is purely
`resultRevision !== revision`. Model snapshot, pack identity and data generation are not part
of acceptance today.

## Build pipeline

```
scripts/fetch_osm.py       Overpass → data/osm-profiles-v4.json   (296 MB for 58x55 km)
scripts/build_region.py    → data/build/geneva/{graph.json, basemap.json, manifest.json}
scripts/package_region.ts  → public/packs/geneva/{graph-*.bin, index.bin, attribution.json,
                                                 basemap.pmtiles, manifest.json}
```

`BBOX = [5.80, 45.95, 6.55, 46.45]` is duplicated in `scripts/fetch_osm.py` and
`scripts/prepare_tracks.py`; `build_region.py` imports it from the latter and **clips every
edge to it**, which is what truncates the network at the region edge. `id: "geneva"` and
`name: "Geneva basin"` are hardcoded.

Whole-graph post-passes, with their influence radii (all bounded, which is what makes a
halo-based per-cell build exact):

| Pass                                  | Radius                                                           |
| ------------------------------------- | ---------------------------------------------------------------- |
| `utility` — low-stress reach          | 1,000 m                                                          |
| `junction` — node degree × road class | node-local                                                       |
| `reward` — reverse multi-source decay | `REWARD_TAU * ln(1/REWARD_FLOOR)` = `600 * ln(50)` ≈ **2,347 m** |

Terrain: Mapterhorn Terrarium `https://tiles.mapterhorn.com/12/{x}/{y}.webp` at **zoom 12**
(13.2 m/px at latitude 46), cached in `data/terrain/12-<x>-<y>.webp`, decoded through
`terrain_profile.bilinear_height`. `terrain_samples` currently holds **every** tile as a
decoded RGB image in one dict, which is fine for 30 tiles and not for thousands.

## Measured baseline

| Metric                        | Value                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Geneva bbox                   | 0.75° × 0.5° ≈ 3,216 km²                                                                                                                        |
| `public/packs/geneva`         | 151 files / 65 MB (147 chunks 10 KB–1.24 MB, `index.bin` 190 KB, `basemap.pmtiles` 28.8 MB **unused by the app**)                               |
| Density                       | ≈20.2 KB/km² in gzip-JSON                                                                                                                       |
| `data/build/geneva-v2` counts | 181,920 nodes · 403,744 directed edges · 2,684 restrictions · `terrainCoverage` 0.986 · `excludedWays` 118,930 · `restrictionsOutsideGraph` 226 |
| Baked field                   | 83 × 80 = 6,640 cells; uint8+gzip = 3.4 KB per preset                                                                                           |
| `public/packs/test`           | 4 files / 16 KB synthetic CI fixture, id `synthetic`                                                                                            |

## Test surfaces that constrain changes

- `tests/offline.test.ts` imports `public/packs/test/manifest.json` directly and asserts the
  schema rejects bad `schemaVersion`, stale `costModelVersion`, and the paths `../private`,
  `https://other/file`, `a/b`.
- `tests/e2e/offline.spec.ts` and `tests/e2e/install-failures.spec.ts` select by accessible
  name: the `Data` tab, a button matching `/Save offline/`, and the exact text
  `Region saved offline`. `install-failures.spec.ts` additionally asserts `graphReads === 1`
  after a resumed install, which is the proof that staged files are reused.
- `scripts/test-server.mjs` injects `checksum` and `disconnect` faults against
  `public/packs/test`, keyed on the filenames `graph-test.bin` and `index.bin`.
- `scripts/verify_public_pack.py` probes `bytes=0-126` of `basemap.pmtiles` for the PMTiles
  magic, so dropping that file changes the publication check.
