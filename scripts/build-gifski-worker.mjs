import { execFileSync } from "node:child_process"
import { chmod, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectDirectory = path.resolve(scriptDirectory, "..")
const workerDirectory = path.join(projectDirectory, "gifski-worker")
const sidecarDistributionDirectory = path.join(projectDirectory, "sidecar", "dist")
const tauriBinaryDirectory = path.join(projectDirectory, "src-tauri", "binaries")

function readRustTargetTriple() {
  if (process.env.BANNER_FORGE_RUST_TARGET) return process.env.BANNER_FORGE_RUST_TARGET
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE

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
const distributionPath = path.join(sidecarDistributionDirectory, executableName)
const tauriBinaryName = isWindowsTarget
  ? `gifski-worker-${rustTargetTriple}.exe`
  : `gifski-worker-${rustTargetTriple}`
const tauriBinaryPath = path.join(tauriBinaryDirectory, tauriBinaryName)

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

await mkdir(sidecarDistributionDirectory, { recursive: true })
await mkdir(tauriBinaryDirectory, { recursive: true })
await copyFile(builtWorkerPath, distributionPath)
await copyFile(builtWorkerPath, tauriBinaryPath)

if (!isWindowsTarget) {
  await chmod(distributionPath, 0o755)
  await chmod(tauriBinaryPath, 0o755)
}

process.stdout.write(`Built ${distributionPath}\n`)
process.stdout.write(`Installed ${tauriBinaryPath}\n`)

