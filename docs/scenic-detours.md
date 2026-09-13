# Scenic destination experiment

The first stage adds a bounded destination search after full-graph routing. It is
enabled when both scenery and detouring are `prefer` or `strongly_prefer`. The
existing profile JSON and model-4 packs remain compatible.

The old objective could only discount individual edges. A great destination could
lose because reaching it required ordinary connecting roads. The new search tries
up to eight geographically distinct scenic destinations, routing through each with
the existing restriction-aware path finder. It preserves ordered user waypoints.
The worker now also uses the profile's corridor width instead of a fixed ladder.

Candidates use model-4 reward sources: reward 1 identifies a viewpoint/peak source
neighbourhood, whereas forest and gravel sources peak at 0.5 and 0.7. Accessible,
comfortable tracks with documented ground take precedence for an unpaved-preferring
profile. Unsurveyed footpaths cannot seed a destination. These are approximate
source neighbourhoods, not exact POI coordinates; the current pack does not retain
POI identities, and preprocessing seeds both endpoints of nearby edges.

Each route receives at most one scenic bonus, capped at 3,000 equivalent metres
and 20% of baseline distance, scaled by the scenic and detour preferences. Travel
cost stays unchanged; `experience.score` subtracts the bonus for selection only.
The same destinations and reward apply to the baseline and all candidates. This
avoids rewarding laps or the number of graph edges. Candidate routes cannot add
more than 50% distance, more than one metre of modeled pushing, or more than 100 m
of repeated geometry. Candidate searches share a 1.5-million-state budget by
default; if they fail or exhaust it, the successful baseline remains available.

This is a heuristic, not a global maximum-fun solution. It explores one additional
destination per candidate and rewards the best visited destination once. It does
not yet optimize sequences of highlights or reward sustained gravel independently
of the existing edge costs. It also cannot correct an incorrect terrain model or
certify rideability from missing OSM tags.

## Coudry acceptance case

Run:

```sh
node --import tsx scripts/gen_coudry_fixture.ts
node --import tsx scripts/audit_coudry.ts tests/fixtures/coudry-graph.json.gz data/tracks/reference/fillinges_casino_annemasse_optimal_gravel.gpx
```

On release `g4-20260909-p5-20d228e2`, using Gravel 50 mm and the supplied endpoints:

| Measurement | Baseline | Scenic exploration |
| --- | ---: | ---: |
| Distance | 14.95 km | 16.46 km |
| Travel cost | 22,149 | 22,492 |
| Route length within 40 m of supplied GPX | 79.2% | 92.8% |
| Modeled pushing | 2.6 m | 2.6 m |

The supplied GPX measures 15.99 km and has a slightly different final endpoint.
The new route visits Coudry, uses the grade-2 track and Chemin des Vignes de Truaz
towards the Menoge, and avoids Chemin du Bois des Milieux. It is not an exact GPX
match. Proximity figures use length-weighted segment midpoints, not map-matched
topological agreement. Audit GPX and JSON outputs stay in ignored
`data/derived/coudry-audit/`; personal GPX is never bundled into the app or fixture.

The same result was verified on a larger 184,126-edge graph covering the application's
search area. Baseline plus exploration took about 18 seconds locally, versus about
2.5 seconds on the smaller fixture. Reusing search preparation and pruning candidates
are performance work still to do before treating this as a fast mobile planner.

## Next experiments

1. Preserve explicit POI identity/location and derive connected gravel stretches
   during preprocessing. Score a stretch's usable length, continuity, surface
   confidence, road crossings, traffic and directional difficulty. Search several
   combinations of these stretches and panoramas within a trip distance budget.
2. Use the ride archive to rank candidate routes and stretches. Map-match rides;
   compare ridden lines with plausible alternatives between the same anchors.
   Keep overlapping rides and repeated corridors together when splitting training
   and evaluation data. Hold out entire geographic areas as well as activities.
3. Learn preference weights or a small route-ranking model first. Export compact
   derived scores for offline use, retain access and capability checks, and report
   confidence where the archive has little coverage. A ridden route is positive
   evidence, but an unvisited alternative is not automatically a bad route.

Keep Coudry as one acceptance case alongside held-out road, gravel and trail cases;
do not train and evaluate on the same ideal rides.
