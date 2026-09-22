import { useId, useRef, useState } from "react";
import type { CapabilityProfile } from "./routing/capability";
import type { RouteResult } from "./routing/types";
import {
  SURFACE_STYLE,
  surfaceBands,
  surfaceStyle,
  type Span,
} from "./map/rideStyle";
import {
  metersAtX,
  pinMarks,
  profileGeometry,
  steepLaneBands,
  stressLaneBands,
  type Pin,
} from "./map/routeStats";

/** Pointer travel below which a drag was really a tap, in CSS pixels. */
const TAP_SLOP = 4;

const BOX = { w: 280, h: 75, top: 10, base: 65 };

/** Which signal the fill under the curve is showing. */
type Lane = "surface" | "steep" | "stress";
const LANES: { lane: Lane; label: string }[] = [
  { lane: "surface", label: "Surface" },
  { lane: "steep", label: "Steep" },
  { lane: "stress", label: "Traffic" },
];

/**
 * The route's height, with what it is made of — or what it will cost — underneath.
 *
 * The curve alone says a climb is long; it cannot say whether the last two hundred metres
 * of it are carried, or how far past comfortable the gradient goes. Filling under the curve
 * puts one of those in the same picture: hatched by surface, or tinted warm where the
 * gradient runs past what this rider climbs comfortably. One signal at a time, because two
 * of them in one 280×75 box is a texture rather than an answer.
 *
 * Without `detail` this is the small sparkline on a track card: surface fill, no switcher,
 * no listeners. The exclusion is structural rather than a CSS rule, so a later stylesheet
 * edit cannot accidentally light it up.
 */
export function Elevation({
  route,
  detail,
}: {
  route: RouteResult;
  detail?: {
    capability: CapabilityProfile;
    pins?: Pin[];
    /** The stretch to draw, if the rider has narrowed it. Owned by the caller. */
    range?: Span;
    onRange?: (range?: Span) => void;
    onLocate?: (meters: number) => void;
  };
}) {
  const id = useId().replace(/:/g, "");
  // Declared before the early return below: hooks cannot be skipped on a route with no
  // measured terrain.
  const [lane, setLane] = useState<Lane>("surface");
  const [drag, setDrag] = useState<{ from: number; to: number }>();
  const svg = useRef<SVGSVGElement>(null);

  // Named `range`, not `window`: shadowing the global here would be a trap for whatever
  // gets added to this component next.
  const range = detail?.range;
  const geometry = profileGeometry(
    route.elevationProfile,
    route.distanceM,
    BOX,
    range,
  );
  if (!geometry) return null;
  const { lines, areas, min, max, x } = geometry;
  // The visible stretch, for the pin gap and the pointer mapping.
  const from = range ? Math.max(0, range.startM) : 0;
  const to = range ? Math.min(range.endM, route.distanceM) : route.distanceM;

  const widthOf = () => svg.current?.getBoundingClientRect().width ?? 0;
  const pxOf = (event: React.PointerEvent) =>
    event.clientX - (svg.current?.getBoundingClientRect().left ?? 0);
  // A press is a place and a drag is a stretch, told apart by how far the pointer moved.
  // The chart is stretched by CSS, so the mapping uses the rendered width rather than the
  // 280-unit viewBox it is drawn in.
  const endDrag = () => {
    if (!drag) return;
    const width = widthOf();
    const moved = Math.abs(drag.to - drag.from);
    if (moved < TAP_SLOP)
      detail?.onLocate?.(metersAtX(drag.from, width, route.distanceM, range));
    else
      detail?.onRange?.({
        startM: metersAtX(
          Math.min(drag.from, drag.to),
          width,
          route.distanceM,
          range,
        ),
        endM: metersAtX(
          Math.max(drag.from, drag.to),
          width,
          route.distanceM,
          range,
        ),
      });
    setDrag(undefined);
  };

  const showing: Lane = detail ? lane : "surface";
  const bands = surfaceBands(route.segments, route.distanceM);
  const present = new Set(bands.map((b) => b.ride));
  const hatched = SURFACE_STYLE.filter(
    (s) => present.has(s.ride) && s.profile.spacing,
  );
  const surfaces = SURFACE_STYLE.filter((s) => present.has(s.ride))
    .map((s) => s.label.toLowerCase())
    .join(", ");
  // Both warm lanes are the same picture — a tint where a signal runs past what is
  // ordinary — so they share one set of rects and differ only in what fills them.
  const warm =
    showing === "steep" && detail
      ? steepLaneBands(
          route.elevationProfile,
          detail.capability,
          route.segments,
          route.distanceM,
        )
      : showing === "stress"
        ? stressLaneBands(route.segments, route.distanceM)
        : [];

  // Six user units of the 280-wide box: pins closer than that would be one smudge, so they
  // merge into a single mark rather than pretending to be separate.
  // Lane bands need no filtering — the clip is built from the windowed curve, so anything
  // outside is clipped for free. Pins are drawn above the curve, so they are filtered here.
  const visiblePins = (detail?.pins ?? []).filter(
    (p) => !range || (p.meters >= range.startM && p.meters <= range.endM),
  );
  const marks = visiblePins.length
    ? pinMarks(visiblePins, ((to - from) * 6) / BOX.w)
    : [];

  // The caption says what is actually painted, so the prose and the picture cannot drift.
  const sections = (count: number) =>
    `${count} section${count === 1 ? "" : "s"}`;
  const legend =
    showing === "steep"
      ? warm.length
        ? `Steep: ${sections(warm.length)} past comfortable`
        : "Steep: none past comfortable"
      : showing === "stress"
        ? warm.length
          ? `Traffic: ${sections(warm.length)} busier than a quiet lane`
          : "Traffic: quiet throughout"
        : surfaces
          ? `Surface: ${surfaces}`
          : "Gaps = unknown terrain";

  return (
    <figure className={`elevation${detail ? " interactive" : ""}`}>
      <figcaption>
        Elevation · {Math.round(min)}–{Math.round(max)} m <span>{legend}</span>
      </figcaption>
      <svg
        ref={svg}
        viewBox={`0 0 ${BOX.w} ${BOX.h}`}
        role="img"
        aria-label={`Route elevation between ${Math.round(min)} and ${Math.round(max)} metres, ${legend.toLowerCase()}, with gaps where terrain is unknown`}
        onPointerDown={
          detail
            ? (event) => {
                const at = pxOf(event);
                setDrag({ from: at, to: at });
                event.currentTarget.setPointerCapture(event.pointerId);
              }
            : undefined
        }
        onPointerMove={
          drag ? (event) => setDrag({ ...drag, to: pxOf(event) }) : undefined
        }
        onPointerUp={detail ? endDrag : undefined}
        onPointerCancel={detail ? () => setDrag(undefined) : undefined}
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
            rectangle and its edges land exactly on the change it marks. */}
        <g clipPath={`url(#${id}-under)`}>
          {areas.map((d, i) => (
            <path key={i} className="elevation-fill" d={d} />
          ))}
          {showing === "surface" &&
            bands.map((b, i) => {
              // Paved is the flat tint already painted: only the classes that need saying
              // get a hatch, so a tarmac ride stays quiet.
              if (!surfaceStyle(b.ride).profile.spacing) return null;
              return (
                <rect
                  key={i}
                  x={x(b.startM)}
                  y={0}
                  width={Math.max(0, x(b.endM) - x(b.startM))}
                  height={BOX.h}
                  fill={`url(#${id}-${b.ride})`}
                />
              );
            })}
          {warm.map((b, i) => (
            <rect
              key={i}
              x={x(b.startM)}
              y={0}
              width={Math.max(0, x(b.endM) - x(b.startM))}
              height={BOX.h}
              fill={b.color}
              fillOpacity={0.55}
            />
          ))}
        </g>
        {lines.map((d, i) => (
          <path key={i} className="elevation-line" d={d} />
        ))}
        {/* Decorative, and deliberately so: the SVG is one image to a screen reader, and
            the warning and waypoint rows already lead to these same places with real
            buttons. Faking controls in here would only duplicate them badly. */}
        {drag && Math.abs(drag.to - drag.from) >= TAP_SLOP && (
          <rect
            className="brush-highlight"
            x={(Math.min(drag.from, drag.to) / Math.max(1, widthOf())) * BOX.w}
            y={0}
            width={
              (Math.abs(drag.to - drag.from) / Math.max(1, widthOf())) * BOX.w
            }
            height={BOX.h}
          />
        )}
        {marks.map((m, i) => (
          <g key={i} aria-hidden="true">
            <line
              className="pin-stem"
              x1={x(m.meters)}
              y1={BOX.top - 6}
              x2={x(m.meters)}
              y2={BOX.base}
            />
            <circle
              // Namespaced: a bare `waypoint` class would pick up the waypoint-row styles
              // and be counted as a row by anything selecting `.waypoint`.
              className={`pin-head pin-${m.kind}`}
              cx={x(m.meters)}
              cy={BOX.top - 7}
              r={m.count > 1 ? 3.4 : 2.4}
            />
          </g>
        ))}
      </svg>
      {detail && (
        <div
          className="lane-switcher"
          role="group"
          aria-label="Fill under the curve"
        >
          {LANES.map(({ lane: value, label }) => (
            <button
              key={value}
              aria-pressed={showing === value}
              onClick={() => setLane(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </figure>
  );
}
