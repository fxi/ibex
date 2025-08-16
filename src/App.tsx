import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Settings,
  RotateCcw,
  Save,
  Download,
  Eye,
  EyeOff,
  Trash2,
  PanelLeftOpen,
  PanelLeftClose,
  Info,
  Gauge,
  ChevronUp,
  ChevronDown,
  CloudCog,
  Pencil,
  Expand,
  LocateFixed,
  Search,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useMarkerManager } from "@/hooks/useMarkerManager";
import { useRoutes, Route } from "@/hooks/useRoutes";
import { useTrackManager } from "@/hooks/useTrackManager";
import { WaypointData } from "@/services/MarkerManager";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MultiActionConfirmDialog } from "@/components/ui/multi-action-confirm-dialog";
import { InputDialog } from "@/components/ui/input-dialog";
import { CircularRouteDialog } from "@/components/ui/circular-route-dialog";
import { RouteLegend } from "@/components/ui/route-legend";
import { LocationButton } from "@/components/ui/location-button";
import { GeocodingSearch } from "@/components/ui/geocoding-search";
import { TrackItem } from "@/components/ui/track-item";
import { RouteVisualization } from "@/services/RouteVisualization";
import { toast } from "sonner";

const basepath = import.meta.env.BASE_URL;

function App() {
  useViewportHeight(); // Set the --app-height CSS variable
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const maplibreglRef = useRef<any>(null);
  const [trackManagerOpen, setTrackManagerOpen] = useState(true);

  // Table sorting state
  type SortColumn =
    | "name"
    | "pts"
    | "date"
    | "distance"
    | "time"
    | "elevation"
    | "saved";
  type SortDirection = "asc" | "desc" | "none";
  const [sortConfig, setSortConfig] = useState<{
    column: SortColumn | null;
    direction: SortDirection;
  }>({
    column: "date",
    direction: "desc", // Default: most recent first
  });

  // Visualization Settings
  const [useSurfaceQualityColors, setUseSurfaceQualityColors] = useState(false);

  // API Routing Settings
  const [routingSettings, setRoutingSettings] = useState({
    bikeType: "GRAVEL_BIKE",
    traffic: "AVOID_IF_REASONABLE",
    climbs: "IGNORE",
    stairs: "AVOID_IF_POSSIBLE",
    pavements: "AVOID_IF_POSSIBLE",
    oneways: "AVOID_IF_POSSIBLE",
    surface: "IGNORE",
    optimizeWaypointsOrder: true,
  });

  // Dialog states
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
    variant?: "default" | "destructive";
  }>({
    open: false,
    title: "",
    description: "",
    onConfirm: () => {},
    variant: "default",
  });

  const [multiActionDialog, setMultiActionDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    actions: {
      label: string;
      onClick: () => void;
      variant?: "default" | "destructive";
    }[];
  }>({
    open: false,
    title: "",
    description: "",
    actions: [],
  });

  const [inputDialog, setInputDialog] = useState<{
    open: boolean;
    title: string;
    description?: string;
    label: string;
    placeholder?: string;
    defaultValue?: string;
    onConfirm: (value: string) => void;
    validation?: (value: string) => boolean | string;
  }>({
    open: false,
    title: "",
    label: "",
    onConfirm: () => {},
  });

  const [circularRouteDialogOpen, setCircularRouteDialogOpen] = useState(false);

  // Use marker manager for clean marker handling
  const {
    waypoints,
    addWaypoint,
    clearWaypoints,
    setAllWaypoints,
    initializeManager: initializeMarkerManager,
  } = useMarkerManager();

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
    getLastHoveredFeature,
    updateAllTracksVisibility,
    initializeManager: initializeTrackManager,
  } = useTrackManager();

  const {
    currentRoutes,
    allRouteAlternatives,
    isProcessing,
    processRoute,
    processCircularRoute,
    clearRoutes,
  } = useRoutes();

  // Dialog helper functions
  const showConfirmDialog = (
    title: string,
    description: string,
    onConfirm: () => void,
    variant: "default" | "destructive" = "default"
  ) => {
    setConfirmDialog({
      open: true,
      title,
      description,
      onConfirm,
      variant,
    });
  };

  const showMultiActionConfirmDialog = (
    title: string,
    description: string,
    actions: {
      label: string;
      onClick: () => void;
      variant?: "default" | "destructive";
    }[]
  ) => {
    setMultiActionDialog({
      open: true,
      title,
      description,
      actions,
    });
  };

  const showInputDialog = (
    title: string,
    label: string,
    onConfirm: (value: string) => void,
    options: {
      description?: string;
      placeholder?: string;
      defaultValue?: string;
      validation?: (value: string) => boolean | string;
    } = {}
  ) => {
    setInputDialog({
      open: true,
      title,
      label,
      onConfirm,
      ...options,
    });
  };

  // Clear routes when waypoints change to less than 2
  useEffect(() => {
    if (waypoints.length < 2 && currentRoutes.length > 0) {
      clearRoutes(mapRef);
    }
  }, [waypoints.length, currentRoutes.length, clearRoutes]);

  // Update track visualization when color mode changes
  useEffect(() => {
    if (updateAllTracksVisibility) {
      updateAllTracksVisibility(useSurfaceQualityColors);
    }
  }, [useSurfaceQualityColors, updateAllTracksVisibility]);

  // Initialize map
  useEffect(() => {
    const loadMap = async () => {
      try {
        const maplibregl = await import("maplibre-gl");
        maplibreglRef.current = maplibregl;
        // Import CSS separately via index.css or global.css

        if (mapContainer.current && !mapRef.current) {
          const map = new maplibregl.Map({
            container: mapContainer.current,
            style: `https://api.maptiler.com/maps/01984598-44d5-70a4-b028-6ce2d6f3027a/style.json?key=${
              import.meta.env.VITE_MAPTILER_API_KEY
            }`,
            center: [6.1908, 46.1943],
            zoom: 10,
            maxZoom: 18,
            minZoom: 5,
            pitch: 0,
            bearing: 0,
            rollEnabled: false,
          });

          mapRef.current = map;

          map.on("load", () => {
            map.setSprite(`${window.location.origin}${basepath}sprites/symbols`);

            // Add a permanent anchor layer for track placement
            if (!map.getLayer("ibex_anchor")) {
              map.addLayer({
                id: "ibex_anchor",
                type: "background",
                paint: { "background-opacity": 0 },
              });
            }

            map.addSource("terrainSource", {
              type: "raster-dem",
              url: `https://api.maptiler.com/tiles/terrain-rgb/tiles.json?key=${
                import.meta.env.VITE_MAPTILER_API_KEY
              }`,
              tileSize: 256,
            });
          });

          map.on("pitch", () => {
            if (map.getPitch() > 0) {
              map.setTerrain({ source: "terrainSource", exaggeration: 1.5 });
            } else {
              map.setTerrain(null);
            }
          });

          // Initialize managers and add click handler
          Promise.all([
            initializeMarkerManager(mapRef),
            initializeTrackManager(mapRef, maplibreglRef.current),
          ]).then(() => {
            // Simple click handler - no debouncing needed with clean class approach
            map.on("click", (e) => {
              addWaypoint(e.lngLat.lng, e.lngLat.lat);
            });
          });

          map.on("error", (e) => {
            console.error("Map error:", e);
          });
        }
      } catch (error) {
        console.error("Failed to load MapLibre:", error);
      }
    };

    loadMap();
  }, []);

  const handleClearWaypoints = () => {
    clearWaypoints();
    clearRoutes(mapRef);
    clearTemporaryTracks();
  };

  const handleProcessRoute = async (replaceExisting: boolean = false) => {
    if (temporaryTracks.length > 0 && !replaceExisting) {
      showMultiActionConfirmDialog(
        "Existing Temporary Tracks",
        "You have existing temporary tracks. What would you like to do?",
        [
          {
            label: "Replace",
            onClick: () => {
              clearTemporaryTracks();
              processAndAddRoutes();
            },
            variant: "destructive",
          },
          {
            label: "Add",
            onClick: () => processAndAddRoutes(),
          },
        ]
      );
      return;
    }

    processAndAddRoutes();
  };

  const processAndAddRoutes = async () => {
    const routes = await processRoute(waypoints, mapRef, routingSettings);

    if (routes.length > 0) {
      addTemporaryTracks(routes, waypoints, useSurfaceQualityColors);
    }
  };

  const handleProcessCircularRoute = (distance: number) => {
    if (waypoints.length === 0) {
      toast.error(
        "Please add at least one waypoint to create a circular route."
      );
      return;
    }

    const startPoint = waypoints[0];
    const intermediateWaypoints = waypoints.slice(1);

    const processAndAddCircularRoutes = async () => {
      const routes = await processCircularRoute(
        startPoint,
        distance,
        intermediateWaypoints,
        mapRef,
        routingSettings
      );
      if (routes.length > 0) {
        addTemporaryTracks(routes, waypoints, useSurfaceQualityColors);
      }
    };

    if (temporaryTracks.length > 0) {
      showMultiActionConfirmDialog(
        "Existing Temporary Tracks",
        "You have existing temporary tracks. What would you like to do?",
        [
          {
            label: "Replace",
            onClick: () => {
              clearTemporaryTracks();
              processAndAddCircularRoutes();
            },
            variant: "destructive",
          },
          {
            label: "Add",
            onClick: () => processAndAddCircularRoutes(),
          },
        ]
      );
    } else {
      processAndAddCircularRoutes();
    }
  };

  const handleReloadWaypoints = useCallback(
    (track: any) => {
      showConfirmDialog(
        "Reload Waypoints",
        "This will clear current waypoints and temporary tracks. Are you sure you want to continue?",
        () => {
          if (!track.isVisible()) {
            toggleTrackVisibility(track.getId(), useSurfaceQualityColors);
          }
          clearWaypoints();
          clearTemporaryTracks();
          setAllWaypoints(
            track
              .getWaypoints()
              .map((wp: WaypointData) => ({ lng: wp.lng, lat: wp.lat }))
          );
          toast.success("Waypoints reloaded for editing!");
        }
      );
    },
    [
      clearWaypoints,
      clearTemporaryTracks,
      setAllWaypoints,
      toggleTrackVisibility,
      useSurfaceQualityColors,
    ]
  );

  // Fixed handler for save track to prevent closure issues
  const handleSaveTrack = useCallback(
    (trackId: string, trackName: string) => {
      showInputDialog(
        "Save Track",
        "Track name",
        (newTrackName) => {
          saveTrackAsPermanent(
            trackId,
            newTrackName,
            useSurfaceQualityColors
          );
          toast.success("Track saved permanently!");
        },
        {
          placeholder: "Enter track name",
          defaultValue: trackName,
          validation: (value) =>
            value.trim().length > 0 || "Track name is required",
        }
      );
    },
    [saveTrackAsPermanent, useSurfaceQualityColors]
  );

  // Tri-state sorting handler
  const handleSort = useCallback((column: SortColumn) => {
    setSortConfig((prevConfig) => {
      if (prevConfig.column !== column) {
        return { column, direction: "asc" };
      }

      switch (prevConfig.direction) {
        case "asc":
          return { column, direction: "desc" };
        case "desc":
          return { column: null, direction: "none" };
        case "none":
        default:
          return { column, direction: "asc" };
      }
    });
  }, []);

  // Sort tracks based on current sort configuration
  const sortedTracks = useCallback(() => {
    if (!sortConfig.column || sortConfig.direction === "none") {
      // Default sort: most recent first
      return [...tracks].sort(
        (a, b) =>
          new Date(b.getCreatedAt()).getTime() -
          new Date(a.getCreatedAt()).getTime()
      );
    }

    const sorted = [...tracks].sort((a, b) => {
      let aValue: any, bValue: any;

      switch (sortConfig.column) {
        case "name":
          aValue = a.getName().toLowerCase();
          bValue = b.getName().toLowerCase();
          break;
        case "pts":
          aValue = a.getWaypoints().length;
          bValue = b.getWaypoints().length;
          break;
        case "date":
          aValue = new Date(a.getCreatedAt()).getTime();
          bValue = new Date(b.getCreatedAt()).getTime();
          break;
        case "distance":
          aValue = a.getRoute()?.stats?.distanceMeters || 0;
          bValue = b.getRoute()?.stats?.distanceMeters || 0;
          break;
        case "time":
          aValue = a.getRoute()?.stats?.durationSeconds || 0;
          bValue = b.getRoute()?.stats?.durationSeconds || 0;
          break;
        case "elevation":
          aValue = a.getRoute()?.stats?.elevationGainMeters || 0;
          bValue = b.getRoute()?.stats?.elevationGainMeters || 0;
          break;
        case "saved":
          aValue = a.isPermanentTrack() ? 1 : 0;
          bValue = b.isPermanentTrack() ? 1 : 0;
          break;
        default:
          return 0;
      }

      if (sortConfig.direction === "asc") {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });

    return sorted;
  }, [tracks, sortConfig]);

  // Calculate color mapping for legend
  const getColorMapping = () => {
    return RouteVisualization.getSurfaceColorMapping();
  };

  return (
    <div className="h-app w-screen bg-background text-foreground relative overflow-hidden">
      {/* Map container */}
      <div className="absolute inset-0">
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
          <Button
            onClick={() => setCircularRouteDialogOpen(true)}
            disabled={waypoints.length === 0 || isProcessing}
            size="sm"
            variant="secondary"
            className="shadow-lg"
            title="Create Circular Route"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <LocationButton mapRef={mapRef} />
          <GeocodingSearch mapRef={mapRef} addWaypoint={addWaypoint} />
        </div>

        <div ref={mapContainer} className="h-full w-full cursor-crosshair" />
      </div>

      {/* Bottom Panel with Tabs - Overlay */}
      <div
        className={`absolute bottom-0 left-0 right-0 bg-background border-t rounded-t-lg shadow-2xl transition-transform duration-300 ease-in-out z-20 ${
          trackManagerOpen ? "translate-y-0" : "translate-y-[calc(100%-4rem)]"
        }`}
      >
        {/* Panel Header Handle */}
        <div
          className="flex items-center justify-center p-3 border-b cursor-pointer"
          onClick={() => setTrackManagerOpen(!trackManagerOpen)}
        >
          <Button variant="ghost" size="sm" className="w-full">
            {trackManagerOpen ? (
              <ChevronDown className="h-5 w-5" />
            ) : (
              <ChevronUp className="h-5 w-5" />
            )}
          </Button>
        </div>

        {/* Panel Content */}
        <div className="h-80">
          <Tabs defaultValue="tracks" className="h-full">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="tracks">
                <PanelLeftOpen className="h-4 w-4 md:mr-2" />
                <span className="hidden md:inline">Tracks</span>
              </TabsTrigger>
              <TabsTrigger value="tools">
                <Settings className="h-4 w-4 md:mr-2" />
                <span className="hidden md:inline">Tools</span>
              </TabsTrigger>
              <TabsTrigger value="settings">
                <CloudCog className="h-4 w-4 md:mr-2" />
                <span className="hidden md:inline">Settings</span>
              </TabsTrigger>
              <TabsTrigger value="diagnostics">
                <Gauge className="h-4 w-4 md:mr-2" />
                <span className="hidden md:inline">Diagnostics</span>
              </TabsTrigger>
              <TabsTrigger value="info">
                <Info className="h-4 w-4 md:mr-2" />
                <span className="hidden md:inline">Info</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent
              value="tracks"
              className="mt-0 p-2 md:p-4 h-[calc(100%-3rem)] overflow-y-auto"
            >
              {/* Combined Tracks List/Table */}
              {tracks.length === 0 ? (
                <Card>
                  <CardContent className="p-3">
                    <p className="text-sm text-muted-foreground">
                      No tracks available
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <>
                  {/* Mobile Card View */}
                  <div className="md:hidden space-y-2">
                    {sortedTracks().map((track) => (
                      <TrackItem
                        key={track.getId()}
                        track={track}
                        handleReloadWaypoints={handleReloadWaypoints}
                        exportTrack={exportTrack}
                        zoomToTrack={zoomToTrack}
                        toggleTrackVisibility={(trackId) =>
                          toggleTrackVisibility(trackId, useSurfaceQualityColors)
                        }
                        showConfirmDialog={showConfirmDialog}
                        deleteTrack={deleteTrack}
                      />
                    ))}
                  </div>

                  {/* Desktop Table View */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="pb-2 font-medium">
                            <button
                              onClick={() => handleSort("name")}
                              className="flex items-center gap-1 hover:text-foreground transition-colors"
                            >
                              Track
                              {sortConfig.column === "name" &&
                                (sortConfig.direction === "asc" ? (
                                  <ChevronUp className="h-3 w-3" />
                                ) : (
                                  <ChevronDown className="h-3 w-3" />
                                ))}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-center">
                            <button
                              onClick={() => handleSort("pts")}
                              className="flex items-center gap-1 hover:text-foreground transition-colors mx-auto"
                            >
                              Pts
                              {sortConfig.column === "pts" &&
                                (sortConfig.direction === "asc" ? (
                                  <ChevronUp className="h-3 w-3" />
                                ) : (
                                  <ChevronDown className="h-3 w-3" />
                                ))}
                            </button>
                          </th>
                          <th className="pb-2 font-medium">
                            <button
                              onClick={() => handleSort("date")}
                              className="flex items-center gap-1 hover:text-foreground transition-colors"
                            >
                              Date
                              {sortConfig.column === "date" &&
                                (sortConfig.direction === "asc" ? (
                                  <ChevronUp className="h-3 w-3" />
                                ) : (
                                  <ChevronDown className="h-3 w-3" />
                                ))}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-right">
                            <button
                              onClick={() => handleSort("distance")}
                              className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                            >
                              Distance
                              {sortConfig.column === "distance" &&
                                (sortConfig.direction === "asc" ? (
                                  <ChevronUp className="h-3 w-3" />
                                ) : (
                                  <ChevronDown className="h-3 w-3" />
                                ))}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-right">
                            <button
                              onClick={() => handleSort("time")}
                              className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                            >
                              Time
                              {sortConfig.column === "time" &&
                                (sortConfig.direction === "asc" ? (
                                  <ChevronUp className="h-3 w-3" />
                                ) : (
                                  <ChevronDown className="h-3 w-3" />
                                ))}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-right">
                            <button
                              onClick={() => handleSort("elevation")}
                              className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                            >
                              Elevation
                              {sortConfig.column === "elevation" &&
                                (sortConfig.direction === "asc" ? (
                                  <ChevronUp className="h-3 w-3" />
                                ) : (
                                  <ChevronDown className="h-3 w-3" />
                                ))}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-center">
                            <button
                              onClick={() => handleSort("saved")}
                              className="flex items-center gap-1 hover:text-foreground transition-colors mx-auto"
                            >
                              Saved
                              {sortConfig.column === "saved" &&
                                (sortConfig.direction === "asc" ? (
                                  <ChevronUp className="h-3 w-3" />
                                ) : (
                                  <ChevronDown className="h-3 w-3" />
                                ))}
                            </button>
                          </th>
                          <th className="pb-2 font-medium text-center">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTracks().map((track) => (
                          <tr
                            key={track.getId()}
                            className="border-b hover:bg-muted/50"
                          >
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
                                          updateTrackColor(
                                            track.getId(),
                                            newColor,
                                            useSurfaceQualityColors
                                          );
                                          toast.success("Track color updated!");
                                        },
                                        {
                                          placeholder: "#FF0000",
                                          defaultValue: track.getColor(),
                                          validation: (value) =>
                                            /^#[0-9A-F]{6}$/i.test(value) ||
                                            "Please enter a valid hex color (e.g., #FF0000)",
                                        }
                                      );
                                    }
                                  }}
                                  title={
                                    track.isPermanentTrack()
                                      ? "Click to change color"
                                      : "Color"
                                  }
                                ></span>
                                <span
                                  className={`${
                                    track.isPermanentTrack()
                                      ? "cursor-pointer hover:underline"
                                      : ""
                                  } truncate max-w-28 md:max-w-xs`}
                                  onClick={() => {
                                    if (track.isPermanentTrack()) {
                                      showInputDialog(
                                        "Rename Track",
                                        "Track name",
                                        (newName) => {
                                          renameTrack(
                                            track.getId(),
                                            newName.trim()
                                          );
                                          toast.success("Track renamed!");
                                        },
                                        {
                                          defaultValue: track.getName(),
                                          validation: (value) =>
                                            value.trim().length > 0 ||
                                            "Track name is required",
                                        }
                                      );
                                    }
                                  }}
                                  title={
                                    track.isPermanentTrack()
                                      ? "Click to rename"
                                      : ""
                                  }
                                >
                                  {track.getName()}
                                </span>
                              </div>
                            </td>
                            <td className="py-2 text-center text-muted-foreground">
                              {track.getWaypoints().length}
                            </td>
                            <td className="py-2 text-muted-foreground">
                              {new Date(
                                track.getCreatedAt()
                              ).toLocaleDateString(undefined, {
                                month: "2-digit",
                                day: "2-digit",
                                year: "2-digit",
                              })}
                            </td>
                            <td className="py-2 text-right">
                              {track.getRoute()?.stats?.distanceMeters
                                ? (
                                    track.getRoute()!.stats!.distanceMeters /
                                    1000
                                  ).toFixed(1) + "km"
                                : "N/A"}
                            </td>
                            <td className="py-2 text-right">
                              {track.getRoute()?.stats?.durationSeconds
                                ? Math.round(
                                    track.getRoute()!.stats!.durationSeconds /
                                      60
                                  ) + "min"
                                : "N/A"}
                            </td>
                            <td className="py-2 text-right">
                              {track.getRoute()?.stats?.elevationGainMeters
                                ? "↗" +
                                  track
                                    .getRoute()!
                                    .stats!.elevationGainMeters.toFixed(0) +
                                  "m"
                                : "N/A"}
                            </td>
                            <td className="py-2 text-center">
                              {track.isPermanentTrack() ? (
                                <span className="text-green-600">✓</span>
                              ) : (
                                <Button
                                  onClick={() =>
                                    handleSaveTrack(
                                      track.getId(),
                                      track.getName()
                                    )
                                  }
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
                                  onClick={() =>
                                    toggleTrackVisibility(
                                      track.getId(),
                                      useSurfaceQualityColors
                                    )
                                  }
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 w-6 p-0"
                                  title={track.isVisible() ? "Hide" : "Show"}
                                >
                                  {track.isVisible() ? (
                                    <EyeOff className="h-3 w-3" />
                                  ) : (
                                    <Eye className="h-3 w-3" />
                                  )}
                                </Button>
                                <Button
                                  onClick={() => {
                                    showConfirmDialog(
                                      track.isPermanentTrack()
                                        ? "Delete Saved Track"
                                        : "Delete Track",
                                      `Are you sure you want to delete "${track.getName()}"? This action cannot be undone.`,
                                      () => {
                                        deleteTrack(track.getId());
                                        toast.success("Track deleted!");
                                      },
                                      "destructive"
                                    );
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
                </>
              )}
            </TabsContent>

            <TabsContent
              value="tools"
              className="mt-0 p-4 h-[calc(100%-3rem)] overflow-y-auto"
            >
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Route Processing
                    </CardTitle>
                    <CardDescription>Compute and manage routes</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Button
                      onClick={() => handleProcessRoute()}
                      disabled={waypoints.length < 2 || isProcessing}
                      className="w-full"
                    >
                      <CloudCog className="h-4 w-4 mr-2" />
                      {isProcessing ? "Processing..." : "Compute Routes"}
                    </Button>

                    <Button
                      onClick={() => setCircularRouteDialogOpen(true)}
                      disabled={waypoints.length === 0 || isProcessing}
                      className="w-full"
                    >
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Create Circular Route
                    </Button>

                    <Button
                      onClick={() => {
                        showConfirmDialog(
                          "Clear Temporary Data",
                          "This will clear waypoints and temporary tracks. Saved tracks will not be affected.",
                          handleClearWaypoints,
                          "default"
                        );
                      }}
                      variant="outline"
                      className="w-full"
                      disabled={
                        waypoints.length === 0 && temporaryTracks.length === 0
                      }
                    >
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Clear Temporary
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base text-destructive">
                      Danger Zone
                    </CardTitle>
                    <CardDescription>
                      Permanently delete all data
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button
                      onClick={() => {
                        showConfirmDialog(
                          "Clear All Data",
                          "This will permanently delete ALL tracks, waypoints, and settings. This action cannot be undone.",
                          () => {
                            clearWaypoints();
                            clearRoutes(mapRef);
                            clearAllTracks();
                            toast.success("All data cleared");
                          },
                          "destructive"
                        );
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

            <TabsContent
              value="settings"
              className="mt-0 p-4 h-[calc(100%-3rem)] overflow-y-auto"
            >
              <div className="space-y-4">
                {/* Route Visualization Controls */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Route Visualization
                    </CardTitle>
                    <CardDescription>
                      Change how route segments are colored
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="surface-quality-colors"
                        checked={useSurfaceQualityColors}
                        onCheckedChange={(checked: boolean) =>
                          setUseSurfaceQualityColors(checked)
                        }
                      />
                      <Label
                        htmlFor="surface-quality-colors"
                        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                      >
                        Use surface quality colors
                      </Label>
                    </div>
                    {useSurfaceQualityColors && (
                      <RouteLegend
                        colorMapping={getColorMapping()}
                        className="flex-grow"
                      />
                    )}
                  </CardContent>
                </Card>

                {/* Routing Settings */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Routing Preferences
                    </CardTitle>
                    <CardDescription>
                      Customize route calculation
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="bike-type">Bicycle Type</Label>
                        <Select
                          value={routingSettings.bikeType}
                          onValueChange={(value) =>
                            setRoutingSettings((prev) => ({
                              ...prev,
                              bikeType: value,
                            }))
                          }
                        >
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
                            <SelectItem value="FOLDING_BIKE">Folding Bike</SelectItem>
                            <SelectItem value="CARGO_BIKE">Cargo Bike</SelectItem>
                            <SelectItem value="ELECTRIC_SCOOTER">E-Scooter</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="surface">Surface Preference</Label>
                        <Select
                          value={routingSettings.surface}
                          onValueChange={(value) =>
                            setRoutingSettings((prev) => ({
                              ...prev,
                              surface: value,
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="IGNORE">Ignore</SelectItem>
                            <SelectItem value="PREFER_NON_PAVED">Prefer Unpaved</SelectItem>
                            <SelectItem value="AVOID_BAD_SMOOTHNESS_ONLY">Avoid Bad Surfaces</SelectItem>
                            <SelectItem value="PREFER_SMOOTH">Prefer Smooth</SelectItem>
                            <SelectItem value="AVOID_NON_SMOOTH">Avoid Unpaved</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="traffic">Traffic Avoidance</Label>
                        <Select
                          value={routingSettings.traffic}
                          onValueChange={(value) =>
                            setRoutingSettings((prev) => ({
                              ...prev,
                              traffic: value,
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="IGNORE">Ignore</SelectItem>
                            <SelectItem value="AVOID_IF_REASONABLE">
                              Avoid if Reasonable
                            </SelectItem>
                            <SelectItem value="AVOID_IF_POSSIBLE">
                              Avoid if Possible
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="climbs">Climb Avoidance</Label>
                        <Select
                          value={routingSettings.climbs}
                          onValueChange={(value) =>
                            setRoutingSettings((prev) => ({
                              ...prev,
                              climbs: value,
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="IGNORE">Ignore</SelectItem>
                            <SelectItem value="AVOID_IF_REASONABLE">
                              Avoid if Reasonable
                            </SelectItem>
                            <SelectItem value="AVOID_IF_POSSIBLE">
                              Avoid if Possible
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="optimize-waypoints">
                          Waypoint Order
                        </Label>
                        <Select
                          value={routingSettings.optimizeWaypointsOrder.toString()}
                          onValueChange={(value) =>
                            setRoutingSettings((prev) => ({
                              ...prev,
                              optimizeWaypointsOrder: value === "true",
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">Optimize Order</SelectItem>
                            <SelectItem value="false">
                              Keep Original Order
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4 pt-4 border-t">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="avoid-stairs"
                          checked={routingSettings.stairs === 'STRICTLY_AVOID'}
                          onCheckedChange={(checked) =>
                            setRoutingSettings((prev) => ({
                              ...prev,
                              stairs: checked ? 'STRICTLY_AVOID' : 'AVOID_IF_POSSIBLE',
                            }))
                          }
                        />
                        <Label htmlFor="avoid-stairs">Avoid Stairs</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="avoid-pavements"
                          checked={routingSettings.pavements === 'STRICTLY_AVOID'}
                          onCheckedChange={(checked) =>
                            setRoutingSettings((prev) => ({
                              ...prev,
                              pavements: checked ? 'STRICTLY_AVOID' : 'AVOID_IF_POSSIBLE',
                            }))
                          }
                        />
                        <Label htmlFor="avoid-pavements">Avoid Pavements</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="avoid-oneways"
                          checked={routingSettings.oneways === 'STRICTLY_AVOID'}
                          onCheckedChange={(checked) =>
                            setRoutingSettings((prev) => ({
                              ...prev,
                              oneways: checked ? 'STRICTLY_AVOID' : 'AVOID_IF_POSSIBLE',
                            }))
                          }
                        />
                        <Label htmlFor="avoid-oneways">Avoid Oneways</Label>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent
              value="diagnostics"
              className="mt-0 p-4 h-[calc(100%-3rem)] overflow-y-auto"
            >
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Diagnostic Information
                    </CardTitle>
                    <CardDescription>
                      System counters and status
                    </CardDescription>
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
                        <span>
                          Visible Tracks:{" "}
                          {tracks.filter((t) => t.isVisible()).length}
                        </span>
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

            <TabsContent
              value="info"
              className="mt-0 p-4 h-[calc(100%-3rem)] overflow-y-auto"
            >
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Ibex - Gravel Bike Routing
                    </CardTitle>
                    <CardDescription>
                      Route planning for gravel cyclists
                    </CardDescription>
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
                        <li>
                          • Right-click tracks (long-tap on mobile) for context
                          menu
                        </li>
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
        </div>
      </div>

      {/* Dialog Components */}
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog((prev) => ({ ...prev, open }))}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={
          confirmDialog.variant === "destructive" ? "Delete" : "Continue"
        }
      />

      <InputDialog
        open={inputDialog.open}
        onOpenChange={(open) => setInputDialog((prev) => ({ ...prev, open }))}
        title={inputDialog.title}
        description={inputDialog.description}
        label={inputDialog.label}
        placeholder={inputDialog.placeholder}
        defaultValue={inputDialog.defaultValue}
        onConfirm={inputDialog.onConfirm}
        validation={inputDialog.validation}
      />

      <CircularRouteDialog
        open={circularRouteDialogOpen}
        onOpenChange={setCircularRouteDialogOpen}
        onConfirm={handleProcessCircularRoute}
      />

      <MultiActionConfirmDialog
        open={multiActionDialog.open}
        onOpenChange={(open) =>
          setMultiActionDialog((prev) => ({ ...prev, open }))
        }
        title={multiActionDialog.title}
        description={multiActionDialog.description}
        actions={multiActionDialog.actions}
      />
    </div>
  );
}

export default App;
