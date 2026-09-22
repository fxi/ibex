# Known issues

Defects found by review, each re-checked against the code and, where it was measurable,
against a real build. Nothing here blocks building on the product; what each one blocks is
named. Remove an entry when it is fixed, rather than marking it done.

Last reviewed 2026-09-22, when the region/release model was replaced by the global grid.
B5 (two split rules), B4 (stale manifest on a failed rebuild), B3 (same-size content
accepted) and CI-3 (range read unchecked) went with it: per-cell splits are now the only
rule, there is no manifest, an object is named by its digest, and the verifier compares the
ranged bytes. CI-2 is gone with the release pointer it guarded. B1 (cross-cell turn
restrictions) and B6 (a cell dated by the clock) were fixed before the 2026-09-22 rebuild;
B7 below was found while measuring B1.

## Data and publication

### B7 · A road inside a cell can produce no edges at all

Measured 2026-09-22 on `9-264-181`. Way `242768222` ("Chemin de la Voile",
`highway=residential`, `access=destination`) sits 12.7 km inside the cell, is present in the
subset source (`slice.wayById.has(242768222)`), and `permitted()` returns true for its tags
— yet `buildGraph` yields **zero** edges for it, with or without `cell`, so `trimToCell` is
not the cause. The same holds for `1157169696` (`service=parking_aisle`) and `1472013285`
(`service=driveway`). All three do get edges when the same extracts are built over a wider
box, so the loss depends on the subset, not on the way.

Nine of the eleven restrictions B1's measurement found missing were missing for this reason
rather than B1's: the rule named a way that had no edges to attach to.

**Blocks:** unknown, and that is the problem. If it generalises it is a routing hole, not
merely a restriction hole. The three known cases are a cul-de-sac, a parking aisle and a
driveway, which is why it has not shown up in a route.
**Shape of the fix:** unknown. Bisect `buildGraph` between `roads` and the split pass on the
`9-264-181` slice from `switzerland.osm.pbf`; the way survives into `candidates`, so the
loss is after `permitted()` and before the edge list.

### B8 · `build_parity.ts` cannot read a cell build

`scripts/build_parity.ts:50` reads `<dir>/graph.json`, which the Python pipeline wrote and
nothing writes now — a cell build is `catalog.json` plus `.ibx` packs. Running it on two
cell builds fails with `ENOENT: .cache/cells/graph.json`, so the guard AGENTS.md requires
around a builder change is not actually available.

**Blocks:** every builder change from here on. The B1 fix of 2026-09-22 had to be justified
by construction (`withRestrictions` only ever adds edges and rules, never removes one) and
by counting edges and restrictions on both sides, rather than by this tool.
**Shape of the fix:** read a build through `loadReleaseGraph` (`scripts/local_cells.ts:21`),
as the audit scripts do. Note that two builds can only be compared within one
`BUILD_VERSION`: the provider refuses a pack from another generation, which is exactly when
a parity run is most wanted, so the loader needs the generation as an argument.

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
