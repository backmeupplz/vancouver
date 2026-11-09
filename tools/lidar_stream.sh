#!/bin/sh
# Starts the low-priority LiDAR massing stream (tools/lidar_stream.py) in the bake image, as its own container.
# Usage on the server: REPO=/opt/vancouver-lidar/repo tools/lidar_stream.sh   (data: /opt/vancouver-bake/data, read-only except massing_lm/;
#   OUT=<dir> streams into another folder, a rerun beside the live one)
set -e
REPO=${REPO:-$(cd "$(dirname "$0")/.." && pwd)}
DATA=${DATA:-/opt/vancouver-bake/data}
OUT=${OUT:-$DATA/massing_lm}
mkdir -p "$OUT" /opt/vancouver-bake/slots
docker build -q -t vancouver-bake-img -f "$REPO/tools/bake.Dockerfile" "$REPO/tools" >/dev/null
docker rm -f vancouver-lidar >/dev/null 2>&1 || true
exec docker run -d --name vancouver-lidar --restart unless-stopped --cpu-shares 64 --blkio-weight 10 --cpus 6 --memory 24g --memory-swap 24g \
  -e SLOTS=/slots -v /opt/vancouver-bake/slots:/slots -v "$REPO:/w" -v "$DATA:/w/data:ro" -v "$OUT:/out" -v "$DATA/lidar_lm/urls.json:/urls.json:ro" -w /w \
  vancouver-bake-img nice -n 19 python3 tools/lidar_stream.py /urls.json /out 5
