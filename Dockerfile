# syntax=docker/dockerfile:1

# 1. Gifski worker (Rust)
FROM rust:1-bookworm AS gifski
WORKDIR /build
COPY gifski-worker/ gifski-worker/
RUN cargo build --release --manifest-path gifski-worker/Cargo.toml

# 2. UI bundle + production node_modules
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY sidecar/package.json sidecar/package-lock.json sidecar/
RUN npm --prefix sidecar ci --omit=dev
COPY index.html tsconfig.json tsconfig.node.json vite.config.ts components.json ./
COPY public/ public/
COPY src/ src/
# Link to the public gifski-worker source, required by Gifski's AGPL for a network service.
ARG VITE_SOURCE_URL=""
ENV VITE_SOURCE_URL=${VITE_SOURCE_URL}
RUN npm run build && npm prune --omit=dev

# 3. Runtime: Playwright image pinned to sidecar/package-lock.json's playwright-core (1.62.1)
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime

# Ubuntu's ffmpeg has no libvmaf, which adaptive dithering (VMAF/CAMBI) needs, so use a
# pinned BtbN static GPL build and verify it against the release's published checksums.
ARG TARGETARCH
ARG FFMPEG_RELEASE=autobuild-2026-09-30-13-08
ARG FFMPEG_BUILD=ffmpeg-n8.1.3-9-g29e619e767
ARG FFMPEG_SHA256_AMD64=97ce978979194b5cf7e06a5e68020dbdaa7a4f3294c5452b6a1bc347100dbb79
ARG FFMPEG_SHA256_ARM64=10523d1e0be6b3ce62a9708cc50815c4b5eb5f36ae147fbe2afeecda6f2d6845
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    case "${TARGETARCH:-amd64}" in \
      amd64) platform=linux64; sha="${FFMPEG_SHA256_AMD64}" ;; \
      arm64) platform=linuxarm64; sha="${FFMPEG_SHA256_ARM64}" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    archive="${FFMPEG_BUILD}-${platform}-gpl-8.1.tar.xz"; \
    curl -fsSL -o /tmp/ffmpeg.tar.xz "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${archive}"; \
    echo "${sha}  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/ffmpeg.tar.xz -C /tmp; \
    install -m 0755 /tmp/${FFMPEG_BUILD}-${platform}-gpl-8.1/bin/ffmpeg /tmp/${FFMPEG_BUILD}-${platform}-gpl-8.1/bin/ffprobe /usr/local/bin/; \
    rm -rf /tmp/ffmpeg.tar.xz /tmp/${FFMPEG_BUILD}-*; \
    apt-get purge -y --auto-remove curl xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    ffmpeg -hide_banner -filters | grep -E 'libvmaf'; \
    chromium="$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome | head -n 1)"; \
    test -x "$chromium"; \
    ln -s "$chromium" /usr/local/bin/chromium; \
    mkdir -p /tmp/forge; \
    chown pwuser:pwuser /tmp/forge

COPY --from=gifski /build/gifski-worker/target/release/gifski-worker /usr/local/bin/gifski-worker

WORKDIR /app
COPY --from=web /app/package.json ./package.json
COPY --from=web /app/node_modules ./node_modules
COPY --from=web /app/dist ./dist
COPY --from=web /app/sidecar/node_modules ./sidecar/node_modules
COPY sidecar/package.json sidecar/
COPY sidecar/bin/banner-forge-sidecar.cjs sidecar/bin/
COPY sidecar/lib/ sidecar/lib/
COPY server/ server/

ENV NODE_ENV=production \
    PORT=8080 \
    WORK_ROOT=/tmp/forge \
    BANNER_FORGE_FFMPEG=/usr/local/bin/ffmpeg \
    BANNER_FORGE_GIFSKI_WORKER=/usr/local/bin/gifski-worker \
    BANNER_FORGE_CHROMIUM=/usr/local/bin/chromium

USER pwuser
EXPOSE 8080
CMD ["node", "server/index.cjs"]
