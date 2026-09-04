import { open } from "@tauri-apps/plugin-dialog"
import { FolderInput, FolderOutput, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { compactPath } from "@/lib/format"

interface PathPanelProps {
  inputFolders: string[]
  outputFolder: string
  disabled: boolean
  onInputsChange: (paths: string[]) => void
  onOutputChange: (path: string) => void
  onDialogError: (message: string) => void
}

export function PathPanel({
  inputFolders,
  outputFolder,
  disabled,
  onInputsChange,
  onOutputChange,
  onDialogError,
}: PathPanelProps) {
  async function pickInputs() {
    onDialogError("")

    try {
      const selection = await open({ directory: true, multiple: true, title: "Choose banner folders" })
      if (!selection) return
      const paths = Array.isArray(selection) ? selection : [selection]
      onInputsChange([...new Set([...inputFolders, ...paths])])
    } catch (error) {
      onDialogError(error instanceof Error ? error.message : "Could not open the folder picker")
    }
  }

  async function pickOutput() {
    onDialogError("")

    try {
      const selection = await open({ directory: true, multiple: false, title: "Choose GIF output folder" })
      if (typeof selection === "string") onOutputChange(selection)
    } catch (error) {
      onDialogError(error instanceof Error ? error.message : "Could not open the folder picker")
    }
  }

  return (
    <Card className="path-card">
      <CardHeader>
        <CardTitle>Batch paths</CardTitle>
        <CardDescription>One banner project per input folder.</CardDescription>
      </CardHeader>
      <CardContent className="path-content">
        <section aria-labelledby="input-folders-label" className="path-section">
          <div className="section-line">
            <div>
              <h2 id="input-folders-label">Input folders</h2>
              <p>{inputFolders.length ? `${inputFolders.length} queued` : "No folders selected"}</p>
            </div>
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={pickInputs}>
              <Plus data-icon="inline-start" /> Add folders
            </Button>
          </div>
          {inputFolders.length ? (
            <ul className="path-list" aria-label="Selected input folders">
              {inputFolders.map((path) => (
                <li key={path}>
                  <FolderInput aria-hidden="true" />
                  <span title={path}>{compactPath(path)}</span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${path}`}
                    disabled={disabled}
                    onClick={() => onInputsChange(inputFolders.filter((item) => item !== path))}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <button className="path-dropzone" type="button" disabled={disabled} onClick={pickInputs}>
              <FolderInput aria-hidden="true" />
              <span>Select one or more banner folders</span>
              <small>Each folder should contain an HTML entry point.</small>
            </button>
          )}
        </section>

        <section aria-labelledby="output-folder-label" className="path-section output-section">
          <div>
            <h2 id="output-folder-label">Output folder</h2>
            <p>Finished GIFs are written here.</p>
          </div>
          <Button type="button" variant="outline" disabled={disabled} onClick={pickOutput} className="output-picker">
            <FolderOutput data-icon="inline-start" />
            <span title={outputFolder}>{outputFolder ? compactPath(outputFolder) : "Choose output folder"}</span>
          </Button>
        </section>
      </CardContent>
    </Card>
  )
}
