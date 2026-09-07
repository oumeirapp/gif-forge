#!/usr/bin/env node
'use strict';

const { validateRequest } = require('../lib/helpers.cjs');
const { convertOne } = require('../lib/convert.cjs');

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function readRequestFromStdin() {
  return new Promise((resolve, reject) => {
    let requestText = '';

    process.stdin.setEncoding('utf8');

    function handleData(chunk) {
      requestText += chunk;
      const newlineIndex = requestText.indexOf('\n');
      if (newlineIndex === -1) return;

      process.stdin.off('data', handleData);
      process.stdin.pause();
      resolve(requestText.slice(0, newlineIndex).trim());
    }

    process.stdin.on('data', handleData);
    process.stdin.once('error', reject);
    process.stdin.once('end', () => resolve(requestText.trim()));
    process.stdin.resume();
  });
}

async function main(argv) {
  if (argv[0] !== 'convert') throw new Error("Usage: banner-forge-sidecar convert ['<JSON>']");
  const requestText = argv[1] || await readRequestFromStdin();
  if (!requestText) throw new Error('A JSON request must be provided as an argument or one stdin line.');
  let raw;
  try {
    raw = JSON.parse(requestText);
  } catch (error) {
    throw new Error(`Request is not valid JSON: ${error.message}`);
  }
  const request = validateRequest(raw);
  const summary = { total: request.inputPaths.length, succeeded: 0, failed: 0 };
  for (let index = 0; index < request.inputPaths.length; index += 1) {
    const inputPath = request.inputPaths[index];
    try {
      const converted = await convertOne(inputPath, request.outputDirectory, request.config, (progress) => {
        emit({ type: 'progress', inputPath, index, ...progress });
      });
      summary.succeeded += 1;
      for (const output of converted.outputs) {
        const { report } = output;
        emit({
          type: 'result',
          inputPath,
          outputPath: output.gifPath,
          reportPath: output.reportPath,
          outputType: report.outputType,
          targetBytes: report.delivery?.targetBytes,
          metTarget: report.delivery?.metTarget,
          candidatesTested: report.delivery?.candidatesTested,
          bytes: report.validation.bytes,
          durationMs: report.validation.durationMs,
          requestedFps: report.encoding.requestedFps,
          effectiveFps: report.validation.effectiveFps,
          maxColors: report.encoding.maxColors,
          dithering: report.encoding.selectedCandidate.id,
          ditheringLabel: report.encoding.selectedCandidate.label,
          gifskiQuality: report.encoding.compression.quality,
          compressionLabel: report.encoding.compression.label,
          adjusted: report.warnings.length > 0,
          warnings: report.warnings,
        });
      }
    } catch (error) {
      summary.failed += 1;
      emit({ type: 'error', inputPath, message: error.message });
    }
  }
  emit({ type: 'complete', ...summary });
  if (summary.failed) process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  emit({ type: 'error', message: error.message });
  emit({ type: 'complete', total: 0, succeeded: 0, failed: 1 });
  process.exitCode = 1;
});
