#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h}"
godot_binary="${GODOT_BIN:-/Applications/Godot Voxel.app/Contents/MacOS/Godot}"
mkdir -p "$project_dir/build"
"$godot_binary" --headless --path "$project_dir" --export-release macOS
