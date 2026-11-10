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
   hip, shed), rooftop plant only where it shows (and the small HVAC units, penthouses and skylights its 2 m grid misses,
   placed by the page), planted roofs (the orthophoto, OSM `roof:garden`), rooftop pools (outdoor OSM pools over a roof)
   and solar panels (OSM `generator:source=solar`), the city's 2009 roof sections where they still match. Their look
   comes from OSM (material, colours, levels for the window rows, heritage, shops for storefronts) and from the
   neighbourhood: Gastown, Chinatown and Yaletown brick, West End concrete towers, downtown glass condos, Granville
   Island tin sheds, character houses (steep roofs, siding, porches) and Vancouver Specials told apart by their roofs.
   The page lays each wall's windows out in whole bays (none cut by a corner), gives houses a front door on the wall
   facing the street, gable ends shingles and an attic window, porch roofs their posts, Specials their front balcony
   railing and storefronts awnings; on a slope each wall goes down to its own ground (the shop on the low street).
   Under bridges and SkyTrain guideways the LiDAR sees the deck, so it is not used for roofs or trees there.
   Bridge decks are profiled once for the whole map (cached in `data/decks.pkl`): the low LiDAR surface across the
   deck, trusses and stay cables dropped, grades clamped to 7%; sidewalks and cycle decks ride on the road deck beside
   them, and a bridge newer than the LiDAR (stal̕əw̓asəm) or a footbridge under the trees (the LiDAR sees their crowns)
   spans its abutments. Where a street goes on from a raised deck end (OpenStreetMap's bridge tag stops short of the
   structure, stairs come down off a footbridge) it follows the LiDAR down to the ground at a ramp's grade; a path that goes
   on from a footbridge's end down on the ground (OpenStreetMap maps no stairs there) gets stairs down along it. Then one
   solve per structure (`deck_solve`: a linear program over every deck, approach and tunnel beside them, on 4 m samples,
   the structures in parallel and the same every run)
   gives each its one height profile: as near the LiDAR as it can, one height where ways meet, one surface where decks are
   drawn over each other (else stacked 3.2 m apart; where the LiDAR's call can't hold, a MILP over the structure decides
   which: first each such stretch as the solved heights make it, solved again, then on a smaller structure a MILP bounded
   in nodes, not seconds), tunnels joined where they meet a deck, no steeper than its grade, on the ground where a street goes on at
   grade (and at a road's or rail's dead end), never under the ground, 3 m clear over the streets under it. The deck,
   its paint, the traffic and the van all read that profile. Roads up on a building (a mall's rooftop
   parking, a parkade's top deck: layer or level 1 and up, mostly over a footprint, the LiDAR well above the ground) are
   decks on its roof, joined to their ramps. Tunnels run under the ground from portal to portal (straight where the ground
   is high over them, else with the roof under it, no steeper than a ramp); near a portal, where the roof isn't under the
   ground, the ground is cut and the page draws the tunnel's concrete box and portal face, and the whole way a dark tube
   round the road, so traffic, walkers and the van go through. Raised decks have railings along their edges. The terrain
   is an 8 m grid in detail tiles (plus, under the streets where it can't follow them, 2 m offsets: section TFIN), so
   streets sit on their embankments and in their cuts, fitted to the streets and
   rail lines (where an 8 m point lands in the cut, ravine or yard beside a street, the grid round it moves so the
   drawn ground under the street is the LiDAR's); piers and seawalls in the sea keep their height. SkyTrain guideways
   take the structure the LiDAR sees beside their line where OpenStreetMap draws it a few metres off (at stations),
   long pieces (a bridge's span, one 1.5 km way on the Lions Gate) are cut at the detail tiles' edges so each tile has
   the part over it (the next tiles' decks reaching over a tile come with it, XDCK: the page leaves out what of its own
   strips they cover and paints nothing under them), and busways are bus-only streets. `tools/geom_rules.py public/tiles` checks a bake against every
   geometry rule (one registry: buildings on the ground, not in each other, streets and decks through them as passages
   (one predicate, `through_hit`, for the bake's fix and the audit's 'clash'); decks one
   surface, no steps, not too steep; paint, traffic lanes and crosswalks on what they are drawn on; poles, trees, beach
   logs clear of streets, buildings and each other; the ground one layer without seams; and `tools/audit_elev.py`'s
   streets off the ground, steps at abutments, buried decks, tunnels), each rule's worst with view links; the bake fixes
   what it can and `tools/bake-all.sh` publishes only with every rule at zero (`FORCE_PUBLISH=1` overrides). `node tools/drive_check.mjs` checks it for driving: the drive plugin's own physics runs headless on the
   tiles with an autopilot driving the 12 m or 18 m bus along every bus route each way and the van along the arterials
   from a grid across the map (`--routes 99,R4`, `--grid 3000`, `--tiles <dir>` for another bake, `--out file.json`),
   and logs every height jump, stuck vehicle, building or railing hit on the road, tilt, drop off a deck, deck through
   the vehicle, GPS line or bus stop off the road, with view links.
   Roofs take their colour from the city's 2022 orthophoto: put its ECW tiles (7.5 cm, 800 x 500 m each) in
   `data/ortho/`, `tools/ortho.sh` turns them into 0.5 m GeoTIFFs (GDAL with the open libecwj2 3.3 plugin, in podman) and
   `uv run --with numpy,scipy,pillow,shapely,rasterio python3 tools/roofs.py` samples every footprint into
   `data/roofs.npz` (`tools/roofs.py preview` draws photo vs colours). Only roofs.npz is needed to bake.
   The beaches get their driftwood from the same photo: `tools/beachlogs.py` cuts the beaches from the ECW tiles at
   12.5 cm (podman again), finds every log on the dry sand (a bright straight stripe with its shadow) and writes
   `data/beachlogs.npz`; beyond the photo (the North Shore, White Rock, Crescent Beach...) it lays logs in rows along
   the shore, and adds lifeguard towers on the guarded beaches and nets on the volleyball courts
   (`tools/beachlogs.py preview kits|english|spanish` draws what it found over the photo). Optional to bake.
   The seawalls are found, not listed (`uv run --with numpy,scipy,shapely,osmium python3 tools/seawall.py` →
   `data/seawalls.npz`, optional): a stretch of coastline (or a beach's landward edge) is a seawall where a paved walk runs
   along it within a few metres, the LiDAR ground at the walk stands well over the water or sand and comes up to the
   edge (Stanley Park, Coal Harbour, English Bay, False Creek, Kits, Canada Place, the North Shore's seawalks...). Each
   run is fitted to the LiDAR: its line where the ground comes up to the walk, its top the smoothest that stays within a
   metre of the ground at its paths, its walk as far in as one top fits (the walk and its bike lane), the water or sand
   at its foot flat. Toward a run's ends the walk first sinks to the terrain on it, then blends into the terrain. Paths
   along a wall that OSM maps out over its edge are moved in onto the walk, and paths across one (stairs, ramps) end at
   its edge (`tools/tiles.py off_walls`). The page draws the ground so over the 8 m terrain (`core/util.js wallHeight`, for
   walkers, people and the drawn ground alike) and a stone face with a coping, and a railing where OSM maps one. The same
   step puts the picnic tables, bins, fountains, washrooms and concession stands OSM maps by the beaches and walks among
   the logs.
   Walls follow the real buildings where the data knows them (`tools/facades.py` → `data/facades.npz`, optional): the
   city's property tax report gives every building its year built, which picks 1960s-80s concrete towers with solid
   balcony fronts on their long sides, 1990s green glass with glass balconies all round, window walls after 2005, and
   window bands on old concrete offices; the heritage register marks the old brick and stone. The city's 2022 LiDAR
   (coloured points, 1 km tiles listed in `data/lidar2022/urls.json`, downloaded by hand into `data/lidar2022/` and read
   one at a time out of their zips) gives the storey height from the rhythm of the floors on the walls;
   the same LiDAR gives the massing where it covers (`uv run --with numpy,scipy,shapely,pyproj,rasterio python3
   tools/lidar_massing.py` → `data/massing22.npz`, optional; tiles.py falls back to the HRDEM levels): each building
   sliced every metre up into parts fitted to its outline at that height (setbacks, podiums and towers, chamfers, curves,
   twists, overhangs such as Harbour Centre's lookout from the wall points), domes and sloped tops, masts and spires,
   rooftop plant, and each wall's own look (`tools/lidar_walls.py`): the rhythm of the returns on its plane gives the
   window bay and the storey height and how much of each the window fills, which rhythm is there gives the glazing
   (punched windows, vertical strips, ribbon bands, a curtain wall where glass returns little, a blank wall), and the
   returns' laser intensity (on one scale across flights) dark or light spandrels; the rest of the Lower Mainland gets the same massing
   and wall looks from the open regional sets, streamed a tile at a time (`tools/lidar_stream.sh` → `lidar_massing.py
   tile`, then `merge` → `data/massing_lm.npz`; the thresholds follow each set's density). The page draws each wall's
   look; walls no LiDAR saw keep the era, heritage and zone patterns;
   Mapillary street photos (`tools/mapillary.py`, token through the vault, CC BY-SA 4.0) give wall colours seen from
   the street; a short list of landmarks (`LOOKS`) is set by hand from public photos.
   Landmarks get a mesh of their own from LiDAR (`uv run --with numpy,scipy,shapely,pyproj,rasterio,scikit-image,fast-simplification,laspy[lazrs]
   python3 tools/landmark_scan.py [ids]` → `public/plugins/landmarks/data/`, in git): the City's 2022 tiles (zips
   unzipped one at a time), outside the City the few open-LiDAR tiles round each (`data/lidar_lm/urls.json`), sliced as
   above, marching cubes, decimated to a few thousand flat triangles plus a quarter-detail copy, coloured by a palette
   per height; the landmarks plugin loads each as the view nears it and draws its footprint massing further off.
6. `tools/publish.sh` copies the tiles to the server. They are not in git.

## How it runs

`public/` is the site (nginx, `Dockerfile`; Tugport `borodutch/vancouver` auto-deploys `main`, with the tiles on a
volume). `public/main.js` sets up the camera, light, shadows, the ink outline pass and render-on-demand;
`public/core/` streams tiles for what is on screen, builds their geometry in Web Workers and draws ground, roads,
facades and trees with procedural shaders, crisp at any zoom. Detail stays where it shows: the ground follows the terrain to
25 cm on the map and to 5 cm up close (zoom 0.3 and street level), its polygons welded where they meet so no crack opens between them, and each wall's balcony fronts and railings are one
sheet the shader draws every floor on. Parking lots and kerbs get parked cars, and walls a soft shade on the ground at
their feet. At night street lamps (OpenStreetMap's, else placed along the lit streets) and the storefronts facing a
street throw pools of light: each a soft disc drawn from above into one small texture over the view (`core/lights.js`)
that the ground, roads and wall feet look up. `public/core/quality.js` picks High or Low graphics
(About → Graphics: Auto, High, Low) and the frame loop lowers the resolution while frames run late. Everything else is a plugin (`public/plugins/`):
lo-fi music, live weather and sun, TransLink transit on its timetable, live aircraft, ships, landmarks and iconic
bridges, and driving (parcel deliveries too, or a bus on a real TransLink route and timetable, with a GPS line, stops, riders and
trolley wires, or Rush Fare: an arcade cab shift against the clock with six cabs, nitro, drifts and stunt ramps), walking,
hiking real trails and sailing through it all. See
[PLUGINS.md](PLUGINS.md) to write one.

Locally, `docker compose up --build` serves the site at http://localhost:48500 with `public/` mounted (edits show on
reload) and the live service (`server/`, visitor counts, multiplayer, chat) behind `/live` as in production.
`docker compose --profile bake run --rm bake` runs the whole bake (`tools/bake-all.sh`, `PROCS=n`, `FRESH=1`) into
`public/tiles`. It is incremental: each stage and each 4 km tile is keyed on what it reads (its OSM bucket and LiDAR,
the data rows under it, the code it runs: `out/manifest.json`, `data/*.key`) and is skipped when that is unchanged, so
a rebake with nothing new takes a couple of minutes and a new `data/roofs.npz` redoes only the tiles whose rows in it changed;
`FORCE=1` rebakes every tile. Only changed tiles are copied, each with its own `?v=` in `index.json`.

Map data © OpenStreetMap contributors (ODbL). City of Vancouver Open Data; 2022 orthophoto and LiDAR, property tax
report and heritage register © City of Vancouver (Open Government Licence – Vancouver). Street photos: Mapillary
contributors (CC BY-SA 4.0). HRDEM and MRDEM © Natural Resources Canada (Open Government Licence – Canada).
Transit data © TransLink. Rendering techniques adapted from [Slop Toronto](https://sloptoronto.ca/) / Slop New York (MIT, © Mr.doob, John
Fewell; see [THIRD_PARTY.md](THIRD_PARTY.md)): the camera look per time of day and the bloom (`core/look.js`), walls by
what they face, the canyon shade, street-light placement. Live aircraft: adsb.lol.
