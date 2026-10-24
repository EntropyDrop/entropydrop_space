#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h}"
godot_binary="${GODOT_BIN:-/Applications/Godot Voxel.app/Contents/MacOS/Godot}"
cd "$project_dir/.."
node godot-space/tools/export-torus.ts --workers=2 --world="${1:-copper-metropolis}"
"$godot_binary" --headless --path "$project_dir" --script tools/bake-torus.gd
