# Routing profiles

Profiles are ordinary JSON. The app bundles `master.json`, the four bike presets,
and other `*.json` profiles in this directory. Add a named file and rebuild to
ship another profile. Browser users can edit JSON, save profiles locally, and
import/export files through **Custom profile**. A saved name replaces the previous
local profile with that name. Browser saving does not write to this directory.

`mountain-wanderer.json` is a working example. `version`, `name`, and `bike` are
required. Bike values are `gravel`, `road`, `touring`, and `scenic` (the last is a
legacy preset name). Resolution is **master → bike preset → user fields**.
Groups merge field by field. Omitted fields inherit; explicit `0`, `false`, and
`null` override. Arrays/expressions, unknown fields, unknown versions, and invalid
values are rejected. `Show inherited fields` expands the draft into a complete
configuration; exported expanded values will no longer inherit future defaults.

## Attractions

All attractions range from 0 (neutral) to 100 (strong). They are preferences, not
hard exclusions. Other inherited effort costs still apply at zero.

- `quiet`: adds a cost for traffic stress. This uses the pack's estimated stress,
  not live traffic measurements.
- `scenic`: discounts hardship near the pack's existing reward signal. It selects
  connections between waypoints; it does not select additional landmarks or
  promise a particular detour length.
- `climbing`: rewards uphill segments, including their distance/effort. The reward
  increases with grade up to the reference grade (8% by default), and accumulates
  over the ridden length. It can make a climb win over a flat alternative. It does
  not recognize named climbs or classify an entire mountain ascent.
- `offroad_up`, `offroad_down`: discount known unpaved riding in that direction.
  Flat segments use the mean preference. Unknown surfaces receive no reward.
- `countryside`: penalizes the fraction of a road in built-up areas. Model 4 uses
  residential/commercial/industrial/retail/garages/construction polygons, buffered
  40 m to include streets between plots. City/town/village centres have fallback
  radii of 1500/700/250 m; residential/living streets count as built-up. Boundary
  crossings are sampled every 30 m. This is a mapped-land-use estimate, not a
  promise to avoid every building or municipal boundary.
- `cycling_network`: penalizes roads outside mapped bicycle/MTB route relations
  or legacy lcn/rcn/ncn/icn tags. Forward/backward member roles are respected;
  proposed routes and explicitly unsigned routes are excluded. This is distinct
  from the older connectivity signal, `costs.graph_utility`. At 100, non-network
  connectors remain available at a higher cost.

## Capabilities and access

- `max_grade_up`, `max_grade_down`: positive percentages, 0–100. `null` removes the
  grade limit. Missing elevation fails an explicit grade limit rather than being
  treated as flat. Uphill/downhill are evaluated per grade segment, not net ascent.
- `max_mtb_scale_up`, `max_mtb_scale_down`: integer limits 0–6. Directional tags take
  precedence over `mtb:scale`. A `+` value is treated as half a level higher. Flat
  and unknown-grade segments must meet both directional limits.
- `max_hike_sac_up`, `max_hike_sac_down`: 0–6, with 1=T1 (`hiking`), 2=T2
  (`mountain_hiking`), through 6=T6. Zero excludes SAC-tagged hiking terrain.
  SAC limits remain independent of MTB limits and apply even with walking enabled.
- `access.hike_a_bike`: exceeding a riding grade/MTB limit changes that portion to
  walking when enabled. Walking has its own effort cost and route distance report.
  It requires documented walking terrain (SAC, a street, paved or gravel surface),
  respects retained foot prohibitions, and does not open edges removed by the pack
  builder. Unknown technical paths are not assumed feasible on foot.
- `access.steps`: permits stairs only when `hike_a_bike` is also true. Stairs are
  priced as carrying/pushing and included in hike-a-bike distance. Their missing
  riding-grade data and unknown surface do not disqualify an otherwise permitted
  stair connection; foot/bicycle prohibitions still do.
- `access.ferry`: permits bicycle-accessible mapped ferry connections independently
  of road surface, climbing limits, or hike-a-bike permission. Water travel has no
  riding elevation/surface cost and is reported separately. Known OSM duration is
  used as a cost proxy; otherwise distance is used. Boarding is charged once per
  service entry, including when a ferry is split by graph junctions or waypoints.
  Schedules are not evaluated: check seasonal availability and departure times.

Advanced inherited capabilities preserve the previous preset surface rules:
`paved_only`, `allow_unknown_paths`, `allow_rough_surfaces`, `max_track_grade`
(1–5), and `max_smoothness` (0 excellent, 1 good, 2 intermediate, 3 bad,
4 very_bad, 5 horrible, 6 very_horrible). Impassable is always excluded.
Surface rules still apply to ordinary hike-a-bike paths; stairs and ferries have
separate handling. Set `paved_only: false`
when adapting the road preset to permit offroad riding.

## Advanced costs and implementation

`master.json` lists all cost coefficients. Ordinary coefficients are nonnegative
and capped at 1000. `slope_reference_grade` uses a fraction, not a percentage, and
must be 0.01–1; `downhill_free_grade` is 0–1. Discount caps are 0–0.95.
`walking_factor` is 1–1000 equivalent-distance units per walking metre, added to
base distance and surface/stress costs in place of riding slope/technical cost.
`steps_factor` defaults to 8. `countryside_factor` defaults to 4 and
`cycling_network_factor` to 3. Ferry cost adds `ferry_second_meters` (default 4)
per mapped second or `ferry_factor` (default 1) per metre if duration is missing,
plus `ferry_boarding_meters` (default 1000) once on entering a service. Base distance
still applies. These are tuning coefficients, not calibrated travel-time predictions.

Cost components include climbing/offroad discounts and walking effort. Discounts
are bounded and sequential, retaining strictly positive traversal costs. A profile
is validated and resolved once at each routing boundary; the immutable resolved
object is reused for edge scoring and eligibility.

The worker currently loads the full regional graph once and builds a field for
the selected configuration, reusing the graph for corridor and reference routing.
It cannot use a field baked for another profile. This moves full-graph loading
before the first result; profile-specific field caching is a future optimization.

Model-4 packs are required by the app. Older installed regions prompt for an
update. Road/Gravel/Touring/Scenic retain their default attractions and keep steps
and ferries disabled until explicitly enabled. The Mountain wanderer example now
uses countryside and cycling-network attraction.

The new extract query is in `scripts/fetch_osm.py`. If an upstream snapshot is older
than the cached roads, `scripts/merge_osm_profiles.py` adds only the missing profile
layers, retaining newer road geometry/access and recording both source dates.
The manifest's `osmTimestamp` is the oldest contributing layer date; source hashes
and individual layer dates are retained under `source.layers`. No deleted highway
is restored from the older extract.

Data conventions: [OSM cycling routes](https://wiki.openstreetmap.org/wiki/Cycle_routes),
[OSM ferries](https://wiki.openstreetmap.org/wiki/Tag:route%3Dferry), and
[OSM land use](https://wiki.openstreetmap.org/wiki/Key:landuse).
