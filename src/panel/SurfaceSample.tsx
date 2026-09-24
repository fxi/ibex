import { useId } from "react";
import {
  CENTER_COLOR,
  LEVEL_COLORS,
  surfaceStyle,
  type Level,
  type SurfaceStyle,
} from "../map/rideStyle";
import type { RideClass } from "../routing/types";

const TRACK_W = 9;

/**
 * The line exactly as the map draws it: the track's colour, cased in white, carrying the
 * centre line its surface earns. Generated from the same table as the map layers, so a
 * legend entry is the real symbol rather than a picture of one.
 */
export function SurfaceSample({
  ride,
  color,
  width = 64,
}: {
  ride: RideClass;
  color: string;
  width?: number;
}) {
  const style: SurfaceStyle = surfaceStyle(ride);
  const center = style.center;
  const w = center ? TRACK_W * center.weight : 0;
  return (
    <svg
      className="symbology-sample"
      viewBox={`0 0 ${width} 14`}
      style={{ width }}
      aria-hidden="true"
    >
      <line
        x1="0"
        y1="7"
        x2={width}
        y2="7"
        stroke={CENTER_COLOR}
        strokeWidth={TRACK_W + 3.5}
        strokeLinecap="round"
        // The map's casing sits on a pale basemap; against the panel it would glare, so
        // the sample keeps the shape and drops the intensity.
        opacity="0.45"
      />
      <line
        x1="0"
        y1="7"
        x2={width}
        y2="7"
        stroke={color}
        strokeWidth={TRACK_W}
        strokeLinecap="round"
      />
      {center && (
        <line
          x1="0"
          y1="7"
          x2={width}
          y2="7"
          stroke={CENTER_COLOR}
          strokeWidth={w}
          strokeOpacity={center.opacity}
          // maplibre measures dashes in multiples of the line width and SVG measures them
          // in user units, so the pattern is scaled here to match what the map paints.
          strokeDasharray={
            center.dash
              ? center.dash.map((d) => (d * w).toFixed(2)).join(" ")
              : undefined
          }
        />
      )}
    </svg>
  );
}

/** The hatch the elevation profile fills that class with. */
export function ProfileSample({
  ride,
  color,
}: {
  ride: RideClass;
  color: string;
}) {
  const {
    spacing,
    angle,
    opacity,
    color: override,
  } = surfaceStyle(ride).profile;
  // Two cards can show the same class in different track colours, so the pattern id has
  // to be unique per instance or the first one on the page wins.
  const id = `${useId().replace(/:/g, "")}-${ride}`;
  return (
    <svg className="symbology-hatch" viewBox="0 0 30 14" aria-hidden="true">
      <rect width="30" height="14" fill={color} fillOpacity="0.18" rx="2" />
      {spacing ? (
        <>
          <defs>
            <pattern
              id={id}
              patternUnits="userSpaceOnUse"
              width={spacing}
              height={spacing}
              patternTransform={`rotate(${angle ?? 45})`}
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2={spacing}
                stroke={override ?? color}
                strokeWidth="1"
                strokeOpacity={opacity}
              />
            </pattern>
          </defs>
          <rect width="30" height="14" fill={`url(#${id})`} rx="2" />
        </>
      ) : null}
    </svg>
  );
}

/**
 * A steepness or traffic level as the map draws it: the track's line, carrying the level's
 * colour down its middle — or nothing, where the going is fine.
 */
export function LevelSample({
  level,
  color,
  width = 30,
}: {
  level: Level | "unknown";
  color: string;
  width?: number;
}) {
  const w = TRACK_W * 0.5;
  return (
    <svg
      className="symbology-sample level-sample"
      viewBox={`0 0 ${width} 14`}
      style={{ width }}
      aria-hidden="true"
    >
      <line
        x1="0"
        y1="7"
        x2={width}
        y2="7"
        stroke={color}
        strokeWidth={TRACK_W}
        strokeOpacity={level === "unknown" ? 0.35 : 1}
      />
      {level !== "unknown" && level > 0 && (
        <line
          x1="0"
          y1="7"
          x2={width}
          y2="7"
          stroke={LEVEL_COLORS[level as 1 | 2 | 3]}
          strokeWidth={w}
        />
      )}
    </svg>
  );
}
