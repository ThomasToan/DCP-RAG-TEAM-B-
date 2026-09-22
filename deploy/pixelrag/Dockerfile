# PixelRAG search server for the Hornsby DCP, packaged for Fly.io.
#
# Bakes in: the model weights (~4.3 GB, downloaded once at build time so the container never
# depends on Hugging Face being reachable at request time), the 489-page image index (~19 MB),
# and the rendered page PNGs (~250 MB). Caddy sits in front on the one port Fly exposes (8080)
# and routes /pages/* to a static file_server and everything else to pixelrag serve, which listens
# on 127.0.0.1 only - so the app never needs a second public port.
#
# Build from the PROJECT ROOT, not this directory, so it can COPY data/hornsby/*:
#   docker build -f deploy/pixelrag/Dockerfile -t dcp-pixelrag .
FROM caddy:2-alpine AS caddy

FROM python:3.12-slim

# libgl1/libglib2.0-0: qwen-vl-utils pulls in `av`/opencv-style image libs that expect these at
# import time even though we never touch video. Cheap to include, avoids an import-time crash.
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 curl \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy

WORKDIR /app

# CPU-only torch first, then pixelrag, then the matching CPU torchvision build. Pinned to what
# was verified working (requirements-wsl.txt): pixelrag pulls torchvision from PyPI by default,
# which does NOT match the CPU torch build and fails at embed time with
# "operator torchvision::nms does not exist" — this order and the --force-reinstall avoid that.
RUN pip install --no-cache-dir torch==2.14.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir 'pixelrag[index,serve]==0.4.0'
RUN pip install --no-cache-dir --force-reinstall --no-deps torchvision==0.29.0 --index-url https://download.pytorch.org/whl/cpu

# Bake the model files into the image layer cache, so a fresh machine never needs to hit Hugging
# Face. Deliberately just a file download (snapshot_download), NOT from_pretrained: loading the
# 4.25 GB safetensors file with from_pretrained mmaps it into memory, and Fly's remote build
# machine does not have enough RAM for that (seen: "unable to mmap ... Cannot allocate memory").
# snapshot_download only writes files to the same HF cache path from_pretrained reads later, at
# container *start* time - which runs on the real 8 GB machine (fly.toml [[vm]]), not the builder.
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-VL-Embedding-2B')"

COPY data/hornsby/index_full ./index
COPY data/hornsby/pages ./pages
COPY deploy/pixelrag/Caddyfile deploy/pixelrag/start.sh ./
RUN chmod +x start.sh

EXPOSE 8080
CMD ["./start.sh"]
