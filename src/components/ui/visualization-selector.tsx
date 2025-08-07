import { Button } from '@/components/ui/button'
import { VisualizationMode } from '@/services/RouteVisualization'
import { Palette, Info, Circle } from 'lucide-react'

interface VisualizationSelectorProps {
  currentMode: VisualizationMode
  onModeChange: (mode: VisualizationMode) => void
  className?: string
}

export function VisualizationSelector({ currentMode, onModeChange, className }: VisualizationSelectorProps) {
  const modes: { mode: VisualizationMode; label: string; icon: React.ReactNode }[] = [
    { mode: 'default', label: 'Track Color', icon: <Circle className="h-4 w-4" /> },
    { mode: 'info', label: 'Track Info', icon: <Info className="h-4 w-4" /> }
  ]

  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {modes.map(({ mode, label, icon }) => (
        <Button
          key={mode}
          variant={currentMode === mode ? 'default' : 'outline'}
          size="sm"
          onClick={() => onModeChange(mode)}
          className="text-xs"
        >
          {icon}
          <span className="ml-1">{label}</span>
        </Button>
      ))}
    </div>
  )
}
