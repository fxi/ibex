import type { RouteResult } from "./routing/types";
export function Elevation({ route }: { route: RouteResult }) {
  const known = route.elevationProfile.filter(
    (p): p is [number, number] => p[1] !== null,
  );
  if (known.length < 2) return null;
  const min = known.reduce((m, p) => Math.min(m, p[1]), Infinity),
    max = known.reduce((m, p) => Math.max(m, p[1]), -Infinity);
  const paths: string[] = [];
  let current = "";
  for (const [meters, height] of route.elevationProfile) {
    if (height === null) {
      if (current) paths.push(current);
      current = "";
      continue;
    }
    const x = (meters / Math.max(1, route.distanceM)) * 280,
      y = 65 - ((height - min) / Math.max(20, max - min)) * 55;
    current += `${current ? " L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  if (current) paths.push(current);
  return (
    <figure className="elevation">
      <figcaption>
        Elevation · {Math.round(min)}–{Math.round(max)} m{" "}
        <span>Gaps = unknown terrain</span>
      </figcaption>
      <svg
        viewBox="0 0 280 75"
        role="img"
        aria-label={`Known route elevation between ${Math.round(min)} and ${Math.round(max)} metres, with gaps where terrain is unknown`}
      >
        {paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="#6e8757" strokeWidth="1.5" />
        ))}
      </svg>
    </figure>
  );
}
