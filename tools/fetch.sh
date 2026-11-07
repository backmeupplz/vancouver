#!/bin/sh
# Downloads everything the map is built from into data/ (not committed). Needs curl, osmium (brew install osmium-tool) and uv.
#   OpenStreetMap: Geofabrik's British Columbia extract, cut to the Lower Mainland (ODbL, © OpenStreetMap contributors)
#   City of Vancouver Open Data: public trees, 2009 LiDAR building footprints (Open Government Licence – Vancouver)
#   NRCan HRDEM 2 m surface/terrain models and MRDEM 30 m terrain (Open Government Licence – Canada): tools/hrdem.py
set -e
cd "$(dirname "$0")/../data" 2>/dev/null || { mkdir -p "$(dirname "$0")/../data"; cd "$(dirname "$0")/../data"; }
[ -f bc.osm.pbf ] || curl -sS -L --fail -o bc.osm.pbf https://download.geofabrik.de/north-america/canada/british-columbia-latest.osm.pbf
osmium extract -b -123.33,48.99,-122.40,49.48 bc.osm.pbf -o lm.osm.pbf --overwrite -s smart
[ -f trees.csv ] || curl -sS --fail "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/public-trees/exports/csv?delimiter=%3B" -o trees.csv
[ -f bf2009.geojson ] || curl -sS --fail "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/building-footprints-2009/exports/geojson" -o bf2009.geojson
cd ..
uv run --with rasterio,numpy python3 tools/hrdem.py 16
