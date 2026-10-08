# Build image for the Anthropic OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this file with the repository as the build context, then runs
# the image without network access. Everything the tests need is fetched here.
FROM rust:1-bookworm

ENV DEBIAN_FRONTEND=noninteractive
# The Tauri Linux build needs WebKitGTK 4.1; xvfb lets the smoke test open the window headless.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 file \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
      xvfb xauth dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-bookworm /usr/local/bin/node /usr/local/bin/node

# Number of parallel compile jobs. The scanner's build machine has 16 CPUs.
ARG JOBS=4
ENV CARGO_BUILD_JOBS=${JOBS} \
    RUSTFLAGS="-C force-frame-pointers=yes"

COPY . /src
WORKDIR /src

# The frontend (src/) is static files that Tauri embeds in the binary, so no bundler
# step is needed. The release binary is what tools/smoke.mjs launches.
RUN cd src-tauri \
    && cargo fetch --locked \
    && cargo build --locked --release \
    && cargo test --locked --no-run

# Run the checks once so a broken image is visible in the build log. A failure does not stop the build.
RUN cd src-tauri && (cargo test --locked || echo "WARNING: cargo test reported failures")
RUN node tools/check_frontend.mjs || echo "WARNING: frontend contract checks reported failures"
RUN xvfb-run -a node tools/smoke.mjs || echo "WARNING: smoke test reported failures"

# From here on there is no network.
ENV CARGO_NET_OFFLINE=true
