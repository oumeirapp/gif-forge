import { useState } from "react"
import { AlertCircle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AppHeader } from "@/components/app-header"
import { ConfigPanel } from "@/components/config-panel"
import { FilmRail } from "@/components/film-rail"
import { PathPanel } from "@/components/path-panel"
import { ResultsPanel } from "@/components/results-panel"
import { RunControls } from "@/components/run-controls"
import { useConversion } from "@/hooks/use-conversion"
import type { ConversionFormConfig, ConversionFormConfigValidity } from "@/types/conversion"
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

function App() {
  const [inputFolders, setInputFolders] = useState<string[]>([])
  const [outputFolder, setOutputFolder] = useState("")
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [dialogError, setDialogError] = useState("")
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
  const ready = inputFolders.length > 0 && Boolean(outputFolder) && validConfig

  let readinessTitle = "Batch ready"
  let readinessDescription = `${inputFolders.length} folder${inputFolders.length === 1 ? "" : "s"} queued`

  if (running) {
    readinessTitle = "Batch in progress"
    readinessDescription = job.message
  } else if (inputFolders.length === 0 && !outputFolder) {
    readinessTitle = "Input and output required"
    readinessDescription = "Choose banner folders and an output folder"
  } else if (inputFolders.length === 0) {
    readinessTitle = "Input folders required"
    readinessDescription = "Choose at least one banner folder"
  } else if (!outputFolder) {
    readinessTitle = "Output folder required"
    readinessDescription = "Choose where finished GIFs should be written"
  } else if (!validConfig) {
    readinessTitle = "Settings need attention"
    readinessDescription = "Correct the highlighted conversion settings"
  }

  function startBatch() {
    setDialogError("")
    void run({
      protocolVersion: 4,
      inputPaths: inputFolders,
      outputDirectory: outputFolder,
      config,
    })
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <FilmRail
          phase={job.phase}
          progress={job.progress}
          message={job.message}
          currentStage={job.currentStage}
          currentFile={job.currentFile}
        />

        {dialogError ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Folder access failed</AlertTitle>
            <AlertDescription>{dialogError}</AlertDescription>
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
            <PathPanel
              inputFolders={inputFolders}
              outputFolder={outputFolder}
              disabled={running}
              onInputsChange={setInputFolders}
              onOutputChange={setOutputFolder}
              onDialogError={setDialogError}
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
