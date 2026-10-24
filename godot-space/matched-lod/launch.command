#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h}"
release_binary="$project_dir/build/Space Matched LOD.app/Contents/MacOS/Space · Matched LOD"
exec "$release_binary" --resolution 1280x720 -- --result="$project_dir/results/godot-latest.json" "$@"
