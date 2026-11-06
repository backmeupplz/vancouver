# Vancouver in code

An isometric Vancouver, live at https://vancouver.borodutch.com, drawn from OpenStreetMap data with three.js: every building footprint, street, beach, marina, bridge and park, with procedural trees, boats, windows and a few hand-made landmarks (BC Place, Science World, Canada Place and its cruise ships).

- `tools/fetch.sh` downloads the OSM extract into `data/osm.json` (not committed).
- `uv run --with numpy,pillow,scipy python3 tools/bake.py` turns it into `public/ground.jpg` (the ground texture), `public/city.bin` (packed buildings, trees, boats, bridge decks) and `public/meta.json`.
- `public/` is the whole site; the Dockerfile serves it with nginx (Tugport `borodutch.vancouver`, auto-deploys `main`).

Map data © OpenStreetMap contributors, ODbL.
