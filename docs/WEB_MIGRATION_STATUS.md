# Web migration status

Tracks progress against [WEB_MIGRATION.md](WEB_MIGRATION.md). Branch: `web-migration`.

Legend: ✅ done · 🟡 in progress · ⬜ not started · ⚠️ blocked / needs manual step

| Phase | Status | Notes |
|---|---|---|
| 0. Baseline | ✅ | See baseline results below. |
| 1. Engine headless prep | ✅ | |
| 2. HTTP server | ✅ | 28 tests; real curl E2E passes. |
| 3. Frontend | ✅ | Browser-verified: ZIP + folder, cancel, refresh reattach. |
| 4. Remove Tauri | ⬜ | |
| 5. Container image | ⬜ | |
| 6. Azure deployment | ⬜ | |
| 7. Documentation | ⬜ | |

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
