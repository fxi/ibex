# Building cells

One command, no server, no Python, no osmium. Give it a box and it builds every cell with
roads under it, straight from OpenStreetMap.

```sh
npm run data:build -- --bbox 5.9,46.1,6.5,46.4          # a couple of cells
npm run data:build -- --cells 9-264-181,9-265-181       # named cells
npm run data:build -- --bbox -11,35,32,72 --dry-run     # what Europe would cost
```

Output lands in `.cache/cells`, which is what `npm run dev` serves and what
`npm run data:publish` uploads. Nothing is written inside the repo.

## What it does

```
1. fetch Geofabrik's index-v1.json (cached a week)
2. per cell, work out which downloads cover its box + 5 km halo
3. per download, largest first:
     fetch it if it is not already in .cache/extracts
     read it once, tag-filtered
     cut every waiting cell out of it
     build and pack each cell whose downloads have all been read
4. rewrite catalog.json, keeping cells this run did not touch
```

Work is **download-major**, not cell-major. Parsing a country takes about as long as
building forty cells out of it, so each file is read exactly once and every cell waiting on
it is cut as it passes. Reading per cell instead would have re-parsed Switzerland eight
times for eight Swiss cells.

## Which downloads a cell needs

Decided by sampling the cell's whole box, not one point, and taking **every** usable extract
that answers — not the best one.

That matters more than it sounds. Geofabrik buffers each polygon past its administrative
boundary, so a point in Geneva reads as inside Rhône-Alpes as well as inside Switzerland.
Picking the smallest match gives you France alone, and the Geneva cell comes out with no
Geneva in it. That exact failure has been published once already.

Two kinds of extract are never chosen:

- a **parent** (`france`, `europe`) — its children tile it, and reading 28 GB of continent
  to build one cell is not a plan;
- a **cross-border convenience** extract (`alps`, `dach`, `britain-and-ireland`) — it
  overlaps the countries under it and would be read twice over. Geofabrik marks these by
  sitting directly under a continent with no ISO country code, which is exactly what a real
  country has. Note that the code is published as an array (`["CH"]`); reading it as a
  string classifies Switzerland as a convenience extract and loses Geneva again.

A cell no download claims is open sea and is never built. A cell that builds to no edges —
desert, ice, moorland — is not published either.

## Halo, and why a cell stands alone

Every cell is built from its own bounds grown by 5 km. The three bounded passes need it:
utility reaches 1 km, reward 600·ln(50) ≈ 2,347 m, junction is node-local. Over cell plus
halo each one sees every neighbour that could influence an edge the cell owns, so the answer
equals a whole-region run. The halo is trimmed afterwards.

Ways are cut into edges at the cell's own split nodes — a way's endpoints, a barrier, a
restriction's via node, any node two roads share — derived from the extract alone. A cut
made with `complete_ways` semantics holds every road touching a node inside cell + halo,
which is what the rule needs, so no release-wide pre-pass exists or is wanted.

## Terrain

Heights come from Mapterhorn Terrarium z13 tiles, cached in `.cache/terrain`, fetched once
and shared by every cell that needs them. Only nodes a road uses are sampled, which is a
small fraction of what a cell holds. A tile that cannot be fetched leaves its nodes without
a height rather than guessing one, and the cell records its `terrainCoverage`.

Roughly 360 tiles and 35 MB per cell, so the cache is the largest thing a wide build puts
on disk — France alone would be some 15 GB. `--terrain-budget <MB>` drops the least
recently used tiles between downloads; tiles are shared only between adjacent cells, which
the download-major loop builds together, so the refetch cost is close to nothing.

Decoding needs `sharp`. It is a devDependency for a reason: when it fails to resolve, every
tile silently fails and the build comes out flat, so the builder now stops if its first
cell has no terrain at all.

## Cost

Measured on this machine, 2026-09-22.

| | |
|---|---|
| download, ~500 MB extract | ~48 s at 11 MB/s |
| parse it, tag-filtered | ~60 s, ~3 GB heap |
| cut one cell out of it | 0.2–1.3 s |
| build one dense z9 cell | 6–17 s |
| a packed cell | ~14 MB |

The dominant costs are the download and the parse, both **per extract**, so a run over many
cells in one country costs barely more than a run over one.

Memory: a country's node index is the large thing (57 M nodes for Switzerland). Run with
`--max-old-space-size=12000`, which `npm run data:build` already does.

## Publishing

```sh
npm run data:publish -- --setup-bucket    # once: bucket + CORS
npm run data:publish -- --dry-run         # what would go up
npm run data:publish
npm run data:publish -- --verify <VITE_DATA_URL>
```

Layout, cache headers and the verify checks are in [data-format.md](data-format.md). Both
writers share `scripts/s3.ts`, so the key layout and the cache headers cannot drift apart.

A build wider than a handful of cells should publish itself instead:

```sh
npm run data:build -- --regions switzerland,rhone-alpes --publish --skip-built \
  --terrain-budget 4000
```

Each cell goes up as it is packed and then leaves the disk, the catalogue is uploaded after
every download, and `--skip-built` resumes from what the catalogue already has. `publish.ts`
remains the way to send a build that is already on disk, and the only way to run
`--setup-bucket` or `--verify`.

## Verifying a build

Routes are not supposed to move when the builder is refactored, and the gold standards say
whether they got better.

```sh
node --import tsx scripts/build_parity.ts <before> <after>   # expects IDENTICAL
node --import tsx scripts/route_golden.ts --check            # exits 1 on any difference
node --import tsx scripts/gold_route.ts audit voirons-gravel intent .cache/cells
```

Capture the golden baseline **before** editing: `route_golden.ts` overwrites it by default.
