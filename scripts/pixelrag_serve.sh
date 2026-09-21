#!/bin/bash
# Start PixelRAG's search API over a built index. Run from the project root inside WSL:
#   wsl --cd <project> -- bash scripts/pixelrag_serve.sh [index_dir] [port]
# Then:  curl -X POST localhost:30001/search -d '{"queries":[{"text":"..."}],"n_docs":5}'
# The query is embedded with the SAME model that built the index (base Qwen3-VL-Embedding-2B, no adapter): mixing
# models between index and query would make the similarity scores meaningless.
source "$HOME/dcp-venv/bin/activate"
IDX="${1:-data/hornsby/index_sample}"
exec pixelrag serve \
  --index-dir "$IDX" \
  --tiles-dir "$IDX/tiles" \
  --articles-json "$IDX/articles.json" \
  --model Qwen/Qwen3-VL-Embedding-2B \
  --device cpu \
  --host 127.0.0.1 \
  --port "${2:-30001}"
