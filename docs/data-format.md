# Published data: layout, versioning, hosting

The app downloads routing data as grid cells from a static tree. The same tree is served
from S3 in production, from `data/publish/` by `npm run dev`, and from
`tests/fixtures/data/` in browser tests. Building the cells is covered in
[release-pipeline.md](release-pipeline.md).

## Layout

```
<data root>/                                   VITE_DATA_URL points here
  v1/                                          one directory per DATA_VERSION
    latest.json                                mutable pointer to the current release
    releases/
      20260914-a3540b2d/                       <OSM edition>-<hash of inputs>, immutable
        catalogue.json
        9-262-180/
          manifest.json
          index.ibx                            64-byte header + block directory
          graph.ibx                            deflated z13 blocks, read by byte range
        9-262-181/ ...
```

The app reads `${VITE_DATA_URL}/v${DATA_VERSION}/latest.json` (`pointerURL` in
`src/offline/catalogue.ts`). It follows the pointer to the catalogue and resolves each cell
manifest relative to the catalogue. Nothing else in the tree is mutable, so apart from the
pointer everything can be cached forever.

## Versioning

There is one compatibility number, `DATA_VERSION` in `src/offline/version.ts`. It appears
in `latest.json`, `catalogue.json`, every `manifest.json`, and the header of every
`index.ibx` and block.

**Bump it** for any change an existing app cannot read correctly:

- a required field added, removed or reinterpreted in the pointer, catalogue or manifest;
- any change to the `.ibx` binary layout or its scales;
- a change to what a stored value means to the cost model (for example, a signal's scale).

**Don't bump it** for additive, optional fields that older readers ignore, or for a new
release built with the same format. A new release is a new directory plus a pointer update.

What a bump does:

- The new data publishes under `v<N+1>/`. Apps already deployed keep reading `v<N>/`
  until they update, so the old tree stays until those clients have moved on.
- On start-up, the app removes installed cells whose manifest fails `cellManifestSchema`,
  which includes any other data version, and tells the user to download again.
- Checklist: bump `DATA_VERSION` in `src/offline/version.ts` — the only place it is
  written; the Python scripts read it through `scripts/data_version.py` — regenerate the
  fixtures (`scripts/create_cell_fixture.ts`, `scripts/gen_grid_fixture.ts`), repackage,
  publish and promote under the new directory.
- The old tree is not touched by a later `--prune`, because `--data-version` defaults to
  the current value. Deleting `v<N>/` once its clients are gone takes an explicit
  `--data-version <N> --prune <keep> --yes`.

The release id is `<yyyymmdd>-<hash>`, where the hash covers `DATA_VERSION`, the cost model
version, the preprocessor version, and every cell's source digest and terrain provenance
(source and coverage). Changing any of them produces a new id, so an existing release is
never overwritten — including by a rebuild whose DEM tiles failed, which carries different
grades from the same OSM input.

Packaging refuses a build that is missing any cell of its window, comparing what it finds
against the `window.json` that `build_cells.py` writes beside the cells. A deliberate subset
is packaged with `--partial`, which is never a release.

Profiles (`format_version`) and the saved track collection (`version`) are versioned
separately, because they live in the user's browser rather than in the data tree.

## Documents

`latest.json`

```json
{
  "dataVersion": 1,
  "release": "20260914-a3540b2d",
  "catalogue": "releases/20260914-a3540b2d/catalogue.json",
  "published": "2026-09-17T12:00:00+00:00"
}
```

`catalogue.json`: `dataVersion`, `release`, `grid` (`scheme: "xyz"`, `zoom` 9,
`blockZoom` 13, `fieldZoom` 15), `osmTimestamp`, `generated`, `attribution`, and
`cells[]` (`id`, `x`, `y`, `bbox`, `manifest`, `version`, `bytes`, `available`, and
optionally `nodes` and `edges`). Cell ids and bboxes are checked against the grid when
parsed. Schema: `catalogueSchema`.

`manifest.json`: `dataVersion`, `id`, `name`, `version`, `release`, `cell`, `bbox`,
`osmTimestamp`, `terrainCoverage`, `attribution`, `blockZoom`, `blocks`, and `files[]`
(`path`, `bytes`, `sha256`). Downloads are verified against these sizes and digests.
Schema: `cellManifestSchema` in `src/offline/store.ts`.

The `.ibx` binary layout is defined in `src/offline/ibex/spec.ts`, `index.ts` and
`block.ts`.

## Hosting requirements

| Object                         | `Cache-Control`                       |
| ------------------------------ | ------------------------------------- |
| `v<N>/latest.json`             | `public, max-age=300, must-revalidate` |
| everything under `releases/`   | `public, max-age=31536000, immutable` |

- Public `GET` and `HEAD`.
- `Range` requests answered with `206`: the router reads `graph.ibx` blocks by range.
- CORS: `GET, HEAD` from the app origin (the publisher sets `*`), allowing the `Range`,
  `If-Match` and `If-None-Match` request headers and exposing `ETag`, `Content-Length`
  and `Content-Range`.

`scripts/publish_release.py` sets all of this. `scripts/verify_public_release.py` checks it.

## Publishing

Configure the S3 block of `.env` (see `.env.example`), then:

```sh
# Verify a local release (no network)
uv run scripts/publish_release.py --release data/build/<edition>/packs

# One-time setup: bucket and CORS
uv run scripts/publish_release.py --create-bucket

# Upload (skips objects already present), then make it current
uv run scripts/publish_release.py --release data/build/<edition>/packs --publish --promote

# Check what clients will see
uv run scripts/verify_public_release.py "$VITE_DATA_URL"

# Later: repoint to an uploaded release, or drop old releases (the current one is kept)
uv run scripts/publish_release.py --promote-id 20260914-a3540b2d
uv run scripts/publish_release.py --prune 3
```

Uploads are ordered so that each cell's data files come before its manifest and the
catalogue comes last, and the pointer moves only after the catalogue exists. A client
therefore never sees a pointer to something incomplete. `--promote-id`, `--prune` and
verification also run from GitHub Actions (`.github/workflows/data.yml`). Building the
cells doesn't: it needs about 8 GB of disk and hours of CPU.

## Local data

```sh
npm run data:stage -- data/build/<edition>/packs   # links into data/publish/v1/releases/
```

With `VITE_DATA_URL` empty, `npm run dev` and `npm run preview` serve `data/publish/` at
`/ibex/data/` (`scripts/data-server.ts`), with byte ranges. Staged data is never copied
into `dist/`.
