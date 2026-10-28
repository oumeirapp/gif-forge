import { useCallback, useEffect, useRef, useState } from "react"
import type {
  ConversionConfig,
  JobPhase,
  JobSnapshot,
  JobState,
  ProcessStage,
  ProtocolEvent,
  ServerJobStatus,
  UploadItem,
} from "@/types/conversion"

const INITIAL_STATE: JobState = {
  phase: "idle",
  progress: 0,
  message: "Ready to forge",
  results: [],
  errors: [],
}

const STAGE_MESSAGES: Record<string, string> = {
  load: "Loading banner package",
  capture: "Capturing animation frames",
  coalesce: "Removing duplicate frames",
  frames: "Packaging animation frames",
  encode: "Encoding and applying Gifski",
  optimize: "Searching delivery-size candidates",
  analyze: "Comparing dithering variants",
  validate: "Validating GIF output",
}

function clampProgress(value: number) {
  return Math.min(100, Math.max(0, value))
}

function eventRatio(event: Extract<ProtocolEvent, { type: "progress" }>) {
  if (typeof event.percent === "number") {
    return clampProgress(event.percent) / 100
  }

  if (event.current !== undefined && event.total) {
    return clampProgress((event.current / event.total) * 100) / 100
  }

  return 0
}

function itemProgressValue(event: Extract<ProtocolEvent, { type: "progress" }>) {
  const ratio = eventRatio(event)

  if (event.stage === "load") return 2
  if (event.stage === "capture") return 10 + ratio * 35
  if (event.stage === "coalesce") return 50
  if (event.stage === "frames") return 50 + ratio * 8
  if (event.stage === "encode") return 50 + ratio * 22
  if (event.stage === "optimize") return 50 + ratio * 45
  if (event.stage === "analyze") return 72 + ratio * 13
  if (event.stage === "validate") return 95 + ratio * 5

  return ratio * 100
}

function batchProgressValue(
  event: Extract<ProtocolEvent, { type: "progress" }>,
  batchSize: number,
) {
  const itemProgress = itemProgressValue(event) / 100
  const itemIndex = Math.min(batchSize - 1, Math.max(0, event.index ?? 0))
  const completedItems = itemIndex + itemProgress

  return clampProgress((completedItems / batchSize) * 100)
}

function normalizeStage(stage?: string): ProcessStage | undefined {
  if (stage === "load") return "load"
  if (stage === "capture" || stage === "coalesce") return "capture"
  if (stage === "encode" || stage === "analyze" || stage === "optimize") return "encode"
  if (stage === "validate") return "validate"

  return undefined
}

const JOB_STORAGE_KEY = "fallback-forge:job-id"

const TERMINAL_PHASES: Partial<Record<ServerJobStatus, JobPhase>> = {
  succeeded: "success",
  failed: "error",
  cancelled: "cancelled",
}

function readStoredJobId() {
  try {
    return sessionStorage.getItem(JOB_STORAGE_KEY)
  } catch {
    return null
  }
}

function storeJobId(jobId: string | null) {
  try {
    if (jobId) sessionStorage.setItem(JOB_STORAGE_KEY, jobId)
    else sessionStorage.removeItem(JOB_STORAGE_KEY)
  } catch {
    // Reattaching after a refresh is a convenience; the batch still runs without it.
  }
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: string }
    return body.error ?? fallback
  } catch {
    return fallback
  }
}

function uploadJob(
  form: FormData,
  onProgress: (percent: number) => void,
  onRequest: (request: XMLHttpRequest) => void,
) {
  return new Promise<{ jobId: string, banners?: string[] }>((resolve, reject) => {
    const request = new XMLHttpRequest()
    onRequest(request)
    request.open("POST", "/api/jobs")
    request.responseType = "json"
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    request.onload = () => {
      const body = request.response as { jobId?: string, banners?: string[], error?: string } | null
      if (request.status === 202 && body?.jobId) resolve({ jobId: body.jobId, banners: body.banners })
      else reject(new Error(body?.error ?? `Upload failed with status ${request.status}`))
    }
    request.onerror = () => reject(new Error("Upload failed. Check your connection and try again."))
    request.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"))
    request.send(form)
  })
}

export function useConversion() {
  const [job, setJob] = useState<JobState>(INITIAL_STATE)
  const uploadRef = useRef<XMLHttpRequest | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const jobIdRef = useRef<string | null>(null)
  const lastEventIdRef = useRef(0)
  const batchSizeRef = useRef(1)
  const activeRunIdRef = useRef(0)
  const cancelledRunIdRef = useRef<number | null>(null)

  const applyEvent = useCallback((event: ProtocolEvent) => {
    setJob((current) => {
      if (event.type === "progress") return {
        ...current,
        progress: batchProgressValue(event, batchSizeRef.current),
        message: event.message ?? STAGE_MESSAGES[event.stage ?? ""] ?? "Processing banner",
        currentStage: normalizeStage(event.stage) ?? current.currentStage,
        currentFile: event.file ?? event.inputPath ?? current.currentFile,
      }
      if (event.type === "result") return {
        ...current,
        results: [...current.results, event],
      }
      if (event.type === "error") return {
        ...current,
        message: event.message,
        currentFile: event.file ?? event.inputPath ?? current.currentFile,
        errors: [...current.errors, event],
      }
      return {
        ...current,
        phase: (event.failed ?? 0) > 0 ? "error" : "success",
        progress: 100,
        message: (event.failed ?? 0) > 0 ? "Batch completed with errors" : "Batch complete",
        summary: event,
      }
    })
  }, [])

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }, [])

  const forgetJob = useCallback(() => {
    jobIdRef.current = null
    storeJobId(null)
  }, [])

  const isCurrentRun = useCallback((runId: number) => (
    activeRunIdRef.current === runId && cancelledRunIdRef.current !== runId
  ), [])

  const loadSnapshot = useCallback(async (jobId: string) => {
    const response = await fetch(`/api/jobs/${jobId}`)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(await responseError(response, `Could not load the batch (status ${response.status})`))
    return await response.json() as JobSnapshot
  }, [])

  // The stream closes itself after `complete`; if the server ends it any other way,
  // the snapshot tells us whether the job finished, vanished, or should be resumed.
  const recoverStream = useCallback(async (jobId: string, runId: number) => {
    try {
      const snapshot = await loadSnapshot(jobId)
      if (!isCurrentRun(runId)) return
      if (!snapshot) {
        forgetJob()
        setJob((current) => ({ ...current, phase: "error", message: "The batch is no longer available on the server" }))
        return
      }
      for (const event of snapshot.events.slice(lastEventIdRef.current)) applyEvent(event)
      lastEventIdRef.current = snapshot.lastEventId
      const terminalPhase = TERMINAL_PHASES[snapshot.status]
      if (terminalPhase) {
        forgetJob()
        setJob((current) => ({ ...current, phase: terminalPhase }))
      }
    } catch (error) {
      if (!isCurrentRun(runId)) return
      setJob((current) => ({
        ...current,
        phase: "error",
        message: error instanceof Error ? error.message : "Lost contact with the conversion server",
      }))
    }
  }, [applyEvent, forgetJob, isCurrentRun, loadSnapshot])

  const openStream = useCallback((jobId: string, runId: number) => {
    closeStream()
    const source = new EventSource(`/api/jobs/${jobId}/events?lastEventId=${lastEventIdRef.current}`)
    eventSourceRef.current = source
    source.onmessage = (message) => {
      if (!isCurrentRun(runId)) {
        source.close()
        return
      }
      const id = Number(message.lastEventId)
      if (Number.isFinite(id) && id > 0) {
        if (id <= lastEventIdRef.current) return
        lastEventIdRef.current = id
      }
      try {
        const event = JSON.parse(message.data) as ProtocolEvent
        if (!event || typeof event.type !== "string") return
        applyEvent(event)
        if (event.type === "complete") {
          source.close()
          if (eventSourceRef.current === source) eventSourceRef.current = null
          forgetJob()
        }
      } catch {
        setJob((current) => ({ ...current, message: String(message.data).trim() }))
      }
    }
    source.onerror = () => {
      // EventSource retries on its own while CONNECTING; CLOSED means it gave up.
      if (source.readyState !== EventSource.CLOSED || eventSourceRef.current !== source) return
      eventSourceRef.current = null
      if (isCurrentRun(runId)) void recoverStream(jobId, runId)
    }
  }, [applyEvent, closeStream, forgetJob, isCurrentRun, recoverStream])

  const run = useCallback(async (items: UploadItem[], config: ConversionConfig) => {
    const runId = activeRunIdRef.current + 1
    activeRunIdRef.current = runId
    cancelledRunIdRef.current = null
    closeStream()
    forgetJob()
    lastEventIdRef.current = 0
    batchSizeRef.current = Math.max(1, items.length)
    setJob({ ...INITIAL_STATE, phase: "running", message: "Uploading… 0%" })

    const form = new FormData()
    form.append("config", JSON.stringify(config))
    for (const item of items) {
      item.files.forEach((file, index) => {
        form.append("paths", item.paths[index] ?? file.name)
        form.append("files", file, file.name)
      })
    }

    try {
      const { jobId, banners } = await uploadJob(
        form,
        (percent) => {
          if (!isCurrentRun(runId)) return
          setJob((current) => ({ ...current, message: `Uploading… ${percent}%` }))
        },
        (request) => { uploadRef.current = request },
      )
      uploadRef.current = null

      if (!isCurrentRun(runId)) {
        void fetch(`/api/jobs/${jobId}`, { method: "DELETE" })
        return
      }

      jobIdRef.current = jobId
      storeJobId(jobId)
      if (banners?.length) batchSizeRef.current = banners.length
      setJob((current) => ({ ...current, message: "Waiting for the capture engine" }))
      openStream(jobId, runId)
    } catch (error) {
      uploadRef.current = null
      if (!isCurrentRun(runId)) return
      setJob((current) => ({
        ...current,
        phase: "error",
        message: error instanceof Error ? error.message : "Could not upload the batch",
      }))
    }
  }, [closeStream, forgetJob, isCurrentRun, openStream])

  const cancel = useCallback(async () => {
    const runId = activeRunIdRef.current
    const jobId = jobIdRef.current
    cancelledRunIdRef.current = runId
    setJob((current) => ({ ...current, phase: "cancelled", message: "Batch cancelled" }))

    uploadRef.current?.abort()
    uploadRef.current = null
    closeStream()
    if (!jobId) return

    try {
      const response = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" })
      if (!response.ok && response.status !== 404) {
        throw new Error(await responseError(response, `status ${response.status}`))
      }
      if (jobIdRef.current === jobId) forgetJob()
    } catch (error) {
      if (activeRunIdRef.current !== runId) return

      cancelledRunIdRef.current = null
      setJob((current) => ({
        ...current,
        phase: "running",
        message: error instanceof Error ? `Could not stop the conversion engine: ${error.message}` : "Could not stop the conversion engine",
      }))
      openStream(jobId, runId)
    }
  }, [closeStream, forgetJob, openStream])

  // After a page refresh, pick the stored batch back up from its snapshot and resume streaming.
  useEffect(() => {
    const runId = activeRunIdRef.current + 1
    activeRunIdRef.current = runId
    const jobId = readStoredJobId()

    if (jobId) {
      void (async () => {
        try {
          const snapshot = await loadSnapshot(jobId)
          if (!isCurrentRun(runId)) return
          if (!snapshot) {
            storeJobId(null)
            return
          }
          jobIdRef.current = jobId
          batchSizeRef.current = Math.max(1, snapshot.banners.length)
          lastEventIdRef.current = snapshot.lastEventId
          setJob({ ...INITIAL_STATE, phase: "running", message: "Reconnecting to batch" })
          for (const event of snapshot.events) applyEvent(event)
          const terminalPhase = TERMINAL_PHASES[snapshot.status]
          if (terminalPhase) {
            forgetJob()
            setJob((current) => ({ ...current, phase: terminalPhase }))
            return
          }
          openStream(jobId, runId)
        } catch {
          if (isCurrentRun(runId)) storeJobId(null)
        }
      })()
    }

    return () => {
      activeRunIdRef.current += 1
      closeStream()
    }
  }, [applyEvent, closeStream, forgetJob, isCurrentRun, loadSnapshot, openStream])

  return { job, run, cancel }
}
