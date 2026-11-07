#!/bin/sh
# Rebakes the map on hetzner-main, straight into the live `vancouver-tiles` volume (no upload from here).
# Usage: tools/remote-bake.sh [branch]   (default main; FRESH=1 re-downloads OSM and city data; PROCS=n)
# Runs at the lowest CPU/IO priority with 4 workers by default; follow it with:
#   ssh root@148.251.0.158 docker logs -f vancouver-bake
set -eu
BRANCH=${1:-main}
ssh root@148.251.0.158 "set -e
  mkdir -p /opt/vancouver-bake && cd /opt/vancouver-bake
  [ -d repo ] || git clone -q https://git.borodutch.com/backmeupplz/vancouver.git repo
  cd repo && git fetch -q origin && git checkout -q -B bake origin/$BRANCH && cd ..
  docker build -q -t vancouver-bake -f repo/tools/bake.Dockerfile repo/tools >/dev/null
  docker rm -f vancouver-bake >/dev/null 2>&1 || true
  docker run -d --name vancouver-bake --cpu-shares 64 --blkio-weight 10 \
    -e PROCS=${PROCS:-4} -e FRESH=${FRESH:-0} \
    -v /opt/vancouver-bake/repo/tools:/w/tools:ro -v /opt/vancouver-bake/data:/w/data -v /opt/vancouver-bake/out:/w/out \
    -v /opt/vancouver-bake/cache:/cache -v vancouver-tiles:/tiles \
    vancouver-bake nice -n 19 sh tools/bake-all.sh"
echo "started; follow with: ssh root@148.251.0.158 docker logs -f vancouver-bake"
