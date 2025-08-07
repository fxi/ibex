import { RouteSection } from '@/types/routing';

export interface ColorMapping {
  value: string | number;
  color: string;
  label: string;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
}

const TrackStyleConfig = {
  surfaceColorMapping: [
    { value: 'PAVED_EXCELLENT', color: '#1b7837', label: 'Paved - Excellent' },
    { value: 'PAVED_GOOD', color: '#5aae61', label: 'Paved - Good' },
    { value: 'PAVED_INTERMEDIATE', color: '#a6dba0', label: 'Paved - Intermediate' },
    { value: 'PAVED_BAD', color: '#d9f0d3', label: 'Paved - Bad' },
    { value: 'UNPAVED_INTERMEDIATE', color: '#e7d4e8', label: 'Unpaved - Intermediate' },
    { value: 'UNPAVED_BAD', color: '#c2a5cf', label: 'Unpaved - Bad' },
    { value: 'UNPAVED_HORRIBLE', color: '#9970ab', label: 'Unpaved - Horrible' },
    { value: 'UNPAVED_IMPASSABLE', color: '#762a83', label: 'Unpaved - Impassable' },
    { value: 'UNKNOWN', color: '#6B7280', label: 'Unknown' },
  ],

  lineWidthExpression: [
    'interpolate',
    ['linear'],
    ['zoom'],
    2, 6, 
    14, 10
  ],

  outlineWidthExpression: [
    'interpolate',
    ['linear'],
    ['zoom'],
    2, 18, 
    14, 20
  ],

  surfaceColorExpression: () => {
    const caseExpression: any[] = ['case'];
    TrackStyleConfig.surfaceColorMapping.forEach(({ value, color }) => {
      caseExpression.push(['==', ['get', 'surfaceSmoothness'], value]);
      caseExpression.push(color);
    });
    caseExpression.push('#6B7280'); // Default color
    return caseExpression;
  },
};

export class RouteVisualization {
  static getSurfaceColorMapping(): ColorMapping[] {
    return TrackStyleConfig.surfaceColorMapping;
  }

  static getStyleConfig() {
    return TrackStyleConfig;
  }

  static createSegmentGeoJSON(sections: RouteSection[]): any {
    const features = sections
      .filter(section => section.coordinates && section.coordinates.length > 0)
      .map((section, index) => ({
        type: 'Feature',
        properties: {
          segmentIndex: index,
          distance: section.distance,
          infrastructure: section.infrastructure,
          stress: section.stress,
          surfaceSmoothness: section.surfaceSmoothness,
          slope: section.slope
        },
        geometry: {
          type: 'LineString',
          coordinates: section.coordinates
        }
      }))

    return {
      type: 'FeatureCollection',
      features
    }
  }

  static extractSegmentDataFromGeoJSON(routeGeoJSON: any): any {
    // The API returns GeoJSON with properties in each feature
    // We can use this directly for data-driven styling
    if (routeGeoJSON && routeGeoJSON.features) {
      return routeGeoJSON
    }
    return null
  }
}
