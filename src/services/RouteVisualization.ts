import { RouteSection } from '@/types/routing'

export type VisualizationMode = 'default' | 'info'

export interface ColorMapping {
  value: string | number
  color: string
  label: string
  lineStyle?: 'solid' | 'dashed' | 'dotted'
}

export class RouteVisualization {
  
  static getSurfaceColorMapping(): ColorMapping[] {
    return [
      { value: 'PAVED_EXCELLENT', color: '#1b7837', label: 'Paved - Excellent', lineStyle: 'solid' },
      { value: 'PAVED_GOOD', color: '#5aae61', label: 'Paved - Good', lineStyle: 'solid' },
      { value: 'PAVED_INTERMEDIATE', color: '#a6dba0', label: 'Paved - Intermediate', lineStyle: 'solid' },
      { value: 'PAVED_BAD', color: '#d9f0d3', label: 'Paved - Bad', lineStyle: 'solid' },
      { value: 'UNPAVED_INTERMEDIATE', color: '#e7d4e8', label: 'Unpaved - Intermediate', lineStyle: 'dashed' },
      { value: 'UNPAVED_BAD', color: '#c2a5cf', label: 'Unpaved - Bad', lineStyle: 'dashed' },
      { value: 'UNPAVED_HORRIBLE', color: '#9970ab', label: 'Unpaved - Horrible', lineStyle: 'dotted' },
      { value: 'UNPAVED_IMPASSABLE', color: '#762a83', label: 'Unpaved - Impassable', lineStyle: 'dotted' },
      { value: 'UNKNOWN', color: '#6B7280', label: 'Unknown', lineStyle: 'solid' }
    ]
  }

  static getSegmentColor(section: RouteSection, mode: VisualizationMode): string {
    switch (mode) {
      case 'info':
        const surfaceMapping = this.getSurfaceColorMapping()
        return surfaceMapping.find(m => m.value === section.surfaceSmoothness)?.color || '#6B7280'
      
      default:
        return '#3B82F6' // Default blue
    }
  }

  static getColorMapping(mode: VisualizationMode): ColorMapping[] {
    switch (mode) {
      case 'info':
        return this.getSurfaceColorMapping()
      default:
        return []
    }
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
