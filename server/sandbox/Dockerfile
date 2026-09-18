# syntax=docker/dockerfile:1
#
# The Hub TypeScript execution image (§23.8): the Sandbox control binary from the EXACTLY
# matching preview release, on a pinned Deno base, plus the three immutable runtime files
# the run directory is built from. Nothing else is baked and nothing mutable is mounted:
# the submission, its declarations and its snapshot are written per run, and the only
# secret ever present is the ephemeral generation nonce in one process environment.
#
# The two pins are the release contract: `SANDBOX_IMAGE` must carry the same version as the
# `@cloudflare/sandbox` dependency (the control protocol is versioned with it) and
# `DENO_IMAGE` the same Deno whose flags and Worker semantics runner.ts relies on. A unit
# test reads this file, package.json and runner.ts and fails on drift.

ARG SANDBOX_IMAGE=cloudflare/sandbox:0.13.0-next.751.1
ARG DENO_IMAGE=denoland/deno:2.9.6

# The control binary is linux/amd64-only; pinning the stage makes a cross-platform build
# copy the right artifact instead of silently failing.
FROM --platform=linux/amd64 ${SANDBOX_IMAGE} AS control
FROM ${DENO_IMAGE}

# The base already ships Deno at /usr/bin/deno and tini at /tini. The control binary is a
# Bun-compiled standalone (glibc); libstdc++/libgcc and a CA bundle are the system pieces it
# expects on a Debian base.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libstdc++6 libgcc-s1 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The whole control directory: the standalone binary plus the legacy JS bundle the upstream
# image ships beside it. Anything under /container-server is vendor runtime, never ours.
COPY --from=control /container-server /container-server

# The immutable application files: the trusted parent, the fixed worker entry, and the
# checker options. Copied per run into /workspace/pmcp-exec, never executed from here.
COPY runner.ts worker.ts deno.json /opt/hub/

# No language pools: the run uses the pinned Deno binary directly, and the interpreter
# pools are the SDK's own machinery for a feature this image deliberately does not ship.
ENV PYTHON_POOL_MIN_SIZE=0 \
  JAVASCRIPT_POOL_MIN_SIZE=0 \
  TYPESCRIPT_POOL_MIN_SIZE=0

RUN mkdir -p /workspace /container-server

WORKDIR /container-server
EXPOSE 3000

ENTRYPOINT ["/tini", "--", "/container-server/sandbox"]