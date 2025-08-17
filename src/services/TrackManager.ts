import { Route } from "@/hooks/useRoutes";
import { WaypointData } from "./MarkerManager";
import { RouteVisualization } from "./RouteVisualization";

//const palette1 = ["#b09502", "#986408", "#733a0b", "#441b08", "#000000"];
const palette2 = ["#e2d705", "#eab35a", "#ed8c82", "#ea5fa4", "#e205c4"];

export interface TrackData {
  id: string;
  name: string;
  waypoints: WaypointData[];
  route: Route;
  createdAt: string;
  isPermanent: boolean;
  color?: string;
  isVisible?: boolean;
}

export class Track {
  private data: TrackData;
  private mapLayerId: string;
  private outlineLayerId: string;
  private unpavedLayerId: string;
  private symbolLayerId: string;
  private directionsLayerId: string;
  private distanceMarkersLayerId: string;
  private surfaceLayerIds: string[] = [];
  private onUpdate: (track: Track) => void;
  private onDelete: (id: string) => void;
  private trackManager?: TrackManager;

  constructor(
    data: TrackData,
    onUpdate: (track: Track) => void,
    onDelete: (id: string) => void,
    trackManager?: TrackManager
  ) {
    this.data = { ...data };
    this.mapLayerId = `track-${data.id}`;
    this.outlineLayerId = `track-${data.id}-outline`;
    this.unpavedLayerId = `track-${data.id}-unpaved`;
    this.symbolLayerId = `track-${data.id}-symbols`;
    this.directionsLayerId = `track-${data.id}-directions`;
    this.distanceMarkersLayerId = `track-${data.id}-distance-markers`;
    this.onUpdate = onUpdate;
    this.onDelete = onDelete;
    this.trackManager = trackManager;

    // Ensure track has a color
    if (!this.data.color) {
      this.data.color = this.generateColor();
    }
  }

  private generateColor(): string {
    // Brighter, more saturated colors
    const colors = [
      "#FF1493", // DeepPink
      "#FF4500", // OrangeRed
      "#FFD700", // Gold
      "#ADFF2F", // GreenYellow
      "#00FFFF", // Aqua
      "#1E90FF", // DodgerBlue
      "#9932CC", // DarkOrchid
      "#FF00FF", // Magenta
    ];
    const index = Math.abs(
      this.data.id.split("").reduce((a, b) => a + b.charCodeAt(0), 0)
    );
    return colors[index % colors.length];
  }

  // Getters
  getId(): string {
    return this.data.id;
  }
  getName(): string {
    return this.data.name;
  }
  getColor(): string {
    return this.data.color || this.generateColor();
  }
  getWaypoints(): WaypointData[] {
    return [...this.data.waypoints];
  }
  getRoute(): Route {
    return this.data.route;
  }
  getCreatedAt(): string {
    return this.data.createdAt;
  }
  isPermanentTrack(): boolean {
    return this.data.isPermanent;
  }
  isVisible(): boolean {
    return this.data.isVisible || false;
  }
  getData(): TrackData {
    return { ...this.data };
  }
  getMapLayerId(): string {
    return this.mapLayerId;
  }
  getOutlineLayerId(): string {
    return this.outlineLayerId;
  }

  getBounds(): any | null {
    if (!this.data.route?.geojson) return null;

    const coordinates = this.getAllCoordinates();
    if (coordinates.length === 0) return null;

    const maplibregl = this.trackManager?.getMapLibreGl();
    if (!maplibregl) return null;

    const bounds = coordinates.reduce((bounds, coord) => {
      return bounds.extend(coord);
    }, new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));

    return bounds;
  }

  // Setters
  setName(name: string) {
    this.data.name = name;
    this.onUpdate(this);
  }

  setColor(color: string) {
    this.data.color = color;
    this.onUpdate(this);
  }

  setVisibility(visible: boolean) {
    this.data.isVisible = visible;
    this.onUpdate(this);
  }

  makePermanent() {
    this.data.isPermanent = true;
    this.onUpdate(this);
  }

  // Actions
  delete() {
    this.onDelete(this.data.id);
  }

  private getAllCoordinates(): [number, number][] {
    let allCoordinates: [number, number][] = [];
    const geojson = this.data.route.geojson;

    if (geojson.features) {
      geojson.features.forEach((feature: any) => {
        if (feature.geometry?.coordinates) {
          if (feature.geometry.type === "LineString") {
            allCoordinates.push(...feature.geometry.coordinates);
          } else if (feature.geometry.type === "MultiLineString") {
            feature.geometry.coordinates.forEach((line: any) =>
              allCoordinates.push(...line)
            );
          }
        }
      });
    } else if (geojson.geometry?.coordinates) {
      if (geojson.geometry.type === "LineString") {
        allCoordinates = geojson.geometry.coordinates;
      } else if (geojson.geometry.type === "MultiLineString") {
        geojson.geometry.coordinates.forEach((line: any) =>
          allCoordinates.push(...line)
        );
      }
    }

    return allCoordinates;
  }

  exportAsGPX(): void {
    try {
      if (!this.data.route?.geojson) {
        alert("No route data available for export");
        return;
      }

      const allCoordinates = this.getAllCoordinates();

      console.log("Extracted coordinates for GPX:", allCoordinates.length);

      if (allCoordinates.length === 0) {
        alert("No coordinates found in route");
        return;
      }

      const trackPoints = allCoordinates
        .map(
          (coord: [number, number]) =>
            `      <trkpt lat="${coord[1]}" lon="${coord[0]}"></trkpt>`
        )
        .join("\n");

      const distance = this.data.route.stats?.distanceMeters
        ? (this.data.route.stats.distanceMeters / 1000).toFixed(1) + "km"
        : "N/A";

      const gpxContent = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ibex Route Planner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${this.data.name}</name>
    <desc>Distance: ${distance}</desc>
  </metadata>
  <trk>
    <name>${this.data.name}</name>
    <trkseg>
${trackPoints}
    </trkseg>
  </trk>
</gpx>`;

      const blob = new Blob([gpxContent], { type: "application/gpx+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${this.data.name.replace(/\s+/g, "-")}.gpx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Error exporting GPX:", error);
      alert("Error exporting GPX file");
    }
  }

  addToMap(map: any, useSurfaceQuality: boolean = false): void {
    if (!map || !this.data.route?.geojson) return;

    try {
      // Remove existing layers if they exist
      this.removeFromMap(map);

      this.addGeoJSONBasedVisualization(map, useSurfaceQuality);

      // Add interactive features to both layers
      this.addInteractiveFeatures(map);

      this.data.isVisible = true;
    } catch (error) {
      console.error("Error adding track to map:", error);
    }
  }

  private addGeoJSONBasedVisualization(
    map: any,
    useSurfaceQuality: boolean
  ): void {
    const styleConfig = RouteVisualization.getStyleConfig();
    const segmentGeoJSON = this.data.route.geojson;
    const groupedGeoJSON = RouteVisualization.createGroupedGeoJSON(
      segmentGeoJSON.features.map((f: any) => ({
        ...f.properties,
        coordinates: f.geometry.coordinates,
      }))
    );
    const symbolFeatures = this.generateSymbolFeatures(segmentGeoJSON.features);
    const distanceMarkers = this.generateDistanceMarkers(
      segmentGeoJSON.features
    );

    // Add source for the main track line
    map.addSource(this.mapLayerId, {
      type: "geojson",
      data: groupedGeoJSON,
    });

    // Add sources for symbol layers
    map.addSource(this.symbolLayerId, {
      type: "geojson",
      data: { type: "FeatureCollection", features: symbolFeatures },
    });

    // Add source for distance markers
    map.addSource(this.distanceMarkersLayerId, {
      type: "geojson",
      data: { type: "FeatureCollection", features: distanceMarkers },
    });

    // Add outline layer
    map.addLayer({
      id: this.outlineLayerId,
      type: "line",
      source: this.mapLayerId,
      before: "ibex_anchor",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "white",
        "line-width": styleConfig.outlineWidthExpression,
        "line-opacity": 1,
      },
    });

    // Add main track layer with data-driven coloring
    const solidLayerId = `${this.mapLayerId}-solid`;
    this.surfaceLayerIds = [solidLayerId];

    map.addLayer({
      id: solidLayerId,
      type: "line",
      source: this.mapLayerId,
      before: "ibex_anchor",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": useSurfaceQuality
          ? styleConfig.surfaceColorExpression()
          : this.getColor(),
        "line-width": styleConfig.lineWidthExpression,
        "line-opacity": 1,
      },
    });

    // Add unpaved overlay
    map.addLayer({
      id: this.unpavedLayerId,
      type: "line",
      source: this.mapLayerId,
      before: "ibex_anchor",
      layout: {
        "line-join": "round",
        "line-cap": "round",
      },
      paint: {
        "line-pattern": styleConfig.unpavedPatternExpression(),
        "line-width": styleConfig.lineWidthExpression, // Keep a base width
        "line-opacity": 1,
        "line-color": "red",
      },
      filter: styleConfig.unpavedFilterExpression,
    });

    // Add symbol layer
    map.addLayer({
      id: this.symbolLayerId,
      type: "symbol",
      source: this.symbolLayerId,
      before: "ibex_anchor",
      layout: {
        "icon-image": ["get", "symbol"],
        "icon-size": 1.5,
        "icon-allow-overlap": false,
        "symbol-avoid-edges": true,
        "icon-rotate": ["get", "rotation"],
        "symbol-sort-key": ["get", "priority"],
      },
      paint: {
        "icon-color": ["get", "color"],
        "icon-halo-color": "#fff",
        "icon-halo-width": 4,
      },
    });

    // Add direction arrows layer
    map.addLayer({
      id: this.directionsLayerId,
      type: "symbol",
      source: this.mapLayerId,
      layout: {
        "symbol-placement": "line",
        "icon-image": "chevron",
        "icon-size": 2,
        "icon-rotate": 90,
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": false,
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-color": this.getColor(),
        "icon-halo-color": "#fff",
        "icon-halo-width": 4,
      },
    });

    // Add distance markers layer
    map.addLayer({
      id: this.distanceMarkersLayerId,
      type: "symbol",
      source: this.distanceMarkersLayerId,
      before: "ibex_anchor",
      layout: {
        "icon-image": "circle",
        "icon-size": 20,
        "icon-allow-overlap": false,
        "symbol-avoid-edges": true,
        "symbol-sort-key": 0,
      },
      paint: {
        "icon-color": this.getColor(),
        "icon-halo-color": "#fff",
        "icon-halo-width": 4,
      },
    });

    map.addLayer({
      id: `${this.distanceMarkersLayerId}-label`,
      type: "symbol",
      source: this.distanceMarkersLayerId,
      before: "ibex_anchor",
      layout: {
        "icon-image": "circle",
        "symbol-sort-key": 0,
        "icon-size": 1.3,
        "text-field": ["get", "label"],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-size": 12,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#FFF",
        "icon-color": this.getColor(),
        "icon-halo-color": "#fff",
        "icon-halo-width": 5,
      },
    });
  }

  private generateSymbolFeatures(features: any[]): any[] {
    const symbolFeatures: any[] = [];
    features.forEach((feature) => {
      const { stress, slope, surfaceSmoothness } = feature.properties;
      const midPoint = this.getMidPoint(feature.geometry.coordinates);

      // Priority-based symbol generation with updated color scheme
      if (stress >= 5) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "car", palette2[4], 0, 0) // Red
        );
      } else if (stress >= 4) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "car", palette2[3], 0, 0) // Orange
        );
      } else if (stress >= 3) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "car", palette2[1], 10, 0) // Yellow
        );
      } else if (slope > 20) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "chevron_4", palette2[4], 20, 0) // red strong
        );
      } else if (slope < -20) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "chevron_4", palette2[4], 20, 180) // red strong
        );
      } else if (slope > 15) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "chevron_3", palette2[3], 20, 0) // Red
        );
      } else if (slope < -15) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "chevron_3", palette2[3], 20, 180) // Red
        );
      } else if (slope > 10) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "chevron_2", palette2[2], 30, 0) // Orange
        );
      } else if (slope < -10) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "chevron_2", palette2[2], 30, 180) // Orange
        );
      } else if (slope > 6) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "chevron_1", palette2[1], 30, 0) // Yellow
        );
      } else if (slope < -6) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "chevron_1", palette2[1], 30, 180) // Yellow
        );
      } else if (slope > 2) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "chevron_1", palette2[0], 30, 0) // Light Yellow
        );
      } else if (slope < -2) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "chevron_1", palette2[0], 30, 180) // Light Yellow
        );
      }
    });

    return symbolFeatures;
  }

  private getMidPoint(coordinates: [number, number][]): [number, number] {
    return coordinates[Math.floor(coordinates.length / 2)];
  }

  private generateDistanceMarkers(features: any[]): any[] {
    const markers = [];
    let totalDistance = 0;
    const interval = 5000; // 7km
    let nextMarkerDistance = interval;

    for (const feature of features) {
      const coords = feature.geometry.coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        const start = coords[i];
        const end = coords[i + 1];
        const segmentDistance = this.haversineDistance(start, end);

        while (totalDistance + segmentDistance >= nextMarkerDistance) {
          const distanceToMarker = nextMarkerDistance - totalDistance;
          const fraction = distanceToMarker / segmentDistance;
          const markerCoord = this.interpolatePoint(start, end, fraction);

          markers.push({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: markerCoord,
            },
            properties: {
              label: `${nextMarkerDistance / 1000}`,
            },
          });

          nextMarkerDistance += interval;
        }
        totalDistance += segmentDistance;
      }
    }
    return markers;
  }

  private haversineDistance(
    coords1: [number, number],
    coords2: [number, number]
  ): number {
    const toRad = (x: number) => (x * Math.PI) / 180;
    const R = 6371e3; // Earth radius in meters

    const dLat = toRad(coords2[1] - coords1[1]);
    const dLon = toRad(coords2[0] - coords1[0]);
    const lat1 = toRad(coords1[1]);
    const lat2 = toRad(coords2[1]);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  private interpolatePoint(
    p1: [number, number],
    p2: [number, number],
    fraction: number
  ): [number, number] {
    const lon = p1[0] + (p2[0] - p1[0]) * fraction;
    const lat = p1[1] + (p2[1] - p1[1]) * fraction;
    return [lon, lat];
  }

  private createSymbolFeature(
    coordinates: [number, number],
    symbolName: string,
    color: string,
    priority: number,
    rotation: number
  ): any {
    return {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates,
      },
      properties: {
        symbol: symbolName,
        color: color,
        rotation: rotation,
        priority: priority,
      },
    };
  }

  private addInteractiveFeatures(map: any): void {
    // Add pointer cursor on hover
    map.on("mouseenter", this.mapLayerId, () => {
      map.getCanvas().style.cursor = "pointer";
      // Notify diagnostic system about hover
      if (this.trackManager) {
        this.trackManager.notifyFeatureHovered(this.getName());
      }
    });

    map.on("mouseleave", this.mapLayerId, () => {
      map.getCanvas().style.cursor = "";
    });

    // Add right-click context menu (desktop)
    map.on("contextmenu", this.mapLayerId, (e: any) => {
      e.preventDefault();
      e.originalEvent.stopPropagation();
      this.showContextMenu(e.point.x, e.point.y);
    });

    // Add long-tap context menu (mobile) - 500ms
    let longTapTimer: NodeJS.Timeout | null = null;
    let tapStart = { x: 0, y: 0 };

    map.on("touchstart", this.mapLayerId, (e: any) => {
      if (e.originalEvent.touches.length === 1) {
        const touch = e.originalEvent.touches[0];
        tapStart = { x: touch.clientX, y: touch.clientY };

        longTapTimer = setTimeout(() => {
          e.preventDefault();
          e.originalEvent.stopPropagation();
          this.showContextMenu(tapStart.x, tapStart.y);
        }, 500);
      }
    });

    map.on("touchmove", this.mapLayerId, (e: any) => {
      if (longTapTimer) {
        clearTimeout(longTapTimer);
        longTapTimer = null;
      }
    });

    map.on("touchend", this.mapLayerId, () => {
      if (longTapTimer) {
        clearTimeout(longTapTimer);
        longTapTimer = null;
      }
    });
  }

  private showContextMenu(x: number, y: number): void {
    // Create context menu element
    const contextMenu = document.createElement("div");
    contextMenu.className =
      "track-context-menu absolute bg-white border border-gray-200 rounded-md shadow-lg z-50 py-1 min-w-32";
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;

    // Create menu items based on track type
    const menuItems = this.isPermanentTrack()
      ? [
          {
            label: this.isVisible() ? "Hide" : "Show",
            action: () => this.toggleVisibility(),
          },
          { label: "Hide all others", action: () => this.hideAllOthers() },
          { label: "Export GPX", action: () => this.exportAsGPX() },
          {
            label: "Delete",
            action: () => this.confirmDelete(),
            destructive: true,
          },
        ]
      : [
          { label: "Save", action: () => this.promptSave() },
          { label: "Export GPX", action: () => this.exportAsGPX() },
          { label: "Delete", action: () => this.delete(), destructive: true },
        ];

    menuItems.forEach((item) => {
      const menuItem = document.createElement("button");
      menuItem.className = `block w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${
        item.destructive ? "text-red-600 hover:bg-red-50" : "text-gray-700"
      }`;
      menuItem.textContent = item.label;
      menuItem.onclick = () => {
        item.action();
        document.body.removeChild(contextMenu);
      };
      contextMenu.appendChild(menuItem);
    });

    // Add to document and remove on outside click
    document.body.appendChild(contextMenu);

    const removeMenu = (event: MouseEvent) => {
      if (!contextMenu.contains(event.target as Node)) {
        document.body.removeChild(contextMenu);
        document.removeEventListener("click", removeMenu);
      }
    };

    setTimeout(() => document.addEventListener("click", removeMenu), 0);
  }

  private toggleVisibility(): void {
    if (this.trackManager) {
      this.trackManager.toggleTrackVisibility(this.getId());
    }
  }

  private hideAllOthers(): void {
    if (this.trackManager) {
      this.trackManager.hideAllOtherTracks(this.getId());
    }
  }

  private confirmDelete(): void {
    if (
      confirm(
        `Are you sure you want to delete "${this.getName()}"? This action cannot be undone.`
      )
    ) {
      this.delete();
    }
  }

  private promptSave(): void {
    const name = prompt("Enter a name for this track:", this.getName());
    if (name && name.trim() && this.trackManager) {
      this.trackManager.saveTemporaryTrackAsPermanent(
        this.getId(),
        name.trim()
      );
    }
  }

  removeFromMap(map: any): void {
    if (!map) return;

    this.surfaceLayerIds.forEach((layerId) => {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    });
    this.surfaceLayerIds = [];

    if (map.getLayer(`${this.distanceMarkersLayerId}-label`))
      map.removeLayer(`${this.distanceMarkersLayerId}-label`);
    if (map.getLayer(this.distanceMarkersLayerId))
      map.removeLayer(this.distanceMarkersLayerId);
    if (map.getLayer(this.symbolLayerId)) map.removeLayer(this.symbolLayerId);
    if (map.getLayer(this.directionsLayerId))
      map.removeLayer(this.directionsLayerId);
    if (map.getLayer(this.unpavedLayerId)) map.removeLayer(this.unpavedLayerId);
    if (map.getLayer(this.outlineLayerId)) map.removeLayer(this.outlineLayerId);
    if (map.getLayer(this.mapLayerId)) map.removeLayer(this.mapLayerId);

    if (map.getSource(this.distanceMarkersLayerId))
      map.removeSource(this.distanceMarkersLayerId);
    if (map.getSource(this.symbolLayerId)) map.removeSource(this.symbolLayerId);
    if (map.getSource(this.mapLayerId)) map.removeSource(this.mapLayerId);

    this.data.isVisible = false;
  }

  private removeInteractiveFeatures(map: any): void {
    try {
      // Remove all event listeners for this track
      map.off("mouseenter", this.mapLayerId);
      map.off("mouseleave", this.mapLayerId);
      map.off("contextmenu", this.mapLayerId);
      map.off("touchstart", this.mapLayerId);
      map.off("touchmove", this.mapLayerId);
      map.off("touchend", this.mapLayerId);
    } catch (error) {
      console.error("Error removing interactive features:", error);
    }
  }

  updateMapColor(map: any, useSurfaceQuality: boolean = false): void {
    if (!map || !this.isVisible()) return;

    try {
      // The solid layer is the first one in surfaceLayerIds
      const solidLayerId = this.surfaceLayerIds[0];
      if (solidLayerId && map.getLayer(solidLayerId)) {
        const color = useSurfaceQuality
          ? RouteVisualization.getStyleConfig().surfaceColorExpression()
          : this.getColor();
        map.setPaintProperty(solidLayerId, "line-color", color);
      }
    } catch (error) {
      console.error("Error updating track color:", error);
    }
  }
}

export class TrackManager {
  private tracks = new Map<string, Track>();
  private map: any;
  private maplibregl: any;
  private onTracksChange?: (tracks: Track[]) => void;
  private lastHoveredFeature?: string;

  constructor(
    map: any,
    maplibregl: any,
    onTracksChange?: (tracks: Track[]) => void
  ) {
    this.map = map;
    this.maplibregl = maplibregl;
    this.onTracksChange = onTracksChange;
  }

  getMapLibreGl(): any {
    return this.maplibregl;
  }

  getMap(): any {
    return this.map;
  }

  addTrack(trackData: TrackData): Track {
    const track = new Track(
      trackData,
      (updatedTrack) => this.handleTrackUpdate(updatedTrack),
      (id) => this.deleteTrack(id),
      this
    );

    this.tracks.set(trackData.id, track);
    this.notifyChange();
    return track;
  }

  deleteTrack(id: string): boolean {
    console.log(`TrackManager: Deleting track ${id}`);
    const track = this.tracks.get(id);
    if (track) {
      track.removeFromMap(this.map);
      this.tracks.delete(id);
      this.notifyChange();
      console.log(`TrackManager: Successfully deleted track ${id}`);
      return true;
    }
    console.warn(`TrackManager: Track ${id} not found for deletion`);
    return false;
  }

  getTrack(id: string): Track | undefined {
    return this.tracks.get(id);
  }

  getAllTracks(): Track[] {
    return Array.from(this.tracks.values());
  }

  getPermanentTracks(): Track[] {
    return this.getAllTracks().filter((track) => track.isPermanentTrack());
  }

  getTemporaryTracks(): Track[] {
    return this.getAllTracks().filter((track) => !track.isPermanentTrack());
  }

  getVisibleTracks(): Track[] {
    return this.getAllTracks().filter((track) => track.isVisible());
  }

  clearTemporaryTracks(): void {
    const tempTracks = this.getTemporaryTracks();
    tempTracks.forEach((track) => {
      track.removeFromMap(this.map);
      this.tracks.delete(track.getId());
    });
    this.notifyChange();
  }

  clearAllTracks(): void {
    this.tracks.forEach((track) => track.removeFromMap(this.map));
    this.tracks.clear();
    this.notifyChange();
  }

  toggleTrackVisibility(
    id: string,
    useSurfaceQuality: boolean = false
  ): boolean {
    const track = this.tracks.get(id);
    if (track) {
      if (track.isVisible()) {
        track.removeFromMap(this.map);
      } else {
        track.addToMap(this.map, useSurfaceQuality);
      }
      this.notifyChange();
      return track.isVisible();
    }
    return false;
  }

  updateTrackColor(
    id: string,
    color: string,
    useSurfaceQuality: boolean = false
  ): void {
    const track = this.tracks.get(id);
    if (track) {
      track.setColor(color);
      track.updateMapColor(this.map, useSurfaceQuality);
      this.notifyChange();
    }
  }

  renameTrack(id: string, name: string): void {
    const track = this.tracks.get(id);
    if (track) {
      track.setName(name);
      this.notifyChange();
    }
  }

  makePermanent(id: string): void {
    const track = this.tracks.get(id);
    if (track) {
      track.makePermanent();
      this.notifyChange();
    }
  }

  hideAllOtherTracks(exceptId: string): void {
    this.tracks.forEach((track) => {
      if (track.getId() !== exceptId && track.isVisible()) {
        track.removeFromMap(this.map);
      }
    });
    this.notifyChange();
  }

  zoomToTrack(id: string): void {
    const track = this.getTrack(id);
    if (!track) return;

    const bounds = track.getBounds();
    if (bounds) {
      this.map.fitBounds(bounds, {
        padding: 60, // Add some padding around the track
        duration: 1000, // Smooth animation
        essential: true,
      });
    }
  }

  saveTemporaryTrackAsPermanent(id: string, name: string): void {
    const track = this.tracks.get(id);
    if (track && !track.isPermanentTrack()) {
      track.setName(name);
      track.makePermanent();
      this.notifyChange();
    }
  }

  notifyFeatureHovered(featureName: string): void {
    this.lastHoveredFeature = featureName;
  }

  getLastHoveredFeature(): string | undefined {
    return this.lastHoveredFeature;
  }

  exportMultipleTracks(trackIds: string[]): void {
    // For now, export each track separately
    // Could be enhanced to create a single multi-track GPX
    trackIds.forEach((id) => {
      const track = this.tracks.get(id);
      if (track) {
        track.exportAsGPX();
      }
    });
  }

  private handleTrackUpdate(updatedTrack: Track): void {
    // Track has been updated, notify listeners
    this.notifyChange();
  }

  private notifyChange(): void {
    if (this.onTracksChange) {
      this.onTracksChange(this.getAllTracks());
    }
  }

  // Persistence methods
  saveToLocalStorage(key: string): void {
    const tracksData = this.getAllTracks().map((track) => track.getData());
    localStorage.setItem(key, JSON.stringify(tracksData));
  }

  loadFromLocalStorage(key: string): void {
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const tracksData: TrackData[] = JSON.parse(saved);
        tracksData.forEach((trackData) => {
          // Set all loaded tracks to invisible by default
          const trackWithDefaultVisibility = {
            ...trackData,
            isVisible: false,
          };
          this.addTrack(trackWithDefaultVisibility);
        });
      }
    } catch (error) {
      console.error("Error loading tracks from localStorage:", error);
    }
  }
}
