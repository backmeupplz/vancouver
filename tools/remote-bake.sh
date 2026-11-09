#!/bin/sh
# Rebakes the map on hetzner-main, straight into the live `vancouver-tiles` volume (no upload from here).
# Usage: tools/remote-bake.sh [branch]   (default main; FRESH=1 re-downloads OSM and city data; PROCS=n;
#   FORCE_PUBLISH=1 publishes even with geometry defects left — the gate in bake-all.sh refuses otherwise)
# Runs at the lowest CPU/IO priority with up to 10 workers (fewer while production is busy: tools/common.py cpu_slot,
# whose slots in /opt/vancouver-bake/slots the LiDAR stream shares); incremental (FORCE=1 rebakes every tile). Follow it with:
#   ssh root@148.251.0.158 docker logs -f vancouver-bake
set -eu
BRANCH=${1:-main}
ssh root@148.251.0.158 "set -e
  mkdir -p /opt/vancouver-bake && cd /opt/vancouver-bake
  [ -d repo ] || git clone -q https://git.borodutch.com/backmeupplz/vancouver.git repo
  cd repo && git fetch -q origin && git checkout -q -B bake origin/$BRANCH && cd ..
  docker build -q -t vancouver-bake -f repo/tools/bake.Dockerfile repo/tools >/dev/null
  docker rm -f vancouver-bake >/dev/null 2>&1 || true
  docker run -d --name vancouver-bake --cpu-shares 64 --blkio-weight 10 --memory 24g --memory-swap 24g \
    -e PROCS=${PROCS:-10} -e FRESH=${FRESH:-0} -e FORCE=${FORCE:-0} -e FORCE_PUBLISH=${FORCE_PUBLISH:-0} -e SLOTS=/slots -v /opt/vancouver-bake/slots:/slots \
    -v /opt/vancouver-bake/repo/tools:/w/tools:ro -v /opt/vancouver-bake/repo/public:/w/public:ro -v /opt/vancouver-bake/data:/w/data -v /opt/vancouver-bake/out:/w/out \
    -v /opt/vancouver-bake/cache:/cache -v vancouver-tiles:/tiles \
    vancouver-bake nice -n 19 sh tools/bake-all.sh"
echo "started; follow with: ssh root@148.251.0.158 docker logs -f vancouver-bake"
