# Routing profiles

A profile is one `*.profile.json` file in this directory. It is complete: every field it
needs is in it, nothing is inherited, and what you export is exactly what routed. Send one
to someone and it means the same thing on their machine as on yours.

The app bundles every `*.profile.json` here. Add a file and rebuild to ship another.
Browser users can edit, import and export profiles in **Configure**; saved profiles live
in IndexedDB under `routing-profiles` and shadow a shipped profile with the same `id`.

> Profiles written for the old format (`version: 1`, a `bike` key, `attraction` /
> `capabilities` / `access` / `costs` groups) cannot be converted. Their meaning lived in
> `master.json` and a bike preset that no longer exist, so they are discarded on load
> rather than guessed at.

## Shape

```jsonc
{
  "format_version": 2,
  "id": "gravel_40",                 // lowercase, digits, - and _
  "name": "Gravel 40 mm",
  "description": "…",
  "setup": {
    "preset": "gravel_40 / expert",  // a label only — never looked up
    "bike":  { "tire_mm": 40, "mass_kg": 11.5, "lowest_gear_ratio": 0.85,
               "suspension": "none", "load_kg": 3 },
    "rider": { "mass_kg": 75, "sustained_w_per_kg": 3.2,
               "tech_skill": 0.7, "descend_confidence": 0.7 }
  },
  "preferences": { "detour": "prefer", "traffic_stress": "strongly_avoid", … },
  "permissions": { "ferry": true, "stairs": true, "push": true }
}
```

## Setup

`setup` describes the bike and the rider, not the route. It exists so that nobody has to
answer "what is the steepest grade you can ride?" — a question whose real answer is "it
depends on my gearing, my load and how far up the climb I already am".

| Field | Means |
| --- | --- |
| `tire_mm` | Nominal tire width. Sets rolling resistance, wheel size, and how much rough ground the bike shrugs off. |
| `mass_kg` (bike) | Frame, wheels and fittings, without luggage. |
| `lowest_gear_ratio` | Chainring teeth over largest cog; 34/40 is `0.85`. The number that decides whether a steep climb is rideable at all. |
| `suspension` | `none`, `front` or `full`. |
| `load_kg` | Luggage and water. Costs more on rough and technical ground than on a gradient. |
| `mass_kg` (rider) | With clothing and shoes. |
| `sustained_w_per_kg` | Power held for the length of a climb, per kilo of rider. Roughly FTP/mass: 1.9 casual, 3.2 strong, 4.3 racing. |
| `tech_skill` | 0–1, handling on loose, steep or broken ground. |
| `descend_confidence` | 0–1, willingness to let the bike run downhill. Independent of fitness. |

The Configure tab offers bike and rider presets. Choosing one **copies its numbers into
the file**; it does not leave a reference behind. `setup.preset` records where they came
from so the form can say so, and reads `custom` once any value is edited by hand. This is
deliberate: a profile that referenced a preset by name would change meaning whenever the
app's preset table did, which is the problem the old inheritance had.

From `setup` the app derives directional soft thresholds — `comfortable_until` and
`high_cost_at` for uphill grade, downhill grade, technical difficulty and surface
roughness (`src/routing/capability.ts`). Uphill comes from a steady-state power balance
solved for speed, so lower gearing and lighter luggage genuinely raise it. The rest are
calibrated heuristics and are labelled as such in the code: there is no honest physics for
how steep a descent a given rider will commit to. Configure shows the result in words.

## Preferences

Nine knobs, one vocabulary: `strongly_avoid`, `avoid`, `neutral`, `prefer`,
`strongly_prefer`. Each is scored against what an ordinary way looks like
(`REFERENCE` in `src/routing/vocabulary.ts`), so a preference both penalises and rewards:
"strongly avoid traffic" makes a main road expensive *and* makes the quiet lane cheap.

- `detour` — how much the line matters against the distance. It is the price ratio between
  an ideal way and an ordinary one: at `prefer` 2.5 km of the ground you asked for costs
  the same as 1 km of ordinary road, at `strongly_prefer` 4 km, at `neutral` 1.5 km. It is
  not a cap on route length — a route is as long as the good line it follows — and it also
  widens the search corridor so that line is reachable. This is the knob that decides
  whether the app explores or commutes.
- `traffic_stress` — estimated from road class and cycle infrastructure in the pack, not
  from live traffic. Avoiding it does two things: it scores ways like every other
  preference, and it charges stress above a tertiary as a hazard outside the detour
  budget (`ENGINE.traffic`), so a rider who strongly avoids traffic is kept off primary
  and secondary roads even with `detour` at `avoid`. A signed cycle route calms the
  road-class estimate (`ENGINE.network_calming`), since class alone cannot tell the quiet
  signed departmental road from the lorry route beside it.
- Unpaved ground with no mapped `surface` is never rewarded, but a rider who avoids
  unpaved pays a share of the likely penalty (`ENGINE.unpaved_guess_share`): an untagged
  `tracktype=grade2` otherwise priced like asphalt for a 28 mm tyre.
- `unpaved` — gravel, track and dirt, where the ground is actually described: a `surface`
  tag, or `tracktype` grade2–5. An unsurveyed way is never *rewarded* as unpaved; guessing
  would hand out credit for silence, and a barely tagged path should not beat a mapped
  gravel track.
- `roughness` — how broken the surface is, from `surface`, `smoothness` and `tracktype`,
  judged against what this bike rides comfortably (`surface_roughness.comfortable_until`
  from `setup`). "Avoid roughness" on 50 mm tyres does not mean avoid gravel roads.
- `technicality` — mapped MTB and hiking difficulty, judged separately uphill and down.
- `climbing` — whether height gain is the point or the price. Unlike the others this
  scales a cost that already exists (`ENGINE.climb_effort`, 5 equivalent metres per metre
  climbed): `strongly_prefer` pays 0.4× of it, `strongly_avoid` 1.6×.
- `scenic` — the better of proximity to viewpoints, peaks, forest and good ground (decayed
  backwards along the direction of travel) and the way's own forest cover and gravel
  quality. Proximity alone rated every road beside a wood like the path through it. It
  selects between lines; it does not invent landmarks or promise a particular detour
  length. Castles and other historic sites are not in the pack yet.

A preference you *prefer* is credited in full where a way has it. Merely lacking something
you *avoid* is credited at `REWARD_SHARE`, so a smooth main road cannot collect a reward
for every defect it does not have. Off the street network, a way whose ground neither
`surface` nor `tracktype` describes earns only `ENGINE.unsurveyed_credit` of any credit —
the forest around a bare footpath says nothing about whether it can be ridden — while
its defects are charged in full.
- `urbanity` — how built-up the surroundings are, from land use and settlement density. A
  quiet residential street has low traffic stress and high urbanity.
- `cycle_infrastructure` — membership of mapped cycle and MTB route relations.

## Permissions

`ferry`, `stairs`, `push`. Only `ferry` can remove a connection — a crossing you will not
take is genuinely not available. Refusing stairs or pushing makes them a last resort
instead: a rider can always get off and walk, and no preference is allowed to make a
destination unreachable.

## What can and cannot exclude a way

| | Example | Effect |
| --- | --- | --- |
| Hard constraint | `bicycle=no`, `foot=no` on ground that must be walked, `smoothness=impassable`, a highway class bikes may not use | Excluded |
| Permission | `ferry: false` | Excluded. `stairs`/`push: false`: priced as a last resort |
| Capability | A very steep loose climb | Cost rises steeply, and keeps rising. Never excluded |

The old model made grade, MTB scale, SAC scale, smoothness, tracktype and surface into
hard limits that deleted edges, so a preference could return `no-path`. Three unsampled
road bridges once stranded the whole Voirons massif from every profile that set a grade
limit. `tests/detour.test.ts` now asserts the opposite guarantee: every shipped profile,
every detour level and every combination of permissions must find a route.

## How a way is priced

Cost is in equivalent metres, at a rate that can fall below 1:

```
cost = length × (1 + hard) × budget_ratio ** tanh(net / NET_SCALE)
```

`net` is the weighted mean of how well the way matches the preferences you actually
expressed — `neutral` contributes nothing and does not dilute the rest. `hard` carries
what is not a matter of taste: being past your capability, unsurveyed ground, severed
fragments, the effort of climbing, and — for a rider who avoids it — traffic above an
ordinary way:

```
excess  = max(0, (stress − traffic_from) / (1 − traffic_from))
traffic = ENGINE.traffic × |strength| × excess²
```

`traffic_from` is a tertiary's stress, so at `strongly_avoid` a primary road pays about
1.6 on its rate, a secondary 0.6, and a tertiary nothing. It sits in `hard` because the
preference factor is capped by the detour budget: before it existed, a stress-0.95
primary cost at most `budget_ratio` times its length, and signed route 23 at Machilly
lost to 1.1 km of Route du Pays de la Côte by 2%. A first version started at an ordinary
way instead and charged every tertiary 0.4 — which are the quiet roads riders here
choose — and sent a road rider to Saxel over the Voirons on unmapped gravel. A way you like costs **less than its own length**,
which is what lets a detour pay for itself; the old model charged full distance and only
ever discounted the penalties on top of it, so the cheapest possible edge still cost its
own length and no scenic line could ever beat a shorter plain one.

`REFERENCE` and `NET_SCALE` are calibrations measured against a real release, not
constants of nature. Re-measure them with `npx tsx scripts/audit_signals.ts` whenever the
builder changes how a signal is derived.

## Tuning and inspection

- `npx tsx scripts/audit_signals.ts [graph] [profile-id]` — signal distributions against
  the current `REFERENCE`, and the resulting spread of rates.
- `npx tsx scripts/audit_route.ts` — per-edge costs along a chosen route.
- `npx tsx scripts/ablation.ts` — routes with individual signals disabled.
- `npm run benchmark` — search cost per profile.

Configure's diagnostics show the compiled profile for the last route, so `prefer` is never
a claim the app makes without showing the number behind it.

Data conventions: [OSM cycling routes](https://wiki.openstreetmap.org/wiki/Cycle_routes),
[OSM ferries](https://wiki.openstreetmap.org/wiki/Tag:route%3Dferry), and
[OSM land use](https://wiki.openstreetmap.org/wiki/Key:landuse).
