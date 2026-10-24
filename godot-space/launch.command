#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h}"
release_binary="$project_dir/build/Space Torus Tour.app/Contents/MacOS/Space · Torus Tour"
godot_binary="${GODOT_BIN:-/Applications/Godot Voxel.app/Contents/MacOS/Godot}"
if [[ -x "$release_binary" ]]; then
  exec "$release_binary" --resolution 1280x720 -- --result="$project_dir/results/godot-latest.json" "$@"
fi
exec "$godot_binary" --path "$project_dir" --resolution 1280x720 -- --result="$project_dir/results/godot-latest.json" "$@"
