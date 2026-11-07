// Drive: explore the real streets by van or on foot, or work a shift for the Salmonberry Parcel Co.
// The toolbar's "Drive" menu (or D for deliveries) asks for a spot on the map, then dives from the map into a
// third-person view there; Esc flies back. On foot you walk the sidewalks (E gets in and out of the van).
// Deliveries are made up on the fly around you from what is loaded: a building, the street in front of it,
// a Vancouver-style house number, a recipient and a parcel. No GPS: a compass arrow and the distance only.
// Data: roads, buildings and water from the map tiles; street names and named shops from OpenStreetMap
// (data/*.json, made by tools/delivery_places.py), © OpenStreetMap contributors, ODbL. Sounds are synthesised.
// Other cars come from city.traffic (the life plugin) when it is there: the van and the walker bump into them and
// are published as obstacles that they brake for. The player is published as city.player, with the van and the
// courier as city.models factories (see PLUGINS.md), and collides with other players through city.multiplayer.
import { makeVan } from './van.js'
import { makeWalker, poseWalker } from './walker.js'

const DRIVE_MAX_KIND = 7 // motorway .. living street (graph piece kinds): where a van belongs
const WALK_MAX_KIND = 12 // .. steps: where a person can walk (plus the sidewalks of roads)
const CELL = 32 // metres, spatial grid for roads and footprints
const WB = 2.7 // wheelbase
const MAX_SPEED = 17, MAX_REVERSE = 6 // m/s
const WALK = 1.6, RUN = 4.6 // m/s
const VAN_L = 2.2, VAN_W = 0.95 // half length / width for collisions
const ARRIVE = 9, ARRIVE_FOOT = 3.5 // metres from a marker that count as there
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
  function index(t) { // roads (drivable and walkable segments) and building footprints on a grid
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
    return { t, segs, rg, fg, fp, bb }
  }
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
    each(x, y, r, (b) => {
      const seen = new Set()
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
        for (const id of b.rg.get(ckey(cx, cy)) || []) {
          if (seen.has(id)) continue
          seen.add(id)
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
  // push a circle out of building footprints: returns the summed push (x, y) or null
  function collide(x, y, rad) {
    let px = 0, py = 0, hit = false
    each(x, y, rad, (b) => {
      if (!b.fp) return
      const seen = new Set()
      for (let cx = Math.floor((x - rad) / CELL); cx <= Math.floor((x + rad) / CELL); cx++) for (let cy = Math.floor((y - rad) / CELL); cy <= Math.floor((y + rad) / CELL); cy++) {
        for (const r of b.fg.get(ckey(cx, cy)) || []) {
          if (seen.has(r)) continue
          seen.add(r)
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
        fetch(new URL(`./data/${k}.json`, import.meta.url)).then((r) => r.json()).then((d) => cells.set(k, prepCell(d))).catch((e) => { console.warn('drive: no street names for', k, e); cells.set(k, { segs: [], name: [], grid: new Map(), names: [], places: [] }) })
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
    return { segs, name, grid, names: d.n, places }
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
  const icons = { pickup: parcelIcon(), drop: houseIcon() }
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
    horn() { if (!audio()) return; const t = ac.currentTime; tone(523, t, 0.16, 0.05, 'square'); tone(523, t + 0.2, 0.18, 0.05, 'square'); tone(659, t, 0.16, 0.03, 'square'); tone(659, t + 0.2, 0.18, 0.03, 'square') },
  }
  function setMuted(m) { muted = m; try { localStorage.setItem('delivery.muted', m ? '1' : '0') } catch {}; if (ac) ac.out.gain.value = m ? 0 : 1; ui.mute.textContent = m ? 'Sound off' : 'Sound on' }

  // ================================================================ HUD
  const touchy = matchMedia('(pointer: coarse)').matches
  const ui = makeUI()
  function makeUI() {
    const css = document.createElement('style')
    css.textContent = `
      .dlv { position: fixed; z-index: 25; font: 13px/1.35 system-ui, -apple-system, sans-serif; color: #fdf6ea; pointer-events: none; }
      .dlv[hidden] { display: none }
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
      .dlv-menu { display: grid; gap: 6px; }
      .dlv-menu button { display: flex; gap: 10px; align-items: center; text-align: left; font: inherit; color: var(--text); background: rgba(255,255,255,.05); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
      .dlv-menu button:hover { background: rgba(255,255,255,.12) }
      .dlv-menu button span { font-size: 18px } .dlv-menu small { display: block; color: var(--muted); font-size: 11.5px }
      @media (max-width: 1000px) { .dlv-job { top: 74px } }
      @media (max-width: 640px) {
        .dlv-co { padding: 7px 11px } .dlv-co .credit { display: none }
        .dlv-btns .opt { display: none }
        .dlv-job .where, .dlv-job .sub, .dlv-job .what { max-width: 250px }
        .dlv-pick { font-size: 13px; white-space: nowrap; top: 64px }
      }`
    document.head.append(css)
    const el = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; d.hidden = true; document.body.append(d); return d }
    const co = el('dlv dlv-co card', `<div class="name">Salmonberry Parcel Co.</div>
      <div class="stats"><span><b data-n>0</b> delivered</span><span><b data-m>$0.00</b></span><span data-c></span></div><div class="credit">Streets © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</div>`)
    const btns = el('dlv dlv-btns', '<button class="opt" data-assist title="Gently lines the van up with the road (G)">Assist on</button><button class="opt" data-mute title="Sound (M)">Sound on</button><button data-exit title="Back to the map (Esc)">Back to map</button>')
    const read = el('dlv dlv-read card', '')
    const job = el('dlv dlv-job card', `<div class="dlv-arrow"><div class="n">N</div><svg viewBox="0 0 30 30"><path d="M15 3 L25 25 L15 20 L5 25 Z" fill="#ffc9b5" stroke="#3a2a26" stroke-width="1.5" stroke-linejoin="round"/></svg></div>
      <div><div class="what" data-w></div><div class="where" data-p></div><div class="sub" data-s></div><div class="meta"><span data-d></span><span data-t></span></div></div>`)
    const help = el('dlv dlv-help card', '')
    const act = el('dlv dlv-act card', '')
    const pop = el('dlv dlv-pop card', '<div class="big" data-b></div><div class="q" data-q></div>')
    const pickEl = el('dlv dlv-pick card', `<span data-pt></span><button data-cancel>Cancel</button>`)
    const touch = el('dlv dlv-touch', '<button class="l" data-k="left" aria-label="Turn left">◀</button><button class="r" data-k="right" aria-label="Turn right">▶</button><button class="brk" data-k="brake" aria-label="Brake and reverse">Brake</button><button class="gas" data-k="gas" aria-label="Go">Go</button><button class="act" data-act hidden></button>')
    const q = (e, s) => e.querySelector(s)
    return { co, btns, read, job, help, act, pop, pickEl, touch, all: [co, btns, read, job, help, act, pop, pickEl, touch], n: q(co, '[data-n]'), m: q(co, '[data-m]'), c: q(co, '[data-c]'),
      assist: q(btns, '[data-assist]'), mute: q(btns, '[data-mute]'), exit: q(btns, '[data-exit]'), arrow: q(job, 'svg'), north: q(job, '.n'), w: q(job, '[data-w]'), p: q(job, '[data-p]'), s: q(job, '[data-s]'),
      d: q(job, '[data-d]'), t: q(job, '[data-t]'), b: q(pop, '[data-b]'), qq: q(pop, '[data-q]'), pt: q(pickEl, '[data-pt]'), cancel: q(pickEl, '[data-cancel]'), brk: q(touch, '.brk'), tact: q(touch, '[data-act]'), css }
  }
  const touchState = { left: false, right: false, gas: false, brake: false }
  for (const b of ui.touch.querySelectorAll('[data-k]')) {
    const k = b.dataset.k, set = (on) => (e) => { e.preventDefault(); touchState[k] = on; b.classList.toggle('on', on); if (on) audio() }
    b.addEventListener('pointerdown', (e) => { try { b.setPointerCapture(e.pointerId) } catch {} set(true)(e) })
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, set(false))
    b.addEventListener('contextmenu', (e) => e.preventDefault())
  }
  ui.tact.addEventListener('click', () => toggleFoot())
  ui.exit.onclick = () => exit()
  ui.cancel.onclick = () => cancelPick()
  ui.assist.onclick = () => { assist = !assist; ui.assist.textContent = assist ? 'Assist on' : 'Assist off' }
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
    ui.help.textContent = onFoot ? 'WASD or arrows to walk · Shift to run · E to get in the van · Esc to the map'
      : `WASD or arrows to drive · Space to brake · E to get out · H horn · R back on the road · Esc to the map`
    ui.help.hidden = false; ui.help.classList.remove('fade')
    clearTimeout(helpT)
    if (!deliver) helpT = setTimeout(() => ui.help.classList.add('fade'), 7000)
  }

  // ================================================================ the game state
  const pcam = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 1, 900)
  const opts = { focus: new THREE.Vector3(), radius: 900, shadowRadius: 300 }
  const car = { x: 0, y: 0, h: 0, yaw: 0, speed: 0, steer: 0, spin: 0, pitch: 0, roll: 0, bank: 0, deck: false, bumpT: 0, sx: 0, sy: 0, kick: 0, parked: false }
  const man = { x: 0, y: 0, h: 0, yaw: 0, speed: 0, phase: 0, run: false, bumpT: 0, board: null }
  const chase = { pos: new THREE.Vector3(), look: new THREE.Vector3(), yaw: 0 }
  let state = 'off', anim = null, offFrame = null, t0 = 0, mapPose = null, fromPose = null, saved = null
  let deliver = false, onFoot = false, hasVan = true, assist = true, job = null, shift = { n: 0, money: 0 }, hudAt = 0, jobRetry = 0, readAt = 0, street = null, shake = 0, skyAt = 0, fogFar = 850
  let pickKind = null, down = null
  const keys = new Set()

  const button = city.ui.addButton({ label: 'Drive', icon: '🚐', title: 'Explore the streets by van or on foot, or deliver parcels (D)', panel: true })
  button.panel.innerHTML = `<div class="dlv-menu">
    <button data-m="car"><span>🚐</span><div>Explore by van<small>Drive anywhere, no jobs</small></div></button>
    <button data-m="foot"><span>🚶</span><div>Explore on foot<small>Walk the sidewalks; E gets in the van</small></div></button>
    <button data-m="deliver"><span>📦</span><div>Deliveries<small>Parcels to real streets nearby, a compass, tips</small></div></button></div>`
  for (const b of button.panel.querySelectorAll('[data-m]')) b.addEventListener('click', () => { button.panel.hidden = true; button.button.setAttribute('aria-expanded', 'false'); startPick(b.dataset.m) })

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
    onFoot = kind === 'foot'
    document.activeElement?.blur?.() // a focused toolbar button would take Space (brake) as a click
    Object.assign(car, { speed: 0, steer: 0, pitch: 0, roll: 0, bank: 0, deck: false, sx: 0, sy: 0, kick: 0, parked: onFoot })
    if (onFoot) {
      Object.assign(man, { x: spot.x, y: spot.y, yaw: spot.yaw, speed: 0, board: null })
      man.h = city.world.heightAt(man.x, -man.y) + 0.15
      const v = carSpawn(at.x, at.y) // the van waits on the street nearby
      hasVan = !!v && Math.hypot(v.x - man.x, v.y - man.y) < 120
      if (hasVan) Object.assign(car, { x: v.x, y: v.y, yaw: v.yaw })
    } else { hasVan = true; Object.assign(car, { x: spot.x, y: spot.y, yaw: spot.yaw }) }
    if (hasVan) car.h = surface(car.x, car.y, city.world.heightAt(car.x, -car.y) + 0.2).y
    // where the map camera is: the dive starts there, and Esc returns there exactly
    const C = city.camera, T = city.controls.target
    mapPose = { look: T.clone(), dir: C.position.clone().sub(T).normalize(), H: (C.top - C.bottom) / C.zoom, fov: 2 }
    chase.yaw = body().yaw
    chasePose(0, true)
    shift = { n: 0, money: 0 }; job = null; jobRetry = 0; street = null
    saved = { bg: city.scene.background, fog: city.scene.fog }
    if (hasVan) city.scene.add(van)
    city.scene.add(walker, icons.pickup, icons.drop)
    walker.visible = onFoot
    icons.pickup.visible = icons.drop.visible = false
    city.overlay.add(blob, wblob, beam, ring, ring2, pool)
    beam.visible = ring.visible = ring2.visible = false
    wblob.visible = onFoot; blob.visible = hasVan
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
  function exit() {
    if (state === 'pick') return cancelPick()
    if (state !== 'play') return
    fromPose = { look: chase.look.clone(), dir: chase.pos.clone().sub(chase.look).normalize(), H: 2 * chase.pos.distanceTo(chase.look) * Math.tan((pcam.fov * Math.PI) / 360), fov: pcam.fov }
    state = 'out'; t0 = performance.now()
    for (const e of ui.all) e.hidden = true
    keys.clear()
    if (engine) engine.g.gain.setTargetAtTime(0, ac.currentTime, 0.2)
    traffic()?.setObstacle('player-van', null); traffic()?.setObstacle('player-walker', null)
    if (deliver) {
      const { n, money } = shift, all = saveTotals()
      if (n) setTimeout(() => city.ui.toast(`Shift done: ${n} ${n === 1 ? 'parcel' : 'parcels'}, $${money.toFixed(2)}${all ? ` ($${all.money.toFixed(2)} all time)` : ''}. Thanks for driving!`, 4500), 1800)
    }
  }
  function finish() { // back on the map camera, exactly where it was
    state = 'off'
    city.view.release()
    offFrame?.(); offFrame = null
    anim?.(); anim = null
    city.scene.remove(van, walker, icons.pickup, icons.drop)
    city.overlay.remove(blob, wblob, beam, ring, ring2, pool)
    city.scene.background = saved.bg; city.scene.fog = saved.fog
    publishPlayer(true)
    document.body.classList.remove('dlv-on', 'dlv-touchy')
    button.button.setAttribute('aria-pressed', 'false')
    city.requestRender()
  }
  function saveTotals() {
    try {
      const t = JSON.parse(localStorage.getItem('delivery.totals') || '{"n":0,"money":0}')
      t.n += shift.n; t.money += shift.money
      localStorage.setItem('delivery.totals', JSON.stringify(t))
      return t
    } catch {} finally { shift.n = 0; shift.money = 0 }
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
    let bx = P.x - fx * back, by = P.y - fy * back
    // keep the boom out of buildings: shorten it to the first wall
    for (let s = 0.25; s <= 1.0001; s += 0.25) {
      if (insideBuilding(P.x - fx * back * s, P.y - fy * back * s)) { const f = Math.max(onFoot ? 0.3 : 0.35, s - 0.25); bx = P.x - fx * back * f; by = P.y - fy * back * f; break }
    }
    const gy = Math.max(city.world.heightAt(bx, -by) + (onFoot ? 1.2 : 1.4), P.h + up)
    v3.set(bx, gy, -by)
    if (snap) chase.pos.copy(v3); else chase.pos.lerp(v3, 1 - Math.exp(-7 * dt))
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
    fogFar = A.fogFar
    // blend in from the map look: far fog first, the haze settles as the camera reaches the street
    const D = pcam.position.distanceTo(opts.focus)
    fog.color.copy(ca)
    fog.near = A.fogNear + (D * 4 + 2000) * (1 - k); fog.far = A.fogFar + (D * 8 + 4000) * (1 - k)
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
    pool.visible = !!lights && k > 0.9 && hasVan
  }

  // ---------------------------------------------------------------- other cars (city.traffic, from the life plugin)
  const traffic = () => (city.traffic?.nearby ? city.traffic : null)
  const SELF = new Set(['player-van', 'player-walker'])
  function others(x, y, r) { // simulated cars and other players near (x, north); mp: true for players
    const out = []
    try { const T = traffic(); if (T) for (const o of T.nearby(x, -y, r)) if (!SELF.has(o.id) && !String(o.id).startsWith('mp:')) out.push(o) } catch (e) { console.warn('drive: traffic.nearby', e) }
    try { const M = city.multiplayer; if (M?.nearby) for (const o of M.nearby(x, -y, r)) out.push({ ...o, mp: true }) } catch (e) { console.warn('drive: multiplayer.nearby', e) }
    return out
  }
  const otherBox = (o) => ({ x: o.x, y: -o.z, fx: Math.sin(o.heading), fy: -Math.cos(o.heading), hl: (o.length || 4.4) / 2, hw: (o.width || 1.8) / 2 }) // heading: forward (sin, cos) in (x, z)
  function hitTraffic(o, impact) {
    if (o.mp) return
    try { city.traffic?.bump?.(o.id, impact) } catch (e) { console.warn('drive: traffic.bump', e) }
  }
  function carVsTraffic() {
    const fx = fwdX(car.yaw), fy = fwdY(car.yaw)
    const me = { x: car.x, y: car.y, fx, fy, hl: VAN_L, hw: VAN_W }
    for (const o of others(car.x, car.y, 14)) {
      const b = otherBox(o), c = boxBox(me, b)
      if (!c) continue
      car.x += c.nx * c.depth; car.y += c.ny * c.depth; me.x = car.x; me.y = car.y
      // bounce off it as off a heavy moving wall: the van's velocity relative to it, reflected along the normal
      const vx = fx * car.speed + car.sx, vy = fy * car.speed + car.sy, ux = b.fx * (o.speed || 0), uy = b.fy * (o.speed || 0)
      const vn = (vx - ux) * c.nx + (vy - uy) * c.ny
      if (vn >= 0) continue
      const nvx = vx - 1.35 * vn * c.nx, nvy = vy - 1.35 * vn * c.ny
      car.speed = nvx * fx + nvy * fy
      const side = nvx * fy - nvy * fx // sideways part: a short slide and a little twist
      car.sx = fy * side * 0.8; car.sy = -fx * side * 0.8
      car.kick = clamp(-side * 0.25, -0.6, 0.6)
      bumped(-vn, () => hitTraffic(o, -vn))
    }
  }
  function bumped(impact, fn) {
    const P = body()
    if (impact < 0.8 || performance.now() - P.bumpT < 350) return
    P.bumpT = performance.now()
    sfx.bump(clamp(impact / 9, 0.25, 1))
    shake = Math.min(0.55, 0.08 + impact * 0.05)
    if (job && impact > 2) job.bumps++
    fn?.()
  }
  function publishPlayer(emit) { // city.player (player-contract): where the user is, read by others every frame
    const P = body()
    if (state === 'off' || state === 'pick') { if (city.player) { city.player = null; city.emit('player', null) } return }
    const p = city.player || (city.player = { vehicle: 'van', colour: COLOUR })
    Object.assign(p, { mode: onFoot ? 'foot' : 'car', x: P.x, y: P.h, z: -P.y, heading: wrap(P.yaw + Math.PI), speed: P.speed })
    if (emit) city.emit('player', p)
  }
  function publish() { // the van and the walker as obstacles the simulated cars brake for
    publishPlayer(false)
    const T = traffic()
    if (!T?.setObstacle) return
    if (hasVan) T.setObstacle('player-van', { x: car.x, z: -car.y, heading: wrap(car.yaw + Math.PI), length: 4.3, width: 1.8, speed: onFoot ? 0 : Math.abs(car.speed) })
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
  function drive(dt, I) {
    // speed: throttle, brake / reverse, rolling drag, a gentle pull on slopes; a parked van just stands
    let a = 0
    if (I.up) a += car.speed < -0.3 ? 12 : 6.5 * (1 - clamp(car.speed / MAX_SPEED, 0, 1)) + 0.6
    if (I.down) a -= car.speed > 0.3 ? 11 : car.speed > -MAX_REVERSE ? 4 : 0
    if (I.hand || car.parked) a -= Math.sign(car.speed) * Math.min(14, Math.abs(car.speed) / dt)
    a -= 9.8 * Math.sin(car.pitch) * 0.55 * (car.parked ? 0 : 1)
    car.speed += a * dt
    const drag = (0.5 + 0.011 * car.speed * car.speed + (I.up || I.down ? 0 : 1.2)) * dt
    car.speed = Math.abs(car.speed) <= drag ? 0 : car.speed - Math.sign(car.speed) * drag
    car.speed = clamp(car.speed, -MAX_REVERSE, MAX_SPEED)
    // steering: tighter when slow, smoothed
    const maxSteer = 0.58 / (1 + Math.abs(car.speed) / 9)
    car.steer += (I.steer * maxSteer - car.steer) * (1 - Math.exp(-(I.steer ? 5 : 8) * dt))
    // pushing against a wall still lets the van creep round (as if rolling at walking pace)
    const turn = Math.abs(car.speed) < 1.2 && (I.up || I.down) ? (I.up ? 1.2 : -1.2) : car.speed
    const yawRate = (turn * Math.tan(car.steer)) / WB + car.kick
    car.yaw += yawRate * dt
    car.kick *= Math.exp(-5 * dt)
    // assist: with no steering, ease the van along the road it is on
    if (assist && !I.steer && Math.abs(car.speed) > 2.5) {
      const r = nearestRoad(car.x, car.y, 3)
      if (r && r.d < 0.5) {
        let d = wrap(yawFromDir(r.dir) - car.yaw)
        if (Math.abs(d) > Math.PI / 2) d = wrap(d + Math.PI)
        if (Math.abs(d) < 0.4) car.yaw += d * Math.min(1, 1.6 * dt)
      }
    }
    // move, then resolve: water and bridge edges stop the van softly, buildings push it out
    const fx = fwdX(car.yaw), fy = fwdY(car.yaw)
    let nx = car.x + (fx * car.speed + car.sx) * dt, ny = car.y + (fy * car.speed + car.sy) * dt
    car.sx *= Math.exp(-4 * dt); car.sy *= Math.exp(-4 * dt)
    const blocked = (x, y) => {
      const s = surface(x, y, car.h)
      if (car.deck && !s.deck && car.h - s.y > 2 && !s.end) return 'edge'
      const ax = x + fx * Math.sign(car.speed || 1) * 2, ay = y + fy * Math.sign(car.speed || 1) * 2
      if (!s.deck && isWater(ax, ay) && !roadAt(ax, ay, car.h)) return 'water'
      return null
    }
    const why = (nx !== car.x || ny !== car.y) && blocked(nx, ny)
    if (why) {
      if (!blocked(nx, car.y)) ny = car.y
      else if (!blocked(car.x, ny)) nx = car.x
      else { nx = car.x; ny = car.y }
      if (Math.abs(car.speed) > 3 && why === 'water') sfx.splash()
      car.speed *= why === 'water' ? 0.6 : 0.7
    }
    car.x = nx; car.y = ny
    let hit = 0
    for (const off of [1.45, 0, -1.45]) {
      const cx = car.x + fwdX(car.yaw) * off, cy = car.y + fwdY(car.yaw) * off
      const p = collide(cx, cy, 1.05)
      if (!p) continue
      car.x += p.x; car.y += p.y
      const l = Math.hypot(p.x, p.y) || 1, nX = p.x / l, nY = p.y / l
      const vx = fwdX(car.yaw) * car.speed, vy = fwdY(car.yaw) * car.speed, vn = vx * nX + vy * nY
      if (vn < 0) { // slide along the wall; a real knock bounces a little and costs some speed
        const k = -vn > 2 ? 1.15 : 1
        hit = Math.max(hit, -vn); car.speed = (vx - nX * vn * k) * fwdX(car.yaw) + (vy - nY * vn * k) * fwdY(car.yaw)
        if (-vn > 2) car.speed *= 0.8
      }
    }
    if (hit > 2.5) bumped(hit)
    carVsTraffic()
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
    car.bank += (clamp(-yawRate * car.speed * 0.012, -0.07, 0.07) - car.bank) * (1 - Math.exp(-5 * dt)) // leans out of turns
    car.spin += (car.speed * dt) / 0.36
  }
  function engineNote(I) {
    if (!engine || muted) return
    const t = ac.currentTime, sp = Math.abs(car.speed) / MAX_SPEED
    if (onFoot) { engine.g.gain.setTargetAtTime(hasVan ? 0.006 : 0, t, 0.3); return } // idling at the kerb
    engine.o1.frequency.setTargetAtTime(38 + sp * 70 + (I.up ? 6 : 0), t, 0.1); engine.o2.frequency.setTargetAtTime(77 + sp * 140, t, 0.1)
    engine.g.gain.setTargetAtTime(0.018 + sp * 0.03 + (I.up ? 0.01 : 0), t, 0.15)
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
  function walk(dt, I) {
    if (man.board) { // walking round to the van's door, then in
      const b = man.board, e = clamp((performance.now() - b.t0) / b.ms, 0, 1)
      man.x = b.x + (b.tx - b.x) * e; man.y = b.y + (b.ty - b.y) * e; man.speed = e < 1 ? 3.2 : 0
      man.yaw += wrap(b.yaw - man.yaw) * Math.min(1, dt * 12)
      man.phase += dt * 9
      if (e >= 1) { man.board = null; onFoot = false; car.parked = false; walker.visible = wblob.visible = false; sfx.door(); showHelp(); publishPlayer(true) }
      return
    }
    man.run = I.run
    const target = I.up ? (I.run ? RUN : WALK) : I.down ? -WALK * 0.6 : 0
    man.speed += (target - man.speed) * (1 - Math.exp(-(target ? 6 : 10) * dt))
    if (Math.abs(man.speed) < 0.02 && !target) man.speed = 0
    man.yaw += I.steer * (I.run ? 2.2 : 2.8) * dt
    const fx = fwdX(man.yaw), fy = fwdY(man.yaw)
    let nx = man.x + fx * man.speed * dt, ny = man.y + fy * man.speed * dt
    // water: only where a deck or a path goes over it
    const wet = (x, y) => isWater(x, y) && !footSurface(x, y, man.h).deck && !(nearestRoad(x, y, 6, false, true)?.d < 0.6)
    if ((nx !== man.x || ny !== man.y) && wet(nx + fx * 0.4, ny + fy * 0.4)) {
      if (!wet(nx + fx * 0.4, man.y)) ny = man.y; else if (!wet(man.x, ny + fy * 0.4)) nx = man.x; else { nx = man.x; ny = man.y }
    }
    man.x = nx; man.y = ny
    // buildings and the parked van push the walker out
    const p = collide(man.x, man.y, 0.32)
    if (p) { man.x += p.x; man.y += p.y }
    if (hasVan) { const q = circleBox(man.x, man.y, 0.32, car.x, car.y, fwdX(car.yaw), fwdY(car.yaw), VAN_L, VAN_W); if (q) { man.x += q.x; man.y += q.y } }
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
  // E: in and out of the van
  function nearVan() { return hasVan && onFoot && !man.board && Math.hypot(man.x - car.x, man.y - car.y) < 7 }
  function canGetOut() { return !onFoot && Math.abs(car.speed) < 1.5 }
  function toggleFoot() {
    if (state !== 'play') return
    if (nearVan()) { // walk to the driver's door (left, front) and climb in
      const rx = Math.cos(car.yaw), ry = Math.sin(car.yaw)
      const tx = car.x - rx * 1.25 + fwdX(car.yaw) * 0.9, ty = car.y - ry * 1.25 + fwdY(car.yaw) * 0.9
      man.board = { t0: performance.now(), x: man.x, y: man.y, tx, ty, yaw: car.yaw, ms: clamp(Math.hypot(tx - man.x, ty - man.y) / 3.2, 0.3, 2) * 1000 }
      return
    }
    if (!canGetOut()) { if (!onFoot) city.ui.toast('Stop the van to get out', 1500); return }
    // out of the driver's door; if that is a wall or water, the other side, else behind
    const rx = Math.cos(car.yaw), ry = Math.sin(car.yaw), fx = fwdX(car.yaw), fy = fwdY(car.yaw)
    let spot = null
    for (const [sr, sf] of [[-1.7, 0.6], [1.7, 0.6], [0, -3.2], [0, 3.2]]) {
      const x = car.x + rx * sr + fx * sf, y = car.y + ry * sr + fy * sf
      if (!insideBuilding(x, y) && !collide(x, y, 0.3) && !isWater(x, y)) { spot = { x, y, yaw: car.yaw }; break }
    }
    if (!spot) { city.ui.toast('No room to get out here'); return }
    car.speed = 0; car.parked = true; onFoot = true
    Object.assign(man, { x: spot.x, y: spot.y, yaw: spot.yaw, speed: 0, h: footSurface(spot.x, spot.y, car.h - 0.1).y, board: null })
    walker.visible = wblob.visible = true
    sfx.door()
    showHelp()
    publishPlayer(true)
  }

  function place() {
    if (hasVan) {
      van.position.set(car.x, car.h - 0.02, -car.y)
      van.rotation.set(0, 0, 0)
      van.rotateY(car.yaw); van.rotateX(car.pitch); van.rotateZ(car.roll + car.bank)
      for (const w of van.userData.wheels) { w.spin.rotation.x = -car.spin; if (w.front) w.steer.rotation.y = car.steer }
      blob.position.set(car.x, car.h + 0.06, -car.y); blob.rotation.set(0, car.yaw, 0)
      pool.position.copy(blob.position); pool.rotation.copy(blob.rotation)
    }
    if (walker.visible) {
      walker.position.set(man.x, man.h - 0.05, -man.y)
      walker.rotation.set(0, man.yaw, 0)
      poseWalker(walker, man.phase, clamp(Math.abs(man.speed) / WALK, 0, 1), man.run && man.speed > WALK + 0.3)
      wblob.position.set(man.x, man.h + 0.03, -man.y)
    }
  }
  function resetToRoad() {
    const r = nearestRoad(car.x, car.y, 300)
    if (!r) return
    let yaw = yawFromDir(r.dir)
    if (Math.abs(wrap(yaw - car.yaw)) > Math.PI / 2) yaw = wrap(yaw + Math.PI)
    Object.assign(car, { x: r.px, y: r.py, yaw, speed: 0, steer: 0, sx: 0, sy: 0, kick: 0 })
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
  function target() { return job && (job.stage === 'pickup' ? job.from : job.to) }
  function newJob() {
    const P = body()
    let from = null, item = pick(PARCELS)
    if (Math.random() < 0.35) { // now and then a pickup at a real shop nearby first
      const shops = placesNear(P.x, P.y, 120, 600)
      for (let k = 0; k < 10 && shops.length && !from; k++) {
        const p = shops.splice(Math.floor(Math.random() * shops.length), 1)[0], s = stopFor(p.x, p.y)
        if (s) { from = { ...s, label: p.name, sub: p.addr ? abbr(p.addr) : p.kind }; if (ITEMS[p.kind]) item = pick(ITEMS[p.kind]) }
      }
    }
    const o = from || P, to = address(o.x, o.y, from ? 200 : 150, from ? 700 : 600)
    if (!to) return false
    to.who = someone()
    job = { stage: from ? 'pickup' : 'drop', from, to, item, bumps: 0 }
    setTarget()
    return true
  }
  function setTarget() {
    const t = target(), pickup = job.stage === 'pickup'
    const col = pickup ? 0xffb05c : 0x5fd6c4
    beamMat.uniforms.col.value.set(col); ringMat.color.set(col); ring2Mat.color.set(col)
    icons.pickup.visible = pickup; icons.drop.visible = !pickup
    beam.visible = ring.visible = ring2.visible = true
    t.gy = city.world.heightAt(t.x, -t.y) + 0.2
    for (const o of [beam, ring, ring2]) o.position.set(t.x, t.gy + 0.08, -t.y)
    // a relaxed time: the way there (as the crow flies, plus a bit for corners) at a gentle 7 m/s, plus a minute
    const P = body()
    job.dist = Math.hypot(t.x - P.x, t.y - P.y) * 1.35
    job.limit = job.dist / 7 + 60; job.start = performance.now()
  }
  function arrive() {
    if (job.stage === 'pickup') {
      sfx.pickup()
      job.stage = 'drop'; job.bumps = 0
      popup('Picked up!', `${job.item[0].toUpperCase()}${job.item.slice(1)} for ${job.to.who}`)
      setTarget()
      return
    }
    // paid: a base for the distance, a tip for being on time and gentle with the parcel
    const used = (performance.now() - job.start) / 1000, left = Math.max(0, job.limit - used)
    const base = 6 + (job.dist / 1000) * 5, tip = Math.max(1, (left > 0 ? 3 + 7 * (left / job.limit) : 1.5) - job.bumps * 0.6)
    const pay = Math.round((base + tip) * 100) / 100
    shift.n++; shift.money += pay
    sfx.deliver()
    popup(`+$${pay.toFixed(2)}`, `${job.to.who.split(' ')[0]}: ${pick(THANKS)} (tip $${tip.toFixed(2)})`)
    job = null
    hideMarkers()
    jobRetry = performance.now() + 2500
  }
  function hideMarkers() { beam.visible = ring.visible = ring2.visible = icons.pickup.visible = icons.drop.visible = false }

  // ---------------------------------------------------------------- per frame
  function frame(dt, time) {
    const now = performance.now()
    if (state === 'in' || state === 'out') {
      const e = clamp((now - t0) / (state === 'in' ? 2600 : 2200), 0, 1)
      pose(e)
      place()
      if (e >= 1) {
        if (state === 'out') return finish()
        state = 'play'
        ui.btns.hidden = false
        if (deliver) ui.co.hidden = false; else ui.read.hidden = false
        ui.touch.hidden = false
        showHelp()
        hudAt = 0
      }
      return
    }
    if (state !== 'play' || !(dt > 0)) return
    const I = input()
    if (onFoot) { walk(dt, I); if (hasVan) drive(dt, { steer: 0, up: false, down: false, hand: true }) } else drive(dt, I)
    engineNote(I)
    publish()
    place()
    chasePose(dt)
    const fov = chaseFov(), near = nearPlane(), far = fogFar + 60
    if (pcam.fov !== fov || pcam.near !== near || pcam.far !== far) { pcam.fov = fov; pcam.near = near; pcam.far = far; pcam.updateProjectionMatrix() }
    pcam.position.copy(chase.pos)
    if (shake > 0.001) { pcam.position.x += (Math.random() - 0.5) * shake; pcam.position.y += (Math.random() - 0.5) * shake; shake *= Math.exp(-10 * dt) }
    pcam.up.set(0, 1, 0); pcam.lookAt(chase.look)
    const P = body(), ahead = onFoot ? 60 : 180
    opts.focus.set(P.x + fwdX(P.yaw) * ahead, P.h, -(P.y + fwdY(P.yaw) * ahead))
    opts.radius = 900; opts.shadowRadius = 300
    // the job
    let t = null
    if (deliver) {
      if (!job && now > jobRetry) { if (!newJob()) jobRetry = now + 1000 }
      t = target()
      if (t && Math.hypot(t.x - P.x, t.y - P.y) < (onFoot ? ARRIVE_FOOT : ARRIVE + t.w / 2) && (onFoot || Math.abs(car.speed) < 7)) { arrive(); t = target() }
      // markers: a soft pulse, the parcel/house turning and bobbing
      beamMat.uniforms.t.value = time
      const pulse = (time * 0.8) % 1
      ring2.scale.setScalar(1 + pulse * 0.9); ring2Mat.opacity = 0.8 * (1 - pulse)
      ring.scale.setScalar(1 + Math.sin(time * 3) * 0.04)
      if (t) for (const ic of Object.values(icons)) if (ic.visible) { ic.position.set(t.x, t.gy + 4.2 + Math.sin(time * 2) * 0.35, -t.y); ic.rotation.y = time * 1.2 }
    }
    if (now - readAt > 400) { readAt = now; street = nearestStreet(P.x, P.y, 30); cellsNear(P.x, P.y, 800) }
    if (now - hudAt > 100) { hudAt = now; hud(t) }
    if (now - skyAt > 1000) { skyAt = now; atmosphere(1) }
  }
  function hud(t) {
    // E to get in or out
    const can = nearVan() ? 'Get in' : canGetOut() ? 'Get out' : ''
    ui.tact.hidden = !can; ui.tact.textContent = can
    ui.act.hidden = !(nearVan() && !touchy); ui.act.innerHTML = '<kbd>E</kbd>Get in the van'
    ui.brk.textContent = onFoot ? 'Run' : 'Brake'
    const P = body(), name = street ? abbr(street.name) : ''
    if (!deliver) {
      const sp = Math.abs(P.speed) * 3.6
      ui.read.innerHTML = `<b>${Math.round(sp)}</b> km/h${name ? ` · ${escape(name)}` : ''}`
      return
    }
    ui.n.textContent = String(shift.n)
    ui.m.textContent = `$${shift.money.toFixed(2)}`
    const h = hourNow(), hh = Math.floor(h), mm = Math.floor((h - hh) * 60)
    ui.c.textContent = `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`
    ui.job.hidden = false
    if (!t) {
      ui.arrow.style.opacity = 0.3
      ui.w.textContent = 'Next up'; ui.s.textContent = name ? `on ${name}` : ''; ui.d.textContent = ''; ui.t.textContent = ''
      ui.p.textContent = shift.n ? 'Checking the order board…' : 'Finding your first parcel…'
      return
    }
    ui.arrow.style.opacity = 1
    const pickup = job.stage === 'pickup'
    ui.w.textContent = pickup ? 'Pick up at' : `Deliver ${job.item}`
    ui.p.textContent = pickup ? t.label : t.label
    ui.s.textContent = pickup ? t.sub || '' : `for ${t.who}`
    const d = Math.hypot(t.x - P.x, t.y - P.y)
    ui.d.textContent = `${d > 950 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`} away`
    const left = job.limit - (performance.now() - job.start) / 1000
    ui.t.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} for a good tip` : 'running late, no worries'
    ui.t.className = left > 0 ? '' : 'late'
    // the compass: the target's bearing and north, relative to where the camera looks
    const cy = Math.atan2(chase.look.x - chase.pos.x, -(chase.look.z - chase.pos.z)) // compass bearing of the view
    const ty = Math.atan2(t.x - P.x, t.y - P.y)
    ui.arrow.style.transform = `rotate(${wrap(ty - cy)}rad)`
    ui.north.style.transform = `rotate(${wrap(-cy)}rad)`
  }
  const escape = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

  // ---------------------------------------------------------------- keys
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable
  const CONTROL = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'])
  function onKey(e) {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
    if (state === 'off') { if (e.code === 'KeyD' && !e.repeat && !e.shiftKey) startPick('deliver'); return }
    if (e.code === 'Escape') { exit(); return }
    if (state !== 'play') return
    if (CONTROL.has(e.code)) { keys.add(e.code); e.preventDefault() }
    if (e.repeat) return
    if (e.code === 'KeyE') toggleFoot()
    else if (e.code === 'KeyR' && !onFoot) resetToRoad()
    else if (e.code === 'KeyH' && !onFoot) sfx.horn()
    else if (e.code === 'KeyM') setMuted(!muted)
    else if (e.code === 'KeyG') ui.assist.onclick()
  }
  const onKeyUp = (e) => keys.delete(e.code)
  const onBlur = () => { keys.clear(); for (const k in touchState) touchState[k] = false }
  const onResize = () => { fitCamera(); if (state !== 'off') city.requestRender() }
  addEventListener('keydown', onKey)
  addEventListener('keyup', onKeyUp)
  addEventListener('blur', onBlur)
  addEventListener('resize', onResize)
  const onVis = () => { if (document.hidden) { onBlur(); if (ac) ac.suspend() } else if (ac && state !== 'off') ac.resume() }
  document.addEventListener('visibilitychange', onVis)

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
