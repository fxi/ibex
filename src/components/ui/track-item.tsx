import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, Pencil, Download, Expand, EyeOff, Eye, Trash2 } from "lucide-react"
import { Track } from "@/services/TrackManager"
import { toast } from "sonner"

interface TrackItemProps {
  track: Track;
  handleReloadWaypoints: (track: Track) => void;
  exportTrack: (trackId: string) => void;
  zoomToTrack: (trackId: string) => void;
  toggleTrackVisibility: (trackId: string) => void;
  showConfirmDialog: (title: string, description: string, onConfirm: () => void, variant: "default" | "destructive") => void;
  deleteTrack: (trackId: string) => void;
}

export const TrackItem = ({
  track,
  handleReloadWaypoints,
  exportTrack,
  zoomToTrack,
  toggleTrackVisibility,
  showConfirmDialog,
  deleteTrack,
}: TrackItemProps) => {
  const stats = track.getRoute()?.stats;

  return (
    <Card key={track.getId()} className="p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span
            className="w-3 h-3 rounded-full flex-shrink-0 mt-1"
            style={{ backgroundColor: track.getColor() }}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate" title={track.getName()}>
              {track.getName()}
            </p>
            <div className="flex items-center gap-x-4 gap-y-1 text-xs text-muted-foreground flex-wrap">
              <span>{track.getWaypoints().length} pts</span>
              <span>
                {stats?.distanceMeters != null
                  ? `${(stats.distanceMeters / 1000).toFixed(1)}km`
                  : 'N/A'}
              </span>
              <span>
                {stats?.durationSeconds != null
                  ? `${Math.round(stats.durationSeconds / 60)}min`
                  : 'N/A'}
              </span>
              <span>
                {stats?.elevationGainMeters != null
                  ? `↗${stats.elevationGainMeters.toFixed(0)}m`
                  : 'N/A'}
              </span>
              <span>
                {stats?.userSettingsMatch != null
                  ? `${stats.userSettingsMatch}%`
                  : 'N/A'}
              </span>
            </div>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {track.isPermanentTrack() && (
              <DropdownMenuItem onClick={() => handleReloadWaypoints(track)}>
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => exportTrack(track.getId())}>
              <Download className="mr-2 h-4 w-4" /> Export
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => zoomToTrack(track.getId())}>
              <Expand className="mr-2 h-4 w-4" /> Zoom
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => toggleTrackVisibility(track.getId())}>
              {track.isVisible() ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
              {track.isVisible() ? 'Hide' : 'Show'}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => showConfirmDialog(
                track.isPermanentTrack() ? "Delete Saved Track" : "Delete Track",
                `Are you sure you want to delete "${track.getName()}"? This action cannot be undone.`,
                () => {
                  deleteTrack(track.getId())
                  toast.success("Track deleted!")
                },
                "destructive"
              )}
            >
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  )
}
