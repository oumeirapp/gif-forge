#!/usr/bin/env node
'use strict';

// Stand-in for sidecar/bin/banner-forge-sidecar.cjs. Behaviour comes from FAKE_ENGINE_MODE:
//   complete (default)  one progress + one result per input, then complete
//   hang                write pids to FAKE_ENGINE_PID_FILE, start a grandchild, never exit
//   crash               exit 3 without a complete event
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const request = JSON.parse(input.trim());
  const mode = process.env.FAKE_ENGINE_MODE || 'complete';
  const delayMs = Number(process.env.FAKE_ENGINE_DELAY_MS || 0);

  if (mode === 'hang') {
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.FAKE_ENGINE_PID_FILE, JSON.stringify({ engine: process.pid, grandchild: grandchild.pid }));
    emit({ type: 'progress', inputPath: request.inputPaths[0], index: 0, stage: 'load' });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'crash') {
    process.stderr.write(`boom in ${request.outputDirectory}\n`);
    process.exit(3);
  }

  for (let index = 0; index < request.inputPaths.length; index += 1) {
    const inputPath = request.inputPaths[index];
    emit({ type: 'progress', inputPath, index, stage: 'capture', current: 1, total: 2 });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const stem = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(request.outputDirectory, `${stem}.gif`);
    const reportPath = path.join(request.outputDirectory, `${stem}.report.json`);
    fs.writeFileSync(outputPath, Buffer.from('GIF89a', 'ascii'));
    fs.writeFileSync(reportPath, '{}');
    emit({ type: 'result', inputPath, outputPath, reportPath, outputType: 'forge', bytes: 6, warnings: [] });
  }
  emit({ type: 'complete', total: request.inputPaths.length, succeeded: request.inputPaths.length, failed: 0 });
});
