# Known issues

Defects found by review, each re-checked against the code and, where it was measurable,
against a real build. Nothing here blocks building on the product; what each one blocks is
named. Remove an entry when it is fixed, rather than marking it done.

Last reviewed 2026-09-22, when the region/release model was replaced by the global grid.
B5 (two split rules), B4 (stale manifest on a failed rebuild), B3 (same-size content
accepted) and CI-3 (range read unchecked) went with it: per-cell splits are now the only
rule, there is no manifest, an object is named by its digest, and the verifier compares the
ranged bytes. CI-2 is gone with the release pointer it guarded.

## Data and publication

### B1 · Cross-cell turn restrictions can disappear
`scripts/build_region.py:976-979` keeps a restriction only when *every* way it names has an
edge owned by that cell (ownership is the cell holding an edge's first point, `:915`). A
restriction whose from-way and to-way fall in different cells is dropped by both, and
merging packs cannot restore it, so a prohibited turn becomes legal. Via-way sequences fail
the same way.
**Blocks:** nothing measurable on two cells; at Europe scale it is a systematic hole along
every seam, so fix it before a wide build. Was: fix it before the next
full rebuild, not after.
**Shape of the fix:** keep halo-derived restrictions that an owned edge needs, with explicit
rule ownership and replication; the provider already deduplicates.

### B6 · A cell is built from whatever OpenStreetMap said that minute

`scripts/build_cells.ts` records `osm` as the wall-clock time of the build, not the
timestamp of the data. The extract's own `osmosis_replication_timestamp` header is right
there in the PBF and is not read, so two cells built a month apart from the same download
claim different freshness, and a cell's age cannot be trusted to decide a refresh.

**Blocks:** nothing today — staleness is decided by hash, not by date. It blocks any
"rebuild cells older than N months" policy, which is the point of a yearly refresh.
**Shape of the fix:** read the header block's replication timestamp in `readPbf` and carry
it through to the catalogue entry.

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
