#!/bin/sh
# Downloads the OSM extract the map is built from (ODbL, © OpenStreetMap contributors).
set -e
cd "$(dirname "$0")/../data"
# main region by default; BBOX=49.240,-123.275,49.282,-123.220 OUT=osm-ubc.json for UBC
BBOX="${BBOX:-49.232,-123.172,49.318,-123.080}"
Q="[out:json][timeout:300];(
 way[\"natural\"=\"coastline\"]($BBOX);
 nwr[\"natural\"~\"water|wood|beach|sand|scrub|grassland|wetland\"]($BBOX);
 nwr[\"landuse\"~\"forest|grass|recreation_ground|cemetery|meadow|railway|industrial|commercial|retail|residential|construction|brownfield\"]($BBOX);
 nwr[\"leisure\"~\"park|pitch|golf_course|marina|garden|playground|stadium|swimming_pool|track\"]($BBOX);
 nwr[\"water\"]($BBOX);
 way[\"highway\"]($BBOX);
 way[\"railway\"~\"rail|light_rail|subway\"]($BBOX);
 way[\"man_made\"~\"pier|breakwater\"]($BBOX);
 nwr[\"building\"]($BBOX);
 nwr[\"building:part\"]($BBOX);
);out geom qt;"
curl -sS --fail -A "vancouver-map-builder/1.0" --data-urlencode "data=$Q" ${OVERPASS:-https://overpass.private.coffee/api/interpreter} -o "${OUT:-osm.json}"
ls -lh "${OUT:-osm.json}"
# City of Vancouver open data: public trees (genus, height) and 2009 LiDAR building footprints (heights, roof type)
[ -f trees.csv ] || curl -sS --fail "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/public-trees/exports/csv?delimiter=%3B" -o trees.csv
[ -f bf2009.geojson ] || curl -sS --fail "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/building-footprints-2009/exports/geojson" -o bf2009.geojson
# surface car parks (rows of parked cars, no trees)
for spec in "49.232,-123.172,49.318,-123.080 parking.json" "49.240,-123.275,49.282,-123.220 parking-ubc.json"; do
  set -- $spec
  [ -f "$2" ] || curl -sS --fail -A "vancouver-map-builder/1.0" --data-urlencode "data=[out:json][timeout:120];nwr[\"amenity\"=\"parking\"][\"parking\"!~\"underground|multi-storey\"]($1);out geom qt;" https://overpass-api.de/api/interpreter -o "$2"
done
