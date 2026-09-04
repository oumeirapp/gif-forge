import { Badge } from "@/components/ui/badge"
import { Aperture, Circle } from "lucide-react"

export function AppHeader() {
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <Aperture />
        </div>
        <div>
          <h1>Fallback Forge</h1>
          <p>HTML5 banner fallback production</p>
        </div>
      </div>
      <Badge variant="outline" className="engine-badge">
        <Circle data-icon="inline-start" />
        Local engine
      </Badge>
    </header>
  )
}
