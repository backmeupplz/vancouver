#!/bin/sh
# Downloads the OSM extract the map is built from (ODbL, © OpenStreetMap contributors).
set -e
cd "$(dirname "$0")/../data"
BBOX="49.232,-123.172,49.318,-123.080"
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
curl -sS --fail -A "vancouver-map-builder/1.0" --data-urlencode "data=$Q" ${OVERPASS:-https://overpass.private.coffee/api/interpreter} -o osm.json
ls -lh osm.json
