import { Route } from "@/hooks/useRoutes";
import { WaypointData } from "./MarkerManager";
import { RouteVisualization, VisualizationMode } from "./RouteVisualization";
import { before } from "node:test";

export interface TrackData {
  id: string;
  name: string;
  waypoints: WaypointData[];
  route: Route;
  createdAt: string;
  isPermanent: boolean;
  color?: string;
  isVisible?: boolean;
  visualizationMode?: VisualizationMode;
}

export class Track {
  private data: TrackData;
  private mapLayerId: string;
  private outlineLayerId: string;
  private symbolLayerId: string;
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
    this.symbolLayerId = `track-${data.id}-symbols`;
    this.onUpdate = onUpdate;
    this.onDelete = onDelete;
    this.trackManager = trackManager;

    // Ensure track has a color
    if (!this.data.color) {
      this.data.color = this.generateColor();
    }
  }

  private generateColor(): string {
    const colors = [
      "#3B82F6",
      "#EF4444",
      "#10B981",
      "#F59E0B",
      "#8B5CF6",
      "#EC4899",
      "#14B8A6",
      "#F97316",
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
  getVisualizationMode(): VisualizationMode {
    return this.data.visualizationMode || "default";
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

  setVisualizationMode(mode: VisualizationMode) {
    this.data.visualizationMode = mode;
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

  addToMap(map: any): void {
    if (!map || !this.data.route?.geojson) return;

    try {
      // Remove existing layers if they exist
      this.removeFromMap(map);

      const visualizationMode = this.getVisualizationMode();

      // Check if we have GeoJSON with segment properties for advanced visualization
      const hasSegmentData = this.data.route.geojson?.features?.some(
        (f: any) =>
          f.properties &&
          ("stress" in f.properties ||
            "surfaceSmoothness" in f.properties ||
            "slope" in f.properties)
      );

      if (visualizationMode !== "default" && hasSegmentData) {
        console.log("Using GeoJSON-based segment visualization");
        this.addGeoJSONBasedVisualization(map);
      } else {
        console.log("Using default visualization");
        this.addDefaultVisualization(map);
      }

      // Add interactive features to both layers
      this.addInteractiveFeatures(map);

      this.data.isVisible = true;
    } catch (error) {
      console.error("Error adding track to map:", error);
    }
  }

  private addDefaultVisualization(map: any): void {
    // Add source
    map.addSource(this.mapLayerId, {
      type: "geojson",
      data: this.data.route.geojson,
    });

    // Add outline layer
    map.addLayer({
      id: this.outlineLayerId,
      type: "line",
      source: this.mapLayerId,
      layout: {
        "line-join": "round",
        "line-cap": "round",
      },
      paint: {
        "line-color": "white",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          1,
          this.data.isPermanent ? 24 : 16,
          12,
          this.data.isPermanent ? 6 : 8,
          22,
          this.data.isPermanent ? 6 : 8,
        ],
        "line-opacity": 0.8,
      },
    });

    // Add main track layer
    map.addLayer({
      id: this.mapLayerId,
      type: "line",
      source: this.mapLayerId,
      layout: {
        "line-join": "round",
        "line-cap": "round",
      },
      paint: {
        "line-color": this.getColor(),
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          1,
          this.data.isPermanent ? 24 : 16,
          12,
          this.data.isPermanent ? 6 : 8,
          22,
          this.data.isPermanent ? 4 : 6,
        ],
        "line-opacity": 0.8,
      },
    });
  }

  private addGeoJSONBasedVisualization(map: any): void {
    const segmentGeoJSON = this.data.route.geojson;
    const symbolFeatures = this.generateSymbolFeatures(segmentGeoJSON.features);

    // Add source for the main track line
    map.addSource(this.mapLayerId, {
      type: "geojson",
      data: segmentGeoJSON,
    });

    // Add sources for symbol layers
    map.addSource(this.symbolLayerId, {
      type: "geojson",
      data: { type: "FeatureCollection", features: symbolFeatures },
    });

    // Add outline layer
    map.addLayer({
      id: this.outlineLayerId,
      type: "line",
      source: this.mapLayerId,
      before : "Road Label",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "white",
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 18, 14, 20],
        "line-opacity": 0.2,
      },
    });

    // Add main track layer with data-driven coloring for 'info' mode
    const solidLayerId = `${this.mapLayerId}-solid`;

    this.surfaceLayerIds = [solidLayerId];

    // Solid Layer
    map.addLayer({
      id: solidLayerId,
      type: "line",
      before : "Road Label",
      source: this.mapLayerId,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": this.createDataDrivenExpression(
          this.getVisualizationMode()
        ),
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 6, 14, 10],
        "line-opacity": 0.8
      },
    });



    // Add symbol layer
    map.addLayer({
      id: this.symbolLayerId,
      type: "symbol",
      source: this.symbolLayerId,
      before : "Road Label",
      layout: {
        "icon-image": ["get", "symbol"],
        "icon-size": 1.2,
        "icon-allow-overlap": false,
        "symbol-placement": "point",
 
      
        "symbol-sort-key": ["get", "priority"],
      },
      paint: {
        "icon-color": ["get", "color"],
        "icon-halo-color": "#fff",
        "icon-halo-width": 1,
        "icon-halo-blur": 1,
      },
    });
  }

  private addSegmentBasedVisualization(map: any): void {
    const sections = this.data.route.sections!;
    const visualizationMode = this.getVisualizationMode();

    console.log("Track sections data:", sections);
    console.log("Route GeoJSON:", this.data.route.geojson);

    // Check if sections have coordinates, if not, fall back to default visualization
    const hasValidSections = sections.some(
      (s) => s.coordinates && s.coordinates.length > 0
    );
    if (!hasValidSections) {
      console.log(
        "No valid section coordinates found, falling back to default visualization"
      );
      // For now, always fall back to default visualization until we fix section coordinate extraction
      this.addDefaultVisualization(map);
      return;
    }

    // Calculate max distance for distance-based visualization
    const maxDistance = Math.max(...sections.map((s) => s.distance));

    // Create segment-based GeoJSON
    const segmentGeoJSON = RouteVisualization.createSegmentGeoJSON(sections);
    console.log("Generated segment GeoJSON:", segmentGeoJSON);

    // Add source
    map.addSource(this.mapLayerId, {
      type: "geojson",
      data: segmentGeoJSON,
    });

    // Add outline layer
    map.addLayer({
      id: this.outlineLayerId,
      type: "line",
      source: this.mapLayerId,
      layout: {
        "line-join": "round",
        "line-cap": "round",
      },
      paint: {
        "line-color": "white",
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5,
          this.data.isPermanent ? 8 : 10,
          12,
          this.data.isPermanent ? 6 : 8,
          22,
          this.data.isPermanent ? 6 : 8,
        ],
        "line-opacity": 0.8,
      },
    });

    // Add main track layer with data-driven styling
    map.addLayer({
      id: this.mapLayerId,
      type: "line",
      source: this.mapLayerId,
      layout: {
        "line-join": "round",
        "line-cap": "round",
      },
      paint: {
        "line-color": this.createDataDrivenExpression(visualizationMode),
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5,
          this.data.isPermanent ? 6 : 8,
          12,
          this.data.isPermanent ? 4 : 6,
          22,
          this.data.isPermanent ? 4 : 6,
        ],
        "line-opacity": 0.8,
      },
    });
  }

  private createDataDrivenExpression(mode: VisualizationMode): any {
    if (mode === "info") {
      const baseExpression: any[] = ["case"];
      const mapping = RouteVisualization.getSurfaceColorMapping();
      mapping.forEach(({ value, color }) => {
        baseExpression.push(["==", ["get", "surfaceSmoothness"], value]);
        baseExpression.push(color);
      });
      baseExpression.push("#6B7280"); // Default color
      return baseExpression;
    }

    // Default color for 'default' mode
    return this.getColor();
  }

  private generateSymbolFeatures(features: any[]): any[] {
    const symbolFeatures: any[] = [];

    features.forEach((feature) => {
      const { stress, slope } = feature.properties;
      const midPoint = this.getMidPoint(feature.geometry.coordinates);

      // Priority-based symbol generation
      if (stress >= 4) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "car", "#EF4444", 0, 0)
        );
      } else if (stress >= 3) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "car", "#F97316", 10, 0)
        );
      } else if (slope > 12) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "triangle", "#EF4444", 20, 0)
        );
      } else if (slope < -12) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "triangle", "#EF4444", 20, 180)
        );
      } else if (slope > 8) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "triangle", "#F97316", 30, 0)
        );
      } else if (slope < -8) {
        symbolFeatures.push(
          this.createSymbolFeature(midPoint, "triangle", "#F97316", 30, 180)
        );
      }
    });

    return symbolFeatures;
  }

  private getMidPoint(coordinates: [number, number][]): [number, number] {
    return coordinates[Math.floor(coordinates.length / 2)];
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

    if (map.getLayer(this.symbolLayerId)) map.removeLayer(this.symbolLayerId);
    if (map.getLayer(this.outlineLayerId)) map.removeLayer(this.outlineLayerId);
    if (map.getLayer(this.mapLayerId)) map.removeLayer(this.mapLayerId);

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

  updateMapColor(map: any): void {
    if (!map || !this.isVisible()) return;

    try {
      if (map.getLayer(this.mapLayerId)) {
        map.setPaintProperty(this.mapLayerId, "line-color", this.getColor());
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

  toggleTrackVisibility(id: string): boolean {
    const track = this.tracks.get(id);
    if (track) {
      if (track.isVisible()) {
        track.removeFromMap(this.map);
      } else {
        track.addToMap(this.map);
      }
      this.notifyChange();
      return track.isVisible();
    }
    return false;
  }

  updateTrackColor(id: string, color: string): void {
    const track = this.tracks.get(id);
    if (track) {
      track.setColor(color);
      track.updateMapColor(this.map);
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

  setTrackVisualizationMode(id: string, mode: VisualizationMode): void {
    const track = this.tracks.get(id);
    if (track) {
      track.setVisualizationMode(mode);
      // Re-render the track with new visualization
      if (track.isVisible()) {
        track.addToMap(this.map);
      }
      this.notifyChange();
    }
  }

  setAllTracksVisualizationMode(mode: VisualizationMode): void {
    this.tracks.forEach((track) => {
      track.setVisualizationMode(mode);
      // Re-render visible tracks with new visualization
      if (track.isVisible()) {
        track.addToMap(this.map);
      }
    });
    this.notifyChange();
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
