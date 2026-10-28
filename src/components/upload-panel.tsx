import { useRef, useState, type DragEvent } from "react"
import { FileArchive, FileCode, FolderInput, FolderPlus, Plus, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { formatBytes } from "@/lib/format"
import type { UploadItem, UploadKind } from "@/types/conversion"

interface UploadPanelProps {
  items: UploadItem[]
  disabled: boolean
  onItemsChange: (items: UploadItem[]) => void
  onUploadError: (message: string) => void
}

const ITEM_ICONS: Record<UploadKind, typeof FolderInput> = {
  folder: FolderInput,
  zip: FileArchive,
  html: FileCode,
}

function fileKind(name: string): UploadKind | null {
  const lower = name.toLowerCase()
  if (lower.endsWith(".zip")) return "zip"
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html"
  return null
}

function singleFileItem(file: File): UploadItem | null {
  const kind = fileKind(file.name)
  if (!kind) return null
  return {
    id: `${kind}:${file.name}:${file.size}:${file.lastModified}`,
    name: file.name,
    kind,
    files: [file],
    paths: [file.name],
    bytes: file.size,
  }
}

// Groups files by the first segment of their relative path: one item per top-level folder.
function folderItems(entries: { file: File, path: string }[]) {
  const groups = new Map<string, UploadItem>()
  for (const { file, path } of entries) {
    const [topLevel] = path.split("/")
    if (!topLevel || topLevel === path) continue
    const item = groups.get(topLevel) ?? {
      id: `folder:${topLevel}`,
      name: topLevel,
      kind: "folder" as const,
      files: [],
      paths: [],
      bytes: 0,
    }
    item.files.push(file)
    item.paths.push(path)
    item.bytes += file.size
    groups.set(topLevel, item)
  }
  return [...groups.values()]
}

function readEntries(directory: FileSystemDirectoryEntry) {
  const reader = directory.createReader()
  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    const all: FileSystemEntry[] = []
    function readBatch() {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        readBatch()
      }, reject)
    }
    readBatch()
  })
}

async function collectDirectory(entry: FileSystemEntry, prefix: string): Promise<{ file: File, path: string }[]> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    return [{ file, path }]
  }
  const children = await readEntries(entry as FileSystemDirectoryEntry)
  const nested = await Promise.all(children.map((child) => collectDirectory(child, path)))
  return nested.flat()
}

function itemSummary(item: UploadItem) {
  if (item.kind === "folder") return `${item.files.length} file${item.files.length === 1 ? "" : "s"} · ${formatBytes(item.bytes)}`
  return formatBytes(item.bytes)
}

export function UploadPanel({ items, disabled, onItemsChange, onUploadError }: UploadPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function addItems(added: UploadItem[], rejected: string[] = []) {
    onUploadError(rejected.length ? `Skipped unsupported files: ${rejected.join(", ")}. Add ZIP files, HTML files, or folders.` : "")
    if (!added.length) return
    const byId = new Map(items.map((item) => [item.id, item]))
    for (const item of added) byId.set(item.id, item)
    onItemsChange([...byId.values()])
  }

  function addFiles(files: File[]) {
    const added: UploadItem[] = []
    const rejected: string[] = []
    for (const file of files) {
      const item = singleFileItem(file)
      if (item) added.push(item)
      else rejected.push(file.name)
    }
    addItems(added, rejected)
  }

  function addFolderFiles(files: File[]) {
    addItems(folderItems(files.map((file) => ({ file, path: file.webkitRelativePath || file.name }))))
  }

  async function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDragging(false)
    if (disabled) return

    const entries = [...event.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => Boolean(entry))
    try {
      const looseFiles: File[] = []
      const folderFiles: { file: File, path: string }[] = []
      for (const entry of entries) {
        if (entry.isDirectory) folderFiles.push(...await collectDirectory(entry, ""))
        else looseFiles.push(...(await collectDirectory(entry, "")).map(({ file }) => file))
      }
      const added: UploadItem[] = folderItems(folderFiles)
      const rejected: string[] = []
      for (const file of looseFiles) {
        const item = singleFileItem(file)
        if (item) added.push(item)
        else rejected.push(file.name)
      }
      addItems(added, rejected)
    } catch (error) {
      onUploadError(error instanceof Error ? error.message : "Could not read the dropped files")
    }
  }

  const dropHandlers = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      event.preventDefault()
      if (!disabled) setDragging(true)
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event: DragEvent<HTMLElement>) => void handleDrop(event),
  }

  return (
    <Card className="path-card">
      <CardHeader>
        <CardTitle>Banner uploads</CardTitle>
        <CardDescription>ZIPs, HTML files, or folders. Each folder or ZIP with an index.html is one banner.</CardDescription>
      </CardHeader>
      <CardContent className="path-content">
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,.html,.htm"
          multiple
          hidden
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])])
            event.target.value = ""
          }}
        />
        <input
          ref={(element) => {
            folderInputRef.current = element
            element?.setAttribute("webkitdirectory", "")
          }}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            addFolderFiles([...(event.target.files ?? [])])
            event.target.value = ""
          }}
        />
        <section aria-labelledby="upload-items-label" className="path-section" {...dropHandlers}>
          <div className="section-line">
            <div>
              <h2 id="upload-items-label">Queued banners</h2>
              <p>{items.length ? `${items.length} queued` : "Nothing added yet"}</p>
            </div>
            <div className="upload-actions">
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => fileInputRef.current?.click()}>
                <Plus data-icon="inline-start" /> Add ZIPs
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => folderInputRef.current?.click()}>
                <FolderPlus data-icon="inline-start" /> Add folders
              </Button>
            </div>
          </div>
          {items.length ? (
            <ul className="path-list" aria-label="Queued uploads" data-dragging={dragging || undefined}>
              {items.map((item) => {
                const Icon = ITEM_ICONS[item.kind]
                return (
                  <li key={item.id}>
                    <Icon aria-hidden="true" />
                    <span title={item.name}>{item.name}</span>
                    <small className="upload-meta">{itemSummary(item)}</small>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove ${item.name}`}
                      disabled={disabled}
                      onClick={() => onItemsChange(items.filter((candidate) => candidate.id !== item.id))}
                    >
                      <X />
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <button
              className="path-dropzone"
              type="button"
              disabled={disabled}
              data-dragging={dragging || undefined}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload aria-hidden="true" />
              <span>Drop banner ZIPs or folders here</span>
              <small>Or use the buttons above. Each banner needs an index.html.</small>
            </button>
          )}
        </section>
      </CardContent>
    </Card>
  )
}
