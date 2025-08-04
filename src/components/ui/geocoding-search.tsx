import { useState, useCallback } from 'react'
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Search, MapPin, ZoomIn, Focus } from "lucide-react"
import { geocoding } from '@/services/geocoding'
import { toast } from "sonner"

interface GeocodingSearchProps {
  mapRef: React.RefObject<any>
  addWaypoint: (lng: number, lat: number) => void
}

export function GeocodingSearch({ mapRef, addWaypoint }: GeocodingSearchProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [results, setResults] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const handleSearch = useCallback(async () => {
    if (searchTerm.trim().length < 3) {
      setResults([])
      return
    }
    setIsLoading(true)
    try {
      const center = mapRef.current?.getCenter()
      const response = await geocoding.forward(searchTerm, {
        limit: 5,
        proximity: center ? [center.lng, center.lat] : undefined,
      })
      setResults(response.features)
    } catch (error) {
      console.error("Geocoding error:", error)
      toast.error("Failed to fetch locations.")
    } finally {
      setIsLoading(false)
    }
  }, [searchTerm, mapRef])

  const handleAddMarker = (feature: any) => {
    const [lng, lat] = feature.center
    addWaypoint(lng, lat)
    toast.success(`Marker added for ${feature.text}`)
    setIsOpen(false)
  }

  const handleZoomTo = (feature: any) => {
    if (mapRef.current && feature.bbox) {
      mapRef.current.fitBounds(feature.bbox, {
        padding: 40,
        duration: 1000,
      })
      setIsOpen(false)
    }
  }

  const handleCenterOn = (feature: any) => {
    if (mapRef.current) {
      mapRef.current.flyTo({
        center: feature.center,
        zoom: 14,
      })
      setIsOpen(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" className="shadow-lg" title="Search Places">
          <Search className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Search for a location</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="e.g., Paris, France"
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          <Button onClick={handleSearch} disabled={isLoading}>
            {isLoading ? "..." : <Search className="h-4 w-4" />}
          </Button>
        </div>
        <div className="mt-4 space-y-2">
          {results.map((feature) => (
            <div key={feature.id} className="p-2 border rounded-md">
              <p className="font-semibold">{feature.text}</p>
              <p className="text-sm text-muted-foreground">{feature.place_name}</p>
              <div className="flex gap-2 mt-2">
                <Button size="sm" variant="outline" onClick={() => handleAddMarker(feature)} title="Add Marker">
                  <MapPin className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleZoomTo(feature)} title="Zoom To">
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleCenterOn(feature)} title="Center On">
                  <Focus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
