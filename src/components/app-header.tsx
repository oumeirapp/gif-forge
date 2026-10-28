import { Aperture, Circle, Code, LogOut } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

// Gifski is AGPL: a network service must offer its source, so keep this link visible.
const SOURCE_URL = import.meta.env.VITE_SOURCE_URL

interface AppHeaderProps {
  onSignOut?: () => void
}

export function AppHeader({ onSignOut }: AppHeaderProps) {
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
      <div className="header-actions">
        {SOURCE_URL ? (
          <a className="source-link" href={SOURCE_URL} target="_blank" rel="noreferrer">
            <Code aria-hidden="true" />
            Source (AGPL)
          </a>
        ) : null}
        <Badge variant="outline" className="engine-badge">
          <Circle data-icon="inline-start" />
          Cloud engine
        </Badge>
        {onSignOut ? (
          <Button type="button" size="sm" variant="ghost" onClick={onSignOut}>
            <LogOut data-icon="inline-start" /> Sign out
          </Button>
        ) : null}
      </div>
    </header>
  )
}
