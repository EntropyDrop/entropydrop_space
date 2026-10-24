#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h}"
release_binary="$project_dir/build/Space Fine LOD.app/Contents/MacOS/Space · Fine LOD"
exec "$release_binary" --resolution 1280x720 -- --result="$project_dir/results/godot-latest.json" "$@"
