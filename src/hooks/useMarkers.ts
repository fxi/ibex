import { useState, useRef, useCallback } from 'react'

export interface Waypoint {
  id: number
  lng: number
  lat: number
  marker?: any
}

interface UseMarkersProps {
  onWaypointsChange?: (waypoints: Waypoint[]) => void
}

export const useMarkers = ({ onWaypointsChange }: UseMarkersProps = {}) => {
  const [waypoints, setWaypoints] = useState<Waypoint[]>([])
  const markersRef = useRef<any[]>([])

  const updateWaypoints = useCallback((newWaypoints: Waypoint[]) => {
    setWaypoints(newWaypoints)
    onWaypointsChange?.(newWaypoints)
  }, [onWaypointsChange])

  const removeWaypoint = useCallback((waypointId: number) => {
    setWaypoints(current => {
      const waypointToRemove = current.find(wp => wp.id === waypointId)
      if (waypointToRemove?.marker) {
        waypointToRemove.marker.remove()
        markersRef.current = markersRef.current.filter(m => m !== waypointToRemove.marker)
      }
      
      const filtered = current.filter(wp => wp.id !== waypointId)
      
      // Renumber all remaining markers immediately
      filtered.forEach((wp, index) => {
        if (wp.marker) {
          const markerElement = wp.marker.getElement()
          if (markerElement) {
            markerElement.textContent = (index + 1).toString()
          }
        }
      })
      
      // Call the callback after state update
      setTimeout(() => {
        onWaypointsChange?.(filtered)
      }, 0)
      
      return filtered
    })
  }, [onWaypointsChange])

  const addWaypoint = useCallback(async (lng: number, lat: number, mapRef: any) => {
    if (!mapRef.current) return
    
    const maplibregl = await import('maplibre-gl')
    
    setWaypoints(currentWaypoints => {
      const newWaypoint: Waypoint = { 
        id: Date.now() + Math.random(), 
        lng, 
        lat 
      }
      const newWaypointNumber = currentWaypoints.length + 1

      // Create numbered marker with HTML
      const markerElement = document.createElement('div')
      markerElement.className = 'numbered-marker'
      markerElement.textContent = newWaypointNumber.toString()

      const marker = new maplibregl.Marker({
        element: markerElement,
        draggable: true
      })
      .setLngLat([lng, lat])
      .addTo(mapRef.current)

      // Handle drag behavior
      let draggedRecently = false
      
      marker.on('dragstart', () => {
        draggedRecently = true
      })
      
      marker.on('dragend', () => {
        const lngLat = marker.getLngLat()
        setWaypoints(current => 
          current.map(wp => 
            wp.id === newWaypoint.id 
              ? { ...wp, lng: lngLat.lng, lat: lngLat.lat }
              : wp
          )
        )
        // Reset drag flag after a short delay
        setTimeout(() => {
          draggedRecently = false
        }, 100)
      })
      
      // Click to remove handler
      markerElement.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        
        if (!draggedRecently) {
          removeWaypoint(newWaypoint.id)
        }
      })

      newWaypoint.marker = marker
      markersRef.current.push(marker)
      
      const updatedWaypoints = [...currentWaypoints, newWaypoint]
      onWaypointsChange?.(updatedWaypoints)
      return updatedWaypoints
    })
  }, [onWaypointsChange, removeWaypoint])

  const clearWaypoints = useCallback(() => {
    // Remove all markers
    markersRef.current.forEach(marker => marker.remove())
    markersRef.current = []
    const emptyWaypoints: Waypoint[] = []
    setWaypoints(emptyWaypoints)
    onWaypointsChange?.(emptyWaypoints)
  }, [onWaypointsChange])

  return {
    waypoints,
    addWaypoint,
    removeWaypoint,
    clearWaypoints,
    updateWaypoints
  }
}