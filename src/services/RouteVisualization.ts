import { RouteSection } from '@/types/routing'

export type VisualizationMode = 'default' | 'infrastructure' | 'stress' | 'surface' | 'slope' | 'distance'

export interface ColorMapping {
  value: string | number
  color: string
  label: string
}

export class RouteVisualization {
  
  static getInfrastructureColorMapping(): ColorMapping[] {
    return [
      { value: 'CYCLEWAY', color: '#10B981', label: 'Cycleway' },
      { value: 'BIKE_LANE', color: '#3B82F6', label: 'Bike Lane' },
      { value: 'FOOTWAY', color: '#8B5CF6', label: 'Footway' },
      { value: 'OFFROAD', color: '#F59E0B', label: 'Off-road' },
      { value: 'ROAD', color: '#EF4444', label: 'Road' }
    ]
  }

  static getStressColorMapping(): ColorMapping[] {
    return [
      { value: 1, color: '#10B981', label: 'Level 1 (No traffic)' },
      { value: 2, color: '#84CC16', label: 'Level 2 (Low traffic)' },
      { value: 3, color: '#F59E0B', label: 'Level 3 (Medium traffic)' },
      { value: 4, color: '#F97316', label: 'Level 4 (High traffic)' },
      { value: 5, color: '#EF4444', label: 'Level 5 (Very high traffic)' }
    ]
  }

  static getSurfaceColorMapping(): ColorMapping[] {
    return [
      { value: 'PAVED_EXCELLENT', color: '#10B981', label: 'Paved - Excellent' },
      { value: 'PAVED_GOOD', color: '#22C55E', label: 'Paved - Good' },
      { value: 'PAVED_INTERMEDIATE', color: '#84CC16', label: 'Paved - Intermediate' },
      { value: 'PAVED_BAD', color: '#F59E0B', label: 'Paved - Bad' },
      { value: 'UNPAVED_INTERMEDIATE', color: '#F97316', label: 'Unpaved - Intermediate' },
      { value: 'UNPAVED_BAD', color: '#EF4444', label: 'Unpaved - Bad' },
      { value: 'UNPAVED_HORRIBLE', color: '#DC2626', label: 'Unpaved - Horrible' },
      { value: 'UNPAVED_IMPASSABLE', color: '#7F1D1D', label: 'Unpaved - Impassable' },
      { value: 'UNKNOWN', color: '#6B7280', label: 'Unknown' }
    ]
  }

  static getSlopeColor(slope: number): string {
    // Color gradient based on slope percentage
    if (slope < -8) return '#1E40AF' // Steep downhill - dark blue
    if (slope < -4) return '#3B82F6' // Moderate downhill - blue
    if (slope < -1) return '#60A5FA' // Light downhill - light blue
    if (slope < 1) return '#10B981'  // Flat - green
    if (slope < 4) return '#F59E0B'  // Light uphill - amber
    if (slope < 8) return '#F97316'  // Moderate uphill - orange
    if (slope < 12) return '#EF4444' // Steep uphill - red
    return '#DC2626' // Very steep uphill - dark red
  }

  static getSlopeColorMapping(): ColorMapping[] {
    return [
      { value: '< -8%', color: '#1E40AF', label: 'Steep downhill (< -8%)' },
      { value: '-8% to -4%', color: '#3B82F6', label: 'Moderate downhill (-8% to -4%)' },
      { value: '-4% to -1%', color: '#60A5FA', label: 'Light downhill (-4% to -1%)' },
      { value: '-1% to 1%', color: '#10B981', label: 'Flat (-1% to 1%)' },
      { value: '1% to 4%', color: '#F59E0B', label: 'Light uphill (1% to 4%)' },
      { value: '4% to 8%', color: '#F97316', label: 'Moderate uphill (4% to 8%)' },
      { value: '8% to 12%', color: '#EF4444', label: 'Steep uphill (8% to 12%)' },
      { value: '> 12%', color: '#DC2626', label: 'Very steep uphill (> 12%)' }
    ]
  }

  static getDistanceColor(distance: number, maxDistance: number): string {
    // Color gradient based on segment distance relative to max
    const ratio = distance / maxDistance
    if (ratio < 0.2) return '#10B981' // Short segments - green
    if (ratio < 0.4) return '#84CC16' // Medium-short - lime
    if (ratio < 0.6) return '#F59E0B' // Medium - amber
    if (ratio < 0.8) return '#F97316' // Medium-long - orange
    return '#EF4444' // Long segments - red
  }

  static getDistanceColorMapping(maxDistance: number): ColorMapping[] {
    return [
      { value: `< ${Math.round(maxDistance * 0.2)}m`, color: '#10B981', label: 'Short segments' },
      { value: `${Math.round(maxDistance * 0.2)}-${Math.round(maxDistance * 0.4)}m`, color: '#84CC16', label: 'Medium-short' },
      { value: `${Math.round(maxDistance * 0.4)}-${Math.round(maxDistance * 0.6)}m`, color: '#F59E0B', label: 'Medium' },
      { value: `${Math.round(maxDistance * 0.6)}-${Math.round(maxDistance * 0.8)}m`, color: '#F97316', label: 'Medium-long' },
      { value: `> ${Math.round(maxDistance * 0.8)}m`, color: '#EF4444', label: 'Long segments' }
    ]
  }

  static getSegmentColor(section: RouteSection, mode: VisualizationMode, maxDistance?: number): string {
    switch (mode) {
      case 'infrastructure':
        const infraMapping = this.getInfrastructureColorMapping()
        return infraMapping.find(m => m.value === section.infrastructure)?.color || '#6B7280'
      
      case 'stress':
        const stressMapping = this.getStressColorMapping()
        return stressMapping.find(m => m.value === section.stress)?.color || '#6B7280'
      
      case 'surface':
        const surfaceMapping = this.getSurfaceColorMapping()
        return surfaceMapping.find(m => m.value === section.surfaceSmoothness)?.color || '#6B7280'
      
      case 'slope':
        return this.getSlopeColor(section.slope)
      
      case 'distance':
        if (!maxDistance) return '#6B7280'
        return this.getDistanceColor(section.distance, maxDistance)
      
      default:
        return '#3B82F6' // Default blue
    }
  }

  static getColorMapping(mode: VisualizationMode, maxDistance?: number): ColorMapping[] {
    switch (mode) {
      case 'infrastructure':
        return this.getInfrastructureColorMapping()
      case 'stress':
        return this.getStressColorMapping()
      case 'surface':
        return this.getSurfaceColorMapping()
      case 'slope':
        return this.getSlopeColorMapping()
      case 'distance':
        return maxDistance ? this.getDistanceColorMapping(maxDistance) : []
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