import { Play, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { JobPhase } from "@/types/conversion"

interface RunControlsProps {
  phase: JobPhase
  ready: boolean
  readinessTitle: string
  readinessDescription: string
  onRun: () => void
  onCancel: () => void
}

export function RunControls({
  phase,
  ready,
  readinessTitle,
  readinessDescription,
  onRun,
  onCancel,
}: RunControlsProps) {
  const running = phase === "running"
  return (
    <footer className="run-controls">
      <div className="batch-readiness">
        <span className="readiness-dot" aria-hidden="true" />
        <div>
          <strong>{readinessTitle}</strong>
          <span>{readinessDescription}</span>
        </div>
      </div>
      <Separator orientation="vertical" className="control-separator" />
      {running ? (
        <Button type="button" variant="destructive" size="lg" onClick={onCancel}>
          <Square data-icon="inline-start" /> Cancel batch
        </Button>
      ) : (
        <Button type="button" size="lg" disabled={!ready} onClick={onRun}>
          <Play data-icon="inline-start" /> Forge GIFs
        </Button>
      )}
    </footer>
  )
}
