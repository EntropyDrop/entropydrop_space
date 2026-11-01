#!/bin/sh
# Source from a script that has already set NATIVE_SPACE_ROOT.
export CARGO_HOME="$NATIVE_SPACE_ROOT/.toolchain/cargo"
export RUSTUP_HOME="$NATIVE_SPACE_ROOT/.toolchain/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
