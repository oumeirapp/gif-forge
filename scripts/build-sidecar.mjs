import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const sidecarDirectory = path.join(projectDirectory, 'sidecar');
const packageEntry = path.join(sidecarDirectory, 'package.json');
const outputDirectory = path.join(sidecarDirectory, 'dist');
const tauriBinaryDirectory = path.join(projectDirectory, 'src-tauri', 'binaries');

function readRustTargetTriple() {
  if (process.env.BANNER_FORGE_RUST_TARGET) {
    return process.env.BANNER_FORGE_RUST_TARGET;
  }

  if (process.env.TAURI_ENV_TARGET_TRIPLE) {
    return process.env.TAURI_ENV_TARGET_TRIPLE;
  }

  const versionDetails = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const hostLine = versionDetails
    .split(/\r?\n/)
    .find((line) => line.startsWith('host: '));

  if (!hostLine) {
    throw new Error('Could not determine the Rust host target from rustc -vV.');
  }

  return hostLine.slice('host: '.length).trim();
}

function packageTargetForRustTarget(rustTargetTriple) {
  const targetParts = rustTargetTriple.split('-');
  const architecture = targetParts[0];
  const operatingSystem = targetParts[2];

  const packageArchitecture = {
    aarch64: 'arm64',
    x86_64: 'x64',
  }[architecture];
  const packagePlatform = {
    darwin: 'macos',
    linux: 'linux',
    windows: 'win',
  }[operatingSystem];

  if (!packageArchitecture || !packagePlatform) {
    throw new Error(`Unsupported sidecar target: ${rustTargetTriple}`);
  }

  return `node22-${packagePlatform}-${packageArchitecture}`;
}

const rustTargetTriple = readRustTargetTriple();
const requestedTarget = process.env.BANNER_FORGE_PKG_TARGET || packageTargetForRustTarget(rustTargetTriple);
const isWindowsTarget = rustTargetTriple.includes('-windows-');
const binaryName = isWindowsTarget ? 'banner-forge-sidecar.exe' : 'banner-forge-sidecar';
const outputPath = path.join(outputDirectory, binaryName);
const tauriBinaryName = isWindowsTarget
  ? `banner-forge-sidecar-${rustTargetTriple}.exe`
  : `banner-forge-sidecar-${rustTargetTriple}`;
const tauriBinaryPath = path.join(tauriBinaryDirectory, tauriBinaryName);
const sidecarRequire = createRequire(path.join(sidecarDirectory, 'package.json'));
const { exec: pkgExec } = sidecarRequire('@yao-pkg/pkg');

execFileSync(process.execPath, [path.join(scriptDirectory, 'build-gifski-worker.mjs')], {
  cwd: projectDirectory,
  stdio: 'inherit',
  env: {
    ...process.env,
    BANNER_FORGE_RUST_TARGET: rustTargetTriple,
  },
});

await mkdir(outputDirectory, { recursive: true });
const previousDirectory = process.cwd();
try {
  process.chdir(sidecarDirectory);
  await pkgExec([packageEntry, '--target', requestedTarget, '--output', outputPath, '--compress', 'GZip']);
} finally {
  process.chdir(previousDirectory);
}
if (!isWindowsTarget) await chmod(outputPath, 0o755);

await mkdir(tauriBinaryDirectory, { recursive: true });
await copyFile(outputPath, tauriBinaryPath);
if (!isWindowsTarget) await chmod(tauriBinaryPath, 0o755);

process.stdout.write(`Built ${outputPath}\n`);
process.stdout.write(`Installed ${tauriBinaryPath}\n`);
