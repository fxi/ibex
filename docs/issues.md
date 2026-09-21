# Known issues

Defects found by review on 2026-09-18 against `102d4c7`, each re-checked against the code
and, where it was measurable, against the local packs. Nothing here blocks building on the
product; what each one blocks is named. Remove an entry when it is fixed, rather than
marking it done.

## Data and publication

### B5 · The two split rules disagree
`scripts/global_splits.py` and `scripts/build_region.py` derive the way-split node set by
different rules, so the release-wide set is not what a cell would have computed for itself.
Two mismatches, both confirmed on `9-264-181` against `geneva-toulon-v7`:

- `global_splits.py:48` skips any way without a `highway` tag, so `route=ferry` ways
  contribute no split points. `build_region.py` synthesises `highway=ferry` (`:643`) and
  treats them as roads, so they do. Way 163578661 splits locally and not globally.
- `global_splits.py` keeps the via node of every `type=restriction` relation.
  `build_region.py` adds `via_nodes` only inside the loop that has already filtered on
  `except=bicycle`, on a `no_`/`only_` prefix, and on all named ways being present in
  `road_ids` (`:700-738`), so it keeps strictly fewer.

**Measured 2026-09-21:** building the cell both ways differs on 7 ways of 345,631 edges —
6 nodes and 8 edges only in the global build, 2 edges only in the local one. All seven nodes
are interior to the cell, and road overshoot past the halo is 0.00 km, so none of it follows
from the extract's extent. Both releases route identically: `route_golden.ts --check` over
4 scenarios × 4 profiles reports 16 of 16 unchanged, the seam included.
**Blocks:** nothing measurable — no route moves. It means the global set cannot be used as
the definition of correct, so a per-cell builder cannot be validated against it.
**Shape of the fix:** one rule, in one place. Deriving splits per cell removes the second
implementation rather than reconciling it; a cell extract cut with `complete_ways` holds
every road way touching a node inside the cell plus halo, which is what the rule needs.

### B1 · Cross-cell turn restrictions can disappear
`scripts/build_region.py:976-979` keeps a restriction only when *every* way it names has an
edge owned by that cell (ownership is the cell holding an edge's first point, `:915`). A
restriction whose from-way and to-way fall in different cells is dropped by both, and
merging packs cannot restore it, so a prohibited turn becomes legal. Via-way sequences fail
the same way.
**Blocks:** nothing in the app, but it is baked into every release — fix it before the next
full rebuild, not after.
**Shape of the fix:** keep halo-derived restrictions that an owned edge needs, with explicit
rule ownership and replication; the provider already deduplicates.

### B4 · A failed forced rebuild leaves a stale manifest
`build_region.py:1006-1029` writes graph and basemap before the terrain gate at `:1025`, and
does not invalidate an existing manifest first. `build_cells.py:116-118` resumes on manifest
existence alone, so an interrupted `--force` rebuild leaves new bytes beside old provenance
and the next ordinary build skips the cell.
**Blocks:** nothing — local builds only. Packaging now refuses the mismatch
(`package_cells.ts`), so it can no longer reach a release, but the cell still needs a manual
rebuild.
**Shape of the fix:** build into a staging directory, validate, then promote; resume on an
input fingerprint rather than on the manifest being there.

### B3 (rest) · Same-size different content is still accepted
Publication now preflights the release and refuses to write over objects whose size differs.
It cannot yet see a same-size difference: `publish_release.py` has no remote digest to
compare against.
**Blocks:** nothing, given that the release id now follows from the graph's digest.
**Shape of the fix:** store each object's sha256 as metadata on upload and compare it in the
preflight; resolve objects without it by reading them, never by size.

## Routing

### R2 · Splitting an edge changes what the same ride costs
`src/routing/cost.ts:450` averages the preference rate over an edge's ridden runs, then
`:470` raises `budget_ratio` to `tanh` of that average and applies it to the whole edge;
`:480` caps the edge as one. Mean-then-transform is not the sum of the per-run transforms,
so the same ground costs differently depending on where it is cut — and `snapAnchors`
(`engine.ts:162`) cuts it at every waypoint. The comment at `:421` promises the opposite.
**Blocks:** nothing, but it means adding a waypoint can change which alternative wins.
**Shape of the fix:** price the nonlinear preference and the rate cap per uniform run and
sum them. This moves routes: it is a cost-model correction, so audit it against
`tests/fixtures/gold/` and never lower a `min_shared`.

### R1 · The leg search window never grows
`src/routing/legs.ts:175` loads one area (`searchArea`: 12 km minimum, or 25 % of the anchor
span) and searches only that; the "whole graph" fallback in `engine.ts:420` widens the
search inside what is already loaded, and loading is per block, so the graph really does
stop at the window. A detour that runs further out than the padding cannot be found even
with every cell installed.
**Measured 2026-09-21:** on `geneva-toulon-v7`, 19 anchor pairs routed through `routeLeg`
and again on a graph loaded with `searchArea(anchors, 50)` gave identical status and cost
everywhere, including deliberate barriers (Aravis, Belledonne, Écrins, Verdon, lac du
Bourget, Rhône in the Camargue). The padding is enough for the current coverage.
**Blocks:** nothing today. It becomes reachable with a large lake whose crossings are far —
Thonon → Lausanne windows to lon 6.324–6.786 while the detour at Villeneuve sits at 6.93.
That pair cannot be tested yet because the Swiss north shore is disconnected in v7, so
**treat this with the Swiss extract.**
**Shape of the fix:** retry a disconnected search on progressively larger areas under an
explicit budget, and widen `legCache.ts:35`'s data dependencies to match. `route_golden.ts`
loads through the same `searchArea`, so recapture the golden master.

## CI

### CI-2 · Deployment does not check that the published data still fits the app
`deploy.yml:24-48` requires only a nonempty data URL and a successful build; browser tests
run on local fixtures (`build_browser_tests.ts:9-13`). A format bump can deploy before its
data is promoted.
**Blocks:** nothing spontaneously. Do CI-3 first and reuse its verifier.
**Shape of the fix:** a read-only preflight of the pointer, catalogue and one cell manifest
against the configured URL, before the Pages artefact is uploaded.

### CI-3 · The public verifier accepts any 64 bytes for a range read
`scripts/verify_public_release.py:105-109` checks only that a Range request returned 206
with 64 bytes — not their content, not `Content-Range`. A proxy that always returns the
first bytes, or the wrong ones, passes.
**Blocks:** nothing — browser routing reads ranges from local files. It is a false positive
in the weekly check.
**Shape of the fix:** compare the body with the already-verified full graph, validate
`Content-Range` and its total, and probe a nonzero offset too.
