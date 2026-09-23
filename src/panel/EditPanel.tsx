import { useMemo, useState } from "react";
import {
  Crosshair,
  CloudDownload,
  ListRestart,
  RefreshCw,
  Route,
  TriangleAlert,
} from "lucide-react";
import { Elevation } from "../Elevation";
import { serializeProfile } from "../routing/profiles";
import { exportTrack, freshResult, modelSnapshot } from "../tracks";

import { surfaceStyle, type Span } from "../map/rideStyle";
import {
  composition,
  heightAtM,
  metersAtVertex,
  routeWarnings,
  vertexAtM,
  type Pin,
  type Warning,
} from "../map/routeStats";
import type { CapabilityProfile } from "../routing/capability";
import { anchorVertices, pointAt } from "../routing/localEdit";
import { compileProfile } from "../routing/compile";
import type { Point, RideClass, RouteResult } from "../routing/types";
import type { Track } from "../tracks";
import { ProfileSample } from "./SurfaceSample";
import type { PanelContext } from "./context";
import { ConvertDialog } from "./ConvertDialog";
import { SectionHeading } from "./SectionHeading";

/**
 * Where the active track is shaped, and where what came out of it is read.
 *
 * The Tracks tab only names and colours a track; this is the one place the route changes.
 * The map accepts waypoint taps, drags and marker menus only while this tab is open, so
 * "editing" is a mode you can see rather than something any stray tap on the map can do.
 * Next to the controls sits what the route turned out to be — its profile, warnings,
 * surfaces and waypoints — because the point of an edit is to see what it did. All of that
 * is derived on demand (see `src/map/routeStats.ts`), and the tab has to work before any
 * route exists, since planning starts with nothing to describe.
 */
export function EditPanel({ ctx }: { ctx: PanelContext }) {
  const { tracks, routing, models, canCompute } = ctx;
  const track = tracks.active;
  const route = track?.result;
  // Owned here rather than in the chart, because narrowing the chart also narrows the
  // warnings list: the point of focusing on a stretch is to read everything about it.
  const [range, setRange] = useState<Span>();
  const [converting, setConverting] = useState(false);
  // Thresholds are this rider's own, so the same ramp reads differently on a road bike and
  // a trail bike. Compiling is cheap, but it would otherwise run on every render.
  const capability = useMemo(
    () => (track ? compileProfile(track.profile).capability : undefined),
    [track?.profile],
  );

  // The tab already says Edit; the heading names the track it acts on, in its colour.
  const heading = (
    <SectionHeading
      title={
        track ? (
          <>
            <i
              className="track-dot"
              style={{ "--track-color": track.color } as React.CSSProperties}
            />
            <span className="heading-track">{track.name}</span>
          </>
        ) : (
          "Edit"
        )
      }
      info="Shape the route, then read what it is made of."
    />
  );

  if (!track)
    return (
      <>
        {heading}
        <div className="empty-state">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
          No track selected
        </div>
      </>
    );

  const planned = track.kind === "planned";
  const stale = !!route && !freshResult(track);
  /**
   * Which listed model the track is on, matched by value rather than by name: with no
   * inheritance a profile is just its fields, and two identical profiles built in a
   * different key order are the same model.
   */
  const same = (id: string) => {
    const model = models.find((m) => m.id === id);
    return (
      !!model && serializeProfile(track.profile) === serializeProfile(model)
    );
  };

  return (
    <>
      {heading}
      <div
        className="stats"
        style={{ "--track-color": track.color } as React.CSSProperties}
      >
        {planned ? (
          <select
            aria-label="Profile"
            value={models.find((m) => same(m.id))?.id ?? ""}
            onChange={(e) => {
              const chosen = models.find((m) => m.id === e.target.value);
              if (chosen) tracks.edit({ profile: modelSnapshot(chosen) });
            }}
          >
            {/* An edited model matches nothing in the list until it is saved. */}
            <option value="">{track.profile.name} (custom)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <>
            <p className="hint">
              An imported track is kept exactly as recorded. Convert it to plan
              a new track along the same way, with a profile.
            </p>
            <button className="primary" onClick={() => setConverting(true)}>
              <Route size={16} /> Convert…
            </button>
            {converting && (
              <ConvertDialog
                ctx={ctx}
                track={track}
                onClose={() => setConverting(false)}
              />
            )}
          </>
        )}

        {/* What the track gives out on the left, what changes it on the right. */}
        {(route || planned) && (
          <div className="edit-toolbar">
            {route && (
              <button
                className="icon-button"
                aria-label="Export your route"
                title="Export GPX"
                disabled={stale}
                onClick={() => exportTrack(track)}
              >
                <CloudDownload size={18} />
              </button>
            )}
            {planned && (
              <button
                className="icon-button"
                aria-label="Reset waypoints"
                title="Reset waypoints"
                disabled={!track.anchors.length}
                onClick={() => tracks.edit({ anchors: [] })}
              >
                <ListRestart size={18} />
              </button>
            )}
            {planned && (
              <div className="edit-toolbar-end">
                {routing.busy && (
                  <button
                    onClick={() => {
                      routing.cancel();
                      ctx.setStatus("Cancelled");
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  className="icon-button primary"
                  aria-label="Compute"
                  title={
                    routing.busy ? "Computing…" : "Route the waypoints again"
                  }
                  aria-busy={routing.busy}
                  disabled={!canCompute}
                  onClick={routing.compute}
                >
                  <RefreshCw size={18} className={routing.busy ? "spin" : ""} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* The run is started here, so its progress and outcome are reported here too. The
            line keeps its height when empty, so the figures below never jump. */}
        <p className="edit-status" role="status">
          {routing.busy && <RefreshCw size={12} className="spin" />}
          {ctx.status}
        </p>

        {route && capability ? (
          <div className="result">
            <RouteSummary
              ctx={ctx}
              track={track}
              route={route}
              capability={capability}
              range={range}
              onRange={setRange}
            />
          </div>
        ) : (
          planned && (
            <p className="hint">
              No route yet. Add waypoints on the map, then compute the track to
              see its profile, surfaces and warnings.
            </p>
          )
        )}
        <RouteWaypoints
          track={track}
          onLocate={ctx.locate}
          onEdit={planned ? (anchors) => tracks.edit({ anchors }) : undefined}
        />
      </div>
    </>
  );
}

/** Everything that needs a finished route: the figures, the chart, warnings, surfaces. */
function RouteSummary({
  ctx,
  track,
  route,
  capability,
  range,
  onRange,
}: {
  ctx: PanelContext;
  track: Track;
  route: RouteResult;
  capability: CapabilityProfile;
  range?: Span;
  onRange: (range?: Span) => void;
}) {
  const stale = !freshResult(track);
  const warnings = routeWarnings(route, capability);
  // A row says where a thing is in kilometres; this puts the same place on the map without
  // taking the rider's overview away from them.
  const show = (meters: number) => {
    if (route.geometry.length < 2) return;
    const vertex = vertexAtM(route.segments, route.distanceM, meters);
    ctx.locate(pointAt(route.geometry, vertex));
  };

  // What the chart marks along the top: where each warning starts, and where the rider
  // asked to go. Waypoints only where the route still matches them.
  const vertices = anchorVertices(route, track.anchors.length);
  const pins: Pin[] = [
    ...warnings.map((w): Pin => ({ meters: w.startM, kind: "warning" })),
    ...(vertices ?? []).map((vertex): Pin => ({
      meters: metersAtVertex(route.segments, route.distanceM, vertex),
      kind: "waypoint",
    })),
  ];

  return (
    <>
      {stale && (
        <p className="hint">
          Waypoints or profile changed. These figures describe the previous
          route.
        </p>
      )}

      <dl className="track-stats">
        <div>
          <dt>Distance</dt>
          <dd>{(route.distanceM / 1000).toFixed(1)} km</dd>
        </div>
        <div>
          <dt>Elevation gain</dt>
          <dd>
            {route.ascentM === null ? "—" : `${Math.round(route.ascentM)} m`}
          </dd>
        </div>
      </dl>

      <Elevation
        route={route}
        detail={{ capability, pins, range, onRange, onLocate: show }}
      />
      {range && (
        <div className="range-controls" role="status">
          <span>
            Showing {(range.startM / 1000).toFixed(1)}–
            {(range.endM / 1000).toFixed(1)} km of{" "}
            {(route.distanceM / 1000).toFixed(1)} km
          </span>
          <button
            onClick={() => {
              const segments = route.segments;
              const a = Math.floor(
                vertexAtM(segments, route.distanceM, range.startM),
              );
              const b = Math.ceil(
                vertexAtM(segments, route.distanceM, range.endM),
              );
              ctx.fit(route.geometry.slice(a, b + 1));
            }}
          >
            Fit map
          </button>
          <button onClick={() => onRange(undefined)}>Clear</button>
        </div>
      )}

      <RouteWarnings
        warnings={
          range
            ? warnings.filter(
                (w) => w.endM > range.startM && w.startM < range.endM,
              )
            : warnings
        }
        onShow={show}
      />
      <SurfaceComposition route={route} color={track.color} />
    </>
  );
}

/** A bar segment is the track's colour unless the class overrides it, as on the map. */
const bandColor = (ride: RideClass, color: string) =>
  surfaceStyle(ride).profile.color ?? color;

/**
 * What the route is made of, as one bar and a list.
 *
 * The bar answers the glance — mostly tarmac, or mostly not — and the list answers the
 * follow-up in kilometres. Swatches come from `ProfileSample`, so a class is shown with the
 * exact hatch the elevation profile fills it with.
 */
function SurfaceComposition({
  route,
  color,
}: {
  route: RouteResult;
  color: string;
}) {
  const entries = composition(route.segments, route.distanceM);
  if (!entries.length) return null;
  const summary = entries
    .map((e) => `${e.label} ${Math.round(e.share * 100)}%`)
    .join(", ");

  return (
    <section className="surface-composition">
      <h3>Surfaces</h3>
      <div className="composition-bar" role="img" aria-label={summary}>
        {entries.map((e) => (
          <i
            key={e.ride}
            style={{
              width: `${e.share * 100}%`,
              background: bandColor(e.ride, color),
              // The table's profile opacity is what makes worse ground read darker; a floor
              // keeps tarmac from vanishing against the panel.
              opacity: Math.max(0.35, surfaceStyle(e.ride).profile.opacity),
            }}
          />
        ))}
      </div>
      <ul className="composition-legend">
        {entries.map((e) => (
          <li key={e.ride}>
            <ProfileSample ride={e.ride} color={color} />
            <span>{e.label}</span>
            <b>
              {(e.meters / 1000).toFixed(1)} km ·{" "}
              {e.share < 0.005 ? "<1" : Math.round(e.share * 100)}%
            </b>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The sections worth knowing about before setting off, worst first.
 *
 * Each row is a severity, a place and a length — never a time. Nothing in the app models
 * how long a ride takes, so "+2h" would be invented; how hard and how far is not.
 */
function RouteWarnings({
  warnings,
  onShow,
}: {
  warnings: Warning[];
  onShow: (meters: number) => void;
}) {
  if (!warnings.length) return null;
  const visible = warnings.slice(0, 6);
  const rest = warnings.slice(6);

  const row = (w: Warning, i: number) => (
    <li key={`${w.kind}-${w.startM.toFixed(0)}-${i}`}>
      <span className={`severity ${w.severity}`}>{w.headline}</span>
      <span className="warning-where">
        {(w.startM / 1000).toFixed(1)}–{(w.endM / 1000).toFixed(1)} km
      </span>
      {/* The keyboard-reachable way to point at a section: the chart's own markers are
          decorative, inside an SVG that reads as one image. */}
      <button
        className="locate-button"
        aria-label={`Show ${(w.startM / 1000).toFixed(1)} km on the map`}
        onClick={() => onShow(w.startM)}
      >
        <Crosshair size={13} />
      </button>
      <span className="warning-detail">{w.detail}</span>
    </li>
  );

  return (
    <section className="route-warnings">
      <h3>
        <TriangleAlert size={15} />
        Warnings · {warnings.length}
      </h3>
      <ul>{visible.map(row)}</ul>
      {rest.length > 0 && (
        <details>
          <summary>{`${rest.length} more`}</summary>
          <ul>{rest.map(row)}</ul>
        </details>
      )}
    </section>
  );
}

/**
 * The track's waypoints, where they fell along the route, and the place to prune them.
 *
 * The map is still where waypoints are added and moved — tap to add, drag a marker, long-press
 * or right-click to insert or remove — and it stays editable while this tab is open. The list
 * adds what a marker cannot say: how far in each one is and how high, plus a way to drop one
 * without hunting for it. Waypoints carry no names, so a row is numbered like its marker.
 */
function RouteWaypoints({
  track,
  onLocate,
  onEdit,
}: {
  track: Track;
  onLocate: (point: Point) => void;
  onEdit?: (anchors: Point[]) => void;
}) {
  if (!track.anchors.length)
    return onEdit ? (
      <section className="route-waypoints">
        <h3>Waypoints</h3>
        <p className="hint">Tap the map to add waypoints.</p>
      </section>
    ) : null;

  // Distances only mean something while the route still matches the waypoints; after an
  // edit they would describe points that have moved.
  const fresh = freshResult(track);
  const vertices = fresh
    ? anchorVertices(fresh, track.anchors.length)
    : undefined;

  return (
    <section className="route-waypoints">
      <h3>Waypoints · {track.anchors.length}</h3>
      <ul>
        {track.anchors.map((anchor, i) => {
          const vertex = vertices?.[i];
          const meters =
            fresh && vertex !== undefined
              ? metersAtVertex(fresh.segments, fresh.distanceM, vertex)
              : undefined;
          const height =
            fresh && meters !== undefined
              ? heightAtM(fresh.elevationProfile, meters)
              : null;
          const last = i === track.anchors.length - 1;
          const name =
            i === 0 ? "Start" : last ? "Finish" : `Waypoint ${i + 1}`;
          return (
            <li className="waypoint" key={i}>
              <b>{i + 1}</b>
              <span>{name}</span>
              <small>
                {meters === undefined
                  ? "—"
                  : `${(meters / 1000).toFixed(1)} km`}
                {height === null ? "" : ` · ${Math.round(height)} m`}
              </small>
              {/* The waypoint's own position, so this works before any route exists. */}
              <button
                className="locate-button"
                aria-label={`Show ${name.toLowerCase()} on the map`}
                onClick={() => onLocate(anchor)}
              >
                <Crosshair size={13} />
              </button>
              {onEdit && (
                <button
                  aria-label={`Remove waypoint ${i + 1}`}
                  onClick={() =>
                    onEdit(track.anchors.filter((_, j) => j !== i))
                  }
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {onEdit && (
        <p className="hint">
          Tap the map to add waypoints. Drag markers to move them; long-press or
          right-click one to insert or remove.
        </p>
      )}
    </section>
  );
}
