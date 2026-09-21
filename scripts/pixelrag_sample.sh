#!/bin/bash
# Build a small PixelRAG index over rendered page PNGs and time it. Run from the project root inside WSL:
#   wsl --cd <project> -- bash scripts/pixelrag_sample.sh [source_dir] [output_dir]
set -u
SRC="${1:-data/hornsby/sample/pages}"
OUT="${2:-data/hornsby/index_sample}"
source "$HOME/dcp-venv/bin/activate"
echo "source=$SRC output=$OUT  files: $(ls "$SRC" | wc -l)"
echo "start: $(date +%T)"
START=$(date +%s)
pixelrag index build --source "$SRC" --source-type local --output "$OUT" --device cpu --force 2>&1
CODE=$?
END=$(date +%s)
echo "exit code: $CODE   elapsed: $((END-START)) s   ($(date +%T))"
echo "--- output directory ---"
find "$OUT" -maxdepth 3 -type f 2>/dev/null | head -40
du -sh "$OUT" 2>/dev/null
echo "--- HF cache size ---"
du -sh "$HOME/.cache/huggingface" 2>/dev/null
