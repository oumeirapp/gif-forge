export type LoopMode = "auto" | "once" | "infinite"
export type OutputMode = "forge" | "size-limited" | "both"
export type FrameExportMode = "none" | "png" | "jpeg" | "both"
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
  frameExport: FrameExportMode
  jpegQuality: number
  jpegBackground: string
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
  frameExport: FrameExportMode
  jpegQuality: number
  jpegBackground: string
}

export interface ConversionFormConfigValidity {
  outputFps: boolean
  maxColors: boolean
  gifskiQuality: boolean
  maxDurationSeconds: boolean
  maxBytes: boolean
  jpegQuality: boolean
  jpegBackground: boolean
}

export type UploadKind = "zip" | "folder" | "html"

export interface UploadItem {
  id: string
  name: string
  kind: UploadKind
  files: File[]
  paths: string[]
  bytes: number
}

export type ServerJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export interface JobSnapshot {
  id: string
  status: ServerJobStatus
  banners: string[]
  events: ProtocolEvent[]
  lastEventId: number
  results: ResultEvent[]
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
  fileName?: string
  downloadUrl?: string
  reportFileName?: string
  reportUrl?: string
  bytes?: number
  durationMs?: number
  requestedFps?: number
  effectiveFps?: number | null
  maxColors?: number
  dithering?: DitheringMode
  ditheringLabel?: string
  gifskiQuality?: number
  compressionLabel?: string
  outputType?: "forge" | "delivery" | "png-frames" | "jpeg-frames"
  targetBytes?: number
  metTarget?: boolean
  candidatesTested?: number
  frameCount?: number
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
  cancelled?: boolean
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
