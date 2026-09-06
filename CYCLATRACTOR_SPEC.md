# Cyclatractor — Product & Technical Specification

> **Status:** working specification / architecture proposal  
> **Target:** `https://fxi.io/cyclatractor/`  
> **Primary platform:** mobile web, installable PWA, routing on-device  
> **Core idea:** **semantic field → candidate corridor → topological graph → valid route**

## Implementation baseline — September 2026

The executable comparative prototype is documented in `README.md`. This section takes precedence over the exploratory alternatives below for the current implementation.

- **Study area:** Geneva basin `[5.80, 45.95, 6.55, 46.45]`, with Geneva–Salève–Voirons scenarios and coherent French/Swiss OSM topology.
- **Reference:** full-region Dijkstra. **Experiment:** 700 m raster Dijkstra, graph-chunk selection, exact restricted graph search, and corridor expansion at 2, 5 and 12 cells before full coverage. Both use the same positive cost decomposition. A valid corridor result is not assumed globally optimal.
- **Execution:** TypeScript workers first. New requests terminate obsolete computations; no GPU or WASM dependency. Compare elapsed time, explored states, actual compressed graph bytes read, cost and expansion count.
- **Costs:** directional slope samples, surfaces, deterministic road-stress proxies, uncertainty and 1 km reachable low-stress network utility. Attraction discounts are capped at 65%, retaining positive costs. Personalization is disabled in the baseline.
- **Topology:** stable OSM node IDs, directed bicycle access, node/via-way turn restrictions, incoming-edge state and edge-split waypoint snapping. Unsupported conditional rules are handled conservatively, with exclusion counts in build metadata.
- **Data:** Python uses `uv`; scripts live in `./scripts`. Private source traces stay in `data/`. Deduplication, gap splitting, boundary clipping, matching confidence and overlap-grouped evaluation are explicit preprocessing stages.
- **Offline:** checksummed immutable packs, gzip-JSON graph chunks with `.bin` names, PMTiles basemap, local source attribution, staged/resumable file downloads, OPFS with IndexedDB fallback, and a scoped production service worker. No external fonts or sprites are required by the minimal basemap.
- **Publication:** build-time S3 credentials only. `VITE_REGION_MANIFEST` selects the public pack. The reserved optional MapTiler setting is `VITE_MAPTILER_API_KEY`.
- **Acceptance:** automated software and desktop browser checks plus geographic benchmarks. Physical iPhone memory, battery and persistence must be measured separately; browser emulation is not equivalent to a real-device pass.

The remaining sections retain the long-term vision. Optional GPU backends, terrain archives for map relief, advanced alternatives, navigation and learned personalization are subsequent experiments rather than claims about the current build.

---

## 0. Executive summary

Cyclatractor is an experimental bicycle routing application designed around a simple observation:

> A competent cyclist does not read a map as a list of graph edges. They recognize valleys, continuous networks, unpleasant arterial roads, slopes, barriers, surfaces, bridges, tunnels, and promising corridors — then refine the route locally.

Cyclatractor attempts to reproduce this mode of reasoning.

Instead of treating routing exclusively as a shortest-path query on a static weighted graph, the application maintains a **semantic, contextual and multi-resolution cost field** over the territory. This field expresses where cycling is attractive, stressful, physically costly, uncertain, or impossible.

The field does **not** replace topology.

The core architectural rule is:

> **The field chooses the territory; the graph chooses the path.**

The routing pipeline is therefore hybrid:

1. Read local map/network/terrain data.
2. Build or combine semantic cost layers on-device.
3. Propagate a coarse potential between route anchors.
4. Extract one or more plausible routing corridors.
5. Load/refine the sparse topological graph only where useful.
6. Run the final graph search locally.
7. Expand the corridor automatically if the coarse model was wrong.
8. Explain the result to the user through the same semantic layers that guided it.

The application is **mobile-first and offline-first**. Once a region pack has been downloaded, placing waypoints, recalculating routes, inspecting elevation, exporting GPX, and rerouting must not require a network connection.

The long-term objective is not simply to reproduce an existing cycling router. It is to build a routing engine whose behavior is spatial, contextual, inspectable, and close to how a human reasons while looking at a good map.

---

# 1. Product vision

## 1.1 North star

> **Produce the route that a competent cyclist might choose after carefully studying a good map.**

Cyclatractor should optimize for *plausibility* and *human usefulness*, not merely shortest distance or a single opaque global score.

A good route should often:

- follow continuous cycling-friendly networks;
- avoid unnecessary exposure to large roads;
- recognize useful valleys and passes;
- avoid isolated fragments of cycle infrastructure;
- understand that steepness is directional;
- distinguish paved, gravel and rough surfaces;
- preserve valid topology at bridges, tunnels and grade-separated crossings;
- account for uncertainty in incomplete map data;
- react smoothly to soft user guidance;
- remain usable without connectivity.

---

## 1.2 Product principles

### Routing on device

Routing is performed locally after the required regional data has been downloaded.

No routing API is required for normal operation.

Online services may be used for:

- initial map/data download;
- optional traffic-data updates;
- optional map search/geocoding;
- application updates;
- region-pack updates.

They must not be required to calculate or recalculate a route already covered by downloaded data.

---

### Mobile first

The primary usage context includes:

- weak mobile connectivity;
- complete loss of connectivity;
- mountain valleys;
- long bicycle trips;
- one-handed interaction;
- battery constraints;
- limited memory;
- limited storage;
- older/mobile GPUs.

Desktop is supported, but architecture and UX decisions should be validated on mobile first.

MapOut is a useful product benchmark for the feeling that the map remains genuinely useful when the network disappears.

---

### Offline first, not “offline eventually”

Offline mode is a first-class state of the application.

The UI should explicitly communicate:

- which areas are available offline;
- pack size before download;
- pack version/date;
- whether routing is currently fully offline-capable;
- which optional data layers are unavailable;
- available storage;
- update availability.

The application should never silently become unusable because a remote tile endpoint is unavailable.

---

### Explainable routing

The same factors used by the routing engine should be inspectable by the user.

Examples:

- network attraction;
- traffic/stress;
- slope/effort;
- unpaved/rough surface;
- uncertainty;
- barriers;
- candidate route corridor.

The user should be able to answer:

> “Why is it sending me there?”

without needing to understand the underlying algorithm.

---

### Progressive refinement

Long routes should not require loading and evaluating every local street between A and B.

Routing should work coarse-to-fine:

```text
country / region
      ↓
coarse potential
      ↓
candidate corridor(s)
      ↓
regional network
      ↓
local topology
      ↓
final route
```

Resolution is selected by the routing engine, not by the map camera zoom.

---

# 2. Non-goals

The first implementation is **not** intended to:

- build a globally complete server-side routing service;
- compete on turn-by-turn navigation immediately;
- perfectly model real-time traffic;
- infer every missing OSM attribute;
- guarantee a mathematically globally optimal route under an arbitrarily complex semantic cost function;
- replace OSM topology with pixels;
- continuously run expensive GPU computation every animation frame;
- require WebGPU for basic functionality.

The initial goal is to validate the routing model and user interaction.

---

# 3. Conceptual model

## 3.1 Three parallel representations

Cyclatractor should maintain three distinct but synchronized representations of the same territory.

### A. Human map

A conventional readable map:

- roads;
- paths;
- cycling infrastructure;
- labels;
- land use;
- terrain;
- hillshade;
- contour lines;
- route;
- waypoints;
- offline-region status.

Primary renderer: **MapLibre GL JS**.

---

### B. Machine semantic field

A raster/tiled field used for coarse spatial reasoning.

Conceptually:

```text
attractive                               repulsive
████████████▓▓▓▓▓▓▒▒▒▒▒▒░░░░░░.........XXXXXXXX
```

Possible channels:

| Channel | Meaning |
|---|---|
| Network utility | presence and continuity of useful cycling network |
| Traffic stress | expected exposure to motor traffic |
| Physical effort | elevation/slope-related cost |
| Surface | paved / compact / gravel / rough / unknown |
| Barrier | impossible or strongly discouraged areas |
| Uncertainty | incomplete or ambiguous source data |
| Context | rider/profile-specific dynamic weighting |

This is a **semantic field**, not merely a visualization heatmap.

---

### C. Sparse topology graph

The graph determines where movement is actually possible.

It must preserve at least:

- intersections;
- non-intersections at different levels;
- one-way restrictions;
- bicycle access;
- bridge/tunnel/layer semantics;
- barriers;
- stairs;
- ferries;
- cycleway connections;
- routing portals across tile boundaries.

This prevents impossible raster shortcuts at:

- bridges;
- tunnels;
- railways;
- rivers;
- motorways;
- stacked roads;
- crossing lines that do not intersect.

---

# 4. Core routing rule

```text
semantic field
      ↓
where should we search?
      ↓
candidate corridor
      ↓
topological graph
      ↓
where can we actually go?
      ↓
valid final route
```

The semantic field may be approximate.

The final topology may not.

---

# 5. Semantic cost model

## 5.1 General form

For position `x`, direction `d`, rider context `c`, and routing resolution `L`:

\[
C(x,d,c,L) =
w_n C_{network}
+ w_t C_{traffic}
+ w_s C_{slope}
+ w_r C_{road}
+ w_q C_{surface}
+ w_b C_{barrier}
+ w_u C_{uncertainty}
+ w_p C_{preference}
\]

The model is contextual:

\[
C = C(x,d \mid bike, trip, conditions, profile)
\]

The weights are profile-dependent.

Examples:

```text
road
gravel
touring
cargo
e-bike
```

Later:

```text
commute
leisure
training
bikepacking
wet conditions
winter
night
```

---

## 5.2 Network attraction

A cycling facility is not useful merely because it exists nearby.

A short isolated cycleway fragment should generally be less attractive than a segment belonging to a coherent network.

Useful precomputed features may include:

- connected-component reach;
- reachable network length within 1 / 5 / 20 / 50 km;
- local degree/connectivity;
- dead-end penalty;
- continuity score;
- frequency of facility-type changes;
- connection quality at segment endpoints;
- relationship to regional/national cycling networks;
- local centrality;
- access to useful crossings and bridges.

Conceptually:

\[
NetworkUtility(e,L) =
f(reach_L, connectivity_L, continuity_L, deadEnds_L)
\]

This is expected to be one of Cyclatractor's key differentiators.

---

## 5.3 Traffic stress

V0 can use OSM-derived proxies:

- `highway`;
- speed limit;
- number of lanes;
- cycleway presence;
- cycleway separation;
- road hierarchy;
- residential/service status;
- crossings;
- access restrictions.

Later versions can merge historical traffic observations.

Historical traffic should modify the cost model, not become a hard dependency.

Traffic-related data must be timestamped/versioned inside region packs.

---

## 5.4 Slope and physical effort

Slope is directional.

A static scalar “steepness” layer is insufficient:

```text
+10% uphill != -10% downhill
```

Terrain data provides elevation/gradient.

Directional edge cost is calculated from:

- elevation delta;
- segment length;
- local grade;
- possibly grade distribution along the segment.

V0 should use a deliberately simple non-linear penalty curve, configurable by profile.

Example qualitative behavior:

```text
0–2%     near-neutral
3–5%     increasing cost
6–8%     strong cost
9–12%    very strong cost
>12%     profile-dependent severe penalty
```

Do not freeze these values as universal truths. They must remain testable profile parameters.

For e-bikes, the slope curve can be significantly flatter.

---

## 5.5 Surface

Useful categories:

```text
paved
smooth compact
fine gravel
gravel
rough track
singletrack
stairs
unknown
```

Surface is strongly profile-dependent.

A gravel profile may treat compact gravel as attractive.

A road profile may strongly penalize it.

Unknown surface should interact with **uncertainty**, not automatically imply “bad”.

---

## 5.6 Uncertainty

OSM quality is heterogeneous.

Cyclatractor should represent uncertainty explicitly.

Example:

```text
highway=track
surface=?
smoothness=?
bicycle=?
```

Instead of pretending the cost is perfectly known:

```text
cost = 1.4
confidence = 0.35
```

A risk-averse profile can apply:

\[
C' = C + \lambda(1-confidence)
\]

where `λ` depends on context.

Example:

```text
adventurous gravel       low uncertainty penalty
touring with luggage     medium penalty
cargo / child trailer    high penalty
```

This also gives the UI a meaningful way to say:

> “This segment may be good, but the underlying data is incomplete.”

---

# 6. Multi-resolution routing

## 6.1 Routing resolution is not map zoom

Do **not** bind routing precision directly to camera zoom.

Otherwise:

```text
user zooms out
→ routing model changes
→ route unexpectedly changes
```

Instead maintain a routing-specific level of detail.

Routing resolution depends on:

- A–B distance;
- complexity of the territory;
- candidate corridor width;
- network density;
- uncertainty;
- failure to find valid topology.

Example:

```text
200 km route
    ↓
2 km semantic cells
    ↓
30 km candidate corridor
    ↓
250 m semantic cells
    ↓
5 km refined corridor
    ↓
exact graph search
```

---

## 6.2 Coarse-to-fine algorithm

Initial proposal:

1. Snap start/end to plausible nearby network.
2. Select initial semantic resolution.
3. Evaluate/assemble cost field around the broad A–B region.
4. Propagate cost/potential.
5. Extract the best `N` broad corridors.
6. Load graph tiles intersecting those corridors plus safety margin.
7. Refine semantic field where necessary.
8. Score graph edges.
9. Run A* / Dijkstra variant.
10. Validate route.
11. If route fails or is suspicious, expand corridor and retry.
12. Produce alternatives through distinct corridors where possible.

Important:

> The corridor is initially a **soft search prior**, not a permanent hard clipping boundary.

If the field makes a wrong coarse assumption, the graph search must be allowed to progressively escape it.

---

# 7. Waypoints as attraction, not only hard constraints

Cyclatractor should support two waypoint types.

## Hard waypoint

The route must pass through the selected point/network location.

Useful for:

- required stop;
- exact bridge;
- exact town;
- known pass.

---

## Soft waypoint / attraction point

The point modifies the semantic potential around a region.

Conceptually:

\[
C'(x)=C(x)+W(x)
\]

where `W(x)` is a negative/attractive radial function around the waypoint.

This allows an interaction closer to:

> “Take me more through here.”

rather than:

> “Pass through this exact coordinate.”

Potential UX:

- tap: hard waypoint;
- drag route/corridor: create soft attraction;
- long press: choose attraction radius/strength;
- remove/reset easily.

The route should deform smoothly where possible.

---

# 8. On-device architecture

## 8.1 Runtime components

```text
┌──────────────────────────────────────────────────┐
│ React UI                                         │
│ controls / profile / packs / route information  │
└───────────────────────┬──────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────┐
│ MapLibre GL JS                                  │
│ human-readable map + route visualization        │
└───────────────────────┬──────────────────────────┘
                        │
                route state/events
                        │
        ┌───────────────┴───────────────┐
        │                               │
┌───────▼─────────┐           ┌─────────▼──────────┐
│ Routing Worker  │           │ Cost Field Worker  │
│ graph + A*      │           │ WebGPU/WebGL/WASM  │
│ edge scoring    │           │ coarse propagation │
└───────┬─────────┘           └─────────┬──────────┘
        │                               │
        └───────────────┬───────────────┘
                        │
              local data abstraction
                        │
┌───────────────────────▼──────────────────────────┐
│ Offline Region Store                            │
│ graph / machine tiles / terrain / metadata      │
│ OPFS + IndexedDB metadata                       │
└──────────────────────────────────────────────────┘
```

---

## 8.2 Main-thread rule

The main UI thread should not perform:

- graph search;
- large tile decoding;
- terrain sampling;
- cost propagation;
- region-package indexing;
- GPX simplification for very large tracks.

These belong in workers.

The UI should remain interactive while route calculation is in progress.

---

# 9. WebGPU strategy

WebGPU is attractive for:

- large parallel cost-field operations;
- raster combination;
- gradient evaluation;
- iterative propagation;
- corridor mask generation.

However **WebGPU must not be mandatory in V0**.

As of September 2026, MDN still classifies WebGPU as having limited availability rather than Baseline support.

Required backend abstraction:

```ts
interface CostFieldBackend {
  initialize(): Promise<void>
  buildField(input: FieldInput): Promise<FieldResult>
  propagate(input: PropagationInput): Promise<CorridorResult>
  dispose(): void
}
```

Candidate backends:

```text
WebGPUBackend       preferred when supported
WebGL2Backend       possible GPU fallback
CpuWasmBackend      reliable compatibility fallback
```

---

## 9.1 MapLibre/WebGPU separation

MapLibre GL JS currently renders through WebGL2.

Do not design V0 around direct WebGPU ↔ WebGL texture sharing.

Treat the semantic compute surface and the visible map renderer as separate subsystems.

Possible visualization strategies:

1. WebGPU computes low-resolution semantic result, transfers a display raster to MapLibre.
2. Separate transparent WebGPU canvas is composited over/under the MapLibre canvas.
3. WebGL2 backend renders directly as a MapLibre custom layer.
4. Debug builds expose a dedicated “machine map” view.

The routing engine must not require visualization of the field to function.

---

## 9.2 Avoid permanent recomputation

“Continuously updated” should mean **reactive**, not “compute every frame”.

Recompute when:

- waypoint changes;
- profile changes;
- relevant routing region changes;
- region data becomes available;
- significant parameter changes occur.

Use:

- debounce;
- cancellation via `AbortController`;
- generation IDs;
- incremental tile updates;
- cached intermediate fields.

This is essential for battery life.

---

# 10. Final graph search

## 10.1 Graph representation

The graph can be much sparser than raw OSM geometry.

Keep nodes primarily at:

- decisions/intersections;
- restriction boundaries;
- meaningful attribute changes;
- barriers;
- bridge/tunnel portals;
- ferry terminals;
- region/tile portals.

Keep simplified geometry on edges for rendering/elevation sampling.

Edge attributes should include enough information to calculate contextual cost locally.

Candidate fields:

```ts
type EdgeAttributes = {
  length: number
  access: number
  direction: number
  roadClass: number
  cycleInfrastructure: number
  maxSpeed?: number
  lanes?: number
  surface: number
  smoothness?: number
  bridge: boolean
  tunnel: boolean
  layer: number
  elevationGain?: number
  elevationLoss?: number
  networkUtility: number
  uncertainty: number
}
```

This is conceptual, not the final binary schema.

---

## 10.2 Graph tile boundaries

Graph tiles require explicit cross-tile topology.

Use stable portal IDs at tile boundaries.

Never reconstruct connectivity only from geometric proximity.

The following geometry:

```text
────────────
     |
────────────
```

must not imply an intersection unless topology says it is connected.

---

## 10.3 Binary format

V0 recommendation:

- define a versioned **Cyclatractor Graph Tile** binary format;
- store quantized coordinates;
- CSR-like adjacency arrays;
- bit-pack common categorical attributes;
- keep attribute arrays columnar where practical;
- decode into TypedArrays;
- transfer ArrayBuffers to routing workers.

Possible encodings to evaluate:

- custom versioned binary;
- FlatBuffers;
- Protocol Buffers;
- MVT-derived network tile + separate topology index.

Do not optimize prematurely; define a benchmark first.

A simple decoder and stable versioning are more valuable than maximum compression in the first prototype.

---

# 11. Data sources

## 11.1 OpenStreetMap

Primary semantic/topological network source.

Relevant feature families include:

- roads;
- cycleways;
- paths/tracks;
- access;
- bicycle access;
- surfaces;
- smoothness;
- speed;
- lanes;
- bridge/tunnel/layer;
- barriers;
- ferries;
- route relations.

OSM preprocessing should happen outside the mobile device.

The generated region packs are the runtime input.

---

## 11.2 Mapterhorn

Mapterhorn is a strong terrain candidate.

It currently provides:

- Terrarium-encoded DEM tiles;
- 512 px WebP tiles;
- PMTiles archives;
- area extracts;
- a Z/X/Y HTTP endpoint.

Use cases:

- elevation sampling;
- slope;
- hillshade;
- contours;
- coarse terrain barrier/effort layers.

Reference:

- https://mapterhorn.com/
- https://mapterhorn.com/data-access/
- https://github.com/mapterhorn/mapterhorn

Attribution/licensing requirements must be preserved in offline packs and the UI.

---

## 11.3 MapTiler

MapTiler is a candidate for the online/default human-readable basemap.

Configuration:

```env
VITE_MAPTILER_KEY=...
```

Local development options:

```text
.env
.env.dev
```

If `.env.dev` is used, start Vite with a matching mode, e.g.:

```json
{
  "scripts": {
    "dev": "vite --mode dev"
  }
}
```

Also provide:

```text
.env.example
```

with no real key.

Important:

> A `VITE_*` value is embedded into the browser bundle and is **not a secret**.

The production MapTiler key should therefore be a public/client key restricted as tightly as the provider permits, including domain restrictions for `fxi.io`.

Production CI can inject:

```text
VITE_MAPTILER_KEY
```

from a GitHub Actions secret, but this only prevents committing the key to Git; it does not make the runtime browser key private.

Before implementing offline basemap downloads, explicitly verify MapTiler plan/licensing terms for the intended caching/offline usage.

---

## 11.4 Historical traffic

Not required for V0.

Potential later sources:

- public traffic count datasets;
- governmental open data;
- aggregated historical speed/volume data;
- user-contributed anonymized observations if a privacy-preserving model is ever designed.

V0 should validate the concept using deterministic OSM-derived road stress first.

---

# 12. Offline region packs

## 12.1 Principle

A region pack should be a coherent offline routing unit.

Example logical contents:

```text
region/
├── metadata.json
├── graph/
│   └── ...
├── machine/
│   ├── network-utility/
│   ├── road-stress/
│   ├── surface/
│   └── uncertainty/
├── terrain/
│   └── ...
└── basemap/
    └── ... optional
```

Logical structure does not require separate physical files.

A pack may internally use PMTiles or another archive/container.

---

## 12.2 Storage responsibilities

### Cache API

Use for:

- application shell;
- immutable JS/CSS assets;
- small fetched resources;
- opportunistic web tile caching where appropriate.

Do **not** make Cache API the sole storage mechanism for large managed region packages.

---

### IndexedDB

Use primarily for:

- pack metadata;
- indexes;
- user routes;
- preferences;
- download state;
- version information;
- small structured records.

A helper such as Dexie can be considered, but avoid making the routing core dependent on it.

---

### OPFS — Origin Private File System

Preferred browser storage candidate for:

- large region package blobs;
- downloaded PMTiles;
- graph archives;
- terrain archives.

Implement a storage abstraction so the backend can later be replaced.

```ts
interface RegionStore {
  list(): Promise<RegionMetadata[]>
  install(source: RegionSource): Promise<void>
  remove(id: string): Promise<void>
  open(id: string): Promise<RegionHandle>
  verify(id: string): Promise<VerificationResult>
}
```

---

## 12.3 Optional native shell

Start with a PWA.

If real-world iOS/Android testing shows that browser storage quotas, eviction behavior, large background downloads, or file handling materially damage the offline experience, preserve the option to wrap the same React application with **Capacitor**.

Native-shell mode could use:

- native filesystem;
- more predictable region-pack management;
- native share sheets;
- GPX import/export;
- background location later.

Do not introduce Capacitor before the web/PWA routing architecture works.

---

# 13. Map and tile protocols

Use MapLibre custom protocols where useful.

Target abstraction:

```text
https://...                 online source
pmtiles://...               remote/local packed source
cyclatractor://region/...   application-managed offline source
```

The map style should not care whether the underlying bytes came from:

- network;
- Cache API;
- OPFS;
- native filesystem.

This makes online/offline transitions explicit and testable.

---

# 14. Application stack

## Core

- **Vite**
- **React**
- **TypeScript**, `strict: true`
- **MapLibre GL JS**
- **MapTiler** for initial/default online map style/data
- **Mapterhorn** for terrain/DEM
- **Web Workers**
- **WebGPU**, optional accelerated backend
- **WebGL2**, MapLibre renderer and potential compute fallback
- **WebAssembly**, candidate for portable routing/CPU compute core
- **Service Worker / PWA**
- **Cache API**
- **IndexedDB**
- **OPFS**

---

## Suggested support libraries

Evaluate rather than blindly adopt:

- `pmtiles` — packed tile access;
- `vite-plugin-pwa` — PWA/service-worker integration;
- Workbox — service-worker primitives if needed;
- `Comlink` — ergonomic worker RPC;
- `Zod` — boundary/config/metadata validation;
- `Dexie` — IndexedDB convenience;
- `zustand` — lightweight UI/application state if React context becomes cumbersome;
- `@turf/*` — only for small client-side geospatial helpers, not core routing;
- `Vitest` — unit/property tests;
- `Playwright` — mobile/offline E2E tests.

Prefer small dependencies and direct TypedArray/data structures inside performance-critical routing code.

---

# 15. WASM strategy

A useful architecture boundary is:

```text
UI / Map          TypeScript
Data orchestration TypeScript
Routing kernel     Rust/WASM or optimized TypeScript initially
GPU field kernel   WGSL
```

Do **not** require Rust/WASM on day one.

Suggested sequence:

1. prototype graph search in TypeScript;
2. benchmark on mid-range phones;
3. profile bottlenecks;
4. move stable hot paths to Rust/WASM only when justified.

Potential WASM responsibilities:

- graph decoding;
- A*;
- route simplification;
- elevation aggregation;
- CPU cost propagation fallback.

Keep the wire format language-neutral from the start.

---

# 16. Threading model

Suggested workers:

```text
main
├── route.worker
│   ├── graph loading
│   ├── edge scoring
│   ├── A*
│   └── route alternatives
│
├── field.worker
│   ├── semantic tile assembly
│   ├── WebGPU when available
│   ├── propagation
│   └── corridor extraction
│
└── data.worker
    ├── pack verification
    ├── decompression
    ├── indexing
    └── terrain/network tile decoding
```

This may begin as one worker and split only when profiling justifies it.

Use:

- transferable `ArrayBuffer`s;
- explicit request IDs;
- cancellation;
- immutable result messages where practical.

Do not make the architecture dependent on `SharedArrayBuffer`; cross-origin isolation requirements can complicate a GitHub Pages deployment and third-party tile access.

---

# 17. State model

Keep UI state distinct from routing state.

Possible high-level state:

```ts
type AppState = {
  map: MapViewState
  routePlan: RoutePlan
  profile: CyclingProfile
  offline: OfflineState
  routing: RoutingStatus
  debug: DebugState
}
```

Persist:

- user profile;
- installed region metadata;
- route plans;
- optional track history;
- last map view.

Do not persist transient GPU buffers/corridor caches as application state.

---

# 18. Route profiles

V0 profiles:

## Gravel

Prefer:

- coherent gravel/low-traffic network;
- tolerable unpaved surfaces;
- moderate climbing;
- lower motor-traffic stress.

## Road

Prefer:

- paved roads;
- cycling infrastructure;
- low traffic;
- efficient continuity.

## Touring

Prefer:

- robust/known surfaces;
- lower uncertainty;
- continuous network;
- moderate gradients;
- avoid risky shortcuts.

Potential later profiles:

```text
cargo
e-bike
MTB
commute
training
```

Profiles are parameter sets over the same underlying semantic model, not separate routing implementations.

---

# 19. Route output

Each route should return more than a geometry.

```ts
type RouteResult = {
  geometry: ...
  distanceM: number
  ascentM: number
  descentM: number
  estimatedEffort?: number
  stressScore: number
  surfaceBreakdown: ...
  uncertaintyScore: number
  corridorId?: string
  explanations: RouteExplanation[]
}
```

Example explanations:

```text
+ follows 18 km of continuous low-stress network
+ avoids high-speed arterial road
+ 63% unpaved / gravel
- 2.1 km with uncertain surface
- one 11% climb
```

These explanations should be derived from real cost contributions, not generated as decorative prose.

---

# 20. Alternatives

Alternatives should ideally be **semantically distinct**, not merely tiny variations around the same line.

Examples:

```text
Fast
Quiet
Gravel
Low climbing
```

Internally, alternatives can be generated by:

- selecting distinct coarse corridors;
- penalizing already-used corridor cells/edges;
- varying profile weights within controlled limits;
- requiring minimum route dissimilarity.

Avoid presenting three routes that are 95% identical.

---

# 21. Human map / machine map debug mode

Development mode should expose a split or toggle:

```text
Human
Machine
Both
```

Machine layers:

- network attraction;
- road stress;
- slope;
- barriers;
- uncertainty;
- final combined cost;
- propagated potential;
- selected corridor;
- loaded graph tiles;
- explored graph nodes.

This is not only a visualization feature.

It is a primary debugging tool for the routing model.

A routing mistake should be diagnosable visually as one of:

```text
bad source data
bad semantic layer
bad profile weight
bad coarse corridor
bad topology
bad graph search
```

---

# 22. Mobile UX

## Primary interaction

Minimal map-first UI.

Suggested structure:

```text
┌────────────────────────────┐
│ search / status            │
│                            │
│                            │
│           MAP              │
│                            │
│      A ──────── B          │
│                            │
│                            │
├────────────────────────────┤
│ route summary              │
│ Gravel · 43 km · +820 m    │
│ [profile] [alternatives]   │
└────────────────────────────┘
```

Actions should be reachable by thumb and avoid persistent desktop sidebars.

---

## Offline status

Use explicit states:

```text
Online
Offline — routing data available
Offline — basemap partial
Offline — route leaves downloaded area
Downloading region…
Region update available
```

If a route exits available data:

- show the boundary;
- route as far as confidently possible only if useful;
- otherwise clearly explain that another offline region is required.

Never silently query a remote routing service as fallback.

---

# 23. PWA requirements

V0 should be installable.

Manifest:

- app name;
- icons;
- standalone display;
- theme/background;
- appropriate start URL under `/cyclatractor/`.

Service worker responsibilities:

- cache application shell;
- version static assets;
- provide deterministic offline startup;
- never cache API errors as successful tile responses;
- handle app upgrades safely.

Test:

1. open application online;
2. install/download a test region;
3. enable airplane mode;
4. hard-reload;
5. calculate a new route;
6. move a waypoint;
7. recalculate;
8. inspect elevation;
9. export GPX.

If this sequence fails, offline support is not complete.

---

# 24. Performance budgets

Initial engineering targets, to be measured and revised:

### Interaction

- pan/zoom remains fluid while no route calculation is occurring;
- waypoint drag feedback begins immediately;
- route calculation is cancellable;
- stale results never overwrite a newer request.

### Routing

After relevant region data is local:

- short/local reroutes should feel interactive;
- regional routes should resolve in seconds, not tens of seconds;
- memory usage must remain bounded through tiled loading/eviction;
- cost-field resolution should adapt to device capability.

Do not freeze arbitrary millisecond targets before device benchmarks exist.

Benchmark at minimum:

```text
recent high-end phone
mid-range Android
recent iPhone
older supported iPhone
desktop reference
```

---

# 25. Data/cache eviction

Use an explicit memory budget.

Runtime tile lifecycle:

```text
unloaded
→ loading
→ decoded
→ active
→ cached
→ evicted
```

Separate:

- GPU memory cache;
- decoded graph cache;
- binary region storage.

A downloaded offline pack is persistent user data and should not be silently deleted by Cyclatractor's own cache policy.

---

# 26. Failure modes to design for

## Raster creates impossible crossing

Mitigation: final graph topology.

## Candidate corridor misses only valid bridge/tunnel

Mitigation:

- encode coarse barriers/portals;
- margin around corridor;
- progressive corridor expansion;
- fallback broader graph search.

## OSM surface unknown

Mitigation: uncertainty model.

## WebGPU unavailable

Mitigation: backend fallback.

## Device low on storage

Mitigation:

- region size preview;
- pack management;
- graceful partial download cleanup.

## Network lost mid-download

Mitigation:

- resumable/chunked install;
- checksums/version manifest;
- atomic “installed” state.

## MapTiler unavailable

Mitigation:

- locally available base style/data where region pack supports it;
- routing does not depend on MapTiler.

## Terrain unavailable

Mitigation:

- route still works with slope contribution disabled/degraded;
- communicate degraded model.

## Worker crash / GPU device loss

Mitigation:

- restart worker/backend;
- downgrade backend;
- preserve current route plan in UI state.

---

# 27. Data preprocessing pipeline

Routing is on-device; preprocessing is not.

Suggested external pipeline:

```text
OSM extract
   ↓
normalize bicycle access
   ↓
build topology
   ↓
simplify graph
   ↓
compute network metrics
   ↓
derive static stress/surface/uncertainty attributes
   ↓
join terrain summaries where useful
   ↓
tile/package
   ↓
version manifest
   ↓
publish static region packs
```

This can run:

- in GitHub Actions for small/test regions;
- locally during development;
- later in a dedicated data-build environment for large regions.

Runtime route calculation remains local.

---

# 28. Region versioning

Every pack should expose:

```json
{
  "schemaVersion": 1,
  "regionId": "ch-vaud",
  "generatedAt": "...",
  "osmTimestamp": "...",
  "terrainSource": "...",
  "graphVersion": "...",
  "costModelCompatibility": "..."
}
```

Application startup checks:

```text
Can current app read this pack?
Is an update available?
Does update require a full pack replacement?
```

Do not let application releases silently invalidate all installed packs without a migration/version story.

---

# 29. Git repository structure

Proposed:

```text
cyclatractor/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── pages.yml
│
├── public/
│
├── scripts/
│   ├── build-region/
│   └── benchmarks/
│
├── src/
│   ├── app/
│   ├── map/
│   ├── routing/
│   │   ├── graph/
│   │   ├── cost/
│   │   ├── corridor/
│   │   ├── profiles/
│   │   └── alternatives/
│   ├── workers/
│   ├── offline/
│   ├── terrain/
│   ├── data/
│   ├── gpx/
│   └── debug/
│
├── tests/
│   ├── golden-routes/
│   ├── topology/
│   └── e2e/
│
├── .env.example
├── index.html
├── vite.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

Keep the routing engine independent from React where possible.

---

# 30. Deployment: fxi.io/cyclatractor

Target static deployment:

```text
https://fxi.io/cyclatractor/
```

Vite configuration must account for subpath deployment:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/cyclatractor/',
  plugins: [react()],
})
```

GitHub Actions:

```text
push main
   ↓
install locked dependencies
   ↓
lint
   ↓
typecheck
   ↓
unit tests
   ↓
build
   ↓
Playwright smoke test
   ↓
upload Pages artifact
   ↓
deploy GitHub Pages
```

Production variables:

```text
VITE_MAPTILER_KEY
```

configured through repository/environment secrets.

Again: browser tokens remain visible to the client after build.

---

# 31. CI quality gates

Required on pull request:

```text
TypeScript typecheck
ESLint
unit tests
routing golden tests
production build
```

Recommended:

```text
Playwright mobile viewport
PWA offline smoke test
bundle size report
routing benchmark comparison
```

A routing-performance regression should eventually be treated similarly to a code test regression.

---

# 32. Golden route test suite

This project needs a geographic test suite, not only software unit tests.

Build a curated set of routes in known terrain.

Initial Swiss categories:

```text
urban Lausanne / Genève / Bern / Zürich
peri-urban transitions
Jura
Plateau
Alpine valleys
mountain passes
Ticino
lake crossings
river crossings
rail/motorway barriers
gravel networks
forest tracks
```

Each scenario should record:

- A/B coordinates;
- optional attraction waypoint;
- expected viable corridors;
- forbidden/impossible shortcuts;
- expected qualitative behavior.

The assertion does not always need one exact polyline.

Useful assertions:

```text
must not use motorway
must cross river at one of these bridges
must remain within expected corridor
must avoid known disconnected cycleway
must prefer valley to steep ridge for touring profile
gravel profile should accept this track
road profile should reject/penalize this track
```

---

# 33. Synthetic topology tests

Create tiny artificial networks for bugs that are difficult to diagnose in real OSM.

Required fixtures:

```text
crossing roads without junction
bridge over road
tunnel under road
one-way edge
bicycle exception to one-way
barrier with bicycle access
steps
ferry
dead-end cycleway
parallel cycleway with valid connector
parallel cycleway without connector
tile-boundary portal
```

These tests protect the fundamental rule:

> geometry is not topology.

---

# 34. Cost-model testing

The cost model should be independently inspectable.

Given an edge and profile:

```ts
scoreEdge(edge, profile, context)
```

return both total and decomposition:

```ts
{
  total: 4.8,
  components: {
    distance: 1.0,
    traffic: 1.6,
    slope: 1.2,
    surface: 0.4,
    uncertainty: 0.6
  }
}
```

This supports:

- tests;
- route explanation;
- tuning;
- debug visualization.

Avoid a single opaque magic weight.

---

# 35. Instrumentation

Development builds should record:

```text
field build time
field resolution
GPU/CPU backend
corridor extraction time
graph tiles loaded
graph nodes/edges loaded
A* explored nodes
final route cost
fallback/expansion count
memory estimates
```

No analytics service is required for V0.

A local debug export can produce a JSON bundle for reproducing a routing issue.

---

# 36. Privacy

The offline-first architecture provides a natural privacy advantage.

By default:

- waypoint coordinates stay on-device;
- route calculations stay on-device;
- GPX stays on-device unless explicitly shared;
- downloaded regions do not imply route tracking.

If analytics is introduced later, geographic data should not be collected casually.

Explicit design review is required before sending route or location data to third parties.

---

# 37. Security

- never commit real API keys;
- validate downloaded pack manifests;
- use checksums for region packages;
- treat binary decoders as untrusted-input boundaries;
- enforce reasonable allocation limits before decoding;
- serve production over HTTPS;
- sanitize imported GPX metadata before rendering user-visible text.

---

# 38. Accessibility

Map-first does not mean map-only.

Provide textual equivalents for:

- route distance;
- ascent/descent;
- surface breakdown;
- stress;
- uncertainty;
- offline status;
- waypoint list.

Controls must have accessible labels and reasonable touch targets.

---

# 39. GPX

V0:

- GPX export;
- GPX import as reference track if inexpensive to add;
- preserve route geometry;
- optionally include elevation if known.

Later:

- compare imported GPX with Cyclatractor semantic field;
- “route like this track” corridor attraction;
- route-to-track matching.

---

# 40. Suggested implementation phases

## Phase 0 — architecture spike

Goal: prove the hybrid model.

Implement:

- MapLibre map;
- MapTiler style;
- Mapterhorn elevation;
- 2–3 synthetic semantic layers;
- small local graph fixture;
- field → corridor → graph routing;
- machine-map debug view;
- no production offline packs yet.

Success criterion:

> A route changes in an understandable way when network attraction, traffic stress, or slope weights change.

---

## Phase 1 — Swiss test region

Pick one region with:

- urban roads;
- hills;
- gravel;
- bridge/tunnel topology;
- enough variation to expose failures.

Implement:

- OSM preprocessing;
- graph tiles;
- region manifest;
- local region install;
- gravel/road/touring profiles;
- offline A/B routing;
- hard waypoints;
- GPX export.

---

## Phase 2 — semantic corridor

Implement:

- multi-resolution field;
- coarse propagation;
- corridor extraction;
- progressive corridor expansion;
- graph-tile lazy loading;
- debug visualization.

This is the phase where Cyclatractor becomes architecturally distinct from `ibex`.

---

## Phase 3 — true offline mobile UX

Implement:

- PWA install;
- region browser;
- resumable downloads;
- OPFS store;
- airplane-mode test suite;
- offline basemap strategy;
- storage management;
- update/version flow.

---

## Phase 4 — soft attraction

Implement:

- soft waypoints;
- drag-to-attract route;
- attraction radius;
- interactive low-resolution preview;
- deferred exact recompute after drag.

This should be tested heavily for mobile battery and responsiveness.

---

## Phase 5 — alternatives and explanation

Implement:

- semantically distinct alternatives;
- route-cost decomposition;
- surface/stress/uncertainty summaries;
- visual explanation layers.

---

## Phase 6 — traffic/context

Only after the base model is demonstrably useful:

- historical traffic ingestion;
- temporal cost profiles;
- wet/winter conditions;
- user preference calibration.

---

# 41. V0 technical acceptance criteria

Cyclatractor V0 is successful if all of these are true:

- [ ] Starts as a Vite + React + TypeScript application.
- [ ] Deployed under `/cyclatractor/`.
- [ ] Uses MapLibre for the human map.
- [ ] Can read Mapterhorn elevation.
- [ ] Can install at least one small offline test region.
- [ ] Can restart in airplane mode.
- [ ] Can calculate A→B entirely on-device.
- [ ] Can move a waypoint and recalculate entirely on-device.
- [ ] Final route is validated on a topology graph.
- [ ] Semantic field influences candidate corridor.
- [ ] Slope is directional in final edge scoring.
- [ ] Network continuity affects preference.
- [ ] Large-road/traffic-stress proxy affects preference.
- [ ] Unknown map data has an uncertainty cost.
- [ ] Bridges/tunnels do not create false raster connections.
- [ ] WebGPU absence does not break routing.
- [ ] Main UI remains responsive during routing.
- [ ] GPX can be exported offline.
- [ ] Debug mode can display cost components and chosen corridor.
- [ ] CI builds and publishes the static site.

---

# 42. Open technical questions

These should remain explicit until tested.

## Cost propagation algorithm

Candidates:

- raster Dijkstra;
- bucketed Dijkstra / Dial-like method;
- Fast Marching;
- iterative GPU relaxation;
- hierarchical tile propagation;
- graph-assisted raster propagation.

Selection criteria:

```text
mobile speed
GPU suitability
incremental updates
memory
implementation complexity
quality of resulting corridors
```

---

## Machine representation

Should static machine data be:

```text
MVT
raster textures
custom binary graph tiles
hybrid
```

Likely answer: hybrid.

Do not force every semantic source into the same format.

---

## Offline basemap

Questions:

- use downloadable vector PMTiles?
- derive own lightweight OSM basemap?
- what data/licensing terms permit redistribution/cache?
- how much visual detail is needed offline?

Routing data and human basemap should remain separable.

---

## WebGPU value

Benchmark before committing.

Questions:

- is field propagation actually the bottleneck?
- does GPU readback erase compute gains?
- does WebGPU improve battery use or only peak speed?
- is WebGL2 sufficient for V0?
- can a WASM CPU implementation already meet UX targets?

WebGPU is a tool, not a product requirement.

---

## Graph format

Benchmark:

```text
decode latency
bytes/km²
random tile access
cross-tile topology
worker transfer cost
implementation complexity
schema evolution
```

---

# 43. Architectural decisions

Proposed ADR-style decisions for the initial implementation.

## ADR-001 — Routing runs on-device

**Decision:** no route-time server dependency.

**Reason:** offline reliability, responsiveness, privacy, product identity.

---

## ADR-002 — Semantic field does not replace topology

**Decision:** final routes are produced/validated on a graph.

**Reason:** pixels cannot safely represent grade separation, access restrictions and exact connectivity.

---

## ADR-003 — Routing LOD is independent from map zoom

**Decision:** engine chooses compute resolution.

**Reason:** camera interactions must not unexpectedly change route semantics.

---

## ADR-004 — Corridors are initially soft

**Decision:** graph search can expand outside a candidate corridor.

**Reason:** coarse models can miss critical bridges, tunnels and connectors.

---

## ADR-005 — WebGPU is optional

**Decision:** implement a backend abstraction with fallback.

**Reason:** browser/device compatibility and operational robustness.

---

## ADR-006 — Offline packs are managed data

**Decision:** do not rely only on opportunistic HTTP cache.

**Reason:** users must know whether a region is truly available offline.

---

## ADR-007 — Reactive, not per-frame, semantic compute

**Decision:** recompute on meaningful state changes.

**Reason:** mobile battery and thermal constraints.

---

# 44. Relationship with previous projects

## Traveltime

Repository:

https://github.com/fxi/traveltime

Live/previous project:

https://fxi.io/traveltime/

Conceptual lineage:

```text
traveltime
    ↓
friction / cost surface
    ↓
spatial propagation
    ↓
multi-source travel-time result
```

Cyclatractor reuses the central intuition that movement can be modeled as propagation over a spatial cost surface, but adds:

- bicycle-specific semantics;
- directional slope;
- explicit network utility;
- topology;
- multi-resolution corridors;
- offline region packages;
- profile/context weighting;
- exact final path extraction.

Traveltime should be treated as an important conceptual prototype rather than code that must necessarily be reused.

---

## Ibex

Repository:

https://github.com/fxi/ibex

Ibex currently describes itself as **“Opinionated gravel routing for Swiss terrain”** and already includes:

- multiple route alternatives;
- interactive waypoint-based planning;
- GPX export;
- track management/persistence;
- Swiss topographic map integration;
- React;
- TypeScript;
- MapLibre GL JS.

Cyclatractor can be viewed as a more experimental routing-engine successor/evolution:

```text
Ibex
  ↓
existing gravel-routing UI/product ideas
  ↓
Cyclatractor
  ↓
offline semantic-field + topology architecture
```

Potential reuse should be evaluated module-by-module rather than assumed.

Good candidates:

- map/UI interaction patterns;
- waypoint UX;
- GPX handling;
- style/config conventions;
- CI lessons;
- routing test cases.

---

# 45. External technical references

## MapLibre GL JS

https://maplibre.org/maplibre-gl-js/docs/

MapLibre GL JS uses WebGL for browser rendering and supports custom layers that can render using the map's GL context.

Custom layer API:

https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/

---

## Mapterhorn

https://mapterhorn.com/

Data access:

https://mapterhorn.com/data-access/

Repository:

https://github.com/mapterhorn/mapterhorn

---

## MapTiler

https://www.maptiler.com/

MapLibre integration examples/documentation should be preferred over tightly coupling routing logic to MapTiler APIs.

---

## WebGPU

MDN:

https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API

WebGPU should be capability-detected and treated as an accelerator.

---

## PMTiles

https://docs.protomaps.com/pmtiles/

Candidate storage/distribution mechanism for map/terrain tiles and potentially some machine layers.

---

# 46. Suggested first experiment

Before building a complete offline stack, create one deliberately constrained experiment.

### Area

Approximately 30–50 km across, with:

- one city;
- one valley;
- one ridge;
- a river;
- bridges;
- a major road;
- several gravel paths;
- meaningful elevation.

### Inputs

Precompute:

```text
network graph
network utility
road stress
surface
uncertainty
terrain
```

### Runtime

Display:

```text
MapLibre human map
+
machine field debug layer
```

Interaction:

1. Set A.
2. Set B.
3. Choose Gravel / Road / Touring.
4. Calculate coarse semantic corridor.
5. Load graph only in/near corridor.
6. Calculate route.
7. Drag one soft attraction waypoint.
8. Recompute.
9. Toggle machine layers.

### Core question

Do not begin by asking:

> “Is the route mathematically optimal?”

Ask:

> **“When I look at the map, does the chosen corridor make sense — and can I understand why?”**

If the answer is consistently yes, the architecture is worth scaling.

---

# 47. One-sentence specification

> **Cyclatractor is a mobile-first, offline-first bicycle router that computes a contextual semantic cost field on-device to identify human-plausible movement corridors, then resolves those corridors against an exact OSM-derived topology graph to produce valid, explainable routes without requiring a routing server.**

---

# 48. Short architecture mantra

```text
Human map:      understand the territory
Machine field:  choose the territory
Topology graph: choose a valid path
Offline pack:   make it work anywhere
```

And the routing pipeline:

```text
semantic field
      ↓
corridor
      ↓
topology
      ↓
route
```
