#!/bin/sh
set -eu
NATIVE_SPACE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$NATIVE_SPACE_ROOT/tools/rust-env.sh"
mkdir -p "$NATIVE_SPACE_ROOT/.toolchain"
if ! rustc --version >/dev/null 2>&1; then
  if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
    printf '%s\n' 'This bootstrap currently targets Apple Silicon macOS.' >&2
    exit 1
  fi
  if [ ! -f "$NATIVE_SPACE_ROOT/.toolchain/rustup-init" ]; then
    curl --fail --location https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init --output "$NATIVE_SPACE_ROOT/.toolchain/rustup-init"
  fi
  chmod +x "$NATIVE_SPACE_ROOT/.toolchain/rustup-init"
  "$NATIVE_SPACE_ROOT/.toolchain/rustup-init" -y --profile minimal --default-toolchain stable --no-modify-path
fi
if [ "${1:-}" = "--checks" ]; then
  rustup component add rustfmt clippy
fi
rustc --version
cargo --version
