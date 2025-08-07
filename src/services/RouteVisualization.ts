import { RouteSection } from '@/types/routing'

export type VisualizationMode = 'default' | 'info'

export interface ColorMapping {
  value: string | number
  color: string
  label: string
  lineStyle?: 'solid' | 'dashed' | 'dotted'
}

export class RouteVisualization {
  
  static getStressColorMapping(): ColorMapping[] {
    return [
      { value: 1, color: '#10B981', label: 'Level 1 (No traffic)' },
      { value: 2, color: '#84CC16', label: 'Level 2 (Low traffic)' },
      { value: 3, color: '#F59E0B', label: 'Level 3 (Medium traffic)' },
      { value: 4, color: '#F97316', label: 'Level 4 (High traffic)' },
      { value: 5, color: '#EF4444', label: 'Level 5 (Very high traffic)' }
    ]
  }

  static getSegmentColor(section: RouteSection, mode: VisualizationMode): string {
    switch (mode) {
      case 'info':
        const stressMapping = this.getStressColorMapping()
        return stressMapping.find(m => m.value === section.stress)?.color || '#6B7280'
      
      default:
        return '#3B82F6' // Default blue
    }
  }

  static getColorMapping(mode: VisualizationMode): ColorMapping[] {
    switch (mode) {
      case 'info':
        return this.getStressColorMapping()
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
