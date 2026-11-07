#!/bin/sh
# City of Vancouver 2022 orthophoto (7.5 cm ECW tiles, 800 x 500 m each) -> 0.5 m JPEG COGs in data/ortho/tif/, which
# tools/roofs.py reads. Drop more <tile>.ecw (or the <tile>.zip they come in) into data/ortho/ and run this again: tiles
# already converted are skipped. ECW needs the libecwj2 plugin, so GDAL runs in podman (tools/ortho.Dockerfile).
# Run from the repo root: tools/ortho.sh [metres per pixel, default 0.5]
set -e
RES=${1:-0.5}
cd data/ortho
for z in *.zip; do [ -e "$z" ] && [ ! -e "${z%.zip}.ecw" ] && unzip -qn "$z" '*.ecw' || true; done
podman image exists vancouver-ortho || podman build -t vancouver-ortho -f ../../tools/ortho.Dockerfile ../../tools
mkdir -p tif
# one container for all tiles; 4 at a time (the podman VM has little memory, and ECW decoding is cheap at 0.5 m)
podman run --rm -v "$PWD":/o -w /o -e RES="$RES" vancouver-ortho sh -c '
  ls *.ecw | sed "s/\.ecw$//" | while read t; do [ -s tif/$t.tif ] || echo $t; done |
  xargs -r -P 4 -I{} sh -c "gdal_translate -q -of COG -a_srs EPSG:3157 -tr $RES $RES -r average \
    -co COMPRESS=JPEG -co QUALITY=88 -co OVERVIEWS=NONE {}.ecw tif/{}.tmp.tif && mv tif/{}.tmp.tif tif/{}.tif && echo {}"'
ls tif/*.tif | wc -l
