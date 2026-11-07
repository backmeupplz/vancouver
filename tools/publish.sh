#!/bin/sh
# Copies the baked tiles to the live site: public/tiles → the `vancouver-tiles` volume on hetzner-main, which the
# Tugport service `borodutch/vancouver` mounts at /usr/share/nginx/html/tiles. index.json goes last, so visitors
# switch to a new bake only once all of its tiles are there (tile URLs carry the bake's ?v=).
set -e
cd "$(dirname "$0")/.."
DEST=root@148.251.0.158:/var/lib/docker/volumes/vancouver-tiles/_data/
rsync -a --exclude index.json public/tiles/ "$DEST"
rsync -a public/tiles/index.json "$DEST"
