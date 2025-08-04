import { useState, useRef, useCallback, useEffect } from 'react'
import { TrackManager, Track, TrackData } from '@/services/TrackManager'
import { Route } from '@/hooks/useRoutes'
import { WaypointData } from '@/services/MarkerManager'
import { VisualizationMode } from '@/services/RouteVisualization'

export const useTrackManager = () => {
  const [tracks, setTracks] = useState<Track[]>([])
  const trackManagerRef = useRef<TrackManager | null>(null)

  const initializeManager = useCallback((mapRef: any) => {
    if (!mapRef.current || trackManagerRef.current) return

    trackManagerRef.current = new TrackManager(
      mapRef.current,
      (updatedTracks) => setTracks([...updatedTracks])
    )

    // Load saved tracks from localStorage
    trackManagerRef.current.loadFromLocalStorage('ibex-permanent-tracks')
    
    return trackManagerRef.current
  }, [])

  const addTemporaryTracks = useCallback((routes: Route[], waypoints: WaypointData[]) => {
    if (!trackManagerRef.current) return []
    
    const map = trackManagerRef.current.getMap()
    if (!map) return []

    const tempTracks: Track[] = []
    routes.forEach((route, index) => {
      // IMPORTANT: Remove the original route layers from the map before creating tracks
      // Routes are created by useRoutes with route-* IDs, but tracks use track-* IDs
      const routeId = route.id
      
      // Remove original route layers if they exist
      if (map.getLayer(routeId)) {
        console.log(`Removing original route layer: ${routeId}`)
        map.removeLayer(routeId)
      }
      if (map.getLayer(`${routeId}-outline`)) {
        console.log(`Removing original route outline layer: ${routeId}-outline`)
        map.removeLayer(`${routeId}-outline`)
      }
      if (map.getSource(routeId)) {
        console.log(`Removing original route source: ${routeId}`)
        map.removeSource(routeId)
      }
      
      const trackData: TrackData = {
        id: `temp-${Date.now()}-${index}`,
        name: route.name || `Route ${index + 1}`,
        waypoints: waypoints.map(wp => ({ ...wp })),
        route: { ...route },
        createdAt: new Date().toISOString(),
        isPermanent: false,
        color: route.color
      }
      
      const track = trackManagerRef.current!.addTrack(trackData)
      track.addToMap(trackManagerRef.current!.getMap()) // Show temporary tracks by default
      tempTracks.push(track)
    })

    return tempTracks
  }, [])

  const saveTrackAsPermanent = useCallback((trackId: string, trackName: string) => {
    if (!trackManagerRef.current) return

    const track = trackManagerRef.current.getTrack(trackId)
    if (!track) return

    // Create new permanent track with visibility set to true
    const trackData: TrackData = {
      ...track.getData(),
      id: `perm-${Date.now()}`,
      name: trackName,
      isPermanent: true,
      isVisible: true  // Set visibility to true for saved tracks
    }

    const permanentTrack = trackManagerRef.current.addTrack(trackData)

    // Add the permanent track to the map with visibility true
    permanentTrack.addToMap(trackManagerRef.current.getMap())
    
    // Remove the temporary track (this will remove it from map)
    if (!track.isPermanentTrack()) {
      trackManagerRef.current.deleteTrack(trackId)
    }

    // Save permanent tracks to localStorage
    const permanentTracks = trackManagerRef.current.getPermanentTracks()
    const permanentData = permanentTracks.map(t => t.getData())
    localStorage.setItem('ibex-permanent-tracks', JSON.stringify(permanentData))

    return permanentTrack
  }, [])

  const deleteTrack = useCallback((trackId: string) => {
    if (!trackManagerRef.current) return

    const track = trackManagerRef.current.getTrack(trackId)
    if (track && track.isPermanentTrack()) {
      // Update localStorage for permanent tracks
      trackManagerRef.current.deleteTrack(trackId)
      const permanentTracks = trackManagerRef.current.getPermanentTracks()
      const permanentData = permanentTracks.map(t => t.getData())
      localStorage.setItem('ibex-permanent-tracks', JSON.stringify(permanentData))
    } else {
      trackManagerRef.current.deleteTrack(trackId)
    }
  }, [])

  const toggleTrackVisibility = useCallback((trackId: string) => {
    if (!trackManagerRef.current) return false
    return trackManagerRef.current.toggleTrackVisibility(trackId)
  }, [])

  const updateTrackColor = useCallback((trackId: string, color: string) => {
    if (!trackManagerRef.current) return
    
    trackManagerRef.current.updateTrackColor(trackId, color)
    
    // Update localStorage if it's a permanent track
    const track = trackManagerRef.current.getTrack(trackId)
    if (track && track.isPermanentTrack()) {
      const permanentTracks = trackManagerRef.current.getPermanentTracks()
      const permanentData = permanentTracks.map(t => t.getData())
      localStorage.setItem('ibex-permanent-tracks', JSON.stringify(permanentData))
    }
  }, [])

  const renameTrack = useCallback((trackId: string, newName: string) => {
    if (!trackManagerRef.current) return
    
    trackManagerRef.current.renameTrack(trackId, newName)
    
    // Update localStorage if it's a permanent track
    const track = trackManagerRef.current.getTrack(trackId)
    if (track && track.isPermanentTrack()) {
      const permanentTracks = trackManagerRef.current.getPermanentTracks()
      const permanentData = permanentTracks.map(t => t.getData())
      localStorage.setItem('ibex-permanent-tracks', JSON.stringify(permanentData))
    }
  }, [])

  const exportTrack = useCallback((trackId: string) => {
    if (!trackManagerRef.current) return
    
    const track = trackManagerRef.current.getTrack(trackId)
    if (track) {
      track.exportAsGPX()
    }
  }, [])

  const clearTemporaryTracks = useCallback(() => {
    if (!trackManagerRef.current) return
    trackManagerRef.current.clearTemporaryTracks()
  }, [])

  const clearAllTracks = useCallback(() => {
    if (!trackManagerRef.current) return
    trackManagerRef.current.clearAllTracks()
    localStorage.removeItem('ibex-permanent-tracks')
  }, [])

  const setTrackVisualizationMode = useCallback((trackId: string, mode: VisualizationMode) => {
    if (!trackManagerRef.current) return
    trackManagerRef.current.setTrackVisualizationMode(trackId, mode)
  }, [])

  const setAllTracksVisualizationMode = useCallback((mode: VisualizationMode) => {
    if (!trackManagerRef.current) return
    trackManagerRef.current.setAllTracksVisualizationMode(mode)
  }, [])

  const getLastHoveredFeature = useCallback(() => {
    if (!trackManagerRef.current) return undefined
    return trackManagerRef.current.getLastHoveredFeature()
  }, [])

  // Computed values
  const permanentTracks = tracks.filter(track => track.isPermanentTrack())
  const temporaryTracks = tracks.filter(track => !track.isPermanentTrack())
  const visibleTracks = tracks.filter(track => track.isVisible())

  return {
    // State
    tracks,
    permanentTracks,
    temporaryTracks,
    visibleTracks,
    
    // Actions
    initializeManager,
    addTemporaryTracks,
    saveTrackAsPermanent,
    deleteTrack,
    toggleTrackVisibility,
    updateTrackColor,
    renameTrack,
    exportTrack,
    clearTemporaryTracks,
    clearAllTracks,
    setTrackVisualizationMode,
    setAllTracksVisualizationMode,
    getLastHoveredFeature,
    
    // Manager instance
    trackManager: trackManagerRef.current
  }
}
