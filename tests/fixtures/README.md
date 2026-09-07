`voirons-graph.json.gz` is a small geographic routing regression fixture extracted
from the cached Geneva OSM snapshot (2026-07-15) and rebuilt with cost model 2.
It includes the technical Sentier du Sauget and the surrounding road/track detour.

© OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Elevation: [Mapterhorn attribution](https://mapterhorn.com/attribution/), sampled
with bilinear interpolation and 80 m windows along each complete way.

Regenerate from the real pack by retaining edges whose complete geometry lies
within `[6.34, 46.21, 6.38, 46.245]`, their endpoint nodes, and restrictions whose
ways are all retained. No personal tracks or inferred connections are included.
