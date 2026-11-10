// Drive: explore the real streets by van or on foot, work a shift for the Salmonberry Parcel Co., or hike a trail.
// The toolbar's "Explore" menu (or D for deliveries) asks for a spot on the map, then dives from the map into a
// third-person view there; Esc flies back. On foot you walk the sidewalks (E gets in and out of the van).
// Deliveries are made up on the fly around you from what is loaded: a real shop with one to three parcels ready, then
// for each a building, the street in front of it, a Vancouver-style house number and a recipient. The courier carries
// them from the door to the van and on to each door. No GPS: a compass arrow and the distance only. Tips for being
// quick and for being gentle (every knock, kerb hop and startled pedestrian costs a little), a summary at the end.
// The van (van.js) has an automatic gearbox, weight transfer, understeer and tyres that grip less in rain and snow
// (city.surface). It bumps into buildings, kerbs, bridge railings, traffic light poles, street lamps, signs,
// bollards, tree trunks, cars and people (who stumble or fall over and get up again); the walker into the same.
// Hikes start at real trailheads and climb the real terrain (slower the steeper) to a summit or a viewpoint, where
// the camera pulls back for the view.
// Data: roads, trails, buildings, trees, lamps and signs from the map tiles; street names, named shops and bollards
// from OpenStreetMap (data/*.json, made by tools/delivery_places.py), © OpenStreetMap contributors, ODbL. Sounds are
// synthesised. Other cars and people come from city.traffic (the life plugin) when it is there: the van and the walker
// bump into them and are published as obstacles that they brake for. The player is published as city.player, with the
// van and the courier as city.models factories (see PLUGINS.md), and collides with other players through city.multiplayer.
// Or drive a bus on a real TransLink route (route.js: the route picker, the GPS line, stops and passengers; bus.js: the
// bus, 12 m or articulated, diesel or trolley): the same driving with a bus's numbers (van.js BUS, ARTIC), an articulated
// rear section towed about its joint, the tail swinging out round a tight turn.
// Or Rush Fare (taxi.js, cabs.js): an arcade cab shift against the clock, with van.js's arcade numbers (taxiSpec): drifts
// on the handbrake, a nitro boost, air off crests and deck ends (the cab's lift over the road, fly()).
import { repaint } from '../../core/kit.js'
import { makeVan, newVan, stepVan, jolt, VAN, BUS as CITYBUS, ARTIC } from './van.js'
import { openGarage, taxiGame, specOf, CABS, DRIVERS, makeCab, CSS as TAXI_CSS } from './taxi.js'
import { makeBus, setDoors } from './bus.js'
import { loadLines, loadRoute, picker, busGame, accentOf, CSS as BUS_CSS } from './route.js'
import { makeWalker, poseWalker } from './walker.js'
import { makeFoot } from './foot.js'
import { makeProps, LAMP, STOP, YIELD, BUS, BOLLARD, BENCH } from './props.js'
import { makeKerbs } from './kerbs.js'
import { makeFeel } from './feel.js'
import { deliveryGame } from './deliver.js'
import { clamp, smooth, wrap, esc, vancouver, circleBox } from '../../core/util.js'
import { cellsNear, nearestStreet, abbr } from '../../core/streets.js'
import { typing, buzz, MOVE_KEYS, mapPicker, mapCameraPose, poseOf, dive, streetSky, touchButtons, orbitLook, audioContext, tone as toneInto } from '../../core/play.js'

const DRIVE_MAX_KIND = 7 // motorway .. living street (graph piece kinds): where a van belongs
const WALK_MAX_KIND = 13 // .. steps, tracks: where a person can walk (plus the sidewalks of roads)
const CELL = 32 // metres, spatial grid for roads, footprints and street furniture
const WALK = 1.6, RUN = 4.6 // m/s
const HIKE = 3.2, HUSTLE = 5.6 // m/s on a trail, on the flat (a brisk, game-paced hike)
const ARRIVE = 9, ARRIVE_FOOT = 3.5 // metres from a marker that count as there
const CARRY = 3.4, DOOR_MAX = 22 // the courier jogs parcels at this pace, from at most this far from the van
// Trailheads and goals (OpenStreetMap trails and peaks; the trail lines themselves come from the map tiles).
// view: the compass bearing of the view at the goal, for the photo; ele: its height (until its tile is loaded)
const HIKES = [
  { id: 'grind', name: 'Grouse Grind', from: [49.37109, -123.0982], to: [49.37897, -123.0833], goal: 'the Grind finish at the Grouse chalet', ele: 1127, view: 200, blurb: 'Mother Nature’s Stairmaster: 2.9 km, 850 m up' },
  { id: 'quarry', name: 'Quarry Rock', from: [49.33001, -122.9497], to: [49.3337, -122.93659], goal: 'Quarry Rock lookout over Indian Arm', ele: 100, view: 95, blurb: 'Baden-Powell Trail from Deep Cove: 1.8 km, roots and rock' },
  { id: 'lynn', name: 'Lynn Canyon', from: [49.34372, -123.01913], to: [49.34147, -123.01595], goal: 'Twin Falls bridge', ele: 140, view: 150, blurb: 'Over the suspension bridge, down to the falls: 600 m' },
  { id: 'seawall', name: 'Seawall run', from: [49.2869, -123.1433], to: [49.30809, -123.15503], goal: 'Siwash Rock lookout', ele: 12, view: 280, blurb: 'English Bay to Siwash Rock past Second and Third Beach, against the clock: 3.3 km, flat' },
  { id: 'siwash', name: 'Stanley Park seawall', from: [49.3027, -123.15653], to: [49.30809, -123.15503], goal: 'Siwash Rock lookout', ele: 12, view: 280, blurb: 'Third Beach to Siwash Rock along the water: 700 m, flat' },
  { id: 'wreck', name: 'Pacific Spirit: Wreck Beach', from: [49.2634, -123.25928], to: [49.26223, -123.26153], goal: 'the beach at the bottom of the stairs', ele: 3, view: 250, blurb: 'Down Trail 6’s 470 stairs through the forest to the sea' },
  { id: 'lighthouse', name: 'Lighthouse Park', from: [49.33656, -123.26265], to: [49.33153, -123.26449], goal: 'the viewpoint by Point Atkinson lighthouse', ele: 25, view: 160, blurb: 'Old-growth firs down to the rocks: 700 m' },
  { id: 'dog', name: 'Dog Mountain', from: [49.36844, -122.94914], to: [49.37373, -122.97043], goal: 'Dog Mountain’s bluff over the city', ele: 1054, view: 225, blurb: 'Mount Seymour, through the forest to the view: 2.5 km' },
]
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const ckey = (cx, cy) => cx * 8192 + cy
const NONE = [] // an empty cell (instead of a new [] per lookup)

export default function drive(city) {
  const { THREE } = city
  const v3 = new THREE.Vector3(), v4 = new THREE.Vector3()

  // ================================================================ the street index (detail tiles, lazily)
  const infos = new Map(), overview = new Map(), built = new Map() // ckey(i, j) -> tile info / its index
  const offTiles = [
    city.world.eachTile((t) => { const k = ckey(t.i, t.j); if (t.level === 0) { infos.set(k, t); built.delete(k) } else overview.set(k, t) }),
    city.on('tile:unload', (t) => { const k = ckey(t.i, t.j); if (t.level === 0) { infos.delete(k); built.delete(k) } else overview.delete(k) }),
  ]
  const walkable = (p) => p.kind <= WALK_MAX_KIND && p.kind > 1 // not motorways or trunk roads
  const drivable = (p) => p.drive && p.kind <= DRIVE_MAX_KIND
  const trail = (p) => p.kind >= 8 && p.kind <= 13 // pedestrian .. track: off the streets
  function index(t) { // roads (drivable and walkable segments), building footprints and street furniture on a grid
    const segs = [], rg = new Map(), fg = new Map()
    const put = (g, k, v) => { let a = g.get(k); if (!a) g.set(k, (a = [])); if (a[a.length - 1] !== v) a.push(v) }
    for (const p of t.graph.pieces) {
      const drv = drivable(p), wlk = walkable(p), bus = p.kind <= DRIVE_MAX_KIND // bus: any road, bus-only ones too
      if (!drv && !wlk && !bus) continue
      for (let i = 0; i < p.pts.length / 2 - 1; i++) {
        const s = { p, i, drv, wlk, bus, x0: p.pts[i * 2], y0: p.pts[i * 2 + 1], x1: p.pts[i * 2 + 2], y1: p.pts[i * 2 + 3], z0: p.z ? p.z[i] : null, z1: p.z ? p.z[i + 1] : null }
        const n = Math.ceil(Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / 16), id = segs.push(s) - 1
        for (let k = 0; k <= n; k++) { const f = k / n || 0; put(rg, ckey(Math.floor((s.x0 + (s.x1 - s.x0) * f) / CELL), Math.floor((s.y0 + (s.y1 - s.y0) * f) / CELL)), id) }
      }
    }
    // footprints; then the raised parts of buildings (overhangs, skybridges: tile-worker.js overhangs), solid from the
    // height lo[r] up; then the landmarks' outlines (the rings plugins draw their own buildings in, core/tiles.js
    // masks: the generic buildings there, and their footprints, are left out), each in the tile its first corner is in
    const F = t.footprints, O = t.overhangs, nF = F ? F.start.length - 1 : 0, nO = O ? O.lo.length : 0, bb = []
    const M = (city.tiles?.masks || NONE).filter((r) => r[0][0] >= t.ox && r[0][0] < t.ox + 1024 && r[0][1] >= t.oy && r[0][1] < t.oy + 1024)
    let fp = F, lo = null
    if (nO || M.length) {
      const nM = M.reduce((n, r) => n + r.length * 2, 0), o1 = F ? F.pts.length : 0, o2 = o1 + (O ? O.pts.length : 0)
      const pts = new Float32Array(o2 + nM), start = new Uint32Array(nF + nO + M.length + 1)
      if (F) { pts.set(F.pts); start.set(F.start) }
      if (O) { pts.set(O.pts, o1); for (let i = 1; i <= nO; i++) start[nF + i] = o1 + O.start[i] }
      let q = o2, k = nF + nO
      for (const r of M) { for (const [x, y] of r) { pts[q++] = x; pts[q++] = y } start[++k] = q }
      fp = { pts, start }; lo = new Float32Array(start.length - 1).fill(-Infinity)
      if (O) lo.set(O.lo, nF)
    }
    if (fp) for (let r = 0; r < fp.start.length - 1; r++) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let q = fp.start[r]; q < fp.start[r + 1]; q += 2) { const x = fp.pts[q], y = fp.pts[q + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
      bb.push(x0, y0, x1, y1)
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) put(fg, ckey(cx, cy), r)
    }
    let bx0 = t.ox, by0 = t.oy, bx1 = t.ox + 1024, by1 = t.oy + 1024 // what its roads cover: a long bridge sticks out of its tile
    for (const s of segs) { bx0 = Math.min(bx0, s.x0, s.x1); by0 = Math.min(by0, s.y0, s.y1); bx1 = Math.max(bx1, s.x0, s.x1); by1 = Math.max(by1, s.y0, s.y1) }
    for (let r = 0; r < bb.length; r += 4) { bx0 = Math.min(bx0, bb[r]); by0 = Math.min(by0, bb[r + 1]); bx1 = Math.max(bx1, bb[r + 2]); by1 = Math.max(by1, bb[r + 3]) } // (a landmark's outline too)
    const b = { t, segs, rg, fg, fp, lo, bb, m0: M.length ? nF + nO : Infinity, box: [bx0, by0, bx1, by1], segSeen: new Uint32Array(segs.length), fpSeen: new Uint32Array(bb.length / 4) }
    furniture(b)
    return b
  }
  // things to bump into, 6 floats each (x, north, radius, kind, angle, ground) on a 32 m grid over the tile (start
  // offsets per cell, like a counting sort): tree trunks, and the street lamps, stop / give-way and bus stop signs the
  // tiles have as points. Signs and lamps mapped on the carriageway are moved to its kerb, and off the street as drawn.
  function furniture(b) {
    const t = b.t, K = 1024 / CELL, P = []
    const KIND = { 3: LAMP, 2: STOP, 6: YIELD, 5: BUS, 4: BENCH }
    for (const q of t.graph.pois || NONE) {
      const kind = KIND[q.kind]
      if (!kind) continue
      let x = q.x, y = q.y, ang = 0, best = kind === BENCH ? -99 : 6
      for (const id of b.rg.get(ckey(Math.floor(x / CELL), Math.floor(y / CELL))) || NONE) { // the road it stands by
        const s = b.segs[id]
        if (!s.drv || s.z0 != null) continue
        const dx = s.x1 - s.x0, dy = s.y1 - s.y0, L2 = dx * dx + dy * dy || 1, u = clamp(((x - s.x0) * dx + (y - s.y0) * dy) / L2, 0, 1)
        const px = s.x0 + dx * u, py = s.y0 + dy * u, d = Math.hypot(x - px, y - py) - s.p.w / 2
        if (d >= best) continue
        best = d
        const l = Math.sqrt(L2), side = (x - px) * -dy + (y - py) * dx >= 0 ? 1 : -1, nx = (-dy / l) * side, ny = (dx / l) * side
        if (d < 0.4) { x = px + nx * (s.p.w / 2 + 0.6); y = py + ny * (s.p.w / 2 + 0.6) } // on the street: to the kerb
        ang = kind === LAMP ? Math.atan2(nx, -ny) : yawFromDir(Math.atan2(dy, dx)) // lamps reach over it, signs face along it
      }
      const off = kind !== BENCH && city.world.offRoad(x, -y, 0.4, 6) // and off the street as the map draws it
      if (off) { x = off.x; y = -off.z }
      P.push(x, y, kind === LAMP ? 0.15 : kind === BENCH ? 0.6 : 0.1, kind, ang, city.world.heightAt(x, -y))
    }
    const T = t.trees, pos = T?.pos || T?.geometry?.attributes.iPos?.array, size = T?.size || T?.geometry?.attributes.iSize?.array
    if (pos && t.level === 0) for (let i = 0; i < pos.length / 3; i++) P.push(t.ox + pos[i * 3], t.oy - pos[i * 3 + 2], Math.min(0.4, Math.max(0.15, size[i * 2] * 0.03)), 0, 0, pos[i * 3 + 1])
    const n = P.length / 6, cnt = new Uint32Array(K * K + 1), cellOf = (i) => clamp(Math.floor((P[i * 6 + 1] - t.oy) / CELL), 0, K - 1) * K + clamp(Math.floor((P[i * 6] - t.ox) / CELL), 0, K - 1)
    for (let i = 0; i < n; i++) cnt[cellOf(i) + 1]++
    for (let i = 0; i < K * K; i++) cnt[i + 1] += cnt[i]
    const fill = cnt.slice(0, K * K), out = new Float32Array(P.length)
    for (let i = 0; i < n; i++) { const k = fill[cellOf(i)]++; for (let j = 0; j < 6; j++) out[k * 6 + j] = P[i * 6 + j] }
    b.props = out; b.pstart = cnt
  }
  // fn(x, north, radius, kind, angle, ground) for the street furniture, trunks and bollards within about r of (x, y)
  function propsNear(x, y, r, fn) {
    each(x, y, r, (b) => {
      const t = b.t, K = 1024 / CELL, P = b.props
      const i0 = clamp(Math.floor((x - r - t.ox) / CELL), 0, K - 1), i1 = clamp(Math.floor((x + r - t.ox) / CELL), 0, K - 1)
      const j0 = clamp(Math.floor((y - r - t.oy) / CELL), 0, K - 1), j1 = clamp(Math.floor((y + r - t.oy) / CELL), 0, K - 1)
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        for (let k = b.pstart[j * K + i]; k < b.pstart[j * K + i + 1]; k++) {
          const o = k * 6, dx = P[o] - x, dy = P[o + 1] - y
          if (dx * dx + dy * dy < (r + P[o + 2]) ** 2) fn(P[o], P[o + 1], P[o + 2], P[o + 3], P[o + 4], P[o + 5])
        }
      }
    })
    for (const c of cellsNear(x, y, r)) { // bollards, from the OpenStreetMap cells
      for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++) for (let gy = Math.floor((y - r) / CELL); gy <= Math.floor((y + r) / CELL); gy++) {
        const a = c.bollards.get(ckey(gx, gy))
        if (a) for (let k = 0; k < a.length; k += 2) { const dx = a[k] - x, dy = a[k + 1] - y; if (dx * dx + dy * dy < (r + 0.12) ** 2) fn(a[k], a[k + 1], 0.12, BOLLARD, 0, NaN) }
      }
    }
  }
  let stamp = 0 // dedupe marks (instead of a Set per query: these run several times a frame)
  const NEAR = [] // tilesNear's answer, reused: loop over it before asking again
  function tilesNear(x, y, r) { // the indexes of the detail tiles near (x, north), and of the next ones round whose roads reach here
    NEAR.length = 0
    const i0 = Math.floor((x - r) / 1024), i1 = Math.floor((x + r) / 1024), j0 = Math.floor((y - r) / 1024), j1 = Math.floor((y + r) / 1024)
    for (let i = i0 - 1; i <= i1 + 1; i++) for (let j = j0 - 1; j <= j1 + 1; j++) {
      const k = ckey(i, j)
      let b = built.get(k)
      if (!b) { const t = infos.get(k); if (!t) continue; b = index(t); built.set(k, b) }
      const [bx0, by0, bx1, by1] = b.box
      if ((i < i0 || i > i1 || j < j0 || j > j1) && (x + r < bx0 || x - r > bx1 || y + r < by0 || y - r > by1)) continue
      NEAR.push(b)
    }
    return NEAR
  }
  const each = (x, y, r, fn) => { for (const b of tilesNear(x, y, r).slice()) fn(b) } // (a copy: fn may ask again)
  // the nearest road segment point within r metres: drivable ones, or walkable ones (walk), or any road with bus-only
  // ones (bus); deck: bridge decks only
  // atZ (decks): of the decks right under (x, y), stacked or side by side, the one nearest that height
  function nearestRoad(x, y, r, deck = false, walk = false, bus = false, atZ = null) {
    let best = null, bd = r
    const mark = ++stamp
    for (const b of tilesNear(x, y, r)) {
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
        for (const id of b.rg.get(ckey(cx, cy)) || NONE) {
          if (b.segSeen[id] === mark) continue
          b.segSeen[id] = mark
          const s = b.segs[id]
          if ((walk ? !s.wlk : bus ? !s.bus : !s.drv) || (deck && s.z0 == null)) continue
          const dx = s.x1 - s.x0, dy = s.y1 - s.y0, L2 = dx * dx + dy * dy || 1
          const t = ((x - s.x0) * dx + (y - s.y0) * dy) / L2, u = clamp(t, 0, 1), px = s.x0 + dx * u, py = s.y0 + dy * u
          const d = Math.hypot(x - px, y - py) - s.p.w / 2, z = s.z0 == null ? null : s.z0 + (s.z1 - s.z0) * u
          const key = atZ != null && z != null && d < 1.2 ? Math.abs(z - atZ) - 1000 : d
          if (key < bd) { bd = key; best = { s, u, px, py, d: Math.max(0, d), dist: Math.hypot(x - px, y - py), z, dir: Math.atan2(dy, dx), w: s.p.w, over: (t < 0 ? -t : t > 1 ? t - 1 : 0) * Math.sqrt(L2) } }
        }
      }
    }
    return best
  }
  // the nearest road (bus-only ones too) running along (dx, dy) within r of (x, y): { px, py, dist, w, dir (its way,
  // atan2), along (±1: with or against its points), z (a deck's height or null) }. Rather one lined up within 25° and
  // with its one-way, else one within 45° (a GPS shape cuts a bend's corner) or against a one-way (a contra-flow bus
  // lane); h: the height the way was at (the last sample's), so a deck over the street or the street under one isn't it
  const RA = { px: 0, py: 0, dist: 0, w: 0, dir: 0, along: 1, z: null }
  function roadAlong(x, y, dx, dy, r, h = null) {
    let bd = Infinity, hit = false
    segsNear(x, y, r, (s) => {
      if (!s.bus) return
      const ex = s.x1 - s.x0, ey = s.y1 - s.y0, l2 = ex * ex + ey * ey || 1, al = (ex * dx + ey * dy) / Math.sqrt(l2)
      if (Math.abs(al) < 0.7) return
      const u = clamp(((x - s.x0) * ex + (y - s.y0) * ey) / l2, 0, 1), px = s.x0 + ex * u, py = s.y0 + ey * u, d = Math.hypot(x - px, y - py)
      if (d >= r) return
      const z = s.z0 == null ? null : s.z0 + (s.z1 - s.z0) * u
      const key = d + (Math.abs(al) < 0.9 ? 3 : 0) + (s.p.oneway && al < 0 ? 6 : 0) + (h != null && Math.abs((z == null ? city.world.heightAt(px, -py) + 0.2 : z + 0.58) - h) > 2.5 ? 12 : 0)
      if (key >= bd) return
      bd = key; hit = true
      Object.assign(RA, { px, py, dist: d, w: s.p.w, dir: Math.atan2(ey, ex), along: Math.sign(al), z })
    })
    return hit ? RA : null
  }
  // fn(seg) for every indexed road segment in the grid cells within r of (x, north)
  function segsNear(x, y, r, fn) {
    const mark = ++stamp
    each(x, y, r, (b) => {
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
        for (const id of b.rg.get(ckey(cx, cy)) || NONE) { if (b.segSeen[id] !== mark) { b.segSeen[id] = mark; fn(b.segs[id]) } }
      }
    })
  }
  // push a circle out of building footprints: returns the summed push (x, y) or null. h: the height it is at (the
  // camera's), when the raised parts of buildings that reach down to there are solid too
  let hitD = Infinity // how near the nearest wall collide() just met is (0: inside one): its pushes sum, and between two walls cancel
  function collide(x, y, rad0, h = -Infinity, pad = 0) { // pad: further off the landmarks' outlines (their scanned meshes stand out past them: steps, porticos, cornices)
    let px = 0, py = 0, hit = false
    const mark = ++stamp, R = rad0 + pad
    hitD = Infinity
    for (const b of tilesNear(x, y, R)) {
      if (!b.fp) continue
      for (let cx = Math.floor((x - R) / CELL); cx <= Math.floor((x + R) / CELL); cx++) for (let cy = Math.floor((y - R) / CELL); cy <= Math.floor((y + R) / CELL); cy++) {
        for (const r of b.fg.get(ckey(cx, cy)) || NONE) {
          if (b.fpSeen[r] === mark) continue
          b.fpSeen[r] = mark
          if (b.lo && b.lo[r] > h) continue
          const rad = r >= b.m0 ? R : rad0
          if (x + rad < b.bb[r * 4] || x - rad > b.bb[r * 4 + 2] || y + rad < b.bb[r * 4 + 1] || y - rad > b.bb[r * 4 + 3]) continue
          const P = b.fp.pts, s0 = b.fp.start[r], s1 = b.fp.start[r + 1]
          let inside = false, bd = Infinity, bx = 0, by = 0
          for (let q = s0, w = s1 - 2; q < s1; w = q, q += 2) {
            const ax = P[w], ay = P[w + 1], cx2 = P[q], cy2 = P[q + 1]
            if ((cy2 > y) !== (ay > y) && x < ((ax - cx2) * (y - cy2)) / (ay - cy2) + cx2) inside = !inside
            const dx = cx2 - ax, dy = cy2 - ay, u = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1)
            const qx = ax + dx * u, qy = ay + dy * u, d = Math.hypot(x - qx, y - qy)
            if (d < bd) { bd = d; bx = qx; by = qy }
          }
          if (!inside && bd >= rad) continue
          hitD = Math.min(hitD, inside ? 0 : Math.max(0, bd - (rad - rad0)))
          const nx = (x - bx) / (bd || 1), ny = (y - by) / (bd || 1)
          const k = inside ? -(bd + rad) : rad - bd // inside: out through the nearest wall
          px += nx * k; py += ny * k; hit = true
        }
      }
    }
    return hit ? { x: px, y: py } : null
  }
  const insideBuilding = (x, y) => !!collide(x, y, 0.01)
  // the underside of the lowest raised part of a building (an arcade's upper floors, a skybridge, the storeys over a
  // lane) over (x, north) above the height h, or Infinity: what is driven under is a ceiling to the camera
  function ceilingAt(x, y, h) {
    let top = Infinity
    for (const b of tilesNear(x, y, 1)) {
      if (!b.lo) continue
      for (const r of b.fg.get(ckey(Math.floor(x / CELL), Math.floor(y / CELL))) || NONE) {
        const l = b.lo[r]
        if (!(l > h && l < top) || x < b.bb[r * 4] || x > b.bb[r * 4 + 2] || y < b.bb[r * 4 + 1] || y > b.bb[r * 4 + 3]) continue
        const P = b.fp.pts
        let inside = false
        for (let q = b.fp.start[r], e = b.fp.start[r + 1], w = e - 2; q < e; w = q, q += 2) if ((P[q + 1] > y) !== (P[w + 1] > y) && x < ((P[w] - P[q]) * (y - P[q + 1])) / (P[w + 1] - P[q + 1]) + P[q]) inside = !inside
        if (inside) top = l
      }
    }
    return top
  }
  // the first building wall on the way from (x0, y0) to (x1, y1): the fraction of the way (1 = none); h as collide's
  function wallHit(x0, y0, x1, y1, h = -Infinity) {
    let best = 1
    const mark = ++stamp, dx = x1 - x0, dy = y1 - y0
    const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1)
    for (const b of tilesNear((lx + hx) / 2, (ly + hy) / 2, Math.max(hx - lx, hy - ly) / 2 + 1)) {
      if (!b.fp) continue
      for (let cx = Math.floor(lx / CELL); cx <= Math.floor(hx / CELL); cx++) for (let cy = Math.floor(ly / CELL); cy <= Math.floor(hy / CELL); cy++) {
        for (const r of b.fg.get(ckey(cx, cy)) || NONE) {
          if (b.fpSeen[r] === mark) continue
          b.fpSeen[r] = mark
          if (b.lo && b.lo[r] > h) continue
          if (hx < b.bb[r * 4] || lx > b.bb[r * 4 + 2] || hy < b.bb[r * 4 + 1] || ly > b.bb[r * 4 + 3]) continue
          const P = b.fp.pts, s0 = b.fp.start[r], s1 = b.fp.start[r + 1]
          for (let q = s0, w = s1 - 2; q < s1; w = q, q += 2) {
            const ex = P[q] - P[w], ey = P[q + 1] - P[w + 1], den = dx * ey - dy * ex
            if (Math.abs(den) < 1e-9) continue
            const fx = P[w] - x0, fy = P[w + 1] - y0, t = (fx * ey - fy * ex) / den, u = (fx * dy - fy * dx) / den
            if (t >= 0 && t < best && u >= 0 && u <= 1) best = t
          }
        }
      }
    }
    return best
  }
  function isWater(x, y) {
    const t = infos.get(ckey(Math.floor(x / 1024), Math.floor(y / 1024)))
    if (!t?.water) return false
    const n = t.water.n, i = Math.floor(((x - t.ox) / 1024) * n), j = Math.floor(((y - t.oy) / 1024) * n)
    return i >= 0 && j >= 0 && i < n && j < n && t.water.mask[j * n + i] === 1
  }
  // two boxes { x, y, fx, fy, hl, hw } (separating axes): the way to push a out of b { nx, ny, depth }, or null
  function boxBox(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y
    let best = Infinity, bx = 0, by = 0
    for (const [nx, ny] of [[a.fx, a.fy], [a.fy, -a.fx], [b.fx, b.fy], [b.fy, -b.fx]]) {
      const ra = a.hl * Math.abs(a.fx * nx + a.fy * ny) + a.hw * Math.abs(a.fy * nx - a.fx * ny)
      const rb = b.hl * Math.abs(b.fx * nx + b.fy * ny) + b.hw * Math.abs(b.fy * nx - b.fx * ny)
      const dist = dx * nx + dy * ny, o = ra + rb - Math.abs(dist)
      if (o <= 0) return null
      if (o < best) { best = o; bx = dist < 0 ? -nx : nx; by = dist < 0 ? -ny : ny }
    }
    return { nx: bx, ny: by, depth: best }
  }

  // ================================================================ shops (OpenStreetMap, per 4 km cell: core/streets.js)
  function placesNear(x, y, r0, r1) {
    const out = []
    for (const c of cellsNear(x, y, r1)) for (const p of c.places) { const d = Math.hypot(p.x - x, p.y - y); if (d >= r0 && d <= r1) out.push(p) }
    return out
  }
  // Vancouver house numbers, approximately: on east-west streets 100 a block (~155 m) east and west of Ontario St;
  // on north-south streets 100 an avenue (~107 m) south of the waterfront. Even numbers on the north and east sides.
  const X_ONT = city.world.fromLatLon(49.2632, -123.1048).x, Y_WATER = -city.world.fromLatLon(49.2863, -123.1048).z
  function houseNumber(st, hx, hy) {
    const ew = Math.abs(st.x1 - st.x0) >= Math.abs(st.y1 - st.y0)
    let n = Math.max(2, Math.round(ew ? Math.abs(hx - X_ONT) / 1.55 : Math.abs(Y_WATER - hy) / 1.07))
    const even = ew ? hy > st.py : hx > st.px
    if ((n % 2 === 0) !== even) n += 1
    return n
  }

  // ================================================================ scene objects
  const COLOUR = '#f2a07e' // the Salmonberry van
  const van = makeVan(THREE, COLOUR), walker = makeWalker(THREE)
  let vanColour = COLOUR // the colour picked in the progress panel, painted on when a drive starts
  const paintVan = () => { const c = city.progress?.choice('van')?.value || COLOUR; if (c !== vanColour) { repaint(THREE, van, vanColour, c); vanColour = c; if (city.player) city.player.colour = c } }
  let vehicle = van // what is driven: the van, or a bus (bus.js)
  // model factories, so other players (multiplayer) look like this one
  city.models = { ...city.models, van: (colour = COLOUR) => makeVan(THREE, colour), person: (colour) => makeWalker(THREE, colour), bus: () => makeBus(THREE, {}) }
  const blobMat = new THREE.MeshBasicMaterial({ map: radial('rgba(0,0,0,0.42)'), transparent: true, depthWrite: false, fog: false })
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 5.0).rotateX(-Math.PI / 2), blobMat)
  const wblob = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2), blobMat)
  const blob2 = new THREE.Mesh(blob.geometry, blobMat) // under an articulated bus's rear section
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { col: { value: new THREE.Color() }, t: { value: 0 } },
    vertexShader: 'varying float vY; void main() { vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 col; uniform float t; varying float vY; void main() { float a = pow(1.0 - vY, 1.5) * (0.75 + 0.2 * sin(t * 3.0 - vY * 14.0)); gl_FragColor = vec4(col * a, a); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
  })
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 70, 20, 1, true).translate(0, 35, 0), beamMat)
  const ringMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 4.0, 48).rotateX(-Math.PI / 2), ringMat)
  const ring2Mat = ringMat.clone()
  const ring2 = new THREE.Mesh(new THREE.RingGeometry(3.6, 3.8, 48).rotateX(-Math.PI / 2), ring2Mat)
  const icons = { pickup: parcelIcon(), drop: houseIcon(), summit: flagIcon(), stop: stopIcon() }
  const props = makeProps(THREE), lips = makeKerbs(THREE, segsNear), heightAt = (x, z) => city.world.heightAt(x, z)
  // the parcel in the courier's arms
  const carried = parcelIcon(); carried.scale.setScalar(0.3); carried.position.set(0, 1.08, -0.32); carried.visible = false; walker.add(carried)
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(5, 12).rotateX(-Math.PI / 2).translate(0, 0, -8), new THREE.MeshBasicMaterial({ map: radial('rgba(255,230,170,0.5)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))

  function radial(c) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64
    const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 2, 32, 32, 31)
    gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(cv)
  }
  function parcelIcon() {
    const g = new THREE.Group(), kraft = new THREE.MeshLambertMaterial({ color: 0xd9a066, flatShading: true }), tape = new THREE.MeshLambertMaterial({ color: 0xf3e3c3 })
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 1.6), kraft))
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1.64, 1.24, 0.3), tape), new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.24, 1.64), tape))
    return g
  }
  function flagIcon() { // a pennant on a pole, for a summit or a viewpoint
    const g = new THREE.Group()
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6).translate(0, 0, 0), new THREE.MeshLambertMaterial({ color: 0xf6ead2 })))
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.3, 3).rotateZ(-Math.PI / 2).scale(1, 1, 0.2).translate(0.65, 0.85, 0), new THREE.MeshLambertMaterial({ color: 0x5fd6a0, flatShading: true }))
    g.add(f)
    return g
  }
  function stopIcon() { // a bus stop sign: a blue plate, a white bus on it
    const g = new THREE.Group(), M = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true })
    const box = (w, h, d, c, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(c)); m.position.set(x, y, z); g.add(m) }
    box(1.7, 1.3, 0.14, 0x2f62b8, 0, 0, 0); box(1.1, 0.5, 0.18, 0xffffff, 0, 0.12, 0); box(0.8, 0.18, 0.2, 0x2f62b8, 0, 0.2, 0)
    for (const x of [-0.32, 0.32]) box(0.2, 0.2, 0.2, 0xffffff, x, -0.2, 0)
    box(0.12, 1.4, 0.12, 0xc9ccd0, 0, -1.3, 0)
    return g
  }
  function houseIcon() {
    const g = new THREE.Group()
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 1.5), new THREE.MeshLambertMaterial({ color: 0xf6ead2, flatShading: true })))
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.3, 0.9, 4).rotateY(Math.PI / 4), new THREE.MeshLambertMaterial({ color: 0x3f9e95, flatShading: true }))
    roof.position.y = 1.0; g.add(roof)
    const heart = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.05), new THREE.MeshLambertMaterial({ color: 0xe8735a }))
    heart.position.set(0, -0.15, 0.76); g.add(heart)
    return g
  }

  // ================================================================ sound (Web Audio, synthesised)
  let ac = null, master = null, engine = null, muted = false // master: our gain on the shared context (core/play.js)
  try { muted = localStorage.getItem('delivery.muted') === '1' } catch {}
  function audio() {
    if (master) return audioContext()
    if (!(ac = audioContext())) return null
    const out = master = ac.createGain(); out.gain.value = muted ? 0 : 1; out.connect(ac.destination)
    // engine: two detuned saws through a low-pass, very quiet; pitch and level follow the speed
    const g = ac.createGain(); g.gain.value = 0
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 0.7
    const o1 = ac.createOscillator(), o2 = ac.createOscillator()
    o1.type = 'sawtooth'; o2.type = 'triangle'; o1.frequency.value = 42; o2.frequency.value = 84.5
    o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(out); o1.start(); o2.start()
    engine = { g, o1, o2, lp }
    return ac
  }
  const tone = (freq, t0, dur, vol, type) => toneInto(master, freq, t0, dur, vol, type)
  const bell = (f, t, v = 0.12) => { tone(f, t, 1.4, v); tone(f * 2.01, t, 0.7, v * 0.35); tone(f * 3.98, t, 0.35, v * 0.12) }
  const sfx = {
    pickup() { if (!audio()) return; const t = ac.currentTime + 0.02; bell(659.3, t); bell(987.8, t + 0.12) },
    deliver() { if (!audio()) return; const t = ac.currentTime + 0.02; [523.3, 659.3, 784, 1046.5].forEach((f, i) => bell(f, t + i * 0.09, 0.1)); bell(1568, t + 0.42, 0.05) },
    bump(k) { if (!audio()) return; const t = ac.currentTime; tone(70, t, 0.25, 0.18 * k); tone(140, t, 0.12, 0.06 * k, 'triangle') },
    door() { if (!audio()) return; const t = ac.currentTime; tone(95, t, 0.14, 0.12, 'triangle'); tone(190, t + 0.01, 0.06, 0.04, 'square') },
    splash() { if (!audio()) return; const t = ac.currentTime; tone(320, t, 0.3, 0.04, 'triangle'); tone(240, t + 0.05, 0.3, 0.03, 'triangle') },
    oops() { if (!audio()) return; const t = ac.currentTime; tone(440, t, 0.12, 0.05, 'triangle'); tone(330, t + 0.1, 0.22, 0.05, 'triangle') }, // a startled "oh!"
    kerb(k) { if (!audio()) return; const t = ac.currentTime; tone(55, t, 0.18, 0.12 * k); tone(110, t + 0.01, 0.08, 0.05 * k, 'triangle') },
    clank() { if (!audio()) return; const t = ac.currentTime; tone(620, t, 0.5, 0.05); tone(931, t, 0.35, 0.03); tone(80, t, 0.25, 0.15) }, // a pole rings
    knock() { if (!audio()) return; const t = ac.currentTime; for (const k of [0, 0.16, 0.32]) tone(180, t + k, 0.09, 0.08, 'triangle') },
    shutter() { if (!audio()) return; const t = ac.currentTime; tone(1800, t, 0.03, 0.05, 'square'); tone(900, t + 0.06, 0.05, 0.04, 'square') },
    summit() { if (!audio()) return; const t = ac.currentTime + 0.02; [392, 523.3, 659.3, 784, 1046.5].forEach((f, i) => bell(f, t + i * 0.14, 0.09)); bell(1318.5, t + 0.8, 0.05) },
  }
  // the horn, as long as it is held (a tap still gives a short beep): a pair of disc horns a major third apart, like a
  // van's dual horn: buzzy saws through a soft clip, a brassy resonance near 2 kHz, the pitch settling as the
  // diaphragms get going
  let horn = null
  const clip = new Float32Array(256).map((_, i) => Math.tanh(3 * (i / 127.5 - 1)))
  function hornOn() {
    if (horn || !audio()) return
    const t = ac.currentTime, out = ac.createGain(), sh = ac.createWaveShaper(), pk = ac.createBiquadFilter(), lp = ac.createBiquadFilter()
    sh.curve = clip; pk.type = 'peaking'; pk.frequency.value = 1900; pk.Q.value = 2.2; pk.gain.value = 8; lp.type = 'lowpass'; lp.frequency.value = 4000
    sh.connect(pk); pk.connect(lp); lp.connect(out); out.connect(master)
    out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(0.06, t + 0.012)
    const oscs = (city.progress?.choice('horn')?.value || [418, 526]).map((f) => {
      const o = ac.createOscillator(), g = ac.createGain()
      o.type = 'sawtooth'; o.frequency.setValueAtTime(f * 0.94, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.05)
      g.gain.value = 0.45; o.connect(g); g.connect(sh); o.start(t)
      return o
    })
    horn = { out, oscs, t0: t }
  }
  function hornOff() {
    if (!horn) return
    const h = horn, t = Math.max(ac.currentTime, h.t0 + 0.13)
    horn = null
    h.out.gain.setTargetAtTime(0, t, 0.02)
    for (const o of h.oscs) o.stop(t + 0.15)
  }
  function setMuted(m) { muted = m; try { localStorage.setItem('delivery.muted', m ? '1' : '0') } catch {}; if (master) master.gain.value = m ? 0 : 1; ui.mute.textContent = m ? 'Sound off' : 'Sound on' }

  // ================================================================ HUD
  const touchy = matchMedia('(pointer: coarse)').matches
  const ui = makeUI()
  function makeUI() {
    const css = document.createElement('style')
    css.textContent = `
      .dlv { position: fixed; z-index: 25; font: 13px/1.35 system-ui, -apple-system, sans-serif; color: #fdf6ea; pointer-events: none; }
      .dlv[hidden] { display: none !important }
      .dlv.card, .dlv .card { background: rgba(38, 30, 28, 0.62); border: 1px solid rgba(255, 236, 214, 0.16); border-radius: 14px; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); box-shadow: 0 6px 22px rgba(0,0,0,.18); }
      .dlv button { pointer-events: auto; font: inherit; color: inherit; background: rgba(38, 30, 28, 0.62); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border: 1px solid rgba(255,236,214,.18); border-radius: 9px; padding: 5px 10px; cursor: pointer; }
      .dlv button:hover { background: rgba(70, 56, 52, 0.75) }
      .dlv-co { left: 12px; top: 12px; padding: 9px 13px; }
      .dlv-co .name { font-weight: 700; letter-spacing: .02em; color: #ffc9b5; font-size: 12px; text-transform: uppercase; }
      .dlv-co .stats { display: flex; gap: 12px; margin-top: 3px; font-variant-numeric: tabular-nums; font-size: 14px; }
      .dlv-co .stats b { font-weight: 650 } .dlv-co .stats span { color: #d9cbbb }
      .dlv-co .credit { font-size: 10px; color: #b9a99a; margin-top: 2px } .dlv-co .credit a { color: inherit; pointer-events: auto }
      .dlv-btns { right: 12px; top: 12px; display: flex; gap: 6px; }
      .dlv-read { left: 12px; top: 12px; padding: 5px 11px; font-size: 12px; font-variant-numeric: tabular-nums; color: #f3e8da; white-space: nowrap; max-width: calc(100vw - 210px); overflow: hidden; text-overflow: ellipsis; }
      .dlv-read b { font-weight: 650; color: #fdf6ea }
      .dlv-job { left: 50%; top: 12px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 9px 16px 9px 10px; width: max-content; max-width: min(460px, calc(100vw - 24px)); box-sizing: border-box; }
      .dlv-arrow { flex: none; width: 50px; height: 50px; border-radius: 50%; display: grid; place-items: center; background: rgba(255,255,255,.08); border: 1px solid rgba(255,236,214,.14); position: relative; }
      .dlv-arrow svg { width: 32px; height: 32px; transition: transform .12s linear; }
      .dlv-arrow .n { position: absolute; inset: 0; transition: transform .12s linear; font-size: 8px; font-weight: 750; color: #ffc9b5; text-align: center; line-height: 11px; }
      .dlv-job .what { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: #ffc9b5; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 330px }
      .dlv-job .where { font-size: 16px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 330px }
      .dlv-job .sub { color: #e2d4c4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 330px }
      .dlv-job .meta { display: flex; gap: 10px; color: #fdf6ea; font-variant-numeric: tabular-nums; margin-top: 1px }
      .dlv-job .late { color: #ffd38a }
      .dlv-help { left: 50%; bottom: 52px; transform: translateX(-50%); padding: 6px 12px; color: #e8dccd; font-size: 12px; white-space: nowrap; transition: opacity .6s; }
      .dlv-help.fade { opacity: 0 }
      .dlv-act { left: 50%; bottom: 96px; transform: translateX(-50%); padding: 6px 12px; font-size: 13px; }
      .dlv-act kbd { font: 600 11px system-ui; border: 1px solid rgba(255,236,214,.4); border-radius: 4px; padding: 0 5px; margin-right: 6px; }
      .dlv-pop { left: 50%; top: 36%; transform: translate(-50%, -50%) scale(.9); padding: 12px 20px; text-align: center; opacity: 0; transition: opacity .3s, transform .3s; }
      .dlv-pop.on { opacity: 1; transform: translate(-50%, -50%) scale(1) }
      .dlv-pop .big { font-size: 22px; font-weight: 750; color: #ffe1a8 }
      .dlv-pop .q { color: #e8dccd; margin-top: 2px }
      .dlv-pick { left: 50%; top: 12px; transform: translateX(-50%); padding: 8px 10px 8px 14px; display: flex; gap: 10px; align-items: center; font-size: 14px; }
      body.dlv-picking canvas { cursor: crosshair }
      body.dlv-picking #hint { display: none }
      /* the pedals (--pw wide; Go --gh tall, Brake --bh) sit in the bottom-right corner, the handbrake and the
         action button stack over Go; --pb is the bottom row's distance from the screen edge */
      .dlv-touch { inset: auto 0 0 0; height: 170px; display: none; --pb: 52px; --pw: 88px; --gh: 128px; --bh: 96px; }
      .dlv-touch button { position: absolute; bottom: var(--pb); width: 74px; height: 74px; border-radius: 50%; font-size: 15px; font-weight: 650; background: rgba(38,30,28,.5); border: 2px solid rgba(255,236,214,.35); touch-action: none; user-select: none; -webkit-user-select: none; }
      .dlv-touch button.on { background: rgba(232,115,90,.75) }
      .dlv-touch .l { left: 16px } .dlv-touch .r { left: 100px }
      .dlv-touch .gas, .dlv-touch .brk { width: var(--pw); border-radius: 22px } .dlv-touch .gas { right: 16px; height: var(--gh) } .dlv-touch .brk { right: calc(16px + var(--pw) + 10px); height: var(--bh) }
      .dlv-touch .hrn, .dlv-touch .hb { bottom: 164px; width: 56px; height: 56px; padding: 0; font-size: 12px; line-height: 1.1; }
      .dlv-touch .hrn { left: 25px } .dlv-touch .hb { right: calc(16px + (var(--pw) - 56px) / 2); bottom: calc(var(--pb) + var(--gh) + 12px) }
      .dlv-touch .act { right: 16px; bottom: calc(var(--pb) + var(--gh) + 80px); width: auto; height: 40px; padding: 0 14px; border-radius: 20px; font-size: 14px; }
      .dlv-touch [hidden] { display: none }
      body.dlv-on.dlv-touchy .dlv-touch { display: block }
      body.dlv-on.dlv-touchy .dlv-help, body.dlv-on.dlv-touchy .dlv-act { display: none }
      body.dlv-on.dlv-touchy #credits { display: none !important }
      body.dlv-on #bar, body.dlv-on #hint, body.dlv-on #about, body.dlv-on #tools, body.dlv-on .tool-panel { display: none !important }
      body.dlv-on.dlv-touchy .lofi { left: 50% !important; transform: translateX(-50%); bottom: 168px !important; }
      .dlv-touch button { -webkit-touch-callout: none; }
      .dlv-menu { display: grid; gap: 6px; }
      .dlv-menu button { display: flex; gap: 10px; align-items: center; text-align: left; font: inherit; color: var(--text); background: rgba(255,255,255,.05); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
      .dlv-menu button:hover { background: rgba(255,255,255,.12) }
      .dlv-menu button span { font-size: 18px } .dlv-menu small { display: block; color: var(--muted); font-size: 11.5px }
      .dlv-menu .back { justify-content: center; font-size: 12.5px; padding: 6px; }
      .dlv-menu .done { margin-left: auto; color: #8fd9b0; font-size: 12px; white-space: nowrap }
      .dlv-stam { height: 5px; border-radius: 3px; background: rgba(255,255,255,.12); margin-top: 5px; overflow: hidden; }
      .dlv-stam i { display: block; height: 100%; width: 100%; background: #8fd9b0; border-radius: 3px; transition: width .1s linear, background .3s; }
      .dlv-stam.low i { background: #ffb36b }
      .dlv-job .aboard { color: #e2d4c4; font-size: 11.5px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 330px }
      .dlv-sheet { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(360px, calc(100vw - 32px)); box-sizing: border-box; padding: 18px 20px 16px; pointer-events: auto; text-align: center; z-index: 30; }
      .dlv-sheet h3 { margin: 0 0 2px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #ffc9b5; font-weight: 700; }
      .dlv-sheet .big { font-size: 30px; font-weight: 750; color: #ffe1a8; font-variant-numeric: tabular-nums; margin: 4px 0 2px; }
      .dlv-sheet .rank { width: 62px; height: 62px; margin: 8px auto 0; border-radius: 50%; display: grid; place-items: center; font-size: 34px; font-weight: 800; color: #2a1f1c; background: #ffd38a; box-shadow: 0 0 0 4px rgba(255,211,138,.25); }
      .dlv-sheet .rank.rS { background: #ff8fd0 } .dlv-sheet .rank.rA { background: #ffd38a } .dlv-sheet .rank.rB { background: #9fe0c8 } .dlv-sheet .rank.rC { background: #b9c7d6 } .dlv-sheet .rank.rD { background: #a89a90 }
      .dlv-co .late, .dlv-read .gain { color: #ffd38a }
      .dlv-how { left: 50%; top: 34%; transform: translate(-50%, -50%); width: min(340px, calc(100vw - 32px)); box-sizing: border-box; padding: 14px 18px; z-index: 29; pointer-events: auto; cursor: pointer; transition: opacity .4s; }
      .dlv-how.fade { opacity: 0 }
      .dlv-how h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #ffc9b5; }
      .dlv-how ol { margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.45 } .dlv-how li { margin: 3px 0 }
      .dlv-how .k { margin-top: 8px; font-size: 11.5px; color: #d9cbbb }
      .dlv-sheet .stars { font-size: 20px; letter-spacing: 3px; color: #ffd38a; }
      .dlv-sheet dl { display: grid; grid-template-columns: 1fr auto; gap: 4px 14px; text-align: left; margin: 12px 0 10px; font-variant-numeric: tabular-nums; }
      .dlv-sheet dt { color: #d9cbbb } .dlv-sheet dd { margin: 0; font-weight: 650; text-align: right }
      .dlv-sheet .line { color: #e8dccd; font-style: italic; margin: 6px 0 14px; }
      .dlv-sheet .row { display: flex; gap: 8px; justify-content: center; }
      .dlv-sheet .row button { min-height: 40px; padding: 0 16px; border-radius: 12px; }
      .dlv-sheet .row button.main { background: rgba(232,115,90,.8); border-color: rgba(255,236,214,.4); }
      .dlv-flash { inset: 0; background: #fff; opacity: 0; transition: opacity .9s ease-out; z-index: 29; }
      .dlv-flash.on { opacity: .85; transition: none }
      .dlv-photo { left: 50%; bottom: 40px; transform: translateX(-50%) rotate(-1.5deg); background: #fbf6ec; color: #3a2a26; padding: 12px 16px 12px; border-radius: 6px; box-shadow: 0 10px 34px rgba(0,0,0,.35); text-align: center; pointer-events: auto; width: min(340px, calc(100vw - 40px)); box-sizing: border-box; opacity: 0; transition: opacity .8s .4s, transform .8s .4s; }
      .dlv-photo.on { opacity: 1; transform: translateX(-50%) rotate(-2.5deg); }
      .dlv-photo .t { font: 600 18px Georgia, 'Times New Roman', serif; } .dlv-photo .s { font-size: 12.5px; color: #6b5a50; margin-top: 2px; font-variant-numeric: tabular-nums; }
      .dlv-photo .row { display: flex; gap: 8px; justify-content: center; margin-top: 10px; }
      .dlv-photo button { color: #3a2a26; background: #efe4d2; border-color: #d8c8b0; backdrop-filter: none; min-height: 36px; border-radius: 10px; }
      .dlv-photo button:hover { background: #e6d8c2 }
      body.dlv-shot .dlv:not(.dlv-photo):not(.dlv-flash):not(.dlv-btns), body.dlv-shot .lofi { visibility: hidden }
      @media (max-width: 1000px) { .dlv-job { top: 74px } }
      @media (max-width: 640px) {
        .dlv-co { padding: 7px 11px } .dlv-co .credit { display: none }
        .dlv-btns .opt { display: none }
        .dlv-job .where, .dlv-job .sub, .dlv-job .what { max-width: 250px }
        .dlv-pick { font-size: 13px; white-space: nowrap; top: 64px }
      }
      /* phones (html.compact): one row at the top (shift or speed | chat, map), the job card under it, the pedals
         in the bottom corners clear of the notch and the home indicator, the music between them */
      .compact .dlv-co { left: var(--sl); top: var(--st); padding: 5px 11px; min-height: 44px; box-sizing: border-box; }
      .compact .dlv-co .name { font-size: 10.5px } .compact .dlv-co .stats { gap: 10px; margin-top: 1px }
      .compact .dlv-co .credit { display: none }
      .compact .dlv-read { left: var(--sl); top: var(--st); height: 44px; display: flex; align-items: center; gap: 4px; box-sizing: border-box; padding: 0 12px; font-size: 13px; max-width: calc(100% - var(--sl) - var(--sr) - 140px); }
      .compact .dlv-read .st { min-width: 0; overflow: hidden; text-overflow: ellipsis }
      .compact .dlv-co { max-width: calc(100% - var(--sl) - var(--sr) - 140px); } /* clear of ⋯ and Map */
      .compact .dlv-btns { right: var(--sr); top: var(--st); }
      .compact .dlv-btns .opt, .dlv-btns .short, .compact .dlv-btns .long { display: none }
      .compact .dlv-btns .short { display: inline }
      .compact .dlv-btns [data-exit] { width: 78px; height: 44px; padding: 0; border-radius: 12px; }
      .compact .dlv-btns [data-assist] { width: 78px; height: 44px; padding: 0; border-radius: 12px; }
      #menu [data-assist] .short { display: none } /* phones: Lane assist and Sound are in the ⋯ sheet (city.ui.inMenu) */
      .compact .dlv-job { top: calc(var(--st) + 52px); left: var(--sl); right: var(--sr); transform: none; width: auto; max-width: 460px; padding: 8px 12px 8px 8px; gap: 10px; }
      .compact .dlv-job > div:last-child { min-width: 0; flex: 1 }
      .compact .dlv-job .where, .compact .dlv-job .sub, .compact .dlv-job .what { max-width: none }
      .compact .dlv-job .where { font-size: 15px }
      .compact .dlv-arrow { width: 46px; height: 46px; }
      .compact .dlv-pick { top: calc(var(--st) + 52px); left: var(--sl); right: var(--sr); transform: none; justify-content: space-between; white-space: normal; font-size: 14px; }
      .compact .dlv-pick button { min-height: 44px; padding: 0 14px; flex: none; }
      .compact .dlv-pop { max-width: calc(100% - 48px); box-sizing: border-box; }
      .compact .dlv-job .aboard { max-width: none }
      .compact .dlv-help { white-space: normal; width: max-content; max-width: calc(100% - var(--sl) - var(--sr)); box-sizing: border-box; text-align: center; bottom: calc(var(--sb) + 20px); }
      .compact .dlv-photo { bottom: calc(max(16px, env(safe-area-inset-bottom)) + 8px); }
      /* portrait: tall pedals as wide as the room right of the steering buttons allows (they end at --sl + 158px) */
      .compact .dlv-touch { --pb: max(16px, calc(env(safe-area-inset-bottom) + 4px)); --pw: clamp(56px, calc((100vw - var(--sl) - var(--sr) - 178px) / 2), 88px); height: auto; top: 0; }
      .compact .dlv-touch .l { left: var(--sl) } .compact .dlv-touch .r { left: calc(var(--sl) + 84px) }
      .compact .dlv-touch .gas { right: var(--sr) } .compact .dlv-touch .brk { right: calc(var(--sr) + var(--pw) + 10px) }
      .compact .dlv-touch .hrn { left: calc(var(--sl) + 9px); bottom: calc(var(--pb) + 86px) } .compact .dlv-touch .hb { right: calc(var(--sr) + (var(--pw) - 56px) / 2) }
      .compact .dlv-touch .act { right: var(--sr); height: 44px; border-radius: 22px; }
      .compact body.dlv-on .lofi { padding: 0 } .compact body.dlv-on .lofi-name, .compact body.dlv-on .lofi canvas { display: none }
      .compact body.dlv-on.dlv-touchy .lofi { bottom: calc(max(16px, calc(env(safe-area-inset-bottom) + 4px)) + 112px) !important; } /* over Brake (--bh 96px) */
      @media (orientation: portrait) { .compact body.dlv-on.dlv-touchy .toast { bottom: calc(max(16px, calc(env(safe-area-inset-bottom) + 4px)) + 264px); width: max-content; } } /* over the E button */
      @media (orientation: landscape) {
        /* landscape: the short screen keeps the old heights, so the stack over Go ends where it did; the pedals
           grow wide instead, up to the music player centred between the two clusters (138px wide) */
        .compact .dlv-touch { --pw: clamp(64px, calc(25vw - var(--sr) / 2 - 44px), 100px); --gh: 100px; --bh: 88px; }
        .compact .dlv-job { max-width: min(420px, 50%); }
        .compact body.dlv-on .lofi { padding: 0 } .compact body.dlv-on .lofi-name, .compact body.dlv-on .lofi canvas { display: none }
      .compact body.dlv-on.dlv-touchy .lofi { bottom: max(16px, calc(env(safe-area-inset-bottom) + 4px)) !important; }
      }`
    css.textContent += BUS_CSS + TAXI_CSS
    document.head.append(css)
    const el = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; d.hidden = true; document.body.append(d); return d }
    const co = el('dlv dlv-co card', `<div class="name">Salmonberry Parcel Co.</div>
      <div class="stats"><span><b data-n>0</b> delivered</span><span><b data-m>$0.00</b></span><span data-c></span></div><div class="credit">Streets © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</div>`)
    const btns = el('dlv dlv-btns', '<button data-assist title="Lane assist (G): while you aren’t steering, the van gently straightens up along the road it’s on. It never steers against you."></button><button class="opt" data-mute title="Sound (M)">Sound on</button><button data-exit title="Back to the map (Esc)" aria-label="Back to the map"><span class="long">Back to map</span><span class="short">‹ Map</span></button>')
    city.ui.hud?.append(btns) // the host's top right row: the chat button lines up beside it
    const read = el('dlv dlv-read card', '')
    const job = el('dlv dlv-job card', `<div class="dlv-arrow"><div class="n">N</div><svg viewBox="0 0 30 30"><path d="M15 3 L25 25 L15 20 L5 25 Z" fill="#ffc9b5" stroke="#3a2a26" stroke-width="1.5" stroke-linejoin="round"/></svg></div>
      <div><div class="what" data-w></div><div class="where" data-p></div><div class="sub" data-s></div><div class="meta"><span data-d></span><span data-t></span></div></div>`)
    const help = el('dlv dlv-help card', '')
    const act = el('dlv dlv-act card', '')
    const pop = el('dlv dlv-pop card', '<div class="big" data-b></div><div class="q" data-q></div>')
    const pickEl = el('dlv dlv-pick card', `<span data-pt></span><button data-cancel>Cancel</button>`)
    const sheet = el('dlv dlv-sheet card', '')
    const flash = el('dlv dlv-flash', '')
    const photo = el('dlv dlv-photo', '')
    const aboard = document.createElement('div'); aboard.className = 'aboard'; job.lastElementChild.append(aboard)
    const stam = document.createElement('div'); stam.className = 'dlv-stam'; stam.innerHTML = '<i></i>'; job.lastElementChild.append(stam)
    const touch = el('dlv dlv-touch', '<button class="l" data-k="left" aria-label="Turn left">◀</button><button class="r" data-k="right" aria-label="Turn right">▶</button><button class="brk" data-k="brake" aria-label="Brake and reverse">Brake</button><button class="gas" data-k="gas" aria-label="Go">Go</button><button class="hrn" data-k="horn" aria-label="Horn">Horn</button><button class="hb" data-k="hand" aria-label="Handbrake">Hand<br>brake</button><button class="nos" data-k="nos" aria-label="Nitro">Nitro</button><button class="act" data-act hidden></button>')
    const how = el('dlv dlv-how card', '')
    const q = (e, s) => e.querySelector(s)
    return { el, co, btns, read, job, help, act, pop, pickEl, touch, sheet, flash, photo, aboard, stam, stamBar: stam.firstChild,
      how,
      all: [co, btns, read, job, help, act, pop, pickEl, touch, sheet, flash, photo, how], n: q(co, '[data-n]'), m: q(co, '[data-m]'), c: q(co, '[data-c]'),
      assist: q(btns, '[data-assist]'), mute: q(btns, '[data-mute]'), exit: q(btns, '[data-exit]'), arrow: q(job, 'svg'), north: q(job, '.n'), w: q(job, '[data-w]'), p: q(job, '[data-p]'), s: q(job, '[data-s]'),
      d: q(job, '[data-d]'), t: q(job, '[data-t]'), b: q(pop, '[data-b]'), qq: q(pop, '[data-q]'), pt: q(pickEl, '[data-pt]'), cancel: q(pickEl, '[data-cancel]'), brk: q(touch, '.brk'), hrn: q(touch, '.hrn'), hb: q(touch, '.hb'), tact: q(touch, '[data-act]'), css }
  }
  const touchState = { left: false, right: false, gas: false, brake: false, horn: false, hand: false, nos: false }
  touchButtons(ui.touch, touchState, (k) => { audio(); if (k === 'horn') hornOn() }, (k) => { if (k === 'horn') hornOff() })
  ui.tact.addEventListener('click', () => (taxi ? null : game ? game.action() : errand ? hurry() : toggleFoot()))
  ui.exit.onclick = () => exit()
  ui.cancel.onclick = () => cancelPick()
  // Lane assist, on by default: keys and touch buttons steer all or nothing, so holding a straight line takes constant
  // tapping without it. It only acts while nothing is steering, above walking pace, on a road and nearly lined up
  // with it, so it never fights the driver; the choice is remembered.
  function setAssist(on) { assist = on; try { localStorage.setItem('delivery.assist', on ? '1' : '0') } catch {}; assistLabel() }
  function assistLabel() { ui.assist.innerHTML = `<span class="long">Lane assist: ${assist ? 'on' : 'off'}</span><span class="short">Lane ${assist ? 'on' : 'off'}</span>` }
  ui.assist.onclick = () => setAssist(!assist)
  function assistHint() { // once, the first time the van is driven
    try { if (localStorage.getItem('delivery.assistSeen')) return; localStorage.setItem('delivery.assistSeen', '1') } catch { return }
    city.ui.toast(`Lane assist is ${assist ? 'on' : 'off'}: when you let go of the steering, the ${game ? 'bus' : taxi ? 'cab' : 'van'} straightens up along the road.${city.ui.compact ? ' Switch it in the ⋯ menu.' : touchy ? ' The Lane button switches it.' : ' G or the button switches it.'}`, 7000)
  }
  ui.mute.onclick = () => setMuted(!muted)
  ui.mute.textContent = muted ? 'Sound off' : 'Sound on'
  city.ui.inMenu?.(ui.assist); city.ui.inMenu?.(ui.mute)
  let popT = 0, helpT = 0
  function popup(big, line) {
    ui.b.textContent = big; ui.qq.textContent = line
    ui.pop.hidden = false
    requestAnimationFrame(() => ui.pop.classList.add('on'))
    clearTimeout(popT); popT = setTimeout(() => { ui.pop.classList.remove('on'); setTimeout(() => { if (!ui.pop.classList.contains('on')) ui.pop.hidden = true }, 350) }, 2600)
  }
  // how to play, for ten seconds (or until a tap or the first key): three lines for the mode, the controls for this device
  const HOW = {
    car: ['Free roam', ['Drive anywhere: the whole Lower Mainland is open.', 'Yank the handbrake into a corner: long drifts pay.', 'Honk at people, hop kerbs, find the hidden maple leaves.']],
    deliver: ['Deliveries · a 4-minute shift', ['Stop at any beam on the order board: red is a rush order (×2), blue is fragile (×1.5).', 'Then stop at each door. On time and unrattled builds your streak, up to ×3.', 'The clock starts at your first pickup. Go for an S.']],
    bus: ['Bus · keep them happy', ['Follow the blue line and stop in the amber bay at each stop.', 'Open the doors, let everyone on and off, close them, go.', 'Smooth braking and being on time raise happiness: that is your grade.']],
    taxi: ['Rush Fare · beat the clock', ['Stop in a ring to pick someone up, then follow the arrow.', 'Fares add time. Fast drop-offs add more.', 'Drift, jump and graze traffic with a fare aboard for tips and nitro.']],
  }
  function showHowTo() {
    const [title, lines] = HOW[taxi ? 'taxi' : game ? 'bus' : deliver ? 'deliver' : 'car']
    const keysLine = touchy ? `Left: steer · right: gas and brake${game ? ' · Doors button at stops' : ` · ${taxi ? 'Drift and Nitro' : 'Handbrake'} beside them`}`
      : `W gas · S brake · A D steer · ${game ? 'E doors' : taxi ? 'Space drift · Shift nitro' : 'Space handbrake'} · a gamepad works too`
    ui.how.innerHTML = `<h3>${title}</h3><ol>${lines.map((l) => `<li>${l}</li>`).join('')}</ol><div class="k">${keysLine}</div>`
    ui.how.hidden = false; ui.how.classList.remove('fade')
    clearTimeout(howT); howT = setTimeout(hideHowTo, 10000)
  }
  function hideHowTo() { if (ui.how.hidden || ui.how.classList.contains('fade')) return; clearTimeout(howT); ui.how.classList.add('fade'); setTimeout(() => { ui.how.hidden = true; if (!onFoot && state === 'play') assistHint() }, 400) } // (the hint once the card has faded: over it on a phone held sideways, #591)
  function showHelp() { // the keys, for a few seconds after each change between van and feet (always while delivering)
    ui.help.textContent = taxi ? taxi.help() : game ? 'W gas · S brake (a tap is gentle, hold for more) · A D steer · E doors · H horn · R back on the route · Esc end the shift'
      : hike ? 'WASD or arrows to walk · Shift to push on (it tires you; each quarter mark is a second wind) · the trail guides you when you let go · Esc to the map'
      : onFoot ? touchy ? 'Go walks where the camera looks · drag to look round, pinch to zoom' : 'WASD or arrows to walk · Shift to run · drag to look round, wheel to zoom · Space hop · P camera · C sit · G pet a dog · E van · Esc to the map'
      : `W gas · S brake, hold to reverse · A D steer · Space handbrake · E get out · H horn · R back on the road · Esc map`
    ui.help.hidden = false; ui.help.classList.remove('fade')
    clearTimeout(helpT)
    if (!deliver || city.ui.compact) helpT = setTimeout(() => ui.help.classList.add('fade'), city.ui.compact ? 5000 : 7000) // phones: a moment, then out of the way
  }

  // ================================================================ the game state
  const pcam = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 1, 900)
  const opts = { focus: new THREE.Vector3(), radius: 900, shadowRadius: 300 }
  const car = Object.assign(newVan(), { x: 0, y: 0, h: 0, spin: 0, roll: 0, deck: false, bumpT: 0, kerb: true, kneel: 0, tx: 0, ty: 0, tyaw: 0 })
  // the body as boxes (x, north, unit forward, half length and width): one, or two for an articulated bus, whose rear
  // section is towed about the joint (tow())
  const secs = [{ x: 0, y: 0, fx: 0, fy: 1, hl: 2.2, hw: 0.95 }, { x: 0, y: 0, fx: 0, fy: 1, hl: 3.45, hw: 1.28 }]
  let nsec = 1, game = null, busSpawn = null // game: a bus shift (route.js)
  let taxi = null, taxiChoice = null, garage = null, toGarage = false // taxi: a Rush Fare shift (taxi.js); the cab chosen in the garage
  function boxes() {
    const V = car.V, a = secs[0]
    a.x = car.x; a.y = car.y; a.fx = fwdX(car.yaw); a.fy = fwdY(car.yaw); a.hl = V.hl; a.hw = V.hw
    nsec = V.joint ? 2 : 1
    if (nsec === 2) { const b = secs[1], jx = car.x - a.fx * V.joint, jy = car.y - a.fy * V.joint; b.fx = fwdX(car.tyaw); b.fy = fwdY(car.tyaw); b.x = jx - b.fx * V.rear[0]; b.y = jy - b.fy * V.rear[0]; b.hl = V.rear[1]; b.hw = V.hw }
  }
  // the rear section follows the joint like a trailer: its axle is pulled along the line to the joint (at most 46° off)
  function tow() {
    const V = car.V
    if (!V.joint) return
    const jx = car.x - fwdX(car.yaw) * V.joint, jy = car.y - fwdY(car.yaw) * V.joint
    let ty = yawFromDir(Math.atan2(jy - car.ty, jx - car.tx))
    const rel = wrap(ty - car.yaw)
    if (Math.abs(rel) > 0.8) ty = car.yaw + Math.sign(rel) * 0.8
    car.tyaw = ty; car.tx = jx - fwdX(ty) * V.trail; car.ty = jy - fwdY(ty) * V.trail
  }
  function resetTrailer() { const V = car.V; car.tyaw = car.yaw; car.tx = car.x - fwdX(car.yaw) * ((V.joint || 0) + (V.trail || 0)); car.ty = car.y - fwdY(car.yaw) * ((V.joint || 0) + (V.trail || 0)); boxes() }
  const man = { x: 0, y: 0, h: 0, deck: false, yaw: 0, speed: 0, phase: 0, run: false, bumpT: 0, board: null, stamina: 1, winded: false, lean: 0, bank: 0, air: 0 }
  const chase = { pos: new THREE.Vector3(), look: new THREE.Vector3(), yaw: 0, pitch: 0.12, dist: 4.3 } // (pitch, dist: on foot, where the camera orbits)
  const orbit = orbitLook(city.canvas)
  let state = 'off', anim = null, offFrame = null, t0 = 0, mapPose = null, fromPose = null, saved = null
  let deliver = false, onFoot = false, hasVan = true, assist = true, job = null, hudAt = 0, readAt = 0, street = null, shake = 0, skyAt = 0, fogFar = 850
  let pickKind = null, hike = null, errand = null, grip = 1, propsAt = null, kerbsAt = null, vista = 0 // vista: 0 .. 1 the photo's long view
  const scratch = { people: [], poles: [], props: new Float32Array(700 * 5), seen: new Map() }
  try { assist = localStorage.getItem('delivery.assist') !== '0' } catch {}
  assistLabel()
  const keys = new Set()
  let feel = null // feel.js: tyre marks, sparks, speed lines, squeal (while something is driven)
  let howT = 0, drift = { m: 0, t: 0, show: 0, text: '' } // a free-roam drift under way: metres so far
  let autopilot = null, probe = null // ?drivedebug (tools/drive_check.mjs): the input instead of the keys; told of every hit

  const button = city.ui.addButton({ label: 'Explore', icon: '🧭', title: 'Explore the streets by van, bus, cab or on foot, deliver parcels (D), hike a trail', panel: true, dock: true })
  button.panel.innerHTML = `<div class="dlv-menu">
    <button data-m="car"><span>🚐</span><div>Explore by van<small>Drive anywhere, no jobs</small></div></button>
    <button data-m="foot"><span>🚶</span><div>Explore on foot<small>Walk the sidewalks; ${touchy ? 'hop' : 'E gets'} in the van</small></div></button>
    <button data-m="deliver"><span>📦</span><div>Deliveries<small>Pick up at real shops, drop off at real doors; a compass, tips</small></div></button>
    <button data-m="bus"><span>🚌</span><div>Drive a bus<small>Real TransLink routes on their timetable: stops, riders, the bell</small></div></button>
    <button data-m="hike"><span>🥾</span><div>Hike a trail<small>Grouse Grind, Quarry Rock, Lynn Canyon and more</small></div></button>
    <button data-m="taxi"><span>🚕</span><div>Rush Fare<small>Arcade cabs against the clock: fares across town, stunts, nitro</small></div></button></div>`
  const menuEl = button.panel.querySelector('.dlv-menu'), menuHTML = menuEl.innerHTML
  function hikeLog() { try { return JSON.parse(localStorage.getItem('drive.hikes') || '{}') } catch { return {} } }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  function menu() {
    for (const b of menuEl.querySelectorAll('[data-m]')) b.addEventListener('click', () => {
      if (b.dataset.m === 'bus') { // the routes, then which way
        const back = () => { menuEl.innerHTML = menuHTML; menu() }
        menuEl.innerHTML = '<div class="bus-note" style="padding:8px">Loading the routes…</div>'
        loadLines().then((data) => { if (menuEl.isConnected) picker(menuEl, data, (c) => { closeMenu(); startBus(c) }, back) })
          .catch((e) => { console.warn('drive: bus routes', e); menuEl.innerHTML = '<div class="bus-note" style="padding:8px">Couldn’t load the routes. Try again in a moment.</div><button class="back" data-back>‹ Back</button>'; menuEl.querySelector('[data-back]').onclick = back })
        return
      }
      if (b.dataset.m === 'hike') { // the trailheads, then back to the menu
        const log = hikeLog()
        menuEl.innerHTML = HIKES.map((h) => `<button data-h="${h.id}"><span>⛰️</span><div>${h.name}<small>${h.blurb}</small></div>${log[h.id] ? `<span class="done">${foot.medal(h.id) || '✓'} ${mmss(log[h.id].best)}</span>` : ''}</button>`).join('') + '<button class="back" data-back>‹ Back</button>'
        for (const e of menuEl.querySelectorAll('[data-h]')) e.addEventListener('click', () => { closeMenu(); startHike(HIKES.find((h) => h.id === e.dataset.h)) })
        menuEl.querySelector('[data-back]').addEventListener('click', () => { menuEl.innerHTML = menuHTML; menu() })
        return
      }
      if (b.dataset.m === 'taxi') { closeMenu(); return showGarage() }
      closeMenu(); startPick(b.dataset.m)
    })
  }
  // Rush Fare: the garage first (taxi.js), then where to start on the map
  function showGarage() {
    if (garage || state !== 'off') return
    audio()
    garage = openGarage(THREE, (c) => { garage = null; taxiChoice = c; startPick('taxi') }, () => { garage = null })
  }
  function closeMenu() { button.panel.hidden = true; button.button.setAttribute('aria-expanded', 'false'); setTimeout(() => { menuEl.innerHTML = menuHTML; menu() }, 300) }
  menu()

  // ---------------------------------------------------------------- pick where to start
  const spotPicker = mapPicker(city, 'dlv-picking', (x, z) => {
    const g = { x, y: -z }, kind = pickKind
    const spot = kind === 'foot' ? footSpawn(g.x, g.y) : carSpawn(g.x, g.y)
    if (!spot) { city.ui.toast(kind === 'foot' ? 'Nowhere to walk there: try a street' : 'No street there: try closer to a road'); return }
    cancelPick()
    start(kind, spot, g)
  })
  function startPick(kind) {
    if (state === 'pick') cancelPick()
    if (state !== 'off') return
    pickKind = kind; state = 'pick'
    audio()
    ui.pt.textContent = `${touchy ? 'Tap' : 'Click'} where to start ${kind === 'foot' ? 'walking' : kind === 'car' ? 'driving' : kind === 'taxi' ? 'your shift: downtown is busiest' : 'your shift'}`
    ui.pickEl.hidden = false
    spotPicker.on()
  }
  function cancelPick() {
    if (state !== 'pick') return
    state = 'off'
    ui.pickEl.hidden = true
    spotPicker.off()
  }
  function nearestPiece(x, y, ok, pen, maxD) { // over detail tiles near (x, y), else the overview tiles
    let best = null, bd = maxD
    const scan = (t) => {
      for (const p of t.graph.pieces) {
        if (!ok(p)) continue
        const P = p.pts, k = pen(p)
        for (let i = 0; i < P.length / 2 - 1; i++) {
          const x0 = P[i * 2], y0 = P[i * 2 + 1], dx = P[i * 2 + 2] - x0, dy = P[i * 2 + 3] - y0
          if (Math.min(x0, x0 + dx) > x + bd || Math.max(x0, x0 + dx) < x - bd || Math.min(y0, y0 + dy) > y + bd || Math.max(y0, y0 + dy) < y - bd) continue
          const u = clamp(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1), 0, 1), d = Math.hypot(x - x0 - dx * u, y - y0 - dy * u) + k
          if (d < bd) { bd = d; best = { x: x0 + dx * u, y: y0 + dy * u, dir: Math.atan2(dy, dx), w: p.w, p } }
        }
      }
    }
    const near = (t) => x > t.ox - maxD && x < t.ox + t.size + maxD && y > t.oy - maxD && y < t.oy + t.size + maxD
    for (const t of infos.values()) if (near(t)) scan(t)
    if (!best) for (const t of overview.values()) if (near(t)) scan(t)
    return best
  }
  function carSpawn(x, y) { // the kerb lane of the street nearest (x, y), rather a street than a motorway or a parking aisle
    const r = nearestPiece(x, y, (p) => drivable(p) && !p.z, (p) => (p.kind <= 1 ? 60 : p.kind === 6 ? 20 : 0), 300)
    if (!r) return null
    const off = r.w * 0.22 // right-hand traffic: the right half of the road
    return { x: r.x + Math.cos(r.dir - Math.PI / 2) * off, y: r.y + Math.sin(r.dir - Math.PI / 2) * off, yaw: yawFromDir(r.dir) }
  }
  function footSpawn(x, y) { // a footpath, or the sidewalk of the street nearest (x, y), on the side of the click
    const r = nearestPiece(x, y, (p) => walkable(p) && !p.z, () => 0, 300)
    if (!r) return null
    const p = r.p
    let off = 0
    if (p.kind <= 7) off = p.w / 2 + (p.band ? ((p.kind === 5 || p.kind === 4) ? 2.2 : 0) + (p.kind <= 3 ? 1.6 : 1.0) : 1.3)
    const nx = -Math.sin(r.dir), ny = Math.cos(r.dir), side = (x - r.x) * nx + (y - r.y) * ny >= 0 ? 1 : -1
    return { x: r.x + nx * off * side, y: r.y + ny * off * side, yaw: yawFromDir(r.dir), road: r }
  }
  const yawFromDir = (dir) => dir - Math.PI / 2 // road direction atan2(dy, dx) in (x, north) to a yaw
  const fwdX = (yaw) => -Math.sin(yaw), fwdY = (yaw) => Math.cos(yaw) // forward in (x, north)
  // photo walk, sitting, hike splits and wildlife (foot.js)
  const foot = makeFoot(THREE, city, { man, walker, popup, sfx, audio: () => (audio() ? master : null), pathAt: (x, y) => { const r = nearestRoad(x, y, 3, true, true, false, man.h - 0.5); return r ? { d: r.d, drv: r.s.drv, steps: r.s.p.kind === 12 } : null }, chase, orbit, yawOf: (dx, dy) => yawFromDir(Math.atan2(dy, dx)), wallHit, wet: isWater, fwdX, fwdY, hikeSpeed: HIKE, flash() { ui.flash.hidden = false; ui.flash.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => ui.flash.classList.remove('on'))); setTimeout(() => { ui.flash.hidden = true }, 1000) } })

  function start(kind, spot, at) {
    deliver = kind === 'deliver'
    onFoot = kind === 'foot' || kind === 'hike'
    hike = kind === 'hike' ? at.hike : null
    document.activeElement?.blur?.() // a focused toolbar button would take Space (brake) as a click
    Object.assign(car, newVan(kind === 'bus' ? (at.pick.r.artic ? ARTIC : CITYBUS) : kind === 'taxi' ? specOf(CABS[taxiChoice.cab]) : VAN), { roll: 0, deck: false, roof: undefined, kerb: true, parked: onFoot, kneel: 0, lift: 0, vy: 0, airT: 0, airMax: 0, airDeck: false })
    errand = null; carried.visible = false
    if (kind === 'bus') { // the shift: where it starts (the first stop, or the one nearest the middle of the map)
      vehicle = at.bus
      game = busGame(busCtx(), at.pick, at.data)
      spot = busSpawn = game.startAt(at.pick.from, at.x, at.y)
    }
    paintVan(); walker.paint({ shirt: city.progress?.choice('shirt')?.value, pants: city.progress?.choice('pants')?.value, cap: city.progress?.choice('cap')?.value })
    if (kind === 'taxi') vehicle = makeCab(THREE, CABS[taxiChoice.cab], taxiChoice.livery, DRIVERS[taxiChoice.driver])
    if (onFoot) {
      Object.assign(man, { x: spot.x, y: spot.y, yaw: spot.yaw, speed: 0, board: null, stamina: 1, winded: false, roof: undefined })
      man.h = city.world.heightAt(man.x, -man.y) + 0.15
      const v = !hike && carSpawn(at.x, at.y) // the van waits on the street nearby (not at a trailhead)
      hasVan = !!v && Math.hypot(v.x - man.x, v.y - man.y) < 120
      if (hasVan) Object.assign(car, { x: v.x, y: v.y, yaw: v.yaw })
    } else { hasVan = true; Object.assign(car, { x: spot.x, y: spot.y, yaw: spot.yaw }) }
    resetTrailer()
    if (hasVan) car.h = surface(car.x, car.y, city.world.heightAt(car.x, -car.y) + 0.2).y
    // where the map camera is: the dive starts there, and Esc returns there exactly
    mapPose = mapCameraPose(city)
    chase.yaw = body().yaw
    chasePose(0, true)
    street = null; propsAt = kerbsAt = null
    saved = { bg: city.scene.background, fog: city.scene.fog }
    if (hasVan) city.scene.add(vehicle)
    city.scene.add(walker, icons.pickup, icons.drop, icons.summit, icons.stop, props.group, lips.mesh)
    walker.visible = onFoot
    icons.pickup.visible = icons.drop.visible = icons.summit.visible = false
    city.overlay.add(blob, blob2, wblob, beam, ring, ring2, pool)
    feel = hasVan ? makeFeel(THREE, city, { audio, out: () => master }) : null
    beam.visible = ring.visible = ring2.visible = false
    wblob.visible = onFoot; blob.visible = hasVan; blob2.visible = nsec === 2
    blob.scale.set(car.V.width / 1.8, 1, (car.V.hl * 2 + 0.6) / 4.3); blob2.scale.set(car.V.width / 1.8, 1, ((car.V.rear?.[1] || 0) * 2 + 0.6) / 4.3)
    if (hike) setGoal(hike.gx, hike.gy, 0x7fe0b0, icons.summit)
    if (onFoot) foot.start(hike)
    if (kind === 'taxi') taxi = taxiGame(taxiCtx(), taxiChoice)
    if (deliver) job = deliveryGame(deliverCtx())
    place()
    fitCamera()
    cellsNear(body().x, body().y, 800)
    state = 'in'; t0 = performance.now()
    city.view.useCamera(pcam, opts); orbit.on()
    anim = city.animate()
    offFrame = city.on('frame', frame)
    document.body.classList.add('dlv-on')
    document.body.classList.toggle('dlv-touchy', touchy)
    button.button.setAttribute('aria-pressed', 'true')
    pose(0)
    publishPlayer(true)
  }
  // a hike: straight to its trailhead (the nearest trail there once its tiles are in), facing up the trail
  function startHike(h) {
    if (state === 'pick') cancelPick()
    if (state !== 'off') return
    audio()
    const a = city.world.fromLatLon(...h.from), b = city.world.fromLatLon(...h.to)
    const x = a.x, y = -a.z, gx = b.x, gy = -b.z
    const r = nearestPiece(x, y, (p) => trail(p) && !p.z, () => 0, 60)
    const spot = r ? { x: r.x, y: r.y } : { x, y }
    spot.yaw = yawFromDir(Math.atan2(gy - spot.y, gx - spot.x))
    start('hike', spot, { x, y, hike: { ...h, gx, gy, sx0: spot.x, sy0: spot.y, t0: 0, climb: 0, lastH: null, snapped: !!r, photo: null, done: false } })
  }
  // a bus: its route's data and the bus for it, then the dive to its first stop (or the stop nearest the map's middle)
  async function startBus(pick) {
    if (state === 'pick') cancelPick()
    if (state !== 'off') return
    audio()
    let data
    try { data = await loadRoute(pick.ri) } catch (e) { console.warn('drive: route', e); city.ui.toast('Couldn’t load that route: try again in a moment'); return }
    if (state !== 'off') return
    const c = city.view.center
    start('bus', null, { pick, data, bus: makeBus(THREE, { artic: pick.r.artic, trolley: pick.r.kind === 'trolley', accent: accentOf(pick.r) ?? undefined }), x: c.x, y: -c.z })
  }
  // what a bus shift (route.js) gets to work with
  function busCtx() {
    return { THREE, city, car, bus: vehicle, secs, roadAlong, nearestStreet, touchy, popup, sfx, buzz, setGoal, hideMarkers, icon: icons.stop, el: ui.el,
      loaded: (x, y) => infos.has(ckey(Math.floor(x / 1024), Math.floor(y / 1024))),
      toast: (t, ms) => city.ui.toast(t, ms), muted: () => muted, audio, out: () => master, tone: (...a) => tone(...a), bell: (...a) => bell(...a),
      doors: (k) => setDoors(vehicle, k),
      place: (x, y, yaw, h) => { Object.assign(car, { x, y, yaw, h }); resetTrailer() },
      summary: () => summary(),
    }
  }
  // what a Rush Fare shift (taxi.js) gets to work with
  function taxiCtx() {
    return { THREE, city, car, cab: vehicle, pcam, el: ui.el, sheet: ui.sheet, touchy, audio, out: () => master, tone: (...a) => tone(...a), bell: (...a) => bell(...a), sfx, buzz,
      setGoal, hideMarkers, icon: icons.summit, segsNear, stopFor, insideBuilding, isWater, others, placesNear,
      reset: () => resetToRoad(), exit: (f) => exit(f), toGarage: () => { toGarage = true; exit(true) }, shake: (v) => { shake = Math.max(shake, v) } }
  }
  function exit(force) {
    hornOff()
    if (state === 'pick') return cancelPick()
    if (state !== 'play') return
    if (taxi && !force) return taxi.endShift() // the results first
    if (job && !force && job.S.started) return job.results() // the end-of-shift card first
    if (game && !force && (game.S.carried || game.S.km > 0.3)) return summary()
    game?.dispose()
    taxi?.dispose(); taxi = null
    ui.sheet.hidden = true; ui.photo.classList.remove('on'); ui.how.hidden = true
    fromPose = poseOf(chase.pos, chase.look, pcam.fov)
    state = 'out'; t0 = performance.now()
    if (city.tiles?.baseMesh) city.tiles.baseMesh.position.y = 0 // (sunk in a tunnel)
    for (const e of ui.all) e.hidden = true
    document.body.classList.remove('dlv-shot')
    keys.clear()
    if (engine) engine.g.gain.setTargetAtTime(0, ac.currentTime, 0.2)
    traffic()?.setObstacle('player-van', null); traffic()?.setObstacle('player-walker', null)
  }
  function finish() { // back on the map camera, exactly where it was
    state = 'off'
    city.view.release(); orbit.off()
    offFrame?.(); offFrame = null
    anim?.(); anim = null
    city.scene.remove(vehicle, walker, icons.pickup, icons.drop, icons.summit, icons.stop, props.group, lips.mesh)
    city.overlay.remove(blob, blob2, wblob, beam, ring, ring2, pool)
    feel?.dispose(); feel = null
    if (vehicle !== van) { // the bus goes back to the depot
      vehicle.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); for (const mt of [].concat(m.material)) { mt.map?.dispose(); mt.dispose() } } })
      vehicle = van
    }
    game = null; busSpawn = null
    city.scene.background = saved.bg; city.scene.fog = saved.fog
    if (toGarage) { toGarage = false; setTimeout(showGarage, 0) }
    hike = null; errand = null; job?.dispose(); job = null; vista = 0
    foot.stop()
    publishPlayer(true)
    document.body.classList.remove('dlv-on', 'dlv-touchy', 'dlv-shot'); document.documentElement.classList.remove('dlv-assist')
    button.button.setAttribute('aria-pressed', 'false')
    city.requestRender()
  }
  // what a delivery shift (deliver.js) gets to work with
  function deliverCtx() {
    return { THREE, city, body, stopFor, address, placesNear, setGoal, hideMarkers, icons, popup, sfx, buzz, ui, abbr, dist, mmss, busy: () => !!errand || !!man.board,
      exit: (f) => exit(f), again: () => { job.dispose(); job = deliveryGame(deliverCtx()); hideMarkers(); showHowTo() } }
  }
  function summary() { return busSummary() }
  function busSummary() {
    const g = game.summary()
    game.S.summary = true
    ui.sheet.innerHTML = `<h3>${g.title} · shift summary</h3><div class="rank r${g.rank}">${g.rank}</div><div class="big">${g.big}</div><div class="stars">${'★'.repeat(g.stars)}${'☆'.repeat(5 - g.stars)}</div>
      <dl>${g.rows}</dl><div class="line">${g.line}</div><div class="row"><button data-k>Keep driving</button><button class="main" data-end>End shift</button></div>`
    ui.sheet.hidden = false
    keys.clear()
    ui.sheet.querySelector('[data-k]').onclick = () => { ui.sheet.hidden = true; if (game) game.S.summary = false }
    ui.sheet.querySelector('[data-end]').onclick = () => exit(true)
  }
  const body = () => (onFoot ? man : car) // what the camera follows and the jobs measure from

  // ---------------------------------------------------------------- camera
  function fitCamera() {
    pcam.aspect = innerWidth / innerHeight
    pcam.updateProjectionMatrix()
  }
  const chaseFov = () => (innerWidth < innerHeight ? 72 : onFoot ? 62 : 58) + (taxi && !onFoot ? taxi.fov : !onFoot && feel ? feel.fov : 0) // a van's view widens with speed; a cab's FOV kicks out with speed and nitro
  function chasePose(dt, snap) {
    const k = snap ? 1 : 1 - Math.exp(-(onFoot ? 4 : 3.2) * dt), P = body()
    const sp = Math.max(0, P.speed)
    // on foot the camera orbits: a drag, the wheel, a pinch or the right stick look round and zoom (to the eye at the
    // closest); left alone a moment while walking, it comes round behind again (not when walking at it)
    orbit.step(dt)
    const [oy, op, oz] = orbit.take(), eye = onFoot && chase.dist < 1
    if (onFoot) {
      chase.yaw += oy; chase.pitch = clamp(chase.pitch + op, eye ? -1.1 : -0.3, 1.25); chase.dist = clamp(chase.dist * oz, 0.6, 10)
      const d = wrap(P.yaw - chase.yaw)
      if (snap) chase.yaw = P.yaw
      else if (orbit.idle > 1.2 && sp > 0.5 && Math.abs(d) < 2.4) chase.yaw += clamp(d * 2.2, -2, 2) * dt
      if (foot.framing) man.yaw += oy; else walker.visible = !eye
    } else if (Math.abs(car.speed) > 0.5 || snap) chase.yaw += wrap(P.yaw - chase.yaw) * k
    const fx = fwdX(chase.yaw), fy = fwdY(chase.yaw), cp = Math.cos(chase.pitch), tp = Math.sin(chase.pitch)
    const od = eye ? 0 : chase.dist * (1 + sp * 0.04), eyeH = (eye ? 1.62 : 1.5) - (onFoot ? foot.low : 0) // the orbit's radius, the height of its middle over the feet
    const big = onFoot ? 0 : car.V.length - 4.3 // a bus: further back and up
    // a bus keeps to the kerb lane: the camera a little out over the road, clear of the street trees; at a stop with
    // its doors open it swings round in front, looking back at the front door and the people getting on
    const doors = !!game?.doors && Math.abs(car.speed) < 0.5 && !snap
    if (!doors) doorCam = null; else if (!doorCam) doorCam = pickDoorCam(P)
    const back = onFoot ? od * cp : doors ? -(car.V.hl + doorCam[0]) : 8.6 + big * 0.8 + (taxi ? Math.min(sp, 22) : sp) * 0.14, up = onFoot ? eyeH + od * tp : doors ? 3.8 : 4.3 + big * 0.2 + sp * 0.05
    const off = onFoot ? 0.4 * Math.min(1, od / 3) : !game ? 0 : doors ? doorCam[1] : -2.2 // (on foot: over the right shoulder)
    const bx = P.x - fx * back + fy * off, by = P.y - fy * back - fx * off
    // in a tunnel: under its ceiling, and the buildings overhead are no walls; so while the camera is still in the tube the
    // player has just come out of (else it rose through the roof and the portal's headwall behind them)
    const still = P.roof != null ? null : nearestRoad(bx, by, 1, true, false, false, P.h - 0.58)
    const roof = P.roof != null ? P.roof : still?.s.p.tunnel && still.d < 0.6 && Math.abs(still.z + 0.58 - P.h) < 3 ? still.z + still.s.p.tunnel : null
    const tube = roof != null
    if (city.tiles?.baseMesh) city.tiles.baseMesh.position.y = tube ? -120 : 0 // (the far map's picture lies 4 m under the ground, through a tunnel deeper than that: sunk under it meanwhile)
    const lift = onFoot ? 0 : car.lift // (a cab in the air: the camera rises with it)
    const gy = tube ? Math.min(P.h + up, roof - 0.7) : Math.max(city.world.heightAt(bx, -by) + (onFoot ? 0.9 : 1.4), P.h + up + lift)
    v3.set(bx, gy, -by)
    if (snap) chase.pos.copy(v3); else chase.pos.lerp(v3, 1 - Math.exp(-(doors ? 1.6 : eye ? 40 : taxi || onFoot ? 10 : 7) * dt))
    if (tube) chase.pos.y = Math.min(chase.pos.y, roof - 0.7)
    // under a building's raised part (the player, or the camera behind it): under its underside too, where it is no
    // wall (the camera used to rise into the storeys over a lane and look out from inside them)
    // (again once the walls have moved it: they may push it under one)
    const duck = () => { if (!tube) chase.pos.y = Math.min(chase.pos.y, Math.min(ceilingAt(P.x, P.y, P.h + lift + 1.8), ceilingAt(chase.pos.x, -chase.pos.z, P.h + lift + 1.8)) - 0.7) }
    duck()
    // keep the camera out of buildings, every frame and after the smoothing (so it never glides through a wall):
    // on the line from the player to the camera, stop short of the first wall; then step off walls beside it
    // (a metre clear: cornices, awnings and balconies stand out from the footprint. At the camera's height, so the
    // parts of buildings over an arcade or a passage, which the van drives under, are walls to it too)
    const cx = chase.pos.x, cy = -chase.pos.z, ch = chase.pos.y + 0.5, k0 = tube ? 1 : wallHit(P.x, P.y, cx, cy, ch)
    if (k0 < 1) {
      const len = Math.hypot(cx - P.x, cy - P.y) || 1, k = Math.max(0, k0 - 1 / len)
      chase.pos.x = P.x + (cx - P.x) * k; chase.pos.z = -(P.y + (cy - P.y) * k)
    }
    const side = !tube && !eye && collide(chase.pos.x, -chase.pos.z, 1, ch, 2) // (at the eye: where the walker's own collision keeps it)
    if (side) { chase.pos.x += side.x; chase.pos.z -= side.y }
    // and out of tree trunks (their crowns dissolve between the lens and the player: materials.js occluder)
    if (!tube) propsNear(chase.pos.x, -chase.pos.z, 1.3, (x, y, r, kind, ang, g) => {
      const dx = chase.pos.x - x, dy = -chase.pos.z - y, d = Math.hypot(dx, dy), m = r + nearPlane() + 0.2 - d
      if (!kind && m > 0 && d > 1e-3 && chase.pos.y - g < 8) { chase.pos.x += (dx / d) * m; chase.pos.z -= (dy / d) * m }
    })
    duck()
    // the near plane comes in when a wall is close, so it never cuts through one
    const wall = !tube && collide(chase.pos.x, -chase.pos.z, 2.5, ch, 2)
    // (its corners are further out than its middle, the more the wider the view: a cab at speed looked through the
    // wall of a lane with 0.6 of the distance; and by the nearest wall, not the sum of the pushes off two)
    const tn = Math.tan((pcam.fov * Math.PI) / 360)
    chase.near = wall ? clamp((hitD * 0.9) / Math.sqrt(1 + tn * tn * (1 + pcam.aspect * pcam.aspect)), eye ? 0.1 : 0.2, nearPlane()) : nearPlane()
    const ahead = onFoot ? 3 : doors ? car.V.hl - 3 : 6 + big * 0.3, right = doors ? car.V.hw + 1.2 : 0
    if (onFoot) { const a = eye ? 10 : 3; v4.set(P.x + fx * a * cp + fy * off, P.h + eyeH - a * tp, -(P.y + fy * a * cp - fx * off)) } // along the camera's own line
    else v4.set(P.x + fwdX(P.yaw) * ahead + fwdY(P.yaw) * right, P.h + lift + 1.0, -(P.y + fwdY(P.yaw) * ahead - fwdX(P.yaw) * right))
    if (snap) chase.look.copy(v4); else chase.look.lerp(v4, 1 - Math.exp(-(doors ? 2 : eye ? 40 : onFoot ? 14 : 10) * dt))
  }
  // where the camera stands at a stop, in front of the bus: metres past its nose and to the side (− out over the road).
  // The first spot (once a stop) with no tree crown in its view of the front door or by the lens, and no pole, lamp or
  // sign right in front of it; materials.js occluder dissolves whatever is still in the way
  const DOOR_CAMS = [[9, -1.2], [9, -4], [6, -2.6], [12, -5.5], [7, 1.8]]
  let doorCam = null
  function pickDoorCam(P) {
    const fx = fwdX(P.yaw), fy = fwdY(P.yaw), lx = P.x + fx * (car.V.hl - 3) + fy * (car.V.hw + 1.2), ly = P.y + fy * (car.V.hl - 3) - fx * (car.V.hw + 1.2)
    let best = DOOR_CAMS[0], fewest = Infinity, bx, by, dx, dy, L2, hits
    const hit = (x, y, r, kind) => { // kind 0: a tree (r its trunk, about 0.03 of the crown's width)
      const ex = x - bx, ey = y - by, e = Math.hypot(ex, ey), u = clamp((ex * dx + ey * dy) / L2, 0, 1), d = Math.hypot(bx + dx * u - x, by + dy * u - y)
      if (kind) { if (u < 0.5 && d < r + 1.2) hits++; return }
      const cr = r / 0.07, ahead = ex * dx + ey * dy > e * Math.sqrt(L2) * 0.7 // within 45° of the view's centre
      if (d < cr + 0.8 || e < cr + 3 || (ahead && cr / e > 0.18)) hits++ // in the line of sight, by the lens, or big in the frame
    }
    for (const c of DOOR_CAMS) {
      bx = P.x + fx * (car.V.hl + c[0]) + fy * c[1]; by = P.y + fy * (car.V.hl + c[0]) - fx * c[1]; dx = lx - bx; dy = ly - by; L2 = dx * dx + dy * dy; hits = 0
      const mx = (bx + lx) / 2, my = (by + ly) / 2, r = Math.sqrt(L2) / 2 + 6
      propsNear(mx, my, r, hit)
      for (const o of poles(mx, my, r)) hit(o.x, -o.z, o.r, 1)
      if (hits < fewest) { best = c; fewest = hits; if (!hits) break }
    }
    return best
  }
  // near and far as tight as the view allows (the ground layers are only centimetres apart): near 1 m behind the van,
  // 0.5 m on foot; far just past the fog, where everything has faded into the sky anyway
  const nearPlane = () => (onFoot ? 0.5 : 1.0)
  // the dive: from a nearly orthographic long lens over the map down to the chase camera (e: 0 map .. 1 chase)
  const chaseTo = poseOf(chase.pos, chase.look, 58)
  function pose(e) {
    if (state === 'out') dive(pcam, opts, mapPose, fromPose, 1 - e, nearPlane(), atmosphere)
    else dive(pcam, opts, mapPose, poseOf(chase.pos, chase.look, chaseFov(), chaseTo), e, nearPlane(), atmosphere)
  }

  // ---------------------------------------------------------------- sky and fog from the time of day and weather
  const sky = streetSky()
  function hourNow() { return city.weather?.hour ?? vancouver(Date.now()).sec / 3600 } // the weather plugin's hour (it may be set by hand)
  function atmosphere(k) { // k: 0 map look (no fog) .. 1 street look; returns how far the view reaches
    const w = city.weather || {}
    sky.apply(city, pcam.position.distanceTo(opts.focus), k, saved.bg, vista)
    fogFar = sky.far
    const lights = city.light.night > 0.35 || ['storm', 'fog', 'rain'].includes(w.kind)
    const V = vehicle.userData
    V.lights[0].emissiveIntensity = lights ? 1.6 : 0.5
    V.lights[1].emissiveIntensity = lights ? 1.2 : 0.4
    V.night.value = walker.userData.night.value = city.light.night
    if (V.glass) V.glass.emissiveIntensity = smooth(0.25, 0.6, city.light.night) * 0.42 // a bus lit up inside
    pool.visible = !!lights && k > 0.9 && hasVan
    return fogFar
  }

  // ---------------------------------------------------------------- other cars, people and poles (city.traffic, from the life plugin)
  const traffic = () => (city.traffic?.nearby ? city.traffic : null)
  const SELF = new Set(['player-van', 'player-walker'])
  const nearCars = [] // reused every frame
  function others(x, y, r) { // simulated cars and other players near (x, north); mp: true for players
    const near = nearCars
    near.length = 0
    try { const T = traffic(); if (T) for (const o of T.nearby(x, -y, r)) if (!SELF.has(o.id) && !String(o.id).startsWith('mp:')) near.push(o) } catch (e) { console.warn('drive: traffic.nearby', e) }
    try { const M = city.multiplayer; if (M?.nearby) for (const o of M.nearby(x, -y, r)) near.push({ ...o, mp: true }) } catch (e) { console.warn('drive: multiplayer.nearby', e) }
    return near
  }
  const people = (x, y, r) => { try { return traffic()?.people?.(x, -y, r, scratch.people) || [] } catch (e) { console.warn('drive: traffic.people', e); return [] } }
  const poles = (x, y, r) => { try { return traffic()?.poles?.(x, -y, r, scratch.poles) || [] } catch (e) { console.warn('drive: traffic.poles', e); return [] } }
  const otherBox = (o) => ({ x: o.x, y: -o.z, fx: Math.sin(o.heading), fy: -Math.cos(o.heading), hl: (o.length || 4.4) / 2, hw: (o.width || 1.8) / 2 }) // heading: forward (sin, cos) in (x, z)
  function hitTraffic(o, impact, shove = 0) {
    if (o.mp) return
    try { city.traffic?.bump?.(o.id, impact, shove) } catch (e) { console.warn('drive: traffic.bump', e) }
  }
  // bounce the van off something: n (x, north, unit) points from it to the van, (ux, uy) is its velocity. The
  // velocity relative to it is reflected with restitution e and scrubbed; a hit off the middle (off: metres ahead of
  // it) twists the van. Returns the closing speed (0 if they were parting).
  function bounce(nx, ny, ux, uy, e, off) {
    const fx = fwdX(car.yaw), fy = fwdY(car.yaw), rx = fy, ry = -fx
    const vx = fx * car.speed + rx * car.lat - ux, vy = fy * car.speed + ry * car.lat - uy, vn = vx * nx + vy * ny
    if (vn >= 0) return 0
    const k = Math.max(0.55, 1 + 0.04 * vn), wx = (vx - (1 + e) * vn * nx) * k + ux, wy = (vy - (1 + e) * vn * ny) * k + uy
    car.speed = wx * fx + wy * fy; car.lat = wx * rx + wy * ry
    car.kick = clamp(car.kick + 0.07 * off * (fx * ny - fy * nx) * -vn, -0.9, 0.9)
    return -vn
  }
  function carVsTraffic() {
    const fx = fwdX(car.yaw), fy = fwdY(car.yaw), hl = car.V.hl
    for (let i = 0; i < nsec; i++) {
      const me = secs[i]
      for (const o of others(me.x, me.y, 10 + me.hl)) {
        const b = otherBox(o), c = boxBox(me, b)
        if (!c) continue
        car.x += c.nx * c.depth; car.y += c.ny * c.depth; boxes()
        // off a heavy moving wall: the van's velocity relative to it, reflected
        const s0 = car.speed, l0 = car.lat
        const vn = bounce(c.nx, c.ny, b.fx * (o.speed || 0), b.fy * (o.speed || 0), 0.35, clamp((b.x - car.x) * fx + (b.y - car.y) * fy, -hl, hl))
        if (!vn) continue
        // a cab ploughs on: it loses only the other car's share of the momentum, and shoves that car aside
        let shove = 0
        if (taxi) {
          const k = 1400 / (1400 + car.V.mass)
          car.speed = s0 + (car.speed - s0) * k; car.lat = l0 + (car.lat - l0) * k
          shove = clamp(vn * 0.3, 0.6, 2.4) * (-c.nx * b.fy + c.ny * b.fx >= 0 ? 1 : -1) // towards its right (fy, -fx) or left
          taxi.hitCar(o.id)
        }
        bumped(vn, () => hitTraffic(o, vn, shove))
      }
    }
  }
  // poles, posts, trunks (circles at (x, y) of radius r) against the van's box: pushed out, bounced off
  function carVsPost(x, y, r, metal) {
    const fx = fwdX(car.yaw), fy = fwdY(car.yaw), hl = car.V.hl
    for (let i = 0; i < nsec; i++) {
      const B = secs[i], q = circleBox(x, y, r, B.x, B.y, B.fx, B.fy, B.hl, B.hw)
      if (!q) continue
      car.x -= q.x; car.y -= q.y; boxes()
      const l = Math.hypot(q.x, q.y) || 1, vn = bounce(-q.x / l, -q.y / l, 0, 0, 0.2, clamp((x - car.x) * fx + (y - car.y) * fy, -hl, hl))
      probe?.('post', x, y, vn)
      if (vn > 1) bumped(vn, metal && vn > 2 ? sfx.clank : null)
    }
  }
  // (a bus: a tree trunk placed on the carriageway is a crown leaning over it, not a trunk to hit; nor is a post the
  // map puts in the route's own lane, where a street's width is off)
  const postHit = (x, y, r, kind) => {
    if (game) { if (game.inLane(x, y)) return; if (kind === 0) { const q = nearestRoad(x, y, 2); if (q && q.dist < q.w / 2 - 0.4) return } }
    carVsPost(x, y, r, kind !== 0)
  }
  // people: a nudge at a crawl (they're in the way: the van waits), else they stumble or fall over (and get up)
  function carVsPeople(now) {
    if (car.parked) return // people walk round a parked van
    const sp = Math.abs(car.speed)
    for (let i = 0; i < nsec; i++) {
    const B = secs[i], ppl = people(B.x, B.y, B.hl + 5)
    for (const p of ppl) {
      const px = p.x, py = -p.z
      if (Math.abs(p.y - car.h) > 3) continue // on another level (a bridge above, the street below)
      const q = circleBox(px, py, 0.28, B.x, B.y, B.fx, B.fy, B.hl, B.hw)
      if (!q) continue
      const seen = scratch.seen.get(p.id)
      if (sp > 0.7 && !(seen > now - 5000)) {
        if (scratch.seen.size > 300) scratch.seen.clear()
        scratch.seen.set(p.id, now)
        const l = Math.hypot(q.x, q.y) || 1
        traffic()?.knock?.(p.id, q.x / l, -q.y / l, sp)
        car.speed *= sp > 3 ? 0.6 : 0.4 // a soft thump: the van stops short
        shake = Math.max(shake, 0.12); buzz(40)
        sfx.oops()
        startled(sp)
      }
      car.x -= q.x; car.y -= q.y // never through them (nor over someone who's down)
      const l = Math.hypot(q.x, q.y) || 1
      bounce(-q.x / l, -q.y / l, 0, 0, 0, 0)
      boxes()
    }
    }
  }
  function startled(sp) {
    if (taxi) return taxi.oops()
    if (deliver) {
      job?.person()
      popup('Oh! Sorry!', sp > 2.5 ? 'They’re okay, just shaken. That’ll cost you in tips: mind the pedestrians.' : 'A nudge, no harm done. Gently does it.')
    } else popup('Oops, sorry!', sp > 2.5 ? 'They’re fine, dusting themselves off.' : 'Just a nudge.')
  }
  function bumped(impact, fn) {
    const P = body()
    if (impact < 0.8 || performance.now() - P.bumpT < 350) return
    P.bumpT = performance.now()
    sfx.bump(clamp(impact / 9, 0.25, 1))
    buzz(Math.round(clamp(impact * 7, 15, 70)))
    shake = Math.min(0.55, 0.08 + impact * 0.05)
    if (!onFoot && impact > 2) feel?.impact(car, impact)
    if (!onFoot) jolt(car, clamp(impact / 8, 0.1, 0.8), 0, 0)
    if (game && impact > 2) game.bump(impact)
    if (taxi) taxi.bump(impact)
    if (!onFoot && impact > 2) job?.bump(impact)
    fn?.()
  }
  function publishPlayer(emit) { // city.player (player-contract): where the user is, read by others every frame
    const P = body()
    if (state === 'off' || state === 'pick') { if (city.player) { city.player = null; city.emit('player', null) } return }
    const p = city.player || (city.player = { vehicle: 'van', colour: vanColour })
    p.mode = onFoot ? 'foot' : game ? 'bus' : 'car'; p.vehicle = game ? 'bus' : taxi ? 'taxi' : 'van'; p.x = P.x; p.y = P.h; p.z = -P.y; p.heading = wrap(P.yaw + Math.PI); p.speed = P.speed
    if (emit) city.emit('player', p)
  }
  function publish() { // the van and the walker as obstacles the simulated cars brake for
    publishPlayer(false)
    const T = traffic()
    if (!T?.setObstacle) return
    if (hasVan) { // one box over it all (an articulated bus: from its nose to its tail)
      let x = car.x, y = car.y, len = car.V.length, yaw = car.yaw
      if (nsec === 2) { const a = secs[0], b = secs[1], x0 = a.x + a.fx * a.hl, y0 = a.y + a.fy * a.hl, x1 = b.x - b.fx * b.hl, y1 = b.y - b.fy * b.hl; x = (x0 + x1) / 2; y = (y0 + y1) / 2; len = Math.hypot(x1 - x0, y1 - y0); yaw = yawFromDir(Math.atan2(y0 - y1, x0 - x1)) }
      T.setObstacle('player-van', { x, y: car.h, z: -y, heading: wrap(yaw + Math.PI), length: len, width: car.V.width, speed: onFoot ? 0 : Math.abs(car.speed) })
    }
    T.setObstacle('player-walker', onFoot ? { x: man.x, z: -man.y, heading: wrap(man.yaw + Math.PI), length: 0.6, width: 0.6, speed: Math.abs(man.speed) } : null)
  }

  // ---------------------------------------------------------------- driving
  // the surface under (x, north): a bridge deck when the van is on one, else the ground; y = height of the road top
  // the deck a little over or under the van's height (never one crossing over it: a street under an overpass, a
  // motorway bridge under another deck); right at a deck's end (where it meets the street, sometimes a little off the
  // terrain) it may step up or down a little more, not further along it.
  // In a tunnel: its road, under the ground, and roof the height of its ceiling
  function surface(x, y, curY) {
    const g = city.world.heightAt(x, -y) + 0.2 + (taxi ? taxi.rampAt(x, y) : 0) // (a Rush Fare stunt ramp)
    const r = nearestRoad(x, y, 16, true, false, false, curY - 0.58)
    if (!r) return { y: g, deck: false, end: false }
    const P = r.s.p.pts, m = P.length - 2, end = Math.min(Math.hypot(x - P[0], y - P[1]), Math.hypot(x - P[m], y - P[m + 1])) < 10
    const dz = r.z + 0.58
    if (r.over > 0.8 && !joined(r)) return { y: g, deck: false, end } // past a deck's end where nothing raised goes on: the street (not a disc of deck round its end)
    const rp = r.d < (r.s.p.band ? 2.2 : 1.2) ? -1 : railPast(x, y, curY) // (a deck goes on to its railings: a wheel by the rail of a wide bridge is on it, not over the ground far below)
    if (rp < 0 && rp > -Infinity && Math.abs(dz - curY) < (end ? 4 : 1.2)) return r.s.p.tunnel ? { y: dz, deck: true, end, roof: r.z + r.s.p.tunnel } : { y: Math.max(g, dz), deck: dz - g > 1.2, end }
    return { y: g, deck: false, end }
  }
  // does another deck go on from the end of r's piece that (x, y) is past (a joint, not an abutment)
  function joined(r) {
    const p = r.s.p, n = r.u < 0.5 ? p.a : p.b
    if (r.u < 0.5 ? r.s.i !== 0 : r.s.i !== p.pts.length / 2 - 2) return true // past a bend inside the piece
    let on = false
    segsNear(r.px, r.py, 2, (s) => { if (!on && s.z0 != null && s.p !== p && (s.p.a === n || s.p.b === n)) on = true })
    return on
  }
  // how far (x, north) is past the railings (tile-worker.js railings), or a tunnel's walls (tubes), of the decks at about
  // height h: the least of them, so a deck splitting into pieces or one beside another is one surface; -Infinity on a
  // roof (no railings there)
  function railPast(x, y, h) {
    let best = Infinity
    segsNear(x, y, 14, (s) => {
      if (s.z0 == null) return
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0, u = clamp(((x - s.x0) * dx + (y - s.y0) * dy) / (dx * dx + dy * dy || 1), 0, 1)
      if (Math.abs(s.z0 + (s.z1 - s.z0) * u - h) > 2.6) return
      best = Math.min(best, s.p.roof ? -Infinity : Math.hypot(x - s.x0 - dx * u, y - s.y0 - dy * u) - (s.p.tunnel ? s.p.tw || s.p.w / 2 + 0.6 : s.p.w / 2 + (s.p.band ? 2 : 0)))
    })
    return best
  }
  const roadAt = (x, y, h) => { const r = nearestRoad(x, y, 2); return !!r && r.d < 0.5 && (r.z == null ? h - (city.world.heightAt(x, -y) + 0.2) < 3 : Math.abs(r.z + 0.58 - h) < 3) }
  function input() {
    const L = keys.has('ArrowLeft') || keys.has('KeyA') || touchState.left, R = keys.has('ArrowRight') || keys.has('KeyD') || touchState.right
    const up = keys.has('ArrowUp') || keys.has('KeyW') || touchState.gas, dn = keys.has('ArrowDown') || keys.has('KeyS') || (!onFoot && touchState.brake)
    const shiftKey = keys.has('ShiftLeft') || keys.has('ShiftRight')
    // a gamepad (standard mapping): left stick or d-pad, RT / A gas, LT / B brake, X handbrake, RB / Y nitro or run
    const pads = navigator.getGamepads?.() || NONE
    let gp = null
    for (const p of pads) if (p?.connected && p.mapping === 'standard') { gp = p; break }
    const B = (i) => !!gp?.buttons[i]?.pressed, ax = gp ? (Math.abs(gp.axes[0]) > 0.15 ? gp.axes[0] : 0) + (B(15) ? 1 : 0) - (B(14) ? 1 : 0) : 0
    const fwd = B(7) || B(0) || B(12) || (onFoot && !!gp && gp.axes[1] < -0.3), back = B(6) || B(1) || B(13) || (onFoot && !!gp && gp.axes[1] > 0.3)
    return { steer: clamp((L ? 1 : 0) - (R ? 1 : 0) - ax, -1, 1), up: up || fwd || (onFoot && touchState.brake), down: dn || back, hand: keys.has('Space') || touchState.hand || B(2), run: shiftKey || B(5) || B(3) || (onFoot && touchState.brake), boost: shiftKey || touchState.nos || B(5) || B(3) }
  }
  // tyres grip less in the rain and much less in snow (the weather plugin's city.surface), a little less off the tarmac
  const gripNow = () => clamp(1 - 0.3 * (city.surface?.wet || 0) - 0.8 * (city.surface?.snow || 0), 0.3, 1) * (car.kerb ? 1 : 0.9)
  const vin = { up: false, down: false, steer: 0, hand: false }
  const STILL = { steer: 0, up: false, down: false, hand: false, run: false, boost: false } // no input (a card is up, a countdown)
  function drive(dt, I) {
    // Lane assist: with no steering, a gentle steer along the road the van is on
    let steer = I.steer
    if (assist && !steer && car.speed > 2.5 && !car.parked) {
      const r = car.deck ? nearestRoad(car.x, car.y, 3, true, false, false, car.h - 0.58) : nearestRoad(car.x, car.y, 3) // on a deck or in a tunnel: that road, not the one over or under it
      if (r && r.d < 0.5) {
        let d = wrap(yawFromDir(r.dir) - car.yaw)
        if (Math.abs(d) > Math.PI / 2) d = wrap(d + Math.PI)
        if (Math.abs(d) < 0.4) steer = clamp(d * 2.2, -0.6, 0.6)
      }
    }
    vin.up = I.up; vin.down = I.down; vin.steer = steer; vin.hand = I.hand
    car.boost = !!taxi && taxi.boost(I.boost, dt); car.air = car.lift > 0.3
    grip = gripNow()
    stepVan(car, dt, vin, grip)
    // move, then resolve: water stops the van softly, bridge railings and buildings bounce it
    // (a bus turns about its rear axle, `pivot` behind the middle: the middle swings in, the tail out)
    const fx = fwdX(car.yaw), fy = fwdY(car.yaw), lat = car.lat - car.yawRate * car.V.pivot, vx = fx * car.speed + fy * lat, vy = fy * car.speed - fx * lat
    let nx = car.x + vx * dt, ny = car.y + vy * dt
    const blocked = (x, y) => {
      const s = surface(x, y, car.h)
      if (car.deck && !s.deck && car.h - s.y > 2 && !s.end) return 'edge' // off the deck's side
      if (car.deck) { // its railing, a tunnel's wall: the van's side, and its leading corners (turned across the deck its nose is the first through)
        const z = car.h - 0.58, a = Math.sign(car.speed || 1) * (car.V.hl - 0.2), w = car.V.hw
        for (const [ox, oy, m] of [[0, 0, w], [fx * a + fy * w, fy * a - fx * w, 0], [fx * a - fy * w, fy * a + fx * w, 0]]) { const p = railPast(x + ox, y + oy, z); if (p + m > 0 && p > railPast(car.x + ox, car.y + oy, z)) return 'rail' }
      }
      const ax = x + fx * Math.sign(car.speed || 1) * 2, ay = y + fy * Math.sign(car.speed || 1) * 2
      if (!s.deck && isWater(ax, ay) && !roadAt(ax, ay, car.h)) return 'water'
      return null
    }
    const why = (nx !== car.x || ny !== car.y) && blocked(nx, ny)
    if (why) probe?.(why, nx, ny, Math.abs(car.speed))
    if (why === 'edge') { // the railing: back towards the middle of the deck
      const r = nearestRoad(car.x, car.y, 16, true), l = r ? Math.hypot(r.px - car.x, r.py - car.y) : 0
      if (l > 0.01) { const vn = bounce((r.px - car.x) / l, (r.py - car.y) / l, 0, 0, 0.25, 0); if (vn > 1.5) bumped(vn, vn > 3 ? sfx.clank : null) } else car.speed *= 0.5
      nx = car.x; ny = car.y
    } else if (why === 'rail') { // along a railing or a tunnel's wall, scraping: on along the deck, a little in, turned with it
      const r = nearestRoad(car.x, car.y, 16, true, false, false, car.h - 0.58)
      if (r) {
        const tx = Math.cos(r.dir), ty = Math.sin(r.dir), m = (nx - car.x) * tx + (ny - car.y) * ty, l = Math.hypot(r.px - car.x, r.py - car.y) || 1
        const sx = car.x + tx * m + ((r.px - car.x) / l) * 0.05, sy = car.y + ty * m + ((r.py - car.y) / l) * 0.05
        if (blocked(sx, sy)) { nx = car.x; ny = car.y } else { nx = sx; ny = sy }
        const a = yawFromDir(r.dir), d = wrap(a - car.yaw), e = Math.abs(d) < Math.PI / 2 ? d : wrap(d + Math.PI)
        car.yaw += e * Math.min(1, 4 * dt); car.speed *= 1 - Math.min(1, 0.6 * dt)
      } else { nx = car.x; ny = car.y }
    } else if (why) {
      if (!blocked(nx, car.y)) ny = car.y
      else if (!blocked(car.x, ny)) nx = car.x
      else { nx = car.x; ny = car.y }
      if (Math.abs(car.speed) > 3) sfx.splash()
      car.speed *= 0.6; car.lat *= 0.6
    }
    const x0 = car.x, y0 = car.y, mx = nx - x0, my = ny - y0
    car.x = nx; car.y = ny
    tow(); boxes()
    carVsTraffic()
    // street furniture, trunks, bollards, signal poles; then people
    for (let i = 0; i < nsec; i++) {
      const B = secs[i]
      if (car.roof == null) propsNear(B.x, B.y, B.hl + 1, postHit) // (in a tunnel the trees and lamps are on the ground over it)
      for (const o of poles(B.x, B.y, B.hl + 4)) if (Math.abs(o.y - car.h) < 4 && !game?.inLane(o.x, -o.z)) carVsPost(o.x, -o.z, o.r, true)
    }
    carVsPeople(performance.now())
    // (the walls last: a car or a pole that shoves the van does not shove it into one)
    let walled = false
    for (let i = 0; i < nsec && !car.deck; i++) { // buildings: circles along the van (and each section of a bus); not the ones under a bridge it is on,
      const B = secs[i], [offs, cr] = i ? [car.V.rear[2], 1.35] : car.V.circles // nor one over the carriageway (a street through a building's passage, a footprint drawn over the road)
      // (and its four corners, which stand out past the circles: 0.3 to 0.4 m of a cab's or a van's went into a wall
      // it met at an angle, in a lane as wide as it is long)
      const el = B.hl - 0.2, ew = B.hw - 0.2
      for (let k = 0, n = offs.length + (i ? 0 : 4); k < n; k++) {
        const c = k - offs.length, off = c < 0 ? offs[k] : c < 2 ? el : -el, sd = c < 0 ? 0 : c & 1 ? ew : -ew, r = c < 0 ? cr : 0.2
        const x = B.x + B.fx * off + B.fy * sd, y = B.y + B.fy * off - B.fx * sd
        const p = collide(x, y, r, car.lift > 0.3 ? car.h + car.lift + 1.8 : -Infinity) // (a cab in the air off a ramp meets the storeys over a lane, at its roof's height, as a wall)
        if (!p) continue
        const q = nearestRoad(x, y, 4, false, false, true)
        if (q && q.z == null && q.dist < q.w / 2 - 0.3 && insideBuilding(q.px, q.py)) continue // (the building over the road's middle)
        car.x += p.x; car.y += p.y; boxes(); walled = true
        const l = Math.hypot(p.x, p.y) || 1, vn = bounce(p.x / l, p.y / l, 0, 0, 0.15, i ? -car.V.hl : off)
        probe?.('wall', x - (p.x / l) * r, y - (p.y / l) * r, vn)
        if (vn > 2.5) bumped(vn)
      }
    }
    // between a wall and a car it was moving towards, in a gap narrower than the van (a parked car in a lane): it
    // stops where it was, not inside the car (backing away from it is always open)
    pinch: if (walled) for (let i = 0; i < nsec; i++) for (const o of others(secs[i].x, secs[i].y, 10 + secs[i].hl)) {
      const b = otherBox(o)
      if ((b.x - x0) * mx + (b.y - y0) * my <= 0 || !(boxBox(secs[i], b)?.depth > 0.3)) continue
      car.x = x0; car.y = y0; car.speed *= -0.2; car.lat = 0; boxes()
      break pinch
    }
    kerbs()
    // stand on the surface, on all four wheels: the height, pitch and roll of the plane through the road under them
    // (so a long bus over a crest, a van across a camber or half on the next deck has its wheels on the road; what is
    // left is the road's twist). The deck and the tunnel are the ones under the middle
    const s = surface(car.x, car.y, car.h), h0 = car.h
    car.deck = s.deck; car.roof = s.roof
    const near = (v) => (Math.abs(v - car.h) < 1.5 ? v : car.h) // a wheel over a deck edge or a kerb drop doesn't tip the van
    const wb = car.V.wb, ax = wb / 2, tw = car.V.hw * 0.9
    const rx = Math.cos(car.yaw), ry = Math.sin(car.yaw) // right in (x, north)
    const at = (a, t) => near(surface(car.x + fx * a + rx * t, car.y + fy * a + ry * t, car.h).y)
    const fl = at(ax, -tw), fr = at(ax, tw), bl = at(-ax, -tw), br = at(-ax, tw)
    car.h += ((Math.abs(s.y - car.h) < 1.5 ? (fl + fr + bl + br) / 4 : s.y) - car.h) * (1 - Math.exp(-18 * dt)) // (off a deck, down a drop: to the surface under the middle)
    car.pitch += (Math.atan2((fl + fr - bl - br) / 2, wb) - car.pitch) * (1 - Math.exp(-10 * dt))
    car.roll += (Math.atan2((fr + br - fl - bl) / 2, tw * 2) - car.roll) * (1 - Math.exp(-10 * dt))
    car.spin += (car.speed * dt) / car.V.wheel
    if (car.V.airYaw) fly(dt, h0)
  }
  // an arcade cab can leave the road: where the road falls away faster than gravity (over a crest, off a deck's end)
  // it flies on, car.lift metres over the road and car.vy up, and lands with a jolt (taxi.js scores the air)
  function fly(dt, h0) {
    const sp = Math.abs(car.speed), climb = clamp((car.h - h0) / dt, -sp * 0.35 - 1, sp * 0.35 + 1) // the road's own climb, m/s
    const was = car.lift
    car.vy -= 9.8 * dt
    const Y = h0 + was + car.vy * dt // where the body would be, flying
    if (Y <= car.h || car.roof != null) { // on the road (in a tunnel always)
      if (was > 0 && car.airT > 0.12) { // landing
        const hit = clamp((climb - car.vy) / 9, 0, 1)
        jolt(car, clamp(hit, 0.15, 0.9), 1, 0); sfx.kerb(clamp(hit + 0.3, 0.3, 1)); buzz(Math.round(20 + 40 * hit)); shake = Math.max(shake, 0.1 + 0.3 * hit)
        taxi?.landed(car.airT, car.airMax, car.airDeck)
      }
      car.lift = 0; car.vy = climb; car.airT = 0; car.airMax = 0
      return
    }
    if (!was) { car.airDeck = car.deck; if (car.vy > 0) car.vy *= 1.15 } // take-off: an arcade kick
    car.lift = Y - car.h; car.airT += dt; car.airMax = Math.max(car.airMax, car.lift)
    car.pitch += (-Math.atan2(car.vy, Math.max(6, sp)) * 0.7 - car.pitch) * (1 - Math.exp(-3 * dt)) // the nose follows the arc
  }
  // kerbs: leaving the carriageway of a street with sidewalks (or coming back onto it) the wheels hop the kerb
  function kerbs() {
    if (car.deck) { car.kerb = true; return }
    const r = nearestRoad(car.x, car.y, 8), edge = r ? r.dist - r.w / 2 : 99, was = car.kerb
    if (was && edge > 0.5) car.kerb = false // off the carriageway
    else if (!was && edge < -0.4) car.kerb = true // back on it
    else return
    if (!r?.s.p.band || r.s.p.kind > 5) return
    const sp = Math.abs(car.speed)
    if (sp < 1) return
    const side = (r.px - car.x) * Math.cos(car.yaw) + (r.py - car.y) * Math.sin(car.yaw) > 0 ? -1 : 1 // the wheels away from the street go first
    const k = clamp(sp / 9, 0.25, 1) * (was ? 1 : 0.6)
    jolt(car, k, Math.sign(car.speed), side)
    sfx.kerb(k); buzz(Math.round(10 + 25 * k)); shake = Math.max(shake, 0.07 * k)
    car.speed *= sp > 8 ? 0.93 : 0.97
    if (sp > 4) job?.kerb()
    if (game && sp > 4) game.bump(1)
  }
  function engineNote() {
    if (!engine || muted) return
    const t = ac.currentTime
    if (onFoot) { engine.g.gain.setTargetAtTime(hasVan && !hike ? 0.006 : 0, t, 0.3); return } // idling at the kerb
    // a four-cylinder: two pulses a turn, the filter opening with the throttle
    if (game?.trolley) { // a trolleybus: the motor's whine, rising with the speed (silent when dewired)
      const f = 70 + Math.abs(car.speed) * 34
      engine.o1.frequency.setTargetAtTime(f, t, 0.05); engine.o2.frequency.setTargetAtTime(f * 3.01, t, 0.05)
      engine.lp.frequency.setTargetAtTime(500 + Math.abs(car.speed) * 60, t, 0.08)
      engine.g.gain.setTargetAtTime(car.nopower ? 0.002 : 0.006 + car.thr * 0.012, t, 0.1)
      return
    }
    const f = (car.rpm / 60) * car.V.pulses, idle = car.V.idle
    engine.o1.frequency.setTargetAtTime(f, t, 0.05); engine.o2.frequency.setTargetAtTime(f * 2.01, t, 0.05)
    engine.lp.frequency.setTargetAtTime(170 + car.rpm * 0.06 + car.thr * 260, t, 0.08)
    engine.g.gain.setTargetAtTime(0.022 + car.thr * 0.034 + (car.rpm - idle) / 5000 * 0.02, t, 0.1)
  }

  // ---------------------------------------------------------------- walking
  // the surface under a walker: the ground, or a bridge deck (its sidewalks too) when already up on it
  function footSurface(x, y, curY) {
    const g = city.world.heightAt(x, -y) + 0.15
    const r = nearestRoad(x, y, 16, true, true, false, curY - 0.5)
    if (!r) return { y: g, deck: false }
    const dz = r.z + 0.5, reach = r.s.p.band ? 5 : 1
    if (r.d < reach && Math.abs(dz - curY) < 2.2) return r.s.p.tunnel ? { y: dz, deck: true, roof: r.z + r.s.p.tunnel } : { y: Math.max(g, dz), deck: dz - g > 1.2 }
    return { y: g, deck: false }
  }
  // a hike's pace: slower the steeper (and steep downhill too), slower off the trail, a push on tires you
  function hikeSpeed(dt, I, onTrail) {
    const dir = I.down ? -1 : 1, fx = fwdX(man.yaw) * dir, fy = fwdY(man.yaw) * dir
    const g = (city.world.heightAt(man.x + fx * 1.5, -(man.y + fy * 1.5)) - city.world.heightAt(man.x - fx * 0.5, -(man.y - fy * 0.5))) / 2
    const f = (g > 0 ? 1 / (1 + 1.2 * g) : 1 / (1 + 0.9 * Math.max(0, -g - 0.15))) * (onTrail ? 1 : 0.6)
    const pushing = man.run && I.up && !man.winded
    if (pushing) man.stamina -= dt * (0.05 + 0.12 * Math.max(0, g))
    else man.stamina += dt * (Math.abs(man.speed) < 0.5 ? 0.14 : 0.06)
    man.stamina = clamp(man.stamina, 0, 1)
    if (man.stamina <= 0) man.winded = true; else if (man.stamina > 0.4) man.winded = false
    return I.up ? (pushing ? HUSTLE : HIKE) * f : I.down ? -WALK * 0.6 * f : 0
  }
  function walk(dt, I) {
    if (man.board) { // walking round to the van's door, then in
      const b = man.board, e = clamp((performance.now() - b.t0) / b.ms, 0, 1)
      man.x = b.x + (b.tx - b.x) * e; man.y = b.y + (b.ty - b.y) * e; man.speed = e < 1 ? 3.2 : 0
      man.yaw += wrap(b.yaw - man.yaw) * Math.min(1, dt * 12)
      man.phase += dt * 9
      if (e >= 1) { man.board = null; onFoot = false; car.parked = false; walker.visible = wblob.visible = carried.visible = false; sfx.door(); showHelp(); assistHint(); publishPlayer(true) }
      return
    }
    if (errand) return walkErrand(dt)
    if (hike?.photo) { man.speed = 0; return } // posing for the view
    if (foot.busy(I, dt) || city.fishing?.busy) { man.speed = 0; return } // framing a photo, sat down, a rod in hand (plugins/fish)
    man.run = I.run && !(hike && man.winded)
    const tr = hike ? nearestRoad(man.x, man.y, 4, false, true) : null, onTrail = !!tr && tr.d < 0.8
    // the keys are the camera's: up walks away from it, left and right across its view, down towards it; the walker
    // turns to face the way it goes (first, when that is behind it) and the camera comes round after it (chasePose)
    const mv = I.up ? 1 : I.down ? -1 : 0, going = mv || I.steer ? 1 : 0, yaw0 = man.yaw
    if (going) man.yaw += wrap(chase.yaw + Math.atan2(I.steer, mv) - man.yaw) * (1 - Math.exp(-12 * dt))
    const faced = going ? clamp(Math.cos(wrap(chase.yaw + Math.atan2(I.steer, mv) - man.yaw)) * 1.5, 0, 1) : 0
    const target = (hike ? hikeSpeed(dt, { up: !!going, down: false }, onTrail) : going ? (I.run ? RUN : WALK) : 0) * faced
    man.speed += (target - man.speed) * (1 - Math.exp(-(target ? 9 : 13) * dt))
    if (Math.abs(man.speed) < 0.02 && !target) man.speed = 0
    const turned = wrap(man.yaw - yaw0), h0 = man.h, k5 = 1 - Math.exp(-5 * dt)
    if (Math.abs(man.speed) < 0.8) man.phase += Math.abs(turned) * 1.6 // turning on the spot: small steps
    man.bank += (clamp(-(turned / dt) * Math.abs(man.speed) * 0.02, -0.14, 0.14) - man.bank) * k5
    if (man.air) { man.air += dt / 0.42; if (man.air >= 1) man.air = 0 } // a hop (foot.js: Space)
    // the trail leads: walking on with nothing steered, turn towards the trail a few metres ahead (round switchbacks)
    if (hike && onTrail && !I.steer && man.speed > 0.3) {
      const a = nearestRoad(man.x + fwdX(man.yaw) * 2.6, man.y + fwdY(man.yaw) * 2.6, 4, false, true)
      if (a && a.dist > 0.3) {
        const d = wrap(yawFromDir(Math.atan2(a.py - man.y, a.px - man.x)) - man.yaw)
        if (Math.abs(d) < 1.4 && orbit.idle > 1.2) { man.yaw += d * Math.min(1, 3 * dt); chase.yaw += d * Math.min(1, 3 * dt) }
      }
    }
    const fx = fwdX(man.yaw), fy = fwdY(man.yaw)
    let nx = man.x + fx * man.speed * dt, ny = man.y + fy * man.speed * dt
    // water: only where a deck or a path goes over it
    const wet = (x, y) => isWater(x, y) && !footSurface(x, y, man.h).deck && !(nearestRoad(x, y, 6, false, true)?.d < 0.6)
    if ((nx !== man.x || ny !== man.y) && wet(nx + fx * 0.4, ny + fy * 0.4)) {
      if (!wet(nx + fx * 0.4, man.y)) ny = man.y; else if (!wet(man.x, ny + fy * 0.4)) nx = man.x; else { nx = man.x; ny = man.y }
    }
    if (man.deck && (nx !== man.x || ny !== man.y)) { // a deck's railing, a tunnel's walls
      const now = railPast(man.x, man.y, man.h - 0.5)
      const out = (x, y) => { const p = footSurface(x, y, man.h).deck ? railPast(x, y, man.h - 0.5) : -1; return p + 0.3 > 0 && p > now }
      if (out(nx, ny)) { if (!out(nx, man.y)) ny = man.y; else if (!out(man.x, ny)) nx = man.x; else { nx = man.x; ny = man.y } }
    }
    man.x = nx; man.y = ny
    // buildings, the parked van, posts and trunks (not the ones a trail runs through), signal poles, people, cars
    const p = !man.deck && collide(man.x, man.y, 0.32) // (not the buildings under a bridge)
    if (p) { man.x += p.x; man.y += p.y }
    if (hasVan) { const q = circleBox(man.x, man.y, 0.32, car.x, car.y, fwdX(car.yaw), fwdY(car.yaw), car.V.hl, car.V.hw); if (q) { man.x += q.x; man.y += q.y } }
    if (man.roof == null) propsNear(man.x, man.y, 1, (x, y, r, kind) => { if (!(kind === 0 && onTrail)) push(x, y, r) })
    for (const o of poles(man.x, man.y, 3)) if (Math.abs(o.y - man.h) < 4) push(o.x, -o.z, o.r)
    const now = performance.now()
    for (const o of people(man.x, man.y, 2.5)) {
      if (Math.abs(o.y - man.h) > 2.5) continue
      const px = o.x, py = -o.z
      if (push(px, py, 0.28) && Math.abs(man.speed) > 3.2 && !(scratch.seen.get(o.id) > now - 5000)) { // running into someone: a stumble
        scratch.seen.set(o.id, now)
        traffic()?.knock?.(o.id, px - man.x, -(py - man.y), 1.2)
        sfx.oops(); popup('Oops, sorry!', 'Easy on the sidewalk.')
      }
    }
    for (const o of others(man.x, man.y, 8)) {
      const b = otherBox(o), q = circleBox(man.x, man.y, 0.32, b.x, b.y, b.fx, b.fy, b.hl, b.hw)
      if (!q) continue
      man.x += q.x; man.y += q.y
      const l = Math.hypot(q.x, q.y) || 1, closing = ((o.speed || 0) * (b.fx * q.x + b.fy * q.y) - man.speed * (fx * q.x + fy * q.y)) / l
      bumped(closing, () => hitTraffic(o, closing))
    }
    const s = footSurface(man.x, man.y, man.h)
    man.deck = s.deck; man.roof = s.roof
    man.h = clamp(man.h + (s.y - man.h) * (1 - Math.exp(-14 * dt)), s.y - 0.25, s.y + 0.25) // (a bank, a wall in the terrain: up or down it at once, not through it)
    man.phase += dt * Math.abs(man.speed) * (man.run ? 2.3 : 3.6)
    // leaning: forward setting off and uphill, back stopping and downhill
    const slope = Math.abs(man.speed) > 0.3 ? clamp((man.h - h0) / (Math.abs(man.speed) * dt), -0.5, 0.5) : 0
    man.lean += (clamp((target - man.speed) / RUN, -1, 1) * 0.3 + slope * 0.35 - man.lean) * k5
  }
  // the walker (radius 0.32) out of a circle at (x, y) of radius r: true if it touched
  function push(x, y, r) {
    const dx = man.x - x, dy = man.y - y, d = Math.hypot(dx, dy), m = r + 0.32
    if (!(d < m)) return false // (a NaN neighbour never pushes: it blacked the view out)
    const k = (m - d) / (d || 1)
    man.x += (d ? dx : 1) * k; man.y += dy * k
    return true
  }
  // E: in and out of the van
  function nearVan() { return hasVan && onFoot && !man.board && !errand && Math.hypot(man.x - car.x, man.y - car.y) < 7 }
  function canGetOut() { return !onFoot && !game && !taxi && Math.abs(car.speed) < 1.5 }
  // where the courier steps out: the driver's door; if that is a wall or water, the other side, else behind
  function doorSpot() {
    const rx = Math.cos(car.yaw), ry = Math.sin(car.yaw), fx = fwdX(car.yaw), fy = fwdY(car.yaw)
    for (const [sr, sf] of [[-1.7, 0.6], [1.7, 0.6], [0, -3.2], [0, 3.2]]) {
      const x = car.x + rx * sr + fx * sf, y = car.y + ry * sr + fy * sf
      if (!insideBuilding(x, y) && !collide(x, y, 0.3) && !isWater(x, y)) return { x, y, yaw: car.yaw }
    }
    return null
  }
  function toggleFoot() {
    if (state !== 'play' || errand) return
    if (nearVan()) { // walk to the driver's door (left, front) and climb in
      const rx = Math.cos(car.yaw), ry = Math.sin(car.yaw)
      const tx = car.x - rx * 1.25 + fwdX(car.yaw) * 0.9, ty = car.y - ry * 1.25 + fwdY(car.yaw) * 0.9
      man.board = { t0: performance.now(), x: man.x, y: man.y, tx, ty, yaw: car.yaw, ms: clamp(Math.hypot(tx - man.x, ty - man.y) / 3.2, 0.3, 2) * 1000 }
      return
    }
    if (!canGetOut()) { if (!onFoot) city.ui.toast('Stop the van to get out', 1500); return }
    const spot = doorSpot()
    if (!spot) { city.ui.toast('No room to get out here'); return }
    hop(spot)
    sfx.door()
    showHelp()
  }
  function hop(spot) { // out of the van, parked
    car.speed = 0; car.lat = 0; car.parked = true; onFoot = true
    Object.assign(man, { x: spot.x, y: spot.y, yaw: spot.yaw, speed: 0, h: footSurface(spot.x, spot.y, car.h - 0.1).y, board: null })
    walker.visible = wblob.visible = true
    publishPlayer(true)
  }

  // ---------------------------------------------------------------- errands: the courier on foot between the van and a door
  // legs: [{ x, y, pause (s), then() }]; the courier jogs each, waits, does `then`; after the last one gets back in
  function startErrand(legs) {
    const spot = doorSpot()
    if (!spot) return false
    hop(spot)
    sfx.door()
    errand = { legs, k: 0, wait: -1 }
    return true
  }
  // a door: the first wall from the van towards (x, y), at most DOOR_MAX away (else just as far as that)
  function doorFor(x, y) {
    const sx = car.x, sy = car.y, d = Math.hypot(x - sx, y - sy) || 1, k = wallHit(sx, sy, x, y)
    const f = Math.min(k < 1 ? Math.max(0, k - 0.6 / d) : 1, DOOR_MAX / d)
    return { x: sx + (x - sx) * f, y: sy + (y - sy) * f }
  }
  const backDoors = () => ({ x: car.x - fwdX(car.yaw) * 2.9, y: car.y - fwdY(car.yaw) * 2.9 })
  function walkErrand(dt) {
    const E = errand, L = E.legs[E.k]
    if (!L) { // done: in at the driver's door
      errand = null
      const rx = Math.cos(car.yaw), ry = Math.sin(car.yaw)
      const tx = car.x - rx * 1.25 + fwdX(car.yaw) * 0.9, ty = car.y - ry * 1.25 + fwdY(car.yaw) * 0.9
      man.board = { t0: performance.now(), x: man.x, y: man.y, tx, ty, yaw: car.yaw, ms: clamp(Math.hypot(tx - man.x, ty - man.y) / 3.2, 0.3, 2) * 1000 }
      return
    }
    const dx = L.x - man.x, dy = L.y - man.y, d = Math.hypot(dx, dy)
    if (E.wait < 0 && d > 0.2) {
      const step = Math.min(d, CARRY * dt)
      man.x += (dx / d) * step; man.y += (dy / d) * step; man.speed = CARRY
      man.yaw += wrap(yawFromDir(Math.atan2(dy, dx)) - man.yaw) * Math.min(1, dt * 10)
      man.phase += dt * CARRY * 2.3
    } else {
      if (E.wait < 0) E.wait = L.pause || 0
      man.speed = 0
      if ((E.wait -= dt) <= 0) { E.wait = -1; E.k++; L.then?.() }
    }
    man.h += (city.world.heightAt(man.x, -man.y) + 0.15 - man.h) * (1 - Math.exp(-14 * dt))
  }
  function hurry() { // skip to the end of an errand
    const E = errand
    if (!E) return
    while (E.k < E.legs.length) E.legs[E.k++].then?.()
    errand = null
    onFoot = false; car.parked = false; walker.visible = wblob.visible = carried.visible = false; man.board = null; sfx.door()
    publishPlayer(true)
  }

  function place() {
    if (hasVan) {
      const V = vehicle, U = V.userData
      V.position.set(car.x, car.h + (car.lift || 0) - 0.02 + car.hz - car.kneel * 0.06, -car.y) // (a bus kneels at the kerb, doors open; a cab flies)
      V.rotation.set(0, 0, 0)
      V.rotateY(car.yaw); V.rotateX(car.pitch + car.bp); V.rotateZ(car.roll + car.br - car.kneel * 0.025)
      // the wheels stay on the road while the body dips under braking, leans in a turn, bounces or kneels (the whole
      // model turns with the body: a wheel 1.6 m from the middle went 20 cm into the road, the other as far off it)
      const bz = car.bp, bx = car.br - car.kneel * 0.025, by = car.kneel * 0.06 - car.hz
      for (const w of U.wheels) {
        w.spin.rotation.x = -car.spin; if (w.front) w.steer.rotation.y = car.steer
        const s = w.steer, o = s.parent === V ? 0 : s.parent.position.z // (a bendy bus's rear wheels: in its rear section)
        s.userData.y0 ??= s.position.y
        s.position.y = s.userData.y0 + clamp(-s.position.x * bx + (s.position.z + o) * bz + by, -0.3, 0.3)
      }
      U.signal?.(car, performance.now() / 1000)
      if (U.rear) U.rear.rotation.y = wrap(car.tyaw - car.yaw)
      blob.position.set(car.x, car.h + 0.06, -car.y); blob.rotation.set(0, car.yaw, 0)
      if (nsec === 2) { blob2.position.set(secs[1].x, car.h + 0.06, -secs[1].y); blob2.rotation.set(0, car.tyaw, 0) }
      pool.position.set(car.x + fwdX(car.yaw) * (car.V.hl - 2.2), car.h + 0.06, -(car.y + fwdY(car.yaw) * (car.V.hl - 2.2))); pool.rotation.copy(blob.rotation)
    }
    if (walker.visible) {
      walker.position.set(man.x, man.h - 0.05, -man.y)
      walker.rotation.set(0, man.yaw, 0)
      poseWalker(walker, man.phase, clamp(Math.abs(man.speed) / WALK, 0, 1), (man.run || !!errand) && Math.abs(man.speed) > WALK + 0.3, carried.visible, man)
      foot.pose(walker)
      wblob.position.set(man.x, man.h + 0.03, -man.y)
    }
  }
  function resetToRoad() {
    if (game) { // back onto the route's lane, where the bus has got to
      const p = game.resetSpot()
      Object.assign(car, { x: p.x, y: p.y, yaw: p.yaw, h: p.h, speed: 0, lat: 0, steer: 0, kick: 0, gear: 1, deck: false })
      return resetTrailer()
    }
    const r = nearestRoad(car.x, car.y, 300)
    if (!r) return
    let yaw = yawFromDir(r.dir)
    if (Math.abs(wrap(yaw - car.yaw)) > Math.PI / 2) yaw = wrap(yaw + Math.PI)
    Object.assign(car, { x: r.px, y: r.py, yaw, speed: 0, lat: 0, steer: 0, kick: 0, gear: 1, lift: 0, vy: 0, airT: 0 })
    car.h = r.z != null ? r.z + 0.58 : city.world.heightAt(r.px, -r.py) + 0.2
    car.deck = r.z != null; car.roof = r.s.p.tunnel ? r.z + r.s.p.tunnel : undefined
    resetTrailer()
  }

  // ---------------------------------------------------------------- jobs, made up from what is around
  // where a van stops for a point: the kerb lane of the nearest drivable road
  function stopFor(x, y) {
    const r = nearestRoad(x, y, 70)
    if (!r || r.dist > 70 || r.z != null) return null
    const dx = x - r.px, dy = y - r.py, l = Math.hypot(dx, dy) || 1, off = Math.min(l, Math.max(0, r.w / 2 - 1.4))
    return { x: r.px + (dx / l) * off, y: r.py + (dy / l) * off, w: r.w }
  }
  // an address near (x, y): a building r0..r1 metres away, the named street in front of it, a house number
  function address(x, y, r0, r1) {
    const found = []
    for (const b of tilesNear(x, y, r1)) {
      if (!b.fp) continue
      for (let r = 0; r < b.fp.start.length - 1; r++) {
        if (b.lo && b.lo[r] > -Infinity) continue // (a raised part is no address)
        const w = b.bb[r * 4 + 2] - b.bb[r * 4], h = b.bb[r * 4 + 3] - b.bb[r * 4 + 1], cx = b.bb[r * 4] + w / 2, cy = b.bb[r * 4 + 1] + h / 2
        if (w * h < 45 || w * h > 4000) continue
        const d = Math.hypot(cx - x, cy - y)
        if (d >= r0 && d <= r1) found.push({ x: cx, y: cy, area: w * h })
      }
    }
    for (let k = 0; k < 16 && found.length; k++) {
      const f = found.splice(Math.floor(Math.random() * found.length), 1)[0], s = stopFor(f.x, f.y)
      if (!s) continue
      const st = nearestStreet(s.x, s.y, 22)
      if (!st) continue
      const n = houseNumber(st, f.x, f.y)
      const unit = f.area > 700 ? `${1 + Math.floor(Math.random() * Math.min(12, f.area / 300))}${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}-` : ''
      return { ...s, house: f, label: `${unit}${n} ${abbr(st.name)}` }
    }
    return null
  }
  const goal = { x: 0, y: 0, gy: 0, icon: null }
  function setGoal(x, y, col, icon) {
    beamMat.uniforms.col.value.set(col); ringMat.color.set(col); ring2Mat.color.set(col)
    for (const ic of Object.values(icons)) ic.visible = ic === icon
    beam.visible = ring.visible = ring2.visible = true
    Object.assign(goal, { x, y, icon, gy: NaN })
    groundGoal()
  }
  function groundGoal() { // its tile may load after it is set
    const h = city.world.heightAt(goal.x, -goal.y) + 0.2
    if (h === goal.gy) return
    goal.gy = h
    for (const o of [beam, ring, ring2]) o.position.set(goal.x, h + 0.08, -goal.y)
  }
  function hideMarkers() { beam.visible = ring.visible = ring2.visible = false; for (const ic of Object.values(icons)) ic.visible = false }
  const cap = (s) => s[0].toUpperCase() + s.slice(1)
  // the van has stopped at the target (or the courier walked up to it)
  function arrive() {
    job.take() // an order off the board, if none is ours yet
    const t = job.target(), run = job.run
    if (onFoot) { // walked there: hand it over (or pick up) right away
      if (run.stage === 'pickup') { carried.visible = true; job.pickedUp() } else { carried.visible = false; job.delivered(run.cur) }
      return
    }
    if (run.stage === 'pickup') {
      const d = doorFor(run.shop.sx, run.shop.sy), b = backDoors()
      if (!startErrand([{ x: d.x, y: d.y, pause: 1.1, then: () => { carried.visible = true; sfx.knock() } }, { x: b.x, y: b.y, pause: 0.5, then: () => { carried.visible = false; job.pickedUp() } }])) job.pickedUp()
    } else {
      const p = run.cur, d = doorFor(p.to.house?.x ?? t.x, p.to.house?.y ?? t.y), b = backDoors()
      if (!startErrand([{ x: b.x, y: b.y, pause: 0.6, then: () => { carried.visible = true } }, { x: d.x, y: d.y, pause: 1.2, then: () => { carried.visible = false; sfx.knock(); job.delivered(p) } }])) job.delivered(p)
    }
  }

  // ---------------------------------------------------------------- hiking: the summit, the photo
  function summit(now) {
    hike.done = true
    const secs = hike.t0 ? (now - hike.t0) / 1000 : 0, log = hikeLog(), prev = log[hike.id]
    const best = !prev || secs < prev.best
    log[hike.id] = { best: best ? secs : prev.best, n: (prev?.n || 0) + 1 }
    try { localStorage.setItem('drive.hikes', JSON.stringify(log)) } catch {}
    sfx.summit(); buzz([40, 60, 40])
    hideMarkers()
    man.speed = 0
    // where the camera ends up: behind the hiker and to one side, clear of buildings (the chalet by the Grind's finish)
    const b = (hike.view * Math.PI) / 180, dx = Math.sin(b), dy = Math.cos(b)
    let spot = [4, 1, 20]
    for (const [back, side] of [[18, 6], [18, -6], [11, 4], [11, -4], [6, 2], [6, -2]]) {
      const cx = man.x - dx * back + dy * side, cy = man.y - dy * back - dx * side
      if (wallHit(man.x, man.y, cx, cy) === 1 && !collide(cx, cy, 3)) { spot = [back, side, 10]; break }
    }
    hike.photo = { t0: now, shot: false, secs, best: best && prev, medal: foot.summit(hike, secs), from: chase.pos.clone(), look: chase.look.clone(), h: man.h, spot }
    keys.clear()
  }
  // the camera pulls back and up beside the hiker, over the view (they stand at the left of it), then a photo
  const vp = new THREE.Vector3(), vl = new THREE.Vector3()
  function photoCam(now) {
    const F = hike.photo, t = (now - F.t0) / 1000, e = smooth(0.2, 5, t), b = (hike.view * Math.PI) / 180, dx = Math.sin(b), dy = Math.cos(b)
    man.yaw += wrap(yawFromDir(Math.atan2(dy, dx)) - man.yaw) * 0.06 // turn to the view
    const tall = innerWidth < innerHeight ? 0.3 : 1 // a phone upright: the hiker nearer the middle, the view lower in it
    const [B, S, U] = F.spot, back = 3 + (B - 3) * e, side = S * e * tall, sw = Math.sign(S) * 60 * e * tall // side: right of the view, (dy, -dx)
    vp.set(man.x - dx * back + dy * side, F.h + 2 + U * e, -(man.y - dy * back - dx * side))
    vl.set(man.x + dx * (25 + 600 * e) + dy * sw, F.h + 1 - (tall < 1 ? 130 : 75) * e, -(man.y + dy * (25 + 600 * e) - dx * sw))
    const k = smooth(0, 1.2, t)
    pcam.position.copy(F.from).lerp(vp, k); pcam.lookAt(v3.copy(F.look).lerp(vl, k))
    vista = e
    opts.focus.set(man.x + dx * 4000 * e, F.h, -(man.y + dy * 4000 * e)); opts.radius = 900 + 6500 * e
    if (t > 5.2 && !F.shot) { F.shot = true; snap() }
  }
  function snap() {
    const F = hike.photo
    sfx.shutter()
    ui.flash.hidden = false; ui.flash.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => ui.flash.classList.remove('on')))
    setTimeout(() => { ui.flash.hidden = true }, 1000)
    document.body.classList.add('dlv-shot')
    ui.photo.innerHTML = `<div class="t">${esc(hike.name)}</div><div class="s">${esc(cap(hike.goal))} · ${Math.round(F.h)} m${hike.climb > 20 ? ` · climbed ${Math.round(hike.climb)} m` : ''}${F.secs ? ` · ${mmss(F.secs)}${F.best ? ' · a new best!' : ''}${F.medal ? ` · ${F.medal}` : ''}` : ''}</div>
      <div class="row"><button data-k>Keep exploring</button><button data-x>Back to map</button></div>`
    ui.photo.hidden = false; requestAnimationFrame(() => ui.photo.classList.add('on'))
    ui.photo.querySelector('[data-k]').onclick = () => { ui.photo.classList.remove('on'); ui.photo.hidden = true; document.body.classList.remove('dlv-shot'); hike.photo = null; vista = 0; atmosphere(1) }
    ui.photo.querySelector('[data-x]').onclick = () => { ui.photo.classList.remove('on'); ui.photo.hidden = true; document.body.classList.remove('dlv-shot'); exit() }
  }

  // ---------------------------------------------------------------- per frame
  function frame(dt, time) {
    const now = performance.now()
    if (state === 'in' || state === 'out') {
      const e = clamp((now - t0) / (state === 'in' ? 2600 : 2200), 0, 1)
      if (state === 'in') { // the ground arrives as the tiles do: keep the end of the dive on it
        if (onFoot) man.h = city.world.heightAt(man.x, -man.y) + 0.15
        if (hasVan) car.h = surface(car.x, car.y, city.world.heightAt(car.x, -car.y) + 0.2).y
        chasePose(0, true)
      }
      pose(e)
      place()
      if (e >= 1) {
        if (state === 'out') return finish()
        state = 'play'
        ui.btns.hidden = false
        if (deliver) ui.co.hidden = false; else if (!hike && !game && !taxi) ui.read.hidden = false
        ui.touch.hidden = false
        showHelp()
        if (!onFoot) showHowTo() // (the lane-assist hint follows the card)
        const g = gripNow()
        if (!onFoot && g < 0.8) city.ui.toast(g < 0.6 ? 'Snow on the roads: gentle on the pedals, the van slides and takes a long way to stop.' : 'Wet roads: leave a little more room to stop.', 5000)
        hudAt = 0
      }
      return
    }
    if (state !== 'play' || !(dt > 0)) return
    dt = Math.min(dt, 0.05)
    if (!ui.how.hidden && (keys.size || touchState.gas || touchState.brake)) hideHowTo()
    const I = ui.sheet.hidden && !taxi?.frozen ? autopilot?.() || input() : STILL
    if (onFoot) { walk(dt, I); if (hasVan) drive(dt, { steer: 0, up: false, down: false, hand: true }); feel?.quiet() } else { drive(dt, I); feel.update(dt, time, car, pcam, !taxi); if (!taxi && !game && !deliver) driftScore(dt, now) }
    engineNote()
    publish()
    place()
    chasePose(dt)
    const fov = chaseFov(), near = chase.near ?? nearPlane(), far = fogFar + 60
    if (pcam.fov !== fov || pcam.near !== near || pcam.far !== far) { pcam.fov = fov; pcam.near = near; pcam.far = far; pcam.updateProjectionMatrix() }
    pcam.position.copy(chase.pos)
    if (shake > 0.001) { pcam.position.x += (Math.random() - 0.5) * shake; pcam.position.y += (Math.random() - 0.5) * shake; shake *= Math.exp(-10 * dt) }
    pcam.up.set(0, 1, 0); pcam.lookAt(chase.look)
    foot.frame(dt, now, pcam, hike, onFoot && !errand && !man.board)
    const P = body(), ahead = onFoot ? 60 : 180
    opts.focus.set(P.x + fwdX(P.yaw) * ahead, P.h, -(P.y + fwdY(P.yaw) * ahead))
    opts.radius = 900; opts.shadowRadius = 300
    // the street furniture near the player, redrawn every dozen metres
    if (!kerbsAt || kerbsAt.more || Math.hypot(P.x - kerbsAt.x, P.y - kerbsAt.y) > 15) { // the kerbs within 160 m, every 15 m (built a little a frame)
      kerbsAt = { x: P.x, y: P.y }
      kerbsAt.more = lips.update(infos.values(), P.x, P.y, 160, heightAt)
    }
    if (!propsAt || Math.hypot(P.x - propsAt.x, P.y - propsAt.y) > 12) {
      propsAt = { x: P.x, y: P.y }
      const L = scratch.props
      let n = 0
      propsNear(P.x, P.y, 150, (x, y, r, kind, ang, g) => { if (kind && kind !== BENCH && n < 700) { L[n * 5] = x; L[n * 5 + 1] = y; L[n * 5 + 2] = Number.isNaN(g) ? city.world.heightAt(x, -y) : g; L[n * 5 + 3] = kind; L[n * 5 + 4] = ang; n++ } })
      props.update(L, n, city.light.night)
    }
    // the job
    let t = null
    if (game) { game.settle(busSpawn); game.frame(dt, now, time); t = game.goal() }
    if (taxi) { taxi.frame(dt, now, time); t = taxi.goal() }
    if (deliver) {
      t = job.frame(dt, now)
      if (t && !job.S.over && !errand && !man.board && Math.hypot(t.x - P.x, t.y - P.y) < (onFoot ? ARRIVE_FOOT : ARRIVE + t.w / 2) && (onFoot || Math.abs(car.speed) < 1.2)) { arrive(); t = job.target() }
    }
    if (hike) {
      t = goal
      const H = hike
      if (!H.snapped && now - t0 < 15000 && Math.hypot(man.x - H.sx0, man.y - H.sy0) < 3) { // onto the trail once its tile is in
        const r = nearestPiece(man.x, man.y, (p) => trail(p) && !p.z, () => 0, 60)
        if (r) { man.x = r.x; man.y = r.y; H.snapped = true }
      }
      if (!H.t0 && man.speed > 0.3) H.t0 = now
      if (H.lastH != null && man.h > H.lastH) H.climb += man.h - H.lastH
      H.lastH = man.h
      if (!H.done && Math.hypot(goal.x - man.x, goal.y - man.y) < 12) summit(now)
      if (H.photo) { photoCam(now); atmosphere(1); pcam.far = fogFar + 60; pcam.updateProjectionMatrix() }
    }
    if (t && goal.icon?.visible) { // markers: a soft pulse, the parcel / house / flag turning and bobbing
      beamMat.uniforms.t.value = time
      const pulse = (time * 0.8) % 1
      ring2.scale.setScalar(1 + pulse * 0.9); ring2Mat.opacity = 0.8 * (1 - pulse)
      ring.scale.setScalar(1 + Math.sin(time * 3) * 0.04)
      if (game) beam.visible = Math.hypot(t.x - P.x, t.y - P.y) > 70 // a bus stop's beam: from afar
      goal.icon.position.set(goal.x, goal.gy + 4.2 + Math.sin(time * 2) * 0.35, -goal.y); goal.icon.rotation.y = time * 1.2
      if (game) { goal.icon.scale.setScalar(game.doors ? 0.001 : 1); ring.visible = ring2.visible = !game.doors } // out of the way while the doors are open there
    }
    if (now - readAt > 400) {
      readAt = now; street = nearestStreet(P.x, P.y, 30); cellsNear(P.x, P.y, 800)
      if (goal.icon?.visible) groundGoal()
      if (hike && !hike.goalOn && Math.hypot(hike.gx - P.x, hike.gy - P.y) < 800) { // the goal onto its trail, once that's loaded
        const r = nearestPiece(hike.gx, hike.gy, (p) => trail(p) && !p.z, () => 0, 40)
        if (r) { hike.goalOn = true; if (!hike.done) setGoal(r.x, r.y, 0x7fe0b0, icons.summit) }
      }
    }
    if (now - hudAt > 100) { hudAt = now; hud(t) }
    if (now - skyAt > 1000) { skyAt = now; atmosphere(1) }
  }
  // free roam: a drift is measured while the tyres slide and paid when they grip again (a knock on the way voids it)
  function driftScore(dt, now) {
    const D = drift, sp = Math.hypot(car.speed, car.lat)
    if (feel.slide > 0.3 && sp > 5 && Math.abs(car.lat) > 1) { D.m += sp * dt; D.t = now; if (now - car.bumpT < 400) D.m = 0 }
    else if (D.m && now - D.t > 350) {
      if (D.m > 8) {
        const pay = Math.round(D.m / 6)
        D.text = `Drift ${Math.round(D.m)} m · +$${pay}`; D.show = now + 2200
        city.progress?.award('stunt', pay, { quiet: true }); city.progress?.stat('drive.drift', Math.round(D.m))
        sfx.pickup()
      }
      D.m = 0
    }
  }
  function hud(t) {
    if (taxi) { ui.tact.hidden = ui.act.hidden = ui.job.hidden = ui.hrn.hidden = true; ui.hb.hidden = ui.assist.hidden = false; ui.brk.textContent = 'Brake'; return } // the rest is taxi.js's
    if (game) { // E: the doors (or the trolley poles); the bus's own cards are route.js's
      const lab = game.actionLabel()
      ui.tact.hidden = !lab; ui.tact.textContent = lab
      ui.act.hidden = touchy || !lab; ui.act.innerHTML = `<kbd>E</kbd>${lab}`
      ui.brk.textContent = 'Brake'; ui.assist.hidden = ui.hrn.hidden = ui.hb.hidden = false; ui.job.hidden = true
      document.documentElement.classList.add('dlv-assist')
      return
    }
    // E to get in or out (or to hurry an errand along)
    const can = errand ? 'Hurry' : nearVan() ? 'Get in' : canGetOut() ? 'Get out' : ''
    ui.tact.hidden = !can; ui.tact.textContent = can
    ui.act.hidden = touchy || !(nearVan() || errand || (job && t && !onFoot && Math.abs(car.speed) >= 1.2 && Math.hypot(t.x - car.x, t.y - car.y) < ARRIVE + 8))
    ui.act.innerHTML = errand ? '<kbd>E</kbd>Hurry up' : nearVan() ? '<kbd>E</kbd>Get in the van' : 'Stop here'
    ui.brk.textContent = onFoot ? (hike ? 'Push' : 'Run') : 'Brake'
    ui.assist.hidden = ui.hrn.hidden = ui.hb.hidden = onFoot // they're the van's only
    document.documentElement.classList.toggle('dlv-assist', !onFoot)
    const P = body(), name = street ? abbr(street.name) : ''
    ui.stam.hidden = !hike; ui.aboard.hidden = !deliver
    if (!deliver && !hike) {
      const sp = Math.abs(P.speed) * 3.6, gear = onFoot ? '' : ` · ${car.gear < 0 ? 'R' : `D${car.gear}`}`
      const dr = onFoot ? '' : drift.m > 4 ? ` <span class="gain">· Drift ${Math.round(drift.m)} m</span>` : performance.now() < drift.show ? ` <span class="gain">· ${drift.text}</span>` : ''
      ui.read.innerHTML = `<b>${Math.round(sp)}</b> km/h${gear}${dr}${name ? ` <span class="st">· ${esc(name)}</span>` : ''}`
      const c = onFoot && !man.board && foot.card() // a free walk: the photo walk's card
      ui.job.hidden = !c
      if (c) { ui.w.textContent = c.title; ui.p.textContent = c.line; ui.s.textContent = c.sub; ui.d.textContent = ui.t.textContent = ''; compass(c.target) }
      return
    }
    ui.job.hidden = false
    if (hike) {
      const H = hike, d = Math.hypot(goal.x - man.x, goal.y - man.y), g = city.world.heightAt(goal.x, -goal.y), top = d < 800 && g ? g : H.ele, up = top - man.h
      ui.w.textContent = `Hike · ${H.name}`
      ui.p.textContent = H.done ? 'You made it!' : `To ${H.goal}`
      ui.s.textContent = H.done ? cap(H.goal) : `${dist(d)} away · ${up > 8 ? `${Math.round(up)} m to climb` : up < -8 ? `${Math.round(-up)} m down` : 'nearly level'}`
      ui.d.textContent = `${Math.round(man.h)} m up`
      ui.t.textContent = H.t0 ? mmss(((H.photo ? H.photo.t0 : performance.now()) - H.t0) / 1000) : 'the clock starts as you walk'
      ui.t.className = ''
      ui.stamBar.style.width = `${Math.round(man.stamina * 100)}%`; ui.stam.classList.toggle('low', man.winded || man.stamina < 0.25)
      compass(H.done ? null : goal)
      return
    }
    job.hud(t, name)
    compass(t)
  }
  const dist = (d) => (d > 950 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`)
  function compass(t) { // the target's bearing and north, relative to where the camera looks
    const P = body(), cy = Math.atan2(chase.look.x - chase.pos.x, -(chase.look.z - chase.pos.z))
    ui.arrow.style.opacity = t ? 1 : 0.3
    if (t) ui.arrow.style.transform = `rotate(${wrap(Math.atan2(t.x - P.x, t.y - P.y) - cy)}rad)`
    ui.north.style.transform = `rotate(${wrap(-cy)}rad)`
  }

  // ---------------------------------------------------------------- keys
  const CONTROL = new Set([...MOVE_KEYS, 'ShiftLeft', 'ShiftRight'])
  function onKey(e) {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || garage) return // (the garage has its own keys)
    if (state === 'off') { if (e.code === 'KeyD' && !e.repeat && !e.shiftKey) startPick('deliver'); return }
    if (e.code === 'Escape') { exit(!ui.sheet.hidden); return }
    if (state !== 'play') return
    if (CONTROL.has(e.code)) { keys.add(e.code); e.preventDefault() }
    if (e.repeat) return
    if (onFoot && !errand && !man.board && foot.key(e.code)) { e.preventDefault(); return }
    if (e.code === 'KeyE') { if (taxi) return; if (game) game.action(); else if (errand) hurry(); else toggleFoot() }
    else if (e.code === 'KeyR' && !onFoot) resetToRoad()
    else if (e.code === 'KeyH' && !onFoot) hornOn()
    else if (e.code === 'KeyM') setMuted(!muted)
    else if (e.code === 'KeyG') ui.assist.onclick()
  }
  const onKeyUp = (e) => { keys.delete(e.code); if (e.code === 'KeyH') hornOff() }
  const onBlur = () => { keys.clear(); hornOff(); for (const k in touchState) touchState[k] = false }
  const onResize = () => { fitCamera(); if (state !== 'off') city.requestRender() }
  addEventListener('keydown', onKey)
  addEventListener('keyup', onKeyUp)
  addEventListener('blur', onBlur)
  addEventListener('resize', onResize)
  const onVis = () => { if (document.hidden) { onBlur(); if (ac) ac.suspend() } else if (ac && state !== 'off') ac.resume() }
  document.addEventListener('visibilitychange', onVis)

  // ?drivedebug: the state, for tests in a browser (window.driveDebug)
  if (location.search.includes('drivedebug')) window.driveDebug = { car, man, chase, walker, foot, isWater, goal, get run() { return job?.run }, get job() { return job }, get drift() { return drift }, get feel() { return feel }, get hike() { return hike }, get errand() { return errand }, get shift() { return job?.S }, get state() { return state }, startHike: (id) => startHike(HIKES.find((h) => h.id === id)), propsNear, nearestRoad, wallHit, railPast,
    get game() { return game }, get horn() { return !!horn }, get taxi() { return taxi }, showGarage, startTaxi: (x, y, c = { cab: 0, livery: 0, driver: 0 }) => { taxiChoice = c; start('taxi', carSpawn(x, y) || { x, y, yaw: 0 }, { x, y }) }, input, secs, collide, surface, frame,
    set autopilot(f) { autopilot = f }, set probe(f) { probe = f }, stop: () => { if (state === 'off') return; game?.dispose(); taxi?.dispose(); taxi = null; state = 'out'; finish() },
    start: (kind, x, y, yaw = 0) => start(kind, { x, y, yaw }, { x, y }), startBus: (name, dir = 0, from = 'first') => loadLines().then(({ man }) => { const ri = man.routes.findIndex((r) => r.name === name); return startBus({ ri, r: man.routes[ri], dir, from, man }) }) }
  return {
    dispose() {
      cancelPick()
      garage?.close(); garage = null
      foot.dispose()
      if (state !== 'off') { traffic()?.setObstacle('player-van', null); traffic()?.setObstacle('player-walker', null); taxi?.dispose(); taxi = null; state = 'out'; finish() }
      for (const f of offTiles) f()
      removeEventListener('keydown', onKey); removeEventListener('keyup', onKeyUp); removeEventListener('blur', onBlur); removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVis)
      button.remove()
      if (city.models?.van) { delete city.models.van; delete city.models.person }
      for (const e of ui.all) e.remove()
      ui.css.remove()
      if (engine) { engine.o1.stop(); engine.o2.stop() }
      master?.disconnect()
    },
  }
}
