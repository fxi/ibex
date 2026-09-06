import type { RouteResult } from "./routing/types";
export function exportGPX(route: RouteResult): string {
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Cyclatractor" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Cyclatractor route</name><trkseg>${route.geometry.map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}"/>`).join("")}</trkseg></trk></gpx>`;
}
export function download(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
