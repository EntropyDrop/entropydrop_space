#!/bin/sh
set -eu
NATIVE_SPACE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$NATIVE_SPACE_ROOT/.."
sh "$NATIVE_SPACE_ROOT/tools/cargo.sh" fmt --all -- --check
sh "$NATIVE_SPACE_ROOT/tools/cargo.sh" clippy --offline --all-targets -- -D warnings
sh "$NATIVE_SPACE_ROOT/tools/cargo.sh" test --offline
./node_modules/.bin/tsc -p "$NATIVE_SPACE_ROOT/tsconfig.json"
node --test "$NATIVE_SPACE_ROOT/tests/runtime.test.ts" "$NATIVE_SPACE_ROOT/tests/rendering.test.ts" "$NATIVE_SPACE_ROOT/tests/distant-cache.test.ts"
