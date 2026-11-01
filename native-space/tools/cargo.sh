#!/bin/sh
set -eu
NATIVE_SPACE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$NATIVE_SPACE_ROOT/tools/rust-env.sh"
cd "$NATIVE_SPACE_ROOT"
exec cargo "$@"
