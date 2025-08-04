import { Button } from "@/components/ui/button"
import { LocateFixed } from "lucide-react"
import { toast } from "sonner"

interface LocationButtonProps {
  mapRef: React.RefObject<any>
}

export function LocationButton({ mapRef }: LocationButtonProps) {
  const handleLocateUser = () => {
    if (!navigator.geolocation) {
      toast.error("Geolocation is not supported by your browser.")
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords
        if (mapRef.current) {
          mapRef.current.flyTo({
            center: [longitude, latitude],
            zoom: 14,
            essential: true,
          })
          toast.success("Location found!")
        }
      },
      () => {
        toast.error("Unable to retrieve your location. Please check your browser settings.")
      }
    )
  }

  return (
    <Button
      onClick={handleLocateUser}
      size="sm"
      variant="secondary"
      className="shadow-lg"
      title="Locate Me"
    >
      <LocateFixed className="h-4 w-4" />
    </Button>
  )
}
