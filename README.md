# Ibex

The successor to Ibex, built on Cyclatractor’s local routing engine. A full-screen map and four-tab planner support independent cycling tracks, selectable offline map areas, and editable routing models. The first release focuses on the Geneva basin; the map can be browsed worldwide.

- **Tracks:** create or duplicate tracks, assign independent models, edit numbered waypoints, show/hide routes, and export GPX. Each draft is saved locally. Use the row’s menu for track actions and **Edit track** for waypoints, color, attractions, elevation, and diagnostics.
- **Data:** select the zoom-9 map areas you need, inspect coverage and download size, resume interrupted downloads, or remove installed data. Each area is an independently downloadable cell; routes cross freely between installed neighbours.
- **Tools:** explicitly compute the active track. Edits mark its previous result stale; GPX export becomes available again after successful computation. The floating refresh button performs the same action.
- **Configure:** choose a model for the active track, or edit a custom model using forms and advanced JSON. Other tracks retain their model snapshots. Empty form fields inherit defaults; advanced JSON preserves all cost parameters.

The bottom panel can collapse or expand. Search and location controls move the map without adding waypoints. The previous Cyclatractor draft migrates once into the track collection; installed packs and custom profiles are retained. Importing the original Ibex app’s stored tracks is deferred. The deployment URL and IndexedDB namespace remain unchanged.

A semantic field selects a search corridor; an OSM topology graph determines the actual route. The application compares that result with full-region Dijkstra using the same costs.

## Run locally

Requires Node 22.13+ (or Node 24) and npm. The default app uses `public/packs/geneva-grid/catalogue.json`, the locally rebuilt Geneva cell release. Generate it with the commands below, or set `VITE_CATALOGUE_URL` to a compatible cost-model-4 catalogue. Older model-1/2/3 packs and pre-grid region packs are intentionally rejected and removed on start-up.

```sh
npm ci
npm run dev
```

The map always uses the bundled `src/map/custom-style.json`. Copy `.env.example` to `.env` and set `VITE_MAPTILER_API_KEY` there for online MapTiler tiles, fonts, and sprites. Vite and the manual style downloader read only this workspace’s `.env`; ambient MapTiler variables, ancestor files, other dotenv files, and secret-reference expansion are not used. A missing key or resource failure displays a map status message and never selects another style. The key is a browser resource credential embedded at build time.

To rebuild the data locally, also install `uv` and `tippecanoe`:

```sh
uv sync --locked
uv run scripts/fetch_extracts.py
uv run scripts/clip_region.py
uv run scripts/global_splits.py
uv run scripts/extract_cells.py
uv run scripts/build_cells.py --jobs 3
uv run scripts/fetch_attribution.py
uv run scripts/fetch_water.py
node --max-old-space-size=8000 --import tsx scripts/package_cells.ts
npm run dev
```

Open `http://localhost:5173/cyclatractor/`. Save the map areas you need in **Data**, select an example or place at least two waypoints in **Tracks**, then use **Tools → Compute current track**. Open **Edit track → Inside the route** to compare results. Drag markers to move waypoints. The historical ride overlay is optional and online-only.

For service-worker/offline testing:

```sh
npm run build
npm run preview -- --port 4173
```

Open `http://localhost:4173/cyclatractor/`, save a map area, then reload offline. The development server intentionally does not install the production service worker. LAN HTTP supports the map, installation in IndexedDB, checksum verification through a JavaScript SHA-256 fallback, and local routing while the application is open. HTTPS is required for service-worker registration and reopening the application offline on an iPhone.

## Data and privacy

Original and derived personal tracks remain under ignored `data/`. The application never uploads waypoints or routes. Enabling the historical overlay requests tiles from the existing public PMTiles archive; it does not send route geometry to that archive.

```sh
uv run scripts/prepare_tracks.py
uv run scripts/match_tracks.py --limit 80
node --import tsx scripts/benchmark.ts
```

Use `--limit 0` to audit every prepared portion. Matching reports distinguish spatial confidence from restriction-aware sequence validity. Repeated/overlapping portions and portions of the same activity share a calibration/evaluation group. `Ride` is unspecified cycling; it is not automatically a road-bike label. Personalization is disabled in this baseline.

The cached OSM response, its hash and timestamp make the build reproducible. Use a new output path to request another snapshot; the fetcher rejects caches created by older queries. If the upstream data is older than a cached base, run `uv run scripts/merge_osm_profiles.py` and build from `data/osm-profiles-v4-merged.json` to retain newer roads. Terrain tiles and upstream attribution are cached under `data/terrain`. Graph tiles retain stable OSM node IDs; nearby geometry is never treated as connectivity.

## Pack format and storage

Each cell directory holds `manifest.json`, `index.ibx` and `graph.ibx`. The manifest declares schema/model versions, the cell coordinates, coverage, source date, byte lengths and SHA-256 checksums. `index.ibx` is a 64-byte binary header plus a JSON directory of independently readable z13 blocks; `graph.ibx` holds those blocks, deflate-compressed, which the router reads by byte range rather than in full. Routing and GPX export work offline after installation; the bundled custom style needs online MapTiler resources to render its map.

Downloads are staged and verified before the installed record changes. Interrupted downloads resume at completed file boundaries. Cancel removes the current staging data. OPFS is preferred; IndexedDB is the capability fallback. Browser persistence is requested but can be denied. Removing browser site data removes installed packs. Storage is namespaced but shares the `fxi.io` origin quota with other applications.

Graph chunks are decoded in a worker with a 32 MB per-chunk allocation cap. The worker loads the graph once to build a field for the selected profile, then reuses it for corridor expansion and the full-graph comparison. A new request terminates the old worker, and generation IDs prevent stale output. Both searches use the graph merged from the installed cells.

## Publish

Copy `.env.example` settings into the ignored `.env`. Only `VITE_*` settings enter the browser bundle. Set `VITE_MAPTILER_API_KEY` in `.env` to use the custom MapTiler style `01984598-44d5-70a4-b028-6ce2d6f3027a` online. Restart Vite after changing `.env`. Vite embeds this browser API key in the client bundle; S3 credentials remain confined to Python scripts. The local PMTiles style is used without a key, offline, or if MapTiler fails. Route overlays remain available on both styles.

Run `uv run scripts/download_map_style.py` to save a credential-free copy as `src/map/custom-style.json`. Vite embeds that downloaded style when present and injects the configured key into its resource URLs; otherwise it loads the custom style directly from MapTiler. Downloading the style JSON does not download its tiles, sprites or fonts, so the custom basemap still requires connectivity.

```sh
uv run scripts/publish_release.py
uv run scripts/publish_release.py --publish
```

The first command verifies and previews the publication: it walks `catalogue.json`, checks every cell manifest against the catalogue release and version, and verifies the size and SHA-256 of every `.ibx` file. The second uploads only catalogue-listed public artifacts, never personal traces, to `cyclatractor/packs/<release>/`. Configure `VITE_CATALOGUE_URL` with the public immutable catalogue URL. S3 needs public GET/HEAD, byte ranges, and CORS for the app origin. Credentials are used only by the publisher. Verify a live release with `uv run scripts/verify_public_release.py <catalogue-url>`.

GitHub Pages deployment is a manual workflow and requires a configured repository and Pages environment. The repository currently has no Git remote configured. Set repository variable `VITE_CATALOGUE_URL` before publishing. The app base and service-worker scope are `/cyclatractor/`.

## Checks

```sh
npm run lint
npm run typecheck
npm test
uv run python -m unittest discover -s scripts -p 'test_*.py'
npm run build:test
npx playwright install chromium webkit
npm run test:e2e
```

Browser regression tests require `npm run build:test`. It builds an isolated test checkout with a dummy key in its own `.env`, without reading or modifying your credentials. Browser fixtures intercept MapTiler resources while retaining the production style. CI uses the checked-in single-cell release `public/packs/cell-fixture` without external downloads. It is explicitly test data, not a real route network. Regenerate it with `node --import tsx scripts/create_cell_fixture.ts` when the format changes. Run `npm run build` afterwards to restore the real configuration. `node scripts/smoke-lan.mjs <dev-url>` verifies installation and routing with the real pack on an insecure LAN development origin.

## Routing profiles and data updates

Road accepts paved surfaces and ordinary streets/cycleways with unspecified surfaces. It excludes unpaved tracks and undocumented hiking paths. Gravel accepts roads, usable tracks, and paths documented as paved, gravel/compacted, or MTB difficulty 0. Technical MTB paths, mountain hiking trails, very poor surfaces and grade-4/5 tracks are excluded. These are conservative defaults, not a certification of conditions on the ground.

Eligibility applies before waypoint snapping and search. A waypoint with no suitable connection within 250 m produces an explicit failure rather than routing over an unsuitable path. The original Geneva → Voirons example ends on an off-road path: it works for Gravel; Road requires a road-access endpoint, such as [6.3642228, 46.231931] on Route des Voirons.

The map, route statistics, and GPX export use the cheaper successful full-graph/corridor result. The corridor remains an experimental candidate, not an automatic final choice. Packs must carry cost model 4, urban fractions, cycling-network membership, retained access tags, and steps/ferry connections. Previously installed model-1/2/3 packs and pre-grid region packs are removed on start-up; save the areas you need after refreshing the app.

Run the real-data audit with `node --import tsx scripts/audit_route.ts`. It writes selected ways, grades, and costs under ignored `data/derived/routing-audit/`. The small checked-in Voirons fixture also exercises the actual Sauget detour in `npm test`.

## Limits of this experiment

- Synthetic and desktop browser checks cannot certify physical iPhone memory, battery or storage retention. Real-device acceptance remains a manual step.
- The scalar field is a coarse prior, not an exact directional/topological model. Valid routes may cost more than the full-graph baseline; the UI reports the measured difference.
- Profiles can enable bicycle pushing, stairs, and ferries. Ferry timetables and conditional/time-dependent access are not evaluated. Ambiguous conditional restriction from-ways are excluded conservatively. `no-path` means no path in this model, not proof that cycling is impossible.
- Terrain is sampled at Mapterhorn zoom 12 with bilinear height interpolation and 80 m windows along complete OSM ways before splitting topology edges. Bridge/tunnel terrain is not treated as road elevation. Missing elevation remains unknown and incurs a conservative slope surcharge; GPX exports geometry without invented heights.
- Network utility is a bounded 1 km low-stress reach metric, not a learned preference. Surface, stress and uncertainty coefficients are experimental.

OSM-derived regional databases are distributed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Terrain attribution is preserved from [Mapterhorn](https://mapterhorn.com/attribution/). See `CYCLATRACTOR_SPEC.md` for the broader product vision and the implementation baseline.

Public data CORS can be refreshed with `uv run scripts/publish_release.py --configure-cors`. The dedicated public-data bucket allows GET/HEAD from any origin, including LAN development addresses; credentials remain server-side.

Browser checks cover Chromium and mobile WebKit, including insecure LAN HTTP, interrupted downloads, checksum rejection, offline restart, routing and GPX export. WebKit offline tests stop the local HTTP server transport because Playwright’s offline emulation also breaks standalone Blob workers in this WebKit build. Physical iPhone validation remains manual.

Routing profiles are self-contained JSON: every profile carries its own bike, rider,
preferences and permissions, with nothing inherited from a master file. Open **Configure**
in the app to edit, save locally, or import/export one. Preferences use a single
five-level vocabulary, and grade and technical capability are derived from the bike and
rider rather than hand-set. See [the profile guide](profiles/README.md) and
[Gravel 40 mm](profiles/gravel_40.profile.json) for fields and current data limitations.
