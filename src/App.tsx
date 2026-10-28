import { useState } from "react"
import { AlertCircle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AppHeader } from "@/components/app-header"
import { ConfigPanel } from "@/components/config-panel"
import { FilmRail } from "@/components/film-rail"
import { ResultsPanel } from "@/components/results-panel"
import { RunControls } from "@/components/run-controls"
import { UploadPanel } from "@/components/upload-panel"
import { useConversion } from "@/hooks/use-conversion"
import type { ConversionFormConfig, ConversionFormConfigValidity, UploadItem } from "@/types/conversion"
import "./App.css"

const DEFAULT_CONFIG: ConversionFormConfig = {
  outputFps: 15,
  maxColors: 256,
  dithering: "adaptive",
  gifskiQuality: 80,
  maxDurationSeconds: 30,
  loopMode: "auto",
  outputMode: "both",
  maxBytes: 150_000,
  frameExport: "none",
  jpegQuality: 90,
  jpegBackground: "#ffffff",
}

interface AppProps {
  onSignOut?: () => void
}

function App({ onSignOut }: AppProps) {
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([])
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [uploadError, setUploadError] = useState("")
  const { job, run, cancel } = useConversion()
  const running = job.phase === "running"
  const configValidity: ConversionFormConfigValidity = {
    outputFps: [4, 12, 15, 24].includes(config.outputFps),
    maxColors: [64, 128, 192, 256].includes(config.maxColors),
    gifskiQuality: Number.isInteger(config.gifskiQuality)
      && config.gifskiQuality >= 1
      && config.gifskiQuality <= 100,
    maxDurationSeconds: config.maxDurationSeconds >= 0.1 && config.maxDurationSeconds <= 60,
    maxBytes: Number.isInteger(config.maxBytes) && config.maxBytes >= 1 && config.maxBytes <= 10_000_000,
    jpegQuality: Number.isInteger(config.jpegQuality) && config.jpegQuality >= 1 && config.jpegQuality <= 100,
    jpegBackground: /^#[0-9a-f]{6}$/i.test(config.jpegBackground),
  }
  const validConfig = configValidity.outputFps
    && configValidity.maxColors
    && configValidity.gifskiQuality
    && configValidity.maxDurationSeconds
    && configValidity.maxBytes
    && configValidity.jpegQuality
    && configValidity.jpegBackground
  const ready = uploadItems.length > 0 && validConfig

  let readinessTitle = "Batch ready"
  let readinessDescription = `${uploadItems.length} upload${uploadItems.length === 1 ? "" : "s"} queued`

  if (running) {
    readinessTitle = "Batch in progress"
    readinessDescription = job.message
  } else if (uploadItems.length === 0) {
    readinessTitle = "Banners required"
    readinessDescription = "Add banner ZIPs, HTML files, or folders"
  } else if (!validConfig) {
    readinessTitle = "Settings need attention"
    readinessDescription = "Correct the highlighted conversion settings"
  }

  function startBatch() {
    setUploadError("")
    void run(uploadItems, config)
  }

  return (
    <div className="app-shell">
      <AppHeader onSignOut={onSignOut} />
      <main className="app-main">
        <FilmRail
          phase={job.phase}
          progress={job.progress}
          message={job.message}
          currentStage={job.currentStage}
          currentFile={job.currentFile}
        />

        {uploadError ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Upload problem</AlertTitle>
            <AlertDescription>{uploadError}</AlertDescription>
          </Alert>
        ) : null}

        {!validConfig ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Settings need attention</AlertTitle>
            <AlertDescription>Choose a supported FPS and palette, use a Gifski quality from 1–100, and enter valid duration and delivery-size settings.</AlertDescription>
          </Alert>
        ) : null}

        <div className="workspace-grid">
          <div className="primary-column">
            <UploadPanel
              items={uploadItems}
              disabled={running}
              onItemsChange={setUploadItems}
              onUploadError={setUploadError}
            />
            <ResultsPanel job={job} />
          </div>
          <ConfigPanel config={config} validity={configValidity} disabled={running} onChange={setConfig} />
        </div>
      </main>
      <RunControls
        phase={job.phase}
        ready={ready}
        readinessTitle={readinessTitle}
        readinessDescription={readinessDescription}
        onRun={startBatch}
        onCancel={() => void cancel()}
      />
    </div>
  )
}

export default App
