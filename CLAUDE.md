# Vancouver in code: notes for coding agents

Stylized (flat-shaded, ink outlines), true-to-reality three.js Lower Mainland. README.md explains the bake and the
look; PLUGINS.md is the plugin contract. Read the parts you need, not the whole files.

## Keep your context small (every turn re-reads all of it)
- Find before you read: `grep -n` for the symbol, then read only that range (`sed -n 'a,bp'` or Read with
  offset/limit). Never read a 1000+ line file whole (drive/index.js, life/worker.js, tile-worker.js, tools/tiles.py).
- Cap command output: pipe long output through `tail -20` / `head`, write logs to a file and read a summary line,
  run bakes and servers with output to a log file.
- Screenshots: take what you need, look at a small contact sheet (`tools/sheet.py`), not each full-size frame;
  don't re-open images you already judged.
- Don't paste or re-read diffs of whole files; `git diff --stat` then the hunk you care about.
- Long jobs: finish, commit, report. A fresh agent for the next task is cheaper than a long-lived one.

## Map
- `public/main.js` render loop, post (ink, look/grade, bloom, AA), quality tiers wiring
- `public/city.js` plugin host (`city.*` API). `public/core/`: `tiles.js` streaming/LOD/pump, `tile-worker.js`
  tile decode + geometry (ground, roads, paint, buildings, trees, crosswalks, tunnels), `materials.js` shaders,
  `trees3d.js`/`treeforms.js` trees, `kit.js` low-poly model kit, `play.js` shared third-person game code (chase cam,
  picker, touch), `util.js` helpers, `lights.js`/`look.js` night lights + camera look, `quality.js` tiers,
  `streets.js` street names
- `public/plugins/`: `drive/` (van, walk, hike, bus, Rush Fare `taxi.js`; `deliver.js` delivery shift, `feel.js` tyre marks / sparks / speed lines / squeal, `van.js` physics specs, `route.js` bus GPS,
  `kerbs.js`), `life/` (traffic + pedestrians: `worker.js` sim, `index.js` render, `blades.js` street signs), `sail/`,
  `progress/` (cash, XP, levels, maple leaves, dailies, leaderboards: `city.progress`), `weather/`, `transit/`, `ships/`, `planes/`, `landmarks/`, `lofi/`, `multiplayer/`
- `tools/`: bake (`tiles.py` main, `osm_split.py`, `sea.py`, `heights.py`, `hrdem.py`, `common.py` shared helpers),
  data (`roofs.py`, `beachlogs.py`, `facades.py`, `mapillary.py`, `transit_data.py`), audits/checks (`audit_elev.py`,
  `audit_trunks.py`, `sail_check.mjs` (race marks and starts on water, clear of moored boats), `geom_rules.py` (every geometry rule: checks + fixes, the publish gate; `drawn_check.mjs` its checks on
  what the page draws), `*_check.mjs`, `python3 tools/tiles.py selftest`)
- `server/` Rust live server (`cargo test`)

## Working rules
- Data lives in `data/` (gitignored, symlink it into worktrees); bake test tiles only into your own folder (`OUT=<dir>`),
  never into the main checkout's `public/tiles` (symlink that read-only for local runs).
- Page code must read old and new tiles; when the tile format changes, the page deploys before the rebake.
- The bake is incremental (each 4 km tile keyed on what it reads, `OUT/manifest.json`; `FORCE=1` rebakes all): a new
  data input of `tiles.py` build() gets narrowed to the tile in `cell_key` (until then any change to it rebakes every tile).
- Measure perf before/after on the map (`#13645,11243,0.1295`, DPR 2) and in third person, High and Low tiers.
- DRY: reuse `core/` modules instead of copying helpers into plugins.

## Tools (don't write your own screenshot/perf scripts)
- Shots: `node tools/shoot.mjs --out /tmp/s --dpr 1 --weather rain --hour 18 map=#13645,11243,0.1295 van=drive:49.2838,-123.1185 sail=sail:49.286,-123.16` (also `walk:`, `taxi:`, `bus:ROUTE:DIR`; `--size phone`, `--tier low`); one line per shot
- Drift over a long map session (#548): `node tools/soak.mjs --out /tmp/soak --mins 8` (start vs end shots per view, quality/tiles/GPU log)
- Perf: `node tools/bench.mjs --dpr 2 --tier high --cpu 4 --secs 20 map|drive|sail` prints one JSON line (p50/p95/p99, over33, tris, calls, gpuMs)
- Clipping at play time (#587, #593): `node tools/clip_check.mjs --tiles https://vancouver.borodutch.com/tiles [--routes downtown-van,beach-walk] [--secs 45] [--shots dir] [--out f.json]` an autopilot in each third-person mode (van, cab, bus, walker, hiker, boat) over 17 places (streets, a bridge deck, the Cassiar and Massey tunnels, slopes, the seawall, a marina, bridge piers); counts frames with the camera inside geometry / a trunk / a hull, the player in buildings / trunks / cars / ships / on the shore, wheels and feet off the ground, simulated cars and people in things. Repeatable: the page runs on a fixed 1/60 s clock in step with its workers, seeded random numbers, `--secs` × 60 frames whatever the machine's speed, so two runs of the same code agree to a few % (the `trace` in `--out` shows where they part) and a PR can be held to "no route worse than main": run it on main and on the branch, every route at 0 or no higher. `--tiles` plays on the published tiles (kept in the temp dir; the local ones may be older and have no tunnels); `--at kind[:n] --js 'expr'` stops one route at a counted frame and prints a value from the page. `errors` in the output are the page's own.
- Look: `uv run --with pillow python3 tools/sheet.py /tmp/s/sheet.jpg /tmp/s/*.png --cols 3` then view only the sheet
- Models: `node tools/models.mjs --out /tmp/m --only cars,people --hour 13,22` (the viewer: each code-built model in four views with triangle counts, one PNG per group and hour; groups player, cars, far, people, boats)
- Both node tools use Playwright from `/Users/borodutch/code/agentboard/`, start their own server, and need `public/tiles` symlinked.
