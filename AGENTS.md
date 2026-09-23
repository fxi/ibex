# AGENTS.md

Working notes for coding agents on Ibex. The README covers the product and the user-facing
setup; this file holds the rules and pitfalls that aren't obvious from the code.

## Project in one paragraph

Ibex is a browser-only cycling route planner (React, MapLibre, Vite, PWA). Routing runs on
the device, on binary grid cells (`.ibx`) downloaded from a static tree on S3. The grid is
global Web-Mercator XYZ at zoom 9; cells are built one at a time by `scripts/build_cells.ts`
straight from Geofabrik downloads, with no server and no Python anywhere. The app deploys to
GitHub Pages at https://fxi.io/ibex/ (repo `fxi/ibex`). Data is served from the Exoscale
bucket `ibex`. The product name is **ibex**.

## Commands

```sh
npm run setup                     # first run: npm ci + .env from .env.example
npm run dev                       # http://localhost:5173/ibex/, serving .cache/cells
npm run lint && npm run typecheck && npm test
npm run build:test && npm run test:e2e   # Chromium + mobile WebKit; ~3 min
npm run data:build -- --bbox W,S,E,N     # build cells into .cache/cells
npm run data:build -- --regions switzerland --publish --skip-built --terrain-budget 4000
npm run data:publish -- --dry-run        # what would go to the bucket
npm run data:basemap -- --publish        # Protomaps basemap + fonts + sprite → map.json
npm run data:cycle-routes -- --publish   # cycle/MTB route relations → map.json
```

Rerun both map scripts after the cell coverage grows: they cover the published cells'
extent, and outside it the map has only world detail to z6 and no cycle routes.

A run of more than a handful of cells takes `--publish`: each one goes to the bucket as it
is packed and leaves the disk, and `--skip-built` resumes. `--regions` takes Geofabrik
extract ids, which are not today's administrative names (Occitanie is
`languedoc-roussillon,midi-pyrenees`; there is no `auvergne-rhone-alpes`).

`npm run build:test` overwrites `dist/` with a test build (dummy key, fixture data). Run
`npm run build` afterwards if a real `dist/` matters.

There is no `data/` directory and no staging step: the builder writes to the gitignored
`.cache/`, which is also what the dev server reads. The only data in the repo is the small
fixture under `tests/fixtures`.

## Known failing tests

None as of 2026-09-22: vitest and both e2e browsers are green on `main`. Keep it that way,
because `deploy.yml` runs the checks before the Pages deploy.

`tests/release.test.ts` only runs when a local build has packs beside its catalogue, which
`--publish` deliberately does not leave behind. Build a couple of cells somewhere of their
own and point it there — `IBEX_CELLS=.cache/verify npm test` — or those ten tests skip and
nothing exercises real data.

When a change of yours shows failures, they are most likely yours. Compare against a
worktree of the previous commit before concluding otherwise. Tests that encode a product
decision — a cost, a preference, a routing outcome — are not to be relaxed to make them
pass: ask instead. Record any newly accepted failure in this section.

WebKit does not route requests made by the service worker or a web worker, so a
`page.route`/`context.route` mock there is seen only sometimes: macOS passes and CI on
Linux fails a different few tests each run. Anything the map fetches in the browser tests
is therefore a real file under `tests/fixtures/data` (written by
`scripts/create_cell_fixture.ts`), and relief, which no file can stand in for, is off in
the fixture `map.json`.

## Known defects

`docs/issues.md` lists the defects found by review and not yet fixed, each with what it
blocks. As of 2026-09-22: **R1 fails a real pair** (Thonon → Lausanne returns `no-path`
because the detour sits outside the search window) and is the one to treat first; **B8**
means `build_parity.ts` cannot read a cell build, so the guard below is unavailable; **B7**
is a road inside a cell that produces no edges and nobody knows why. B1 and B6 were fixed
before the rebuild of that date. Read it before touching the builder, the publisher or the
cost model — the entry probably says what you are about to rediscover. Fix an entry by
deleting it, not by marking it done, and add one when you leave a defect behind.

## Changing the router

`src/routing/engine.ts` is the search and nothing else: the cost model (`cost.ts`), the cost
field (`field.ts`), turn restrictions (`restrictions.ts`), the A* lower bound
(`heuristic.ts`), the heap and `distance`/`project` (`src/geo/`) each live on their own and
are re-exported through `engine.ts`, so existing imports and scripts are unaffected. Keep it
that way: put new cost terms in `cost.ts`, not in `route()`.

Memory is a constraint in its own right: iOS kills a tab somewhere past 1–1.5 GB, without
an exception. The search walks a `LegGraph` (`legGraph.ts`), meaning typed arrays plus edges
decoded on demand from compact blocks (`compactBlock`/`blockEdge`), and keeps per-edge and
per-state data in typed arrays. Do not reintroduce an object, a string key or a Map entry per
graph edge or search state. `node --import tsx scripts/memory_leg.ts <cells>` reports the peak
for legs of 30–100 km. On 2026-09-23 a 102 km leg peaked at 630 MB, down from 3.7 GB.

The suite asserts *relationships* (this costs more than that, this distance is in a band),
which will not catch a refactor that moves a route. Before and after any change meant to
preserve behaviour, run the golden master against the local packs:

```sh
node --import tsx scripts/route_golden.ts            # capture
node --import tsx scripts/route_golden.ts --check    # compare, exits 1 on any difference
```

A change meant to *improve* routes is judged against the gold standards in
`tests/fixtures/gold/`: lines the author judged best, each routed from its intent
waypoints only. `node --import tsx scripts/gold_route.ts audit <name>` shows every place
the router still parts from one and what each side costs. Raise a case's `min_shared` when
a change earns it; never lower it without asking.

For the builder the equivalent is `scripts/build_parity.ts`, which compares two builds of
the same cell field by field — every edge id, geometry, tag, grade and restriction — and
exits 1 on any difference. It expects to print `IDENTICAL`. **It does not currently run**:
it reads a `graph.json` that nothing writes any more (`docs/issues.md` B8). Until that is
fixed, a builder change has to be justified another way — by construction, and by counting
edges and restrictions on both sides — and rebuilding a cell twice is the cheap sanity
check, since the hash is the hash of its bytes and an unchanged build reproduces it exactly.

## Data format rules

Read `docs/data-format.md` before touching `src/offline/`, `scripts/build_cells.ts`,
`scripts/publish.ts` or the fixtures.

- `DATA_VERSION` (`src/offline/version.ts`) is the format number: bump it only for changes
  existing readers cannot read. `BUILD_VERSION` beside it is the *generation*: bump it when
  cells built by the old builder would disagree with cells built by the new one, which
  forces a rebuild rather than a re-read.
- There is no release, no edition and no version in any published path. A cell is named by
  the hash of its own bytes (`cells/<id>/<hash>.graph.ibx`), so nothing is ever overwritten
  and everything but `catalog.json` is cached forever.
- Staleness is per cell: the catalogue offers a different hash than the one installed.
- There is no backward-compatibility obligation yet: remove legacy paths rather than
  adding migrations, unless asked.
- Cell data never goes in `public/` or in git. Builds live under the ignored `.cache/`;
  `dist/` must stay a few MB. The committed fixture under `tests/fixtures` stays small.

## Secrets and configuration

- Never print, echo, log or commit values from `.env`. Refer to keys by name, and redact
  when inspecting (e.g. `sed -E 's/=.+/=<set>/' .env`).
- No browser key, on purpose: a key in the bundle is public whatever its origin rules
  say, and the MapTiler one was used up (2026-09-23). The map reads the bucket (`map.json`,
  written by `scripts/basemap.ts` and `scripts/cycle_routes.ts`) and keyless services
  only; `tests/map-style.test.ts` fails on a `key=` in any style.
- GitHub secrets and variables are synced by `scripts/gh-setup.sh`, which sends only the
  names it lists. Don't use `gh secret set -f .env`.
- Before pushing anything new and large or sensitive-looking: `gitleaks git --redact`, and
  check blob sizes.

## Git and publishing

- Commits: Conventional Commits, one line, lowercase type (`feat:`, `fix:`, `refactor:`,
  `chore:`, `docs:`, `ci:`, `test:`; `!` for breaking). No body, no `Co-Authored-By` or
  other trailers.
- Group commits by concern, not one giant commit.
- The remote is named `github`. Pushing to `main` triggers checks and the Pages deploy.
  Ask before pushing, tagging, or any S3 write (`npm run data:publish` without
  `--dry-run`, and `--setup-bucket`). Uploads are public and effectively permanent.
- Tags `v*` must match the `package.json` version (`release.yml` checks it).

## Code conventions

- Match the surrounding style. Comments explain *why* (constraints, measured facts), not
  what the line does. TypeScript is strict; zod schemas validate anything read from storage
  or the network.
- Profiles are complete, self-contained `format_version: 3` files. Every
  `profiles/*.profile.json` ships in the app. The default profile is pinned by id in
  `src/models.ts` (`DEFAULT_PROFILE_ID`), not by filename order.
- Browser storage is namespaced `ibex` (IndexedDB database, OPFS directory, `ibex-*`
  keys), and shares the `fxi.io` origin with other projects.
- Scripts: take inputs as arguments (default to `DEFAULT_CELLS` from
  `scripts/local_cells.ts`), write outputs under `.cache/`, and get a row in
  `scripts/README.md`. No one-off experiments committed.

## Environment pitfalls (this machine)

- `grep` is ugrep: it skips binary files silently, so use `grep -a` when a match in
  binary content matters.
- Python does not run in the agent shell at all: `python3 file.py`, `python3 -c` and
  `python3 - <<EOF` are all killed with exit 137, and a heredoc writes its file first, so it
  looks like the script ran and did nothing. Verified 2026-09-22. Use the Edit
  and Write tools or a script file.
- Disk is tight — about 20 GB free of 926 GB. A Geofabrik download is a few hundred MB and
  the DEM cache grows without bound unless capped; both live under `.cache/`. Build wide
  runs with `--publish` (cells go to the bucket and leave the disk) and `--terrain-budget`,
  and delete cached extracts only when asked.
- macOS ships bash 3.2: with `set -u`, guard empty arrays (`${a[@]+"${a[@]}"}`).
