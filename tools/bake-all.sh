#!/bin/sh
# The whole map bake, start to finish, inside the bake container (tools/bake.Dockerfile):
# fetch → split → sea → heights → tiles, into /w/out, then swap into /tiles (the live volume), index.json last.
# Incremental: every stage keys its output on what it read (data/feat.key, data/sea.npz.key, data/decks.pkl,
# out/manifest.json per 4 km tile, out/heights.bin.key) and skips what is up to date; only the tiles whose bytes
# changed are copied, and index.json gives each its own ?v=. FORCE=1 rebakes every tile anyway.
# Downloads are kept in /w/data between runs; pass FRESH=1 to re-download OpenStreetMap and the city data.
# PROCS caps the workers; tools/common.py cpu_slot runs fewer while the rest of the machine is busy.
set -euf  # (f: the rsync excludes below stay patterns)
cd /w
P=${PROCS:-10}
mkdir -p data out
if [ "${FRESH:-0}" = 1 ]; then rm -f data/bc.osm.pbf data/trees.csv data/bf2009.geojson; fi
[ -f data/bc.osm.pbf ] || curl -sS -L --fail -o data/bc.osm.pbf https://download.geofabrik.de/north-america/canada/british-columbia-latest.osm.pbf
[ data/lm.osm.pbf -nt data/bc.osm.pbf ] || osmium extract -b -123.33,48.99,-122.40,49.48 data/bc.osm.pbf -o data/lm.osm.pbf --overwrite -s smart
[ -f data/trees.csv ] || curl -sS --fail "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/public-trees/exports/csv?delimiter=%3B" -o data/trees.csv
[ -f data/bf2009.geojson ] || curl -sS --fail "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/building-footprints-2009/exports/geojson" -o data/bf2009.geojson
python3 tools/hrdem.py "$P"           # resumable: only missing LiDAR tiles are fetched
python3 tools/osm_split.py
python3 tools/sea.py
[ -f data/roofs.npz ] || echo "no data/roofs.npz (tools/roofs.py): roofs keep their palette colours"
[ -f data/beachlogs.npz ] || echo "no data/beachlogs.npz (tools/beachlogs.py): no driftwood, lifeguard towers or volleyball nets on the beaches"
[ -f data/facades.npz ] || echo "no data/facades.npz (tools/facades.py): walls keep their palettes and the page's own rules"
OUT=out python3 tools/tiles.py "$P"   # also caches data/mrdem32.npz, which heights.py needs
OUT=out python3 tools/heights.py      # writes out/index.json, last
# the gate: every geometry rule (tools/geom_rules.py: the bake's own, the old audits, what the page draws) at zero, or
# nothing is published (the offenders printed, with view hashes); FORCE_PUBLISH=1 publishes anyway
if ! python3 tools/geom_rules.py out "$P" --gate; then
  [ "${FORCE_PUBLISH:-0}" = 1 ] || { echo "not published: geometry defects left (FORCE_PUBLISH=1 to publish anyway)"; exit 1; }
  echo "FORCE_PUBLISH=1: publishing with geometry defects left"
fi
# swap in: new tiles first, then the index that points browsers at them, then drop tiles no longer baked
X="--exclude index.json --exclude manifest.json --exclude rules.json --exclude *.key --exclude *.tmp"
rsync -a $X out/ /tiles/
cp out/index.json /tiles/index.json
rsync -a --delete $X --exclude heights.bin out/0/ /tiles/0/
rsync -a --delete $X out/1/ /tiles/1/
echo "baked $(ls out/0 | wc -l) detail and $(ls out/1 | wc -l) overview tiles"
