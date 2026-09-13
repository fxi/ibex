/** Public graph only; the optional reference GPX stays under ignored data/. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { route, distance, project } from "../src/routing/engine";
import { explore } from "../src/routing/exploration";
import { exportGPX } from "../src/gpx";
import { loadProfile } from "./profile";
import type { Graph, Point, RouteRequest } from "../src/routing/types";

const graph: Graph = JSON.parse(
  gunzipSync(
    readFileSync(process.argv[2] ?? "tests/fixtures/coudry-graph.json.gz"),
  ).toString(),
);
const request: RouteRequest = {
  anchors: [
    [6.3533, 46.1632],
    [6.2316, 46.1833],
  ],
  profile: await loadProfile("gravel_50"),
};
const baseline = route(graph, request, "reference");
const result = explore(graph, request, baseline);
const directory = "data/derived/coudry-audit";
mkdirSync(directory, { recursive: true });
for (const [name, r] of [
  ["baseline", baseline],
  ["exploration", result],
] as const) {
  writeFileSync(`${directory}/${name}.gpx`, exportGPX(r, `Coudry ${name}`));
  writeFileSync(`${directory}/${name}.json`, JSON.stringify(r, null, 2));
  console.log(
    name,
    JSON.stringify({
      status: r.status,
      distanceM: r.distanceM,
      cost: r.cost,
      hikeABikeM: r.hikeABikeM,
      experience: r.experience,
      durationMs: r.metrics.durationMs,
    }),
  );
}
if (process.argv[3]) {
  const xml = readFileSync(process.argv[3], "utf8");
  const points: Point[] = [
    ...xml.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"/g),
  ].map((m) => [+m[2], +m[1]]);
  if (points.length < 2)
    throw new Error("Reference needs at least two track points");
  const length = points
    .slice(1)
    .reduce((s, p, i) => s + distance(points[i], p), 0);
  const near = (a: Point[], b: Point[]) => {
    let covered = 0,
      length = 0;
    for (let i = 1; i < a.length; i++) {
      const meters = distance(a[i - 1], a[i]);
      const mid: Point = [
        (a[i - 1][0] + a[i][0]) / 2,
        (a[i - 1][1] + a[i][1]) / 2,
      ];
      if (b.slice(1).some((p, j) => project(mid, b[j], p).distance <= 40))
        covered += meters;
      length += meters;
    }
    return covered / length;
  };
  console.log(
    "reference",
    JSON.stringify({
      distanceM: length,
      baselineWithin40m: near(baseline.geometry, points),
      explorationWithin40m: near(result.geometry, points),
      referenceCoveredWithin40m: near(points, result.geometry),
    }),
  );
}
