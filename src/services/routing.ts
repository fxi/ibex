import { RoutingRequest, RoutingResponse, Point, RouteSettings } from '@/types/routing';

const API_BASE_URL = 'https://uc1.umotional.net/urbancyclers-api/v7';
const API_KEY = 'ZK7hRQamGXpAeQDfRiCveVyBjdtGp7JU';

const defaultSettings: RouteSettings = {
  bikeType: 'GRAVEL_BIKE',
  averageSpeed: 20,
  allowedTransportModes: ['BIKE'],
  stairs: 'AVOID_IF_POSSIBLE',
  pavements: 'AVOID_IF_POSSIBLE',
  oneways: 'AVOID_IF_POSSIBLE',
  traffic: 'AVOID_IF_REASONABLE',
  surface: 'PREFER_NON_PAVED',
  climbs: 'IGNORE',
  bikeSharingProvidersIds: [],
  addRouteGeoJson: true,
  optimizeWaypointOrder: true,
};

export class RoutingApiService {
  static async getRoutes(
    origin: Point,
    destination: Point,
    waypoints: Point[] = [],
    settings: Partial<RouteSettings> = {}
  ): Promise<RoutingResponse> {
    const requestData: RoutingRequest = {
      client: 'WEB',
      origin: {
        locationType: 'POINT',
        point: origin,
      },
      destination: {
        locationType: 'POINT',
        point: destination,
      },
      waypoints: waypoints.map(wp => ({
        locationType: 'POINT' as const,
        point: wp,
      })),
      settings: { ...defaultSettings, ...settings },
      departureDateTime: new Date().toISOString(),
      key: API_KEY,
      uid: null,
    };

    try {
      const response = await fetch(`${API_BASE_URL}/routing?key=${API_KEY}`, {
        method: 'POST',
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'en-GB,en;q=0.8',
          'content-type': 'application/json; charset=UTF-8',
        },
        referrer: "https://demo.cyclers.tech/",
        body: JSON.stringify(requestData),
        mode: 'cors',
        credentials: 'omit',
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Routing API error:', error);
      throw new Error('Failed to fetch routes. Please try again.');
    }
  }
}
