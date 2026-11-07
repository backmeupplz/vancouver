# Vancouver in code

An isometric Vancouver, live at https://vancouver.borodutch.com, drawn from OpenStreetMap data with three.js: every building footprint, street, beach, marina, bridge and park, with procedural trees, boats, windows and a few hand-made landmarks (BC Place, Science World, Canada Place and its cruise ships).

- `tools/fetch.sh` downloads the OSM extracts (`data/osm.json`, and `data/osm-ubc.json` with `BBOX=49.240,-123.275,49.282,-123.220 OUT=osm-ubc.json`) plus the City of Vancouver's public trees and 2009 LiDAR building footprints (not committed).
- `uv run --with numpy,pillow,scipy,rasterio python3 tools/bake.py` turns them into `public/ground-<region>[-plain].jpg`, `public/city.bin` (terrain, buildings with pitched roofs, trees, boats, bridges, the road graph) and `public/meta.json`. Terrain is MRDEM (NRCan), read straight from its cloud GeoTIFF.
- East-north-up metres, a 30° orthographic camera looking north; the view lives in the URL hash. Inspired by isoworld's [Isometric Vancouver](https://vancouver.isoworld.xyz/).
- `public/main.js` draws it with three.js: chunked meshes, billboard trees, an ink pass on the depth buffer, a shadow map fitted to the view, and rendering only when something changes. `public/code-traffic.js` simulates the traffic in a worker (lanes, junction curves, intelligent driver model, signals at major crossings).
- `public/` is the whole site; the Dockerfile serves it with nginx (Tugport `borodutch.vancouver`, auto-deploys `main`).

Map data © OpenStreetMap contributors, ODbL.
