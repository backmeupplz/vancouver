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
5. `uv run --with numpy,scipy,pillow,shapely,rasterio python3 tools/tiles.py [procs]` bakes the
   map tiles into `public/tiles/` (about 2 minutes on 9 cores, ~115 MB): 1 km detail tiles and 4 km overview tiles
   with terrain, ground polygons, roads with their node graph, buildings, trees (LiDAR canopy peaks, species from the
   city's inventory picking one of nine low-poly forms (round, columnar, spreading, weeping, vase, fir, cedar, pine, palm; the
   cultivar and the LiDAR crown's shape refine it), crowns as wide as the canopy each owns, trunks never on a carriageway or a sidewalk's walking zone:
   `tools/audit_trunks.py public/tiles` counts any left), marina docks with boats at their berths and points like traffic signals. Buildings are OSM footprints shaped by the LiDAR surface inside
   them: up to four roof levels (podium, tower, penthouse, terraces), pitched roofs fitted to it (gable either way,
   hip, shed), rooftop plant only where it shows, the city's 2009 roof sections where they still match. Their look
   comes from OSM (material, colours, levels for the window rows, heritage, shops for storefronts) and from the
   neighbourhood: Gastown, Chinatown and Yaletown brick, West End concrete towers, downtown glass condos, Granville
   Island tin sheds, character houses (steep roofs, siding, porches) and Vancouver Specials told apart by their roofs.
   Under bridges and SkyTrain guideways the LiDAR sees the deck, so it is not used for roofs or trees there.
   Bridge decks are profiled once for the whole map (cached in `data/decks3.pkl`): the low LiDAR surface across the
   deck, trusses and stay cables dropped, grades clamped to 7%; sidewalks and cycle decks ride on the road deck beside
   them, and a bridge newer than the LiDAR (stal̕əw̓asəm) or a footbridge under the trees (the LiDAR sees their crowns)
   spans its abutments. Where a street goes on from a raised deck end (OpenStreetMap's bridge tag stops short of the
   structure, stairs come down off a footbridge) it follows the LiDAR down to the ground at a ramp's grade. A road or rail
   deck end that nothing goes on from comes down to the ground at 7%. The terrain
   is an 8 m grid in detail tiles, so streets sit on their embankments and in their cuts; piers and seawalls in the sea
   keep their height. `tools/audit_elev.py public/tiles` checks a bake: streets off the ground, decks through
   buildings, steps at abutments, steep or buried decks, tunnels on the surface (worst first, with view links).
   Roofs take their colour from the city's 2022 orthophoto: put its ECW tiles (7.5 cm, 800 x 500 m each) in
   `data/ortho/`, `tools/ortho.sh` turns them into 0.5 m GeoTIFFs (GDAL with the open libecwj2 3.3 plugin, in podman) and
   `uv run --with numpy,scipy,pillow,shapely,rasterio python3 tools/roofs.py` samples every footprint into
   `data/roofs.npz` (`tools/roofs.py preview` draws photo vs colours). Only roofs.npz is needed to bake.
   Walls follow the real buildings where the data knows them (`tools/facades.py` → `data/facades.npz`, optional): the
   city's property tax report gives every building its year built, which picks 1960s-80s concrete towers with solid
   balcony fronts on their long sides, 1990s green glass with glass balconies all round, window walls after 2005, and
   window bands on old concrete offices; the heritage register marks the old brick and stone. The city's 2022 LiDAR
   (coloured points, 1 km tiles listed in `data/lidar2022/urls.json`, downloaded by hand into `data/lidar2022/` and
   unzipped into `las/`) gives the storey height from the rhythm of the floors on the walls;
   Mapillary street photos (`tools/mapillary.py`, token through the vault, CC BY-SA 4.0) give wall colours seen from
   the street; a short list of landmarks (`LOOKS`) is set by hand from public photos.
6. `tools/publish.sh` copies the tiles to the server. They are not in git.

## How it runs

`public/` is the site (nginx, `Dockerfile`; Tugport `borodutch/vancouver` auto-deploys `main`, with the tiles on a
volume). `public/main.js` sets up the camera, light, shadows, the ink outline pass and render-on-demand;
`public/core/` streams tiles for what is on screen, builds their geometry in Web Workers and draws ground, roads,
facades and trees with procedural shaders, crisp at any zoom. Detail stays where it shows: the ground follows the terrain to
25 cm on the map and to 5 cm up close (zoom 0.3 and street level), and each wall's balcony fronts and railings are one
sheet the shader draws every floor on. `public/core/quality.js` picks High or Low graphics
(About → Graphics: Auto, High, Low) and the frame loop lowers the resolution while frames run late. Everything else is a plugin (`public/plugins/`):
lo-fi music, live weather and sun, TransLink transit on its timetable, live aircraft, ships, landmarks and iconic
bridges, and driving (parcel deliveries too, or a bus on a real TransLink route and timetable, with a GPS line, stops, riders and
trolley wires), walking, hiking real trails and sailing through it all. See
[PLUGINS.md](PLUGINS.md) to write one.

Map data © OpenStreetMap contributors (ODbL). City of Vancouver Open Data; 2022 orthophoto and LiDAR, property tax
report and heritage register © City of Vancouver (Open Government Licence – Vancouver). Street photos: Mapillary
contributors (CC BY-SA 4.0). HRDEM and MRDEM © Natural Resources Canada (Open Government Licence – Canada).
Transit data © TransLink. Live aircraft: adsb.lol.
