import { Badge } from "@/components/ui/badge"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { Check, Circle, Film, Images, ScanSearch } from "lucide-react"
import { cn } from "@/lib/utils"
import { fileName } from "@/lib/format"
import type { JobPhase, ProcessStage } from "@/types/conversion"

interface FilmRailProps {
  phase: JobPhase
  progress: number
  message: string
  currentStage?: ProcessStage
  currentFile?: string
}

const stages = [
  { key: "load", label: "Load", icon: Film },
  { key: "capture", label: "Capture", icon: Images },
  { key: "encode", label: "Encode", icon: Circle },
  { key: "validate", label: "Validate", icon: ScanSearch },
] satisfies Array<{ key: ProcessStage; label: string; icon: typeof Film }>

function statusLabelForPhase(phase: JobPhase) {
  if (phase === "running") return "Forging"
  if (phase === "success") return "Complete"
  if (phase === "error") return "Needs attention"
  if (phase === "cancelled") return "Cancelled"
  return "Standby"
}

export function FilmRail({ phase, progress, message, currentStage, currentFile }: FilmRailProps) {
  const isDone = phase === "success"
  const statusLabel = statusLabelForPhase(phase)
  const activeStageIndex = stages.findIndex((stage) => stage.key === currentStage)

  return (
    <section className="film-rail" aria-labelledby="process-heading">
      <div className="rail-heading">
        <div>
          <p className="eyebrow">Process rail</p>
          <h2 id="process-heading">{fileName(currentFile)}</h2>
        </div>
        <Badge variant={phase === "error" ? "destructive" : "outline"} className={cn(phase === "running" && "signal-badge", isDone && "rail-success-badge", (phase === "idle" || phase === "cancelled") && "standby-badge")}>
          {isDone ? <Check data-icon="inline-start" /> : <Circle data-icon="inline-start" />}
          {statusLabel}
        </Badge>
      </div>

      <div className="film-strip" aria-label={`Conversion is ${Math.round(progress)} percent complete`}>
        <div className="sprocket-row" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} />)}</div>
        <ol>
          {stages.map(({ key, label, icon: Icon }, index) => {
            const active = phase === "running" && currentStage === key
            const complete = isDone || activeStageIndex > index
            return (
              <li key={label} className={cn(active && "is-active", complete && "is-complete")}>
                <span className="frame-number">0{index + 1}</span>
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </li>
            )
          })}
        </ol>
        <div className="sprocket-row" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} />)}</div>
      </div>

      <Progress value={progress} aria-label="Batch progress">
        <ProgressLabel aria-live="polite">{message}</ProgressLabel>
        <ProgressValue>{(_formattedValue, value) => `${Math.round(value ?? progress)}%`}</ProgressValue>
      </Progress>
    </section>
  )
}
