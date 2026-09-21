# AGENTS.md

Working notes for coding agents on Ibex. The README covers the product and the user-facing
setup; this file holds the rules and pitfalls that aren't obvious from the code.

## Project in one paragraph

Ibex is a browser-only cycling route planner (React, MapLibre, Vite, PWA). Routing runs on
the device, on binary grid cells (`.ibx`) downloaded from a static data tree on S3. Data is
built locally from OpenStreetMap by a Python/TS pipeline under `scripts/`. The app deploys
to GitHub Pages at https://fxi.io/ibex/ (repo `fxi/ibex`). Data is served from the Exoscale
bucket `ibex` at `https://ibex.sos-ch-gva-2.exo.io/data`. The product name is **ibex**. 

## Commands

```sh
npm run setup                     # first run: npm ci + .env from .env.example
npm run dev                       # http://localhost:5173/ibex/
npm run lint && npm run typecheck && npm test
uv run ruff check scripts
uv run python -m unittest discover -s scripts -p 'test_*.py'
npm run build:test && npm run test:e2e   # Chromium + mobile WebKit; ~3 min
npm run data:stage -- <packs dir>        # serve a local release at /ibex/data/
```

`npm run build:test` overwrites `dist/` with a test build (dummy key, fixture data). Run
`npm run build` afterwards if a real `dist/` matters.

## Known failing tests

None as of 2026-09-17: vitest and both e2e browsers are green on `main`. Keep it that way,
because `deploy.yml` runs the checks before the Pages deploy.

When a change of yours shows failures, they are most likely yours. Compare against a
worktree of the previous commit before concluding otherwise. Tests that encode a product
decision — a cost, a preference, a routing outcome — are not to be relaxed to make them
pass: ask instead. Record any newly accepted failure in this section.

## Known defects

`docs/issues.md` lists the defects found by review and not yet fixed, each with what it
blocks: B1 before the next full rebuild, R1 with the Swiss extract, the rest when the
surrounding work makes them cheap. Read it before touching the builder, the publisher or
the cost model — the entry probably says what you are about to rediscover. Fix an entry by
deleting it, not by marking it done, and add one when you leave a defect behind.

## Changing the router

`src/routing/engine.ts` is the search and nothing else: the cost model (`cost.ts`), the cost
field (`field.ts`), turn restrictions (`restrictions.ts`), the A* lower bound
(`heuristic.ts`), the heap and `distance`/`project` (`src/geo/`) each live on their own and
are re-exported through `engine.ts`, so existing imports and scripts are unaffected. Keep it
that way: put new cost terms in `cost.ts`, not in `route()`.

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

For the Python builder the equivalent is a single-cell rebuild diffed against the existing
build: `uv run scripts/build_region.py --input data/pbf/<edition>/cells/<id>.osm.pbf
--output <tmp> --cell <id> --split-nodes data/derived/<edition>/split-nodes.bin`, then
compare `graph.json` and `basemap.json`. It takes about two minutes and 300 MB for one cell.

## Data format rules

Read `docs/data-format.md` before touching `src/offline/`, `scripts/package_cells.ts`,
`scripts/publish_release.py` or the fixtures.

- A single `DATA_VERSION` (`src/offline/version.ts`) governs the pointer, catalogue,
  manifests and `.ibx` headers. Don't add separate schema, format or cost-model version
  fields.
- Bump it only for changes existing readers can't read. Follow the checklist in the doc,
  which includes `DATA_VERSION` in `scripts/verify_public_release.py` and regenerating
  `tests/fixtures/data` and `tests/fixtures/grid-fixture`.
- Releases under `data/v<N>/releases/<id>/` are immutable. Only `latest.json` changes.
- There is no backward-compatibility obligation yet: remove legacy paths rather than
  adding migrations, unless asked.
- Pack data never goes in `public/` or in git. Local releases live under the ignored
  `data/` (current: `data/build/geneva-toulon-v7/packs`); `dist/` must stay a few MB.

## Secrets and configuration

- Never print, echo, log or commit values from `.env`. Refer to keys by name, and redact
  when inspecting (e.g. `sed -E 's/=.+/=<set>/' .env`).
- Only this workspace's `.env` provides `VITE_MAPTILER_API_KEY` locally; an ambient
  variable is deliberately ignored (`tests/map-style.test.ts`). CI passes it through the
  environment with `CI` set. Keep that distinction in `vite.config.ts`.
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
  Ask before pushing, tagging, or any S3 write (`publish_release.py --publish`,
  `--promote`, `--prune`, `--create-bucket`). Uploads are public and effectively
  permanent.
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
- Scripts: take inputs as arguments (default to `DEFAULT_RELEASE` from
  `scripts/local_release.ts`), write outputs under `data/`, and get a row in
  `scripts/README.md`. No one-off experiments committed.
- Python targets 3.11+, run through `uv`; ruff must pass.

## Environment pitfalls (this machine)

- `grep` is ugrep: it skips binary files silently, so use `grep -a` when a match in
  binary content matters.
- Python heredocs (`python3 - <<EOF`) have silently done nothing in the agent shell. Use
  the Edit and Write tools, `uv run python -c`, or a script file.
- Disk is nearly full (~14 GB free). Delete superseded builds under `data/build/` only
  when asked, and check free space before packaging or rebuilding.
- macOS ships bash 3.2: with `set -u`, guard empty arrays (`${a[@]+"${a[@]}"}`).
