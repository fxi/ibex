# Ibex

Choose the territory. Find your way.

Ibex is an offline-capable cycling route planner that runs entirely in the browser. You download the map areas you ride in, and routing happens on your device against your own routing profile: no route or waypoint ever leaves it. The published data covers Geneva to Toulon, including the Rhône valley and the French Alps; the map itself can be browsed worldwide.

Live at **https://fxi.io/ibex/**.

- **Tracks:** create, duplicate and hide tracks, each with its own routing profile. Edit numbered waypoints on the map, undo edits, and export GPX. Imported GPX rides become reference tracks.
- **Data:** select zoom-9 grid cells, check their size, resume interrupted downloads, refresh or remove them. Routes cross freely between installed neighbouring cells.
- **Tools:** compute the active track explicitly; editing marks the previous result stale.
- **Configure:** pick or edit a profile with forms or raw JSON, and show routing diagnostics.

## Quick start

Requires Node 22.13+ and npm.

```sh
git clone https://github.com/fxi/ibex.git && cd ibex
npm run setup     # npm ci, creates .env from .env.example, reports what is missing
npm run dev       # http://localhost:5173/ibex/
```

`.env.example` points `VITE_DATA_URL` at the public data, so a fresh clone can download areas and route right away. Set `VITE_MAPTILER_API_KEY` (free at [MapTiler](https://cloud.maptiler.com)) for the basemap and place search; without it the map shows a status message and routing still works. Only this workspace's `.env` is read for the key: an ambient environment variable is never embedded.

In **Data**, save an area; in **Tracks**, add a track and place two waypoints on the **Edit** tab; then use **Tools → Compute current track**.

To test the service worker and offline mode, use a production build: `npm run build && npm run preview`. HTTPS is required to reopen the app offline on an iPhone; plain LAN HTTP still installs data and routes while the page is open.

## How data works

Routing data is not bundled with the app. It is a static tree of grid cells, each holding a `manifest.json`, an `index.ibx` block directory and a `graph.ibx` of deflated binary blocks that the router reads by byte range. A `v1/latest.json` pointer names the current immutable release, so new data ships without redeploying the app, and a breaking format change moves to `v2/` without breaking deployed clients. See **[docs/data-format.md](docs/data-format.md)** for the layout, the single `DATA_VERSION` rule, cache headers and publishing.

In the browser, downloads are staged and checksum-verified before the installed record changes. OPFS is preferred, with IndexedDB as the fallback (database `ibex`). Graph blocks are decoded in a worker with a 32 MB allocation cap per block. Cells installed under another data version are removed on start-up.

Building data from OpenStreetMap needs `uv`, `osmium-tool` and about 8 GB of disk. See **[docs/release-pipeline.md](docs/release-pipeline.md)**:

```sh
uv sync --locked
# fetch_extracts → clip_region → global_splits → extract_cells → build_cells → package_cells
npm run data:stage -- <packs dir>   # serve it locally: leave VITE_DATA_URL empty
```

## Deploy your own

The app deploys to GitHub Pages at `/<repository name>/`; the data goes to any S3-compatible bucket.

1. Build and verify a release locally, fill in the S3 block of `.env`, then publish and promote it:
   ```sh
   uv run scripts/publish_release.py --create-bucket     # once: bucket + CORS
   uv run scripts/publish_release.py --release <packs dir> --publish --promote
   uv run scripts/verify_public_release.py <VITE_DATA_URL>
   ```
2. Configure the repository: `scripts/gh-setup.sh` copies the named secrets and variables from `.env` with `gh`. Then enable Pages with source **GitHub Actions**.
3. Push to `main`. [`deploy.yml`](.github/workflows/deploy.yml) runs all checks, builds with `BASE_PATH=/<repo>/` and deploys. It is skipped until `VITE_DATA_URL` is set, so a fork without data stays green.

| Workflow      | Trigger                      | Does                                                                   |
| ------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `ci.yml`      | pull requests, branch pushes | lint, typecheck, unit, Python, browser tests                           |
| `deploy.yml`  | push to `main`, manual       | the checks above, then build and publish to Pages                      |
| `data.yml`    | manual, weekly               | promote or prune releases; verify hashes, cache, CORS and Range on S3  |
| `release.yml` | tag `v*`                     | GitHub release with generated notes (tag must match `package.json`)    |

| Name                                                  | Kind     | Used by              |
| ----------------------------------------------------- | -------- | -------------------- |
| `VITE_MAPTILER_API_KEY`                               | secret   | deploy               |
| `S3_ENDPOINT`, `S3_KEY`, `S3_SECRET`, `S3_BUCKET`     | secrets  | data                 |
| `VITE_DATA_URL`                                       | variable | deploy, data         |
| `VITE_HEATMAP_URL`, `S3_PREFIX`, `S3_PUBLIC_URL`, `APP_ORIGIN` | variables | deploy, data |

The MapTiler key ends up in the public bundle: restrict it to your origins in the MapTiler dashboard. Give CI an S3 key limited to the data bucket.

## Checks

```sh
npm run lint && npm run typecheck && npm test
uv run ruff check scripts
uv run python -m unittest discover -s scripts -p 'test_*.py'
npm run build:test && npx playwright install chromium webkit && npm run test:e2e
```

`npm run build:test` builds an isolated checkout with a dummy key and the synthetic single-cell release in `tests/fixtures/data`, which is explicitly test data, not a real network. Browser tests intercept MapTiler, then cover Chromium and mobile WebKit: LAN HTTP, interrupted downloads, checksum rejection, offline restart, routing and GPX export. Regenerate the fixture with `node --import tsx scripts/create_cell_fixture.ts` after a format change. `tests/release.test.ts` also runs on a real local release when one exists (`IBEX_RELEASE=<packs dir>`).

## Routing

A profile is a complete, self-contained file: bike, rider, whole-ride settings, way preferences with uphill and downhill overrides, and permissions. See [the profile guide](profiles/README.md). Every `profiles/*.profile.json` ships with the app.

Normal routing runs one A* search per leg over the graph merged from installed cells. Turn restrictions, urban turns, riding transitions and ferry boarding stay in the final search. Costs are additive: scenery can discount distance but never traffic or capability penalties. Legal access excludes a connection; difficult terrain and refused pushing remain expensive last resorts. Snapping requires a suitable connection within 250 m. See [the routing refactor](docs/routing-refactor.md).

For audits, `node --import tsx scripts/audit_route.ts [packs dir]` writes selected ways, grades and costs under `data/derived/routing-audit/`. The checked-in Voirons and Coudry fixtures exercise real detours in `npm test`. Every script is listed in [scripts/README.md](scripts/README.md).

## Privacy

The app never uploads waypoints, routes or profiles. The optional "your rides" overlay (`VITE_HEATMAP_URL`) requests tiles from a public PMTiles archive and sends no route geometry. Personal activity traces used for calibration stay under the ignored `data/` directory and are never published.

## Limits

- Desktop and emulated browser checks can't certify iPhone memory, battery or storage retention; test on a real device.
- Profiles can allow pushing, stairs and ferries. Ferry timetables and time-dependent access aren't evaluated, and ambiguous conditional restrictions are excluded conservatively. `no-path` means no path in this model, not proof that cycling is impossible.
- Terrain is sampled from Mapterhorn with bilinear interpolation along complete OSM ways. Bridges and tunnels get no ground elevation. Missing elevation stays unknown and adds a conservative slope surcharge, and GPX exports never invent heights.
- Network utility is a bounded 1 km low-stress reach metric, not a learned preference. Surface, stress and uncertainty coefficients are experimental.

## License and attribution

The code is under the [MIT License](LICENCE). Routing data derived from OpenStreetMap is © OpenStreetMap contributors, available under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Terrain: [Mapterhorn](https://mapterhorn.com/attribution/). Basemap: © MapTiler © OpenStreetMap contributors.
