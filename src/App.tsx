import { useEffect, useRef, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Settings, RotateCcw, Save, Download, Eye, EyeOff, Trash2, PanelLeftOpen, PanelLeftClose, Info, Gauge, ChevronUp, ChevronDown, CloudCog, Pencil, Expand, LocateFixed, Search } from 'lucide-react'
import { useMarkerManager } from '@/hooks/useMarkerManager'
import { useRoutes, Route } from '@/hooks/useRoutes'
import { useTrackManager } from '@/hooks/useTrackManager'
import { WaypointData } from '@/services/MarkerManager'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { MultiActionConfirmDialog } from '@/components/ui/multi-action-confirm-dialog'
import { InputDialog } from '@/components/ui/input-dialog'
import { VisualizationSelector } from '@/components/ui/visualization-selector'
import { RouteLegend } from '@/components/ui/route-legend'
import { LocationButton } from '@/components/ui/location-button'
import { GeocodingSearch } from '@/components/ui/geocoding-search'
import { RouteVisualization, VisualizationMode } from '@/services/RouteVisualization'
import { toast } from 'sonner'



function App() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const maplibreglRef = useRef<any>(null)
  const [trackManagerOpen, setTrackManagerOpen] = useState(true)
  const [currentVisualizationMode, setCurrentVisualizationMode] = useState<VisualizationMode>('default')
  
  // Table sorting state
  type SortColumn = 'name' | 'pts' | 'date' | 'distance' | 'time' | 'elevation' | 'saved'
  type SortDirection = 'asc' | 'desc' | 'none'
  const [sortConfig, setSortConfig] = useState<{ column: SortColumn | null; direction: SortDirection }>({
    column: 'date',
    direction: 'desc' // Default: most recent first
  })
  
  // API Routing Settings
  const [routingSettings, setRoutingSettings] = useState({
    bikeType: 'GRAVEL_BIKE',
    traffic: 'AVOID_IF_REASONABLE',
    climbs: 'IGNORE',
    stairs: 'AVOID_IF_POSSIBLE',
    pavements: 'AVOID_IF_POSSIBLE',
    oneways: 'AVOID_IF_POSSIBLE',
    surface: 'PREFER_NON_PAVED'
  })
  
  // Dialog states
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean
    title: string
    description: string
    onConfirm: () => void
    variant?: "default" | "destructive"
  }>({
    open: false,
    title: "",
    description: "",
    onConfirm: () => {},
    variant: "default"
  })

  const [multiActionDialog, setMultiActionDialog] = useState<{
    open: boolean
    title: string
    description: string
    actions: { label: string; onClick: () => void; variant?: "default" | "destructive" }[]
  }>({
    open: false,
    title: "",
    description: "",
    actions: [],
  })
  
  const [inputDialog, setInputDialog] = useState<{
    open: boolean
    title: string
    description?: string
    label: string
    placeholder?: string
    defaultValue?: string
    onConfirm: (value: string) => void
    validation?: (value: string) => boolean | string
  }>({
    open: false,
    title: "",
    label: "",
    onConfirm: () => {}
  })
  
  // Use marker manager for clean marker handling
  const {
    waypoints,
    addWaypoint,
    clearWaypoints,
    setAllWaypoints,
    initializeManager: initializeMarkerManager
  } = useMarkerManager()
  
  // Use track manager for track management
  const {
    tracks,
    permanentTracks,
    temporaryTracks,
    addTemporaryTracks,
    saveTrackAsPermanent,
    deleteTrack,
    toggleTrackVisibility,
    updateTrackColor,
    renameTrack,
    exportTrack,
    zoomToTrack,
    clearTemporaryTracks,
    clearAllTracks,
    setAllTracksVisualizationMode,
    getLastHoveredFeature,
    initializeManager: initializeTrackManager
  } = useTrackManager()
  
  const {
    currentRoutes,
    allRouteAlternatives,
    isProcessing,
    processRoute,
    clearRoutes
  } = useRoutes()

  // Dialog helper functions
  const showConfirmDialog = (title: string, description: string, onConfirm: () => void, variant: "default" | "destructive" = "default") => {
    setConfirmDialog({
      open: true,
      title,
      description,
      onConfirm,
      variant
    })
  }

  const showMultiActionConfirmDialog = (title: string, description: string, actions: { label: string; onClick: () => void; variant?: "default" | "destructive" }[]) => {
    setMultiActionDialog({
      open: true,
      title,
      description,
      actions,
    })
  }

  const showInputDialog = (
    title: string, 
    label: string, 
    onConfirm: (value: string) => void,
    options: {
      description?: string
      placeholder?: string
      defaultValue?: string
      validation?: (value: string) => boolean | string
    } = {}
  ) => {
    setInputDialog({
      open: true,
      title,
      label,
      onConfirm,
      ...options
    })
  }

  // Clear routes when waypoints change to less than 2
  useEffect(() => {
    if (waypoints.length < 2 && currentRoutes.length > 0) {
      clearRoutes(mapRef)
    }
  }, [waypoints.length, currentRoutes.length, clearRoutes])


  // Initialize map
  useEffect(() => {
    const loadMap = async () => {
      try {
        const maplibregl = await import('maplibre-gl')
        maplibreglRef.current = maplibregl
        // Import CSS separately via index.css or global.css
        
        if (mapContainer.current && !mapRef.current) {
          const map = new maplibregl.Map({
            container: mapContainer.current,
            style: 'https://api.maptiler.com/maps/01984598-44d5-70a4-b028-6ce2d6f3027a/style.json?key=r0T8W9TTH8XCCGoLL9gE',
            center: [6.1908, 46.1943],
            zoom: 10,
            maxZoom: 18,
            minZoom: 5,
            pitch: 0,
            bearing: 0
          })

          mapRef.current = map

          map.on('load', () => {
            console.log('Map loaded successfully')
            map.addSource('terrainSource', {
              type: 'raster-dem',
              url: `https://api.maptiler.com/tiles/terrain-rgb/tiles.json?key=${'r0T8W9TTH8XCCGoLL9gE'}`,
              tileSize: 256
            })
          })

          map.on('pitch', () => {
            if (map.getPitch() > 0) {
              map.setTerrain({ source: 'terrainSource', exaggeration: 1.5 })
            } else {
              map.setTerrain(null)
            }
          })

          // Initialize managers and add click handler
          Promise.all([
            initializeMarkerManager(mapRef),
            initializeTrackManager(mapRef, maplibreglRef.current)
          ]).then(() => {
            // Simple click handler - no debouncing needed with clean class approach
            map.on('click', (e) => {
              addWaypoint(e.lngLat.lng, e.lngLat.lat)
            })
          })

          map.on('error', (e) => {
            console.error('Map error:', e)
          })
        }
      } catch (error) {
        console.error('Failed to load MapLibre:', error)
      }
    }

    loadMap()
  }, [])



  const handleClearWaypoints = () => {
    clearWaypoints()
    clearRoutes(mapRef)
    clearTemporaryTracks()
  }


  const handleProcessRoute = async (replaceExisting: boolean = false) => {
    if (temporaryTracks.length > 0 && !replaceExisting) {
      showMultiActionConfirmDialog(
        "Existing Temporary Tracks",
        "You have existing temporary tracks. What would you like to do?",
        [
          {
            label: "Replace",
            onClick: () => {
              clearTemporaryTracks()
              processAndAddRoutes()
            },
            variant: "destructive",
          },
          {
            label: "Add",
            onClick: () => processAndAddRoutes(),
          },
        ]
      )
      return
    }

    processAndAddRoutes()
  }

  const processAndAddRoutes = async () => {
    const routes = await processRoute(waypoints, mapRef, routingSettings)
    
    if (routes.length > 0) {
      addTemporaryTracks(routes, waypoints)
    }
  }

  const handleVisualizationModeChange = (mode: VisualizationMode) => {
    setCurrentVisualizationMode(mode)
    setAllTracksVisualizationMode(mode)
  }

  const handleReloadWaypoints = useCallback((track: any) => {
    showConfirmDialog(
      "Reload Waypoints",
      "This will clear current waypoints and temporary tracks. Are you sure you want to continue?",
      () => {
        if (!track.isVisible()) {
          toggleTrackVisibility(track.getId())
        }
        clearWaypoints()
        clearTemporaryTracks()
        setAllWaypoints(track.getWaypoints().map((wp: WaypointData) => ({ lng: wp.lng, lat: wp.lat })))
        toast.success("Waypoints reloaded for editing!")
      }
    )
  }, [clearWaypoints, clearTemporaryTracks, setAllWaypoints, toggleTrackVisibility])

  // Fixed handler for save track to prevent closure issues
  const handleSaveTrack = useCallback((trackId: string, trackName: string) => {
    showInputDialog(
      "Save Track",
      "Track name",
      (newTrackName) => {
        saveTrackAsPermanent(trackId, newTrackName)
        toast.success("Track saved permanently!")
      },
      {
        placeholder: "Enter track name",
        defaultValue: trackName,
        validation: (value) => value.trim().length > 0 || "Track name is required"
      }
    )
  }, [saveTrackAsPermanent])

  // Tri-state sorting handler
  const handleSort = useCallback((column: SortColumn) => {
    setSortConfig(prevConfig => {
      if (prevConfig.column !== column) {
        return { column, direction: 'asc' }
      }
      
      switch (prevConfig.direction) {
        case 'asc':
          return { column, direction: 'desc' }
        case 'desc':
          return { column: null, direction: 'none' }
        case 'none':
        default:
          return { column, direction: 'asc' }
      }
    })
  }, [])

  // Sort tracks based on current sort configuration
  const sortedTracks = useCallback(() => {
    if (!sortConfig.column || sortConfig.direction === 'none') {
      // Default sort: most recent first
      return [...tracks].sort((a, b) => new Date(b.getCreatedAt()).getTime() - new Date(a.getCreatedAt()).getTime())
    }

    const sorted = [...tracks].sort((a, b) => {
      let aValue: any, bValue: any

      switch (sortConfig.column) {
        case 'name':
          aValue = a.getName().toLowerCase()
          bValue = b.getName().toLowerCase()
          break
        case 'pts':
          aValue = a.getWaypoints().length
          bValue = b.getWaypoints().length
          break
        case 'date':
          aValue = new Date(a.getCreatedAt()).getTime()
          bValue = new Date(b.getCreatedAt()).getTime()
          break
        case 'distance':
          aValue = a.getRoute()?.stats?.distanceMeters || 0
          bValue = b.getRoute()?.stats?.distanceMeters || 0
          break
        case 'time':
          aValue = a.getRoute()?.stats?.durationSeconds || 0
          bValue = b.getRoute()?.stats?.durationSeconds || 0
          break
        case 'elevation':
          aValue = a.getRoute()?.stats?.elevationGainMeters || 0
          bValue = b.getRoute()?.stats?.elevationGainMeters || 0
          break
        case 'saved':
          aValue = a.isPermanentTrack() ? 1 : 0
          bValue = b.isPermanentTrack() ? 1 : 0
          break
        default:
          return 0
      }

      if (sortConfig.direction === 'asc') {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0
      }
    })

    return sorted
  }, [tracks, sortConfig])

  // Calculate color mapping for legend
  const getColorMapping = () => {
    if (currentVisualizationMode === 'distance' && tracks.length > 0) {
      // Find max distance across all track sections
      const maxDistance = Math.max(
        ...tracks
          .filter(track => track.getRoute().sections && track.getRoute().sections!.length > 0)
          .flatMap(track => track.getRoute().sections!.map(s => s.distance))
      )
      return RouteVisualization.getColorMapping(currentVisualizationMode, maxDistance)
    }
    return RouteVisualization.getColorMapping(currentVisualizationMode)
  }


  return (
    <div className="h-screen w-screen bg-background text-foreground relative flex flex-col">
      {/* Main content with map */}
      <div className="flex-1 relative">
        {/* Map Controls */}
        <div className="absolute top-4 right-4 z-10 flex flex-col gap-2">
          <Button
            onClick={() => handleProcessRoute()}
            disabled={waypoints.length < 2 || isProcessing}
            size="sm"
            variant="secondary"
            className="shadow-lg"
            title="Compute Routes"
          >
            <CloudCog className="h-4 w-4" />
          </Button>
          <LocationButton mapRef={mapRef} />
          <GeocodingSearch mapRef={mapRef} addWaypoint={addWaypoint} />
        </div>

        {/* Route Legend */}
        {currentVisualizationMode !== 'default' && tracks.some(t => t.isVisible()) && (
          <div className="absolute top-4 left-4 z-10">
            <RouteLegend
              mode={currentVisualizationMode}
              colorMapping={getColorMapping()}
            />
          </div>
        )}

        {/* Map container */}
        <div 
          ref={mapContainer} 
          className="h-full w-full cursor-crosshair" 
        />

        {/* Floating Show Panel Button */}
        {!trackManagerOpen && (
          <Button
            onClick={() => setTrackManagerOpen(true)}
            variant="secondary"
            size="sm"
            className="absolute bottom-4 left-4 z-20 shadow-lg"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        )}
      </div>
      
      {/* Bottom Panel with Tabs */}
      <div className={`bg-background border-t transition-all duration-300 ease-in-out ${
        trackManagerOpen ? 'h-80' : 'h-12'
      }`}>
        {/* Panel Header */}
        <div className="flex items-center justify-between p-3 border-b">
          <Button
            onClick={() => setTrackManagerOpen(!trackManagerOpen)}
            variant="ghost"
            size="sm"
            className=""
          >
            {trackManagerOpen ? (
              <>Hide Panel <PanelLeftClose className="h-4 w-4 ml-1 rotate-90" /></>
            ) : (
              <>Show Panel <PanelLeftOpen className="h-4 w-4 ml-1 rotate-90" /></>
            )}
          </Button>
        </div>
        
        {/* Panel Content */}
        {trackManagerOpen && (
          <Tabs defaultValue="tracks" className="h-64">
            <TabsList className="w-full justify-start border-b rounded-none p-0 h-auto bg-transparent">
              <TabsTrigger value="tracks" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none bg-transparent">
                Tracks
              </TabsTrigger>
              <TabsTrigger value="tools" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none bg-transparent">
                <Settings className="h-4 w-4 mr-1" />
                Tools
              </TabsTrigger>
              <TabsTrigger value="settings" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none bg-transparent">
                Settings
              </TabsTrigger>
              <TabsTrigger value="diagnostics" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none bg-transparent hidden md:flex">
                <Gauge className="h-4 w-4 mr-1" />
                Diagnostics
              </TabsTrigger>
              <TabsTrigger value="info" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none bg-transparent hidden md:flex">
                <Info className="h-4 w-4 mr-1" />
                Info
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="tracks" className="mt-0 p-4 h-56 overflow-y-auto">
              <div className="space-y-4">
                {/* Combined Tracks Table */}
                {tracks.length === 0 ? (
                  <Card>
                    <CardContent className="p-3">
                      <p className="text-sm text-muted-foreground">No tracks available</p>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="pb-2 font-medium">
                            <button 
                              onClick={() => handleSort('name')}
                              className="flex items-center gap-1 hover:text-foreground transition-colors"
                            >
                              Track
                              {sortConfig.column === 'name' && (
                                sortConfig.direction === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                              )}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-center hidden md:table-cell">
                            <button 
                              onClick={() => handleSort('pts')}
                              className="flex items-center gap-1 hover:text-foreground transition-colors mx-auto"
                            >
                              Pts
                              {sortConfig.column === 'pts' && (
                                sortConfig.direction === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                              )}
                            </button>
                          </th>
                          <th className="pb-2 font-medium hidden md:table-cell">
                            <button 
                              onClick={() => handleSort('date')}
                              className="flex items-center gap-1 hover:text-foreground transition-colors"
                            >
                              Date
                              {sortConfig.column === 'date' && (
                                sortConfig.direction === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                              )}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-right">
                            <button 
                              onClick={() => handleSort('distance')}
                              className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                            >
                              Distance
                              {sortConfig.column === 'distance' && (
                                sortConfig.direction === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                              )}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-right hidden md:table-cell">
                            <button 
                              onClick={() => handleSort('time')}
                              className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                            >
                              Time
                              {sortConfig.column === 'time' && (
                                sortConfig.direction === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                              )}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-right">
                            <button 
                              onClick={() => handleSort('elevation')}
                              className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                            >
                              Elevation
                              {sortConfig.column === 'elevation' && (
                                sortConfig.direction === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                              )}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-center">
                            <button 
                              onClick={() => handleSort('saved')}
                              className="flex items-center gap-1 hover:text-foreground transition-colors mx-auto"
                            >
                              Saved
                              {sortConfig.column === 'saved' && (
                                sortConfig.direction === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                              )}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTracks().map(track => (
                          <tr key={track.getId()} className="border-b hover:bg-muted/50">
                            <td className="py-2">
                              <div className="flex items-center gap-2">
                                <span
                                  className="w-3 h-3 rounded-full cursor-pointer flex-shrink-0" 
                                  style={{ backgroundColor: track.getColor() }}
                                  onClick={() => {
                                    if (track.isPermanentTrack()) {
                                      showInputDialog(
                                        "Change Track Color",
                                        "Color (hex)",
                                        (newColor) => {
                                          updateTrackColor(track.getId(), newColor)
                                          toast.success("Track color updated!")
                                        },
                                        {
                                          placeholder: "#FF0000",
                                          defaultValue: track.getColor(),
                                          validation: (value) => /^#[0-9A-F]{6}$/i.test(value) || "Please enter a valid hex color (e.g., #FF0000)"
                                        }
                                      )
                                    }
                                  }}
                                  title={track.isPermanentTrack() ? "Click to change color" : "Color"}
                                ></span>
                                <span
                                  className={`${track.isPermanentTrack() ? "cursor-pointer hover:underline" : ""} truncate max-w-28 md:max-w-xs`}
                                  onClick={() => {
                                    if (track.isPermanentTrack()) {
                                      showInputDialog(
                                        "Rename Track",
                                        "Track name",
                                        (newName) => {
                                          renameTrack(track.getId(), newName.trim())
                                          toast.success("Track renamed!")
                                        },
                                        {
                                          defaultValue: track.getName(),
                                          validation: (value) => value.trim().length > 0 || "Track name is required"
                                        }
                                      )
                                    }
                                  }}
                                  title={track.isPermanentTrack() ? "Click to rename" : ""}
                                >
                                  {track.getName()}
                                </span>
                              </div>
                            </td>
                            <td className="py-2 text-center text-muted-foreground hidden md:table-cell">
                              {track.getWaypoints().length}
                            </td>
                            <td className="py-2 text-muted-foreground hidden md:table-cell">
                              {new Date(track.getCreatedAt()).toLocaleDateString(undefined, {
                                month: '2-digit',
                                day: '2-digit',
                                year: '2-digit'
                              })}
                            </td>
                            <td className="py-2 text-right">
                              {track.getRoute()?.stats?.distanceMeters 
                                ? (track.getRoute()!.stats!.distanceMeters / 1000).toFixed(1) + 'km'
                                : 'N/A'}
                            </td>
                            <td className="py-2 text-right hidden md:table-cell">
                              {track.getRoute()?.stats?.durationSeconds
                                ? Math.round(track.getRoute()!.stats!.durationSeconds / 60) + 'min'
                                : 'N/A'}
                            </td>
                            <td className="py-2 text-right">
                              {track.getRoute()?.stats?.elevationGainMeters 
                                ? '↗' + track.getRoute()!.stats!.elevationGainMeters.toFixed(0) + 'm'
                                : 'N/A'}
                            </td>
                            <td className="py-2 text-center">
                              {track.isPermanentTrack() ? (
                                <span className="text-green-600">✓</span>
                              ) : (
                                <Button
                                  onClick={() => handleSaveTrack(track.getId(), track.getName())}
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 w-6 p-0"
                                  title="Save track"
                                >
                                  <Save className="h-3 w-3" />
                                </Button>
                              )}
                            </td>
                            <td className="py-2">
                              <div className="flex gap-1 justify-center">
                                {track.isPermanentTrack() && (
                                  <Button
                                    onClick={() => handleReloadWaypoints(track)}
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 w-6 p-0"
                                    title="Edit track waypoints"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                )}
                                <Button
                                  onClick={() => exportTrack(track.getId())}
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 w-6 p-0"
                                  title="Export GPX"
                                >
                                  <Download className="h-3 w-3" />
                                </Button>
                                <Button
                                  onClick={() => zoomToTrack(track.getId())}
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 w-6 p-0"
                                  title="Zoom to track"
                                >
                                  <Expand className="h-3 w-3" />
                                </Button>
                                <Button
                                  onClick={() => toggleTrackVisibility(track.getId())}
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 w-6 p-0"
                                  title={track.isVisible() ? "Hide" : "Show"}
                                >
                                  {track.isVisible() ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                                </Button>
                                <Button
                                  onClick={() => {
                                    showConfirmDialog(
                                      track.isPermanentTrack() ? "Delete Saved Track" : "Delete Track",
                                      `Are you sure you want to delete "${track.getName()}"? This action cannot be undone.`,
                                      () => {
                                        deleteTrack(track.getId())
                                        toast.success("Track deleted!")
                                      },
                                      "destructive"
                                    )
                                  }}
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                                  title="Delete track"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </TabsContent>
            
            <TabsContent value="tools" className="mt-0 p-4 h-56 overflow-y-auto">
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Route Processing</CardTitle>
                    <CardDescription>Compute and manage routes</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Button
                      onClick={() => handleProcessRoute()}
                      disabled={waypoints.length < 2 || isProcessing}
                      className="w-full"
                    >
                      <CloudCog className="h-4 w-4 mr-2" />
                      {isProcessing ? 'Processing...' : 'Compute Routes'}
                    </Button>
                    
                    <Button
                      onClick={() => {
                        showConfirmDialog(
                          "Clear Temporary Data",
                          "This will clear waypoints and temporary tracks. Saved tracks will not be affected.",
                          handleClearWaypoints,
                          "default"
                        )
                      }}
                      variant="outline"
                      className="w-full"
                      disabled={waypoints.length === 0 && temporaryTracks.length === 0}
                    >
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Clear Temporary
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
                    <CardDescription>Permanently delete all data</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button
                      onClick={() => {
                        showConfirmDialog(
                          "Clear All Data",
                          "This will permanently delete ALL tracks, waypoints, and settings. This action cannot be undone.",
                          () => {
                            clearWaypoints()
                            clearRoutes(mapRef)
                            clearAllTracks()
                            toast.success("All data cleared")
                          },
                          "destructive"
                        )
                      }}
                      variant="destructive"
                      className="w-full"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Clear All Data
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
            
            <TabsContent value="settings" className="mt-0 p-4 h-56 overflow-y-auto">
              <div className="space-y-4">
                {/* Route Visualization Controls */}
                {(temporaryTracks.length > 0 || permanentTracks.length > 0) && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Route Visualization</CardTitle>
                      <CardDescription>Change how route segments are colored</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <VisualizationSelector
                        currentMode={currentVisualizationMode}
                        onModeChange={handleVisualizationModeChange}
                      />
                    </CardContent>
                  </Card>
                )}

                {/* Routing Settings */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Routing Preferences</CardTitle>
                    <CardDescription>Customize route calculation</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="bike-type">Bicycle Type</Label>
                        <Select value={routingSettings.bikeType} onValueChange={(value) => 
                          setRoutingSettings(prev => ({ ...prev, bikeType: value }))
                        }>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="GRAVEL_BIKE">Gravel Bike</SelectItem>
                            <SelectItem value="ROAD_BIKE">Road Bike</SelectItem>
                            <SelectItem value="MOUNTAIN_BIKE">Mountain Bike</SelectItem>
                            <SelectItem value="HYBRID_BIKE">Hybrid Bike</SelectItem>
                            <SelectItem value="ELECTRIC_BIKE">E-Bike</SelectItem>
                            <SelectItem value="CITY_BIKE">City Bike</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="traffic">Traffic Avoidance</Label>
                        <Select value={routingSettings.traffic} onValueChange={(value) => 
                          setRoutingSettings(prev => ({ ...prev, traffic: value }))
                        }>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="IGNORE">Ignore</SelectItem>
                            <SelectItem value="AVOID_IF_REASONABLE">Avoid if Reasonable</SelectItem>
                            <SelectItem value="AVOID_IF_POSSIBLE">Avoid if Possible</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="climbs">Climb Avoidance</Label>
                        <Select value={routingSettings.climbs} onValueChange={(value) => 
                          setRoutingSettings(prev => ({ ...prev, climbs: value }))
                        }>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="IGNORE">Ignore</SelectItem>
                            <SelectItem value="AVOID_IF_REASONABLE">Avoid if Reasonable</SelectItem>
                            <SelectItem value="AVOID_IF_POSSIBLE">Avoid if Possible</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="surface">Surface Preference</Label>
                        <Select value={routingSettings.surface} onValueChange={(value) => 
                          setRoutingSettings(prev => ({ ...prev, surface: value }))
                        }>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="PREFER_NON_PAVED">Prefer Unpaved</SelectItem>
                            <SelectItem value="PREFER_SMOOTH">Prefer Smooth</SelectItem>
                            <SelectItem value="AVOID_NON_SMOOTH">Avoid Non-Smooth</SelectItem>
                            <SelectItem value="AVOID_BAD_SMOOTHNESS_ONLY">Avoid Bad Only</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
            
            <TabsContent value="diagnostics" className="mt-0 p-4 h-56 overflow-y-auto">
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Diagnostic Information</CardTitle>
                    <CardDescription>System counters and status</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                        <span>Waypoints: {waypoints.length}</span>
                      </div>
                      {currentRoutes.length > 0 && (
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-green-500"></span>
                          <span>Routes: {currentRoutes.length}</span>
                        </div>
                      )}
                      {temporaryTracks.length > 0 && (
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-yellow-500"></span>
                          <span>Temp Tracks: {temporaryTracks.length}</span>
                        </div>
                      )}
                      {permanentTracks.length > 0 && (
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-purple-500"></span>
                          <span>Saved Tracks: {permanentTracks.length}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-teal-500"></span>
                        <span>Visible Tracks: {tracks.filter(t => t.isVisible()).length}</span>
                      </div>
                      {getLastHoveredFeature() && (
                        <div className="flex items-center gap-2 text-orange-600 col-span-2">
                          <span className="w-2 h-2 rounded-full bg-orange-600"></span>
                          <span>Hovered: {getLastHoveredFeature()}</span>
                        </div>
                      )}
                      {isProcessing && (
                        <div className="flex items-center gap-2 text-blue-600 col-span-2">
                          <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse"></span>
                          <span>Processing routes...</span>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
            
            <TabsContent value="info" className="mt-0 p-4 h-56 overflow-y-auto">
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Ibex - Gravel Bike Routing</CardTitle>
                    <CardDescription>Route planning for gravel cyclists</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div>
                      <h4 className="font-medium mb-1">Features</h4>
                      <ul className="text-muted-foreground space-y-1">
                        <li>• Multiple route alternatives</li>
                        <li>• GPX export functionality</li>
                        <li>• Track management and persistence</li>
                        <li>• Elevation and distance metrics</li>
                      </ul>
                    </div>
                    <div>
                      <h4 className="font-medium mb-1">Usage</h4>
                      <ul className="text-muted-foreground space-y-1">
                        <li>• Click on map to add waypoints</li>
                        <li>• Use compute routes button or Tools tab</li>
                        <li>• Right-click tracks (long-tap on mobile) for context menu</li>
                        <li>• Save temporary tracks for future reference</li>
                        <li>• Export tracks as GPX files</li>
                        <li>• Sort tracks by clicking column headers</li>
                      </ul>
                    </div>
                    <div>
                      <h4 className="font-medium mb-1">Track Interactions</h4>
                      <ul className="text-muted-foreground space-y-1">
                        <li>• Hover over tracks shows diagnostic info</li>
                        <li>• Right-click/long-tap for context menus</li>
                        <li>• Temporary tracks: Save, Export, Delete</li>
                        <li>• Saved tracks: Hide/Show, Export, Delete</li>
                        <li>• Click color dot to change track color</li>
                        <li>• Click track name to rename (saved only)</li>
                      </ul>
                    </div>
                    <div className="pt-2 border-t">
                      <p className="text-xs text-muted-foreground">
                        Built with React, TypeScript, and MapLibre GL JS
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          </Tabs>
        )}
      </div>
      
      {/* Dialog Components */}
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog(prev => ({ ...prev, open }))}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.variant === "destructive" ? "Delete" : "Continue"}
      />
      
      <InputDialog
        open={inputDialog.open}
        onOpenChange={(open) => setInputDialog(prev => ({ ...prev, open }))}
        title={inputDialog.title}
        description={inputDialog.description}
        label={inputDialog.label}
        placeholder={inputDialog.placeholder}
        defaultValue={inputDialog.defaultValue}
        onConfirm={inputDialog.onConfirm}
        validation={inputDialog.validation}
      />

      <MultiActionConfirmDialog
        open={multiActionDialog.open}
        onOpenChange={(open) => setMultiActionDialog(prev => ({ ...prev, open }))}
        title={multiActionDialog.title}
        description={multiActionDialog.description}
        actions={multiActionDialog.actions}
      />
    </div>
  )
}

export default App
