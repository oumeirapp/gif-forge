export function fileName(path?: string) {
  if (!path) return "Waiting for first banner"
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function compactPath(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path
}

export function formatBytes(bytes?: number) {
  if (bytes === undefined) return "—"
  const kilobytes = bytes / 1_000
  const fractionDigits = Number.isInteger(kilobytes) ? 0 : 1

  return `${kilobytes.toFixed(fractionDigits)} KB`
}

export function formatDuration(ms?: number) {
  if (ms === undefined) return "—"
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`
}
