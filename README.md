# Ibex

Choose the territory. Find your way.

Ibex is an offline-capable cycling route planner that runs entirely in the browser. You download the map areas you ride in, and routing happens on your device against your own routing profile: no route or waypoint ever leaves it, unless you ask for places along it (below). The map can be browsed worldwide, and routing works wherever cells have been built.

Live at **https://fxi.io/ibex/**.

- **Tracks:** create, duplicate and hide tracks, each with its own routing profile. Edit numbered waypoints on the map, undo edits, and export GPX. Imported GPX rides become reference tracks.
- **Data:** the whole world on a zoom-9 grid. Cells that exist are offered with their size; ones nobody has built yet are greyed out. Downloads resume, refresh and remove, and routes cross freely between installed neighbours.
- **Notes:** your own notes along a track, and drinking water, bakeries and supermarkets found beside it, about one per kilometre, the closest to the route winning, with water kept at most 10 km apart. Search the whole route or a circle of up to 10 km; the searched stretch is sent to the public [Overpass API](https://overpass-api.de), and what is found is saved with the track and exported as GPX waypoints.
- **Tools:** compute the active track explicitly; editing marks the previous result stale.
- **Configure:** pick or edit a profile with forms or raw JSON, and show routing diagnostics.

## Quick start

Requires Node 22.13+ and npm.

```sh
git clone https://github.com/fxi/ibex.git && cd ibex
npm run setup     # npm ci, creates .env from .env.example, reports what is missing
npm run dev       # http://localhost:5173/ibex/
```

`.env.example` points `VITE_DATA_URL` at the public data, so a fresh clone can download areas, route and draw the map right away. There is no map key: the basemap and cycle routes are PMTiles archives in the same bucket as the cells, relief comes from [Mapterhorn](https://mapterhorn.com), imagery from EOX Sentinel-2 cloudless, IGN and swisstopo, and place search from [Photon](https://photon.komoot.io).

In **Data**, save an area; in **Tracks**, add a track and place two waypoints on the **Edit** tab; then use **Tools → Compute current track**.

To test the service worker and offline mode, use a production build: `npm run build && npm run preview`. HTTPS is required to reopen the app offline on an iPhone; plain LAN HTTP still installs data and routes while the page is open.

## How data works

Routing data is not bundled with the app. It is a static tree of grid cells on any
S3-compatible bucket: one `catalog.json` listing every cell that has been built, and per
cell an `index.ibx` block directory beside a `graph.ibx` of deflated binary blocks the
router reads by byte range.

The grid is global — plain Web-Mercator XYZ at zoom 9, about 54 km a side — and the map
draws all of it. A cell nobody has built yet is still there, greyed out; a cell that exists
is offered for download. There is no region, no edition and no release: each cell is built
on its own, from its own ground plus a 5 km halo, and cells built months apart route
together.

A cell's files are named after the hash of the bytes they hold
(`cells/9-264-181/a1b2….graph.ibx`), so nothing is ever overwritten, everything but the
catalogue can be cached forever, and a rebuilt cell lands beside the old one. When the
catalogue offers a different hash than the one installed, that cell reads as stale. See
**[docs/data-format.md](docs/data-format.md)** for the layout and cache headers.

In the browser, downloads are staged and checksum-verified before the installed record
changes. OPFS is preferred, with IndexedDB as the fallback (database `ibex`). Graph blocks
are decoded in a worker with a 32 MB allocation cap per block. Cells installed under another
data version are removed on start-up.

Building cells needs nothing but Node. Give it a box or a set of OpenStreetMap regions and
it works out which downloads cover them, reads each one once, and builds every cell that has
roads under it:

```sh
npm run data:build -- --bbox 5.9,46.1,6.5,46.4         # a couple of cells
npm run data:build -- --regions switzerland --dry-run  # a region, and what it would cost
npm run dev                                            # serves .cache/cells
```

A region is a Geofabrik extract id, which is not always today's administrative name —
Occitanie is `languedoc-roussillon,midi-pyrenees`. Asking by region rather than by rectangle
skips the cells that are only somebody else's ground.

Anything larger than a handful of cells should publish itself rather than pile up on disk:

```sh
npm run data:build -- --regions switzerland --publish --skip-built --terrain-budget 4000
```

Each cell goes to the bucket as it is packed and leaves the disk again, the catalogue is
uploaded after every download, and `--skip-built` resumes an interrupted run.

## Deploy your own

The app deploys to GitHub Pages at `/<repository name>/`; the data goes to any S3-compatible
bucket.

1. Fill in the S3 block of `.env`, then publish what you built:
   ```sh
   npm run data:publish -- --setup-bucket   # once: bucket + CORS
   npm run data:publish -- --dry-run        # what would go up
   npm run data:publish
   npm run data:publish -- --verify <VITE_DATA_URL>
   ```

2. Configure the repository: `scripts/gh-setup.sh` copies the named secrets and variables from `.env` with `gh`. Then enable Pages with source **GitHub Actions**.
3. Push to `main`. [`deploy.yml`](.github/workflows/deploy.yml) runs all checks, builds with `BASE_PATH=/<repo>/` and deploys. It is skipped until `VITE_DATA_URL` is set, so a fork without data stays green.

| Workflow      | Trigger                      | Does                                                                   |
| ------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `ci.yml`      | pull requests, branch pushes | lint, typecheck, unit and browser tests                                |
| `deploy.yml`  | push to `main`, manual       | the checks above, then build and publish to Pages                      |
| `release.yml` | tag `v*`                     | GitHub release with generated notes (tag must match `package.json`)    |

Publishing data is a local step, not a workflow: cells are built on a machine with the
disk and the OpenStreetMap downloads, and sent straight to the bucket.

| Name                                                  | Kind     | Used by              |
| ----------------------------------------------------- | -------- | -------------------- |
| `S3_ENDPOINT`, `S3_KEY`, `S3_SECRET`, `S3_BUCKET`     | secrets  | data                 |
| `VITE_DATA_URL`                                       | variable | deploy, data         |
| `VITE_HEATMAP_URL`, `S3_PREFIX`, `S3_PUBLIC_URL`, `APP_ORIGIN` | variables | deploy, data |

Give CI an S3 key limited to the data bucket.

## Checks

```sh
npm run lint && npm run typecheck && npm test
npm run build:test && npx playwright install chromium webkit && npm run test:e2e
```

`npm run build:test` builds an isolated checkout with the synthetic single-cell release and a tiny basemap in `tests/fixtures/data`, which is explicitly test data, not a real network. Browser tests intercept relief, imagery and fonts, then cover Chromium and mobile WebKit: LAN HTTP, interrupted downloads, checksum rejection, offline restart, routing and GPX export. Regenerate the fixture with `node --import tsx scripts/create_cell_fixture.ts` after a format change. `tests/release.test.ts` also runs on a real local build when one exists (`IBEX_CELLS=<cells dir>`).

## Routing

A profile is a complete, self-contained file: bike, rider, whole-ride settings, way preferences with uphill and downhill overrides, and permissions. See [the profile guide](profiles/README.md). Every `profiles/*.profile.json` ships with the app.

Normal routing runs one A* search per leg over the graph merged from installed cells. Turn restrictions, urban turns, riding transitions and ferry boarding stay in the final search. Costs are additive: scenery can discount distance but never traffic or capability penalties. Legal access excludes a connection; difficult terrain and refused pushing remain expensive last resorts. Snapping requires a suitable connection within 250 m. See [the routing refactor](docs/routing-refactor.md).

For audits, `node --import tsx scripts/audit_route.ts [packs dir]` writes selected ways, grades and costs under `.cache/routing-audit/`. The checked-in Voirons and Coudry fixtures exercise real detours in `npm test`. Every script is listed in [scripts/README.md](scripts/README.md).

## Privacy

The app never uploads waypoints, routes or profiles. The optional "your rides" overlay (`VITE_HEATMAP_URL`) requests tiles from a public PMTiles archive and sends no route geometry. Personal activity traces used for calibration stay under the ignored `.cache/` directory and are never published.

## Limits

- Desktop and emulated browser checks can't certify iPhone memory, battery or storage retention; test on a real device.
- Profiles can allow pushing, stairs and ferries. Ferry timetables and time-dependent access aren't evaluated, and ambiguous conditional restrictions are excluded conservatively. `no-path` means no path in this model, not proof that cycling is impossible.
- Terrain is sampled from Mapterhorn with bilinear interpolation along complete OSM ways. Bridges and tunnels get no ground elevation. Missing elevation stays unknown and adds a conservative slope surcharge, and GPX exports never invent heights.
- Network utility is a bounded 1 km low-stress reach metric, not a learned preference. Surface, stress and uncertainty coefficients are experimental.

## License and attribution

The code is under the [MIT License](LICENCE). Routing data derived from OpenStreetMap is © OpenStreetMap contributors, available under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Terrain: [Mapterhorn](https://mapterhorn.com/attribution/). Basemap: [Protomaps](https://protomaps.com) © OpenStreetMap contributors. Imagery: Sentinel-2 cloudless by EOX IT Services GmbH (CC BY-NC-SA 4.0), © IGN, © swisstopo.
