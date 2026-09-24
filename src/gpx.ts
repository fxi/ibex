import { APP_VERSION } from "./version";
import type { Point, RouteResult } from "./routing/types";
import { NOTE_LABELS, type Note } from "./notes/types";

const escapeXML = (text: string) =>
  text.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );

/** Where Ibex keeps what only Ibex reads back. */
export const IBEX_GPX_NAMESPACE = "https://fxi.io/ibex/gpx/1";

/** What a planned track was drawn through, so importing the file makes it editable again. */
export type GpxPlan = { waypoints: Point[]; profileId: string };

/**
 * Write a route as GPX. Elevation is emitted when the profile covers the whole route, so
 * an exported file can be re-imported without inventing heights it never had. Notes go
 * out as waypoints, which is what a GPS unit shows along a course. The routing waypoints
 * do not: a device would show each one as a place. They go in `<extensions>`, which
 * devices ignore and Ibex reads back.
 */
export function exportGPX(
  route: RouteResult,
  name = "Ibex route",
  notes: Note[] = [],
  plan?: GpxPlan,
): string {
  // The profile is sampled along the route, not per vertex, so heights are matched by
  // cumulative distance rather than by index.
  const known = route.elevationProfile.filter(
    (p): p is [number, number] => p[1] !== null,
  );
  const heightAt = (meters: number): number | undefined => {
    if (!known.length) return undefined;
    let best = known[0];
    for (const sample of known)
      if (Math.abs(sample[0] - meters) < Math.abs(best[0] - meters))
        best = sample;
    return Math.abs(best[0] - meters) <= 250 ? best[1] : undefined;
  };

  let meters = 0;
  const points = route.geometry.map(([lon, lat], i) => {
    if (i > 0) {
      const [plon, plat] = route.geometry[i - 1];
      const toRad = Math.PI / 180;
      const dLat = (lat - plat) * toRad;
      const dLon = (lon - plon) * toRad;
      meters +=
        Math.hypot(dLon * Math.cos(((lat + plat) / 2) * toRad), dLat) * 6371000;
    }
    const ele = heightAt(meters);
    return `<trkpt lat="${lat}" lon="${lon}">${
      ele === undefined ? "" : `<ele>${ele.toFixed(1)}</ele>`
    }</trkpt>`;
  });

  const waypoints = notes.map(
    (n) =>
      `<wpt lat="${n.point[1]}" lon="${n.point[0]}"><name>${escapeXML(
        n.text || NOTE_LABELS[n.kind],
      )}</name>${
        n.hours ? `<desc>${escapeXML(n.hours)}</desc>` : ""
      }<type>${n.kind}</type></wpt>`,
  );

  const extensions = plan
    ? `<extensions><ibex:plan profile="${escapeXML(plan.profileId)}">${plan.waypoints
        .map(([lon, lat]) => `<ibex:waypoint lat="${lat}" lon="${lon}"/>`)
        .join("")}</ibex:plan></extensions>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Ibex ${APP_VERSION}" xmlns="http://www.topografix.com/GPX/1/1"${
    plan ? ` xmlns:ibex="${IBEX_GPX_NAMESPACE}"` : ""
  }>${waypoints.join("")}<trk><name>${escapeXML(
    name,
  )}</name><trkseg>${points.join("")}</trkseg></trk>${extensions}</gpx>`;
}

export function download(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
