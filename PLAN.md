# Selectable routing packs on a global grid

## Handoff context

This repository is the Cyclatractor application being rebuilt around the Ibex UI. The current product already has the four-tab Ibex-style interface, persistent multi-track editing, model snapshots, explicit route computation, GPX export, and regional pack download support. This plan covers the next phase: replacing the single regional pack with a catalogue of interoperable routing cells.

The main runtime is a Vite/React/TypeScript app. Important existing areas are:

- `src/main.tsx`: application state, tabs, track actions, model configuration, pack download controls, and routing-worker orchestration.
- `src/tracks.ts`: persisted track collection, revisions, model snapshots, result acceptance, and migration from the former single `plan` preference.
- `src/offline/store.ts`: IndexedDB/OPFS pack storage, manifest validation, checksums, resumable installation, removal, and storage checks.
- `src/workers/route.worker.ts`: current single-pack graph loading and corridor/reference routing.
- `src/workers/data.worker.ts`: pack installation and removal worker.
- `scripts/fetch_osm.py`, `scripts/build_region.py`, and `scripts/package_region.ts`: source extraction, graph construction, and pack packaging.
- `public/packs/test`: small checked-in fixture used by browser tests. Generated Geneva artifacts are under ignored `data/build` and `public/packs/geneva` paths.

The current manifest schema is version 1 and describes one pack with an id, version, geographic bbox, cost-model version, attribution, and checksummed files. Current graph chunks are gzip-compressed JSON despite their `.bin` extension; they are a compatibility format and should remain readable while the new format is introduced. The application uses IndexedDB database `cyclatractor-v1`, with OPFS preferred when available.

The map is intentionally online-only for now: MapTiler supplies the visible MapLibre basemap, while routing data and terrain-derived attributes are the offline product. Do not add offline map tiles in this phase.

The existing Geneva source bbox is approximately `[5.80, 45.95, 6.55, 46.45]`. It is too small for the new release because it clips the network at its edges. The new extraction must expand to a complete 200 × 200 km target around Geneva, then snap the published boundary outward to the selected grid-cell boundaries. Keep the source graph cross-border where required by the expanded bbox.

## Summary

Build a catalogue-driven Data tab for downloading pre-generated binary routing packs. Start with approximately **200 × 200 km centred on Geneva**, expanded outward to complete XYZ grid cells.

Keep MapTiler for map rendering. Routes must work offline across adjacent installed packs, including custom models and terrain-based costs.

The implementation should be incremental and keep the app runnable after each phase. First add catalogue and grid data structures behind the existing Data tab, then produce a local Geneva catalogue, then add the new binary format and multi-pack routing. Do not make S3 or a remote service a prerequisite for local development.

## Graph and pack pipeline

- Build a coherent cross-border source graph before partitioning it. Parameterize the current Geneva-only extraction and build boundaries.
- Preserve OSM node identities, directed road segments, elevation profiles, model attributes, and turn restrictions. Retain boundary-crossing edges with deterministic identities; deduplicate shared records when loading adjacent packs.
- Introduce a versioned Ibex binary format inspired by OsmAnd’s indexed routing blocks: compact coordinate encoding, string dictionaries, explicit connectivity, and independently readable spatial blocks. Direct `.obf` support is outside this phase.
- Keep download cells separate from smaller internal graph blocks. Use a **uniform XYZ zoom** for the release: measure encoded packs at zooms 8–12 and choose the coarsest zoom whose largest pack is at most 50 MB. Smaller downloads are acceptable; report measured sizes without padding.
- Give every release a common graph-generation identifier. Prevent routing across incompatible generations.
- New packs contain routing data, embedded terrain attributes, and attribution; omit the currently unused basemap archive.

### Required pack invariants

- A cell id is stable for a given grid definition and must be derived from grid coordinates, not a random identifier.
- Every pack declares the same release/graph-generation id as its neighbouring packs. A pack from another generation cannot participate in a route.
- Node ids and restriction references are globally deterministic within a release. A boundary node must not be recreated with a different id in each adjacent pack.
- A cell may contain internal spatial blocks, but its manifest must identify which blocks cover its bbox and how their byte ranges can be loaded independently.
- Pack installation is atomic from the application’s perspective: incomplete or checksum-invalid data is never listed as installed.

## Catalogue, storage, and Data UI

- Generate a static catalogue containing grid definition, release identifier, cell IDs/bounds, manifest URLs, sizes, and source dates. Resolve relative URLs against the catalogue so the same directory structure can later move to S3.
- Display grid cells in the Data tab with available, selected, downloading, installed, update-available, and failed states. Cells outside published coverage cannot be selected.
- Clicking toggles download selection; deselecting never deletes installed data. Provide separate download and removal actions, selected-size totals, progress, cancellation, and retry.
- Queue downloads sequentially, reuse checksum verification and storage checks, and retain verified staged files for resumption. Expose installed versions only after complete verification.
- Cache the last valid catalogue for offline use. A catalogue failure must not prevent using or removing installed packs.
- Keep existing tracks and models. Retain legacy pack support separately during migration; do not combine legacy and new graph formats in one route.

### Suggested catalogue shape

Use a versioned JSON document alongside the packs. The exact field names may evolve, but it must provide the equivalent of:

```json
{
  "schemaVersion": 1,
  "grid": { "scheme": "xyz", "zoom": 9 },
  "release": "model-4-<source-edition>",
  "cells": [
    {
      "id": "9/264/180",
      "bbox": [5.625, 45.089, 6.328, 45.583],
      "manifest": "packs/9-264-180/manifest.json",
      "bytes": 42123456,
      "available": true
    }
  ]
}
```

The example coordinates are illustrative; derive actual bboxes using standard XYZ/Web Mercator conversions. Catalogue URLs must work both from `public/` during local development and from an S3 prefix later. Store the last valid catalogue in the existing preferences store, with a release and schema check before using it.

## Routing integration

- Replace the single-pack worker input with an installed-pack graph provider. Resolve connections by identity, never by coordinate proximity.
- Load indexed blocks as the search expands, with bounded caching. Adapt semantic-field generation so computing a custom model does not require eagerly decoding every installed pack.
- Distinguish unavailable coverage from a disconnected road network. When a search encounters missing data, identify the affected cells and offer access to their download selection.
- Record the pack versions used by each computed track. Updating or removing those packs marks its result stale.
- Preserve explicit computation, cancellation, model snapshots, and rejection of obsolete worker results.

### Routing API direction

Keep the route worker boundary message-based. Replace the current `{ pack, request }` input with an installed-pack set plus the request, or with a release-scoped pack resolver that can return block bytes. The UI must not read graph files directly.

The graph provider should expose enough information for the worker to:

1. Find cells intersecting the request anchors and expanding search frontier.
2. Load only the required spatial blocks, with an LRU or byte-bounded cache.
3. Merge shared nodes and directed edges by deterministic identity.
4. Report missing cells distinctly from `no-path` and `snap-failed`.

Preserve the current track revision checks: a worker result is accepted only when the active track id, track revision, model snapshot, release id, and pack versions still match the request that started the computation.

## Validation and acceptance

- Verify binary round trips preserve routing attributes, restrictions, geometry, and terrain precision; reject corrupt or incompatible blocks.
- Compare routes on the partitioned graph against the unpartitioned source graph, including border junctions, one-way roads, ferries, restrictions, and roads crossing cell corners.
- Test missing cells, disconnected installed areas, incompatible releases, interrupted downloads, updates, removal, and offline restart.
- Exercise multi-cell road and gravel routes in Chromium and mobile WebKit. Measure pack sizes, decoded memory, and route duration on the generated Geneva dataset.
- Deliver reproducible local build commands, the generated catalogue and packs, and a benchmark report. S3 publication, offline basemap tiles, glyphs, and sprites remain future work.

## Execution order for a future agent

1. Inspect and document the current manifest, graph, and worker message types before changing them. Add focused unit fixtures for grid math and catalogue validation.
2. Implement pure XYZ grid helpers and a catalogue schema. Add a local catalogue fixture and render it in the Data tab without changing routing behavior.
3. Extend the build scripts to generate the expanded Geneva source graph and emit one manifest per cell plus a catalogue. Measure compressed pack sizes at candidate zooms 8–12 and record the selected zoom in the catalogue.
4. Implement the new binary encoder/decoder behind a feature/version gate. Keep the existing test pack and legacy manifest reader working until migration tests pass.
5. Change storage and the data worker to install/list/remove catalogue cells. Add selection, queueing, resume, cancellation, update, and offline-catalogue states to the Data tab.
6. Implement the multi-pack graph provider and worker routing. Start with two adjacent fixture cells containing a deliberately cross-boundary edge, then expand to the generated Geneva cells.
7. Invalidate results when any contributing pack is removed, updated, or belongs to another release. Add missing-coverage diagnostics and download affordances.
8. Run unit tests, build/lint/typecheck, browser tests in Chromium and mobile WebKit, and the generated-region benchmark. Rebuild production assets after test builds.

## Working agreements and non-goals

- Do not silently change the IndexedDB database name or existing preference keys; provide migrations when a schema changes.
- Do not infer connectivity from nearby coordinates. Only explicit shared node/edge identities establish graph connectivity.
- Do not promise every pack is 40–50 MB. Display measured sizes and choose a uniform grid based on the largest generated cell.
- Do not publish to S3, modify production credentials, or add global basemap tiles as part of this phase.
- Keep changes small enough that another agent can test each phase independently. Update this plan if the measured graph size or browser storage limits force a different grid zoom.
