# Web migration status

Tracks progress against [WEB_MIGRATION.md](WEB_MIGRATION.md). Branch: `web-migration`.

Legend: ✅ done · 🟡 in progress · ⬜ not started · ⚠️ blocked / needs manual step

| Phase | Status | Notes |
|---|---|---|
| 0. Baseline | ✅ | See baseline results below. |
| 1. Engine headless prep | ✅ | |
| 2. HTTP server | ✅ | 28 tests; real curl E2E passes. |
| 3. Frontend | ✅ | Browser-verified: ZIP + folder, cancel, refresh reattach. |
| 4. Remove Tauri | ✅ | `npm run check` green; grep empty. |
| 5. Container image | 🟡 | arm64 build verified, incl. VMAF/CAMBI. amd64 build ⚠️ blocked by Netskope TLS interception of crates.io (local network only). |
| 6. Azure deployment | 🟡 | `infra/deploy.sh` + docs written; ⚠️ not run (needs your Azure subscription); Easy Auth is a manual portal step. |
| 7. Documentation | ✅ | README + DEVELOPMENT rewritten. |

## Phase 0: Baseline (2026-10-28)

- `npm run build` ✅
- `npm run sidecar:test` ✅ 24/24
- `npm run gifski:test` ✅ 2/2
- Branch `web-migration` created from `main` @ `9cd1173`.

## Phase 1: Engine headless prep

- [x] `scripts/build-gifski-worker.mjs` installs to `sidecar/bin/gifski-worker` by default; override with `BANNER_FORGE_GIFSKI_INSTALL_DIR`. No longer writes `src-tauri/binaries` or `sidecar/dist`.
- [x] `sidecar/lib/capture.cjs` adds `--no-sandbox` only when `BANNER_FORGE_CHROMIUM_NO_SANDBOX=1`.
- [x] `sidecar/lib/tools.cjs` drops the `src-tauri/binaries` candidate.
- [x] `sidecar/package.json`: removed `pkg` block, `@yao-pkg/pkg`, `build` script. Pinned `playwright-core` to `1.62.1` (exact, matches lockfile; needed for Phase 5).
- [x] `npm run sidecar:test` ✅ 24/24 (with `sidecar/dist` deleted, so the new install path is what's used).
- [x] CLI over stdin converts `sidecar/test/fixtures/package` → `package.gif` + `package.report.json`.

**Decision:** the guide says "`bin/gifski-worker`". It's installed in `sidecar/bin/` (next to the CLI) rather than the repo root `bin/`, because `resolveExecutable` checks `dirname(require.main)` and `cwd/bin`. That location is found both when the server spawns the CLI and when sidecar tests run with `cwd=sidecar`, with no extra env.

## Phase 2: HTTP server

- [x] Deps added: `fastify`, `@fastify/multipart`, `@fastify/static`, `yauzl`, `@azure/storage-blob`, plus `@azure/identity` (only loaded for `STORAGE=blob` with managed identity; Phase 6 needs it).
- [x] `server/config.cjs`: env parsing + defaults (all vars from §4, plus `HOST`, `LOG_LEVEL`).
- [x] `server/auth.cjs`: `X-MS-CLIENT-PRINCIPAL-ID` → owner; `REQUIRE_AUTH=1` → 401 if missing; otherwise `"local"`.
- [x] `server/uploads.cjs`: streaming multipart → `${WORK_ROOT}/<jobId>/input`; ZIP / folder / `.html` discovery; traversal + absolute path rejection (reuses `isWithin`); symlinks, `__MACOSX/`, `.DS_Store` skipped; all four limits enforced.
- [x] `server/jobs.cjs`: in-memory store, FIFO queue, `MAX_CONCURRENT_JOBS`; detached child per job (kills process group); NDJSON parsing; result rewrite to `downloadUrl`/`reportUrl`/`fileName`; `inputPath` → display name; server paths scrubbed from messages; timeout, cancel, TTL cleanup; owner checks.
- [x] `server/storage.cjs`: local streaming with `Content-Disposition: attachment`; Blob upload + 1 h read-only SAS (account key via connection string, or user delegation key via managed identity).
- [x] `server/index.cjs`: all routes in the API table, SSE with `Last-Event-ID` replay + 20 s pings (204 once a finished job has nothing more to send, so `EventSource` stops reconnecting), `/healthz`, static `dist/` + SPA fallback, CSP + `nosniff`, graceful shutdown.
- [x] Scripts `server` and `server:test` added.
- [x] `npm run server:test` ✅ 28/28 — covers ZIP-slip, size/count limits, ZIP + folder discovery, queue concurrency, cancel kills child *and grandchild*, SSE replay, owner isolation, timeouts, crash handling, TTL.
- [x] Manual E2E with the real engine: `curl -F config=... -F files=@fixture.zip -F paths=promo/index.html -F files=@...` → SSE ends in `complete` (2/2), downloads return valid GIF89a with `attachment` disposition. Input directory removed after the job.

**Decisions / notes**
- Each file part should be preceded by a `paths` (or `paths[]`) field with its relative path; if absent, the multipart filename is used.
- A top-level folder without its own `index.html` is searched one level down for banner folders (same rule as ZIPs), so selecting a parent folder of several banners works.
- The engine is sent the client's config object after validation with `normalizeConfig`, not the normalized result (the engine rejects the derived `captureFps`). Found during E2E.
- Extra event fields: `reportFileName` on results; cancel emits `{type:'complete', cancelled:true}`.
- Local `ffmpeg` (Homebrew) lacks libvmaf, so adaptive dithering falls back to Light Bayer locally. The Docker image must include it (Phase 5).

## Phase 3: Frontend

- [x] `src/types/conversion.ts`: removed `ConversionRequest`; added `UploadItem`, `JobSnapshot`, `ServerJobStatus`; `ResultEvent` gains `fileName`, `downloadUrl`, `reportFileName`, `reportUrl`.
- [x] `src/components/upload-panel.tsx` replaces `path-panel.tsx`: drop zone (files and folders, via `webkitGetAsEntry`), "Add ZIPs" (`.zip,.html,.htm`), "Add folders" (`webkitdirectory`); folder files grouped by top-level folder; same list/remove UI and `path-*` classes; output-folder section removed.
- [x] `src/hooks/use-conversion.ts`: same `{ job, run, cancel }` API, same `applyEvent` and progress mapping. XHR upload with `Uploading… n%`, then `EventSource`; closes on `complete`; `DELETE` on cancel (also aborts an in-flight upload); run-ID / cancelled-run guards kept; `jobId` in `sessionStorage` and reattach on mount via `GET /api/jobs/:id` + `?lastEventId=`.
- [x] `src/App.tsx`: `outputFolder` removed; `ready` = items + valid config; alert renamed to "Upload problem".
- [x] `src/components/results-panel.tsx`: download link per result, report as a secondary link, shows `fileName` and the banner display name.
- [x] `vite.config.ts`: `/api` proxy to `:8080`; Tauri port/HMR/watch settings removed.
- [x] Header: "Source (AGPL)" link from `VITE_SOURCE_URL` (hidden if unset — **must be set for production builds**); badge now says "Cloud engine".
- [x] `npm run build` ✅
- [x] Browser check (`npm run server` + `npm run dev`): ZIP with 2 banners + 1 folder → 3/3 generated, all 12 download/report links return 200 with GIF89a/JSON. Refresh mid-batch reattached at 79% and finished with no duplicate rows. Cancel → server status `cancelled`, no leftover engine/Chromium processes. No console errors.

**Notes**
- `POST /api/jobs` also returns `banners` (display names) so the progress bar knows the real banner count (one ZIP can hold several).
- Queued uploads aren't kept across a refresh (browser `File`s can't be persisted); only the running job reattaches.
- `.claude/launch.json` has `api` and `web` entries for running both locally.

## Phase 4: Remove Tauri

- [x] Deleted `src-tauri/`, `scripts/build-sidecar.mjs`, `public/tauri.svg`; dropped the Tauri VS Code recommendation and `src-tauri` lines in `.gitignore`.
- [x] `package.json`: removed `@tauri-apps/*`, `@tauri-apps/cli`, `@yao-pkg/pkg`, the `tauri*` and `sidecar:build` scripts; `check` = `build && gifski:test && sidecar:test && server:test`.
- [x] `sidecar/README.md` updated (no pkg/Tauri build; worker install location; no-sandbox flag).
- [x] `grep -ri tauri src server sidecar scripts` → no matches.
- [x] Clean `rm -rf node_modules sidecar/node_modules && npm install && npm run sidecar:install && npm run check` ✅ (build, gifski 2/2, sidecar 24/24, server 28/28).
- [x] `npm audit fix` (non-breaking) cleared the Fastify chain (`proxy-addr`, `fast-uri`) plus vite/undici etc.

**Open items**
- `npm install` doesn't install `sidecar/` deps; run `npm run sidecar:install` too (the Dockerfile does this).
- `npm audit --omit=dev` still lists `@azure/identity` → `@azure/msal-node` (high; npm's only suggested "fix" is a downgrade) and `shadcn` (low, already on `main`; `shadcn` is a CLI and could move to devDependencies). Re-check when new `@azure/identity` releases land.
- `README.md` / `docs/DEVELOPMENT.md` still describe Tauri. That's Phase 7.

## Phase 5: Container image

- [x] `Dockerfile` (multi-stage): `rust:1-bookworm` builds `gifski-worker`; `node:22-bookworm-slim` runs `npm ci`, `npm --prefix sidecar ci --omit=dev`, `npm run build` (with `VITE_SOURCE_URL` build arg), then `npm prune --omit=dev`; runtime `mcr.microsoft.com/playwright:v1.62.1-noble` (matches the pinned `playwright-core@1.62.1`).
- [x] FFmpeg: Ubuntu noble's `ffmpeg` 6.1.1 has **no libvmaf** (checked inside the base image), so the image installs BtbN `autobuild-2026-09-30-13-08` / `ffmpeg-n8.1.3-9-g29e619e767` GPL static (amd64 + arm64), verifies SHA-256 against the release's `checksums.sha256`, and runs `ffmpeg -filters | grep libvmaf` so the build fails if it's missing.
- [x] Chromium: `/ms-playwright/chromium-*/chrome-linux*/chrome` symlinked to `/usr/local/bin/chromium` (the revision number changes between Playwright versions).
- [x] Env: `BANNER_FORGE_FFMPEG=/usr/local/bin/ffmpeg`, `BANNER_FORGE_GIFSKI_WORKER=/usr/local/bin/gifski-worker`, `BANNER_FORGE_CHROMIUM=/usr/local/bin/chromium`, `PORT=8080`, `NODE_ENV=production`, `WORK_ROOT=/tmp/forge` (owned by `pwuser`); `USER pwuser`, `EXPOSE 8080`, `CMD ["node","server/index.cjs"]`.
- [x] `.dockerignore` (node_modules, target, dist, .git, sidecar/node_modules, test dirs, local worker binary, .env).
- [x] `docker build -t fallback-forge .` ✅ (arm64, Docker Desktop).
- [x] `docker run -p 8092:8080 fallback-forge` **without** `BANNER_FORGE_CHROMIUM_NO_SANDBOX`: `/healthz` → 200 (`ffmpeg`, `chromium`, `gifskiWorker` all true); `/` and an SPA route → 200; ZIP with 2 banners → `complete` 2/2; download is a valid GIF89a. **The Chromium sandbox works under local Docker Desktop.**
- [x] Adaptive dithering in the container (2026-10-28, arm64 image): libvmaf is present. A **300×250** banner gives `encoding.evaluation.mode = "vmaf-cambi"` with all four candidates scored (mean VMAF 89.2–89.9, p95 CAMBI 0.008–0.42) and no fallback warning. Light Bayer won on merit.
  - The earlier "unavailable" warning came from the 120×60 test fixture: **libvmaf's CAMBI feature fails on tiny frames** (`problem during vmaf_read_pictures`). Tested in the container: 120×60, 120×64, 128×64 fail; 300×250, 728×90, 160×600, 320×240 work; plain VMAF works at 120×60. Not an image problem; documented in README "Known limits" and DEVELOPMENT troubleshooting.
- [ ] ⚠️ linux/amd64 build (`docker buildx build --platform linux/amd64 .`) fails at `cargo build`: `SSL certificate ... self-signed certificate in certificate chain` fetching `index.crates.io`. Cause: the office network's **Netskope** proxy intercepts crates.io TLS and re-signs it with the TBWA/Netskope CA (`ca.oss.de.goskope.com`). macOS trusts that CA; containers don't. arm64 containers fail the same way now, so this is a network issue, not an architecture or Dockerfile one. (The first arm64 build earlier in the day got through, so the interception policy or Docker's proxy routing changed after the Docker restart.) GitHub (FFmpeg download) isn't intercepted.
  - **The deploy path isn't affected:** `az acr build` (used by `infra/deploy.sh`) builds amd64 in Azure, outside Netskope.
  - Local options: (a) build off the corporate network/VPN; (b) ask IT to exempt `crates.io`/`index.crates.io`/`static.crates.io` from inspection; (c) add an opt-in BuildKit secret for the corporate CA (`--secret id=extra_ca,src=netskope.pem`, used via `CARGO_HTTP_CAINFO` and `NODE_EXTRA_CA_CERTS` only during the build, never baked into the image).
**Incident (2026-10-28):** the base-image pulls and builds (Playwright, rust, node, plus build cache) filled the Mac's disk, and Docker Desktop's disk image reached 22 GB. Docker Desktop then got stuck mid-restart (`com.docker.backend` processes not exiting). Resolved: the stuck backend processes were killed, Docker Desktop was restarted, and `docker builder prune -af` + `docker image prune -f` reclaimed about 6.8 GB (25 GB free afterwards).

## Phase 6: Azure deployment

- [x] `infra/deploy.sh` (Azure CLI, re-runnable, no secrets): resource group; ACR Basic + `az acr build` tagged with the git SHA; Linux B3 plan + web app on the ACR image; system-assigned identity with `AcrPull` + `acrUseManagedIdentityCreds`; storage account (TLS 1.2, no public blob access, shared key off), private `outputs` container, 7-day delete lifecycle rule; `Storage Blob Data Contributor` + `Storage Blob Delegator` for the app identity; app settings from §6.3; Always On, `/healthz` health check, HTTPS only, min TLS 1.2; container logging. `bash -n` passes (shellcheck isn't installed here).
- [x] `docs/DEVELOPMENT.md` → new "Azure deployment" section, including the manual Easy Auth steps (Microsoft provider, require auth, 302 redirect) and the acceptance check.
- [ ] ⚠️ **Not run.** It creates billable resources in your subscription. Run it yourself (or ask me to) with `APP_NAME=... SOURCE_URL=... infra/deploy.sh`.
- [ ] Easy Auth: manual portal step after the script.
- [ ] Acceptance on `*.azurewebsites.net`: signed-in upload, a batch longer than 4 minutes without the stream dropping, downloads via SAS; anonymous visitors redirected to sign-in.
- [ ] Decide whether `BANNER_FORGE_CHROMIUM_NO_SANDBOX=1` is needed on App Service (check `/healthz` and a capture).

**Decision:** the app uses `AZURE_STORAGE_ACCOUNT` + managed identity (user-delegation SAS) rather than a connection string, so there's no storage key to manage. `AZURE_STORAGE_CONNECTION_STRING` still works, e.g. for Azurite locally.

## Phase 7: Documentation

- [x] `README.md`: intro, architecture diagram, prerequisites, licensing, setup, commands, tool discovery, limits, and scaling rewritten for the web app; engine protocol and dithering sections kept (protocol text now describes the server's role and the event rewriting).
- [x] `docs/DEVELOPMENT.md`: code map with `server/`, runtime walkthrough (upload → job → SSE → download → cleanup), env var table (every variable from §4 plus `HOST`, `LOG_LEVEL`, build-time vars), Azure deployment, troubleshooting (sandbox, missing libvmaf, 230 s idle timeout, 401/403/413), licensing (Gifski AGPL source link, FFmpeg GPL).
- [x] `sidecar/README.md` updated in Phase 4.
- [x] `npm run check` ✅ after the doc changes; Tauri grep still empty.

## Remaining work

1. amd64 image: build via `az acr build` (step 2 does this), or locally once crates.io TLS works in containers (see Phase 5 options).
2. Run `infra/deploy.sh`, turn on Easy Auth, and do the Phase 6 acceptance test.
3. Optional: move `shadcn` to devDependencies; watch for an `@azure/identity`/`msal-node` fix.
