import { useState, useRef, useCallback } from 'react'
import { RoutingApiService } from '@/services/routing'
import { Point, RouteSection } from '@/types/routing'
import { WaypointData } from '@/services/MarkerManager'

export interface Route {
  id: string
  geojson: any
  sections?: RouteSection[]
  stats?: {
    distanceMeters: number
    durationSeconds: number
    elevationGainMeters: number
    elevationDropMeters: number
    bikeConvenience?: number
    safetyScore?: number
  }
  labels?: string[]
  routeIndex: number
  name: string
  color?: string
}

interface UseRoutesProps {
  onRoutesChange?: (routes: Route[]) => void
}

export const useRoutes = ({ onRoutesChange }: UseRoutesProps = {}) => {
  const [currentRoutes, setCurrentRoutes] = useState<Route[]>([])
  const [allRouteAlternatives, setAllRouteAlternatives] = useState<Route[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const routeLayersRef = useRef<string[]>([])

  const generateRouteColor = useCallback((routeIndex: number): string => {
    const colors = [
      '#3B82F6', // blue
      '#EF4444', // red  
      '#10B981', // green
      '#F59E0B', // amber
      '#8B5CF6', // violet
      '#EC4899', // pink
      '#14B8A6', // teal
      '#F97316'  // orange
    ]
    return colors[routeIndex % colors.length]
  }, [])

  const clearRoutes = useCallback((mapRef: any) => {
    if (!mapRef.current) return

    // Remove route layers
    routeLayersRef.current.forEach(layerId => {
      if (mapRef.current.getLayer(layerId)) {
        mapRef.current.removeLayer(layerId)
      }
      if (mapRef.current.getLayer(`${layerId}-outline`)) {
        mapRef.current.removeLayer(`${layerId}-outline`)
      }
      if (mapRef.current.getSource(layerId)) {
        mapRef.current.removeSource(layerId)
      }
    })
    routeLayersRef.current = []
    setCurrentRoutes([])
    onRoutesChange?.([])
  }, [onRoutesChange])

  const addRouteToMap = useCallback((route: Route, mapRef: any) => {
    if (!mapRef.current || !route.geojson) return

    const routeId = route.id
    
    // Add route to map
    mapRef.current.addSource(routeId, {
      type: 'geojson',
      data: route.geojson
    })

    // Add white outline layer first
    mapRef.current.addLayer({
      id: `${routeId}-outline`,
      type: 'line',
      source: routeId,
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': 'white',
        'line-width': 8,
        'line-opacity': 0.8
      }
    })
    
    // Add main route line with preserved color
    mapRef.current.addLayer({
      id: routeId,
      type: 'line',
      source: routeId,
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': route.color || generateRouteColor(route.routeIndex),
        'line-width': 6,
        'line-opacity': 0.8
      }
    })

    routeLayersRef.current.push(routeId)
  }, [generateRouteColor])

  const processRoute = useCallback(async (waypoints: WaypointData[], mapRef: any, settings?: any) => {
    if (waypoints.length < 2) {
      alert('Please add at least 2 waypoints to create a route')
      return []
    }

    setIsProcessing(true)
    clearRoutes(mapRef)

    try {
      const origin: Point = { 
        lat: waypoints[0].lat, 
        lon: waypoints[0].lng 
      }
      const destination: Point = { 
        lat: waypoints[waypoints.length - 1].lat, 
        lon: waypoints[waypoints.length - 1].lng 
      }
      const waypointPoints: Point[] = waypoints.slice(1, -1).map(wp => ({
        lat: wp.lat,
        lon: wp.lng
      }))

      const data = await RoutingApiService.getRoutes(origin, destination, waypointPoints, settings)
      console.log('API Response:', data)

      if (data.routes && data.routes.length > 0) {
        const routes: Route[] = []
        
        data.routes.forEach((route: any, routeIndex: number) => {
          if (route.geoJson) {
            const routeId = `route-${Date.now()}-${routeIndex}`
            const routeName = (route.labels && route.labels.length > 0) 
              ? route.labels.join(', ') 
              : `Route ${routeIndex + 1}`
            
            const routeObj: Route = {
              id: routeId,
              geojson: route.geoJson,
              sections: route.sections,
              stats: route.stats,
              labels: route.labels,
              routeIndex,
              name: routeName,
              color: generateRouteColor(routeIndex)
            }
            
            routes.push(routeObj)
            addRouteToMap(routeObj, mapRef)
          }
        })

        setCurrentRoutes(routes)
        setAllRouteAlternatives(routes)
        onRoutesChange?.(routes)
        return routes
      }
      return []
    } catch (error) {
      console.error('Routing error:', error)
      alert('Failed to process route. Please try again.')
      return []
    } finally {
      setIsProcessing(false)
    }
  }, [clearRoutes, addRouteToMap, generateRouteColor, onRoutesChange])

  return {
    currentRoutes,
    allRouteAlternatives,
    isProcessing,
    processRoute,
    clearRoutes,
    addRouteToMap
  }
}