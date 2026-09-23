#!/usr/bin/env bash
#
# Render build for one service in this monorepo.
#
#   ./scripts/render-build.sh @instantmockapi/api
#
# Exists because the obvious build command does not work on Render, and the
# reason is not obvious from its error. Two problems, both fixed here rather
# than in a dashboard field nobody can review or test:
#
# 1. `corepack enable` installs its shims next to the `corepack` binary, which
#    it locates with the equivalent of `which corepack`. On Render that is
#    `/usr/bin`, mounted read-only, so the command dies with
#    `EROFS: read-only file system, unlink '/usr/bin/pnpm'`. Passing
#    `--install-directory` puts them somewhere writable instead. Corepack does
#    NOT create that directory, so the `mkdir -p` below is load-bearing —
#    without it the build fails a second time with `ENOENT ... lstat`.
#
# 2. `tsc` across this monorepo exceeds Node's default heap on a small build
#    container and dies with exit 134. The ceiling is raised for the build step
#    ONLY, deliberately: setting `NODE_OPTIONS` as a Render environment variable
#    would apply it to the running service too, where telling V8 it may grow to
#    4 GB inside a 512 MB container makes the kernel kill the process instead of
#    letting V8 collect. Build-time memory and runtime memory are different
#    problems and should not share a knob.

set -euo pipefail

FILTER="${1:-}"
if [ -z "$FILTER" ]; then
  echo "usage: $0 <turbo-filter>   e.g. $0 @instantmockapi/api" >&2
  exit 2
fi

# Overridable so a platform with a different writable path can say so, and so
# this script is runnable locally without touching a shared directory.
COREPACK_DIR="${COREPACK_INSTALL_DIR:-$HOME/.corepack}"
BUILD_HEAP_MB="${BUILD_HEAP_MB:-4096}"

echo "==> corepack shims -> $COREPACK_DIR"
mkdir -p "$COREPACK_DIR"
corepack enable --install-directory "$COREPACK_DIR"
export PATH="$COREPACK_DIR:$PATH"

# Proves the shim resolved and reports the version `packageManager` pins, so a
# version mismatch shows up here rather than as a confusing lockfile error.
echo "==> pnpm $(pnpm --version)"

pnpm install --frozen-lockfile --prod=false

echo "==> building $FILTER with a ${BUILD_HEAP_MB}MB heap"
NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MB}" pnpm turbo run build --filter="$FILTER"
