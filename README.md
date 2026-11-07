# Vancouver in code

The Lower Mainland, from the Strait of Georgia to Port Coquitlam and from White Rock to the North Shore
mountains, drawn entirely in code and rendered live in the browser with three.js: every building, street, tree,
field and dock comes from open data, at real elevations. Live at https://vancouver.borodutch.com. Inspired by
isoworld's [Isometric Vancouver](https://vancouver.isoworld.xyz/).

## How it's built

1. `tools/fetch.sh` downloads the data into `data/` (not committed): OpenStreetMap (Geofabrik's BC extract cut to
   the Lower Mainland), City of Vancouver trees and 2009 LiDAR building sections, and NRCan's HRDEM 2 m LiDAR surface
   and terrain models (`tools/hrdem.py`, resumable).
2. `uv run --with osmium,shapely,numpy python3 tools/osm_split.py` sorts the OSM extract into 4 km buckets.
3. `uv run --with numpy,scipy,pillow python3 tools/sea.py` floods the sea between the coastlines.
4. `uv run --with numpy,scipy,rasterio python3 tools/heights.py` writes a coarse height grid of the whole map.
5. `uv run --with numpy,scipy,pillow,shapely,mapbox-earcut,rasterio python3 tools/tiles.py [procs]` bakes the
   map tiles into `public/tiles/` (about 2 minutes on 9 cores, ~115 MB): 1 km detail tiles and 4 km overview tiles
   with terrain, ground polygons, roads with their node graph, buildings, trees (LiDAR canopy peaks, species from the
   city's inventory) and points like traffic signals. Buildings are OSM footprints shaped by the LiDAR surface inside
   them: up to four roof levels (podium, tower, penthouse, terraces), pitched roofs fitted to it (gable either way,
   hip, shed), rooftop plant only where it shows, the city's 2009 roof sections where they still match. Their look
   comes from OSM (material, colours, levels for the window rows, heritage, shops for storefronts) and from the
   neighbourhood: Gastown, Chinatown and Yaletown brick, West End concrete towers, downtown glass condos, Granville
   Island tin sheds, character houses (steep roofs, siding, porches) and Vancouver Specials told apart by their roofs.
   Under bridges and SkyTrain guideways the LiDAR sees the deck, so it is not used for roofs or trees there.
   Bridge decks are profiled once for the whole map (cached in `data/decks.pkl`): the low LiDAR surface across the
   deck, trusses and stay cables dropped, grades clamped to 7%; sidewalks and cycle decks ride on the road deck beside
   them, and a bridge newer than the LiDAR (stal̕əw̓asəm) spans its abutments with a gentle crest.
6. `tools/publish.sh` copies the tiles to the server. They are not in git.

## How it runs

`public/` is the site (nginx, `Dockerfile`; Tugport `borodutch/vancouver` auto-deploys `main`, with the tiles on a
volume). `public/main.js` sets up the camera, light, shadows, the ink outline pass and render-on-demand;
`public/core/` streams tiles for what is on screen, builds their geometry in Web Workers and draws ground, roads,
facades and trees with procedural shaders, crisp at any zoom. Everything else is a plugin (`public/plugins/`):
lo-fi music, live weather and sun, TransLink transit on its timetable, live aircraft, ships, landmarks and iconic
bridges, and driving, walking and sailing through it all. See [PLUGINS.md](PLUGINS.md) to write one.

Map data © OpenStreetMap contributors (ODbL). City of Vancouver Open Data. HRDEM and MRDEM © Natural Resources
Canada (Open Government Licence – Canada). Transit data © TransLink. Live aircraft: adsb.lol.
