# Development guide

This guide explains where the main pieces of Fallback Forge live and how a conversion moves through the application.

## Repository map

```text
src/                    React + TypeScript desktop UI
  App.tsx               Application state and layout
  hooks/                Sidecar process lifecycle and NDJSON parsing
  components/           Panels, controls, and shared UI primitives
  types/                Frontend request, result, and job-state types
sidecar/                Node conversion engine
  bin/                  CLI entry point and protocol handling
  lib/capture.cjs       Chromium launch, asset readiness, timeline discovery
  lib/encode.cjs        FFmpeg palette/dither candidates and Gifski pass
  lib/convert.cjs       Per-input orchestration and report creation
  lib/gif.cjs           Output inspection and validation
  lib/server.cjs        Ephemeral loopback file server
  test/                 Node unit and integration-style tests
gifski-worker/          Rust wrapper around the bundled Gifski encoder
src-tauri/              Tauri configuration, permissions, and native entry point
scripts/                Cross-platform sidecar and worker build scripts
```

## Runtime flow

1. The user chooses one or more package folders and an output folder in the React UI.
2. `useConversion` starts the Tauri sidecar with the fixed `convert` command and writes one JSON request line to stdin.
3. The sidecar validates protocol version 4 and normalizes conversion settings.
4. Each input is processed independently. A directory resolves to `index.html`; a direct `.html` or `.htm` path is also accepted.
5. The sidecar serves the input directory from an ephemeral `127.0.0.1` HTTP server and opens the entry page in a separate headless Chromium process.
6. Capture waits for page assets and discovers dimensions and animation timing. Source frames are sampled at 24 FPS, then adjacent identical frames are coalesced.
7. FFmpeg creates the selected palette/dithering candidate(s). Adaptive mode evaluates all concrete dithering methods when VMAF/CAMBI are available.
8. The bundled Rust worker applies the requested Gifski quality pass. In size-limited mode, the captured frames are reused for a bounded search of lower-cost profiles.
9. The result is inspected for dimensions, timing, frame count, loop behavior, and byte size. Failed inputs are cleaned up.
10. Progress, result, error, and complete events are emitted as newline-delimited JSON. The UI turns those events into batch progress and result cards.

## Input and output conventions

Inputs can be:

- A package directory containing `index.html` and its relative assets.
- A direct `.html` or `.htm` entry file; assets are resolved relative to that file’s directory.

Outputs are placed directly in the selected output directory. The base name is sanitized to ASCII-safe characters. Existing files are never overwritten; a numeric suffix is added instead:

```text
my-banner.gif
my-banner.report.json
my-banner-2.gif
my-banner-2.report.json
```

The report is the authoritative record of what was actually produced. In particular, compare `settings.outputFps` with `encoding.appliedFps`, and inspect `warnings` when capture safety limits or missing quality metrics affected the result.

## Protocol contract

The request must contain `protocolVersion: 4`, a non-empty `inputPaths` array, an `outputDirectory`, and a `config` object. The supported controls are:

| Field | Values | Default |
| --- | --- | --- |
| `outputFps` | `4`, `12`, `15`, `24` | `15` |
| `maxColors` | `64`, `128`, `192`, `256` | `256` |
| `dithering` | `adaptive`, `none`, `bayer-5`, `bayer-4`, `gradfun-bayer-5` | `adaptive` |
| `gifskiQuality` | integer `1`–`100` | `80` |
| `maxDurationSeconds` | number `0.1`–`60` | `30` |
| `loopMode` | `auto`, `once`, `infinite`/`forever`, or a non-negative repeat count | `auto` |
| `outputMode` | `forge`, `size-limited`, `both` | `forge` |
| `maxBytes` | whole-number delivery target in bytes | `150000` |
| `frameExport` | `none`, `png`, `jpeg`, `both` | `none` |
| `jpegQuality` | integer `1`–`100` | `90` |
| `jpegBackground` | six-digit `#rrggbb` matte color | `#ffffff` |

Frame archives use the raw captured sequence before adjacent-frame coalescing. Their ZIP-contained `manifest.json` is the timing authority for downstream assembly; JPEG frames have transparency flattened onto the selected matte color.

The sidecar emits JSON objects one per line. Consumers should tolerate progress events arriving between any two result events, preserve input-level errors, and use the `complete` event for batch totals. Exit codes are `0` for full success, `2` for partial/input failures, and `1` for invalid commands or requests.

## Local development

Install the root and sidecar dependencies, then run the browser UI or the desktop shell:

```bash
npm install
npm run sidecar:install
npm run dev          # UI in Vite
npm run tauri:dev    # Tauri desktop app
```

Before running a real conversion, build the platform-specific sidecars:

```bash
npm run sidecar:build
```

For a complete local check:

```bash
npm run check
```

`check` builds the frontend, runs the Rust worker tests, packages the sidecar, runs sidecar tests, and runs `cargo check` for the Tauri application. The sidecar build needs Rust/Cargo because it also builds the Gifski worker.

## Tool discovery and troubleshooting

The sidecar may need explicit executable paths when launched from Tauri, because GUI applications often receive a smaller `PATH` than a terminal. Set these variables for diagnostics or CI:

```bash
export BANNER_FORGE_CHROMIUM=/path/to/chrome
export BANNER_FORGE_FFMPEG=/path/to/ffmpeg
export BANNER_FORGE_GIFSKI_WORKER=/path/to/gifski-worker
```

Common symptoms:

- **Chromium could not be launched:** set `BANNER_FORGE_CHROMIUM` to a Chromium-family executable and retry.
- **FFmpeg not found:** install a compatible FFmpeg build or set `BANNER_FORGE_FFMPEG`. Adaptive dithering also needs an FFmpeg build exposing `libvmaf` and CAMBI; otherwise the sidecar falls back to Light Bayer and records a warning.
- **Gifski worker not found:** run `npm run sidecar:build`, or set `BANNER_FORGE_GIFSKI_WORKER` while diagnosing a packaged build.
- **Assets fail to load:** keep assets relative to the entry file and vendor remote fonts/scripts where reproducibility matters. The loopback server intentionally blocks paths outside the input directory.
- **Output FPS is lower than requested:** inspect the report’s capture timing and warnings. Safety limits can reduce source sampling or effective output FPS; frames are not duplicated to hide the adjustment.

## Change checklist

When changing the request or result contract, update all of these together:

1. `sidecar/lib/helpers.cjs` validation and defaults.
2. `src/types/conversion.ts` frontend types.
3. `src/App.tsx` and the relevant configuration/result components.
4. `sidecar/README.md` protocol examples.
5. `README.md` product-facing behavior and limitations.
6. Tests in `sidecar/test/`.

Run `npm run check` before handing off a change. Forge mode retains the selected settings; delivery mode may change FPS, palette, dithering, and Gifski quality to meet its byte target, but never changes banner dimensions.
