# Routing performance and profile format 3

Normal routing runs one search per leg. Corridor comparisons and scenic destination
sweeps no longer run implicitly. Profiles move to format 3: generated UUIDs, whole-ride
`settings`, and way preferences stated for `base` with `uphill` and `downhill` overrides.
Format 2 converts on load. See `profiles/README.md` for the format itself.

## Profiles

An intermediate version of this work replaced preferences with fixed ride policies
(ride type × rider level × technical comfort). That was rolled back: it hid the
preferences a custom profile is made of, and added two choices a rider should not have
to make. What it got right was that a ride's intent depends on direction, and that is
kept inside the preference model as `preferences.uphill` / `preferences.downhill`.

A grade run steeper than `ENGINE.grade_from` (2 %) uses the matching override. This is
local grade, not a sustained descent. On the Fillinges gold standard a Gravel downhill
override cost 20 points at any threshold below 8 %, because that route rides gravel on
short descents, so shipped Gravel has none until sustained-descent data exists.

`surface_difficulty` replaces `roughness` and `technicality` as one level over the same
two scored signals, each against its own reference. Avoided, both are charged; preferred,
the stronger is credited. Lacking a technical tag no longer earns a credit: with one level
moving both signals, that credit priced a rough gravel track below "prefer" for a rider
avoiding difficulty. Measured with the scenic sweep on: Fillinges 94.1 % (unchanged),
Geneva→Med 30 km legs 69.3 % (68.7 % before).

`direction_changes` charges turns only at nodes where three or more ways meet, scaled by
`(1 - cos angle) / 2`, never negative. The search state already carries the arrival node
for turn restrictions, so no extra states are needed, and the reverse lower bound stays
admissible because the charge is nonnegative. The search and the reported route price
turns identically.

A rider who strongly avoids unpaved ground also pays `unpavedHazard`, outside the detour
budget like `trafficHazard`. The preference alone was capped by the budget, and
compacted gravel sits below a 28 mm tyre's roughness threshold, so neither kept a road
route off a gravel shortcut. It is finite, so no destination becomes unreachable.

Shipped profiles are Gravel (`gravel_50`), MTB (`trail_60`) and Road (`road_28`). Their
intent is tested in `tests/rideIntent.test.ts`. Road uses `climbing: neutral` and
`traffic_stress: strongly_avoid`; with `climbing: prefer` it took a 10 % ridge over a
flat valley, which also failed the golden test before this work.

Not carried over from the policy experiment: road/track transition costs. They required
search states keyed by edge rather than node, were invisible to the search lower bound,
and had only synthetic evidence.

## Search and caching

Small graphs use A* with a conservative projected-distance lower bound. Large two-anchor
graphs also run a reverse node search with actual edge costs while ignoring turn
restrictions and ferry boarding. Those omitted terms are nonnegative, so the resulting
node distances are lower bounds for the complete search. Preparation stops at the source
or its budget; unsettled nodes use the last settled frontier distance. The final search
still checks restrictions and prices ferry boarding. It can reopen states.

The preparation visits at most 100,000 nodes and at most a quarter of the request's
settlement budget; preparation and final search both count against that budget.
`metrics.preparedStates` and `metrics.explored` report them separately. Explicit
`search: "dijkstra"` disables the guide for correctness comparisons.

The lower bound's length scale is a minimum over every loaded edge. One edge whose
length is much shorter than its chord keeps the bound admissible but weakens it for the
whole query, which shows up as a slow search rather than a wrong route.

An idle worker retains its last compiled profile and bounded decoded-block cache. An
active cancellation terminates the worker; generation, track and revision checks still
reject stale messages. Blocks outside the next leg's search area are released. Edge
costs use weak object keys, so evicted blocks can be collected and synthetic split ids
cannot collide with cached costs. Loading/decoding and search durations are reported
separately. Completed leg caching remains in place; reused legs keep the load metrics of
the run that produced them.

Set `diagnostics: true` on an audit request to restore corridor/reference/exploration
comparisons. Normal results have no field overlay and a null comparison cost difference.

## Upstream data

New block format 2 stores profile-independent roughness, uphill/downhill technical
difficulty, unpaved evidence and curvature, quantized to one millionth. The cell index
format remains 1. Both old and new blocks are readable; old blocks derive these facts
once when loaded. Pieces of an edge split at a waypoint keep the parent's facts, so a
waypoint cannot change what a way costs. Validation rejects out-of-range facts and
unsupported versions. Changing how a signal is derived requires bumping the semantics
version, or repackaged format-2 blocks keep the old values.

Preprocessor 7 retains `natural=saddle` and `mountain_pass=yes` nodes and includes them
among scenic sources. Repackaging existing preprocessor-6 graphs adds cached signals
but does not invent missing passes. The packager derives its preprocessor generation
from input manifests and adds a semantic-version suffix to the release id.

The synthetic browser release has been regenerated. A real regional cell can be
repackaged into an isolated directory with `scripts/package_cells.ts`; this does not
publish or replace the installed regional catalogue.

## Measurements

Desktop Node v23.11.0, installed Geneva-grid packs, one measured run per case. The old
pipeline was loaded from an isolated copy of the previous routing engine. Loading was
measured separately and shared across the compared queries. These are local
measurements, not physical-phone latency claims.

| Case | Graph edges | Old pipeline | New pipeline, same profile | Cold pack load |
| --- | ---: | ---: | ---: | ---: |
| Geneva–Voirons | 263,728 | 6.26 s | 1.12 s | 1.18 s |
| Geneva–Salève | 217,808 | 4.56 s | 1.11 s | 0.78 s |

The same profile produced the same route distances under both pipelines in these two
cases. Costs decreased slightly because waypoint splitting no longer duplicates a
junction charge. Timings for the three shipped profiles need re-measuring after the
policy rollback:

```
node --import tsx scripts/benchmark_routing.ts public/packs/geneva-grid [baseline-legs-module]
```

The machine-readable report is written to `data/derived/routing-refactor.json`.

## Remaining scope

There is no precomputed multilevel shortcut hierarchy yet. Long legs still load the graph
inside their padded search extent. The measured speedup comes from removing repeated
searches, stronger exact-query guidance, cached costs and upstream facts; it must not be
extrapolated to continental single-leg routing. Published regional packs are unchanged.

Scenic data remains a proxy: mapped passes and viewpoints do not establish an
unobstructed view, and altitude alone is not rewarded.

`tests/bikepacking.test.ts` predates this work. Four of its assertions ask for roughness
and pushing heuristics the engine does not implement, and still fail.
