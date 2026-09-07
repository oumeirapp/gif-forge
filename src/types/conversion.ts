export type LoopMode = "auto" | "once" | "infinite"
export type OutputMode = "forge" | "size-limited" | "both"
export type OutputFps = 4 | 12 | 15 | 24
export type PaletteSize = 64 | 128 | 192 | 256
export type DitheringMode = "adaptive" | "none" | "bayer-5" | "bayer-4" | "gradfun-bayer-5"

export interface ConversionConfig {
  outputFps: OutputFps
  maxColors: PaletteSize
  dithering: DitheringMode
  gifskiQuality: number
  maxDurationSeconds: number
  loopMode: LoopMode
  outputMode: OutputMode
  maxBytes: number
}

export interface ConversionFormConfig {
  outputFps: OutputFps
  maxColors: PaletteSize
  dithering: DitheringMode
  gifskiQuality: number
  maxDurationSeconds: number
  loopMode: LoopMode
  outputMode: OutputMode
  maxBytes: number
}

export interface ConversionFormConfigValidity {
  outputFps: boolean
  maxColors: boolean
  gifskiQuality: boolean
  maxDurationSeconds: boolean
  maxBytes: boolean
}

export interface ConversionRequest {
  protocolVersion: 4
  inputPaths: string[]
  outputDirectory: string
  config: ConversionConfig
}

export type JobPhase = "idle" | "running" | "success" | "error" | "cancelled"
export type ProcessStage = "load" | "capture" | "encode" | "validate"

export interface ProgressEvent {
  type: "progress"
  index?: number
  current?: number
  total?: number
  percent?: number
  message?: string
  file?: string
  inputPath?: string
  stage?: string
}

export interface ResultEvent {
  type: "result"
  input?: string
  inputPath?: string
  output?: string
  outputPath?: string
  reportPath?: string
  bytes?: number
  durationMs?: number
  requestedFps?: number
  effectiveFps?: number | null
  maxColors?: number
  dithering?: DitheringMode
  ditheringLabel?: string
  gifskiQuality?: number
  compressionLabel?: string
  outputType?: "forge" | "delivery"
  targetBytes?: number
  metTarget?: boolean
  candidatesTested?: number
  adjusted?: boolean
  warnings?: string[]
  status?: "success" | "warning" | "error"
  warning?: string
  message?: string
}

export interface ErrorEvent {
  type: "error"
  message: string
  file?: string
  inputPath?: string
  code?: string
}

export interface CompleteEvent {
  type: "complete"
  total?: number
  processed?: number
  succeeded?: number
  failed?: number
  elapsedMs?: number
}

export type ProtocolEvent = ProgressEvent | ResultEvent | ErrorEvent | CompleteEvent

export interface JobState {
  phase: JobPhase
  progress: number
  message: string
  currentStage?: ProcessStage
  currentFile?: string
  results: ResultEvent[]
  errors: ErrorEvent[]
  summary?: CompleteEvent
}
