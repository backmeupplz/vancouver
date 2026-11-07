// Drive: explore the real streets by van or on foot, work a shift for the Salmonberry Parcel Co., or hike a trail.
// The toolbar's "Drive" menu (or D for deliveries) asks for a spot on the map, then dives from the map into a
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
import { makeVan, newVan, stepVan, jolt } from './van.js'
import { makeWalker, poseWalker } from './walker.js'
import { makeProps, LAMP, STOP, YIELD, BUS, BOLLARD, BENCH } from './props.js'
import { makeKerbs } from './kerbs.js'

const DRIVE_MAX_KIND = 7 // motorway .. living street (graph piece kinds): where a van belongs
const WALK_MAX_KIND = 13 // .. steps, tracks: where a person can walk (plus the sidewalks of roads)
const CELL = 32 // metres, spatial grid for roads, footprints and street furniture
const WALK = 1.6, RUN = 4.6 // m/s
const HIKE = 3.2, HUSTLE = 5.6 // m/s on a trail, on the flat (a brisk, game-paced hike)
const VAN_L = 2.2, VAN_W = 0.95 // half length / width for collisions
const ARRIVE = 9, ARRIVE_FOOT = 3.5 // metres from a marker that count as there
const CARRY = 3.4, DOOR_MAX = 22 // the courier jogs parcels at this pace, from at most this far from the van
// Trailheads and goals (OpenStreetMap trails and peaks; the trail lines themselves come from the map tiles).
// view: the compass bearing of the view at the goal, for the photo; ele: its height (until its tile is loaded)
const HIKES = [
  { id: 'grind', name: 'Grouse Grind', from: [49.37109, -123.0982], to: [49.37897, -123.0833], goal: 'the Grind finish at the Grouse chalet', ele: 1127, view: 200, blurb: 'Mother Nature’s Stairmaster: 2.9 km, 850 m up' },
  { id: 'quarry', name: 'Quarry Rock', from: [49.33001, -122.9497], to: [49.3337, -122.93659], goal: 'Quarry Rock lookout over Indian Arm', ele: 100, view: 95, blurb: 'Baden-Powell Trail from Deep Cove: 1.8 km, roots and rock' },
  { id: 'lynn', name: 'Lynn Canyon', from: [49.34372, -123.01913], to: [49.34147, -123.01595], goal: 'Twin Falls bridge', ele: 140, view: 150, blurb: 'Over the suspension bridge, down to the falls: 600 m' },
  { id: 'siwash', name: 'Stanley Park seawall', from: [49.3027, -123.15653], to: [49.30809, -123.15503], goal: 'Siwash Rock lookout', ele: 12, view: 280, blurb: 'Third Beach to Siwash Rock along the water: 700 m, flat' },
  { id: 'wreck', name: 'Pacific Spirit: Wreck Beach', from: [49.2634, -123.25928], to: [49.26223, -123.26153], goal: 'the beach at the bottom of the stairs', ele: 3, view: 250, blurb: 'Down Trail 6’s 470 stairs through the forest to the sea' },
  { id: 'lighthouse', name: 'Lighthouse Park', from: [49.33656, -123.26265], to: [49.33153, -123.26449], goal: 'the viewpoint by Point Atkinson lighthouse', ele: 25, view: 160, blurb: 'Old-growth firs down to the rocks: 700 m' },
  { id: 'dog', name: 'Dog Mountain', from: [49.36844, -122.94914], to: [49.37373, -122.97043], goal: 'Dog Mountain’s bluff over the city', ele: 1054, view: 225, blurb: 'Mount Seymour, through the forest to the view: 2.5 km' },
]
const EASE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const ckey = (cx, cy) => cx * 8192 + cy

const FIRST = ['Mei', 'Arjun', 'Sofia', 'Daniel', 'Priya', 'Kenji', 'Amara', 'Liam', 'Noor', 'Jasmine', 'Tomás', 'Hana', 'Owen', 'Leilani', 'Ravi', 'Grace', 'Mateo', 'Yuki', 'Farah', 'Theo', 'Ines', 'Sam', 'Marguerite', 'Kai', 'Harpreet', 'Wei', 'Olivia', 'Jun', 'Aiyana', 'Connor', 'Fatima', 'Diego', 'Elodie', 'Min-jun', 'Rosa', 'Ezra']
const LAST = ['Chen', 'Sandhu', 'Nguyen', 'MacLeod', 'Wong', 'Gill', 'Tremblay', 'Kim', 'Singh', 'Lee', 'Fraser', 'Santos', 'Park', 'Dhillon', 'Campbell', 'Ito', 'Hassan', 'Martin', 'Leung', 'Grewal', 'Okafor', 'Novak', 'Reyes', 'Thompson', 'Lam', 'Jackson']
const PARCELS = ['a small parcel', 'a carefully taped box', 'a padded envelope', 'a parcel marked “fragile”', 'a flat-pack bookshelf', 'a box of vinyl records', 'a ceramic teapot (fragile!)',
  'a potted monstera, this side up', 'a crate of BC apples', 'a new bike wheel', 'a pair of hiking boots', 'a box of books', 'a guitar in a soft case', 'a birthday cake (keep it level)',
  'a rain jacket', 'a stack of board games', 'a sack of coffee beans', 'a tent for the weekend', 'a pair of skis', 'a cat tree']
const THANKS = ['Thanks so much!', 'Oh, lovely. Thank you!', 'Right on time, you’re a star.', 'Perfect, have a cozy day!', 'Ah, I was hoping it’d come today!', 'Thank you, drive safe!', 'Wonderful, cheers!']
const ITEMS = {
  bakery: ['a box of warm cinnamon buns', 'a sourdough loaf', 'a dozen bagels'], cafe: ['two oat-milk lattes', 'a bag of fresh beans', 'a tray of matcha lattes'],
  books: ['a stack of paperbacks', 'a signed novel'], florist: ['a bouquet of tulips', 'a little potted fern'], 'garden centre': ['a potted lemon tree', 'a sack of seed potatoes'],
  pharmacy: ['a small paper bag'], bicycle: ['a new bike bell', 'a set of panniers'], restaurant: ['a warm dinner for two', 'a box of dumplings'], 'fast food': ['a bag of fries, still hot'],
  'ice cream': ['a pint of salted caramel'], supermarket: ['a crate of groceries'], convenience: ['a carton of milk and some snacks'], greengrocer: ['a box of BC apples'],
  pet: ['a bag of cat food', 'a squeaky toy'], toys: ['a wooden train set'], music: ['a vinyl record'], hardware: ['a toolbox', 'a tin of paint'], doityourself: ['a tin of paint'],
  library: ['a pile of returned books'], tea: ['a tin of loose-leaf tea'], gift: ['a wrapped present'], clothes: ['a knitted sweater'], outdoor: ['a new rain jacket'],
  chocolate: ['a box of truffles'], deli: ['a picnic basket'], pub: ['a growler of local ale'], seafood: ['a cooler of fresh salmon'], 'post office': ['a sack of letters'],
}
// OpenStreetMap spells street names out; addresses abbreviate them
const ABBR = { Avenue: 'Ave', Street: 'St', Drive: 'Dr', Road: 'Rd', Boulevard: 'Blvd', Place: 'Pl', Crescent: 'Cres', Court: 'Ct', Highway: 'Hwy', Lane: 'Ln', Way: 'Way', Mall: 'Mall', Square: 'Sq', Terrace: 'Terr', Parkway: 'Pkwy' }
const DIRS = { East: 'E', West: 'W', North: 'N', South: 'S' }
function abbr(name) {
  const w = name.split(' ')
  if (w.length >= 3 && DIRS[w[0]]) w[0] = DIRS[w[0]]
  if (w.length >= 2 && ABBR[w[w.length - 1]]) w[w.length - 1] = ABBR[w[w.length - 1]]
  return w.join(' ')
}

export default function drive(city) {
  const { THREE } = city
  const v3 = new THREE.Vector3(), v4 = new THREE.Vector3()

  // ================================================================ the street index (detail tiles, lazily)
  const infos = new Map(), overview = new Map(), built = new Map() // "i_j" -> tile info / its index
  const offTiles = [
    city.world.eachTile((t) => { const k = `${t.i}_${t.j}`; if (t.level === 0) { infos.set(k, t); built.delete(k) } else overview.set(k, t) }),
    city.on('tile:unload', (t) => { const k = `${t.i}_${t.j}`; if (t.level === 0) { infos.delete(k); built.delete(k) } else overview.delete(k) }),
  ]
  const walkable = (p) => p.kind <= WALK_MAX_KIND && p.kind > 1 // not motorways or trunk roads
  const drivable = (p) => p.drive && p.kind <= DRIVE_MAX_KIND
  const trail = (p) => p.kind >= 8 && p.kind <= 13 // pedestrian .. track: off the streets
  function index(t) { // roads (drivable and walkable segments), building footprints and street furniture on a grid
    const segs = [], rg = new Map(), fg = new Map()
    const put = (g, k, v) => { let a = g.get(k); if (!a) g.set(k, (a = [])); if (a[a.length - 1] !== v) a.push(v) }
    for (const p of t.graph.pieces) {
      const drv = drivable(p), wlk = walkable(p)
      if (!drv && !wlk) continue
      for (let i = 0; i < p.pts.length / 2 - 1; i++) {
        const s = { p, i, drv, wlk, x0: p.pts[i * 2], y0: p.pts[i * 2 + 1], x1: p.pts[i * 2 + 2], y1: p.pts[i * 2 + 3], z0: p.z ? p.z[i] : null, z1: p.z ? p.z[i + 1] : null }
        const n = Math.ceil(Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / 16), id = segs.push(s) - 1
        for (let k = 0; k <= n; k++) { const f = k / n || 0; put(rg, ckey(Math.floor((s.x0 + (s.x1 - s.x0) * f) / CELL), Math.floor((s.y0 + (s.y1 - s.y0) * f) / CELL)), id) }
      }
    }
    const fp = t.footprints, bb = []
    if (fp) for (let r = 0; r < fp.start.length - 1; r++) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let q = fp.start[r]; q < fp.start[r + 1]; q += 2) { const x = fp.pts[q], y = fp.pts[q + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
      bb.push(x0, y0, x1, y1)
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) put(fg, ckey(cx, cy), r)
    }
    const b = { t, segs, rg, fg, fp, bb, segSeen: new Uint32Array(segs.length), fpSeen: new Uint32Array(bb.length / 4) }
    furniture(b)
    return b
  }
  // things to bump into, 6 floats each (x, north, radius, kind, angle, ground) on a 32 m grid over the tile (start
  // offsets per cell, like a counting sort): tree trunks, and the street lamps, stop / give-way and bus stop signs the
  // tiles have as points. Signs and lamps mapped on the carriageway are moved to its kerb.
  function furniture(b) {
    const t = b.t, K = 1024 / CELL, P = []
    const KIND = { 3: LAMP, 2: STOP, 6: YIELD, 5: BUS, 4: BENCH }
    for (const q of t.graph.pois || []) {
      const kind = KIND[q.kind]
      if (!kind) continue
      let x = q.x, y = q.y, ang = 0, best = kind === BENCH ? -99 : 6
      for (const id of b.rg.get(ckey(Math.floor(x / CELL), Math.floor(y / CELL))) || []) { // the road it stands by
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
      P.push(x, y, kind === LAMP ? 0.15 : kind === BENCH ? 0.6 : 0.1, kind, ang, city.world.heightAt(x, -y))
    }
    const T = t.trees, pos = T?.pos || T?.geometry?.attributes.iPos?.array, size = T?.size || T?.geometry?.attributes.iSize?.array
    if (pos && t.level === 0) for (let i = 0; i < pos.length / 3; i++) P.push(t.ox + pos[i * 3], t.oy - pos[i * 3 + 2], Math.max(0.15, size[i * 2] * 0.035), 0, 0, pos[i * 3 + 1])
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
  function each(x, y, r, fn) { // fn(tileIndex) for detail tiles near (x, north)
    for (let i = Math.floor((x - r) / 1024); i <= Math.floor((x + r) / 1024); i++) for (let j = Math.floor((y - r) / 1024); j <= Math.floor((y + r) / 1024); j++) {
      const k = `${i}_${j}`
      let b = built.get(k)
      if (!b) { const t = infos.get(k); if (!t) continue; b = index(t); built.set(k, b) }
      fn(b)
    }
  }
  // the nearest road segment point within r metres: drivable ones, or walkable ones (walk); deck: bridge decks only
  function nearestRoad(x, y, r, deck = false, walk = false) {
    let best = null, bd = r
    const mark = ++stamp
    each(x, y, r, (b) => {
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
        for (const id of b.rg.get(ckey(cx, cy)) || []) {
          if (b.segSeen[id] === mark) continue
          b.segSeen[id] = mark
          const s = b.segs[id]
          if ((walk ? !s.wlk : !s.drv) || (deck && s.z0 == null)) continue
          const dx = s.x1 - s.x0, dy = s.y1 - s.y0, L2 = dx * dx + dy * dy || 1
          const u = clamp(((x - s.x0) * dx + (y - s.y0) * dy) / L2, 0, 1), px = s.x0 + dx * u, py = s.y0 + dy * u
          const d = Math.hypot(x - px, y - py) - s.p.w / 2
          if (d < bd) { bd = d; best = { s, u, px, py, d: Math.max(0, d), dist: Math.hypot(x - px, y - py), z: s.z0 == null ? null : s.z0 + (s.z1 - s.z0) * u, dir: Math.atan2(dy, dx), w: s.p.w } }
        }
      }
    })
    return best
  }
  // fn(seg) for every indexed road segment in the grid cells within r of (x, north)
  function segsNear(x, y, r, fn) {
    const mark = ++stamp
    each(x, y, r, (b) => {
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
        for (const id of b.rg.get(ckey(cx, cy)) || []) { if (b.segSeen[id] !== mark) { b.segSeen[id] = mark; fn(b.segs[id]) } }
      }
    })
  }
  // push a circle out of building footprints: returns the summed push (x, y) or null
  function collide(x, y, rad) {
    let px = 0, py = 0, hit = false
    const mark = ++stamp
    each(x, y, rad, (b) => {
      if (!b.fp) return
      for (let cx = Math.floor((x - rad) / CELL); cx <= Math.floor((x + rad) / CELL); cx++) for (let cy = Math.floor((y - rad) / CELL); cy <= Math.floor((y + rad) / CELL); cy++) {
        for (const r of b.fg.get(ckey(cx, cy)) || []) {
          if (b.fpSeen[r] === mark) continue
          b.fpSeen[r] = mark
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
          const nx = (x - bx) / (bd || 1), ny = (y - by) / (bd || 1)
          const k = inside ? -(bd + rad) : rad - bd // inside: out through the nearest wall
          px += nx * k; py += ny * k; hit = true
        }
      }
    })
    return hit ? { x: px, y: py } : null
  }
  const insideBuilding = (x, y) => !!collide(x, y, 0.01)
  // the first building wall on the way from (x0, y0) to (x1, y1): the fraction of the way (1 = none)
  function wallHit(x0, y0, x1, y1) {
    let best = 1
    const mark = ++stamp, dx = x1 - x0, dy = y1 - y0
    const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1)
    each((lx + hx) / 2, (ly + hy) / 2, Math.max(hx - lx, hy - ly) / 2 + 1, (b) => {
      if (!b.fp) return
      for (let cx = Math.floor(lx / CELL); cx <= Math.floor(hx / CELL); cx++) for (let cy = Math.floor(ly / CELL); cy <= Math.floor(hy / CELL); cy++) {
        for (const r of b.fg.get(ckey(cx, cy)) || []) {
          if (b.fpSeen[r] === mark) continue
          b.fpSeen[r] = mark
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
    })
    return best
  }
  function isWater(x, y) {
    const t = infos.get(`${Math.floor(x / 1024)}_${Math.floor(y / 1024)}`)
    if (!t?.water) return false
    const n = t.water.n, i = Math.floor(((x - t.ox) / 1024) * n), j = Math.floor(((y - t.oy) / 1024) * n)
    return i >= 0 && j >= 0 && i < n && j < n && t.water.mask[j * n + i] === 1
  }
  // circle (x, y, r) against a box (centre, unit forward f, half length hl, half width hw): the push out, or null
  function circleBox(x, y, r, cx, cy, fx, fy, hl, hw) {
    const dx = x - cx, dy = y - cy, lf = dx * fx + dy * fy, lr = dx * fy - dy * fx // right = (fy, -fx)
    let ef = lf - clamp(lf, -hl, hl), er = lr - clamp(lr, -hw, hw), d = Math.hypot(ef, er), k
    if (d < 1e-6) { // centre inside: out through the nearest side
      const pf = hl - Math.abs(lf), pr = hw - Math.abs(lr)
      if (pf < pr) { ef = Math.sign(lf) || 1; er = 0; k = r + pf } else { ef = 0; er = Math.sign(lr) || 1; k = r + pr }
    } else if (d < r) { k = (r - d) / d } else return null
    return { x: (ef * fx + er * fy) * k, y: (ef * fy - er * fx) * k }
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

  // ================================================================ street names and shops (OpenStreetMap, per 4 km cell)
  const cells = new Map() // "I_J" -> null while loading, then { segs, name, grid, names, places }
  let cellList = null
  fetch(new URL('./data/index.json', import.meta.url)).then((r) => r.json()).then((l) => { cellList = new Set(l) }).catch(() => { cellList = new Set() })
  function cellsNear(x, y, r) { // the loaded cells within r; starts loading the missing ones
    const out = []
    if (!cellList) return out
    for (let I = Math.floor((x - r) / 4096); I <= Math.floor((x + r) / 4096); I++) for (let J = Math.floor((y - r) / 4096); J <= Math.floor((y + r) / 4096); J++) {
      const k = `${I}_${J}`
      if (!cellList.has(k)) continue
      if (!cells.has(k)) {
        cells.set(k, null)
        fetch(new URL(`./data/${k}.json`, import.meta.url)).then((r) => r.json()).then((d) => cells.set(k, prepCell(d))).catch((e) => { console.warn('drive: no street names for', k, e); cells.set(k, { segs: [], name: [], grid: new Map(), names: [], places: [], bollards: new Map() }) })
      }
      const c = cells.get(k)
      if (c) out.push(c)
    }
    return out
  }
  function prepCell(d) {
    const [ox, oy] = d.o, segs = [], name = [], grid = new Map()
    for (const row of d.s) for (let i = 1; i + 3 < row.length; i += 2) {
      const x0 = row[i] + ox, y0 = row[i + 1] + oy, x1 = row[i + 2] + ox, y1 = row[i + 3] + oy, id = name.push(row[0]) - 1
      segs.push(x0, y0, x1, y1)
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 24)
      for (let k = 0; k <= n; k++) {
        const f = k / n || 0, key = ckey(Math.floor((x0 + (x1 - x0) * f) / 48), Math.floor((y0 + (y1 - y0) * f) / 48))
        let a = grid.get(key); if (!a) grid.set(key, (a = [])); if (a[a.length - 1] !== id) a.push(id)
      }
    }
    const places = d.p.map(([x, y, nm, k, addr]) => ({ x: x + ox, y: y + oy, name: nm, kind: d.k[k], addr }))
    const bollards = new Map()
    for (let i = 0; i + 1 < (d.b || []).length; i += 2) {
      const x = ox + d.b[i] / 10, y = oy + d.b[i + 1] / 10, key = ckey(Math.floor(x / CELL), Math.floor(y / CELL))
      let a = bollards.get(key); if (!a) bollards.set(key, (a = [])); a.push(x, y)
    }
    return { segs, name, grid, names: d.n, places, bollards }
  }
  // the nearest named street within r metres: { name, x0, y0, x1, y1, px, py, d }
  function nearestStreet(x, y, r) {
    let best = null, bd = r
    for (const c of cellsNear(x, y, r)) {
      const seen = new Set()
      for (let gx = Math.floor((x - r) / 48); gx <= Math.floor((x + r) / 48); gx++) for (let gy = Math.floor((y - r) / 48); gy <= Math.floor((y + r) / 48); gy++) {
        for (const id of c.grid.get(ckey(gx, gy)) || []) {
          if (seen.has(id)) continue
          seen.add(id)
          const x0 = c.segs[id * 4], y0 = c.segs[id * 4 + 1], dx = c.segs[id * 4 + 2] - x0, dy = c.segs[id * 4 + 3] - y0
          const u = clamp(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1), 0, 1), px = x0 + dx * u, py = y0 + dy * u, d = Math.hypot(x - px, y - py)
          if (d < bd) { bd = d; best = { name: c.names[c.name[id]], x0, y0, x1: x0 + dx, y1: y0 + dy, px, py, d } }
        }
      }
    }
    return best
  }
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
  // model factories, so other players (multiplayer) look like this one
  city.models = { ...city.models, van: (colour = COLOUR) => makeVan(THREE, colour), person: (colour) => makeWalker(THREE, colour) }
  const blobMat = new THREE.MeshBasicMaterial({ map: radial('rgba(0,0,0,0.42)'), transparent: true, depthWrite: false, fog: false })
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 5.0).rotateX(-Math.PI / 2), blobMat)
  const wblob = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2), blobMat)
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { col: { value: new THREE.Color() }, t: { value: 0 } },
    vertexShader: 'varying float vY; void main() { vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 col; uniform float t; varying float vY; void main() { float a = pow(1.0 - vY, 1.5) * (0.75 + 0.2 * sin(t * 3.0 - vY * 14.0)); gl_FragColor = vec4(col * a, a); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  })
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 70, 20, 1, true).translate(0, 35, 0), beamMat)
  const ringMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 4.0, 48).rotateX(-Math.PI / 2), ringMat)
  const ring2Mat = ringMat.clone()
  const ring2 = new THREE.Mesh(new THREE.RingGeometry(3.6, 3.8, 48).rotateX(-Math.PI / 2), ring2Mat)
  const icons = { pickup: parcelIcon(), drop: houseIcon(), summit: flagIcon() }
  const props = makeProps(THREE), lips = makeKerbs(THREE, segsNear)
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
  let ac = null, engine = null, muted = false
  try { muted = localStorage.getItem('delivery.muted') === '1' } catch {}
  function audio() {
    if (ac) return ac
    try { ac = new AudioContext() } catch { return null }
    const out = ac.createGain(); out.gain.value = muted ? 0 : 1; out.connect(ac.destination); ac.out = out
    // engine: two detuned saws through a low-pass, very quiet; pitch and level follow the speed
    const g = ac.createGain(); g.gain.value = 0
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 0.7
    const o1 = ac.createOscillator(), o2 = ac.createOscillator()
    o1.type = 'sawtooth'; o2.type = 'triangle'; o1.frequency.value = 42; o2.frequency.value = 84.5
    o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(out); o1.start(); o2.start()
    engine = { g, o1, o2, lp }
    return ac
  }
  function tone(freq, t0, dur, vol, type = 'sine') {
    const o = ac.createOscillator(), g = ac.createGain()
    o.type = type; o.frequency.value = freq
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    o.connect(g); g.connect(ac.out); o.start(t0); o.stop(t0 + dur + 0.05)
  }
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
    sh.connect(pk); pk.connect(lp); lp.connect(out); out.connect(ac.out)
    out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(0.06, t + 0.012)
    const oscs = [418, 526].map((f) => {
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
  // haptics where the phone has them (Android; iOS Safari has no navigator.vibrate)
  const buzz = (p) => { try { navigator.vibrate?.(p) } catch {} }
  function setMuted(m) { muted = m; try { localStorage.setItem('delivery.muted', m ? '1' : '0') } catch {}; if (ac) ac.out.gain.value = m ? 0 : 1; ui.mute.textContent = m ? 'Sound off' : 'Sound on' }

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
      .dlv-touch { inset: auto 0 0 0; height: 170px; display: none; }
      .dlv-touch button { position: absolute; bottom: 52px; width: 74px; height: 74px; border-radius: 50%; font-size: 15px; font-weight: 650; background: rgba(38,30,28,.5); border: 2px solid rgba(255,236,214,.35); touch-action: none; user-select: none; -webkit-user-select: none; }
      .dlv-touch button.on { background: rgba(232,115,90,.75) }
      .dlv-touch .l { left: 16px } .dlv-touch .r { left: 100px } .dlv-touch .gas { right: 16px; height: 100px; border-radius: 22px } .dlv-touch .brk { right: 100px; width: 66px; height: 66px }
      .dlv-touch .act { right: 16px; bottom: 222px; width: auto; height: 40px; padding: 0 14px; border-radius: 20px; font-size: 14px; }
      .dlv-touch .act[hidden] { display: none }
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
      .compact .dlv-read { left: var(--sl); top: var(--st); height: 44px; display: flex; align-items: center; gap: 4px; box-sizing: border-box; padding: 0 12px; font-size: 13px; max-width: calc(100% - var(--sl) - var(--sr) - 146px); }
      .compact .dlv-btns { right: var(--sr); top: var(--st); }
      .compact .dlv-btns .opt, .dlv-btns .short, .compact .dlv-btns .long { display: none }
      .compact .dlv-btns .short { display: inline }
      .compact .dlv-btns [data-exit] { width: 78px; height: 44px; padding: 0; border-radius: 12px; }
      .compact .dlv-btns [data-assist] { height: 44px; padding: 0 10px; border-radius: 12px; }
      .compact.dlv-assist .dlv-read { max-width: calc(100% - var(--sl) - var(--sr) - 230px); }
      .compact .dlv-job { top: calc(var(--st) + 52px); left: var(--sl); right: var(--sr); transform: none; width: auto; max-width: 460px; padding: 8px 12px 8px 8px; gap: 10px; }
      .compact .dlv-job > div:last-child { min-width: 0; flex: 1 }
      .compact .dlv-job .where, .compact .dlv-job .sub, .compact .dlv-job .what { max-width: none }
      .compact .dlv-job .where { font-size: 15px }
      .compact .dlv-arrow { width: 46px; height: 46px; }
      .compact .dlv-pick { top: calc(var(--st) + 52px); left: var(--sl); right: var(--sr); transform: none; justify-content: space-between; white-space: normal; font-size: 14px; }
      .compact .dlv-pick button { min-height: 44px; padding: 0 14px; flex: none; }
      .compact .dlv-pop { max-width: calc(100% - 48px); box-sizing: border-box; }
      .compact .dlv-job .aboard { max-width: none }
      .compact .dlv-photo { bottom: calc(max(16px, env(safe-area-inset-bottom)) + 8px); }
      .compact .dlv-touch { --pb: max(16px, calc(env(safe-area-inset-bottom) + 4px)); height: auto; top: 0; }
      .compact .dlv-touch button { bottom: var(--pb); }
      .compact .dlv-touch .l { left: var(--sl) } .compact .dlv-touch .r { left: calc(var(--sl) + 84px) }
      .compact .dlv-touch .gas { right: var(--sr) } .compact .dlv-touch .brk { right: calc(var(--sr) + 86px); bottom: var(--pb) }
      .compact .dlv-touch .act { right: var(--sr); bottom: calc(var(--pb) + 112px); height: 44px; border-radius: 22px; }
      .compact body.dlv-on .lofi { padding: 0 } .compact body.dlv-on .lofi-name, .compact body.dlv-on .lofi canvas { display: none }
      .compact body.dlv-on.dlv-touchy .lofi { bottom: calc(max(16px, calc(env(safe-area-inset-bottom) + 4px)) + 112px) !important; }
      @media (orientation: landscape) {
        .compact .dlv-job { max-width: min(420px, 50%); }
        .compact .dlv-touch .act { bottom: calc(var(--pb) + 112px); }
        .compact body.dlv-on .lofi { padding: 0 } .compact body.dlv-on .lofi-name, .compact body.dlv-on .lofi canvas { display: none }
      .compact body.dlv-on.dlv-touchy .lofi { bottom: max(16px, calc(env(safe-area-inset-bottom) + 4px)) !important; }
      }`
    document.head.append(css)
    const el = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; d.hidden = true; document.body.append(d); return d }
    const co = el('dlv dlv-co card', `<div class="name">Salmonberry Parcel Co.</div>
      <div class="stats"><span><b data-n>0</b> delivered</span><span><b data-m>$0.00</b></span><span data-c></span></div><div class="credit">Streets © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</div>`)
    const btns = el('dlv dlv-btns', '<button data-assist title="Lane assist (G): while you aren’t steering, the van gently straightens up along the road it’s on. It never steers against you."></button><button class="opt" data-mute title="Sound (M)">Sound on</button><button data-exit title="Back to the map (Esc)" aria-label="Back to the map"><span class="long">Back to map</span><span class="short">‹ Map</span></button>')
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
    const touch = el('dlv dlv-touch', '<button class="l" data-k="left" aria-label="Turn left">◀</button><button class="r" data-k="right" aria-label="Turn right">▶</button><button class="brk" data-k="brake" aria-label="Brake and reverse">Brake</button><button class="gas" data-k="gas" aria-label="Go">Go</button><button class="act" data-act hidden></button>')
    const q = (e, s) => e.querySelector(s)
    return { co, btns, read, job, help, act, pop, pickEl, touch, sheet, flash, photo, aboard, stam, stamBar: stam.firstChild,
      all: [co, btns, read, job, help, act, pop, pickEl, touch, sheet, flash, photo], n: q(co, '[data-n]'), m: q(co, '[data-m]'), c: q(co, '[data-c]'),
      assist: q(btns, '[data-assist]'), mute: q(btns, '[data-mute]'), exit: q(btns, '[data-exit]'), arrow: q(job, 'svg'), north: q(job, '.n'), w: q(job, '[data-w]'), p: q(job, '[data-p]'), s: q(job, '[data-s]'),
      d: q(job, '[data-d]'), t: q(job, '[data-t]'), b: q(pop, '[data-b]'), qq: q(pop, '[data-q]'), pt: q(pickEl, '[data-pt]'), cancel: q(pickEl, '[data-cancel]'), brk: q(touch, '.brk'), tact: q(touch, '[data-act]'), css }
  }
  const touchState = { left: false, right: false, gas: false, brake: false }
  for (const b of ui.touch.querySelectorAll('[data-k]')) {
    const k = b.dataset.k, set = (on) => (e) => { e.preventDefault(); if (on && !touchState[k]) buzz(6); touchState[k] = on; b.classList.toggle('on', on); if (on) audio() }
    b.addEventListener('pointerdown', (e) => { try { b.setPointerCapture(e.pointerId) } catch {} set(true)(e) })
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, set(false))
    b.addEventListener('contextmenu', (e) => e.preventDefault())
  }
  ui.tact.addEventListener('click', () => (errand ? hurry() : toggleFoot()))
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
    city.ui.toast(`Lane assist is ${assist ? 'on' : 'off'}: when you let go of the steering, the van straightens up along the road.${touchy ? ' The Lane button switches it.' : ' G or the button switches it.'}`, 7000)
  }
  ui.mute.onclick = () => setMuted(!muted)
  ui.mute.textContent = muted ? 'Sound off' : 'Sound on'
  let popT = 0, helpT = 0
  function popup(big, line) {
    ui.b.textContent = big; ui.qq.textContent = line
    ui.pop.hidden = false
    requestAnimationFrame(() => ui.pop.classList.add('on'))
    clearTimeout(popT); popT = setTimeout(() => { ui.pop.classList.remove('on'); setTimeout(() => { if (!ui.pop.classList.contains('on')) ui.pop.hidden = true }, 350) }, 2600)
  }
  function showHelp() { // the keys, for a few seconds after each change between van and feet (always while delivering)
    ui.help.textContent = hike ? 'WASD or arrows to walk · Shift to push on (it tires you) · the trail guides you when you let go · Esc to the map'
      : onFoot ? 'WASD or arrows to walk · Shift to run · E to get in the van · Esc to the map'
      : `W gas · S brake, hold to reverse · A D steer · Space handbrake · E get out · H horn · R back on the road · Esc map`
    ui.help.hidden = false; ui.help.classList.remove('fade')
    clearTimeout(helpT)
    if (!deliver) helpT = setTimeout(() => ui.help.classList.add('fade'), 7000)
  }

  // ================================================================ the game state
  const pcam = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 1, 900)
  const opts = { focus: new THREE.Vector3(), radius: 900, shadowRadius: 300 }
  const car = Object.assign(newVan(), { x: 0, y: 0, h: 0, spin: 0, roll: 0, deck: false, bumpT: 0, kerb: true })
  const man = { x: 0, y: 0, h: 0, yaw: 0, speed: 0, phase: 0, run: false, bumpT: 0, board: null, stamina: 1, winded: false }
  const chase = { pos: new THREE.Vector3(), look: new THREE.Vector3(), yaw: 0 }
  let state = 'off', anim = null, offFrame = null, t0 = 0, mapPose = null, fromPose = null, saved = null
  let deliver = false, onFoot = false, hasVan = true, assist = true, run = null, shift = newShift(), hudAt = 0, jobRetry = 0, readAt = 0, street = null, shake = 0, skyAt = 0, fogFar = 850
  let pickKind = null, down = null, hike = null, errand = null, grip = 1, propsAt = null, kerbsAt = null, vista = 0 // vista: 0 .. 1 the photo's long view
  const scratch = { people: [], poles: [], props: new Float32Array(700 * 5), seen: new Map() }
  try { assist = localStorage.getItem('delivery.assist') !== '0' } catch {}
  assistLabel()
  const keys = new Set()

  const button = city.ui.addButton({ label: 'Drive', icon: '🚐', title: 'Explore the streets by van or on foot, or deliver parcels (D)', panel: true })
  button.panel.innerHTML = `<div class="dlv-menu">
    <button data-m="car"><span>🚐</span><div>Explore by van<small>Drive anywhere, no jobs</small></div></button>
    <button data-m="foot"><span>🚶</span><div>Explore on foot<small>Walk the sidewalks; ${touchy ? 'hop' : 'E gets'} in the van</small></div></button>
    <button data-m="deliver"><span>📦</span><div>Deliveries<small>Pick up at real shops, drop off at real doors; a compass, tips</small></div></button>
    <button data-m="hike"><span>🥾</span><div>Hike a trail<small>Grouse Grind, Quarry Rock, Lynn Canyon and more</small></div></button></div>`
  const menuEl = button.panel.querySelector('.dlv-menu'), menuHTML = menuEl.innerHTML
  function hikeLog() { try { return JSON.parse(localStorage.getItem('drive.hikes') || '{}') } catch { return {} } }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  function menu() {
    for (const b of menuEl.querySelectorAll('[data-m]')) b.addEventListener('click', () => {
      if (b.dataset.m === 'hike') { // the trailheads, then back to the menu
        const log = hikeLog()
        menuEl.innerHTML = HIKES.map((h) => `<button data-h="${h.id}"><span>⛰️</span><div>${h.name}<small>${h.blurb}</small></div>${log[h.id] ? `<span class="done">✓ ${mmss(log[h.id].best)}</span>` : ''}</button>`).join('') + '<button class="back" data-back>‹ Back</button>'
        for (const e of menuEl.querySelectorAll('[data-h]')) e.addEventListener('click', () => { closeMenu(); startHike(HIKES.find((h) => h.id === e.dataset.h)) })
        menuEl.querySelector('[data-back]').addEventListener('click', () => { menuEl.innerHTML = menuHTML; menu() })
        return
      }
      closeMenu(); startPick(b.dataset.m)
    })
  }
  function closeMenu() { button.panel.hidden = true; button.button.setAttribute('aria-expanded', 'false'); setTimeout(() => { menuEl.innerHTML = menuHTML; menu() }, 300) }
  menu()

  // ---------------------------------------------------------------- pick where to start
  function startPick(kind) {
    if (state === 'pick') cancelPick()
    if (state !== 'off') return
    pickKind = kind; state = 'pick'
    audio()
    ui.pt.textContent = `${touchy ? 'Tap' : 'Click'} where to start ${kind === 'foot' ? 'walking' : kind === 'car' ? 'driving' : 'your shift'}`
    ui.pickEl.hidden = false
    document.body.classList.add('dlv-picking')
    city.canvas.addEventListener('pointerdown', onPickDown)
    city.canvas.addEventListener('pointerup', onPickUp)
  }
  function cancelPick() {
    if (state !== 'pick') return
    state = 'off'; down = null
    ui.pickEl.hidden = true
    document.body.classList.remove('dlv-picking')
    city.canvas.removeEventListener('pointerdown', onPickDown)
    city.canvas.removeEventListener('pointerup', onPickUp)
  }
  const pointers = new Set()
  function onPickDown(e) { pointers.add(e.pointerId); down = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null }
  function onPickUp(e) { // a click or tap, not the end of a drag or a pinch
    pointers.delete(e.pointerId)
    const d = down; down = null
    if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 600) return
    const g = groundAt(e.clientX, e.clientY)
    if (!g) return
    const kind = pickKind
    const spot = kind === 'foot' ? footSpawn(g.x, g.y) : carSpawn(g.x, g.y)
    if (!spot) { city.ui.toast(kind === 'foot' ? 'Nowhere to walk there: try a street' : 'No street there: try closer to a road'); return }
    cancelPick()
    start(kind, spot, g)
  }
  // the ground under a screen point: march down the map camera's ray until it is below the terrain
  const ray = new THREE.Raycaster()
  function groundAt(cx, cy) {
    const r = city.canvas.getBoundingClientRect()
    ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), city.camera)
    const o = ray.ray.origin, d = ray.ray.direction
    if (d.y > -0.05) return null
    const below = (t) => o.y + d.y * t < city.world.heightAt(o.x + d.x * t, o.z + d.z * t)
    let a = (o.y - 2200) / -d.y, b = a
    for (let k = 0; k < 1000 && !below(b); k++) { a = b; b += 12 }
    if (!below(b)) return null
    for (let k = 0; k < 14; k++) { const m = (a + b) / 2; if (below(m)) b = m; else a = m }
    return { x: o.x + d.x * b, y: -(o.z + d.z * b) }
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

  function start(kind, spot, at) {
    deliver = kind === 'deliver'
    onFoot = kind === 'foot' || kind === 'hike'
    hike = kind === 'hike' ? at.hike : null
    document.activeElement?.blur?.() // a focused toolbar button would take Space (brake) as a click
    Object.assign(car, newVan(), { roll: 0, deck: false, kerb: true, parked: onFoot })
    errand = null; carried.visible = false
    if (onFoot) {
      Object.assign(man, { x: spot.x, y: spot.y, yaw: spot.yaw, speed: 0, board: null, stamina: 1, winded: false })
      man.h = city.world.heightAt(man.x, -man.y) + 0.15
      const v = !hike && carSpawn(at.x, at.y) // the van waits on the street nearby (not at a trailhead)
      hasVan = !!v && Math.hypot(v.x - man.x, v.y - man.y) < 120
      if (hasVan) Object.assign(car, { x: v.x, y: v.y, yaw: v.yaw })
    } else { hasVan = true; Object.assign(car, { x: spot.x, y: spot.y, yaw: spot.yaw }) }
    if (hasVan) car.h = surface(car.x, car.y, city.world.heightAt(car.x, -car.y) + 0.2).y
    // where the map camera is: the dive starts there, and Esc returns there exactly
    const C = city.camera, T = city.controls.target
    mapPose = { look: T.clone(), dir: C.position.clone().sub(T).normalize(), H: (C.top - C.bottom) / C.zoom, fov: 2 }
    chase.yaw = body().yaw
    chasePose(0, true)
    shift = newShift(); run = null; jobRetry = 0; street = null; propsAt = kerbsAt = null
    saved = { bg: city.scene.background, fog: city.scene.fog }
    if (hasVan) city.scene.add(van)
    city.scene.add(walker, icons.pickup, icons.drop, icons.summit, props.group, lips.mesh)
    walker.visible = onFoot
    icons.pickup.visible = icons.drop.visible = icons.summit.visible = false
    city.overlay.add(blob, wblob, beam, ring, ring2, pool)
    beam.visible = ring.visible = ring2.visible = false
    wblob.visible = onFoot; blob.visible = hasVan
    if (hike) setGoal(hike.gx, hike.gy, 0x7fe0b0, icons.summit)
    place()
    fitCamera()
    cellsNear(body().x, body().y, 800)
    state = 'in'; t0 = performance.now()
    city.view.useCamera(pcam, opts)
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
  function exit(force) {
    hornOff()
    if (state === 'pick') return cancelPick()
    if (state !== 'play') return
    if (deliver && !force && (shift.n || shift.km > 0.3)) return summary() // the end-of-shift card first
    ui.sheet.hidden = true; ui.photo.classList.remove('on')
    fromPose = { look: chase.look.clone(), dir: chase.pos.clone().sub(chase.look).normalize(), H: 2 * chase.pos.distanceTo(chase.look) * Math.tan((pcam.fov * Math.PI) / 360), fov: pcam.fov }
    state = 'out'; t0 = performance.now()
    for (const e of ui.all) e.hidden = true
    document.body.classList.remove('dlv-shot')
    keys.clear()
    if (engine) engine.g.gain.setTargetAtTime(0, ac.currentTime, 0.2)
    traffic()?.setObstacle('player-van', null); traffic()?.setObstacle('player-walker', null)
    if (deliver) saveTotals()
  }
  function finish() { // back on the map camera, exactly where it was
    state = 'off'
    city.view.release()
    offFrame?.(); offFrame = null
    anim?.(); anim = null
    city.scene.remove(van, walker, icons.pickup, icons.drop, icons.summit, props.group, lips.mesh)
    city.overlay.remove(blob, wblob, beam, ring, ring2, pool)
    city.scene.background = saved.bg; city.scene.fog = saved.fog
    hike = null; errand = null; run = null; vista = 0
    publishPlayer(true)
    document.body.classList.remove('dlv-on', 'dlv-touchy', 'dlv-shot'); document.documentElement.classList.remove('dlv-assist')
    button.button.setAttribute('aria-pressed', 'false')
    city.requestRender()
  }
  function newShift() { return { n: 0, money: 0, tips: 0, km: 0, bumps: 0, people: 0, kerbs: 0, shops: new Set(), best: null, t0: performance.now(), saved: false } }
  function saveTotals() {
    if (shift.saved) return
    shift.saved = true
    try {
      const t = JSON.parse(localStorage.getItem('delivery.totals') || '{"n":0,"money":0}')
      t.n += shift.n; t.money += shift.money
      localStorage.setItem('delivery.totals', JSON.stringify(t))
    } catch {}
  }
  // the end of a shift: what was done, a few stars and a kind word; keep driving, or head home
  function summary() {
    const S = shift, mins = (performance.now() - S.t0) / 60000
    let all = null
    try { all = JSON.parse(localStorage.getItem('delivery.totals') || 'null') } catch {}
    const care = Math.max(0, 1 - (S.bumps + 2 * S.people + 0.3 * S.kerbs) / Math.max(2, S.n * 2.5))
    const pace = S.n ? Math.min(1, S.n / Math.max(1, mins / 3.5)) : 0
    const stars = S.n ? Math.max(1, Math.min(5, Math.round(1 + 2.4 * care + 1.6 * pace))) : 0
    const line = !S.n ? 'No parcels this time. The kettle’s on at the depot whenever you’re ready.'
      : S.people ? 'Everyone’s fine, but do keep an eye out for folks on foot.'
      : !S.bumps && !S.kerbs ? 'Not a single bump. The neighbourhood thanks you.'
      : stars >= 4 ? 'Lovely work: smooth driving, happy doorsteps.' : 'A good day’s work. Put your feet up.'
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`
    ui.sheet.innerHTML = `<h3>Salmonberry Parcel Co. · shift summary</h3>
      <div class="big">$${S.money.toFixed(2)}</div><div class="stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</div>
      <dl>${row('Parcels delivered', S.n)}${row('Tips', `$${S.tips.toFixed(2)}`)}${row('Shops visited', S.shops.size)}${row('Driven', `${S.km.toFixed(1)} km in ${Math.max(1, Math.round(mins))} min`)}
      ${row('Bumps', S.bumps + S.kerbs ? `${S.bumps} knock${S.bumps === 1 ? '' : 's'}, ${S.kerbs} kerb${S.kerbs === 1 ? '' : 's'}` : 'none')}${row('People startled', S.people || 'nobody')}
      ${S.best ? row('Best tip', `$${S.best.tip.toFixed(2)} from ${escape(S.best.who.split(' ')[0])}`) : ''}${all ? row('All time', `${all.n + S.n} parcels, $${(all.money + S.money).toFixed(2)}`) : ''}</dl>
      <div class="line">${line}</div><div class="row"><button data-k>Keep driving</button><button class="main" data-end>End shift</button></div>`
    ui.sheet.hidden = false
    keys.clear()
    ui.sheet.querySelector('[data-k]').onclick = () => { ui.sheet.hidden = true }
    ui.sheet.querySelector('[data-end]').onclick = () => exit(true)
  }
  const body = () => (onFoot ? man : car) // what the camera follows and the jobs measure from

  // ---------------------------------------------------------------- camera
  function fitCamera() {
    pcam.aspect = innerWidth / innerHeight
    pcam.updateProjectionMatrix()
  }
  const chaseFov = () => (innerWidth < innerHeight ? 72 : onFoot ? 62 : 58)
  function chasePose(dt, snap) {
    const k = snap ? 1 : 1 - Math.exp(-(onFoot ? 4 : 3.2) * dt), P = body()
    if (onFoot || Math.abs(car.speed) > 0.5 || snap) chase.yaw += wrap(P.yaw - chase.yaw) * k
    const fx = fwdX(chase.yaw), fy = fwdY(chase.yaw), sp = Math.max(0, P.speed)
    const back = onFoot ? 4.3 + sp * 0.18 : 8.6 + sp * 0.14, up = onFoot ? 1.9 + sp * 0.06 : 4.3 + sp * 0.05
    const bx = P.x - fx * back, by = P.y - fy * back
    const gy = Math.max(city.world.heightAt(bx, -by) + (onFoot ? 1.2 : 1.4), P.h + up)
    v3.set(bx, gy, -by)
    if (snap) chase.pos.copy(v3); else chase.pos.lerp(v3, 1 - Math.exp(-7 * dt))
    // keep the camera out of buildings, every frame and after the smoothing (so it never glides through a wall):
    // on the line from the player to the camera, stop short of the first wall; then step off walls beside it
    const cx = chase.pos.x, cy = -chase.pos.z, k0 = wallHit(P.x, P.y, cx, cy)
    if (k0 < 1) {
      const len = Math.hypot(cx - P.x, cy - P.y) || 1, k = Math.max(0, k0 - 0.7 / len)
      chase.pos.x = P.x + (cx - P.x) * k; chase.pos.z = -(P.y + (cy - P.y) * k)
    }
    const side = collide(chase.pos.x, -chase.pos.z, 0.6)
    if (side) { chase.pos.x += side.x; chase.pos.z -= side.y }
    // the near plane comes in when a wall is close, so it never cuts through one
    const wall = collide(chase.pos.x, -chase.pos.z, 2.5)
    chase.near = wall ? clamp((2.5 - Math.hypot(wall.x, wall.y)) * 0.6, 0.2, nearPlane()) : nearPlane()
    const ahead = onFoot ? 3 : 6
    v4.set(P.x + fwdX(P.yaw) * ahead, P.h + (onFoot ? 1.3 : 1.0), -(P.y + fwdY(P.yaw) * ahead))
    if (snap) chase.look.copy(v4); else chase.look.lerp(v4, 1 - Math.exp(-10 * dt))
  }
  // near and far as tight as the view allows (the ground layers are only centimetres apart): near 1 m behind the van,
  // 0.5 m on foot; far just past the fog, where everything has faded into the sky anyway
  const nearPlane = () => (onFoot ? 0.5 : 1.0)
  // the dive: from a nearly orthographic long lens over the map down to the chase camera (e: 0 map .. 1 chase)
  const nd = new THREE.Vector3()
  function pose(e) {
    const b = { look: chase.look, dir: nd.copy(chase.pos).sub(chase.look).normalize(), H: 2 * chase.pos.distanceTo(chase.look) * Math.tan((chaseFov() * Math.PI) / 360), fov: chaseFov() }
    const [S, E, k] = state === 'out' ? [mapPose, fromPose, 1 - e] : [mapPose, b, e]
    const ek = EASE(k)
    const look = v3.copy(S.look).lerp(E.look, ek)
    const dir = v4.copy(S.dir).lerp(E.dir, ek).normalize()
    const H = Math.exp(Math.log(S.H) + (Math.log(E.H) - Math.log(S.H)) * ek)
    const fov = S.fov + (E.fov - S.fov) * smooth(0.3, 1, ek)
    const dist = H / 2 / Math.tan((fov * Math.PI) / 360)
    pcam.fov = fov
    atmosphere(smooth(0.55, 1, ek))
    pcam.near = Math.max(nearPlane(), dist * 0.04); pcam.far = dist + 4000 + (fogFar + 60 - 4000) * smooth(0.6, 1, ek)
    pcam.updateProjectionMatrix()
    pcam.position.copy(look).addScaledVector(dir, dist)
    pcam.up.set(0, 1, 0); pcam.lookAt(look)
    opts.focus.copy(look)
    const half = (H / 2) * Math.max(1, pcam.aspect)
    opts.radius = clamp(half * 1.5, 900, 8000)
    opts.shadowRadius = clamp(half * 1.9, 300, 6000)
  }

  // ---------------------------------------------------------------- sky and fog from the time of day and weather
  const skyTex = (() => { const c = document.createElement('canvas'); c.width = 2; c.height = 128; const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.cv = c; return t })()
  const fog = new THREE.Fog(0xcfe0ea, 120, 850)
  const ca = new THREE.Color(), cb = new THREE.Color(), cc = new THREE.Color()
  let skyKey = ''
  const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hourCycle: 'h23', hour: 'numeric', minute: 'numeric' })
  function hourNow() { // the weather plugin's hour (it may be set by hand), else the time in Vancouver
    if (city.weather?.hour != null) return city.weather.hour
    const p = Object.fromEntries(clockFmt.formatToParts(new Date()).map((x) => [x.type, x.value]))
    return +p.hour + p.minute / 60
  }
  function atmosphere(k) { // k: 0 map look (no fog) .. 1 street look
    // the weather plugin publishes the street-level look (sky and fog for the weather and time of day); without it, a fair day
    const w = city.weather || {}, A = w.atmosphere || { horizon: 0xcfe2ec, zenith: 0x84b7dc, fogNear: 140, fogFar: 850 }
    ca.setHex(A.horizon); cb.setHex(A.zenith)
    fogFar = A.fogFar + 13000 * vista
    // blend in from the map look: far fog first, the haze settles as the camera reaches the street
    const D = pcam.position.distanceTo(opts.focus)
    fog.color.copy(ca)
    fog.near = A.fogNear + 3500 * vista + (D * 4 + 2000) * (1 - k); fog.far = fogFar + (D * 8 + 4000) * (1 - k)
    city.scene.fog = fog // from the start of the dive (far away at first), so materials switch to fog only once
    const key = `${ca.getHexString()}${cb.getHexString()}${k.toFixed(2)}`
    if (key !== skyKey) {
      skyKey = key
      const g = skyTex.cv.getContext('2d'), bg = (saved.bg?.isColor ? saved.bg : cc.set(0x0e1620)).getStyle()
      const gr = g.createLinearGradient(0, 0, 0, 128)
      gr.addColorStop(0, cb.getStyle()); gr.addColorStop(0.55, ca.getStyle()); gr.addColorStop(1, ca.getStyle())
      g.globalAlpha = 1; g.fillStyle = bg; g.fillRect(0, 0, 2, 128)
      g.globalAlpha = k; g.fillStyle = gr; g.fillRect(0, 0, 2, 128)
      skyTex.needsUpdate = true
    }
    city.scene.background = skyTex
    const lights = city.light.night > 0.35 || ['storm', 'fog', 'rain'].includes(w.kind)
    van.userData.lights[0].emissiveIntensity = lights ? 1.6 : 0.5
    van.userData.lights[1].emissiveIntensity = lights ? 1.2 : 0.4
    van.userData.night.value = walker.userData.night.value = city.light.night
    pool.visible = !!lights && k > 0.9 && hasVan
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
  function hitTraffic(o, impact) {
    if (o.mp) return
    try { city.traffic?.bump?.(o.id, impact) } catch (e) { console.warn('drive: traffic.bump', e) }
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
    const fx = fwdX(car.yaw), fy = fwdY(car.yaw)
    const me = { x: car.x, y: car.y, fx, fy, hl: VAN_L, hw: VAN_W }
    for (const o of others(car.x, car.y, 14)) {
      const b = otherBox(o), c = boxBox(me, b)
      if (!c) continue
      car.x += c.nx * c.depth; car.y += c.ny * c.depth; me.x = car.x; me.y = car.y
      // off a heavy moving wall: the van's velocity relative to it, reflected
      const vn = bounce(c.nx, c.ny, b.fx * (o.speed || 0), b.fy * (o.speed || 0), 0.35, clamp((b.x - car.x) * fx + (b.y - car.y) * fy, -VAN_L, VAN_L))
      if (vn) bumped(vn, () => hitTraffic(o, vn))
    }
  }
  // poles, posts, trunks (circles at (x, y) of radius r) against the van's box: pushed out, bounced off
  function carVsPost(x, y, r, metal) {
    const fx = fwdX(car.yaw), fy = fwdY(car.yaw), q = circleBox(x, y, r, car.x, car.y, fx, fy, VAN_L, VAN_W)
    if (!q) return
    car.x -= q.x; car.y -= q.y
    const l = Math.hypot(q.x, q.y) || 1, vn = bounce(-q.x / l, -q.y / l, 0, 0, 0.2, clamp((x - car.x) * fx + (y - car.y) * fy, -VAN_L, VAN_L))
    if (vn > 1) bumped(vn, metal && vn > 2 ? sfx.clank : null)
  }
  // people: a nudge at a crawl (they're in the way: the van waits), else they stumble or fall over (and get up)
  function carVsPeople(now) {
    if (car.parked) return // people walk round a parked van
    const ppl = people(car.x, car.y, 7)
    if (!ppl.length) return
    const fx = fwdX(car.yaw), fy = fwdY(car.yaw), sp = Math.abs(car.speed)
    for (const p of ppl) {
      const px = p.x, py = -p.z
      if (Math.abs(p.y - car.h) > 3) continue // on another level (a bridge above, the street below)
      const q = circleBox(px, py, 0.28, car.x, car.y, fx, fy, VAN_L, VAN_W)
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
    }
  }
  function startled(sp) {
    if (deliver) {
      shift.people++
      if (run) for (const p of run.parcels) if (p.aboard && !p.done) p.bumps += 3
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
    if (!onFoot) jolt(car, clamp(impact / 8, 0.1, 0.8), 0, 0)
    if (run && !onFoot && impact > 2) { shift.bumps++; for (const p of run.parcels) if (p.aboard && !p.done) p.bumps += impact > 6 ? 2 : 1 }
    fn?.()
  }
  function publishPlayer(emit) { // city.player (player-contract): where the user is, read by others every frame
    const P = body()
    if (state === 'off' || state === 'pick') { if (city.player) { city.player = null; city.emit('player', null) } return }
    const p = city.player || (city.player = { vehicle: 'van', colour: COLOUR })
    p.mode = onFoot ? 'foot' : 'car'; p.x = P.x; p.y = P.h; p.z = -P.y; p.heading = wrap(P.yaw + Math.PI); p.speed = P.speed
    if (emit) city.emit('player', p)
  }
  function publish() { // the van and the walker as obstacles the simulated cars brake for
    publishPlayer(false)
    const T = traffic()
    if (!T?.setObstacle) return
    if (hasVan) T.setObstacle('player-van', { x: car.x, y: car.h, z: -car.y, heading: wrap(car.yaw + Math.PI), length: 4.3, width: 1.8, speed: onFoot ? 0 : Math.abs(car.speed) })
    T.setObstacle('player-walker', onFoot ? { x: man.x, z: -man.y, heading: wrap(man.yaw + Math.PI), length: 0.6, width: 0.6, speed: Math.abs(man.speed) } : null)
  }

  // ---------------------------------------------------------------- driving
  // the surface under (x, north): a bridge deck when the van is on one, else the ground; y = height of the road top
  // near a deck's end (where it meets the street, often a few metres off the terrain) the van may step up or down
  function surface(x, y, curY) {
    const g = city.world.heightAt(x, -y) + 0.2
    const r = nearestRoad(x, y, 16, true)
    if (!r) return { y: g, deck: false, end: false }
    const P = r.s.p.pts, m = P.length - 2, end = Math.min(Math.hypot(x - P[0], y - P[1]), Math.hypot(x - P[m], y - P[m + 1])) < 25
    const dz = r.z + 0.58
    if (r.d < 1.2 && Math.abs(dz - curY) < (end ? 7 : 2.6)) return { y: Math.max(g, dz), deck: dz - g > 1.2, end }
    return { y: g, deck: false, end }
  }
  const roadAt = (x, y, h) => { const r = nearestRoad(x, y, 2); return !!r && r.d < 0.5 && (r.z == null ? h - (city.world.heightAt(x, -y) + 0.2) < 3 : Math.abs(r.z + 0.58 - h) < 3) }
  function input() {
    const L = keys.has('ArrowLeft') || keys.has('KeyA') || touchState.left, R = keys.has('ArrowRight') || keys.has('KeyD') || touchState.right
    const up = keys.has('ArrowUp') || keys.has('KeyW') || touchState.gas, dn = keys.has('ArrowDown') || keys.has('KeyS') || (!onFoot && touchState.brake)
    return { steer: (L ? 1 : 0) - (R ? 1 : 0), up: up || (onFoot && touchState.brake), down: dn, hand: keys.has('Space'), run: keys.has('ShiftLeft') || keys.has('ShiftRight') || (onFoot && touchState.brake) }
  }
  // tyres grip less in the rain and much less in snow (the weather plugin's city.surface), a little less off the tarmac
  const gripNow = () => clamp(1 - 0.3 * (city.surface?.wet || 0) - 0.8 * (city.surface?.snow || 0), 0.3, 1) * (car.kerb ? 1 : 0.9)
  const vin = { up: false, down: false, steer: 0, hand: false }
  function drive(dt, I) {
    // Lane assist: with no steering, a gentle steer along the road the van is on
    let steer = I.steer
    if (assist && !steer && car.speed > 2.5 && !car.parked) {
      const r = nearestRoad(car.x, car.y, 3)
      if (r && r.d < 0.5) {
        let d = wrap(yawFromDir(r.dir) - car.yaw)
        if (Math.abs(d) > Math.PI / 2) d = wrap(d + Math.PI)
        if (Math.abs(d) < 0.4) steer = clamp(d * 2.2, -0.6, 0.6)
      }
    }
    vin.up = I.up; vin.down = I.down; vin.steer = steer; vin.hand = I.hand
    grip = gripNow()
    stepVan(car, dt, vin, grip)
    // move, then resolve: water stops the van softly, bridge railings and buildings bounce it
    const fx = fwdX(car.yaw), fy = fwdY(car.yaw), vx = fx * car.speed + fy * car.lat, vy = fy * car.speed - fx * car.lat
    let nx = car.x + vx * dt, ny = car.y + vy * dt
    const blocked = (x, y) => {
      const s = surface(x, y, car.h)
      if (car.deck && !s.deck && car.h - s.y > 2 && !s.end) return 'edge'
      const ax = x + fx * Math.sign(car.speed || 1) * 2, ay = y + fy * Math.sign(car.speed || 1) * 2
      if (!s.deck && isWater(ax, ay) && !roadAt(ax, ay, car.h)) return 'water'
      return null
    }
    const why = (nx !== car.x || ny !== car.y) && blocked(nx, ny)
    if (why === 'edge') { // the railing: back towards the middle of the deck
      const r = nearestRoad(car.x, car.y, 16, true), l = r ? Math.hypot(r.px - car.x, r.py - car.y) : 0
      if (l > 0.01) { const vn = bounce((r.px - car.x) / l, (r.py - car.y) / l, 0, 0, 0.25, 0); if (vn > 1.5) bumped(vn, vn > 3 ? sfx.clank : null) } else car.speed *= 0.5
      nx = car.x; ny = car.y
    } else if (why) {
      if (!blocked(nx, car.y)) ny = car.y
      else if (!blocked(car.x, ny)) nx = car.x
      else { nx = car.x; ny = car.y }
      if (Math.abs(car.speed) > 3) sfx.splash()
      car.speed *= 0.6; car.lat *= 0.6
    }
    if (run) shift.km += Math.hypot(nx - car.x, ny - car.y) / 1000
    car.x = nx; car.y = ny
    for (const off of [1.45, 0, -1.45]) { // buildings: three circles along the van
      const cx = car.x + fx * off, cy = car.y + fy * off, p = collide(cx, cy, 1.05)
      if (!p) continue
      car.x += p.x; car.y += p.y
      const l = Math.hypot(p.x, p.y) || 1, vn = bounce(p.x / l, p.y / l, 0, 0, 0.15, off)
      if (vn > 2.5) bumped(vn)
    }
    carVsTraffic()
    // street furniture, trunks, bollards, signal poles; then people
    propsNear(car.x, car.y, 3.2, (x, y, r, kind) => carVsPost(x, y, r, kind !== 0))
    for (const o of poles(car.x, car.y, 6)) if (Math.abs(o.y - car.h) < 4) carVsPost(o.x, -o.z, o.r, true)
    carVsPeople(performance.now())
    kerbs()
    // stand on the surface: height from the middle, pitch and roll from the wheels
    const s = surface(car.x, car.y, car.h)
    car.deck = s.deck
    car.h += (s.y - car.h) * (1 - Math.exp(-18 * dt))
    const near = (v) => (Math.abs(v - car.h) < 1.5 ? v : car.h) // a wheel over a deck edge or a kerb drop doesn't tip the van
    const f = near(surface(car.x + fx * 1.35, car.y + fy * 1.35, car.h).y), b = near(surface(car.x - fx * 1.35, car.y - fy * 1.35, car.h).y)
    const rx = Math.cos(car.yaw), ry = Math.sin(car.yaw) // right in (x, north)
    const l = city.world.heightAt(car.x - rx * 0.85, -(car.y - ry * 0.85)), r = city.world.heightAt(car.x + rx * 0.85, -(car.y + ry * 0.85))
    car.pitch += (Math.atan2(f - b, 2.7) - car.pitch) * (1 - Math.exp(-10 * dt))
    car.roll += ((car.deck ? 0 : Math.atan2(near(r + 0.2) - near(l + 0.2), 1.7)) - car.roll) * (1 - Math.exp(-10 * dt))
    car.spin += (car.speed * dt) / 0.36
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
    sfx.kerb(k); buzz(Math.round(10 + 25 * k))
    car.speed *= sp > 8 ? 0.93 : 0.97
    if (run && sp > 4) { shift.kerbs++; for (const p of run.parcels) if (p.aboard && !p.done) p.bumps += 0.5 }
  }
  function engineNote() {
    if (!engine || muted) return
    const t = ac.currentTime
    if (onFoot) { engine.g.gain.setTargetAtTime(hasVan && !hike ? 0.006 : 0, t, 0.3); return } // idling at the kerb
    // a four-cylinder: two pulses a turn, the filter opening with the throttle
    const f = (car.rpm / 60) * 2
    engine.o1.frequency.setTargetAtTime(f, t, 0.05); engine.o2.frequency.setTargetAtTime(f * 2.01, t, 0.05)
    engine.lp.frequency.setTargetAtTime(170 + car.rpm * 0.06 + car.thr * 260, t, 0.08)
    engine.g.gain.setTargetAtTime(0.014 + car.thr * 0.02 + (car.rpm - 850) / 5000 * 0.012, t, 0.1)
  }

  // ---------------------------------------------------------------- walking
  // the surface under a walker: the ground, or a bridge deck (its sidewalks too) when already up on it
  function footSurface(x, y, curY) {
    const g = city.world.heightAt(x, -y) + 0.15
    const r = nearestRoad(x, y, 16, true, true)
    if (!r) return { y: g, deck: false }
    const dz = r.z + 0.5, reach = r.s.p.band ? 5 : 1
    if (r.d < reach && Math.abs(dz - curY) < 2.2) return { y: Math.max(g, dz), deck: dz - g > 1.2 }
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
    man.run = I.run && !(hike && man.winded)
    const tr = hike ? nearestRoad(man.x, man.y, 4, false, true) : null, onTrail = !!tr && tr.d < 0.8
    const target = hike ? hikeSpeed(dt, I, onTrail) : I.up ? (I.run ? RUN : WALK) : I.down ? -WALK * 0.6 : 0
    man.speed += (target - man.speed) * (1 - Math.exp(-(target ? 6 : 10) * dt))
    if (Math.abs(man.speed) < 0.02 && !target) man.speed = 0
    man.yaw += I.steer * (I.run ? 2.2 : 2.8) * dt
    // the trail leads: walking on with nothing steered, turn towards the trail a few metres ahead (round switchbacks)
    if (hike && onTrail && !I.steer && man.speed > 0.3) {
      const a = nearestRoad(man.x + fwdX(man.yaw) * 2.6, man.y + fwdY(man.yaw) * 2.6, 4, false, true)
      if (a && a.dist > 0.3) {
        const d = wrap(yawFromDir(Math.atan2(a.py - man.y, a.px - man.x)) - man.yaw)
        if (Math.abs(d) < 1.4) man.yaw += d * Math.min(1, 3 * dt)
      }
    }
    const fx = fwdX(man.yaw), fy = fwdY(man.yaw)
    let nx = man.x + fx * man.speed * dt, ny = man.y + fy * man.speed * dt
    // water: only where a deck or a path goes over it
    const wet = (x, y) => isWater(x, y) && !footSurface(x, y, man.h).deck && !(nearestRoad(x, y, 6, false, true)?.d < 0.6)
    if ((nx !== man.x || ny !== man.y) && wet(nx + fx * 0.4, ny + fy * 0.4)) {
      if (!wet(nx + fx * 0.4, man.y)) ny = man.y; else if (!wet(man.x, ny + fy * 0.4)) nx = man.x; else { nx = man.x; ny = man.y }
    }
    man.x = nx; man.y = ny
    // buildings, the parked van, posts and trunks (not the ones a trail runs through), signal poles, people, cars
    const p = collide(man.x, man.y, 0.32)
    if (p) { man.x += p.x; man.y += p.y }
    if (hasVan) { const q = circleBox(man.x, man.y, 0.32, car.x, car.y, fwdX(car.yaw), fwdY(car.yaw), VAN_L, VAN_W); if (q) { man.x += q.x; man.y += q.y } }
    propsNear(man.x, man.y, 1, (x, y, r, kind) => { if (!(kind === 0 && onTrail)) push(x, y, r) })
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
    man.h += (s.y - man.h) * (1 - Math.exp(-14 * dt))
    man.phase += dt * Math.abs(man.speed) * (man.run ? 2.3 : 3.6)
  }
  // the walker (radius 0.32) out of a circle at (x, y) of radius r: true if it touched
  function push(x, y, r) {
    const dx = man.x - x, dy = man.y - y, d = Math.hypot(dx, dy), m = r + 0.32
    if (d >= m) return false
    const k = (m - d) / (d || 1)
    man.x += (d ? dx : 1) * k; man.y += dy * k
    return true
  }
  // E: in and out of the van
  function nearVan() { return hasVan && onFoot && !man.board && !errand && Math.hypot(man.x - car.x, man.y - car.y) < 7 }
  function canGetOut() { return !onFoot && Math.abs(car.speed) < 1.5 }
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
      van.position.set(car.x, car.h - 0.02 + car.hz, -car.y)
      van.rotation.set(0, 0, 0)
      van.rotateY(car.yaw); van.rotateX(car.pitch + car.bp); van.rotateZ(car.roll + car.br)
      for (const w of van.userData.wheels) { w.spin.rotation.x = -car.spin; if (w.front) w.steer.rotation.y = car.steer }
      blob.position.set(car.x, car.h + 0.06, -car.y); blob.rotation.set(0, car.yaw, 0)
      pool.position.copy(blob.position); pool.rotation.copy(blob.rotation)
    }
    if (walker.visible) {
      walker.position.set(man.x, man.h - 0.05, -man.y)
      walker.rotation.set(0, man.yaw, 0)
      poseWalker(walker, man.phase, clamp(Math.abs(man.speed) / WALK, 0, 1), (man.run || !!errand) && Math.abs(man.speed) > WALK + 0.3, carried.visible)
      wblob.position.set(man.x, man.h + 0.03, -man.y)
    }
  }
  function resetToRoad() {
    const r = nearestRoad(car.x, car.y, 300)
    if (!r) return
    let yaw = yawFromDir(r.dir)
    if (Math.abs(wrap(yaw - car.yaw)) > Math.PI / 2) yaw = wrap(yaw + Math.PI)
    Object.assign(car, { x: r.px, y: r.py, yaw, speed: 0, lat: 0, steer: 0, kick: 0, gear: 1 })
    car.h = r.z != null ? r.z + 0.58 : city.world.heightAt(r.px, -r.py) + 0.2
    car.deck = r.z != null
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
    each(x, y, r1, (b) => {
      if (!b.fp) return
      for (let r = 0; r < b.fp.start.length - 1; r++) {
        const w = b.bb[r * 4 + 2] - b.bb[r * 4], h = b.bb[r * 4 + 3] - b.bb[r * 4 + 1], cx = b.bb[r * 4] + w / 2, cy = b.bb[r * 4 + 1] + h / 2
        if (w * h < 45 || w * h > 4000) continue
        const d = Math.hypot(cx - x, cy - y)
        if (d >= r0 && d <= r1) found.push({ x: cx, y: cy, area: w * h })
      }
    })
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
  const someone = () => `${pick(FIRST)} ${pick(LAST)}`
  // A run: a real shop near you with one to three parcels ready, each for a door 200-900 m from the shop. Drive to
  // the shop (stop at the kerb: the courier fetches them), then to the doors in any order (the compass points to the
  // nearest); when the van is empty the next run starts near the last door.
  const FRAGILE = /fragile|cake|teapot|level|vinyl|record|lemon|monstera|latte/
  function newRun() {
    const P = body()
    for (const [r0, r1] of [[120, 700], [80, 1500]]) {
      const shops = placesNear(P.x, P.y, r0, r1)
      for (let k = 0; k < 14 && shops.length; k++) {
        const p = shops.splice(Math.floor(Math.random() * shops.length), 1)[0], s = stopFor(p.x, p.y)
        if (!s) continue
        const want = 1 + (Math.random() < 0.5 ? 1 : 0) + (Math.random() < 0.25 ? 1 : 0), parcels = []
        for (let i = 0; i < want * 3 && parcels.length < want; i++) {
          const to = address(p.x, p.y, 200, 900)
          if (!to || parcels.some((q) => Math.hypot(q.to.x - to.x, q.to.y - to.y) < 40)) continue
          to.who = someone()
          const item = ITEMS[p.kind] && Math.random() < 0.75 ? pick(ITEMS[p.kind]) : pick(PARCELS)
          parcels.push({ to, item, who: to.who, aboard: false, done: false, bumps: 0, fragile: FRAGILE.test(item), dist: Math.hypot(to.x - s.x, to.y - s.y), t0: 0, limit: 0 })
        }
        if (!parcels.length) continue
        run = { shop: { ...s, label: p.name, sub: p.addr ? abbr(p.addr) : p.kind, kind: p.kind, sx: p.x, sy: p.y }, parcels, stage: 'pickup', cur: null }
        aim()
        return true
      }
    }
    return false
  }
  // where to now: the shop, else the nearest door with a parcel for it
  function aim() {
    const P = body()
    if (run.stage === 'pickup') { run.cur = null; setGoal(run.shop.x, run.shop.y, 0xffb05c, icons.pickup); return }
    let best = null
    for (const p of run.parcels) if (!p.done && (!best || Math.hypot(p.to.x - P.x, p.to.y - P.y) < Math.hypot(best.to.x - P.x, best.to.y - P.y))) best = p
    run.cur = best
    if (best) setGoal(best.to.x, best.to.y, 0x5fd6c4, icons.drop)
  }
  function target() { return run && (run.stage === 'pickup' ? run.shop : run.cur?.to) }
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
  // at the shop: fetch the parcels from its door to the back of the van
  function pickedUp() {
    const now = performance.now(), n = run.parcels.length
    run.parcels.sort((a, b) => a.dist - b.dist)
    run.parcels.forEach((p, i) => { p.aboard = true; p.t0 = now; p.limit = (p.dist * 1.35 + 260 * i) / 7 + 70 })
    run.stage = 'drop'
    shift.shops.add(run.shop.label)
    sfx.pickup(); buzz(30)
    popup('Picked up!', n === 1 ? `${cap(run.parcels[0].item)} for ${run.parcels[0].who}` : `${n} parcels from ${run.shop.label}: ${run.parcels.map((p) => p.who.split(' ')[0]).join(', ')}`)
    aim()
  }
  // at a door: paid, a base for the distance, a tip for being quick and for being gentle with it
  function delivered(p) {
    const used = (performance.now() - p.t0) / 1000, left = Math.max(0, p.limit - used)
    const care = Math.max(0.15, 1 - 0.16 * p.bumps * (p.fragile ? 1.6 : 1))
    const tip = Math.round(Math.max(0.5, (left > 0 ? 2.5 + 6 * (left / p.limit) : 1.2) * care) * 100) / 100
    const pay = Math.round((6 + (p.dist / 1000) * 5 + tip) * 100) / 100
    p.done = true
    shift.n++; shift.money += pay; shift.tips += tip
    if (!shift.best || tip > shift.best.tip) shift.best = { tip, who: p.who }
    sfx.deliver(); buzz([30, 70, 30, 70, 60])
    popup(`+$${pay.toFixed(2)}`, `${p.who.split(' ')[0]}: ${care < 0.6 ? 'It’s a bit rattled, but thanks!' : pick(THANKS)} (tip $${tip.toFixed(2)})`)
    if (run.parcels.every((q) => q.done)) { run = null; hideMarkers(); jobRetry = performance.now() + 2500 } else aim()
  }
  const cap = (s) => s[0].toUpperCase() + s.slice(1)
  // the van has stopped at the target (or the courier walked up to it)
  function arrive() {
    const t = target()
    if (onFoot) { // walked there: hand it over (or pick up) right away
      if (run.stage === 'pickup') { carried.visible = true; pickedUp() } else { carried.visible = false; delivered(run.cur) }
      return
    }
    if (run.stage === 'pickup') {
      const d = doorFor(run.shop.sx, run.shop.sy), b = backDoors()
      if (!startErrand([{ x: d.x, y: d.y, pause: 1.1, then: () => { carried.visible = true; sfx.knock() } }, { x: b.x, y: b.y, pause: 0.5, then: () => { carried.visible = false; pickedUp() } }])) pickedUp()
    } else {
      const p = run.cur, d = doorFor(p.to.house?.x ?? t.x, p.to.house?.y ?? t.y), b = backDoors()
      if (!startErrand([{ x: b.x, y: b.y, pause: 0.6, then: () => { carried.visible = true } }, { x: d.x, y: d.y, pause: 1.2, then: () => { carried.visible = false; sfx.knock(); delivered(p) } }])) delivered(p)
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
    hike.photo = { t0: now, shot: false, secs, best: best && prev, from: chase.pos.clone(), look: chase.look.clone(), h: man.h, spot }
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
    ui.photo.innerHTML = `<div class="t">${escape(hike.name)}</div><div class="s">${escape(cap(hike.goal))} · ${Math.round(F.h)} m${hike.climb > 20 ? ` · climbed ${Math.round(hike.climb)} m` : ''}${F.secs ? ` · ${mmss(F.secs)}${F.best ? ' · a new best!' : ''}` : ''}</div>
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
        if (deliver) ui.co.hidden = false; else if (!hike) ui.read.hidden = false
        ui.touch.hidden = false
        showHelp()
        if (!onFoot) assistHint()
        const g = gripNow()
        if (!onFoot && g < 0.8) city.ui.toast(g < 0.6 ? 'Snow on the roads: gentle on the pedals, the van slides and takes a long way to stop.' : 'Wet roads: leave a little more room to stop.', 5000)
        hudAt = 0
      }
      return
    }
    if (state !== 'play' || !(dt > 0)) return
    dt = Math.min(dt, 0.05)
    const I = ui.sheet.hidden ? input() : { steer: 0, up: false, down: false, hand: false, run: false }
    if (onFoot) { walk(dt, I); if (hasVan) drive(dt, { steer: 0, up: false, down: false, hand: true }) } else drive(dt, I)
    engineNote()
    publish()
    place()
    chasePose(dt)
    const fov = chaseFov(), near = chase.near ?? nearPlane(), far = fogFar + 60
    if (pcam.fov !== fov || pcam.near !== near || pcam.far !== far) { pcam.fov = fov; pcam.near = near; pcam.far = far; pcam.updateProjectionMatrix() }
    pcam.position.copy(chase.pos)
    if (shake > 0.001) { pcam.position.x += (Math.random() - 0.5) * shake; pcam.position.y += (Math.random() - 0.5) * shake; shake *= Math.exp(-10 * dt) }
    pcam.up.set(0, 1, 0); pcam.lookAt(chase.look)
    const P = body(), ahead = onFoot ? 60 : 180
    opts.focus.set(P.x + fwdX(P.yaw) * ahead, P.h, -(P.y + fwdY(P.yaw) * ahead))
    opts.radius = 900; opts.shadowRadius = 300
    // the street furniture near the player, redrawn every dozen metres
    if (!kerbsAt || Math.hypot(P.x - kerbsAt.x, P.y - kerbsAt.y) > 15) { // the kerbs within 160 m, every 15 m
      kerbsAt = { x: P.x, y: P.y }
      lips.update(infos.values(), P.x, P.y, 160, (x, z) => city.world.heightAt(x, z))
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
    if (deliver) {
      if (!run && now > jobRetry) { if (!newRun()) jobRetry = now + 1000 }
      t = target()
      if (t && !errand && !man.board && Math.hypot(t.x - P.x, t.y - P.y) < (onFoot ? ARRIVE_FOOT : ARRIVE + t.w / 2) && (onFoot || Math.abs(car.speed) < 1.2)) { arrive(); t = target() }
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
      goal.icon.position.set(goal.x, goal.gy + 4.2 + Math.sin(time * 2) * 0.35, -goal.y); goal.icon.rotation.y = time * 1.2
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
  function hud(t) {
    // E to get in or out (or to hurry an errand along)
    const can = errand ? 'Hurry' : nearVan() ? 'Get in' : canGetOut() ? 'Get out' : ''
    ui.tact.hidden = !can; ui.tact.textContent = can
    ui.act.hidden = touchy || !(nearVan() || errand || (run && t && !onFoot && Math.abs(car.speed) >= 1.2 && Math.hypot(t.x - car.x, t.y - car.y) < ARRIVE + 8))
    ui.act.innerHTML = errand ? '<kbd>E</kbd>Hurry up' : nearVan() ? '<kbd>E</kbd>Get in the van' : 'Stop here'
    ui.brk.textContent = onFoot ? (hike ? 'Push' : 'Run') : 'Brake'
    ui.assist.hidden = onFoot // it steers the van only
    document.documentElement.classList.toggle('dlv-assist', !onFoot)
    const P = body(), name = street ? abbr(street.name) : ''
    ui.stam.hidden = !hike; ui.aboard.hidden = !deliver
    if (!deliver && !hike) {
      const sp = Math.abs(P.speed) * 3.6, gear = onFoot ? '' : ` · ${car.gear < 0 ? 'R' : `D${car.gear}`}`
      ui.read.innerHTML = `<b>${Math.round(sp)}</b> km/h${gear}${name ? ` · ${escape(name)}` : ''}`
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
    ui.n.textContent = String(shift.n)
    ui.m.textContent = `$${shift.money.toFixed(2)}`
    const h = hourNow(), hh = Math.floor(h), mm = Math.floor((h - hh) * 60)
    ui.c.textContent = `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`
    if (!t) {
      ui.arrow.style.opacity = 0.3
      ui.w.textContent = 'Next up'; ui.s.textContent = name ? `on ${name}` : ''; ui.d.textContent = ''; ui.t.textContent = ''; ui.aboard.textContent = ''
      ui.p.textContent = shift.n ? 'Checking the order board…' : 'Finding your first pickup…'
      return
    }
    const pickup = run.stage === 'pickup', n = run.parcels.length, left = run.parcels.filter((p) => !p.done)
    ui.w.textContent = pickup ? `Pick up ${n === 1 ? 'a parcel' : `${n} parcels`} at` : `Deliver ${run.cur.item}`
    ui.p.textContent = t.label
    ui.s.textContent = pickup ? t.sub || '' : `for ${run.cur.who}${run.cur.fragile ? ' · handle with care' : ''}`
    ui.aboard.textContent = pickup ? `For ${run.parcels.map((p) => p.who.split(' ')[0]).join(', ')}` : left.length > 1 ? `Also aboard: ${left.filter((p) => p !== run.cur).map((p) => `${p.who.split(' ')[0]} (${p.to.label})`).join(', ')}` : 'Last one in the van'
    ui.d.textContent = `${dist(Math.hypot(t.x - P.x, t.y - P.y))} away`
    if (pickup) { ui.t.textContent = errand ? 'fetching…' : 'stop at the kerb'; ui.t.className = '' } else {
      const rem = run.cur.limit - (performance.now() - run.cur.t0) / 1000
      ui.t.textContent = rem > 0 ? `${mmss(rem)} for a good tip` : 'running late, no worries'
      ui.t.className = rem > 0 ? '' : 'late'
    }
    compass(t)
  }
  const dist = (d) => (d > 950 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`)
  function compass(t) { // the target's bearing and north, relative to where the camera looks
    const P = body(), cy = Math.atan2(chase.look.x - chase.pos.x, -(chase.look.z - chase.pos.z))
    ui.arrow.style.opacity = t ? 1 : 0.3
    if (t) ui.arrow.style.transform = `rotate(${wrap(Math.atan2(t.x - P.x, t.y - P.y) - cy)}rad)`
    ui.north.style.transform = `rotate(${wrap(-cy)}rad)`
  }
  const escape = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

  // ---------------------------------------------------------------- keys
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable
  const CONTROL = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'])
  function onKey(e) {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
    if (state === 'off') { if (e.code === 'KeyD' && !e.repeat && !e.shiftKey) startPick('deliver'); return }
    if (e.code === 'Escape') { exit(!ui.sheet.hidden); return }
    if (state !== 'play') return
    if (CONTROL.has(e.code)) { keys.add(e.code); e.preventDefault() }
    if (e.repeat) return
    if (e.code === 'KeyE') { if (errand) hurry(); else toggleFoot() }
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
  if (location.search.includes('drivedebug')) window.driveDebug = { car, man, goal, get run() { return run }, get hike() { return hike }, get errand() { return errand }, get shift() { return shift }, get state() { return state }, startHike: (id) => startHike(HIKES.find((h) => h.id === id)), propsNear, nearestRoad, wallHit }
  return {
    dispose() {
      cancelPick()
      if (state !== 'off') { traffic()?.setObstacle('player-van', null); traffic()?.setObstacle('player-walker', null); state = 'out'; finish() }
      for (const f of offTiles) f()
      removeEventListener('keydown', onKey); removeEventListener('keyup', onKeyUp); removeEventListener('blur', onBlur); removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVis)
      button.remove()
      if (city.models?.van) { delete city.models.van; delete city.models.person }
      for (const e of ui.all) e.remove()
      ui.css.remove()
      ac?.close()
    },
  }
}
