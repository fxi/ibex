import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ColorMapping } from '@/services/RouteVisualization';

interface RouteLegendProps {
  colorMapping: ColorMapping[];
  className?: string;
}

export function RouteLegend({ colorMapping, className }: RouteLegendProps) {
  if (colorMapping.length === 0) {
    return null;
  }

  return (
    <Card className={`w-64 ${className}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Surface Quality</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-1">
          {colorMapping.map((item, index) => (
            <div key={index} className="flex items-center gap-2 text-xs">
              <div className="w-8 h-4 flex items-center">
                <div
                  className="w-full h-0.5"
                  style={{
                    backgroundColor: item.color,
                    borderStyle: item.lineStyle || 'solid',
                    borderWidth: '1px 0 0 0',
                    borderColor: item.color,
                  }}
                />
              </div>
              <span className="text-muted-foreground">{item.label}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
