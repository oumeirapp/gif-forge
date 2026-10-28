# Development guide

This guide explains where the main pieces of Fallback Forge live and how a conversion moves through the application.

## Repository map

```text
src/                    React + TypeScript web UI
  App.tsx               Application state and layout
  hooks/use-conversion  Upload (XHR), SSE progress, cancel, reattach after refresh
  components/           Panels, controls, and shared UI primitives
  types/                Upload, protocol event, and job-state types
server/                 Node HTTP server (Fastify, CommonJS)
  index.cjs             Routes, SSE, static UI, security headers, startup
  config.cjs            Environment parsing and defaults
  uploads.cjs           Multipart parsing, ZIP extraction, folder reassembly, limits
  jobs.cjs              Job store, FIFO queue, engine child processes, event buffer
  storage.cjs           Local and Azure Blob output backends
  auth.cjs              Easy Auth principal -> job owner
  test/                 node:test suites (fake engine in test/fixtures)
sidecar/                Conversion engine (one CLI process per job)
  bin/                  CLI entry point and protocol handling
  lib/capture.cjs       Chromium launch, asset readiness, timeline discovery
  lib/encode.cjs        FFmpeg palette/dither candidates and Gifski pass
  lib/convert.cjs       Per-input orchestration and report creation
  lib/gif.cjs           Output inspection and validation
  lib/server.cjs        Ephemeral loopback file server
  test/                 Node unit and integration-style tests
gifski-worker/          Rust wrapper around the Gifski encoder
scripts/                Gifski worker build script
infra/deploy.sh         Azure CLI provisioning and deployment
Dockerfile              Multi-stage image (Rust worker, UI build, Playwright runtime)
```

## Runtime flow

1. **Upload.** The user adds ZIPs, `.html` files, or folders. `useConversion.run` posts one `multipart/form-data` request to `POST /api/jobs`: a `config` field, then for every file a `paths` field (its relative path) followed by the file. Upload progress shows as "Uploading… n%".
2. **Unpack.** `uploads.cjs` streams parts into `${WORK_ROOT}/<jobId>/input`. Each ZIP is extracted into its own folder; a root `index.html` makes it one banner, otherwise every top-level folder with `index.html` is one. Folder uploads are rebuilt from their relative paths, one banner per top-level folder. Traversal, absolute paths, and symlinks are rejected or skipped, and the size/count limits are enforced while streaming. The server answers `202 { jobId, banners }`.
3. **Queue.** `jobs.cjs` queues the job (FIFO, at most `MAX_CONCURRENT_JOBS` running). Jobs record their owner; every `/api/jobs/:id*` route returns 404 to anyone else.
4. **Run.** The runner spawns `node sidecar/bin/banner-forge-sidecar.cjs convert` detached (own process group), writes one protocol-v4 request line to stdin, and parses stdout as NDJSON. Inside the engine, each banner is served from an ephemeral `127.0.0.1` server, captured in headless Chromium at 24 FPS, encoded with FFmpeg + Gifski, and validated.
5. **Rewrite.** Each event is stored in the job's buffer with an increasing id. `result` events have `outputPath`/`reportPath` replaced by `fileName`, `downloadUrl`, `reportFileName`, and `reportUrl` (after uploading to Blob when `STORAGE=blob`). `inputPath` becomes the banner's display name and server paths are removed from messages.
6. **Stream.** The browser opens `EventSource('/api/jobs/:id/events')`. The server replays buffered events after `Last-Event-ID` (or `?lastEventId=`), then streams live ones, with a `: ping` comment every 20 s so idle proxies don't cut the connection. The client closes the stream on `complete`.
7. **Reattach.** The job id is kept in `sessionStorage`. After a refresh the hook loads `GET /api/jobs/:id`, replays the snapshot's events, and resumes the stream from its `lastEventId`.
8. **Cancel / timeout.** `DELETE /api/jobs/:id`, or exceeding `JOB_TIMEOUT_MS`, kills the whole process group (`process.kill(-pid, 'SIGKILL')`), which also stops Chromium, FFmpeg, and gifski.
9. **Download and cleanup.** `GET /api/jobs/:id/files/:name` streams the file with `Content-Disposition: attachment` (local) or redirects to a 1-hour read-only SAS URL (Blob). The input directory is deleted when the job ends. The job record and local outputs are deleted after `JOB_TTL_MS`; Blob outputs are removed by the storage lifecycle rule after 7 days.

## Input and output conventions

Inputs can be:

- A package directory containing `index.html` and its relative assets.
- A direct `.html` or `.htm` entry file; assets are resolved relative to that file’s directory.

The engine writes outputs to the job's output directory (`${WORK_ROOT}/<jobId>/output`), named after the banner folder or file. The base name is sanitized to ASCII-safe characters. Existing files are never overwritten; a numeric suffix is added instead:

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

Prerequisites: Node.js 22+, Rust/Cargo, FFmpeg (ideally with `libvmaf`), and Chrome or Chromium.

```bash
npm install
npm run sidecar:install
npm run gifski:build      # builds the worker into sidecar/bin/gifski-worker
npm run server            # API on http://localhost:8080 (also serves dist/ if built)
npm run dev               # Vite UI on http://localhost:5173, proxies /api to :8080
```

`npm run sidecar:test` also builds the worker first. For a complete local check:

```bash
npm run check             # build + gifski tests + sidecar tests + server tests
```

To try the production image locally:

```bash
docker build -t fallback-forge --build-arg VITE_SOURCE_URL=https://github.com/<org>/gif-forge .
docker run --rm -p 8080:8080 fallback-forge
curl localhost:8080/healthz
```

### Driving the API by hand

```bash
curl -F 'config={"outputMode":"both"}' -F paths=banners.zip -F files=@banners.zip localhost:8080/api/jobs
curl -N localhost:8080/api/jobs/<jobId>/events
curl -OJ localhost:8080/api/jobs/<jobId>/files/<fileName>
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `WORK_ROOT` | `/tmp/forge` | Job working directories |
| `MAX_CONCURRENT_JOBS` | `2` | Parallel engine processes |
| `JOB_TIMEOUT_MS` | `900000` (15 min) | Kill a job after this many ms |
| `JOB_TTL_MS` | `86400000` (24 h) | Forget the job and delete local outputs after this many ms |
| `MAX_UPLOAD_BYTES` | `104857600` (100 MB) | Upload size cap per request |
| `MAX_UNZIPPED_BYTES` | `314572800` (300 MB) | Extracted size cap per job |
| `MAX_FILES` | `5000` | File count cap per job |
| `MAX_BANNERS_PER_JOB` | `25` | Banner count cap |
| `REQUIRE_AUTH` | unset | `1` = require the Easy Auth `X-MS-CLIENT-PRINCIPAL-ID` header (401 otherwise) |
| `STORAGE` | `local` | `local` or `blob` |
| `AZURE_STORAGE_CONNECTION_STRING` | – | Blob access with an account key |
| `AZURE_STORAGE_ACCOUNT` | – | Blob access with managed identity (`DefaultAzureCredential`) |
| `AZURE_STORAGE_CONTAINER` | `outputs` | Blob container |
| `LOG_LEVEL` | `info` | Fastify log level |
| `BANNER_FORGE_CHROMIUM` | auto | Chromium executable (also `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, `CHROME_PATH`) |
| `BANNER_FORGE_FFMPEG` | auto | FFmpeg executable (also `FFMPEG_PATH`) |
| `BANNER_FORGE_GIFSKI_WORKER` | auto | Gifski worker executable |
| `BANNER_FORGE_CHROMIUM_NO_SANDBOX` | unset | `1` = launch Chromium with `--no-sandbox` |
| `BANNER_FORGE_GIFSKI_INSTALL_DIR` | `sidecar/bin` | Build-time: where `gifski:build` installs the worker |
| `VITE_SOURCE_URL` | – | Build-time: the "Source (AGPL)" link in the UI |

## Azure deployment

The app runs as one Linux container on App Service, behind Easy Auth, writing outputs to Blob Storage. The job store is in memory, so **keep the app at one instance**.

**For the full step-by-step procedure (prerequisites, portal and CLI steps, sign-in setup, verification checklist, updates, rollback, troubleshooting), see [AZURE_DEPLOYMENT.md](AZURE_DEPLOYMENT.md).** This section is a summary.

`infra/deploy.sh` does steps 1–4 and 6–7 below with the Azure CLI. It's safe to re-run and uses managed identity throughout, so there are no secrets to store:

```bash
az login
APP_NAME=fallback-forge-prod SOURCE_URL=https://github.com/<org>/gif-forge infra/deploy.sh
```

1. **Resource group + Azure Container Registry (Basic).** The image is built in ACR (`az acr build -t fallback-forge:<git-sha> .`) for linux/amd64, with `VITE_SOURCE_URL` passed as a build arg.
2. **App Service plan, Linux B3.** The web app runs the ACR image and pulls it with its system-assigned managed identity (`AcrPull` role, `acrUseManagedIdentityCreds`).
3. **App settings:** `WEBSITES_PORT=8080`, `REQUIRE_AUTH=1`, `STORAGE=blob`, `AZURE_STORAGE_ACCOUNT=<account>`, `AZURE_STORAGE_CONTAINER=outputs`, `MAX_CONCURRENT_JOBS=2`. Add `BANNER_FORGE_CHROMIUM_NO_SANDBOX=1` **only if** `/healthz` or capture fails with Chromium sandbox errors.
4. **General settings:** Always On, health check path `/healthz`, HTTPS only, minimum TLS 1.2.
5. **Authentication (manual).** In the portal: *Web app → Authentication → Add identity provider → Microsoft*. Create a new app registration (single tenant), set *Restrict access* to **Require authentication**, and *Unauthenticated requests* to **HTTP 302 Found redirect**. Easy Auth then sets `X-MS-CLIENT-PRINCIPAL-ID` on every request it forwards and strips any copy a client sends.
6. **Storage account.** Private container `outputs`, shared-key access disabled, lifecycle rule deleting blobs older than 7 days. The web app's identity has **Storage Blob Data Contributor** (upload) and **Storage Blob Delegator** (sign user-delegation SAS download URLs).
7. **Logs.** Container logging to the file system is turned on (`az webapp log tail -g <rg> -n <app>`). Application Insights is optional.

**Acceptance check:** a signed-in user can upload a ZIP on `https://<app>.azurewebsites.net`, watch progress for a batch longer than 4 minutes without the connection dropping, and download the GIF and report. A user who isn't signed in is redirected to sign-in.

To ship a new version, re-run the script, or just build and point the app at the new tag:

```bash
az acr build -r <acr> -t fallback-forge:$(git rev-parse --short HEAD) --build-arg VITE_SOURCE_URL=<url> .
az webapp config container set -g <rg> -n <app> --container-image-name <acr>.azurecr.io/fallback-forge:<sha>
```

## Tool discovery and troubleshooting

The engine looks for tools via explicit environment variables, then sibling locations (next to the CLI and in `bin/`), common absolute paths, and finally `PATH`. In the container, all three tool variables are set explicitly. `GET /healthz` reports which tools resolve and returns 503 if any are missing.

- **Chromium could not be launched / sandbox errors.** Some hosts don't allow Chromium's sandbox (no user namespaces). Set `BANNER_FORGE_CHROMIUM_NO_SANDBOX=1`. It ran with the sandbox on under local Docker Desktop; confirm on App Service before turning it off. Locally, set `BANNER_FORGE_CHROMIUM` if Chrome isn't found.
- **Adaptive dithering always picks Light Bayer.** The report warns "Adaptive VMAF/CAMBI comparison was unavailable" when FFmpeg lacks `libvmaf`. Ubuntu's and Homebrew's default builds don't have it; the Docker image installs a pinned BtbN static GPL build and fails the build if the filter is missing. Check with `ffmpeg -hide_banner -filters | grep libvmaf`. Separately, libvmaf's CAMBI feature fails on very small frames (e.g. 120×60 or 128×64 fail; 300×250, 728×90 and 160×600 work), so tiny banners get the same warning even with libvmaf present.
- **Gifski worker not found.** Run `npm run gifski:build`, or set `BANNER_FORGE_GIFSKI_WORKER`.
- **Progress stops after about 4 minutes.** App Service's front end drops idle HTTP connections after roughly 230 s. Jobs keep running in the background regardless. The SSE stream sends a ping every 20 s, and `EventSource` reconnects with `Last-Event-ID`, so nothing is lost. If it still drops, check that nothing in between buffers `text/event-stream` responses. The server sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`.
- **401 on every API call in Azure.** `REQUIRE_AUTH=1` is set but Easy Auth isn't on yet, or the provider isn't requiring authentication.
- **Downloads fail with 403 from Blob.** The web app identity is missing *Storage Blob Delegator*, or role assignments haven't propagated yet (allow a few minutes).
- **Upload rejected (400/413).** The error message names the limit or path. Raise `MAX_*` variables if the content is legitimate.
- **Assets fail to load.** Keep assets relative to the entry file and vendor remote fonts/scripts. The engine's loopback server blocks paths outside the banner folder.
- **Output FPS is lower than requested.** Inspect the report's capture timing and warnings. Safety limits can reduce source sampling or effective output FPS; frames aren't duplicated to hide the adjustment.

## Licensing

- **Gifski is AGPL-3.0-or-later.** Because Fallback Forge offers it over a network, users must be able to get the corresponding source. Keep the "Source (AGPL)" link in the UI (set `VITE_SOURCE_URL` at build time) and keep the `gifski-worker` source in a public repository.
- **FFmpeg.** The container ships a GPL build of FFmpeg (needed for libvmaf), so its GPL obligations apply to the image.
- **Chromium** comes from the Playwright base image under its own licences.

## Change checklist

When changing the request or result contract, update all of these together:

1. `sidecar/lib/helpers.cjs` validation and defaults.
2. `src/types/conversion.ts` frontend types, and the event rewriting in `server/jobs.cjs`.
3. `src/App.tsx` and the relevant configuration/result components.
4. `sidecar/README.md` protocol examples.
5. `README.md` product-facing behavior and limitations.
6. Tests in `sidecar/test/` and `server/test/`.

Run `npm run check` before handing off a change. Forge mode retains the selected settings; delivery mode may change FPS, palette, dithering, and Gifski quality to meet its byte target, but never changes banner dimensions.
