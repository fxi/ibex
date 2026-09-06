# Cyclatractor

A mobile-first cycling route laboratory for the Geneva basin. A semantic field selects a search corridor; an OSM topology graph determines the actual route. The application compares that result with full-region Dijkstra using the same costs.

## Run locally

Requires Node 22.13+ (or Node 24) and npm. The default app uses the published Geneva pack; rebuilding data is optional.

```sh
npm ci
npm run dev
```

The map always uses the bundled `src/map/custom-style.json`. Copy `.env.example` to `.env` and set `VITE_MAPTILER_API_KEY` there for online MapTiler tiles, fonts, and sprites. Vite and the manual style downloader read only this workspace’s `.env`; ambient MapTiler variables, ancestor files, other dotenv files, and secret-reference expansion are not used. A missing key or resource failure displays a map status message and never selects another style. The key is a browser resource credential embedded at build time.

To rebuild the data locally, also install `uv` and `tippecanoe`:

```sh
uv sync --locked
uv run scripts/fetch_osm.py --endpoint https://overpass.kumi.systems/api/interpreter
uv run scripts/build_region.py
uv run scripts/fetch_attribution.py
uv run scripts/fetch_water.py
node --import tsx scripts/package_region.ts
VITE_REGION_MANIFEST=/cyclatractor/packs/geneva/manifest.json npm run dev
```

Open `http://localhost:5173/cyclatractor/`. Save the region, select an example or place at least two waypoints, and open **Inside the route** to compare results. Drag markers to move waypoints. **Draw me through here** adds a soft attraction with adjustable radius. The historical ride overlay is optional and online-only.

For service-worker/offline testing:

```sh
npm run build
npm run preview -- --port 4173
```

Open `http://localhost:4173/cyclatractor/`, save the region, then reload offline. The development server intentionally does not install the production service worker. LAN HTTP supports the map, installation in IndexedDB, checksum verification through a JavaScript SHA-256 fallback, and local routing while the application is open. HTTPS is required for service-worker registration and reopening the application offline on an iPhone.

## Data and privacy

Original and derived personal tracks remain under ignored `data/`. The application never uploads waypoints or routes. Enabling the historical overlay requests tiles from the existing public PMTiles archive; it does not send route geometry to that archive.

```sh
uv run scripts/prepare_tracks.py
uv run scripts/match_tracks.py --limit 80
node --import tsx scripts/benchmark.ts
```

Use `--limit 0` to audit every prepared portion. Matching reports distinguish spatial confidence from restriction-aware sequence validity. Repeated/overlapping portions and portions of the same activity share a calibration/evaluation group. `Ride` is unspecified cycling; it is not automatically a road-bike label. Personalization is disabled in this baseline.

The cached OSM response, its hash and timestamp make the build reproducible. Delete the cached OSM file explicitly to request a new snapshot. Terrain tiles and upstream attribution are cached under `data/terrain`. Graph tiles retain stable OSM node IDs; nearby geometry is never treated as connectivity.

## Pack format and storage

`manifest.json` declares schema/model versions, coverage, source date, byte lengths and SHA-256 checksums. `index.bin` and `graph-*.bin` contain gzip-compressed JSON; `.bin` prevents servers from transparently applying HTTP content decoding. `basemap.pmtiles` is a local vector basemap. `attribution.json` preserves source notices. This basemap artifact remains in existing packs for compatibility but is no longer displayed. Routing and GPX export work offline after installation; the bundled custom style needs online MapTiler resources to render its map.

Downloads are staged and verified before the installed record changes. Interrupted downloads resume at completed file boundaries. Cancel removes the current staging data. OPFS is preferred; IndexedDB is the capability fallback. Browser persistence is requested but can be denied. Removing browser site data removes installed packs. Storage is namespaced but shares the `fxi.io` origin quota with other applications.

Graph chunks are decoded in a worker with a 32 MB per-chunk allocation cap. Corridor searches read intersecting chunks and progressively expand; the full-graph comparison intentionally reads the entire region. A new request terminates the old worker, and generation IDs prevent stale output. The reference can therefore use considerably more memory than the corridor search.

## Publish

Copy `.env.example` settings into the ignored `.env`. Only `VITE_*` settings enter the browser bundle. Set `VITE_MAPTILER_API_KEY` in `.env` to use the custom MapTiler style `01984598-44d5-70a4-b028-6ce2d6f3027a` online. Restart Vite after changing `.env`. Vite embeds this browser API key in the client bundle; S3 credentials remain confined to Python scripts. The local PMTiles style is used without a key, offline, or if MapTiler fails. Route overlays remain available on both styles.

Run `uv run scripts/download_map_style.py` to save a credential-free copy as `src/map/custom-style.json`. Vite embeds that downloaded style when present and injects the configured key into its resource URLs; otherwise it loads the custom style directly from MapTiler. Downloading the style JSON does not download its tiles, sprites or fonts, so the custom basemap still requires connectivity.

```sh
uv run scripts/publish_region.py
uv run scripts/publish_region.py --publish
```

The first command verifies and previews the publication. The second uploads only manifest-listed public regional artifacts, never personal traces, to `cyclatractor/packs/geneva/<version>/`. Configure `VITE_REGION_MANIFEST` with the public immutable manifest URL. S3 needs public GET/HEAD, byte ranges, and CORS for the app origin. Credentials are used only by the publisher.

GitHub Pages deployment is a manual workflow and requires a configured repository and Pages environment. The repository currently has no Git remote configured. Set repository variable `VITE_REGION_MANIFEST` before publishing. The app base and service-worker scope are `/cyclatractor/`.

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

Browser regression tests require the synthetic pack build shown above. It builds an isolated test checkout with a dummy key in its own `.env`, without reading or modifying your credentials. Browser fixtures intercept MapTiler resources while retaining the production style. CI uses the same checked-in pack without external downloads. It is explicitly test data, not a real route network. Regenerate it with `node --import tsx scripts/create_fixture.ts` when its schema changes. Run `npm run build` afterwards to restore the real region configuration. `node scripts/smoke-lan.mjs <dev-url>` verifies installation and routing with the real pack on an insecure LAN development origin.

## Limits of this experiment

- Synthetic and desktop browser checks cannot certify physical iPhone memory, battery or storage retention. Real-device acceptance remains a manual step.
- The scalar field is a coarse prior, not an exact directional/topological model. Valid routes may cost more than the full-graph baseline; the UI reports the measured difference.
- Bicycle pushing, stairs, ferries and conditional/time-dependent access are excluded. Ambiguous conditional restriction from-ways are excluded conservatively. `no-path` means no path in this model, not proof that cycling is impossible.
- Terrain is sampled at Mapterhorn zoom 12, smoothed across approximately 80 m. Bridge/tunnel terrain is not treated as road elevation. Missing elevation remains unknown; GPX exports geometry without invented heights.
- Network utility is a bounded 1 km low-stress reach metric, not a learned preference. Surface, stress and uncertainty coefficients are experimental.

OSM-derived regional databases are distributed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Terrain attribution is preserved from [Mapterhorn](https://mapterhorn.com/attribution/). See `CYCLATRACTOR_SPEC.md` for the broader product vision and the implementation baseline.

Public pack CORS can be refreshed with `uv run scripts/publish_region.py --configure-cors`. The dedicated public-data bucket allows GET/HEAD from any origin, including LAN development addresses; credentials remain server-side.

Browser checks cover Chromium and mobile WebKit, including insecure LAN HTTP, interrupted downloads, checksum rejection, offline restart, routing and GPX export. WebKit offline tests stop the local HTTP server transport because Playwright’s offline emulation also breaks standalone Blob workers in this WebKit build. Physical iPhone validation remains manual.
