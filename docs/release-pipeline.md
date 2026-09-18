# Building a release

Six stages, each cached and resumable. Run from the repo root.

```sh
uv run scripts/fetch_extracts.py          # Geofabrik extracts, md5-verified, resumable
uv run scripts/clip_region.py             # merge + clip + tag-filter -> data/pbf/release.osm.pbf
uv run scripts/global_splits.py           # release-wide way-split node set (required)
uv run scripts/extract_cells.py           # one complete pbf per cell, cell + halo
uv run scripts/build_cells.py --jobs 3    # halo-exact graph per cell, parallel, resumable
node --max-old-space-size=8000 --import tsx scripts/package_cells.ts <cells dir> <packs dir>
```

Then serve the result locally, with `VITE_DATA_URL` empty in `.env`:

```sh
npm run data:stage -- <packs dir>   # links it under data/publish/v1/, writes latest.json
npm run dev
```

Publishing to S3 and the versioned layout are described in [data-format.md](data-format.md).

`scripts/region_config.py` is the single definition of the window, halo, and zooms. Nothing
else hardcodes a bbox.

## Geneva–Toulon coverage

The default window is now z9, x 262–266 / y 180–187: 40 cells covering
4.21875–7.734375° E and 43.068888–47.040182° N. It includes the Rhône valley
through Lyon, Valence, Avignon and Arles, and the Alps through Grenoble,
Briançon and Nice, with Marseille and Toulon on the southern edge.
The source extracts include Bourgogne, Auvergne, Provence-Alpes-Côte d’Azur
and Languedoc-Roussillon in addition to the original four extracts.

For an isolated rebuild that preserves the previous build and packs until validation:

```sh
uv run scripts/fetch_extracts.py --directory data/pbf/geneva-toulon
uv run scripts/clip_region.py --directory data/pbf/geneva-toulon --output data/pbf/geneva-toulon/release.osm.pbf
uv run scripts/fetch_extracts.py --directory data/pbf/geneva-toulon --prune   # frees ~2.8 GB
uv run scripts/global_splits.py --input data/pbf/geneva-toulon/release.osm.pbf --output data/derived/geneva-toulon/split-nodes.bin
uv run scripts/extract_cells.py --input data/pbf/geneva-toulon/release.osm.pbf --directory data/pbf/geneva-toulon/cells
uv run scripts/build_cells.py --extracts data/pbf/geneva-toulon/cells --output data/build/geneva-toulon/cells --split-nodes data/derived/geneva-toulon/split-nodes.bin --jobs 3
node --max-old-space-size=8000 --import tsx scripts/package_cells.ts data/build/geneva-toulon/cells data/build/geneva-toulon/packs
uv run scripts/publish_release.py --release data/build/geneva-toulon/packs
node --import tsx scripts/verify_release.ts data/build/geneva-toulon/packs
rm -r data/pbf/geneva-toulon/cells   # once both checks pass
```

Without `--publish`, `publish_release.py --release` only verifies local checksums; `verify_release.ts`
decodes every block and routes Marseille→Toulon across a seam. All neighbouring cells
must be rebuilt together using the new release-wide split nodes; do not combine old
Geneva packs with newly built southern packs. Elevation sampling remains enabled.

## Why each stage exists

**`fetch_extracts.py`** replaces the Overpass query. The enlarged window returns multiple GB
of JSON, past Overpass's `maxsize` and timeout; the eight Geofabrik extracts listed in
`region_config.EXTRACTS` are cached. `--prune` deletes them once `release.osm.pbf` exists.

**`clip_region.py`** merges the extracts _before_ clipping, then applies one `tags-filter`
whose expressions are a direct translation of the old Overpass selection (the mapping is
commented in `FILTERS`). Validated by building the pre-grid Geneva bbox both ways and
diffing: **shared-way length agreed to −0.167% over 36,540 km**, with the residual explained
by four months of OSM edits (57% of the "missing" ways no longer exist in OSM at all).

**`global_splits.py`** is not optional. A way is cut into edges at every "kept" node — a way
endpoint, barrier, restriction via node, or a node shared by more than one road. Derived per
cell that set depends on which ways happen to be in the cell's extract, so a way could split
differently in two adjacent cells and the same physical segment would get two different
deterministic ids, breaking deduplication. Computing it once over the release makes every
cell split identically by construction, independent of halo size. Needs no node locations,
so it is one cheap pass (1,958,248 split nodes over 1.3M road ways).

**`extract_cells.py`** cuts one `complete_ways` pbf per cell, covering the cell **plus a
5 km halo**, in a single pass over the release.

**`build_cells.py`** runs the graph build per cell. The three passes that look global all
have a bounded influence radius — `utility` 1,000 m, `junction` node-local, `reward`
`600 × ln(50)` ≈ 2,347 m — so a 5 km halo yields attributes identical to a whole-region run.
The halo is trimmed only _after_ those passes, and ownership is then decided by the cell
containing an edge's first geometry point: a property of the road, so adjacent cells agree
without consulting each other. Each build reports `haloOvershootKm` and `edgesBeyondHalo`;
a long ferry across Lake Geneva legitimately overshoots (~15 km) and is recorded, not
rejected, because global splits make identity halo-independent.

**`package_cells.ts`** groups each cell's edges into z13 blocks, encodes them, deflates, and
writes `index.ibx` + `graph.ibx` + `manifest.json` per cell plus `catalogue.json` at the
release root. It fails loudly if a cell exceeds 50 MB rather than padding the claim.

## Measured, 2026-09-09 edition

Historic: a 16-cell window, and release ids still carried the `g4-`/`-p5` prefixes that
`package_cells.ts` no longer emits. The current window is 40 cells (`region_config.WINDOW`)
and ids are `<yyyymmdd>-<hash>`.

|          |                                                                           |
| -------- | ------------------------------------------------------------------------- |
| release  | `g4-20260909-p5-20d228e2`                                                 |
| coverage | 16 z9 cells, x 263–266 / y 180–183, 216.7 × 217.2 km                      |
| total    | 154.0 MB — largest cell 15.42 MB, smallest 2.61 MB                        |
| graph    | 3,825,491 directed edges, 1,692,456 nodes                                 |
| density  | ~35 B per directed edge, **2.50× smaller than the gzip-JSON it replaces** |
| terrain  | Mapterhorn Terrarium z13, 6.6 m/px                                        |

The 50 MB cell limit is met with a 3× margin, which is what justifies z9 as the download
zoom. Internal blocks are z13 (~3.4 km, 256 per cell), matching the granularity the router
previously worked at.

## Disk

Peak is ~8 GB: 1.8 GB extracts (prunable) + 251 MB release pbf + 326 MB cell extracts +
~5 GB of per-cell `graph.json` + 1.5 GB terrain cache + 154 MB of packs. Every stage skips
completed work, so a run can be interrupted and resumed.

## Verification

All in Node — the routing core is an API that happens to run client-side:

```sh
npm run test          # 160 tests, ~5 s, includes the real cross-cell route
npm run typecheck && npm run lint
npx playwright test   # UI shell only: install flow, offline restart, tab wiring
```

- `tests/ibex.test.ts` — codec losslessness and every rejection path, on synthetic data.
- `tests/provider.test.ts` — two synthetic adjacent cells with a deliberately
  cross-boundary road: routing across it, node/edge/restriction dedup, block selection,
  caching, foreign release, corrupt block, missing-cell reporting. 40 ms.
- `tests/release.test.ts` — the generated release: catalogue/manifest agreement, byte-range
  tiling, every block's CRC, and the real Geneva → Voirons route across the
  `9-264-181` / `9-265-181` boundary. `skipIf` keeps CI green without the packs; point
  `IBEX_RELEASE` at a packs directory to run it on another release.

## Route segments

Every `RouteResult` carries `segments`: the finished route cut into stretches that are
uniform in how they ride. This is presentation, not cost — the router has already chosen
the line, and the segments are what make that choice inspectable.

- `rideClass` in `src/routing/eligibility.ts` maps an edge plus its traversal mode to one
  of `paved | gravel | rough | walk | ferry`. Mode wins over surface, so a paved way that
  must be pushed reads as `walk`.
- `appendSegments` in `src/routing/engine.ts` runs inside the result loop, which already
  walks the chosen edges and already calls `traversalSegments`. Grade runs need not line up
  with geometry vertices, so each geometry span is classified by the run covering its
  midpoint and consecutive spans of one class are merged. Segments therefore start and end
  on real vertices: `start` and `end` are inclusive indices into `geometry`, consecutive
  segments share a vertex, and their lengths sum to the route distance.
- Nothing in the `.ibex` format changed. `surface`, `highway`, `tags` and `grades` were
  already encoded and decoded; they were simply discarded at the end of the search.
- `src/map/rideStyle.ts` is the single table behind the line colour, the dash overlays and
  the legend, so the map and the key cannot drift apart. Consecutive same-class segments
  merge into one feature before drawing, which avoids a round cap at every join.
- Covered by `tests/segments.test.ts` (classification and the contiguity, coverage and
  length-conservation invariants), `tests/rideStyle.test.ts` (feature merging and the
  generated colour expression) and an assertion in `tests/release.test.ts` that segments
  survive the real codec rather than only synthetic graphs.

## Known gaps

- **Baked preset cost fields are not emitted.** The worker builds the corridor field at
  runtime from the merged graph, which is correct and seam-free because it is one field over
  one graph. Per-cell rasters remain an optimisation: they would avoid decoding blocks
  outside the corridor. The index reserves the section.
- **`ascentM` can be null on routes through terrain gaps.** `completeElevation` goes false
  if any non-ferry edge lacks `grades`. Pre-existing on the pre-grid pack too (terrain
  coverage 0.986); not introduced here.
- **The route worker is recreated per computation**, so the provider's block cache does not
  survive. Making it persistent is what would make the LRU worth having.
- **`readRange` on the IndexedDB backend reads the whole file** before slicing. OPFS is used
  when available; the idb fallback would benefit from caching the buffer.
- **Steepness is carried but not drawn.** `RouteSegment.grade` is populated, and the map
  encodes rideability only. Gradient chevrons would need an SDF sprite build, which is why
  they are not here yet.
- **FIT import is not implemented.** GPX import lands imported rides as display-only
  reference tracks; FIT needs a binary decoder and is deliberately deferred.
