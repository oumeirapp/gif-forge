# Delivery-output TDD evidence

## Scope

Derived from the approved feature plan in this conversation: generate a configured Forge GIF, a size-limited delivery GIF, or both; preserve dimensions; report whether a byte target was met.

## User journeys

1. As a banner producer, I can choose Forge-only, size-limited-only, or both outputs.
2. As a banner producer, I can set a delivery byte budget and receive the first acceptable candidate or the smallest candidate when the target cannot be met.
3. As a batch user, I receive distinct output paths and reports without overwriting existing outputs.

## Evidence

| Guarantee | Test | Result |
| --- | --- | --- |
| Output-mode and byte-budget inputs are defaulted and strictly validated | `sidecar/test/helpers.test.cjs` — configuration defaults | Pass |
| Forge and delivery output names are paired and distinguish the decimal-KB budget | `sidecar/test/helpers.test.cjs` — output paths | Pass |
| Delivery candidates start with the selected configuration, progressively reduce costs, and remain unique | `sidecar/test/helpers.test.cjs` — delivery profiles | Pass |
| A target uses the first in-budget candidate; an unmet target uses the smallest candidate | `sidecar/test/helpers.test.cjs` — delivery candidate selection | Pass |
| Reports accept the current schema while retaining schema-v4 validation compatibility | `sidecar/test/helpers.test.cjs` — report schema | Pass |

Validation commands run:

```bash
npm --prefix sidecar test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

All commands passed. `npm run check` reached the packaged-sidecar step but could not complete because the sandbox cannot modify the local `pkg` cache outside the workspace. A request to run that step outside the sandbox was rejected by the environment before execution. An end-to-end fixture conversion was also blocked because the sandbox prevents binding the loopback HTTP server used by the renderer.

## Known gaps

No coverage script or browser E2E runner is configured in this repository. The new contract and selection policy are unit-tested, but a packaged-app conversion that writes both outputs still needs to be exercised in an environment that permits loopback listeners and package-cache writes.
