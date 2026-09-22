# Published data: layout, versioning, hosting

The app downloads routing data as grid cells from a static tree. The same tree is served
from S3 in production, from `.cache/cells` by `npm run dev`, and from `tests/fixtures/data/`
in browser tests. Building the cells is covered in [data-pipeline.md](data-pipeline.md).

## Layout

```
<data root>/                             VITE_DATA_URL points here
  catalog.json                           every cell that exists; the only thing that changes
  cells/
    9-264-181/
      a1b2c3d4e5f60718.index.ibx         64-byte header + block directory
      a1b2c3d4e5f60718.graph.ibx         deflated z13 blocks, read by byte range
    9-265-181/
      9f8e7d6c5b4a3210.index.ibx
      9f8e7d6c5b4a3210.graph.ibx
```

Two objects per cell and one catalogue. There is no pointer, no release directory, no
edition and no version segment in any path.

**Files are named after their content.** A cell's `hash` is the digest of the two files it
holds, and it prefixes both of them. So a published object never changes: a rebuilt cell is
written beside the old one under a new name, a client mid-download is never served different
bytes, and every `.ibx` can be cached forever. Old objects become unreferenced once the
catalogue moves on, and can be deleted whenever.

## The catalogue

```jsonc
{
  "dataVersion": 1,
  "generated": "2026-09-22T09:35:51.958Z",
  "grid": { "scheme": "xyz", "zoom": 9, "blockZoom": 13, "fieldZoom": 15 },
  "attribution": "© OpenStreetMap contributors · ODbL 1.0 | Terrain: Mapterhorn",
  "cells": [
    {
      "id": "9-264-181", "x": 264, "y": 181,
      "bbox": [5.625, 46.0732306, 6.328125, 46.5588603],
      "hash": "a1b2c3d4e5f60718",
      "builtAt": "2026-09-22T09:34:27.007Z",
      "osm": "2026-09-22T07:56:00Z",
      "bytes": 13871104, "blocks": 255, "terrainCoverage": 1,
      "files": [
        { "path": "index.ibx", "bytes": 287104, "sha256": "…" },
        { "path": "graph.ibx", "bytes": 13584000, "sha256": "…" }
      ],
      "nodes": 157311, "edges": 345725
    }
  ]
}
```

`files[].path` is the name a file keeps **once installed**, not the name it is served under
— the published object carries the hash in front of it. `cellFileURL` in
`src/offline/catalogue.ts` is the one place that knows this.

Cell ids are derived from the grid, never assigned, and re-checked against it at parse time:
a silent change to the grid shows up as a bbox mismatch rather than as mis-stitched routes.

An **empty** `cells` array is valid. The grid covers the world from the first run; the
catalogue starts with nothing in it.

## The grid

Plain Web-Mercator XYZ, global, `-85.0511…` to `85.0511…` and `-180` to `180`. Cells are
zoom 9 — about 54 km a side at mid latitudes. The map draws the grid for its own viewport
above zoom 5, colouring each cell by state; a cell with no catalogue entry is drawn greyed
out, because nobody has built it yet.

The cell zoom is only the **download and build** unit. Inside a cell, edges are grouped into
zoom-13 blocks (about 3.4 km), each addressable by the byte range the index records, and the
router reads only the blocks its search area touches. That is the granularity routing
actually runs at.

## Versions

Two numbers, both in `src/offline/version.ts`, and neither appears in a path.

| | |
|---|---|
| `DATA_VERSION` | The **format**. Bump it when an existing reader cannot read the new bytes: the catalogue schema, the `.ibx` layout, what a stored value means. Cells carrying another value are removed at start-up. |
| `BUILD_VERSION` | The **generation**, written into every `.ibx` header as a tag. Bump it when a cell built by the old builder would disagree with one built by the new: the cost model, the tag rules, the split rule. A pack from another generation is skipped by the provider, not fatal. |

`BUILD_VERSION` is what replaced the release id. A release pinned every cell to one
publishing run, so a cell downloaded on Tuesday refused to route beside one downloaded on
Wednesday — untenable when cells arrive one at a time, forever.

**Staleness is per cell**: the catalogue offers a different `hash` than the one installed.
Nothing else is consulted.

### Bumping `DATA_VERSION`

1. Change it in `src/offline/version.ts`.
2. Regenerate the fixtures: `node --import tsx scripts/create_cell_fixture.ts` and
   `node --import tsx scripts/gen_grid_fixture.ts`.
3. Rebuild cells (`npm run data:build`) — old ones cannot be re-read.
4. `npm test && npm run build:test && npm run test:e2e`.

## Cache headers

| Object | `Cache-Control` |
|---|---|
| `cells/**/*.ibx` | `public, max-age=31536000, immutable` |
| `catalog.json` | `public, max-age=300, must-revalidate` |

The catalogue is also fetched with `cache: "no-cache"` by the app, so a cell published a
minute ago is visible now.

CORS must allow `GET`/`HEAD` from any origin, accept a `Range` request header, and expose
`ETag`, `Content-Length`, `Content-Range` and `Accept-Ranges`. `npm run data:publish --
--setup-bucket` sets exactly that.

## Publishing

`scripts/publish.ts` verifies every byte against the catalogue locally before anything is
sent, uploads the cells, and writes `catalog.json` **last** — so the catalogue never names a
file that is not there, and an interrupted run leaves unreferenced objects rather than a
broken tree. An object whose name matches is skipped, because a name is a digest.

`--verify <url>` reads the published tree back the way the app does: the catalogue parses
and is not immutable, every file matches its size and digest, `.ibx` objects are cacheable
forever, CORS answers, and a range read returns `206` with the right `Content-Range` **and
the right bytes**.
