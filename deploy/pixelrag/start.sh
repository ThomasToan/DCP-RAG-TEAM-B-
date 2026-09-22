#!/bin/bash
# One public port (Caddy, 8080) in front of two internal-only things: the PixelRAG search API
# (127.0.0.1:8090) and the rendered DCP page images (served by Caddy itself from ./pages). If
# either process exits, stop the container rather than limping along on half a service.
set -e

pixelrag serve \
	--index-dir ./index \
	--tiles-dir ./index/tiles \
	--articles-json ./index/articles.json \
	--model Qwen/Qwen3-VL-Embedding-2B \
	--device cpu \
	--host 127.0.0.1 \
	--port 8090 &
SEARCH_PID=$!

caddy run --config ./Caddyfile --adapter caddyfile &
CADDY_PID=$!

wait -n "$SEARCH_PID" "$CADDY_PID"
exit $?
