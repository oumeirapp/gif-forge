import { AlertCircle, CheckCircle2, FileImage, Inbox, TriangleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DITHERING_OPTIONS, findOption } from "@/lib/export-options"
import { fileName, formatBytes, formatDuration } from "@/lib/format"
import type { CompleteEvent, ErrorEvent, JobState, ResultEvent } from "@/types/conversion"

function resultWarningText(result: ResultEvent) {
  const messages = [...(result.warnings ?? [])]

  if (result.warning && !messages.includes(result.warning)) {
    messages.push(result.warning)
  }

  return messages.join(" ")
}

function formatFps(fps?: number | null) {
  if (fps === undefined || fps === null) return "Still image"
  const digits = Number.isInteger(fps) ? 0 : 2
  return `${fps.toFixed(digits)} FPS actual`
}

function resultMetadata(result: ResultEvent) {
  const details = []
  if (result.requestedFps !== undefined) details.push(`${result.requestedFps} FPS requested`)
  details.push(formatFps(result.effectiveFps))
  if (result.maxColors !== undefined) details.push(`up to ${result.maxColors} colors`)
  const ditheringLabel = result.ditheringLabel
    ?? (result.dithering ? findOption(DITHERING_OPTIONS, result.dithering)?.label : undefined)
  const compressionLabel = result.compressionLabel
    ?? (result.gifskiQuality !== undefined ? `Gifski ${result.gifskiQuality}% quality` : undefined)
  if (ditheringLabel) details.push(ditheringLabel)
  if (compressionLabel) details.push(compressionLabel)
  if (result.durationMs !== undefined) details.push(formatDuration(result.durationMs))
  if (result.frameCount !== undefined) details.push(`${result.frameCount} source frames`)
  if (result.targetBytes !== undefined) details.push(`${result.metTarget ? "within" : "over"} ${formatBytes(result.targetBytes)} target`)
  return details.join(" · ")
}

function summaryText(summary: CompleteEvent, readyCount: number, failedCount: number) {
  const generated = summary.succeeded ?? readyCount
  const failed = summary.failed ?? failedCount
  let description = `${generated} generated · ${failed} failed`

  if (typeof summary.elapsedMs === "number") {
    description += ` · ${formatDuration(summary.elapsedMs)}`
  }

  return description
}

function errorSourceName(error: ErrorEvent) {
  const inputPath = error.inputPath ?? error.file

  if (!inputPath) return "Batch request"

  return fileName(inputPath)
}

function ResultStatus({ result }: { result: ResultEvent }) {
  if (result.metTarget === false) {
    return <Badge variant="outline" className="warning-badge"><TriangleAlert data-icon="inline-start" />Over target</Badge>
  }

  if (result.metTarget === true) {
    return <Badge variant="outline" className="success-badge"><CheckCircle2 data-icon="inline-start" />Within target</Badge>
  }

  if (result.adjusted || (result.warnings?.length ?? 0) > 0) {
    return <Badge variant="outline" className="warning-badge"><TriangleAlert data-icon="inline-start" />Adjusted</Badge>
  }

  return <Badge variant="outline" className="success-badge"><CheckCircle2 data-icon="inline-start" />Completed</Badge>
}

export function ResultsPanel({ job }: { job: JobState }) {
  const hasRows = job.results.length > 0 || job.errors.length > 0
  const summary = job.summary
  const latestError = job.errors[job.errors.length - 1]

  return (
    <Card className="results-card">
      <CardHeader>
        <CardTitle>Output ledger</CardTitle>
        <CardDescription>
          {summary ? summaryText(summary, job.results.length, job.errors.length) : "A row appears as each banner finishes."}
        </CardDescription>
      </CardHeader>
      <CardContent className="results-content">
        {job.errors.length > 0 || job.phase === "error" ? (
          <Alert variant="destructive" className="batch-alert">
            <AlertCircle />
            <AlertTitle>{job.errors.length > 1 ? `${job.errors.length} conversion errors` : "Conversion error"}</AlertTitle>
            <AlertDescription>{latestError?.message ?? job.message}</AlertDescription>
          </Alert>
        ) : null}

        {hasRows ? (
          <Table aria-label="Conversion results">
            <TableHeader>
              <TableRow>
                <TableHead>Banner</TableHead>
                <TableHead>Output or issue</TableHead>
                <TableHead>File size</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {job.results.map((result, index) => {
                const warningText = resultWarningText(result)

                return (
                  <TableRow key={`${result.input ?? result.inputPath ?? result.output ?? result.outputPath}-${index}`}>
                    <TableCell><span className="file-cell"><FileImage aria-hidden="true" />{fileName(result.input ?? result.inputPath)}</span></TableCell>
                    <TableCell className="result-detail-cell" title={result.output ?? result.outputPath}>
                      <span className="muted-cell">{fileName(result.output ?? result.outputPath)}</span>
                      <span className="result-type">{
                        result.outputType === "delivery" ? "Delivery optimized"
                          : result.outputType === "png-frames" ? "PNG frame ZIP"
                            : result.outputType === "jpeg-frames" ? "JPEG frame ZIP"
                              : "Forge configured"
                      }</span>
                      <span className="result-metadata">{resultMetadata(result)}</span>
                      {warningText ? <span className="result-warning">{warningText}</span> : null}
                    </TableCell>
                    <TableCell className="numeric-cell">{formatBytes(result.bytes)}</TableCell>
                    <TableCell><ResultStatus result={result} /></TableCell>
                  </TableRow>
                )
              })}
              {job.errors.map((error, index) => (
                <TableRow key={`error-${error.inputPath ?? error.file ?? "batch"}-${index}`}>
                  <TableCell>
                    <span className="file-cell"><AlertCircle aria-hidden="true" />{errorSourceName(error)}</span>
                  </TableCell>
                  <TableCell className="result-error" title={error.message}>{error.message}</TableCell>
                  <TableCell className="numeric-cell">—</TableCell>
                  <TableCell><Badge variant="destructive"><AlertCircle data-icon="inline-start" />Failed</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="empty-ledger" role="status">
            <Inbox aria-hidden="true" />
            <div>
              <h3>No output yet</h3>
              <p>{job.phase === "running" ? "The first GIF will appear after encoding." : "Choose your paths and export settings, then start the batch."}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
