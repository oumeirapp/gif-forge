# Banner Forge sidecar

`banner-forge-sidecar` converts local HTML banners to optimized GIFs. Inputs may be direct HTML files or package directories containing `index.html`. It loads each banner from a loopback-only HTTP server in Chromium, waits for fonts/images/video metadata, detects common ad dimensions, finds Web Animations plus modern GSAP and legacy `window.tl` timelines, and captures a fixed-DPR timeline. Exact adjacent PNG frames are coalesced before FFmpeg encoding.

## Install and test

Run these commands from `sidecar/`:

```sh
npm install
npm test
```

`npm test` first builds the Rust Gifski worker (`scripts/build-gifski-worker.mjs`) and installs it at `sidecar/bin/gifski-worker`, next to the CLI, where discovery finds it. Set `BANNER_FORGE_GIFSKI_INSTALL_DIR` to install it somewhere else.

The engine runs as a plain Node CLI. The web server (`server/`) starts one `banner-forge-sidecar convert` child process per job. Chromium and FFmpeg are not bundled. Set these variables only when overriding discovery:

- Chromium: `BANNER_FORGE_CHROMIUM` (also accepts `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` or `CHROME_PATH`)
- FFmpeg: `BANNER_FORGE_FFMPEG` (also accepts `FFMPEG_PATH`)
- Gifski worker: `BANNER_FORGE_GIFSKI_WORKER`

- Chromium sandbox: `BANNER_FORGE_CHROMIUM_NO_SANDBOX=1` adds `--no-sandbox`, for container hosts that don't allow Chromium's sandbox

When no explicit path is set, the sidecar checks sibling locations (next to the CLI and in `bin/`), standard browser locations, then `PATH` where appropriate.

## Protocol

Pass one JSON request as the second CLI argument:

```sh
banner-forge-sidecar convert '{"protocolVersion":4,"inputPaths":["/absolute/banner-package"],"outputDirectory":"/absolute/out","config":{"outputFps":15,"maxColors":256,"dithering":"adaptive","gifskiQuality":80,"maxDurationSeconds":30,"loopMode":"auto"}}'
```

The same JSON can be sent as one line on stdin. The web server uses stdin so large batches are not constrained by command-line length limits.

Protocol v4 separates frame rate, palette size, dithering, and Gifski quality. `outputFps` accepts 4, 12, 15, or 24 (default 15); `maxColors` accepts 64, 128, 192, or 256 (default 256). The sidecar captures at 24 FPS, then resamples at the selected output rate. `outputMode` accepts `forge`, `size-limited`, or `both`; `maxBytes` is the delivery target in bytes and defaults to 150000. Legacy quality presets, editable capture-FPS fields, and Gifsicle modes are rejected.

`frameExport` accepts `none`, `png`, `jpeg`, or `both` and defaults to `none`. Each selected format produces a ZIP archive containing every captured source frame before GIF coalescing and a `manifest.json` timing map. JPEG uses `jpegQuality` (1–100, default 90) and flattens transparency using `jpegBackground` (a six-digit `#rrggbb` color, default `#ffffff`).

`dithering` accepts `adaptive`, `none`, `bayer-5`, `bayer-4`, or `gradfun-bayer-5`. Adaptive compares all four concrete methods using VMAF/CAMBI and chooses the smallest candidate within 0.25 quality-score points of the best result. Without those metrics, Adaptive uses Light Bayer and records a warning. A manual choice encodes only that method. Every method uses a stable global palette generated from full-frame statistics.

`gifskiQuality` accepts an integer from 1–100 and defaults to 80. It is a quality score rather than a file-size percentage: lower values permit stronger lossy compression, while 100 disables Gifski's lossy LZW pass. The bundled worker keeps Gifski's palette and motion quality at 100 so this control does not silently change the selected FPS, palette ceiling, or upstream dithering mode.

`loopMode` accepts `"auto"`, `"forever"`/`"infinite"`, `"once"`, or a non-negative numeric repeat count. Auto mode preserves detectable CSS/GSAP infinite looping and otherwise emits a play-once GIF. Input packages are processed independently.

Standard output is newline-delimited JSON only:

- `progress`: load, capture, coalesce, encode, quality analysis, and validation status
- `result`: GIF/report paths or frame-archive paths, output type, requested and effective FPS, palette, dithering, compression, exact byte count, and warnings. Delivery results also expose the byte target, whether it was met, and candidates tested; frame archives expose their source-frame count.
- `error`: a request-level or input-level failure
- `complete`: total/succeeded/failed counts

The process exits `0` if every input produces a structurally valid GIF, `2` after partial/input failures, and `1` for an invalid command or request. Forge output retains the selected controls. Size-limited output reuses the captured frames, tests a bounded sequence of lower-cost settings while preserving dimensions, and writes the first candidate within the target; if none fit, it writes the smallest. Each GIF receives a schema-v5 `.report.json` containing capture timing, selected controls, candidate metrics, compression status, dimensions, duration, looping, exact bytes, and delivery-budget status where applicable.
