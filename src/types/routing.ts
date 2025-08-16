export interface Point {
  lat: number;
  lon: number;
}

export interface LocationPoint {
  locationType: 'POINT';
  point: Point;
}

export interface RouteSettings {
  bikeType: 'CITY_BIKE' | 'ROAD_BIKE' | 'MOUNTAIN_BIKE' | 'HYBRID_BIKE' | 'FOLDING_BIKE' | 'ELECTRIC_BIKE' | 'CARGO_BIKE' | 'FIXIE_BIKE' | 'GRAVEL_BIKE' | 'RECUMBENT_BIKE' | 'ELECTRIC_CITY_BIKE' | 'ELECTRIC_ROAD_BIKE' | 'ELECTRIC_FOLDING_BIKE' | 'ELECTRIC_CARGO_BIKE' | 'ELECTRIC_FIXIE_BIKE' | 'ELECTRIC_HYBRID_BIKE' | 'ELECTRIC_GRAVEL_BIKE' | 'ELECTRIC_RECUMBENT_BIKE' | 'SCOOTER' | 'BIG_WHEEL_SCOOTER' | 'ELECTRIC_SCOOTER';
  averageSpeed: number;
  allowedTransportModes: string[];
  stairs: 'AVOID_IF_POSSIBLE' | 'STRICTLY_AVOID';
  pavements: 'AVOID_IF_POSSIBLE' | 'STRICTLY_AVOID';
  oneways: 'AVOID_IF_POSSIBLE' | 'STRICTLY_AVOID';
  traffic: 'IGNORE' | 'AVOID_IF_REASONABLE' | 'AVOID_IF_POSSIBLE';
  surface: 'IGNORE' | 'PREFER_NON_PAVED' | 'AVOID_BAD_SMOOTHNESS_ONLY' | 'PREFER_SMOOTH' | 'AVOID_NON_SMOOTH';
  climbs: 'IGNORE' | 'AVOID_IF_REASONABLE' | 'AVOID_IF_POSSIBLE';
  bikeSharingProvidersIds: string[];
  addRouteGeoJson: boolean;
  optimizeWaypointOrder: boolean;
  desiredLengthMeters?: number;
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
