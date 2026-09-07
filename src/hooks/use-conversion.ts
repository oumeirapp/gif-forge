import { useCallback, useRef, useState } from "react"
import { Command, type Child } from "@tauri-apps/plugin-shell"
import type { ConversionRequest, JobState, ProcessStage, ProtocolEvent } from "@/types/conversion"

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

export function useConversion() {
  const [job, setJob] = useState<JobState>(INITIAL_STATE)
  const childRef = useRef<Child | null>(null)
  const bufferRef = useRef("")
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

  const parseLines = useCallback((chunk: string, flush = false) => {
    bufferRef.current += chunk
    const lines = bufferRef.current.split(/\r?\n/)
    const remainder = lines.pop() ?? ""
    bufferRef.current = flush ? "" : remainder
    if (flush && remainder.trim()) lines.push(remainder)
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as ProtocolEvent
        if (event && typeof event.type === "string") applyEvent(event)
      } catch {
        setJob((current) => ({ ...current, message: line.trim() }))
      }
    }
  }, [applyEvent])

  const run = useCallback(async (request: ConversionRequest) => {
    const runId = activeRunIdRef.current + 1
    activeRunIdRef.current = runId
    cancelledRunIdRef.current = null
    batchSizeRef.current = Math.max(1, request.inputPaths.length)
    setJob({ ...INITIAL_STATE, phase: "running", message: "Starting capture engine" })
    bufferRef.current = ""

    function isCurrentRun() {
      return activeRunIdRef.current === runId && cancelledRunIdRef.current !== runId
    }

    let spawnedChild: Child | null = null

    try {
      const command = Command.sidecar("binaries/banner-forge-sidecar", ["convert"])
      command.stdout.on("data", (line) => {
        if (!isCurrentRun()) return
        parseLines(`${line}\n`)
      })
      command.stderr.on("data", (line) => {
        if (!isCurrentRun() || !line.trim()) return
        setJob((current) => ({ ...current, message: line.trim() }))
      })
      command.on("error", (message) => {
        if (!isCurrentRun()) return
        setJob((current) => ({ ...current, phase: "error", message }))
      })
      command.on("close", ({ code }) => {
        if (childRef.current === spawnedChild) childRef.current = null
        if (!isCurrentRun()) return
        parseLines("", true)
        setJob((current) => current.phase === "running" ? {
          ...current,
          phase: code === 0 ? "success" : "error",
          progress: code === 0 ? 100 : current.progress,
          message: code === 0 ? "Batch complete" : `Engine exited with code ${code ?? "unknown"}`,
        } : current)
      })
      spawnedChild = await command.spawn()

      if (!isCurrentRun()) {
        await spawnedChild.kill()
        return
      }

      childRef.current = spawnedChild
      await spawnedChild.write(`${JSON.stringify(request)}\n`)
    } catch (error) {
      if (!isCurrentRun()) return
      setJob((current) => ({
        ...current,
        phase: "error",
        message: error instanceof Error ? error.message : "Could not start the conversion engine",
      }))
    }
  }, [parseLines])

  const cancel = useCallback(async () => {
    const runId = activeRunIdRef.current
    const child = childRef.current
    cancelledRunIdRef.current = runId
    setJob((current) => ({ ...current, phase: "cancelled", message: "Batch cancelled" }))

    if (!child) return

    try {
      await child.kill()
      if (childRef.current === child) childRef.current = null
    } catch (error) {
      if (activeRunIdRef.current !== runId) return

      if (childRef.current === null) {
        setJob((current) => ({ ...current, phase: "cancelled", message: "Batch cancelled" }))
        return
      }

      cancelledRunIdRef.current = null
      setJob((current) => ({
        ...current,
        phase: "running",
        message: error instanceof Error ? `Could not stop the conversion engine: ${error.message}` : "Could not stop the conversion engine",
      }))
    }
  }, [])

  return { job, run, cancel }
}
