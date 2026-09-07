# Prototype validation

## Rideability correction — 2026-09-07

- The app now uses rebuilt local pack `3ff3ea27b6de281a`, cost model 2,
  preprocessor 2. All 150 file lengths and SHA-256 hashes were verified
  (61,043,435 bytes). Older installed packs require an update.
- The previous published pack had null grades on the 634.68 m Sentier du
  Sauget (`107854950`, MTB scale 3), yielding zero slope cost. The newer local
  baseline still selected an MTB-scale-5 segment in corridor mode and displayed
  that candidate despite a cheaper full-graph route.
- The real Sauget regression now chooses a 4.777 km track/Route des Voirons
  detour, excluding the technical switchbacks. Waypoints snap to eligible
  nearby connections; this is not a promise of access to the exact trail points.
- The built-in Geneva–Voirons Gravel route is 26.695 km, with no MTB-rated
  technical paths; reference and corridor agree. Road rejects its off-road
  destination. A road-access endpoint on Route des Voirons produces a 33.637 km
  Road route with no hiking paths and a maximum sampled uphill grade of 12.6%.
- Thirty JavaScript tests (including the geographic regression), ten Python
  tests, lint, typecheck, and the production build pass. Browser tests were not
  rerun for this routing-focused change. These checks establish the reported
  data/model regressions, not physical rideability of every route.

## Review-fix checkpoint

The topology/restriction and single-style changes pass 24 TypeScript tests,
7 Python tests, typechecking, and ESLint. The isolated browser-test build passes.
The browser run completed 10 tests successfully, then was interrupted during
WebKit offline reload; three subsequent WebKit tests did not run. A follow-up
fixture change waits for initial map loading before going offline and has not
been validated. These results supersede the historical browser claims below
for this checkpoint.

These checks do not establish route rideability. Road and Gravel still select
unsuitable steep hiking paths in the reported Voirons example. Terrain data,
profile eligibility, and route cost behavior remain unresolved.

## Earlier baseline results

Recorded 2026-09-06. This is a comparative prototype, not physical-device certification.

- Public Geneva pack: 54,561,151 bytes, 181,920 graph nodes and 403,744 directed edges. All published artifacts were downloaded and checksum-verified; PMTiles byte ranges return HTTP 206. CORS was also verified for `http://192.168.1.104:5173`.
- Real LAN development smoke: downloaded the public pack, stored it with IndexedDB and calculated the Arve example with no uncaught JavaScript errors. The origin was explicitly verified to be insecure. SHA-256 verification remains enabled using the JavaScript fallback.
- 16 TypeScript unit tests and 5 Python data tests pass. Type checking, ESLint and the production build pass.
- Chromium and mobile WebKit regression scenarios pass: map rendering, insecure LAN installation and routing, checksum rejection, interrupted-download resumption, offline restart, route comparison and GPX export. These regressions use the checked-in synthetic network. Real-pack LAN smoke is a separate check.
- WebKit offline restart uses an actual local-server transport outage and HTTP interception. Playwright offline emulation in the installed WebKit build prevents even a standalone Blob worker from starting; `scripts/repro-webkit-offline.mjs` isolates this tooling limitation. Physical iPhone memory, battery and storage retention still require manual validation over HTTPS.

## Routing experiment

Nine real-region desktop comparisons completed successfully: three profiles on Geneva–Salève, Geneva–Voirons and the Arve example. Corridor cost differences against full-region Dijkstra ranged from 0% to 5.10%. These resident-graph benchmarks exclude disk reads; the application separately measures actual worker file reads. They do not establish iPhone performance.

The current utility ablation did not change the selected Salève path. Removing slope changed the corridor result. The tested attraction lay outside the resulting route and had no effect. More discriminating cases are needed before tuning these terms from such results.

## Personal tracks

The complete private audit prepared 793 portions. Of these, 76 passed spatial checks and 29 passed the stricter sequence checks. Grouped splitting left only one quantitatively eligible evaluation portion versus 28 calibration portions. This is insufficient for reliable personalized cost fitting, so personalization remains disabled. Original tracks and detailed reports stay under ignored `data/` and were not published with the OSM pack.

The public data pack is published. The application itself has not been deployed to GitHub Pages; the repository has no remote configured.
