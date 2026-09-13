# scripts/

Run everything from the repo root (`uv run scripts/<name>.py`, `node --import tsx scripts/<name>.ts`).
Outputs go under the gitignored `data/` (see `data/README.md`); nothing here writes to `src/`.
Modules marked **lib** are imported by other scripts: do not rename or move them in isolation.

| Group | Script | Purpose |
|---|---|---|
| Release pipeline | `fetch_extracts.py` | Download + md5-verify Geofabrik extracts (`--prune` after clipping) |
| | `clip_region.py` | Clip, merge, tag-filter → `release.osm.pbf` |
| | `global_splits.py` | Release-wide way-split nodes (required for consistent cell edge ids) |
| | `extract_cells.py` | One pbf per z9 cell plus halo |
| | `build_cells.py` | Parallel, resumable per-cell builds; calls `build_region.py` by path |
| | `build_region.py` | **lib** + per-cell graph builder (see its docstring) |
| | `package_cells.ts` | Cell builds → `catalogue.json` + `.ibx` packs |
| | `fetch_attribution.py`, `fetch_water.py` | Terrain attribution, water layer |
| | `region_config.py` | **lib**: window, halo, zooms, extract list — the only place a bbox is defined |
| | `grid.py`, `osm_source.py`, `profile_features.py`, `terrain_profile.py`, `profile.ts` | **lib** helpers for the builder and audits |
| Publish | `publish_release.py` | Verify a packs dir (default) or upload it (`--publish`, `--configure-cors`) |
| | `verify_release.ts` | Decode every block of a local release and route Marseille→Toulon |
| | `verify_public_release.py` | Verify a live catalogue URL |
| | `download_map_style.py` | Save the MapTiler style as `src/map/custom-style.json` |
| Audit & benchmark | `benchmark.ts`, `ablation.ts` | Corridor vs reference search on a local release's merged packs (argv[2], default `data/build/geneva-toulon/packs`) |
| | `local_release.ts` | **lib**: load a local release through `CellGraphProvider`, as the app does |
| | `audit_route.ts`, `audit_coudry.ts`, `audit_profile_options.ts`, `audit_search_budget.ts`, `audit_signals.ts` | Routing audits → `data/derived/` |
| | `compare_builds.py` | Grid vs pre-grid build regression comparison |
| Fixtures | `create_cell_fixture.ts` | `public/packs/cell-fixture` (CI release) |
| | `gen_grid_fixture.ts`, `gen_grid_vectors.ts` | `public/packs/grid-fixture`, `tests/fixtures/grid-vectors.json` |
| | `gen_coudry_fixture.ts`, `gen_voirons_fixture.ts` | Real-data routing fixtures in `tests/fixtures/` |
| Personal tracks | `prepare_tracks.py`, `match_tracks.py` | Private ride traces → `data/derived/` (never uploaded) |
| Dev & browser tests | `build_browser_tests.ts`, `local-env.ts`, `test-server.mjs` | Isolated browser test build |
| | `smoke-lan.mjs`, `repro-webkit-offline.mjs` | LAN smoke test; WebKit offline repro cited in `VALIDATION.md` |
| Python tests | `test_*.py` | `uv run python -m unittest discover -s scripts -p 'test_*.py'` |

Rules: one-off experiments do not get committed here. If a script is worth keeping, give it
argv inputs (no hardcoded `data/` build paths) and add it to this table.
