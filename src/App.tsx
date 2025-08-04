import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Settings, RotateCcw, Save, Download, Eye, EyeOff, Trash2, PanelLeftOpen, PanelLeftClose, Info, Gauge } from 'lucide-react'
import { useMarkerManager } from '@/hooks/useMarkerManager'
import { useRoutes, Route } from '@/hooks/useRoutes'
import { useTrackManager } from '@/hooks/useTrackManager'
import { WaypointData } from '@/services/MarkerManager'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { InputDialog } from '@/components/ui/input-dialog'
import { toast } from 'sonner'



function App() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const [trackManagerOpen, setTrackManagerOpen] = useState(true)
  
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
    clearTemporaryTracks,
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
        // Import CSS separately via index.css or global.css
        
        if (mapContainer.current && !mapRef.current) {
          const map = new maplibregl.Map({
            container: mapContainer.current,
            style: 'https://api.maptiler.com/maps/01984598-44d5-70a4-b028-6ce2d6f3027a/style.json?key=r0T8W9TTH8XCCGoLL9gE',
            center: [6.1908, 46.1943],
            zoom: 10,
            maxZoom: 18,
            minZoom: 5
          })

          mapRef.current = map

          map.on('load', () => {
            console.log('Map loaded successfully')
          })

          // Initialize managers and add click handler
          Promise.all([
            initializeMarkerManager(mapRef),
            initializeTrackManager(mapRef)
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


  const handleProcessRoute = async () => {
    const routes = await processRoute(waypoints, mapRef)
    
    if (routes.length > 0) {
      // Add routes as temporary tracks using the track manager
      addTemporaryTracks(routes, waypoints)
    }
  }


  return (
    <div className="h-screen w-screen bg-background text-foreground relative flex flex-col">
      {/* Main content with map */}
      <div className="flex-1 relative">
        {/* Control buttons */}
        <div className="absolute top-4 right-4 z-10 flex flex-col gap-2">
        <Button
          onClick={handleProcessRoute}
          disabled={waypoints.length < 2 || isProcessing}
          className="control-button rounded-full w-12 h-12 p-0"
          title="Process Route"
        >
          <Settings className="h-5 w-5" />
        </Button>
        
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              className="control-button rounded-full w-12 h-12 p-0"
              title="Clear Waypoints"
            >
              <RotateCcw className="h-5 w-5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete temporary tracks and way points. Saved track will not be affected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleClearWaypoints}>Continue</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        </div>


        {/* Map container */}
        <div 
          ref={mapContainer} 
          className="h-full w-full cursor-crosshair" 
        />
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
              <TabsTrigger value="settings" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none bg-transparent">
                <Gauge className="h-4 w-4 mr-1" />
                Diagnostics
              </TabsTrigger>
              <TabsTrigger value="info" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none bg-transparent">
                <Info className="h-4 w-4 mr-1" />
                Info
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="tracks" className="mt-0 p-4 h-56 overflow-y-auto">
              <div className="space-y-4">
                {/* Temporary Tracks Section */}
                <div>
                  <h3 className="text-sm font-medium mb-2">Temporary Routes</h3>
                  {temporaryTracks.length === 0 ? (
                    <Card>
                      <CardContent className="p-3">
                        <p className="text-sm text-muted-foreground">No routes computed yet</p>
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="space-y-2">
                      {temporaryTracks.map(track => (
                        <Card key={track.getId()}>
                          <CardContent className="p-3">
                            <div className="mb-2">
                              <div className="font-medium text-sm flex items-center gap-2">
                                <span 
                                  className="w-3 h-3 rounded-full" 
                                  style={{ backgroundColor: track.getColor() }}
                                ></span>
                                {track.getName()}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {track.getWaypoints().length} waypoints • {new Date(track.getCreatedAt()).toLocaleDateString()}
                                {track.getRoute()?.stats && (
                                  <>
                                    <br />
                                    {track.getRoute()?.stats?.distanceMeters ? (track.getRoute()!.stats!.distanceMeters / 1000).toFixed(1) + 'km' : 'N/A'} • 
                                    {track.getRoute()?.stats?.durationSeconds ? Math.round(track.getRoute()!.stats!.durationSeconds / 60) + 'min' : 'N/A'}
                                    {track.getRoute()?.stats?.elevationGainMeters && (
                                      <> • ↗{track.getRoute()!.stats!.elevationGainMeters.toFixed(0)}m</>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-1 flex-wrap">
                              <Button
                                onClick={() => {
                                  showInputDialog(
                                    "Save Track",
                                    "Track name",
                                    (trackName) => {
                                      saveTrackAsPermanent(track.getId(), trackName)
                                      toast.success("Track saved permanently!")
                                    },
                                    {
                                      placeholder: "Enter track name",
                                      defaultValue: track.getName(),
                                      validation: (value) => value.trim().length > 0 || "Track name is required"
                                    }
                                  )
                                }}
                                size="sm"
                                variant="default"
                              >
                                <Save className="h-3 w-3 mr-1" />
                                Save
                              </Button>
                              <Button
                                onClick={() => exportTrack(track.getId())}
                                size="sm"
                                variant="outline"
                              >
                                <Download className="h-3 w-3 mr-1" />
                                Export
                              </Button>
                              <Button
                                onClick={() => {
                                  showConfirmDialog(
                                    "Delete Track",
                                    `Are you sure you want to delete "${track.getName()}"? This action cannot be undone.`,
                                    () => deleteTrack(track.getId()),
                                    "destructive"
                                  )
                                }}
                                size="sm"
                                variant="destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>

                {/* Permanent Tracks Section */}
                <div>
                  <h3 className="text-sm font-medium mb-2">Saved Tracks</h3>
                  {permanentTracks.length === 0 ? (
                    <Card>
                      <CardContent className="p-3">
                        <p className="text-sm text-muted-foreground">No saved tracks</p>
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="space-y-2">
                      {permanentTracks.map(track => (
                        <Card key={track.getId()}>
                          <CardContent className="p-3">
                            <div className="mb-2">
                              <div className="font-medium text-sm flex items-center gap-2">
                                <span 
                                  className="w-3 h-3 rounded-full cursor-pointer" 
                                  style={{ backgroundColor: track.getColor() }}
                                  onClick={() => {
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
                                  }}
                                  title="Click to change color"
                                ></span>
                                <span
                                  className="cursor-pointer"
                                  onClick={() => {
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
                                  }}
                                  title="Click to rename"
                                >
                                  {track.getName()}
                                </span>
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {track.getWaypoints().length} waypoints • {new Date(track.getCreatedAt()).toLocaleDateString()}
                                {track.getRoute()?.stats && (
                                  <>
                                    <br />
                                    {track.getRoute()?.stats?.distanceMeters ? (track.getRoute()!.stats!.distanceMeters / 1000).toFixed(1) + 'km' : 'N/A'} • 
                                    {track.getRoute()?.stats?.durationSeconds ? Math.round(track.getRoute()!.stats!.durationSeconds / 60) + 'min' : 'N/A'}
                                    {track.getRoute()?.stats?.elevationGainMeters && (
                                      <> • ↗{track.getRoute()!.stats!.elevationGainMeters.toFixed(0)}m</>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-1 flex-wrap">
                              <Button
                                onClick={() => toggleTrackVisibility(track.getId())}
                                size="sm"
                                variant="outline"
                              >
                                {track.isVisible() ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
                                {track.isVisible() ? "Hide" : "Show"}
                              </Button>
                              <Button
                                onClick={() => exportTrack(track.getId())}
                                size="sm"
                                variant="outline"
                              >
                                <Download className="h-3 w-3 mr-1" />
                                GPX
                              </Button>
                              <Button
                                onClick={() => {
                                  showConfirmDialog(
                                    "Delete Saved Track",
                                    `Are you sure you want to permanently delete "${track.getName()}"? This action cannot be undone.`,
                                    () => {
                                      deleteTrack(track.getId())
                                      toast.success("Track deleted!")
                                    },
                                    "destructive"
                                  )
                                }}
                                size="sm"
                                variant="destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>
            
            <TabsContent value="settings" className="mt-0 p-4 h-56 overflow-y-auto">
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
                        <li>• Process routes to get alternatives</li>
                        <li>• Save routes for future reference</li>
                        <li>• Export tracks as GPX files</li>
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
    </div>
  )
}

export default App