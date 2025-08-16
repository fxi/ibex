import { useState, useRef, useCallback, useEffect } from 'react'
import { TrackManager, Track, TrackData } from '@/services/TrackManager'
import { Route } from '@/hooks/useRoutes'
import { WaypointData } from '@/services/MarkerManager'

export const useTrackManager = () => {
  const [tracks, setTracks] = useState<Track[]>([])
  const trackManagerRef = useRef<TrackManager | null>(null)

  const initializeManager = useCallback((mapRef: any, maplibregl: any) => {
    if (!mapRef.current || trackManagerRef.current) return

    trackManagerRef.current = new TrackManager(
      mapRef.current,
      maplibregl,
      (updatedTracks: Track[]) => setTracks([...updatedTracks])
    )

    // Load saved tracks from localStorage
    trackManagerRef.current.loadFromLocalStorage('ibex-permanent-tracks')
    
    return trackManagerRef.current
  }, [])

  const addTemporaryTracks = useCallback(
    (
      routes: Route[],
      waypoints: WaypointData[],
      useSurfaceQuality: boolean
    ) => {
      if (!trackManagerRef.current) return [];

      const map = trackManagerRef.current.getMap();
      if (!map) return [];

      const tempTracks: Track[] = [];
      routes.forEach((route, index) => {
        const routeId = route.id;

        if (map.getLayer(routeId)) map.removeLayer(routeId);
        if (map.getLayer(`${routeId}-outline`))
          map.removeLayer(`${routeId}-outline`);
        if (map.getSource(routeId)) map.removeSource(routeId);

        const trackData: TrackData = {
          id: `temp-${Date.now()}-${index}`,
          name: route.name || `Route ${index + 1}`,
          waypoints: waypoints.map((wp) => ({ ...wp })),
          route: { ...route },
          createdAt: new Date().toISOString(),
          isPermanent: false,
          color: route.color,
        };

        const track = trackManagerRef.current!.addTrack(trackData);
        track.addToMap(trackManagerRef.current!.getMap(), useSurfaceQuality);
        tempTracks.push(track);
      });

      return tempTracks;
    },
    []
  );

  const saveTrackAsPermanent = useCallback(
    (trackId: string, trackName: string, useSurfaceQuality: boolean) => {
      if (!trackManagerRef.current) return;

      const track = trackManagerRef.current.getTrack(trackId);
      if (!track) return;

      const trackData: TrackData = {
        ...track.getData(),
        id: `perm-${Date.now()}`,
        name: trackName,
        isPermanent: true,
        isVisible: true,
      };

      const permanentTrack = trackManagerRef.current.addTrack(trackData);
      permanentTrack.addToMap(
        trackManagerRef.current.getMap(),
        useSurfaceQuality
      );

      if (!track.isPermanentTrack()) {
        trackManagerRef.current.deleteTrack(trackId);
      }

    // Save permanent tracks to localStorage
    const permanentTracks = trackManagerRef.current.getPermanentTracks()
    const permanentData = permanentTracks.map(t => t.getData())
    localStorage.setItem('ibex-permanent-tracks', JSON.stringify(permanentData))

    return permanentTrack;
    },
    []
  );

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

  const toggleTrackVisibility = useCallback(
    (trackId: string, useSurfaceQuality: boolean) => {
      if (!trackManagerRef.current) return false;
      return trackManagerRef.current.toggleTrackVisibility(
        trackId,
        useSurfaceQuality
      );
    },
    []
  );

  const updateTrackColor = useCallback(
    (trackId: string, color: string, useSurfaceQuality: boolean) => {
      if (!trackManagerRef.current) return;

      trackManagerRef.current.updateTrackColor(
        trackId,
        color,
        useSurfaceQuality
      );

      // Update localStorage if it's a permanent track
    const track = trackManagerRef.current.getTrack(trackId);
      if (track && track.isPermanentTrack()) {
        const permanentTracks = trackManagerRef.current.getPermanentTracks();
        const permanentData = permanentTracks.map((t) => t.getData());
        localStorage.setItem(
          "ibex-permanent-tracks",
          JSON.stringify(permanentData)
        );
      }
    },
    []
  );

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

  const zoomToTrack = useCallback((trackId: string) => {
    if (!trackManagerRef.current) return
    trackManagerRef.current.zoomToTrack(trackId)
  }, [])

  const getLastHoveredFeature = useCallback(() => {
    if (!trackManagerRef.current) return undefined;
    return trackManagerRef.current.getLastHoveredFeature();
  }, []);

  const updateAllTracksVisibility = useCallback(
    (useSurfaceQuality: boolean) => {
      if (!trackManagerRef.current) return;
      const visibleTracks = trackManagerRef.current.getVisibleTracks();
      visibleTracks.forEach((track) => {
        track.removeFromMap(trackManagerRef.current!.getMap());
        track.addToMap(trackManagerRef.current!.getMap(), useSurfaceQuality);
      });
    },
    []
  );

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
    zoomToTrack,
    getLastHoveredFeature,
    updateAllTracksVisibility,

    // Manager instance
    trackManager: trackManagerRef.current
  }
}
