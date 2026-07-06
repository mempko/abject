#!/usr/bin/env bash
# Compile a C++ abject into a WASM module conforming to docs/WASM_ABI.md.
#
# Usage:  sdk/cpp/build.sh <sources...> -o <out.wasm> [extra clang++ flags]
#
# Requires the WASI SDK (https://github.com/WebAssembly/wasi-sdk).
# Set WASI_SDK to its root; defaults to ~/tools/wasi-sdk.

set -euo pipefail

WASI_SDK="${WASI_SDK:-$HOME/tools/wasi-sdk}"
SDK_INCLUDE="$(cd "$(dirname "$0")/include" && pwd)"

if [ ! -x "$WASI_SDK/bin/clang++" ]; then
  echo "error: WASI SDK not found at $WASI_SDK (set WASI_SDK)" >&2
  exit 1
fi

exec "$WASI_SDK/bin/clang++" \
  --target=wasm32-wasi \
  -mexec-model=reactor \
  -std=c++20 \
  -O2 \
  -fno-exceptions \
  -fno-threadsafe-statics \
  -I "$SDK_INCLUDE" \
  -Wl,-z,stack-size=1048576 \
  -Wl,--initial-memory=4194304 \
  "$@"
