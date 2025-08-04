export interface Point {
  lat: number;
  lon: number;
}

export interface LocationPoint {
  locationType: 'POINT';
  point: Point;
}

export interface RouteSettings {
  bikeType: 'GRAVEL_BIKE' | 'ROAD_BIKE' | 'MOUNTAIN_BIKE';
  averageSpeed: number;
  allowedTransportModes: string[];
  stairs: 'AVOID_IF_POSSIBLE' | 'ALLOW' | 'AVOID';
  pavements: 'AVOID_IF_POSSIBLE' | 'ALLOW' | 'AVOID';
  oneways: 'AVOID_IF_POSSIBLE' | 'ALLOW' | 'AVOID';
  traffic: 'AVOID_IF_REASONABLE' | 'ALLOW' | 'AVOID';
  surface: 'PREFER_NON_PAVED' | 'PREFER_PAVED' | 'NO_PREFERENCE';
  climbs: 'IGNORE' | 'AVOID' | 'PREFER';
  bikeSharingProvidersIds: string[];
  addRouteGeoJson: boolean;
  optimizeWaypointOrder: boolean;
}

export interface RoutingRequest {
  client: string;
  origin: LocationPoint;
  destination: LocationPoint;
  waypoints: LocationPoint[];
  settings: RouteSettings;
  departureDateTime: string;
  key: string;
  uid: null;
}

export interface RouteSection {
  distance: number; // Route segment distance in meters
  infrastructure: 'CYCLEWAY' | 'BIKE_LANE' | 'FOOTWAY' | 'OFFROAD' | 'ROAD';
  stress: 1 | 2 | 3 | 4 | 5; // Traffic stress level (1 = no cars, 5 = high traffic)
  surfaceSmoothness: 'PAVED_EXCELLENT' | 'PAVED_GOOD' | 'PAVED_INTERMEDIATE' | 'PAVED_BAD' | 
                     'UNPAVED_INTERMEDIATE' | 'UNPAVED_BAD' | 'UNPAVED_HORRIBLE' | 'UNPAVED_IMPASSABLE' | 'UNKNOWN';
  slope: number; // Slope in percent
  coordinates?: [number, number][]; // Segment coordinates
}

export interface Route {
  geoJson: any;
  sections?: RouteSection[];
  distance?: number;
  duration?: number;
}

export interface RoutingResponse {
  routes: Route[];
  status: string;
}