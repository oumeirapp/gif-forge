'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function runtimeRustTargetTriple() {
  const architecture = {
    arm64: 'aarch64',
    x64: 'x86_64',
  }[process.arch];
  const platform = {
    darwin: 'apple-darwin',
    linux: 'unknown-linux-gnu',
    win32: 'pc-windows-msvc',
  }[process.platform];

  if (!architecture || !platform) return null;
  return `${architecture}-${platform}`;
}

function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function packagedSiblingCandidates(name) {
  const executable = executableName(name);
  const targetTriple = runtimeRustTargetTriple();
  const targetExecutable = targetTriple
    ? executableName(`${name}-${targetTriple}`)
    : null;
  const directories = [...new Set([path.dirname(process.execPath), path.dirname(require.main?.filename || ''), process.cwd()])];
  return directories.flatMap((directory) => {
    const candidates = [
      path.join(directory, executable),
      path.join(directory, 'bin', executable),
      path.join(directory, 'dist', executable),
      path.join(directory, 'resources', 'bin', executable),
    ];

    if (targetExecutable) {
      candidates.push(path.join(directory, targetExecutable));
      candidates.push(path.join(directory, 'src-tauri', 'binaries', targetExecutable));
    }

    return candidates;
  });
}

function commonAbsoluteCandidates(name) {
  const executable = executableName(name);
  if (process.platform === 'win32') {
    return [
      path.join(process.env.ProgramFiles || '', name, executable),
      path.join(process.env['ProgramFiles(x86)'] || '', name, executable),
      path.join(process.env.LOCALAPPDATA || '', name, executable),
    ];
  }
  return [`/opt/homebrew/bin/${executable}`, `/usr/local/bin/${executable}`, `/usr/bin/${executable}`, `/bin/${executable}`];
}

function findExecutableOnPath(names) {
  const searchPath = process.env.PATH;
  if (!searchPath) return null;

  for (const directory of searchPath.split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }

  return null;
}

function resolveExecutable(name, environmentNames = []) {
  for (const environmentName of environmentNames) {
    if (isExecutable(process.env[environmentName])) return process.env[environmentName];
  }
  for (const candidate of packagedSiblingCandidates(name)) {
    if (isExecutable(candidate)) return candidate;
  }
  for (const candidate of commonAbsoluteCandidates(name)) {
    if (isExecutable(candidate)) return candidate;
  }
  return executableName(name);
}

function resolveChromiumExecutable() {
  for (const key of ['BANNER_FORGE_CHROMIUM', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', 'CHROME_PATH']) {
    if (isExecutable(process.env[key])) return process.env[key];
  }
  const names = process.platform === 'win32' ? ['chromium.exe', 'chrome.exe'] : ['chromium', 'chrome', 'google-chrome'];
  for (const name of names) {
    for (const candidate of packagedSiblingCandidates(name)) if (isExecutable(candidate)) return candidate;
  }
  const system = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : process.platform === 'win32' ? [
    path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const systemExecutable = system.find(isExecutable);
  if (systemExecutable) return systemExecutable;
  return findExecutableOnPath(names);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`Unable to start ${command}: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function toolAvailable(command) {
  try {
    await run(command, ['--version']);
    return true;
  } catch {
    try {
      await run(command, ['-version']);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { isExecutable, findExecutableOnPath, resolveExecutable, resolveChromiumExecutable, run, toolAvailable };
