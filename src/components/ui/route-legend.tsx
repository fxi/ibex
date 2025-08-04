import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ColorMapping, VisualizationMode } from '@/services/RouteVisualization'

interface RouteLegendProps {
  mode: VisualizationMode
  colorMapping: ColorMapping[]
  className?: string
}

export function RouteLegend({ mode, colorMapping, className }: RouteLegendProps) {
  if (mode === 'default' || colorMapping.length === 0) {
    return null
  }

  const getModeTitle = (mode: VisualizationMode): string => {
    switch (mode) {
      case 'infrastructure': return 'Road Infrastructure'
      case 'stress': return 'Traffic Stress Level'
      case 'surface': return 'Surface Quality'
      case 'slope': return 'Slope Gradient'
      case 'distance': return 'Segment Distance'
      default: return 'Route Visualization'
    }
  }

  return (
    <Card className={`w-64 ${className}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{getModeTitle(mode)}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-1">
          {colorMapping.map((item, index) => (
            <div key={index} className="flex items-center gap-2 text-xs">
              <div 
                className="w-3 h-3 rounded-sm border border-gray-300" 
                style={{ backgroundColor: item.color }}
              />
              <span className="text-muted-foreground">{item.label}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}