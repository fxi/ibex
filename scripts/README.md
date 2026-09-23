# scripts/

Run everything from the repo root (`node --import tsx scripts/<name>.ts`).
Outputs go under the gitignored `.cache/`; nothing here writes to `src/`.
Modules marked **lib** are imported by other scripts: do not rename or move them in isolation.
Scripts that read a local build take its cells directory as an argument, defaulting to
`DEFAULT_CELLS` in `local_cells.ts`.

| Group | Script | Purpose |
|---|---|---|
| Cell pipeline | `build_cells.ts` | **The pipeline.** `--bbox W,S,E,N`, `--regions <geofabrik id,…>` or `--cells`: picks the Geofabrik downloads that cover each cell, parses each one once, cuts every cell it touches, builds and packs them. `--publish` sends each cell to the bucket as it is built (`--keep-local` to keep it on disk too), `--skip-built` resumes, `--terrain-budget <MB>` caps the DEM cache. Also `--dry-run`, `--out`, `--extracts`, `--zoom`, `--no-terrain`, `--keep-extracts`, `--limit`. Run it as `npm run data:build -- --regions …` |
| | `s3.ts` | **lib**: the bucket client, key layout and cache headers both writers share |
| Publish | `publish.ts` | `npm run data:publish`: verify every byte against the catalogue, upload cells one at a time, write `catalog.json` last. `--dry-run`, `--setup-bucket`, `--verify <url>` ([data-format.md](../docs/data-format.md)) |
| Audit & benchmark | `benchmark.ts`, `ablation.ts` | Corridor vs reference search on a local build's merged packs |
| | `benchmark_routing.ts` | Local pack loading and cold/warm queries for all four ride policies; packs directory and optional baseline module are argv inputs |
| | `memory_leg.ts` | Heap of a leg's decoded graph and peak RSS while routing it, Geneva outward from 30 to 100 km, one process per leg; the phone's limit is what it watches |
| | `route_golden.ts` | Golden master of routing output on real packs; `--check` fails on any change (use around engine refactors) |
| | `build_parity.ts` | Diff two cell builds: ids and extents exactly, derived values to a tolerance (use around builder changes) |
| | `gold_route.ts` | **lib** + CLI for gold standards (`tests/fixtures/gold/`): `import` a line drawn in Ibex, `audit` where the router parts from it and why |
| | `local_cells.ts` | **lib**: load a local build through `CellGraphProvider`, as the app does |
| | `audit_route.ts`, `audit_long_route.ts`, `audit_signals.ts` | Routing audits → `.cache/derived/` |
| Fixtures | `create_cell_fixture.ts` | `tests/fixtures/data` (synthetic published tree for CI and browser tests) |
| | `gen_grid_fixture.ts`, `gen_grid_vectors.ts` | `tests/fixtures/grid-fixture`, `tests/fixtures/grid-vectors.json` |
| | `gen_graph_fixture.ts` | Real-data routing fixtures in `tests/fixtures/`: a named region, or `gold/<name>` for the corridor around a gold standard |
| Dev & browser tests | `setup.mjs` | `npm run setup`: install, create `.env`, report missing settings |
| | `data-server.ts`, `local-env.ts` | **lib** for `vite.config.ts`: serve the cells directory with byte ranges; read only this workspace's `.env` |
| | `build_browser_tests.ts`, `test-server.mjs` | Isolated browser test build and its server |
| | `gh-setup.sh` | Copy the deploy secrets and variables from `.env` to the GitHub repository |

Rules: one-off experiments do not get committed here. If a script is worth keeping, give it
argv inputs (no hardcoded `data/` build paths) and add it to this table.
