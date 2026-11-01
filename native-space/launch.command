#!/bin/sh
set -eu
NATIVE_SPACE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$NATIVE_SPACE_ROOT/.."
sh "$NATIVE_SPACE_ROOT/tools/bootstrap-rust.sh"
sh "$NATIVE_SPACE_ROOT/tools/cargo.sh" fetch --locked
world=aether-archipelago
for argument in "$@"; do
  case "$argument" in --world=*) world=${argument#--world=} ;; esac
done
node "$NATIVE_SPACE_ROOT/tools/terrain.ts" "--world=$world" --radius=4
sh "$NATIVE_SPACE_ROOT/tools/bundle.sh"
open "$NATIVE_SPACE_ROOT/build/Space Native.app" --args "$@"
