import markerSvg from "/symbols/marker.svg?raw";

export interface WaypointData {
  id: string;
  lng: number;
  lat: number;
}

export class Marker {
  private id: string;
  private maplibreMarker: any;
  private element: HTMLElement;
  private onRemove: (id: string) => void;
  private onUpdate: (id: string, lng: number, lat: number) => void;
  private draggedRecently = false;
  private textElement!: SVGTextElement;

  constructor(
    id: string,
    lng: number,
    lat: number,
    number: number,
    maplibregl: any,
    map: any,
    onRemove: (id: string) => void,
    onUpdate: (id: string, lng: number, lat: number) => void
  ) {
    this.id = id;
    this.onRemove = onRemove;
    this.onUpdate = onUpdate;

    // Create marker element
    this.element = document.createElement("div");
    this.element.innerHTML = markerSvg;
    const svgElement = this.element.firstChild as SVGSVGElement;
    svgElement.classList.add("numbered-marker");

    const textElement = svgElement.querySelector(".marker_content");
    if (textElement instanceof SVGTextElement) {
      this.textElement = textElement;
      this.textElement.setAttribute("fill", "black");
      this.textElement.setAttribute("font-size", "60");
      this.textElement.setAttribute("font-weight", "bold");
      this.textElement.textContent = number.toString();
    }

    // Create MapLibre marker
    this.maplibreMarker = new maplibregl.Marker({
      element: this.element,
      draggable: true,
    })
      .setLngLat([lng, lat])
      .addTo(map);

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    // Drag handlers
    this.maplibreMarker.on("dragstart", () => {
      this.draggedRecently = true;
    });

    this.maplibreMarker.on("dragend", () => {
      const lngLat = this.maplibreMarker.getLngLat();
      this.onUpdate(this.id, lngLat.lng, lngLat.lat);

      // Reset drag flag after delay
      setTimeout(() => {
        this.draggedRecently = false;
      }, 100);
    });

    // Click to remove handler
    this.element.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!this.draggedRecently) {
        this.onRemove(this.id);
      }
    });
  }

  updateNumber(number: number) {
    if (this.textElement) {
      this.textElement.textContent = number.toString();
    }
  }

  getPosition() {
    return this.maplibreMarker.getLngLat();
  }

  remove() {
    this.maplibreMarker.remove();
  }

  getId() {
    return this.id;
  }
}

export class MarkerManager {
  private markers = new Map<string, Marker>();
  private map: any;
  private maplibregl: any;
  private onWaypointsChange?: (waypoints: WaypointData[]) => void;

  constructor(
    map: any,
    maplibregl: any,
    onWaypointsChange?: (waypoints: WaypointData[]) => void
  ) {
    this.map = map;
    this.maplibregl = maplibregl;
    this.onWaypointsChange = onWaypointsChange;
  }

  addMarker(lng: number, lat: number): string {
    const id = `marker-${Date.now()}-${Math.random()}`;
    const number = this.markers.size + 1;

    const marker = new Marker(
      id,
      lng,
      lat,
      number,
      this.maplibregl,
      this.map,
      (markerId) => this.removeMarker(markerId),
      (markerId, newLng, newLat) =>
        this.updateMarkerPosition(markerId, newLng, newLat)
    );

    this.markers.set(id, marker);
    this.notifyChange();
    return id;
  }

  removeMarker(id: string) {
    const marker = this.markers.get(id);
    if (marker) {
      marker.remove();
      this.markers.delete(id);
      this.renumberMarkers();
      this.notifyChange();
    }
  }

  private updateMarkerPosition(id: string, lng: number, lat: number) {
    // Position is already updated in MapLibre, just notify React
    this.notifyChange();
  }

  private renumberMarkers() {
    let index = 1;
    this.markers.forEach((marker) => {
      marker.updateNumber(index++);
    });
  }

  clearAllMarkers() {
    this.markers.forEach((marker) => marker.remove());
    this.markers.clear();
    this.notifyChange();
  }

  setAllMarkers(waypoints: { lng: number; lat: number }[]): void {
    this.clearAllMarkers();
    waypoints.forEach((wp) => this.addMarker(wp.lng, wp.lat));
  }

  getWaypoints(): WaypointData[] {
    const waypoints: WaypointData[] = [];
    this.markers.forEach((marker) => {
      const pos = marker.getPosition();
      waypoints.push({
        id: marker.getId(),
        lng: pos.lng,
        lat: pos.lat,
      });
    });
    return waypoints;
  }

  getMarkerCount(): number {
    return this.markers.size;
  }

  private notifyChange() {
    if (this.onWaypointsChange) {
      this.onWaypointsChange(this.getWaypoints());
    }
  }
}
