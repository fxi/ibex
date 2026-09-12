import { useId } from "react";
import type { RouteResult } from "./routing/types";
import { SURFACE_STYLE, surfaceBands, surfaceStyle } from "./map/rideStyle";

const W = 280,
  H = 75,
  TOP = 10,
  BASE = 65;

/**
 * The route's height, with what it is made of hatched underneath.
 *
 * The curve alone says a climb is long; it cannot say whether the last two hundred metres
 * of it are carried. Filling under the curve by surface — denser hatching as the going
 * worsens, orange cross-hatch for hike-a-bike — puts that in the same picture, so an
 * unrideable stretch is diagnosed without opening anything.
 */
export function Elevation({ route }: { route: RouteResult }) {
  const id = useId().replace(/:/g, "");
  const known = route.elevationProfile.filter(
    (p): p is [number, number] => p[1] !== null,
  );
  if (known.length < 2) return null;
  const min = known.reduce((m, p) => Math.min(m, p[1]), Infinity),
    max = known.reduce((m, p) => Math.max(m, p[1]), -Infinity);
  const span = Math.max(1, route.distanceM);
  const x = (meters: number) => (meters / span) * W;
  const y = (height: number) =>
    BASE - ((height - min) / Math.max(20, max - min)) * (BASE - TOP);

  // One path per run of known terrain: a gap in the DEM breaks both the curve and the
  // fill, rather than being bridged by a line nobody measured.
  const lines: string[] = [];
  const areas: string[] = [];
  let line = "";
  let start: [number, number] | undefined;
  let last: [number, number] | undefined;
  const flush = () => {
    if (line && start && last)
      areas.push(
        `${line} L${x(last[0]).toFixed(1)},${BASE} L${x(start[0]).toFixed(1)},${BASE} Z`,
      );
    if (line) lines.push(line);
    line = "";
    start = undefined;
  };
  for (const [meters, height] of route.elevationProfile) {
    if (height === null) {
      flush();
      continue;
    }
    const point: [number, number] = [meters, height];
    line += `${line ? " L" : "M"}${x(meters).toFixed(1)},${y(height).toFixed(1)}`;
    start ??= point;
    last = point;
  }
  flush();

  const bands = surfaceBands(route.segments ?? [], route.distanceM);
  const present = new Set(bands.map((b) => b.ride));
  const hatched = SURFACE_STYLE.filter(
    (s) => present.has(s.ride) && s.profile.spacing,
  );
  const summary = SURFACE_STYLE.filter((s) => present.has(s.ride))
    .map((s) => s.label.toLowerCase())
    .join(", ");

  return (
    <figure className="elevation">
      <figcaption>
        Elevation · {Math.round(min)}–{Math.round(max)} m{" "}
        <span>{summary ? `Surface: ${summary}` : "Gaps = unknown terrain"}</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Route elevation between ${Math.round(min)} and ${Math.round(max)} metres${summary ? `, hatched by surface: ${summary}` : ""}, with gaps where terrain is unknown`}
      >
        <defs>
          {/* Hatch lines are drawn by the pattern's own tile, so density stays honest at
              any width the card is resized to. */}
          {hatched.map((s) => (
            <pattern
              key={s.ride}
              id={`${id}-${s.ride}`}
              patternUnits="userSpaceOnUse"
              width={s.profile.spacing}
              height={s.profile.spacing}
              patternTransform={`rotate(${s.profile.angle ?? 45})`}
            >
              <line
                className={s.profile.color ? undefined : "hatch-track"}
                x1="0"
                y1="0"
                x2="0"
                y2={s.profile.spacing}
                stroke={s.profile.color}
                strokeWidth={1}
                strokeOpacity={s.profile.opacity}
              />
            </pattern>
          ))}
          <clipPath id={`${id}-under`}>
            {areas.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </clipPath>
        </defs>
        {/* Everything under the curve is painted through one clip, so a band is a plain
            rectangle and its edges land exactly on the surface change. */}
        <g clipPath={`url(#${id}-under)`}>
          {areas.map((d, i) => (
            <path key={i} className="elevation-fill" d={d} />
          ))}
          {bands.map((b, i) => {
            // Paved is the flat tint already painted: only the classes that need saying
            // get a hatch, so a tarmac ride stays quiet.
            if (!surfaceStyle(b.ride).profile.spacing) return null;
            return (
              <rect
                key={i}
                x={x(b.startM)}
                y={0}
                width={Math.max(0, x(b.endM) - x(b.startM))}
                height={H}
                fill={`url(#${id}-${b.ride})`}
              />
            );
          })}
        </g>
        {lines.map((d, i) => (
          <path key={i} className="elevation-line" d={d} />
        ))}
      </svg>
    </figure>
  );
}
