# scripts/

Run everything from the repo root (`uv run scripts/<name>.py`, `node --import tsx scripts/<name>.ts`).
Outputs go under the gitignored `data/`; nothing here writes to `src/`.
Modules marked **lib** are imported by other scripts: do not rename or move them in isolation.
Scripts that read a local release take its packs directory as an argument, defaulting to
`DEFAULT_RELEASE` in `local_release.ts`.

| Group | Script | Purpose |
|---|---|---|
| Cell pipeline | `build_cells.ts` | **The pipeline.** `--bbox W,S,E,N` or `--cells`: picks the Geofabrik downloads that cover each cell, parses each one once, cuts every cell it touches, builds and packs them. `--dry-run`, `--out`, `--extracts`, `--zoom`, `--no-terrain`, `--keep-extracts`, `--limit`. Run it as `npm run data:build -- --bbox …` |
| Superseded by it | `fetch_extracts.py` | Download + md5-verify Geofabrik extracts (`--prune` after clipping) |
| | `clip_region.py` | Clip, merge, tag-filter → `release.osm.pbf` |
| | `global_splits.py` | Release-wide way-split nodes (required for consistent cell edge ids) |
| | `extract_cells.py` | One pbf per z9 cell plus halo |
| | `build_cells.py` | Parallel, resumable per-cell builds; calls `build_region.py` by path |
| | `build_region.py` | **lib** + per-cell graph builder (see its docstring) |
| | `package_cells.ts` | Cell builds → `catalogue.json` + `.ibx` packs at the current `DATA_VERSION`; refuses an incomplete window unless `--partial` |
| | `cost_model_version.py` | **lib**: reads `COST_MODEL_VERSION` from `src/routing/types.ts` |
| | `fetch_attribution.py`, `fetch_water.py` | Terrain attribution, water layer |
| | `region_config.py` | **lib**: window, halo, zooms, extract list — the only place a bbox is defined |
| | `grid.py`, `osm_source.py`, `profile_features.py`, `terrain_profile.py`, `profile.ts` | **lib** helpers for the builder and audits |
| Publish | `publish_release.py` | Verify a packs dir; `--publish`, `--promote`, `--promote-id`, `--prune` (lists unless `--yes`), `--create-bucket` on S3 ([data-format.md](../docs/data-format.md)) |
| | `data_version.py` | **lib**: reads `DATA_VERSION` from `src/offline/version.ts` so Python keeps no copy |
| | `verify_release.ts` | Decode every block of a local release and route Marseille→Toulon |
| | `verify_public_release.py` | Verify published data from its root URL: pointer, hashes, cache headers, CORS, Range |
| | `stage_release.ts` | `npm run data:stage`: link a local release under `data/publish/` for the dev server |
| | `download_map_style.py` | Save the MapTiler style as `src/map/custom-style.json` |
| Audit & benchmark | `benchmark.ts`, `ablation.ts` | Corridor vs reference search on a local release's merged packs |
| | `benchmark_routing.ts` | Local pack loading and cold/warm queries for all four ride policies; packs directory and optional baseline module are argv inputs |
| | `route_golden.ts` | Golden master of routing output on real packs; `--check` fails on any change (use around engine refactors) |
| | `build_parity.ts` | Diff two cell builds: ids and extents exactly, derived values to a tolerance (use around builder changes) |
| | `build_cell.ts` | Build one cell's graph from an extract already on disk; `--cell`, `--no-terrain`, `--terrain-cache`. `build_cells.ts` is the one to reach for |
| | `gold_route.ts` | **lib** + CLI for gold standards (`tests/fixtures/gold/`): `import` a line drawn in Ibex, `audit` where the router parts from it and why |
| | `local_release.ts` | **lib**: load a local release through `CellGraphProvider`, as the app does |
| | `audit_route.ts`, `audit_long_route.ts`, `audit_signals.ts` | Routing audits → `data/derived/` |
| Fixtures | `create_cell_fixture.ts` | `tests/fixtures/data` (synthetic published tree for CI and browser tests) |
| | `gen_grid_fixture.ts`, `gen_grid_vectors.ts` | `tests/fixtures/grid-fixture`, `tests/fixtures/grid-vectors.json` |
| | `gen_graph_fixture.ts` | Real-data routing fixtures in `tests/fixtures/`: a named region, or `gold/<name>` for the corridor around a gold standard |
| Personal tracks | `prepare_tracks.py`, `match_tracks.py` | Private ride traces → `data/derived/` (never uploaded) |
| Dev & browser tests | `setup.mjs` | `npm run setup`: install, create `.env`, report missing settings |
| | `data-server.ts`, `local-env.ts` | **lib** for `vite.config.ts`: serve `data/publish/` with byte ranges; read only this workspace's `.env` |
| | `build_browser_tests.ts`, `test-server.mjs` | Isolated browser test build and its server |
| | `gh-setup.sh` | Copy the deploy secrets and variables from `.env` to the GitHub repository |
| Python tests | `test_*.py` | `uv run python -m unittest discover -s scripts -p 'test_*.py'` |

Rules: one-off experiments do not get committed here. If a script is worth keeping, give it
argv inputs (no hardcoded `data/` build paths) and add it to this table.
