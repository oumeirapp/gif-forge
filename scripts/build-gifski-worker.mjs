import { execFileSync } from "node:child_process"
import { chmod, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectDirectory = path.resolve(scriptDirectory, "..")
const workerDirectory = path.join(projectDirectory, "gifski-worker")
// The engine CLI lives in sidecar/bin, so a worker installed next to it is found by
// resolveExecutable without configuration. BANNER_FORGE_GIFSKI_WORKER still wins at runtime.
const installDirectory = process.env.BANNER_FORGE_GIFSKI_INSTALL_DIR
  ? path.resolve(process.env.BANNER_FORGE_GIFSKI_INSTALL_DIR)
  : path.join(projectDirectory, "sidecar", "bin")

function readRustTargetTriple() {
  if (process.env.BANNER_FORGE_RUST_TARGET) return process.env.BANNER_FORGE_RUST_TARGET

  const versionDetails = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  const hostLine = versionDetails
    .split(/\r?\n/)
    .find((line) => line.startsWith("host: "))

  if (!hostLine) throw new Error("Could not determine the Rust host target from rustc -vV.")
  return hostLine.slice("host: ".length).trim()
}

const rustTargetTriple = readRustTargetTriple()
const isWindowsTarget = rustTargetTriple.includes("-windows-")
const executableName = isWindowsTarget ? "gifski-worker.exe" : "gifski-worker"
const builtWorkerPath = path.join(workerDirectory, "target", rustTargetTriple, "release", executableName)
const installedPath = path.join(installDirectory, executableName)

execFileSync("cargo", [
  "build",
  "--manifest-path",
  path.join(workerDirectory, "Cargo.toml"),
  "--release",
  "--target",
  rustTargetTriple,
], {
  cwd: projectDirectory,
  stdio: "inherit",
})

await mkdir(installDirectory, { recursive: true })
await copyFile(builtWorkerPath, installedPath)

if (!isWindowsTarget) {
  await chmod(installedPath, 0o755)
}

process.stdout.write(`Installed ${installedPath}\n`)
