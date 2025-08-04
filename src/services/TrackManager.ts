import { Route } from '@/hooks/useRoutes'
import { WaypointData } from './MarkerManager'

export interface TrackData {
  id: string
  name: string
  waypoints: WaypointData[]
  route: Route
  createdAt: string
  isPermanent: boolean
  color?: string
  isVisible?: boolean
}

export class Track {
  private data: TrackData
  private mapLayerId: string
  private outlineLayerId: string
  private onUpdate: (track: Track) => void
  private onDelete: (id: string) => void

  constructor(
    data: TrackData,
    onUpdate: (track: Track) => void,
    onDelete: (id: string) => void
  ) {
    this.data = { ...data }
    this.mapLayerId = `track-${data.id}`
    this.outlineLayerId = `track-${data.id}-outline`
    this.onUpdate = onUpdate
    this.onDelete = onDelete
    
    // Ensure track has a color
    if (!this.data.color) {
      this.data.color = this.generateColor()
    }
  }

  private generateColor(): string {
    const colors = [
      '#3B82F6', '#EF4444', '#10B981', '#F59E0B',
      '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'
    ]
    const index = Math.abs(this.data.id.split('').reduce((a, b) => a + b.charCodeAt(0), 0))
    return colors[index % colors.length]
  }

  // Getters
  getId(): string { return this.data.id }
  getName(): string { return this.data.name }
  getColor(): string { return this.data.color || this.generateColor() }
  getWaypoints(): WaypointData[] { return [...this.data.waypoints] }
  getRoute(): Route { return this.data.route }
  getCreatedAt(): string { return this.data.createdAt }
  isPermanentTrack(): boolean { return this.data.isPermanent }
  isVisible(): boolean { return this.data.isVisible || false }
  getData(): TrackData { return { ...this.data } }
  getMapLayerId(): string { return this.mapLayerId }
  getOutlineLayerId(): string { return this.outlineLayerId }

  // Setters
  setName(name: string) {
    this.data.name = name
    this.onUpdate(this)
  }

  setColor(color: string) {
    this.data.color = color
    this.onUpdate(this)
  }

  setVisibility(visible: boolean) {
    this.data.isVisible = visible
    this.onUpdate(this)
  }

  makePermanent() {
    this.data.isPermanent = true
    this.onUpdate(this)
  }

  // Actions
  delete() {
    this.onDelete(this.data.id)
  }

  exportAsGPX(): void {
    try {
      if (!this.data.route?.geojson) {
        alert('No route data available for export')
        return
      }
      
      const coordinates = this.data.route.geojson.features?.[0]?.geometry?.coordinates || []
      if (coordinates.length === 0) {
        alert('No coordinates found in route')
        return
      }
      
      const trackPoints = coordinates.map((coord: [number, number]) => 
        `      <trkpt lat="${coord[1]}" lon="${coord[0]}"></trkpt>`
      ).join('\n')
      
      const distance = this.data.route.stats?.distanceMeters 
        ? (this.data.route.stats.distanceMeters / 1000).toFixed(1) + 'km' 
        : 'N/A'
      
      const gpxContent = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ibex Route Planner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${this.data.name}</name>
    <desc>Distance: ${distance}</desc>
  </metadata>
  <trk>
    <name>${this.data.name}</name>
    <trkseg>
${trackPoints}
    </trkseg>
  </trk>
</gpx>`
      
      const blob = new Blob([gpxContent], { type: 'application/gpx+xml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${this.data.name.replace(/\s+/g, '-')}.gpx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Error exporting GPX:', error)
      alert('Error exporting GPX file')
    }
  }

  addToMap(map: any): void {
    if (!map || !this.data.route?.geojson) return

    try {
      // Remove existing layers if they exist
      this.removeFromMap(map)

      // Add source
      map.addSource(this.mapLayerId, {
        type: 'geojson',
        data: this.data.route.geojson
      })

      // Add outline layer
      map.addLayer({
        id: this.outlineLayerId,
        type: 'line',
        source: this.mapLayerId,
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': 'white',
          'line-width': this.data.isPermanent ? 6 : 8,
          'line-opacity': 0.8
        }
      })

      // Add main track layer
      map.addLayer({
        id: this.mapLayerId,
        type: 'line',
        source: this.mapLayerId,
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': this.getColor(),
          'line-width': this.data.isPermanent ? 4 : 6,
          'line-opacity': 0.8
        }
      })

      this.data.isVisible = true
    } catch (error) {
      console.error('Error adding track to map:', error)
    }
  }

  removeFromMap(map: any): void {
    if (!map) return

    // Only log if the track was actually visible/added to the map
    const wasVisible = this.data.isVisible
    if (wasVisible) {
      console.log(`Removing track from map: ${this.mapLayerId}`)
    }

    try {
      let layersRemoved = 0
      
      // Remove layers in reverse order (main layer first, then outline)
      if (map.getLayer(this.mapLayerId)) {
        if (wasVisible) console.log(`Removing main layer: ${this.mapLayerId}`)
        map.removeLayer(this.mapLayerId)
        layersRemoved++
      }
      
      if (map.getLayer(this.outlineLayerId)) {
        if (wasVisible) console.log(`Removing outline layer: ${this.outlineLayerId}`)
        map.removeLayer(this.outlineLayerId)
        layersRemoved++
      }
      
      // Remove source after layers are removed
      if (map.getSource(this.mapLayerId)) {
        if (wasVisible) console.log(`Removing source: ${this.mapLayerId}`)
        map.removeSource(this.mapLayerId)
        layersRemoved++
      }

      this.data.isVisible = false
      
      // Only log success if we actually removed something or if it was visible
      if (wasVisible && layersRemoved > 0) {
        console.log(`Successfully removed track from map: ${this.mapLayerId}`)
      }
    } catch (error) {
      console.error(`Error removing track ${this.mapLayerId} from map:`, error)
      // Even if there's an error, mark as not visible
      this.data.isVisible = false
    }
  }

  updateMapColor(map: any): void {
    if (!map || !this.isVisible()) return

    try {
      if (map.getLayer(this.mapLayerId)) {
        map.setPaintProperty(this.mapLayerId, 'line-color', this.getColor())
      }
    } catch (error) {
      console.error('Error updating track color:', error)
    }
  }
}

export class TrackManager {
  private tracks = new Map<string, Track>()
  private map: any
  private onTracksChange?: (tracks: Track[]) => void

  constructor(map: any, onTracksChange?: (tracks: Track[]) => void) {
    this.map = map
    this.onTracksChange = onTracksChange
  }

  getMap(): any {
    return this.map
  }

  addTrack(trackData: TrackData): Track {
    const track = new Track(
      trackData,
      (updatedTrack) => this.handleTrackUpdate(updatedTrack),
      (id) => this.deleteTrack(id)
    )

    this.tracks.set(trackData.id, track)
    this.notifyChange()
    return track
  }

  deleteTrack(id: string): boolean {
    console.log(`TrackManager: Deleting track ${id}`)
    const track = this.tracks.get(id)
    if (track) {
      track.removeFromMap(this.map)
      this.tracks.delete(id)
      this.notifyChange()
      console.log(`TrackManager: Successfully deleted track ${id}`)
      return true
    }
    console.warn(`TrackManager: Track ${id} not found for deletion`)
    return false
  }

  getTrack(id: string): Track | undefined {
    return this.tracks.get(id)
  }

  getAllTracks(): Track[] {
    return Array.from(this.tracks.values())
  }

  getPermanentTracks(): Track[] {
    return this.getAllTracks().filter(track => track.isPermanentTrack())
  }

  getTemporaryTracks(): Track[] {
    return this.getAllTracks().filter(track => !track.isPermanentTrack())
  }

  getVisibleTracks(): Track[] {
    return this.getAllTracks().filter(track => track.isVisible())
  }

  clearTemporaryTracks(): void {
    const tempTracks = this.getTemporaryTracks()
    tempTracks.forEach(track => {
      track.removeFromMap(this.map)
      this.tracks.delete(track.getId())
    })
    this.notifyChange()
  }

  clearAllTracks(): void {
    this.tracks.forEach(track => track.removeFromMap(this.map))
    this.tracks.clear()
    this.notifyChange()
  }

  toggleTrackVisibility(id: string): boolean {
    const track = this.tracks.get(id)
    if (track) {
      if (track.isVisible()) {
        track.removeFromMap(this.map)
      } else {
        track.addToMap(this.map)
      }
      this.notifyChange()
      return track.isVisible()
    }
    return false
  }

  updateTrackColor(id: string, color: string): void {
    const track = this.tracks.get(id)
    if (track) {
      track.setColor(color)
      track.updateMapColor(this.map)
      this.notifyChange()
    }
  }

  renameTrack(id: string, name: string): void {
    const track = this.tracks.get(id)
    if (track) {
      track.setName(name)
      this.notifyChange()
    }
  }

  makePermanent(id: string): void {
    const track = this.tracks.get(id)
    if (track) {
      track.makePermanent()
      this.notifyChange()
    }
  }

  exportMultipleTracks(trackIds: string[]): void {
    // For now, export each track separately
    // Could be enhanced to create a single multi-track GPX
    trackIds.forEach(id => {
      const track = this.tracks.get(id)
      if (track) {
        track.exportAsGPX()
      }
    })
  }

  private handleTrackUpdate(updatedTrack: Track): void {
    // Track has been updated, notify listeners
    this.notifyChange()
  }

  private notifyChange(): void {
    if (this.onTracksChange) {
      this.onTracksChange(this.getAllTracks())
    }
  }

  // Persistence methods
  saveToLocalStorage(key: string): void {
    const tracksData = this.getAllTracks().map(track => track.getData())
    localStorage.setItem(key, JSON.stringify(tracksData))
  }

  loadFromLocalStorage(key: string): void {
    try {
      const saved = localStorage.getItem(key)
      if (saved) {
        const tracksData: TrackData[] = JSON.parse(saved)
        tracksData.forEach(trackData => {
          // Set all loaded tracks to invisible by default
          const trackWithDefaultVisibility = {
            ...trackData,
            isVisible: false
          }
          this.addTrack(trackWithDefaultVisibility)
        })
      }
    } catch (error) {
      console.error('Error loading tracks from localStorage:', error)
    }
  }
}