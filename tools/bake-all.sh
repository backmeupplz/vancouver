#!/bin/sh
# The whole map bake, start to finish, inside the bake container (tools/bake.Dockerfile):
# fetch → split → sea → heights → tiles, into /w/out, then swap into /tiles (the live volume), index.json last.
# Downloads are kept in /w/data between runs; pass FRESH=1 to re-download OpenStreetMap and the city data.
set -eu
cd /w
P=${PROCS:-4}
mkdir -p data out
if [ "${FRESH:-0}" = 1 ]; then rm -f data/bc.osm.pbf data/trees.csv data/bf2009.geojson; fi
[ -f data/bc.osm.pbf ] || curl -sS -L --fail -o data/bc.osm.pbf https://download.geofabrik.de/north-america/canada/british-columbia-latest.osm.pbf
osmium extract -b -123.33,48.99,-122.40,49.48 data/bc.osm.pbf -o data/lm.osm.pbf --overwrite -s smart
[ -f data/trees.csv ] || curl -sS --fail "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/public-trees/exports/csv?delimiter=%3B" -o data/trees.csv
[ -f data/bf2009.geojson ] || curl -sS --fail "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/building-footprints-2009/exports/geojson" -o data/bf2009.geojson
python3 tools/hrdem.py "$P"           # resumable: only missing LiDAR tiles are fetched
python3 tools/osm_split.py
python3 tools/sea.py
[ -f data/roofs.npz ] || echo "no data/roofs.npz (tools/roofs.py): roofs keep their palette colours"
[ -f data/facades.npz ] || echo "no data/facades.npz (tools/facades.py): walls keep their palettes and the page's own rules"
rm -rf out/0 out/1
OUT=out python3 tools/tiles.py "$P"   # also caches data/mrdem32.npz, which heights.py needs
OUT=out python3 tools/heights.py
# swap in: new tiles first, then the index that points browsers at them, then drop tiles no longer baked
rsync -a --exclude index.json out/ /tiles/
cp out/index.json /tiles/index.json
rsync -a --delete --exclude index.json --exclude heights.bin out/0/ /tiles/0/
rsync -a --delete out/1/ /tiles/1/
echo "baked $(ls out/0 | wc -l) detail and $(ls out/1 | wc -l) overview tiles"
