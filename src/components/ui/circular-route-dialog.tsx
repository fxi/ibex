import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'

interface CircularRouteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (distance: number) => void
}

export function CircularRouteDialog({
  open,
  onOpenChange,
  onConfirm,
}: CircularRouteDialogProps) {
  const [distance, setDistance] = useState(50)

  const handleConfirm = () => {
    onConfirm(distance * 1000) // Convert km to meters
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Create Circular Route</AlertDialogTitle>
          <AlertDialogDescription>
            Select the desired length for the circular route. The route will start and end at your first waypoint.
          </AlertDialogDescription>
        </AlertDialogHeader>
        
        <div className="py-4">
          <Label htmlFor="distance-slider">Distance: {distance} km</Label>
          <Slider
            id="distance-slider"
            defaultValue={[50]}
            min={10}
            max={200}
            step={1}
            onValueChange={(value) => setDistance(value[0])}
            className="mt-2"
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>Create Route</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
