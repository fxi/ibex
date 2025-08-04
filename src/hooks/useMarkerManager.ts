import { useState, useRef, useCallback, useEffect } from 'react'
import { MarkerManager, WaypointData } from '@/services/MarkerManager'

export const useMarkerManager = () => {
  const [waypoints, setWaypoints] = useState<WaypointData[]>([])
  const markerManagerRef = useRef<MarkerManager | null>(null)

  const initializeManager = useCallback(async (mapRef: any) => {
    if (!mapRef.current || markerManagerRef.current) return

    const maplibregl = await import('maplibre-gl')
    markerManagerRef.current = new MarkerManager(
      mapRef.current,
      maplibregl,
      (newWaypoints) => setWaypoints(newWaypoints)
    )
    
    return markerManagerRef.current
  }, [])

  const addWaypoint = useCallback((lng: number, lat: number) => {
    if (markerManagerRef.current) {
      markerManagerRef.current.addMarker(lng, lat)
    }
  }, [])

  const clearWaypoints = useCallback(() => {
    if (markerManagerRef.current) {
      markerManagerRef.current.clearAllMarkers()
    }
  }, [])

  return {
    waypoints,
    addWaypoint,
    clearWaypoints,
    initializeManager,
    markerManager: markerManagerRef.current
  }
}