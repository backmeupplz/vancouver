// Life: the simulation thread. Cars drive the map tiles' road graph (© OpenStreetMap contributors, ODbL) on the
// right, in lanes, through junctions on Bezier curves, keeping their distance with the intelligent driver model;
// they change lanes (MOBIL: to pass, to get into the lane for the next turn, where a lane ends) and
// they obey traffic signals (two phases by approach axis, with a walk phase for people), stop signs and give-way
// rules, and yield to people on the crosswalks. People walk the sidewalks and footways, cross at junctions and
// crossings, wait at bus stops and sit on benches; cyclists ride the cycleways.
// The page sends the tiles near the view ('tiles'), the simulated area ('area'), settings ('opts') and a 'tick'
// per drawn frame; each tick answers with every car and person as 8 floats in a transferable Float32Array.
// 'obstacles' are things the page drives or walks (city.traffic.setObstacle): cars brake for them, people step
// around them (and jump out of the way of a fast one); 'bump' stops a car the player hit for a moment, 'knock' sends a
// person the player bumped into stumbling, or over (they get up again after a moment).

const STEP = 1 / 30 // fixed simulation step, seconds
const BUILD_MS = 10, BUILD_MIN = 4 // a new network is built in what is left of this many milliseconds a tick, at least that many
const IDM = { a: 1.4, b: 2.2, T: 1.3, s0: 2.2 }
// lane changes: about how many seconds of sideways motion (over at least `run` metres), MOBIL politeness,
// threshold and keep-right bias (m/s²), how far before the stop line drivers get into the lane for their turn,
// safe braking for a free and a needed change; MARGIN: how close to an obstacle's outline a path is blocked
const LC = { T: 3, run: 20, p: 0.3, th: 0.3, bias: 0.2, zone: 120, bsafe: 3, bmust: 4.5 }
const MARGIN = 1.5
const SEEN = 250 // metres: no car appears or vanishes this close to the player (an obstacle)
// nor in the camera's view (a little past its edges; a perspective camera: within FAR metres); where one must (the view
// still filling, a dead end in view), it grows in or shrinks away over FADE seconds; NEAR: closer than this, two
// junction paths are as good as crossing (the bodies of two cars on them touch)
const FAR = 700, FADE = 0.6, NEAR = 1.8
const AXLE = 0.6 // the rear axle trails the front bumper by this share of the car's length
// the width cars parked along each kerb take (core/tile-worker.js parkSide, which places them: keep the two in step):
// residential and living streets and two-lane tertiaries (kinds 5, 7, 4) where the lanes keep 2.1 m each beside them
const parkSide = (p) => (p.kind === 5 || p.kind === 7 || p.kind === 4 && p.lanes <= 2) && p.w - 3.8 >= 2.1 * Math.max(2, p.lanes) ? 1.9 : 0
// by road kind: motorway, trunk, primary, secondary, tertiary, residential, service, living
const V0 = [24, 19, 14, 13.5, 12.5, 10, 5, 4.2] // free speed, m/s
const DENS = [22, 20, 40, 34, 24, 4, 0.8, 0.8] // cars per lane-km at the evening rush
// car kinds: sedan, suv, van, truck, taxi, police (the page has a model for each)
const CAR_LEN = [4.55, 4.85, 5.45, 8.7, 4.55, 4.55] // bumper to bumper, as the page models them
const BODY = [0xd63b3b, 0x2f6fd6, 0xf2f2ee, 0x2b2d31, 0x9aa3ab, 0xc8ccd0, 0x1f7a5a, 0xe68a2e, 0x3d4f8f, 0x8a2433, 0x5cb8d8, 0xf0c419, 0x6b4f9e, 0x40464e, 0xd8d0c0, 0x7fb069]
const VAN = [0xf2f2ee, 0xf2f2ee, 0xd8dadc, 0x2b2d31, 0x2f6fd6, 0xe9e2d0]
const CAB = [0xd63b3b, 0xf2f2ee, 0x2f6fd6, 0x1f7a5a, 0xf0a020, 0x40464e]
const SHIRT = [0xe63946, 0xf4a261, 0x2a9d8f, 0x457b9d, 0xe9c46a, 0x8ecae6, 0xf7f7f2, 0x264653, 0xd62828, 0x6a4c93, 0xff99c8, 0x90be6d, 0x2b2b2b, 0xf77f00, 0x3a86ff, 0xb5838d]
const PANTS = [0x1d3557, 0x2b2d42, 0x495057, 0x6c584c, 0x3a5a40, 0x14213d, 0xa98467, 0x222222, 0x5e6472, 0x8d99ae]
const DOWNTOWN = [-850, -370] // Granville & Georgia, world metres
const pick = (a) => a[(Math.random() * a.length) | 0]

let tiles = new Map() // "level/i_j" -> { level, ox, oy, size, terrain, pieces, pois }
let area = null // { x, y, r, vx, vy, vr }: simulated circle, and the view circle (people live there)
let opts = { cars: true, people: false, bikes: true, density: 1, hour: 12, maxCars: 4000, maxPeople: 3000 }
let dirty = true, walkDirty = true, lastBuild = -1e9
let net = null, walk = null
let cars = [], peds = [], bikes = [], statics = []
let obstacles = new Map(), blocked = [], nextId = 1, lcTotal = 0, view = null
let job = null, budget = Infinity // the network being built (rebuild()), and when this tick's share of it ends
const due = () => performance.now() > budget
let stuck = 0, simT = 0, acc = 0, stamp = 0, carTarget = 0, pedTarget = 0, bikeTarget = 0, nextPid = 1
const tmp = {}, tmp2 = {}

onmessage = ({ data: m }) => {
  if (m.type === 'tiles') {
    for (const k of m.drop) tiles.delete(k)
    for (const t of m.add) tiles.set(t.key, t)
    if (m.masks) masks = m.masks.map((r) => ({ ox: -1e9, oy: -1e9, size: 2e9, fp: { pts: Float32Array.from(r.flat()), start: [0, r.length * 2] } }))
    wallCells.clear()
    dirty = walkDirty = true
  } else if (m.type === 'area') {
    area = m.area; dirty = walkDirty = true
  } else if (m.type === 'opts') {
    const people = opts.people, weekend = !!opts.weekend
    Object.assign(opts, m.opts)
    if (opts.people !== people || !!opts.weekend !== weekend) walkDirty = true
    if (!opts.people) { for (const p of peds) release(p); peds = []; bikes = []; statics = [] }
    targets()
  } else if (m.type === 'obstacles') {
    obstacles = new Map(m.list.map((o) => [o.id, Object.assign(o, { c: Math.cos(o.ang), s: Math.sin(o.ang) })]))
    blockSegs()
  } else if (m.type === 'bump') {
    const car = cars.find((c) => c.id === m.id)
    if (car) { car.v = 0; car.hold = simT + 2 + Math.random() * 2; if (m.shove) car.shove = { d: Math.max(-2.6, Math.min(2.6, m.shove)), t: simT } }
  } else if (m.type === 'knock') { // { id, dx, dy (the push, x and north), v (m/s) }: a stumble, or a fall and up again
    const p = peds.find((q) => q.id === m.id) || statics.find((q) => q.id === m.id)
    if (p && !p.fall) {
      const hard = m.v > 2.5
      if (m.v < 1) p.pet = { t: 0, dur: 2.2 } // a pat (someone petting their dog): they stop and turn, the dog wags
      else p.fall = { t: 0, dur: hard ? 3.4 : 1.0, max: hard ? 1.45 : 0.32 }
      p.ang = Math.atan2(-m.dy, -m.dx) // facing what hit them, falling back away from it
    }
  } else if (m.type === 'tick') { view = m.view || null; tick(m) }
  else if (m.type === 'debug') postMessage(debug(m))
}

// ---------------------------------------------------------------- geometry helpers
function poly(X, Y, H) {
  const n = X.length, cum = new Float32Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1])
  return { x: X, y: Y, h: H, cum, len: cum[n - 1] }
}
// point, height and unit tangent at distance s along a polyline (before its start: on along the first stretch, at
// its height; the slope of a stretch a few centimetres long, carried metres back, lifted cars into the air)
function at(p, s, o) {
  const c = p.cum, n = c.length
  let lo = 0, hi = n - 1
  if (s >= p.len) lo = n - 2
  else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m }
  hi = lo + 1
  const d = c[hi] - c[lo], f = d > 1e-6 ? Math.min(1, (s - c[lo]) / d) : 0
  const dx = p.x[hi] - p.x[lo], dy = p.y[hi] - p.y[lo], l = Math.hypot(dx, dy) || 1
  o.x = p.x[lo] + dx * f; o.y = p.y[lo] + dy * f; o.h = p.h[lo] + (p.h[hi] - p.h[lo]) * Math.max(0, f); o.tx = dx / l; o.ty = dy / l
  return o
}
function cut(p, s0, s1) { // the part between s0 and len - s1
  const X = [], Y = [], H = [], b = p.len - s1
  at(p, s0, tmp); X.push(tmp.x); Y.push(tmp.y); H.push(tmp.h)
  for (let i = 0; i < p.cum.length; i++) if (p.cum[i] > s0 + 0.05 && p.cum[i] < b - 0.05) { X.push(p.x[i]); Y.push(p.y[i]); H.push(p.h[i]) }
  at(p, b, tmp); X.push(tmp.x); Y.push(tmp.y); H.push(tmp.h)
  return poly(Float32Array.from(X), Float32Array.from(Y), Float32Array.from(H))
}
const endHeading = (p) => { const n = p.x.length - 1; return Math.atan2(p.y[n] - p.y[n - 1], p.x[n] - p.x[n - 1]) }
const startHeading = (p) => Math.atan2(p.y[1] - p.y[0], p.x[1] - p.x[0])
const turn = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

// ground height from one tile's terrain grid (world x, y north): clamped at the tile's edge, so only for points in it
// a pier's top at tile-local (x, y) at the lowest tide: core/util.js pierTop, inline as this worker imports nothing (the drawn y at tide 0 is the stored one)
function pierTop(P, x, y) {
  const i = Math.floor(x / P.c), j = Math.floor(y / P.c)
  if (i < 0 || j < 0 || i >= 128 || j >= 128) return null
  const k = j * 128 + i, T = P.tri
  for (let s = P.start[k]; s < P.start[k + 1]; s++) {
    const t = P.list[s], o = t * 6, ax = T[o], ay = T[o + 1], bx = T[o + 2], by = T[o + 3], cx = T[o + 4], cy = T[o + 5], d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (!d) continue
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, w = 1 - u - v
    if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6) return u * P.y[t * 3] + v * P.y[t * 3 + 1] + w * P.y[t * 3 + 2]
  }
  return null
}
function tileH(t, x, y) {
  const { n, h } = t.terrain, size = t.size, c = size / (n - 1)
  const fx = Math.min(n - 1.0001, Math.max(0, (x - t.ox) / c)), fy = Math.min(n - 1.0001, Math.max(0, (size - (y - t.oy)) / c))
  const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j
  let g = h[j * n + i] * (1 - u) * (1 - v) + h[j * n + i + 1] * u * (1 - v) + h[(j + 1) * n + i] * (1 - u) * v + h[(j + 1) * n + i + 1] * u * v, f = t.terrain.f
  if (f) { // (the 2 m offsets under the streets: core/util.js sampleTerr, inline as this worker imports nothing)
    const gx = Math.min(f.n - 1.0001, Math.max(0, (x - t.ox) / 2)), gy = Math.min(f.n - 1.0001, Math.max(0, (size - (y - t.oy)) / 2)), a = gx | 0, b = gy | 0, p = gx - a, q = gy - b
    const at = (a, b) => { const s = f.B[(b >> 4) * f.nb + (a >> 4)]; return s < 0 ? 0 : f.V[s * 256 + (b & 15) * 16 + (a & 15)] }
    g += at(a, b) * (1 - p) * (1 - q) + at(a + 1, b) * p * (1 - q) + at(a, b + 1) * (1 - p) * q + at(a + 1, b + 1) * p * q
  }
  if (t.terrain.wall) g = wallH(t.terrain.wall, g, x - t.ox, y - t.oy)
  if (t.terrain.pier) { const p = pierTop(t.terrain.pier, x - t.ox, y - t.oy); if (p !== null && p > g) return p } // (a pier's deck, at the lowest tide)
  return g
}
// the seawalls' walks over the terrain (core/util.js wallHeight, copied: this classic worker can't import it)
function wallH(W, g, x, y) {
  const M = 34, c = Math.max(0, Math.min(M - 1, Math.floor(y / 32) + 1)) * M + Math.max(0, Math.min(M - 1, Math.floor(x / 32) + 1)), P = W.P, N = W.N
  let d1 = 32, h1 = g, d2 = 32, h2 = g, run = -1, rd = 32, rh = g
  const done = () => { if (rd < d1) { d2 = d1; h2 = h1; d1 = rd; h1 = rh } else if (rd < d2) { d2 = rd; h2 = rh } }
  for (let q = W.start[c]; q < W.start[c + 1]; q++) {
    const i = W.seg[W.idx[q]], r = W.segRun[W.idx[q]]
    if (r !== run) { done(); run = r; rd = 32; rh = g }
    const a = i * 7, b = a + 7, ax = P[a], ay = P[a + 1], dx = P[b] - ax, dy = P[b + 1] - ay, L2 = dx * dx + dy * dy || 1e-9
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)), dist = Math.hypot(x - ax - dx * u, y - ay - dy * u)
    if (dist >= rd) continue
    rd = dist
    const sd = u <= 0 ? (x - ax) * N[i * 2] + (y - ay) * N[i * 2 + 1] : u >= 1 ? (x - P[b]) * N[i * 2 + 2] + (y - P[b + 1]) * N[i * 2 + 3] : dx * (y - ay) - dy * (x - ax)
    const d = sd < 0 ? -dist : dist, lerp = (o) => P[a + o] + (P[b + o] - P[a + o]) * u, F = lerp(5)
    if (d > -0.2) {
      const gw = W.G ? W.G[i] + (W.G[i + 1] - W.G[i]) * u : NaN, Gc = gw === gw ? g + (gw - g) * Math.min(1, 2 * F) : g
      const Wd = W.D[i * 2] + (W.D[i * 2 + 2] - W.D[i * 2]) * u, Bd = W.D[i * 2 + 1] + (W.D[i * 2 + 3] - W.D[i * 2 + 1]) * u
      rh = g + (Gc + (lerp(2) - Gc) * F - g) * Math.max(0, Math.min(1, 1 - (d - Wd) / Bd))
    } else rh = g + (lerp(3) - g) * Math.max(0, Math.min(1, 1 - (-d - 2) / 8)) * F
  }
  done()
  const t = Math.min(1, (d2 - d1) / 3)
  return h1 + (h2 - h1) * 0.5 * (1 - t * t * (3 - 2 * t))
}
function groundH(x, y) {
  const t = tiles.get(`0/${Math.floor(x / 1024)}_${Math.floor(y / 1024)}`) || tiles.get(`1/${Math.floor(x / 4096)}_${Math.floor(y / 4096)}`)
  return t ? tileH(t, x, y) : 0
}

// a piece's centre line, densified like the tile worker's road strips (every <= 8 m, deck heights on bridges), on the
// ground of the tile each point is in (a piece lives in the tile of its middle and may reach into the next one)
function centre(p) {
  if (p._c) return p._c
  const pts = p.pts, n = pts.length >> 1, zs = p.z
  const X = [], Y = [], H = []
  const hw = p.w / 2
  const bends = (x0, y0, x1, y1) => { // does the ground stray from a straight line here, along the centre or a kerb?
    const l = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / l, ny = (x1 - x0) / l
    for (const o of [-hw, 0, hw]) {
      const ax = x0 + nx * o, ay = y0 + ny * o, bx = x1 + nx * o, by = y1 + ny * o
      const ha = groundH(ax, ay), hb = groundH(bx, by)
      for (const f of [0.25, 0.5, 0.75]) if (Math.abs(groundH(ax + (bx - ax) * f, ay + (by - ay) * f) - ha - (hb - ha) * f) > 0.04) return true // (the ground's 2 m offsets: a dip between the ends and the middle)
    }
    return false
  }
  const ground = (x0, y0, x1, y1, d) => { // points from (x0, y0) up to (not including) (x1, y1), halved while the ground bends
    if (d < 6 && Math.hypot(x1 - x0, y1 - y0) > 0.6 && bends(x0, y0, x1, y1)) { const mx = (x0 + x1) / 2, my = (y0 + y1) / 2; ground(x0, y0, mx, my, d + 1); ground(mx, my, x1, y1, d + 1) }
    else { X.push(x0); Y.push(y0); H.push(groundH(x0, y0)) }
  }
  for (let i = 0; i < n - 1; i++) {
    const x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[i * 2 + 2], y1 = pts[i * 2 + 3]
    const m = zs ? 1 : Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 8))
    for (let k = 0; k < m; k++) {
      const f = k / m, g = (k + 1) / m, x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f
      if (zs) { X.push(x); Y.push(y); H.push(zs[i] + (zs[i + 1] - zs[i]) * f) } else ground(x, y, x0 + (x1 - x0) * g, y0 + (y1 - y0) * g, 0)
    }
  }
  const x = pts[n * 2 - 2], y = pts[n * 2 - 1]
  X.push(x); Y.push(y); H.push(zs ? zs[n - 1] : groundH(x, y))
  const c = poly(Float32Array.from(X), Float32Array.from(Y), Float32Array.from(H))
  c.deck = !!zs
  return (p._c = c)
}
// a parallel line `off` metres to the right (mitred like the road strips), optionally reversed, lifted: on a deck over
// its centre line's height (the deck is level across), on the ground over the ground there (as the paint is drawn)
function offsetLine(c, off, rev, lift) {
  const n = c.x.length, X = new Float32Array(n), Y = new Float32Array(n), H = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const i = rev ? n - 1 - k : k, p = Math.max(0, i - 1), q = Math.min(n - 1, i + 1)
    let tx = c.x[q] - c.x[p], ty = c.y[q] - c.y[p]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl
    if (rev) { tx = -tx; ty = -ty }
    let m = 1
    if (i > 0 && i < n - 1) {
      let ax = c.x[i] - c.x[i - 1], ay = c.y[i] - c.y[i - 1]; const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al
      m = 1 / Math.max(0.5, Math.abs(-ay * -ty + ax * tx))
    }
    X[k] = c.x[i] + ty * off * m; Y[k] = c.y[i] - tx * off * m; H[k] = (c.deck ? c.h[i] : groundH(X[k], Y[k])) + lift
  }
  return poly(X, Y, H)
}

// pieces of the loaded tiles within r of the area centre: detail tiles where loaded, overview tiles elsewhere,
// each piece once (tiles assign a piece by its middle point, so a piece lives in exactly one tile per level)
function* gather(cx, cy, r, keep) {
  const out = [], seen = new Set(), r2 = r * r
  const list = [...tiles.values()].sort((a, b) => a.level - b.level)
  for (const t of list) {
    if (due()) yield
    if (Math.max(Math.abs(t.ox + t.size / 2 - cx), Math.abs(t.oy + t.size / 2 - cy)) > r + t.size / 2) continue
    for (const p of t.pieces) {
      if (!keep(p)) continue
      const m = (p.pts.length >> 2) << 1, mx = p.pts[m], my = p.pts[m + 1]
      if ((mx - cx) ** 2 + (my - cy) ** 2 > r2) continue
      if (t.level === 1 && tiles.has(`0/${Math.floor(mx / 1024)}_${Math.floor(my / 1024)}`)) continue
      const key = p.key || (p.key = `${p.a}_${p.b}_${p.kind}`)
      if (seen.has(key)) continue
      seen.add(key)
      p.tile = t
      out.push(p)
    }
  }
  return out
}
function poisOf(kinds, cx, cy, r) {
  const out = [], seen = new Set(), r2 = r * r
  for (const t of tiles.values()) for (const q of t.pois || []) {
    if (!kinds.includes(q.kind) || seen.has(q.id) || (q.x - cx) ** 2 + (q.y - cy) ** 2 > r2) continue
    seen.add(q.id); out.push(q)
  }
  return out
}
// a coarse spatial hash
function grid(cell) {
  const m = new Map()
  return {
    add(x, y, v) { const k = Math.floor(x / cell) * 65536 + Math.floor(y / cell); let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(v) },
    near(x, y, fn) { const i = Math.floor(x / cell), j = Math.floor(y / cell); for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) for (const v of m.get(a * 65536 + b) || []) fn(v) },
  }
}

// ---------------------------------------------------------------- the road network
function* buildCars() {
  const pieces = yield* gather(area.x, area.y, area.r, (p) => p.drive && p.kind <= 7 && p.pts.length >= 4)
  const nodes = new Map()
  const node = (id, x, y) => {
    let n = nodes.get(id)
    if (!n) nodes.set(id, (n = { id, x, y, deg: 0, best: 9, half: 0, deck: true, ins: [], outs: [], conns: [], ctl: null }))
    return n
  }
  for (const p of pieces) {
    if (due()) yield
    const c = centre(p), m = c.x.length - 1
    p.na = node(p.a, c.x[0], c.y[0]); p.nb = node(p.b, c.x[m], c.y[m])
    for (const n of [p.na, p.nb]) { n.deg++; n.best = Math.min(n.best, p.kind); n.half = Math.max(n.half, p.w / 2); n.deck = n.deck && !!p.z }
  }
  deckGrid = grid(16)
  for (const p of pieces) if (p.z && !p.tunnel) for (let i = 0; i < p.pts.length / 2 - 1; i++) {
    const P = p.pts, k = Math.ceil(Math.hypot(P[i * 2 + 2] - P[i * 2], P[i * 2 + 3] - P[i * 2 + 1]) / 12)
    for (let s = 0; s <= k; s++) deckGrid.add(P[i * 2] + (P[i * 2 + 2] - P[i * 2]) * s / k, P[i * 2 + 1] + (P[i * 2 + 3] - P[i * 2 + 1]) * s / k, [p, i])
  }
  const cws = new Map()
  const cw = (n, p) => { const k = n.id + ':' + p.key; let o = cws.get(k); if (!o) cws.set(k, (o = { n: 0 })); return o }
  const cutAt = (n) => n.deg >= 3 && !n.deck ? Math.max(8.4, n.half + 1.2) : n.deg >= 2 ? 2.5 : 0 // (decks only: a ramp leaving, no box)
  const lanes = []
  for (const p of pieces) {
    if (due()) yield
    // lanes each way: OSM turn lanes (turns.f a→b, turns.b b→a, left to right) say how many, else half the total
    const c = centre(p), tl = [p.turns?.f?.length ? p.turns.f : null, p.turns?.b?.length ? p.turns.b : null]
    const lanes0 = Math.max(1, p.lanes || 1), half = Math.max(1, lanes0 >> 1)
    const pers = p.oneway ? [tl[0]?.length || lanes0] : [tl[0]?.length || half, tl[1]?.length || half]
    const total = tl[0] || tl[1] ? pers.reduce((a, b) => a + b) : p.oneway ? lanes0 : Math.max(2, lanes0), lw = (p.w - 2 * parkSide(p)) / total // (cars parked along both kerbs)
    const lift = 0.18 + (18 - p.kind) * 0.004 + (c.deck ? 0.35 : 0)
    for (const dir of p.oneway ? [0] : [0, 1]) {
      const from = dir ? p.nb : p.na, to = dir ? p.na : p.nb, per = pers[dir]
      let s0 = cutAt(from), s1 = cutAt(to)
      if (s0 + s1 > c.len * 0.8) { const f = (c.len * 0.8) / (s0 + s1); s0 *= f; s1 *= f }
      for (let li = 0; li < per; li++) {
        const off = p.oneway ? (li - (per - 1) / 2) * lw : (li + 0.5) * lw
        let line = offsetLine(c, off, dir === 1, lift)
        if (s0 + s1 > 0) line = cut(line, s0, s1)
        const L = Object.assign(line, { conn: false, p, dir, li, n: per, off, lw, turn: tl[dir] ? tl[dir][li] || 4 : 0, cls: p.kind, v0: V0[p.kind], from, to, cars: [], outs: [],
          key: `${p.key}:${dir}:${li}`, cwStart: cw(from, p), cwEnd: cw(to, p), stop: false, giveWay: false, internal: false, inc: [] })
        lanes.push(L); from.outs.push(L); to.ins.push(L)
      }
    }
  }
  // the lanes of a road one way, left to right: cars change between them
  const sibs = new Map()
  for (const L of lanes) {
    const k = L.p.key + ':' + L.dir
    let a = sibs.get(k)
    if (!a) sibs.set(k, (a = []))
    a[L.li] = L; L.sib = a; L.ghosts = []
  }
  // junction stop and give-way signs: on the junction node (minor approaches, or all if equal) or just before it
  const jgrid = grid(30)
  for (const n of nodes.values()) if (n.deg >= 3) jgrid.add(n.x, n.y, n)
  for (const q of poisOf([2, 6], area.x, area.y, area.r)) {
    if (due()) yield
    let best = null, bd = 15
    jgrid.near(q.x, q.y, (n) => { const d = Math.hypot(n.x - q.x, n.y - q.y); if (d < bd) { bd = d; best = n } })
    if (!best) continue
    const flag = q.kind === 2 ? 'stop' : 'giveWay'
    if (best.id === q.id) {
      const minor = best.ins.some((L) => L.cls > best.best)
      for (const L of best.ins) if (!minor || L.cls > best.best) L[flag] = true
    } else {
      let lane = null, ld = Infinity
      for (const L of best.ins) { const m = L.x.length - 1, d = Math.hypot(L.x[m] - q.x, L.y[m] - q.y); if (d < ld) { ld = d; lane = L } }
      if (lane) for (const L of best.ins) if (L.p === lane.p && L.dir === lane.dir) L[flag] = true
    }
  }
  // connectors through every node
  for (const nd of nodes.values()) {
    if (due()) yield
    if (nd.deg === 1) continue // a dead end or the edge of the area: cars leave the simulation here
    for (const L of nd.ins) {
      const hin = endHeading(L), opts = []
      for (const M of nd.outs) {
        if (M.p === L.p) continue
        const ang = turn(hin, startHeading(M))
        if (Math.abs(ang) > 2.7) continue
        opts.push({ M, ang, type: nd.deg === 2 || Math.abs(ang) < 0.6 ? 'S' : ang > 0 ? 'L' : 'R' })
      }
      // which lanes turn where: OSM turn lanes at junctions (a movement no lane is marked for, and junctions without
      // them: left from the left lane, right from the right lane, straight on keeping the lane)
      const marked = nd.deg >= 3 && L.turn ? L.sib : null
      const ok = (o) => {
        const { M, type } = o, idx = marked ? marked.filter((S) => S.turn & MOVE[type]).map((S) => S.li) : []
        if (!idx.length) {
          o.ends = type === 'S' && L.li > M.li
          return type === 'S' ? M.li === Math.min(L.li, M.n - 1) || (L.li === L.n - 1 && M.li > L.li)
            : type === 'R' ? L.li === L.n - 1 && M.li === M.n - 1 : L.li === 0 && M.li === 0
        }
        const k = idx.indexOf(L.li)
        o.ends = type === 'S' && k > M.li
        return k >= 0 && (type === 'S' ? M.li === Math.min(k, M.n - 1) || (k === idx.length - 1 && M.li > k)
          : type === 'R' ? M.li === Math.max(0, M.n - (idx.length - k)) : M.li === Math.min(k, M.n - 1))
      }
      let use = opts.filter(ok)
      if (!use.length && opts.length) { // nowhere this lane may go: the straightest way on
        const o = opts.sort((a, b) => Math.abs(a.ang) - Math.abs(b.ang))[0]
        use = opts.filter((a) => a.M.p === o.M.p && a.M.dir === o.M.dir && a.M.li === Math.min(L.li, a.M.n - 1))
        for (const a of use) a.ends = a.type === 'S' && L.li > a.M.li
      }
      const plan = () => use.map(({ M, type, ends }) => {
        let path = junctionPath(L, M, nd)
        if (!path.ok) { // across a gap between decks: the nearest lane of that road it can reach on a deck
          const alt = M.sib.filter((S) => S !== M).sort((a, b) => Math.abs(a.li - M.li) - Math.abs(b.li - M.li)).map((S) => [S, junctionPath(L, S, nd)]).find(([, q]) => q.ok)
          if (alt) [M, path] = alt
        }
        return { M, type, ends, path }
      })
      let ways = plan()
      // none: an outer lane of a wide deck that narrows into ramps here (past its end, beside theirs, is air): it leaves
      // its lane earlier, over the wide deck
      for (let k = 0; k < 4 && ways.some((w) => !w.path.ok) && L.len > 12; k++) { Object.assign(L, cut(L, 0, 4)); ways = plan() }
      for (const { M, type, ends, path } of ways) { const c = connector(L, M, type, nd, ends, path); L.outs.push(c); nd.conns.push(c) }
    }
  }
  // paths leaving one lane different ways: how far along each its cars' bodies still overlap the other's
  for (const L of lanes) {
    if (L.outs.length < 2) continue
    if (due()) yield
    for (const c of L.outs) {
      c.part = new Map()
      for (const o of L.outs) {
        if (o === c) continue
        let k = c.x.length - 1
        while (k > 0 && distTo(o, c.x[k], c.y[k]) > NEAR + 0.3) k--
        c.part.set(o, k === c.x.length - 1 ? c.len + 3 : c.cum[k])
      }
    }
  }
  // who crosses whose path, and who gives way: inside each junction, and across the junctions of one crossing (both
  // halves of a divided road meet the cross street at two to four nodes a few metres apart, their paths overlap);
  // where lanes merge (also where a lane ends between junctions) the ending lane gives way
  const jpar = new Map(), jfind = (n) => { while (jpar.get(n) !== n) n = jpar.get(n); return n }
  // (and the nodes a few metres from them: crossings mapped just before the junction)
  for (const n of nodes.values()) jpar.set(n, n)
  for (const p of pieces) {
    const l = centre(p).len, a = p.na, b = p.nb
    if (a !== b && a.deg >= 2 && b.deg >= 2 && (a.deg >= 3 || b.deg >= 3) && (l < 15 || (a.deg >= 3 && b.deg >= 3 && l < 40))) jpar.set(jfind(a), jfind(b))
  }
  const boxes = new Map()
  for (const nd of nodes.values()) {
    if (!nd.conns.length) continue
    const r = jfind(nd)
    let b = boxes.get(r)
    if (!b) boxes.set(r, (b = { conns: [], best: 9 }))
    b.conns.push(...nd.conns); b.best = Math.min(b.best, nd.best); b.big = b.big || nd.deg >= 3
  }
  for (const { conns: C, best, big } of boxes.values()) {
    for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) {
      if (due()) yield
      const a = C[i], b = C[j]
      if (a.from === b.from || a.to === b.from || b.to === a.from) continue
      if (!(a.to === b.to || (big && crossAt(a, b) >= 0))) continue
      a.conflicts.push(b); b.conflicts.push(a)
      const pa = prio(a, best), pb = prio(b, best)
      if (pa > pb || b.from.stop || b.from.giveWay) b.yields.push(a)
      if (pb > pa || a.from.stop || a.from.giveWay) a.yields.push(b)
    }
  }
  const ctls = yield* signals(nodes, pieces)
  const entries = lanes.filter((L) => L.from.deg === 1 && L.len > 12)
  const sgrid = grid(20) // lanes and junction paths by 20 m cell, for what is in the way (blockSegs())
  for (const g of [...lanes, ...[...nodes.values()].flatMap((n) => n.conns)]) {
    if (due()) yield
    let last = null
    for (let i = 0; i < g.x.length; i++) { const k = Math.floor(g.x[i] / 20) * 65536 + Math.floor(g.y[i] / 20); if (k !== last) sgrid.add(g.x[i], g.y[i], g); last = k }
  }
  return { nodes, lanes, entries, ctls, cws, sgrid, cum: cumWeights(lanes, (L) => L.len * DENS[L.cls]), ecum: cumWeights(entries, (L) => DENS[L.cls] ** 2) }
}
const prio = (c, best) => (c.type === 'S' ? 2 : c.type === 'R' ? 1 : 0) + (c.from.cls === best ? 3 : 0) - (c.ends ? 4 : 0)

const MOVE = { L: 1 | 2 | 32, S: 2 | 4 | 8 | 64, R: 8 | 16 } // turn lane bits: left, slight left, through, slight right, right, u-turn, merge
let deckGrid = null // the deck pieces' segments by 16 m cell (buildCars()): what the junction paths to and from a deck drive on
// the lane height over the deck drawn at (x, y) nearest h (lanes ride 0.17 m over a deck strip), or null where none is
function deckUnder(x, y, h) {
  let best = null, bd = 3
  deckGrid?.near(x, y, ([p, i]) => {
    const P = p.pts, x0 = P[i * 2], y0 = P[i * 2 + 1], dx = P[i * 2 + 2] - x0, dy = P[i * 2 + 3] - y0, l2 = dx * dx + dy * dy || 1
    const f0 = ((x - x0) * dx + (y - y0) * dy) / l2, f = Math.max(0, Math.min(1, f0))
    const over = 0.05 / Math.sqrt(l2) // (the drawn deck goes on 5 cm past its end)
    if ((i === 0 && f0 < -over) || (i === p.pts.length / 2 - 2 && f0 > 1 + over)) return // past the deck's square end
    if (Math.hypot(x - x0 - dx * f, y - y0 - dy * f) > p.w / 2) return
    const z = p.z[i] + (p.z[i + 1] - p.z[i]) * f + 0.53 + (18 - p.kind) * 0.004
    if (Math.abs(z - h) < bd) { bd = Math.abs(z - h); best = z }
  })
  return best
}
// the path from lane L's end to lane M's start through a junction: { X, Y, H, ok } (ok: a deck or the ground under it all
// the way, not the gap between two ramps' decks leaving apart)
function junctionPath(L, M, nd) {
  const e = L.x.length - 1, x0 = L.x[e], y0 = L.y[e], h0 = L.h[e], x3 = M.x[0], y3 = M.y[0], h3 = M.h[0]
  const a0 = endHeading(L), a3 = startHeading(M), d = Math.hypot(x3 - x0, y3 - y0), k = d * 0.42
  const n = Math.max(2, Math.min(40, Math.ceil(d / 1.5))), X = new Float32Array(n + 1), Y = new Float32Array(n + 1), H = new Float32Array(n + 1)
  for (let i = 0; i <= n; i++) {
    const s = i / n, u = 1 - s, b0 = u * u * u, b1 = 3 * u * u * s, b2 = 3 * u * s * s, b3 = s * s * s
    X[i] = b0 * x0 + b1 * (x0 + Math.cos(a0) * k) + b2 * (x3 - Math.cos(a3) * k) + b3 * x3
    Y[i] = b0 * y0 + b1 * (y0 + Math.sin(a0) * k) + b2 * (y3 - Math.sin(a3) * k) + b3 * y3
    H[i] = h0 + (h3 - h0) * s
  }
  if (!L.p.z && !M.p.z) { // at grade: over the ground across the junction, not on a straight line from end to end
    const g0 = groundH(x0, y0), g3 = groundH(x3, y3)
    for (let i = 1; i < n; i++) H[i] += groundH(X[i], Y[i]) - (g0 + ((g3 - g0) * i) / n)
  }
  let ok = true
  if (L.p.z || M.p.z) for (let i = 1; i < n; i++) { // to or from a deck: on the deck under the point nearest the line's height, else the ground
    const d = deckUnder(X[i], Y[i], H[i])
    if (d != null) H[i] = d
    else if (!L.p.z || !M.p.z) H[i] = groundH(X[i], Y[i]) + 0.18 + (18 - M.p.kind) * 0.004
    else ok = false // (deck to deck over no deck: a gap between two ramps leaving apart)
  }
  return { X, Y, H, ok }
}
function connector(L, M, type, nd, ends, path = junctionPath(L, M, nd)) {
  const { X, Y, H } = path
  // mv: the way on (which road, which way); ends: this lane ends here and merges into the next lane over
  const c = Object.assign(poly(X, Y, H), { conn: true, node: nd, from: L, to: M, type, cars: [], conflicts: [], yields: [], reserved: 0, group: 0,
    mv: M.p.key + ':' + M.dir, ends,
    v0: type === 'S' ? Math.min(L.v0, M.v0) : type === 'R' ? 5.5 : 7, w: (type === 'S' ? 4 : 1) * (8 - M.cls) })
  M.inc.push(c)
  return c
}
// where path a first crosses path b, or else first comes within NEAR of it (metres along a), or -1. (Not at their
// ends: paths from or to one lane touch there; a crossing on a vertex counts once, on the stretch after it)
function crossAt(a, b) {
  const na = a.x.length - 1, nb = b.x.length - 1
  for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) {
    const ax = a.x[i], ay = a.y[i], bx = a.x[i + 1], by = a.y[i + 1], cx = b.x[j], cy = b.y[j], dx = b.x[j + 1], dy = b.y[j + 1]
    const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
    if (Math.abs(d) < 1e-9) continue
    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d, u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d
    if (t >= (i ? 0 : 0.02) && t < (i === na - 1 ? 0.98 : 1) && u >= (j ? 0 : 0.02) && u < (j === nb - 1 ? 0.98 : 1)) return a.cum[i] + t * (a.cum[i + 1] - a.cum[i])
  }
  return nearAt(a, b, NEAR, 1.5)
}
// the first point of path a within r of path b (metres along a), leaving out `skip` metres at the ends of both, or -1
function nearAt(a, b, r, skip = 0) {
  for (let i = 1; i < a.x.length - 1; i++) if (a.cum[i] > skip && a.len - a.cum[i] > skip && distTo(b, a.x[i], a.y[i], skip) < r) return a.cum[i]
  return -1
}
// distance from (x, y) to polyline p, leaving out `skip` metres at each end
function distTo(p, x, y, skip = 0) {
  let best = 1e9
  for (let j = 0; j < p.x.length - 1; j++) {
    if (p.cum[j + 1] < skip || p.cum[j] > p.len - skip) continue
    const x0 = p.x[j], y0 = p.y[j], dx = p.x[j + 1] - x0, dy = p.y[j + 1] - y0, f = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(x - x0 - dx * f, y - y0 - dy * f))
  }
  return best
}
// o comes the other way through the same green (the oncoming traffic of a left turn)
const opposing = (c, o) => o.group === c.group && (o.from.p !== c.from.p || o.from.dir !== c.from.dir)
function cumWeights(list, w) {
  const c = new Float64Array(list.length)
  let s = 0
  list.forEach((x, i) => { s += Math.max(0, w(x)); c[i] = s })
  return c
}
function sample(list, cum) {
  if (!list.length || !cum[cum.length - 1]) return null
  const r = Math.random() * cum[cum.length - 1]
  let lo = 0, hi = cum.length - 1
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m }
  return list[lo]
}

// ---------------------------------------------------------------- traffic signals
// Junctions with a traffic_signals node within 25 m get a controller; nearby signalled junctions (both halves of
// a divided road) share one. Two phases by approach axis (green, amber, all red), offsets along the main axis
// so the avenues get a green wave, and people walk alongside the green.
function* signals(nodes, pieces) {
  const jg = grid(30)
  for (const n of nodes.values()) if (n.deg >= 2) jg.add(n.x, n.y, n)
  for (const q of poisOf([0], area.x, area.y, area.r)) {
    let any = false
    jg.near(q.x, q.y, (n) => { if (n.deg >= 3 && Math.hypot(n.x - q.x, n.y - q.y) < 25) { n.sig = true; any = true } })
    if (!any) jg.near(q.x, q.y, (n) => { if (n.id === q.id) n.sig = true }) // a signalled crossing between junctions
  }
  const parent = new Map(), find = (n) => { while (parent.get(n) !== n) n = parent.get(n); return n }
  for (const n of nodes.values()) if (n.sig) parent.set(n, n)
  for (const p of pieces) if (p.na.sig && p.nb.sig && centre(p).len < 45) parent.set(find(p.na), find(p.nb))
  const groups = new Map()
  for (const n of parent.keys()) { const r = find(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n) }
  const ctls = []
  for (const list of groups.values()) {
    if (due()) yield
    let ref = null, best = 9, cx = 0, cy = 0
    for (const n of list) { cx += n.x / list.length; cy += n.y / list.length; for (const L of n.ins) if (L.cls < best) { best = L.cls; ref = endHeading(L) } }
    if (ref === null) continue
    const ctl = { id: ctls.length, ref, nodes: list, x: cx, y: cy, A: 3.5, C: 1.5, G: [0, 0] }
    let side = 9
    for (const n of list) {
      n.ctl = ctl
      for (const c of n.conns) { c.group = Math.abs(Math.cos(endHeading(c.from) - ref)) > 0.7 ? 0 : 1; if (c.group) side = Math.min(side, c.from.cls) }
    }
    ctl.G[0] = best <= 2 ? 30 : 24
    ctl.G[1] = side === 9 ? 14 : side <= 2 ? 26 : side <= 4 ? 20 : 15 // 12: a walk phase only
    ctl.cycle = ctl.G[0] + ctl.G[1] + 2 * (ctl.A + ctl.C)
    ctl.off = ((((cx * Math.cos(ref) + cy * Math.sin(ref)) / 11) % ctl.cycle) + ctl.cycle) % ctl.cycle
    ctls.push(ctl)
  }
  for (const n of nodes.values()) for (const L of n.ins) L.internal = !!(L.from.ctl && L.from.ctl === L.to.ctl)
  // turning left on a green: pull into the junction and wait there (hold) for a gap in the oncoming traffic, or
  // for the oncoming lights to change, rather than blocking everyone behind at the stop line
  // (hold: it stops short of the first oncoming path it crosses; IDM keeps s0 to a stop)
  for (const ctl of ctls) for (const n of ctl.nodes) for (const c of n.conns) {
    if (due()) yield
    if (c.type !== 'L' || c.from.internal) continue
    let first = c.len * 0.6
    for (const o of c.conflicts) if (opposing(c, o)) { const s = o.to === c.to ? c.len : nearAt(c, o, NEAR + 0.6); if (s >= 0) first = Math.min(first, s) } // (where its corner would reach over the other path)
    c.lt = true; c.hold = Math.max(0.5, first - 1.2) + IDM.s0
  }
  return ctls
}
// 2 green, 1 amber, 0 red
function light(ctl, g) {
  const u = (simT + ctl.off) % ctl.cycle, P = ctl.G[0] + ctl.A + ctl.C
  const v = g ? u - P : u
  if (v < 0) return 0
  const G = ctl.G[g]
  return v < G ? 2 : v < G + ctl.A ? 1 : 0
}
// may people cross a leg of axis group g? while the parallel traffic has a fresh green
function walkSign(ctl, g) {
  const o = 1 - g, u = (simT + ctl.off) % ctl.cycle, start = o ? ctl.G[0] + ctl.A + ctl.C : 0
  const v = u - start
  return v >= 0 && v < ctl.G[o] - 7
}
const axisGroup = (ctl, ang) => Math.abs(Math.cos(ang - ctl.ref)) > 0.7 ? 0 : 1

// ---------------------------------------------------------------- cars
// How busy the city is by the hour, in percent of its busiest hour: [weekdays, weekends], from midnight. Cars: the
// two rush hours, a light early morning (6:30 is under a third of the evening rush), nights nearly empty; weekends
// start late and peak in the afternoon. People: lunch and after work on weekdays, the afternoon at weekends, and
// later at night then.
const TOD = {
  car: [[6, 4, 3, 3, 4, 7, 12, 45, 88, 75, 60, 62, 68, 66, 70, 85, 97, 100, 80, 58, 42, 33, 24, 13], [10, 8, 5, 4, 3, 4, 6, 11, 20, 34, 50, 62, 70, 72, 72, 70, 66, 60, 52, 42, 34, 28, 22, 16]],
  walk: [[4, 3, 2, 2, 2, 3, 5, 22, 58, 55, 55, 68, 100, 88, 72, 78, 88, 100, 85, 65, 45, 30, 20, 10], [12, 9, 6, 3, 2, 2, 3, 8, 18, 36, 58, 75, 90, 100, 100, 95, 85, 75, 65, 55, 46, 40, 32, 20]],
}
const tod = (k) => { const a = TOD[k][opts.weekend ? 1 : 0], h = ((opts.hour % 24) + 24) % 24, i = Math.floor(h); return (a[i] + (a[(i + 1) % 24] - a[i]) * (h - i)) / 100 }
// fewer people out in the wet (opts.wet: 0 dry to 1 a downpour; the ones who are carry umbrellas), far fewer cyclists
const dry = (k) => 1 - k * Math.min(1, opts.wet || 0)
function targets() {
  const ct = tod('car'), pt = tod('walk')
  // and by place: the arterials carry the rush and what there is at night, the side streets empty as the city does
  const key = `${Math.round(ct * 50)}`
  if (net && net.todKey !== key) { net.todKey = key; net.cum = cumWeights(net.lanes, (L) => L.len * DENS[L.cls] * (L.cls <= 4 ? 1 : 0.3 + 0.7 * ct)) }
  const lanesKm = net ? net.cum[net.cum.length - 1] / 1000 : 0
  carTarget = opts.cars ? Math.min(opts.maxCars, Math.round(lanesKm * ct * opts.density)) : 0
  if (walk) {
    pedTarget = opts.people ? Math.min(opts.maxPeople - statics.length, Math.round(walk.weight * pt * dry(0.8) * opts.density)) : 0
    bikeTarget = opts.people && opts.bikes ? Math.min(300, Math.round(walk.bikeWeight * pt * dry(0.9) * opts.density)) : 0
  }
}

function newCar(cls) {
  const r = Math.random(), taxi = 0.012 + (Math.hypot(area.x - DOWNTOWN[0], area.y - DOWNTOWN[1]) < 3000 ? 0.07 : 0.02)
  const kind = r < 0.012 ? 5 : r < taxi ? 4 : r < 0.3 ? 1 : r < 0.4 ? 2 : r < (cls <= 3 ? 0.48 : 0.43) ? 3 : 0
  const color = kind === 4 ? 0xf2c21b : kind === 5 ? 0xf4f4f0 : kind === 2 ? pick(VAN) : kind === 3 ? pick(CAB) : pick(BODY)
  nextId = (nextId % 16777215) + 1 // ids stay exact as floats
  return { id: nextId, kind, L: CAR_LEN[kind], color, seed: Math.random(), vf: 0.86 + Math.random() * 0.22, seg: null, s: 0, v: 0, acc: 0, route: [], prev: null, committed: null, stopT: 0, wait: 0, k: 0 }
}
function insert(seg, car) {
  const a = seg.cars
  let i = 0
  while (i < a.length && a[i].s < car.s) i++
  a.splice(i, 0, car)
}
function remove(seg, car) { const a = seg.cars, i = a.indexOf(car); if (i >= 0) a.splice(i, 1) }
function chooseOwn(L) { // a way on from this very lane
  const outs = L.outs
  if (!outs.length) return null
  let r = 0
  for (const c of outs) r += c.w
  r *= Math.random()
  for (const c of outs) { r -= c.w; if (r <= 0) return c }
  return outs[outs.length - 1]
}
// where to go at the end of lane L: pick a way on from any lane of the road (turn left, straight, right...), then
// the lane for it nearest to L that doesn't end there; the driver changes lanes to get there
function choose(L) {
  if (L.conn || L.sib.length < 2) return chooseOwn(L)
  const a = L.sib
  if (!a.mvs) {
    const m = new Map()
    for (const S of a) for (const c of S.outs) { let o = m.get(c.mv); if (!o) m.set(c.mv, (o = { w: 0, cs: [] })); o.w = Math.max(o.w, c.w); o.cs.push(c) }
    for (const o of m.values()) { const ok = o.cs.filter((c) => !c.ends); if (ok.length) o.cs = ok }
    a.mvs = [...m.values()]
  }
  if (!a.mvs.length) return null
  let r = 0
  for (const o of a.mvs) r += o.w
  r *= Math.random()
  let mv = a.mvs[a.mvs.length - 1]
  for (const o of a.mvs) { r -= o.w; if (r <= 0) { mv = o; break } }
  let best = null, bd = 1e9
  for (const c of mv.cs) { const d = Math.abs(c.from.li - L.li) + Math.random() * 0.5; if (d < bd) { bd = d; best = c } }
  return best
}
function plan(car, need) { // keep the route planned `need` metres ahead
  let last = car.route.length ? car.route[car.route.length - 1] : car.seg, d = car.seg.len - car.s
  for (const s of car.route) if (s) d += s.len
  while (last && d < need && car.route.length < 10) {
    const nx = last.conn ? last.to : choose(last)
    car.route.push(nx)
    if (!nx) break
    d += nx.len; last = nx
  }
}
function place(car, L, s) {
  Object.assign(car, { born: simT, die: 0, seg: L, s, v: L.v0 * 0.5, route: [], prev: null, committed: null, stopT: 0, wait: 0, lc: null, lcNext: 0, lcCool: 0, hold: 0 })
  insert(L, car)
  cars.push(car)
}
function spawnCar(entry, fill) { // fill: the view is still filling (a new area): in sight too (growing in)
  if (!net) return
  if (entry) {
    const L = sample(net.entries, net.ecum)
    if (!L || (L.cars.length && L.cars[0].s - L.cars[0].L < 30) || seen(L.x[0], L.y[0], L.h[0])) return // room to come in and brake
    const car = newCar(L.cls)
    place(car, L, car.L + 0.5)
    car.v = L.v0 * 0.7
    return
  }
  for (let tries = 0; tries < 6; tries++) {
    const L = sample(net.lanes, net.cum)
    if (!L || L.len < 10 || L.block) continue
    const car = newCar(L.cls), s = car.L + Math.random() * (L.len - car.L)
    if (L.cars.some((o) => Math.abs(o.s - s) < car.L + 6) || (!fill && seen(at(L, s, tmp).x, tmp.y, tmp.h))) continue
    place(car, L, s)
    return
  }
}
function dropCar(i) {
  const car = cars[i]
  remove(car.seg, car)
  unghost(car)
  if (car.committed) car.committed.reserved--
  cars[i] = cars[cars.length - 1]; cars.pop()
}

// ---------------------------------------------------------------- lane changes
const idm = (v, v0, g, vl) => IDM.a * (1 - (v / Math.max(0.5, v0)) ** 4 - ((IDM.s0 + Math.max(0, v * IDM.T + (v * (v - vl)) / (2 * Math.sqrt(IDM.a * IDM.b)))) / Math.max(0.1, g)) ** 2)
const ease = (t) => t * t * (3 - 2 * t)
// the nearest thing ahead of s on segment L other than `me`: a car, a car moving out of the lane, an obstacle.
// [gap, its speed, hard (an obstacle: never drive into it)]
function leadOn(L, s, me) {
  let g = 1e9, v = 0, hard = false
  for (const o of L.cars) if (o !== me && o.s > s) { g = o.s - o.L - s; v = o.v; break }
  if (L.ghosts) for (const o of L.ghosts) { const os = (o.s * L.len) / o.seg.len; if (o !== me && os > s && os - o.L - s < g) { g = os - o.L - s; v = o.v } }
  if (L.block) { const b = blockAhead(L, s); if (b[0] < g) { g = b[0]; v = b[1]; hard = true } }
  return [g, v, hard]
}
function followOn(L, s, me) { // the car behind s on lane L
  let f = null
  for (const o of L.cars) { if (o.s > s) break; if (o !== me) f = o }
  return f
}
function unghost(car) {
  if (!car.lc?.ghost) return
  const a = car.lc.from.ghosts, i = a.indexOf(car)
  if (i >= 0) a.splice(i, 1)
  car.lc.ghost = false
}
function replanOwn(car) { // too late to change lanes: take a way on from this lane instead
  if (car.committed) { car.committed.reserved--; car.committed = null }
  car.route = [chooseOwn(car.seg)]
}
// may the car move into lane T? nobody there has to brake harder than b, nor the car itself
function safe(car, L, T, b) {
  if (leadOn(L, car.s, car)[0] < 2) return false // no room to pull out
  const s = (car.s * T.len) / L.len, [g, vl] = leadOn(T, s, car)
  if (g < 1.5 + car.v * 0.3 || idm(car.v, T.v0 * car.vf, g, vl) < -b) return false
  const f = followOn(T, s, car)
  if (f) { const gf = s - car.L - f.s; if (gf < 1.5 + f.v * 0.3 || idm(f.v, f.seg.v0 * f.vf, gf, car.v) < -b) return false }
  for (const o of T.ghosts) if (Math.abs((o.s * T.len) / o.seg.len - s) < o.L + car.L) return false // someone leaving T right there
  return true
}
function change(car, T) {
  const L = car.seg, g0 = leadOn(L, car.s, car)[0]
  remove(L, car)
  car.s = (car.s * T.len) / L.len; car.seg = T
  insert(T, car)
  // d: where it was, metres right of the new lane; it moves over while driving `run` metres (no sliding sideways),
  // sharper when pulling out from close behind someone (clear of their lane before reaching them)
  const run = Math.max(3, Math.min(Math.max(LC.run, car.v * LC.T), (g0 - 0.2) / 0.6))
  car.lc = { from: L, t: 0, d: L.off - T.off, run, ghost: true }
  L.ghosts.push(car)
  car.lcCool = simT + 8; lcTotal++
  const nx = car.route[0]
  if (nx && nx.from === L) { // the same way on from the new lane; the rest of the route still fits
    const c = T.outs.find((c) => c.mv === nx.mv && !c.ends) || T.outs.find((c) => c.mv === nx.mv)
    if (!c) car.route = []
    else { car.route[0] = c; if (car.route.length > 1) car.route[1] = c.to }
  }
}
// the lane of this road that leads into lane F of a road further on (lanes keep their place, counted from the
// left, or from the right for a kerb lane)
function laneFor(L, F) {
  const a = L.sib, n = a.length
  return F.n !== n && F.li === F.n - 1 && F.li > 0 ? a[n - 1] : a[Math.min(F.li, n - 1)]
}
// decide lane changes, a couple of times a second per car: into the lane the next junction's turn needs (from
// LC.zone metres before its stop line, across the short road pieces before it), else MOBIL: when it gains more
// than it costs the cars around, with a bias to keep right. Never inside junctions, near stop lines and
// crosswalks, or across the centre line
function laneChange(car) {
  const L = car.seg
  if (L.conn || L.sib.length < 2) return
  const rest = L.len - car.s
  if (car.route[0] && car.route[0].from !== L && rest < 15) return replanOwn(car) // too late
  if (car.lc || simT < car.lcNext || car.hold > simT) return
  car.lcNext = simT + 0.4 + Math.random() * 0.3
  if (car.s < 12 || rest < 15 + Math.max(LC.run, car.v * LC.T)) return
  // the lane wanted: walk the route up to the next junction within reach
  if (rest < LC.zone) plan(car, LC.zone + 10)
  const R = car.route
  let want = null, turn = false, d = rest, prev = L
  for (let i = 0; i < R.length && d < LC.zone; i += 2) {
    const c = R[i]
    if (!c) break
    if (c.from !== prev) { want = laneFor(L, c.from); break }
    if (c.node.deg >= 3) { turn = c.type !== 'S'; break }
    prev = R[i + 1]
    if (!prev) break
    d += c.len + prev.len
  }
  if (want && want !== L) { const T = L.sib[L.li + Math.sign(want.li - L.li)]; if (safe(car, L, T, LC.bmust)) change(car, T); return }
  const nx = R[0], v0 = L.v0 * car.vf, [g0, vl0, hard] = leadOn(L, car.s, car), aNow = idm(car.v, v0, g0, vl0)
  // standing behind an obstacle, or a long while (a car that was hit...): any lane will do
  const stuck = car.wait > 4 && (hard || car.wait > 20)
  if (!stuck && (want || turn || simT < car.lcCool)) return // in the lane for the turn already: stay
  const o = followOn(L, car.s, car)
  let dO = 0
  if (o) { const gb = car.s - car.L - o.s, ov0 = L.v0 * o.vf; dO = idm(o.v, ov0, g0 + car.L + gb, vl0) - idm(o.v, ov0, gb, car.v) }
  let best = null, bi = LC.th
  for (const dl of [-1, 1]) {
    const T = L.sib[L.li + dl]
    if (!T || (!stuck && nx && rest < LC.zone && !T.outs.some((c) => c.mv === nx.mv && !c.ends))) continue
    const s = (car.s * T.len) / L.len, [g1, vl1] = leadOn(T, s, car)
    let inc = idm(car.v, v0, g1, vl1) - aNow + LC.p * dO + (dl > 0 ? LC.bias : -LC.bias)
    const f = followOn(T, s, car)
    if (f) { const gf = s - car.L - f.s, fv0 = T.v0 * f.vf; inc += LC.p * (idm(f.v, fv0, gf, car.v) - idm(f.v, fv0, g1 + s - f.s, vl1)) }
    if (inc > bi && safe(car, L, T, LC.bsafe)) { bi = inc; best = T }
  }
  if (best) change(car, best)
}

// ---------------------------------------------------------------- obstacles (the player's van, a walker)
// Each obstacle blocks the stretch of every lane and junction path that passes within MARGIN of its outline
// (a lane it sits in, or two if it straddles them); followers treat it as a car they must never drive into.
function blockSegs() {
  for (const g of blocked) g.block = null
  blocked = []
  if (!net || !obstacles.size) return
  for (const o of obstacles.values()) {
    const seen = new Set()
    net.sgrid.near(o.x, o.y, (g) => {
      if (seen.has(g)) return
      seen.add(g)
      const b = blockOn(g, o)
      if (b) { if (!g.block) { g.block = []; blocked.push(g) } g.block.push(b) }
    })
  }
}
function blockOn(g, o) { // the stretch [s0, s1] of g within MARGIN of obstacle o, and o's speed along g
  const R = Math.hypot(o.len, o.w) / 2 + MARGIN
  let s0 = Infinity, s1 = -Infinity, tx = 0, ty = 0
  for (let i = 0; i < g.x.length - 1; i++) {
    const ax = g.x[i], ay = g.y[i], dx = g.x[i + 1] - ax, dy = g.y[i + 1] - ay, l2 = dx * dx + dy * dy
    if (l2 < 1e-6) continue
    const f = Math.min(1, Math.max(0, ((o.x - ax) * dx + (o.y - ay) * dy) / l2))
    if (Math.hypot(ax + dx * f - o.x, ay + dy * f - o.y) > R || (o.h != null && Math.abs(g.h[i] - o.h) > 4)) continue // (a deck above or a street below)
    const l = Math.sqrt(l2), n = Math.ceil(l / 0.5)
    for (let k = 0; k <= n; k++) {
      const px = ax + (dx * k) / n - o.x, py = ay + (dy * k) / n - o.y
      const u = Math.abs(px * o.c + py * o.s) - o.len / 2, v = Math.abs(-px * o.s + py * o.c) - o.w / 2
      if (Math.hypot(Math.max(u, 0), Math.max(v, 0)) >= MARGIN) continue
      const q = g.cum[i] + (l * k) / n
      if (q < s0) { s0 = q; tx = dx / l; ty = dy / l }
      if (q > s1) s1 = q
    }
  }
  return s0 > s1 ? null : { s0, s1, v: Math.max(0, o.speed * (o.c * tx + o.s * ty)), t: simT }
}
function blockAhead(g, s) { // [gap, speed] to the nearest obstacle on g not wholly behind s (moved on since sent)
  let gap = 1e9, v = 0
  for (const b of g.block) {
    const d = Math.min(0.5, simT - b.t) * b.v
    if (b.s1 + d <= s) continue
    if (b.s0 + d - s < gap) { gap = b.s0 + d - s; v = b.v }
  }
  return [gap, v]
}
// is (x, y) (at height h) where someone would see a car or person appear or vanish? near a player (an obstacle), or
// in the camera's view: view is its view-projection matrix (column-major, three.js world: y up, z south)
function seen(x, y, h = groundH(x, y)) {
  for (const o of obstacles.values()) if ((o.x - x) ** 2 + (o.y - y) ** 2 < SEEN * SEEN) return true
  const m = view
  if (!m) return false
  const z = -y, w = m[3] * x + m[7] * h + m[11] * z + m[15]
  if (w <= 0 || (m[11] !== 0 && w > FAR)) return false
  return Math.abs((m[0] * x + m[4] * h + m[8] * z + m[12]) / w) < 1.15 && Math.abs((m[1] * x + m[5] * h + m[9] * z + m[13]) / w) < 1.15
}
// a car leaves: at once out of sight, else it shrinks away first (stepCars() drops it)
function retire(i) { const c = cars[i]; if (!seen(c.rx, c.ry)) dropCar(i); else c.die ||= simT }
function inObstacle(x, y, h, m) {
  for (const o of obstacles.values()) {
    if (o.h != null && Math.abs(h - o.h) > 3) continue
    const px = x - o.x, py = y - o.y
    if (Math.abs(px * o.c + py * o.s) < o.len / 2 + m && Math.abs(-px * o.s + py * o.c) < o.w / 2 + m) return o
  }
  return null
}

// may this car enter junction connector c, `dist` metres ahead? (ahead: a junction after the next one, only asked)
function permit(car, c, dist, ahead) {
  if (car.committed === c) return true
  car.why = ''
  const L = c.from, nd = c.node, ctl = nd.ctl
  if (ctl && !L.internal) {
    const st = light(ctl, c.group)
    if (st === 0) return (car.why = 'red', false)
    if (st === 1 && dist > (car.v * car.v) / (2 * IDM.b) + 1.5) return (car.why = 'amber', false)
  }
  if (L.stop && car.stopT < 0.8) return (car.why = 'stop', false)
  if (L.cwEnd.n > 0 || c.to.cwStart.n > 0) return (car.why = 'ped', false)
  if (nd.deg >= 3 && !room(car, c)) return (car.why = 'box', false) // don't block the box
  if (car.stopT < 25 || ctl) { // (a deadlock breaker where no signal sorts it out: standing at the line that long)
    if (busy(c, c.lt)) return (car.why = 'conflict', false)
    for (const o of c.yields) if ((!c.lt || !opposing(c, o)) && arriving(o)) return (car.why = 'yield', false)
  }
  if (!ahead && !car.committed && dist < 2.5 + car.v * 0.4) { car.committed = c; c.reserved++ } // (one at a time: the nearest)
  return true
}
// is a path crossing c taken? (left turners waiting in the junction don't hold up the oncoming traffic; with
// opp, the oncoming traffic is no reason not to pull in either)
function busy(c, opp) {
  for (const o of c.conflicts) {
    const op = opposing(c, o)
    if (opp && op) continue
    if (o.reserved) return true
    for (const q of o.cars) if (!(q.lhold && op)) return true
  }
  return false
}
// someone with right of way about to arrive on path o?
function arriving(o) {
  const F = o.from, a = F.cars
  if (!a.length) return false
  const lead = a[a.length - 1]
  return lead.route[0] === o && lead.v > 0.8 && F.len - lead.s < 6 + lead.v * 3
}
// is there room past junction path c? A car standing (or crawling) on the way out within the car's length, after
// the cars already in the junction heading that way, means it would stop in the box and block the cross traffic
function room(car, c) {
  const R = car.route, need = car.L + 1.5
  let inb = 0, free = 0
  for (const o of c.to.inc) { for (const q of o.cars) if (q !== car) inb += q.L + 2; inb += o.reserved * 6.5 }
  for (let j = R.indexOf(c) + 1; j > 0 && j < R.length; j++) {
    const s = R[j]
    if (!s) return true
    if (s.cars.length) { const o = s.cars[0]; return o.v > 3 || free + o.s - o.L - inb >= need }
    free += s.len
    if (free - inb >= need + 20 || (s.conn && s.node.deg >= 3)) return true // plenty, or the next junction (its own rules)
  }
  return true
}
// a car on another path from the same lane as junction path c whose tail is still where the two run side by side,
// its front past s: [its tail along c, its speed], or null (part: how far along each path it runs within NEAR + a
// car's width of the other one, buildCars())
function beside(c, s) {
  let best = null
  for (const o2 of c.from.outs) {
    if (o2 === c || !o2.cars.length) continue
    const o = o2.cars[0], t = o.s - o.L
    if (o.s > s && t < (o2.part?.get(c) ?? 3) && (!best || t < best[0])) best = [t, o.v]
  }
  return best
}
// distance to what is ahead and its speed; stop: a stop line
function gap(car) {
  const seg = car.seg, a = seg.cars
  let g = 1e9, gv = 0, hard = false
  car.lhold = !!(seg.lt && car.s < seg.hold && (busy(seg, false) || seg.yields.some(arriving))) // waiting to turn left
  if (car.lhold) { g = seg.hold - car.s; hard = true }
  if (car.k < a.length - 1) { const o = a[car.k + 1]; if (o.s - o.L - car.s < g) { g = o.s - o.L - car.s; gv = o.v; hard = false } }
  if (seg.ghosts?.length || seg.block || car.lc?.ghost) {
    const r = leadOn(seg, car.s, car)
    if (r[0] < g) [g, gv, hard] = r
    if (car.lc?.ghost) { // still half in the old lane: don't touch who is ahead there (it is clear of them before it gets there)
      const F = car.lc.from, q = leadOn(F, (car.s * F.len) / seg.len, car)
      q[0] += IDM.s0 - 0.3
      if (q[0] < g) [g, gv, hard] = q
    }
  }
  if (seg.conn) { const o = beside(seg, car.s); if (o && o[0] - car.s < g) { g = o[0] - car.s; gv = o[1]; hard = false } } // (and in it)
  if (g < 1e9) return [g, gv, hard]
  let d = seg.len - car.s, prev = seg
  const look = 25 + car.v * 4
  plan(car, look + 20)
  const R = car.route
  for (let i = 0; i < R.length; i++) {
    const nx = R[i]
    if (d > look) break
    if (!nx) { // the end of the road: off it out of sight, else park there and shrink away
      const e = prev.x.length - 1
      if (!seen(prev.x[e], prev.y[e], prev.h[e])) return [1e9, 0, false]
      if (d < 4 + car.v) car.die ||= simT
      return [d - 0.6, 0, true]
    }
    if (nx.conn && !prev.conn) {
      // stop at the line, or behind a car on the path whose tail still reaches back over it
      const ln = nx.cars.length ? leadOn(nx, -1, null) : null
      const line = () => (ln && ln[0] - 1 < -0.6 ? [d + ln[0] - 1, ln[1], ln[2]] : [d - 0.6, 0, true])
      // an obstacle in the junction or just past it: don't enter
      if (nx.block || (nx.to.block && blockAhead(nx.to, 0)[0] < car.L + 2)) return line()
      // a lane too short to wait on between two junctions: the second must be clear before entering the first
      const nx2 = R[i + 2]
      if (car.committed !== nx && nx.to.len < car.L + 4 && nx2?.conn && !permit(car, nx2, d + nx.len + nx.to.len, true)) return line()
      if (!permit(car, nx, d)) return line()
      // someone who just turned off this lane another way is still in front (until the paths part)
      const o = beside(nx, -1e9)
      if (o) return [d + o[0], o[1], false]
    }
    if (nx.cars.length || nx.ghosts?.length || nx.block) { const r = leadOn(nx, -1, null); if (r[0] < 1e9) return [d + r[0] - 1, r[1], r[2]] }
    d += nx.len; prev = nx
  }
  return [1e9, 0, false]
}
function stepCars(dt) {
  stamp++
  for (const car of cars) laneChange(car)
  for (const car of cars) {
    const seg = car.seg
    if (seg.stamp !== stamp) { seg.stamp = stamp; seg.cars.sort((p, q) => p.s - q.s); for (let k = 0; k < seg.cars.length; k++) seg.cars[k].k = k }
  }
  for (const car of cars) {
    const [g, vl, stop] = gap(car)
    let v0 = car.seg.v0 * car.vf
    const nx = car.route[0]
    if (nx && nx.v0 < v0) v0 = Math.min(v0, Math.sqrt(nx.v0 * nx.v0 * car.vf * car.vf + 2 * 1.2 * Math.max(0, car.seg.len - car.s))) // slow for the turn ahead
    const v = car.v, ss = IDM.s0 + Math.max(0, v * IDM.T + (v * (v - vl)) / (2 * Math.sqrt(IDM.a * IDM.b)))
    car.acc = car.hold > simT ? -8 : Math.max(-8, IDM.a * (1 - (v / Math.max(0.5, v0)) ** 4 - (ss / Math.max(0.1, g)) ** 2))
    car.stopAt = stop ? car.s + Math.max(0, g) : Infinity
  }
  for (let i = cars.length - 1; i >= 0; i--) {
    const car = cars[i]
    const v = Math.max(0, car.v + car.acc * dt)
    car.s += Math.max(0, ((car.v + v) / 2) * dt); car.v = v
    if (car.s > car.stopAt) { car.s = car.stopAt; car.v = 0 }
    car.wait = car.v < 0.3 ? car.wait + dt : 0
    car.stopT = car.v < 0.3 && car.seg.len - car.s < 3 ? car.stopT + dt : car.v > 2 ? 0 : car.stopT
    if (car.die && simT - car.die > FADE) { dropCar(i); continue } // shrunk away
    if (car.wait > 50 && !car.die) { stuck++; retire(i); if (cars[i] !== car) continue } // hopelessly stuck: clear it
    if (car.lc) { // sideways into the new lane as it drives on
      const lc = car.lc
      lc.t += (car.v * dt) / lc.run
      if (ease(lc.t) > 0.6) unghost(car)
      if (lc.t >= 1) car.lc = null
    }
    let gone = false
    while (car.s > car.seg.len) {
      const old = car.seg
      if (!car.route.length) plan(car, 1)
      if (car.route[0]?.from !== old && !old.conn) replanOwn(car) // never jump sideways into another lane's turn
      unghost(car)
      const nx = car.route.shift()
      if (!nx) { dropCar(i); gone = true; break } // drove off the edge of the area
      remove(old, car)
      car.s -= old.len; car.prev = old; car.seg = nx; car.stopT = 0
      if (car.committed === nx) { nx.reserved--; car.committed = null }
      insert(nx, car)
    }
    if (gone) continue
  }
  // a leader that stopped dead (a red line, a hold) can leave the car behind it overlapping with no room to brake, and
  // IDM then waits for a gap that never opens: back the follower off to a bumper's gap
  for (const car of cars) {
    const o = car.seg.cars[car.seg.cars.indexOf(car) + 1]
    if (!o || car.lc || o.lc || o.s - o.L - car.s > -0.2) continue
    const s = o.s - o.L - 0.3
    if (s >= 0) { car.s = s; car.v = Math.min(car.v, o.v) }
  }
  if (net) {
    const want = carTarget
    if (cars.length < want * 0.85) for (let k = 0; k < 40 && cars.length < want; k++) spawnCar(false, cars.length < want * 0.5)
    else if (cars.length < want) for (let k = 0; k < 3; k++) spawnCar(true)
    else if (cars.length > want * 1.25) { const i = (Math.random() * cars.length) | 0; if (!seen(cars[i].rx, cars[i].ry)) dropCar(i) }
  }
}

// ---------------------------------------------------------------- people
// sidewalk centre offset of a street whose sidewalks the core paves (piece.band; tools/tiles.py: a boulevard on
// tertiary and residential streets, then a 3 m walk on primary and secondary, 2 m elsewhere; 2 m on bridge decks)
function sidewalk(p) {
  if (!p.band || p.kind < 2 || p.kind > 7 || p.kind === 6) return 0
  if (p.z) return p.w / 2 + 1
  return p.w / 2 + (p.kind === 4 || p.kind === 5 ? 2.2 : 0) + (p.kind <= 3 ? 1.5 : 1)
}
const FOOT = new Set([8, 9, 11, 12, 13])
const xsOf = (w, side) => (w.off ? w.xsS && w.xsS[side > 0 ? 1 : 0] : w.xs) // the stretches of w across streets, for someone on that side of it
const okSide = (w, s) => (s > 0 ? w.okL : w.okR) // may people walk on this side of w (+1 left of a→b)?
function* buildWalk() {
  const r = area.vr + 250
  let pieces = yield* gather(area.vx, area.vy, r, (p) => p.pts.length >= 4 && (FOOT.has(p.kind) || p.kind === 10 || sidewalk(p) > 0))
  // which sides of a street people walk: not the side facing the other half of a divided road (the median), nor
  // where the sidewalk is mapped as a footway of its own alongside (people walk that instead)
  const fg = grid(32)
  const lineOf = (p, kind) => {
    const c = centre(p)
    for (let i = 0; i < c.x.length - 1; i++) {
      const dx = c.x[i + 1] - c.x[i], dy = c.y[i + 1] - c.y[i], l = Math.hypot(dx, dy) || 1, n = Math.ceil(l / 4)
      for (let k = 0; k < n; k++) fg.add(c.x[i] + (dx * k) / n, c.y[i] + (dy * k) / n, [dx / l, dy / l, c.x[i] + (dx * k) / n, c.y[i] + (dy * k) / n, kind, p])
    }
  }
  // every carriageway, the ones the simulated cars keep off too (a bus loop, a busway, a private road: the player's
  // bus drives there, and people walked along them as if they were paths)
  const streets = yield* gather(area.vx, area.vy, r, (p) => p.kind <= 7 && p.pts.length >= 4)
  for (const p of pieces) { if (due()) yield; if (p.kind === 9 || p.kind === 8) lineOf(p, 1) }
  // the streets at each node, by their own ends (not the car network's: it leaves out the streets cars keep off)
  const roadsAt = new Map()
  for (const p of streets) {
    const c = centre(p), d = Math.min(4, c.len / 2)
    for (const e of [0, 1]) { at(c, e ? c.len - d : d, tmp); const i = e ? c.x.length - 1 : 0, id = e ? p.b : p.a, a = roadsAt.get(id) || []; a.push({ p, ang: Math.atan2(tmp.y - c.y[i], tmp.x - c.x[i]) }); roadsAt.set(id, a) }
  }
  for (const p of streets) { if (due()) yield; if (p.oneway) lineOf(p, 0) }
  for (const p of pieces) {
    if (due()) yield
    if (p._sides || !sidewalk(p)) continue
    const c = centre(p), hw = p.w / 2, hit = [0, 0]
    let tried = 0
    for (let u = Math.min(6, c.len / 2); u < c.len; u += 10) {
      at(c, u, tmp); tried++
      const side = [false, false]
      fg.near(tmp.x, tmp.y, (q) => {
        if (q[5] === p) return
        const dot = q[0] * tmp.tx + q[1] * tmp.ty
        if (Math.abs(dot) < 0.9) return
        const ox = q[2] - tmp.x, oy = q[3] - tmp.y, a = -ox * tmp.ty + oy * tmp.tx, d = Math.abs(a)
        if (Math.abs(ox * tmp.tx + oy * tmp.ty) > 8) return
        if (q[4] ? d > hw - 0.5 && d < hw + 9 : p.oneway && dot < 0 && d > 2 && d < 30) side[a > 0 ? 0 : 1] = true
      })
      if (side[0]) hit[0]++
      if (side[1]) hit[1]++
    }
    p._sides = hit.map((h) => !(tried && h / tried >= 0.4)) // [left, right]
  }
  pieces = pieces.filter((p) => FOOT.has(p.kind) || p.kind === 10 || (sidewalk(p) > 0 && (p._sides[0] || p._sides[1])))
  // a footway mapped through a building (an indoor mall's corridor, a path drawn across a block's footprint): nobody
  // walks it, 3 m or more of it being over 0.8 m inside walls (decks and tunnels are over or under the buildings)
  const outside = []
  for (const p of pieces) {
    if (due()) yield
    let ok = true
    if (FOOT.has(p.kind) && !p.z && !p.tunnel) {
      const c = centre(p)
      for (let u = 0, run = 0; ok && u <= c.len; u += 1.5) { at(c, u, tmp); const o = wallOut(tmp.x, tmp.y, 0); run = o && Math.hypot(o.x, o.y) > 0.8 ? run + 1 : 0; ok = run < 3 }
    }
    if (ok) outside.push(p)
  }
  pieces = outside
  const nodes = new Map(), wps = []
  const node = (id, x, y) => { let n = nodes.get(id); if (!n) nodes.set(id, (n = { id, x, y, legs: [], bikes: [] })); return n }
  const dt = (x, y) => { const d = Math.hypot(x - DOWNTOWN[0], y - DOWNTOWN[1]); return 1 + 2.5 * Math.exp(-d / 1500) }
  const day = tod('walk'), we = opts.weekend ? 1 : 0 // (at weekends: the parks and paths more than the sidewalks)
  // the carriageways, every 3 m: footways that run into them (OSM draws many sidewalks inside the paved width) move
  // out to the kerb, and where a path crosses one that stretch is walked only while crossing
  const rg = grid(32)
  for (const p of streets) {
    if (due()) yield
    const c = centre(p)
    for (let i = 0; i < c.x.length - 1; i++) {
      const dx = c.x[i + 1] - c.x[i], dy = c.y[i + 1] - c.y[i], l = Math.hypot(dx, dy) || 1, n = Math.ceil(l / 3)
      for (let k = 0; k <= n; k++) rg.add(c.x[i] + (dx * k) / n, c.y[i] + (dy * k) / n, [dx / l, dy / l, c.x[i] + (dx * k) / n, c.y[i] + (dy * k) / n, p])
    }
  }
  for (const p of pieces) {
    if (due()) yield
    const off = sidewalk(p), bike = p.kind === 10, c = off || bike ? centre(p) : kerbed(p, rg)
    const lift = off ? 0.12 + (c.deck ? 0.3 : 0) : 0.18 + (18 - p.kind) * 0.004 - 0.03 + (c.deck ? 0.35 : 0)
    const m = c.x.length >> 1, mx = c.x[m], my = c.y[m]
    const per = (off ? (p.kind <= 3 ? 0.03 : 0.012) * 2 : p.kind === 8 ? 0.07 : p.kind === 9 ? 0.03 : p.kind === 12 ? 0.008 : 0.016 * (0.3 + day)) * (we ? (off ? 0.8 : 1.4) : 1)
    const wp = { p, c, off, bike, lift, w: p.w, okL: !off || p._sides[0], okR: !off || p._sides[1], na: node(p.a, c.x[0], c.y[0]), nb: node(p.b, c.x[c.x.length - 1], c.y[c.y.length - 1]), legs: [null, null],
      weight: bike ? 0 : c.len * per * dt(mx, my), bikeWeight: bike ? c.len * 0.004 * dt(mx, my) : 0 }
    if (!off && !bike) wp.xs = crossings(c, rg, p)
    else if (off) wp.xsS = [crossings(c, rg, p, -off), crossings(c, rg, p, off)] // [right, left of a→b]
    wps.push(wp)
    for (const e of [0, 1]) {
      const n = e ? wp.nb : wp.na
      at(c, e ? c.len - Math.min(4, c.len / 2) : Math.min(4, c.len / 2), tmp)
      const leg = { wp, end: e, ang: Math.atan2(tmp.y - n.y, tmp.x - n.x), band: off > 0, cut: 0, n }
      wp.legs[e] = leg
      ;(bike ? n.bikes : n.legs).push(leg)
    }
  }
  // corners: between neighbouring sidewalk legs (counter-clockwise); footways join the corner they point into
  for (const n of nodes.values()) {
    if (due()) yield
    const cn = net?.nodes.get(n.id)
    n.car = cn && cn.deg >= 2 ? cn : null
    const roads = roadsAt.get(n.id) || []
    n.dX = roads.length >= 3 ? 5.6 : 0
    const bands = n.legs.filter((l) => l.band).sort((a, b) => a.ang - b.ang)
    n.bands = bands
    // the streets meeting here (their carriageways): corners sit where the sidewalks clear them, footways stop at
    // the kerb (a crossing's footway, which lies on the street, is walked to the end while crossing)
    n.roads = roads
    let reach = Math.max(0, ...bands.map((l) => l.wp.off))
    for (const q of roads) reach = Math.max(reach, q.p.w / 2 + 0.8)
    for (const l of n.legs) {
      let cut = l.band ? n.dX : l.wp.p.crossing ? 0 : reach
      if (l.band) for (const q of roads) {
        if (q.p === l.wp.p) continue
        const th = l.ang - q.ang, sn = Math.abs(Math.sin(th))
        if (sn > 0.34) cut = Math.max(cut, (q.p.w / 2 + 0.8 + l.wp.off * Math.abs(Math.cos(th))) / sn)
      }
      l.cut = Math.min(cut, l.wp.c.len * 0.45)
      l.k = bands.indexOf(l)
    }
    n.corners = bands.length ? bands.map(() => []) : [[]]
    for (let k = 0; k < bands.length; k++) { n.corners[k].push({ leg: bands[k], side: 1 }); n.corners[(k + 1) % bands.length].push({ leg: bands[(k + 1) % bands.length], side: -1 }) }
    for (const l of n.legs) {
      if (l.band) continue
      let k = 0
      if (bands.length > 1) { k = bands.length - 1; for (let i = 0; i < bands.length; i++) if (l.ang > bands[i].ang) k = i }
      l.corner = k; n.corners[k].push({ leg: l, side: 0 })
    }
    // may people cross here? at junctions, and where a crossing or signal is mapped
    n.crossOK = n.dX > 0
  }
  for (const q of poisOf([0, 1, 7, 8], area.vx, area.vy, r)) { const n = nodes.get(q.id); if (n) n.crossOK = true }
  for (const n of nodes.values()) if (!n.car) n.crossOK = false
  const foot = wps.filter((w) => !w.bike), cycl = wps.filter((w) => w.bike)
  if (due()) yield
  // benches and bus stops, facing the nearest path or street
  const near = grid(25)
  for (const w of wps) for (let i = 0; i < w.c.x.length; i++) near.add(w.c.x[i], w.c.y[i], w)
  const face = (x, y) => {
    let bd = 1e9, bx = 0, by = 0
    near.near(x, y, (w) => { for (let i = 0; i < w.c.x.length; i++) { const d = (w.c.x[i] - x) ** 2 + (w.c.y[i] - y) ** 2; if (d < bd) { bd = d; bx = w.c.x[i]; by = w.c.y[i] } } })
    return bd < 1e9 ? Math.atan2(by - y, bx - x) : Math.random() * 6.28
  }
  // a bench stands beside the nearest path or sidewalk, square to it and facing it, clear of its paving (OSM maps
  // many on the path's own line or at its edge: facing the nearest point of the line they stood on it at any angle)
  let scans = 0
  const beside = (q) => {
    let x = q.x, y = q.y, ang = null
    for (let k = 0; k < 4; k++) { // (where paths meet: clear of each of them)
      let b = null // the path whose paving it stands deepest in, else the one whose edge is nearest
      const scan = ++scans
      near.near(x, y, (w) => {
        if (w._scan === scan) return // (it is in the grid once per point of its line)
        w._scan = scan
        const X = w.c.x, Y = w.c.y, need = w.off ? w.off + 1.3 : w.w / 2 + 0.5
        for (let i = 0; i < X.length - 1; i++) {
          const dx = X[i + 1] - X[i], dy = Y[i + 1] - Y[i], l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - X[i]) * dx + (y - Y[i]) * dy) / l2))
          const px = X[i] + dx * t, py = Y[i] + dy * t, d = Math.hypot(x - px, y - py)
          if (d > 12 || (b && d - need >= b.d - b.need)) continue
          const l = Math.sqrt(l2), side = (x - px) * -dy + (y - py) * dx >= 0 ? 1 : -1
          b = { d, need, px, py, nx: (side * -dy) / l, ny: (side * dx) / l }
        }
      })
      if (!b) break
      ang = Math.atan2(-b.ny, -b.nx)
      if (b.d >= b.need - 0.01) break
      x = b.px + b.nx * b.need; y = b.py + b.ny * b.need
    }
    if (ang == null) ang = (q.id % 628) / 100 // (no path within 12 m: any way round)
    return wallOut(x, y, 0.3) ? { x: q.x, y: q.y, ang } : { x, y, ang } // (moved into a wall: as mapped)
  }
  const benches = poisOf([4], area.vx, area.vy, r).filter((q) => !wallOut(q.x, q.y, 0)).map( // (not the ones mapped indoors, on a roof terrace)
    (q) => { const b = beside(q); return { x: b.x, y: b.y, h: groundH(b.x, b.y) + 0.1, ang: b.ang, id: q.id } })
  const stops = poisOf([5], area.vx, area.vy, r).map((q) => ({ x: q.x, y: q.y, h: groundH(q.x, q.y) + 0.13, ang: face(q.x, q.y), id: q.id }))
  return { nodes, foot, cycl, cum: cumWeights(foot, (w) => w.weight), bcum: cumWeights(cycl, (w) => w.bikeWeight),
    weight: foot.reduce((s, w) => s + w.weight, 0), bikeWeight: cycl.reduce((s, w) => s + w.bikeWeight, 0), benches, stops, rg }
}
const KERB = 0.8 // people keep this far from a carriageway's edge unless crossing
// a path's line moved out of the carriageways it runs alongside (to a metre past the kerb)
function kerbed(p, rg) {
  const c = centre(p), n = c.x.length, X = Float32Array.from(c.x), Y = Float32Array.from(c.y)
  if (c.deck) return c
  let moved = false
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), l = Math.hypot(c.x[b] - c.x[a], c.y[b] - c.y[a]) || 1, tx = (c.x[b] - c.x[a]) / l, ty = (c.y[b] - c.y[a]) / l
    rg.near(X[i], Y[i], (q) => {
      if (q[4].z || Math.abs(q[0] * tx + q[1] * ty) < 0.8) return
      const ox = X[i] - q[2], oy = Y[i] - q[3]
      if (Math.abs(ox * q[0] + oy * q[1]) > 2) return
      const s = -ox * q[1] + oy * q[0], need = q[4].w / 2 + KERB + 0.3
      if (Math.abs(s) < need) { const k = (s >= 0 ? need : -need) - s; X[i] -= q[1] * k; Y[i] += q[0] * k; moved = true }
    })
  }
  if (!moved) return c
  const H = new Float32Array(n)
  for (let i = 0; i < n; i++) H[i] = groundH(X[i], Y[i])
  return Object.assign(poly(X, Y, H), { deck: false, kerbed: true })
}
// the stretches [u0, u1] of a path's line inside a carriageway, with the street, its direction and the junction
// node the cars stop at for people there (the path's own end on the street, else the street's nearer end)
function crossings(c, rg, fp, off = 0) {
  const xs = []
  let cur = null
  for (let u = 0; u <= c.len + 0.5; u += 1) {
    at(c, Math.min(u, c.len), tmp)
    if (off) { tmp.x -= tmp.ty * off; tmp.y += tmp.tx * off }
    let hit = null
    rg.near(tmp.x, tmp.y, (q) => {
      if (hit || !!q[4].z !== c.deck || (off && q[4] === fp)) return
      const ox = tmp.x - q[2], oy = tmp.y - q[3]
      if (Math.abs(ox * q[0] + oy * q[1]) <= 1.6 && Math.abs(-ox * q[1] + oy * q[0]) < q[4].w / 2 + KERB) hit = q
    })
    if (!hit) continue
    if (cur && u - cur.u1 <= 2.5) cur.u1 = u
    else xs.push((cur = { u0: u, u1: u, p: hit[4], ang: Math.atan2(hit[1], hit[0]), x: tmp.x, y: tmp.y }))
  }
  for (const I of xs) {
    I.u0 = Math.max(0, I.u0 - 0.5); I.u1 = Math.min(c.len, I.u1 + 0.5)
    I.node = stopNode(I.p, I.x, I.y, net && (net.nodes.get(fp.a) || net.nodes.get(fp.b)))
    I.leg = { ang: I.ang, wp: { p: I.p } } // (as mayCross reads a leg)
  }
  return xs.length ? xs : null
}
// the junction where cars stop for people crossing street P at (x, y): `own` if P runs through it, else P's
// nearer end within 30 m
function stopNode(P, x, y, own) {
  if (own && own.deg >= 2 && [...own.ins, ...own.outs].some((L) => L.p === P)) return own
  const e = [P.na, P.nb].filter(Boolean).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0]
  return e && Math.hypot(e.x - x, e.y - y) < 30 ? e : null
}
// someone about to wait for a street who stands on its paving (OSM's crossings start where the kerb really is, the
// streets are drawn a little wider): a step or two back the way they came
function kerbside(p) {
  const bx = -Math.cos(p.ang) * 0.5, by = -Math.sin(p.ang) * 0.5
  for (let k = 0; k < 6 && inRoad(p.x, p.y); k++) { p.x += bx; p.y += by }
}
// someone standing within m metres of a carriageway's edge (or on it): out to that far from it
function standBack(p, m) {
  for (let k = 0; k < 3; k++) {
    let hit = null, hs = 0
    walk.rg.near(p.x, p.y, (q) => {
      if (hit || q[4].z) return
      const ox = p.x - q[2], oy = p.y - q[3], s = -ox * q[1] + oy * q[0]
      if (Math.abs(ox * q[0] + oy * q[1]) <= 1.6 && Math.abs(s) < q[4].w / 2 + m) { hit = q; hs = s }
    })
    if (!hit) return
    const d = (hs >= 0 ? 1 : -1) * (hit[4].w / 2 + m) - hs
    p.x -= hit[1] * d; p.y += hit[0] * d
  }
}
// the carriageway (a road sample of walk.rg) at a point, if any
function inRoad(x, y) {
  let hit = null
  walk.rg.near(x, y, (q) => {
    if (hit || q[4].z) return
    const ox = x - q[2], oy = y - q[3]
    if (Math.abs(ox * q[0] + oy * q[1]) <= 1.6 && Math.abs(-ox * q[1] + oy * q[0]) < q[4].w / 2 + KERB) hit = q
  })
  return hit
}
// people on the benches and at the bus stops: each seat keeps its person; one who comes or goes in sight waits until
// out of it (the first time round, with nobody there yet, they all come)
function makeStatics() {
  const old = new Map(statics.map((p) => [p.key, p])), first = !statics.length
  statics = []
  const sit = (key, p) => {
    const q = old.get(key)
    if (q) { old.delete(key); statics.push(q) } else if (first || !seen(p.x, p.y, p.h)) statics.push(Object.assign(p, { key }))
  }
  const seeded = (id) => { let a = id % 2147483647; return () => { a = (a * 48271) % 2147483647; return a / 2147483647 } }
  if (!walk || !opts.people) return
  const day = tod('walk')
  const rnd = (id, k) => { const x = Math.sin(id * 0.0001 + k * 12.9898) * 43758.5453; return x - Math.floor(x) }
  for (const b of walk.benches) {
    if (rnd(b.id, 1) > (0.04 + 0.66 * day) * dry(0.95)) continue // (nobody sits in the rain)
    const two = rnd(b.id, 2) < 0.35
    for (const side of two ? [-0.45, 0.45] : [(rnd(b.id, 3) - 0.5) * 0.8]) {
      const ax = Math.cos(b.ang), ay = Math.sin(b.ang)
      sit(`b${b.id}:${side}`, person(b.x + ay * side - ax * 0.05, b.y - ax * side - ay * 0.05, b.h, b.ang, 2, seeded(b.id + side * 7)))
    }
  }
  for (const s of walk.stops) {
    const n = Math.floor(rnd(s.id, 4) * (0.6 + 4 * day)) // (nobody at most stops at night, one here and there at dawn)
    for (let i = 0; i < n; i++) {
      const a = rnd(s.id, 5 + i) * 6.28, d = 0.6 + rnd(s.id, 9 + i) * 1.4
      const p = person(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, s.h, s.ang + (rnd(s.id, 13 + i) - 0.5) * 1.2, 1, seeded(s.id + i))
      standBack(p, 1.4) // the stop's pole is at the kerb: they wait well back from it
      outdoors(p) // (a stop by a wall)
      sit(`s${s.id}:${i}`, p)
    }
  }
  for (const p of old.values()) if (seen(p.x, p.y, p.h)) statics.push(p)
  if (statics.length > opts.maxPeople / 3) statics.length = Math.floor(opts.maxPeople / 3)
}
function person(x, y, h, ang, pose, r = Math.random) {
  const shirt = SHIRT[(r() * SHIRT.length) | 0], pants = PANTS[(r() * PANTS.length) | 0], seed = r(), phase = r() * 6.28, v = 1.05 + r() * 0.5
  const jog = pose === 0 && seed >= 0.58 && seed < 0.7 // the jogger outfit (models.js WEARS): three times the walking pace, a longer stride per metre
  return { id: nextPid++, x, y, h, ang, pose, shirt, pants, seed, phase, v: jog ? v * 3 : v, pk: jog ? 2.2 : 4.2, life: 60 + r() * 300 }
}

// where a person stands at the end of a leg: the corner of the sidewalk (side +1 left of the leg looking out)
function portPos(leg, side, lat, o) {
  const w = leg.wp, c = w.c, u = leg.end ? c.len - leg.cut : leg.cut
  at(c, u, o)
  const ps = side * (leg.end ? -1 : 1), off = ps * w.off + lat
  o.x += -o.ty * off; o.y += o.tx * off; o.h += w.lift
  return o
}
function startWalk(p, leg, side) {
  const w = leg.wp, other = w.legs[1 - leg.end]
  p.wp = w; p.dir = leg.end ? -1 : 1; p.side = side * (leg.end ? -1 : 1)
  p.u = leg.end ? w.c.len - leg.cut : leg.cut
  p.uEnd = leg.end ? other.cut : w.c.len - other.cut
  // (never into the kerb strip: a sidewalk 1 m from the paving, a footway moved out to the kerb)
  p.lat = (Math.random() - 0.5) * (w.off ? Math.min(0.9, 2 * (w.off - w.p.w / 2 - KERB - 0.05)) : w.c.kerbed ? 0.5 : Math.max(0.2, w.w - 1.2))
  p.mode = 'walk'
}
function hop(p, o, then) {
  p.hx0 = p.x; p.hy0 = p.y; p.hh0 = p.h; p.hx1 = o.x; p.hy1 = o.y; p.hh1 = o.h
  p.hlen = Math.hypot(o.x - p.x, o.y - p.y); p.ht = 0; p.mode = 'hop'; p.then = then
}
// may this person cross `leg` (a street) at node n now?
function mayCross(n, leg) {
  const cn = n.car
  if (!cn) return true
  if (cn.ctl) return walkSign(cn.ctl, axisGroup(cn.ctl, leg ? leg.ang : endHeading(cn.ins[0] || cn.outs[0])))
  for (const L of cn.ins) {
    if (leg && L.p !== leg.wp.p) continue
    const a = L.cars
    if (a.length) { const o = a[a.length - 1]; if ((o.v > 0.5 && L.len - o.s < 5 + o.v * 2.5) || (o.wait > 3 && L.len - o.s < 8)) return false } // (or has waited for people a while: its turn)
  }
  for (const c of cn.conns) if ((c.cars.length || c.reserved) && (!leg || c.from.p === leg.wp.p || c.to.p === leg.wp.p)) return false
  return true
}
// is something the player drives on the stretch of street from (x0, y0) to (x1, y1), or about to pass over it (within
// four seconds at its speed)? People wait at the kerb for it as they do for the cars
function playerComing(x0, y0, x1, y1, h) {
  for (const o of obstacles.values()) {
    if (o.len < 2 || (o.h != null && Math.abs(h - o.h) > 3)) continue // (a vehicle, at this level)
    for (let k = 0; k <= 2; k++) {
      const px = x0 + ((x1 - x0) * k) / 2 - o.x, py = y0 + ((y1 - y0) * k) / 2 - o.y, along = px * o.c + py * o.s
      if (Math.abs(-px * o.s + py * o.c) < o.w / 2 + 1.5 && along > -o.len / 2 - 1 && along < o.len / 2 + 2 + o.speed * 4) return true
    }
  }
  return false
}
function crosswalk(n, leg) { return n.car ? net.cws.get(n.car.id + ':' + leg.wp.p.key) : null }
function arrive(p, leg, side) {
  const n = leg.n
  if (p.xin && !inRoad(p.x, p.y)) leaveX(p) // across: off the street (cars may go)
  if (n.legs.length === 1 && Math.hypot(n.x - area.vx, n.y - area.vy) > area.vr) { p.dead = true; return }
  const ci = side === 0 ? leg.corner : side > 0 ? leg.k : (leg.k - 1 + n.bands.length) % n.bands.length
  const corner = n.corners[ci] || n.corners[0]
  const nb = n.bands.length
  if (n.crossOK && nb >= 2 && Math.random() < 0.45) {
    const opts = [n.bands[ci], n.bands[(ci + 1) % nb]].filter((l) => l !== p.crossed && portOK(l, 1) && portOK(l, -1))
    const X = opts[(Math.random() * opts.length) | 0]
    if (X) {
      leaveX(p)
      const sX = X === n.bands[ci] ? 1 : -1
      portPos(X, sX, 0, tmp2)
      hopAt(p, n, tmp2, () => { p.mode = 'wait'; p.waitT = 0; p.cross = X; p.crossSide = sX; p.ang = X.ang + (sX > 0 ? -Math.PI / 2 : Math.PI / 2) })
      return
    }
  }
  p.crossed = null
  let ports = corner.filter((q) => (q.leg !== leg || (q.side !== side && n.crossOK)) && portOK(q.leg, q.side)) // (the other side of their own street: only where people cross)
  if (!ports.length) ports = [{ leg, side }] // nowhere to go on from this corner: back the way they came
  const q = ports[(Math.random() * ports.length) | 0]
  startWalkFrom(p, q.leg, q.side)
}
// may people stand at this end of a leg on that side (looking out from the node)?
const portOK = (leg, side) => !side || okSide(leg.wp, side * (leg.end ? -1 : 1))
function startWalkFrom(p, leg, side) {
  const x = p.x, y = p.y, h = p.h
  startWalk(p, leg, side)
  pedPos(p)
  const o = { x: p.x, y: p.y, h: p.h }
  p.x = x; p.y = y; p.h = h
  if (Math.hypot(o.x - x, o.y - y) > 0.3) hopAt(p, leg.n, o, () => { p.mode = 'walk' })
  else p.mode = 'walk'
}
// a step round a corner of node n; across a street that has no sidewalk legs here (a side street, a service road),
// as a crossing: wait for it, then cross with the cars at the junction waiting
// (also onto a path that starts out on the street: OSM's crossings often begin inside the paved width)
function hopAt(p, n, o, then) {
  if (p.xin || p.xing) return hop(p, o, then)
  let leg = null, cn = n.car
  for (const r of n.roads) {
    const dx = Math.cos(r.ang) * 40, dy = Math.sin(r.ang) * 40, ex = o.x - p.x, ey = o.y - p.y, d = ex * dy - ey * dx
    if (Math.abs(d) < 1e-9) continue
    const t = ((n.x - p.x) * dy - (n.y - p.y) * dx) / d, u = ((n.x - p.x) * ey - (n.y - p.y) * ex) / d
    if (t > 0 && t < 1 && u >= 0 && u < 1) { leg = { ang: r.ang, wp: { p: r.p } }; break }
  }
  // (or the step ends on a street, or passes over the paving of one: a corner cut short, a node the streets' graph has no junction at)
  if (!leg) for (const f of [1, 0.5, 0.25, 0.75]) {
    const x = p.x + (o.x - p.x) * f, y = p.y + (o.y - p.y) * f, q = inRoad(x, y)
    if (q && (f === 1 || Math.abs(-(x - q[2]) * q[1] + (y - q[3]) * q[0]) < q[4].w / 2)) { leg = { ang: Math.atan2(q[1], q[0]), wp: { p: q[4] } }; cn = stopNode(q[4], x, y, n.car); break }
  }
  if (!leg) return hop(p, o, then)
  p.mode = 'wait'; p.waitT = 0; p.xhop = { o: { x: o.x, y: o.y, h: o.h }, leg, cn, then }
  kerbside(p)
}
// Buildings (the detail tiles' footprints, the landmarks' outlines): OpenStreetMap's footways and the sidewalks beside
// a street run through a good many of them (an arcade, a wall drawn a metre over the sidewalk, a mall's corridor).
// wallOut: the step that takes (x, y) out of the building it is in, to m metres clear of its nearest wall (null in the open)
const FC = 16
let masks = []
function fpGrid(t) {
  const F = t.fp, n = F.start.length - 1
  t.fg = new Map(); t.fbb = new Float32Array(n * 4)
  for (let r = 0; r < n; r++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let q = F.start[r]; q < F.start[r + 1]; q += 2) { x0 = Math.min(x0, F.pts[q]); x1 = Math.max(x1, F.pts[q]); y0 = Math.min(y0, F.pts[q + 1]); y1 = Math.max(y1, F.pts[q + 1]) }
    t.fbb.set([x0, y0, x1, y1], r * 4)
    for (let cx = Math.floor(x0 / FC); cx <= Math.floor(x1 / FC); cx++) for (let cy = Math.floor(y0 / FC); cy <= Math.floor(y1 / FC); cy++) { const k = cx * 65536 + cy, a = t.fg.get(k); if (a) a.push(r); else t.fg.set(k, [r]) }
  }
}
const wout = { x: 0, y: 0 }
// per FC cell: [tile, ring, tile, ring, ...] in the order tiles then masks are walked (cleared when the tiles change):
// a person asks for the same few cells step after step, and walking every loaded tile was half the worker's time
let wallCells = new Map()
function wallCell(k, cx, cy) {
  const a = []
  for (const t of [...tiles.values(), ...masks]) {
    if (!t.fp || cx + FC < t.ox - 100 || cx > t.ox + t.size + 100 || cy + FC < t.oy - 100 || cy > t.oy + t.size + 100) continue
    if (!t.fg) fpGrid(t)
    for (const r of t.fg.get(k) || []) a.push(t, r)
  }
  wallCells.set(k, a)
  return a
}
function wallOut(x, y, m) {
  const cx = Math.floor(x / FC), cy = Math.floor(y / FC), k = cx * 65536 + cy
  const a = wallCells.get(k) || wallCell(k, cx * FC, cy * FC)
  for (let i = 0; i < a.length; i += 2) {
    const t = a[i], r = a[i + 1], P = t.fp.pts, B = t.fbb
    if (x < t.ox - 100 || x > t.ox + t.size + 100 || y < t.oy - 100 || y > t.oy + t.size + 100) continue // (as before: the tile's own margin)
    if (x < B[r * 4] || y < B[r * 4 + 1] || x > B[r * 4 + 2] || y > B[r * 4 + 3]) continue
    let inside = false, bd = Infinity, bx = 0, by = 0
    const q0 = t.fp.start[r], e = t.fp.start[r + 1]
    for (let q = q0, w = e - 2; q < e; w = q, q += 2) {
      const ay = P[w + 1], cx = P[q], cy = P[q + 1]
      if ((cy > y) !== (ay > y) && x < ((P[w] - cx) * (y - cy)) / (ay - cy) + cx) inside = !inside
    }
    if (!inside) continue // (most are outside: the nearest wall only for those in)
    for (let q = q0, w = e - 2; q < e; w = q, q += 2) {
      const ax = P[w], ay = P[w + 1], cx = P[q], cy = P[q + 1]
      const dx = cx - ax, dy = cy - ay, u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))), d = Math.hypot(ax + dx * u - x, ay + dy * u - y)
      if (d < bd) { bd = d; bx = ax + dx * u; by = ay + dy * u }
    }
    if (bd > 1e-4) { wout.x = ((bx - x) / bd) * (bd + m); wout.y = ((by - y) / bd) * (bd + m); return wout }
  }
  return null
}
const outdoors = (p) => { for (let k = 0; k < 2; k++) { const o = wallOut(p.x, p.y, 0.35); if (!o) return; p.x += o.x; p.y += o.y } } // (twice: out of one into its neighbour)
function pedPos(p) {
  const w = p.wp
  at(w.c, p.u, tmp)
  const off = p.side * w.off + p.lat
  p.x = tmp.x - tmp.ty * off; p.y = tmp.y + tmp.tx * off; p.h = tmp.h + w.lift
  if (!w.c.deck) outdoors(p)
  p.ang = Math.atan2(tmp.ty * p.dir, tmp.tx * p.dir)
}
function release(p) {
  if (p.cw) { p.cw.n--; p.cw = null }
  hold(p, null)
  p.xin = p.xok = p.xiv = p.xhop = null; p.xing = false
}
// on a path's stretch across a street (cars at its junction wait for them), and off it again
function enterX(p, I) {
  p.xcwN = I.node && net?.cws.get(I.node.id + ':' + I.p.key) // (cars yield once they are out on the paving, not for the kerb strip)
  p.xin = I; p.xok = null
}
function leaveX(p) { hold(p, null); p.xin = null }
// the crosswalk (a street at a junction) someone is out on: cars about to cross it there wait
function hold(p, cw) { if (p.xcw === cw) return; if (p.xcw) p.xcw.n--; p.xcw = cw || null; p.xT = simT; if (cw) cw.n++ }
// how far over someone is (radians back from upright): down quickly, a moment there, then up again
function fallAngle(f) {
  const up = Math.min(0.9, f.dur * 0.5), k = f.t < 0.25 ? f.t / 0.25 : f.t > f.dur - up ? (f.dur - f.t) / up : 1
  return f.max * ease(Math.max(0, Math.min(1, k)))
}
// a fast obstacle coming at someone on a path with tangent (tx, ty): which way to jump, as a change of their
// lateral offset (+1: to the left of the tangent), else 0
function dodge(p, tx, ty) {
  for (const o of obstacles.values()) {
    if (o.speed < 3 || (o.h != null && Math.abs(p.h - o.h) > 3)) continue
    const px = p.x - o.x, py = p.y - o.y, along = px * o.c + py * o.s, across = -px * o.s + py * o.c
    if (along < 0 || along > o.len / 2 + o.speed * 1.1 || Math.abs(across) > o.w / 2 + 0.9) continue
    const away = (across >= 0 ? 1 : -1) * (o.s * ty + o.c * tx) // its left (-s, c) against the path's left (-ty, tx)
    return away >= 0 ? 1 : -1
  }
  return 0
}
function stepPeople(dt) {
  for (const p of peds) { p.ox = p.x; p.oy = p.y; p.oh = p.h; p.oph = p.phase } // where they were: drawn between that and here (output())
  for (const b of bikes) { b.ox = b.x; b.oy = b.y; b.oh = b.h; b.oph = b.phase }
  for (const p of statics) { if (p.fall && (p.fall.t += dt) >= p.fall.dur) p.fall = null; if (p.pet && (p.pet.t += dt) >= p.pet.dur) p.pet = null }
  for (const p of peds) {
    if (p.fall) { if ((p.fall.t += dt) >= p.fall.dur) p.fall = null; continue } // down (or stumbling): no walking
    if (p.pet) { if ((p.pet.t += dt) >= p.pet.dur) p.pet = null; continue } // stopped for someone petting their dog
    p.life -= dt
    if (p.xcw && simT - p.xT > 30) hold(p, null) // (never hold the cars up for long)
    if (p.mode === 'walk') {
      const u0 = p.u
      p.u += p.dir * p.v * dt; p.phase += p.v * dt * p.pk
      const xs = xsOf(p.wp, p.side)
      let I = null
      if (xs) for (const q of xs) if (p.u > q.u0 && p.u < q.u1) { I = q; break }
      if (I && p.xin !== I) {
        if (p.xin || p.xok === I) enterX(p, I) // allowed, or already out on the street (at a path's middle node)
        else { p.u = p.dir > 0 ? I.u0 : I.u1; pedPos(p); p.mode = 'wait'; p.waitT = 0; p.xiv = I; kerbside(p); continue } // wait at the kerb
      } else if (!I && p.xin) leaveX(p)
      if ((p.dir > 0 && p.u >= p.uEnd) || (p.dir < 0 && p.u <= p.uEnd)) {
        p.u = p.uEnd; pedPos(p)
        const leg = p.wp.legs[p.dir > 0 ? 1 : 0]
        if (p.life < 0 && peds.length > pedTarget * 0.8 && !seen(p.x, p.y, p.h)) { p.dead = true; continue } // (out of sight)
        arrive(p, leg, p.side * (leg.end ? -1 : 1))
      } else {
        pedPos(p)
        if (p.xin && !p.xcw && p.xcwN && onPaving(p) > 0) hold(p, p.xcwN)
        const side = obstacles.size && p.seed < 0.75 && !p.xing ? dodge(p, tmp.tx, tmp.ty) : 0
        if (side) { p.lat = Math.max(-2.6, Math.min(2.6, p.lat + side * 4 * dt)); pedPos(p) } // a quick hop aside
        const o = obstacles.size && inObstacle(p.x, p.y, p.h, 0.5)
        if (o) { // something in the way: stop and step aside, away from it
          p.u = u0
          at(p.wp.c, p.u, tmp)
          const left = (o.x - tmp.x) * -tmp.ty + (o.y - tmp.y) * tmp.tx
          p.lat = Math.max(-2.5, Math.min(2.5, p.lat + (left > 0 ? -1.2 : 1.2) * dt))
          pedPos(p)
        }
      }
    } else if (p.mode === 'hop') {
      p.ht += p.v * dt; p.phase += p.v * dt * p.pk
      if (obstacles.size && p.hlen > 0.01) { // wait while something is in the way
        const f = Math.min(1, p.ht / p.hlen)
        if (inObstacle(p.hx0 + (p.hx1 - p.hx0) * f, p.hy0 + (p.hy1 - p.hy0) * f, p.hh0 + (p.hh1 - p.hh0) * f, 0.5)) p.ht -= p.v * dt
      }
      const f = p.hlen > 0.01 ? Math.min(1, p.ht / p.hlen) : 1
      p.x = p.hx0 + (p.hx1 - p.hx0) * f; p.y = p.hy0 + (p.hy1 - p.hy0) * f; p.h = p.hh0 + (p.hh1 - p.hh0) * f
      outdoors(p)
      if (p.hlen > 0.05) p.ang = Math.atan2(p.hy1 - p.hy0, p.hx1 - p.hx0)
      if (f >= 1) p.then()
    } else if (p.mode === 'wait') {
      p.waitT += dt
      if (p.cross) {
        const n = p.cross.n
        const X = p.cross, sX = p.crossSide
        portPos(X, -sX, 0, tmp2)
        if ((mayCross(n, X) && !playerComing(p.x, p.y, tmp2.x, tmp2.y, p.h)) || p.waitT > 60) {
          p.cw = crosswalk(n, X); if (p.cw) p.cw.n++
          portPos(X, -sX, 0, tmp2)
          p.cross = null; p.xing = true // (on the street, on the crosswalk)
          hop(p, tmp2, () => { if (p.cw) { p.cw.n--; p.cw = null } p.xing = false; p.crossed = X; arrive(p, X, -sX) })
        }
      } else if (p.xhop) {
        const X = p.xhop
        if (((!X.cn || mayCross({ car: X.cn }, X.leg)) && !playerComing(p.x, p.y, X.o.x, X.o.y, p.h)) || p.waitT > 60) {
          p.xhop = null; p.xing = true
          hold(p, X.cn && net?.cws.get(X.cn.id + ':' + X.leg.wp.p.key))
          hop(p, X.o, () => {
            p.xing = false; hold(p, null)
            X.then()
            p.xok = (xsOf(p.wp, p.side) || []).find((I) => p.u >= I.u0 - 0.01 && p.u <= I.u1 + 0.01) || null // on across the street
          })
        }
      } else if (p.xiv) {
        const I = p.xiv
        at(p.wp.c, p.dir > 0 ? I.u1 : I.u0, tmp2) // (the far kerb)
        if (((!I.node || mayCross({ car: I.node }, I.leg)) && !playerComing(p.x, p.y, tmp2.x, tmp2.y, p.h)) || p.waitT > 60) { p.xok = I; p.xiv = null; p.mode = 'walk' }
      } else p.mode = 'walk'
    }
    if ((p.x - area.vx) ** 2 + (p.y - area.vy) ** 2 > (area.vr + 300) ** 2) p.dead = true
  }
  for (let i = peds.length - 1; i >= 0; i--) if (peds[i].dead) { release(peds[i]); peds[i] = peds[peds.length - 1]; peds.pop() }
  if (walk) {
    for (let k = 0; k < (peds.length < pedTarget * 0.6 ? 60 : 3) && peds.length < pedTarget; k++) spawnPed(peds.length < pedTarget * 0.5)
  }
}
function spawnPed(fill) { // fill: the view is still filling (a new area), in sight too
  const w = sample(walk.foot, walk.cum)
  if (!w) return
  const c = w.c, u = Math.random() * c.len
  at(c, u, tmp)
  if ((tmp.x - area.vx) ** 2 + (tmp.y - area.vy) ** 2 > (area.vr + 150) ** 2 || (!fill && seen(tmp.x, tmp.y, tmp.h))) return
  const p = person(0, 0, 0, 0, 0)
  const dir = Math.random() < 0.5 ? 1 : -1, leg = w.legs[dir > 0 ? 0 : 1]
  const ws = !w.okL ? -1 : !w.okR ? 1 : Math.random() < 0.5 ? 1 : -1 // the side of the street (of a→b)
  startWalk(p, leg, w.off ? ws * (leg.end ? -1 : 1) : 0)
  p.u = Math.min(Math.max(u, Math.min(p.u, p.uEnd)), Math.max(p.u, p.uEnd))
  if ((xsOf(w, p.side) || []).some((I) => p.u > I.u0 - 1 && p.u < I.u1 + 1)) return // not out on a street
  pedPos(p)
  peds.push(p)
}
function stepBikes(dt) {
  if (walk && bikes.length < bikeTarget) {
    const w = sample(walk.cycl, walk.bcum), u = w ? Math.random() * w.c.len : 0
    if (w && (bikes.length < bikeTarget * 0.5 || !seen(at(w.c, u, tmp).x, tmp.y, tmp.h))) { // out of sight, unless the view is still filling
      const b = person(0, 0, 0, 0, 3)
      Object.assign(b, { wp: w, dir: Math.random() < 0.5 ? 1 : -1, u, v: 4 + Math.random() * 2.5 })
      bikes.push(b)
    }
  }
  for (const b of bikes) {
    b.u += b.dir * b.v * dt; b.phase += b.v * dt * 2.2
    const c = b.wp.c
    if (b.u > c.len || b.u < 0) {
      const leg = b.wp.legs[b.u > c.len ? 1 : 0], n = leg.n, over = b.u > c.len ? b.u - c.len : -b.u // (ridden on along the next path: no pause at each junction)
      const opts = n.bikes.filter((l) => l !== leg)
      let nx = opts.length ? opts[(Math.random() * opts.length) | 0] : Math.random() < 0.5 ? null : leg
      if (!nx || (b.x - area.vx) ** 2 + (b.y - area.vy) ** 2 > (area.vr + 200) ** 2) { if (!seen(b.x, b.y, b.h)) { b.dead = true; continue } nx = leg } // gone out of sight, else back the way it came
      b.wp = nx.wp; b.dir = nx.end ? -1 : 1; b.u = nx.end ? Math.max(0, nx.wp.c.len - over) : Math.min(nx.wp.c.len, over)
    }
    at(b.wp.c, b.u, tmp)
    const off = -b.dir * Math.min(0.9, b.wp.w / 4)
    b.x = tmp.x - tmp.ty * off; b.y = tmp.y + tmp.tx * off; b.h = tmp.h + b.wp.lift
    b.ang = Math.atan2(tmp.ty * b.dir, tmp.tx * b.dir)
  }
  bikes = bikes.filter((b) => !b.dead)
}

// ---------------------------------------------------------------- the loop
// The networks are built a few milliseconds a tick (the simulation goes on meanwhile on the old ones: built in one
// go, a second or more downtown, every car and person stood still that long and then jumped), then swapped in
function* rebuild() {
  const t0 = performance.now()
  if (dirty) {
    dirty = false
    const old = net
    net = yield* buildCars()
    // keep the cars whose lanes still exist, where they are (a car in a junction on the same path through it)
    const byKey = new Map(net.lanes.map((L) => [L.key, L]))
    const same = (g) => {
      if (!g?.conn) return g && byKey.get(g.key)
      const F = byKey.get(g.from.key), T = byKey.get(g.to.key)
      return (F && T && F.outs.find((c) => c.to === T)) || null
    }
    const keep = []
    for (const car of cars) {
      let seg = same(car.seg), s = Math.min(car.s, seg?.len ?? 0)
      if (!seg && car.seg.conn && (seg = byKey.get(car.seg.to.key))) s = Math.min(seg.len, car.L) // that junction changed: just past it
      if (!seg) continue
      // where the new lane puts it can be a little off where it was (the lanes redrawn as finer tiles came): drawn
      // where it was, easing over (output())
      at(car.seg, car.s, tmp); at(seg, s, tmp2)
      const jx = tmp.x - tmp2.x, jy = tmp.y - tmp2.y
      if (jx * jx + jy * jy > 0.01 && jx * jx + jy * jy < 400) Object.assign(car, { jx, jy, jt: simT })
      const F = car.lc && !car.seg.conn && byKey.get(car.lc.from.key) // mid lane change: carry on
      Object.assign(car, { seg, s, route: [], prev: same(car.prev), committed: null, lc: F ? { ...car.lc, from: F } : null })
      if (F && car.lc.ghost) F.ghosts.push(car)
      keep.push(car)
    }
    cars = []
    for (const car of keep) { insert(car.seg, car); cars.push(car) }
    // cars moved off junctions onto the same lane start: keep the first of any that overlap
    cars = cars.filter((car) => {
      const a = car.seg.cars, i = a.indexOf(car), o = a[i + 1]
      if (!o || o.s - o.L - car.s > 0.5) return true
      a.splice(i, 1); unghost(car)
      return false
    })
    if (!old) for (let i = 0; i < 150; i++) { targets(); stepCars(0.1) } // let the first cars settle into queues
    blockSegs()
  }
  if (walkDirty && opts.people) {
    walkDirty = false
    walk = yield* buildWalk()
    // keep the people whose paths still exist, walking on from where they were
    const byKey = new Map([...walk.foot, ...walk.cycl].map((w) => [w.p.key, w]))
    const move = (p) => {
      release(p)
      const w = p.wp && byKey.get(p.wp.p.key)
      if (!w) return false
      const leg = w.legs[p.dir > 0 ? 0 : 1], u = Math.min(w.c.len, Math.max(0, p.u))
      if (p.pose !== 3 && w.off && !okSide(w, p.side)) return false
      if (p.pose !== 3) { const lat = p.lat, side = p.side; startWalk(p, leg, side * (leg.end ? -1 : 1)); p.lat = lat; p.u = p.dir > 0 ? Math.min(u, p.uEnd) : Math.max(u, p.uEnd) }
      else { p.wp = w; p.u = u }
      p.cross = p.crossed = null
      return true
    }
    peds = peds.filter(move); bikes = bikes.filter(move)
    makeStatics()
  }
  if (due()) yield
  targets()
  postMessage({ type: 'net', ...signalHeads(), ms: performance.now() - t0 })
}

// signal heads for the page to draw: per approach, a pole at the kerb just past the stop line with an arm over
// its lanes and a head facing the traffic
function signalHeads() {
  const heads = [], ctls = []
  for (const ctl of net.ctls) {
    ctls.push(ctl.cycle, ctl.off, ctl.G[0], ctl.G[1], ctl.A, ctl.C)
    const seen = new Set()
    for (const n of ctl.nodes) for (const L of n.ins) {
      if (L.internal || L.li !== L.n - 1 || seen.has(L.p.key + L.dir) || !n.conns.some((c) => c.from === L)) continue
      seen.add(L.p.key + L.dir)
      const m = L.x.length - 1, fx = Math.cos(endHeading(L)), fy = Math.sin(endHeading(L))
      const kerb = L.p.w / 2 - L.off + 0.9
      const px = L.x[m] + fy * kerb + fx * 1.2, py = L.y[m] - fx * kerb + fy * 1.2
      const arm = Math.min(11, kerb + (L.n - 0.6) * L.lw)
      const group = n.conns.find((c) => c.from === L).group
      heads.push(px, py, L.h[m], Math.atan2(fx, -fy), arm, Math.atan2(-fy, -fx), ctl.id, group)
    }
  }
  // a street-name post on a corner of each junction without signals (one where a divided road makes it two):
  // x, north, ground, heading of the main street and of the one across it
  const posts = [], pg = grid(30)
  for (const n of net.nodes.values()) {
    if (n.deg < 3 || n.ctl) continue
    const legs = new Map()
    for (const L of n.outs) legs.set(L.p, startHeading(L))
    for (const L of n.ins) if (!legs.has(L.p)) legs.set(L.p, endHeading(L) + Math.PI)
    let A = null
    for (const p of legs.keys()) if (p.kind >= 2 && p.kind <= 5 && (!A || p.kind < A.kind || (p.kind === A.kind && p.w > A.w))) A = p
    if (!A) continue
    const a = legs.get(A)
    let B = null, bs = 0.6
    for (const [p, b] of legs) { const sn = Math.abs(Math.sin(b - a)); if (p.kind >= 2 && p.kind <= 5 && sn > bs) { bs = sn; B = p } }
    if (!B) continue
    const b = legs.get(B), x = n.x + Math.cos(a) * (B.w / 2 + 1.6) + Math.cos(b) * (A.w / 2 + 1.6), y = n.y + Math.sin(a) * (B.w / 2 + 1.6) + Math.sin(b) * (A.w / 2 + 1.6)
    let near = false
    pg.near(x, y, (q) => { if (Math.hypot(q[0] - x, q[1] - y) < 18) near = true })
    if (near) continue
    pg.add(x, y, [x, y])
    posts.push(x, y, groundH(x, y), a, b)
  }
  return { heads: new Float32Array(heads), ctls: new Float32Array(ctls), posts: new Float32Array(posts), simT, benches: walk && opts.people ? walk.benches.map((b) => [b.x, b.y, b.h, b.ang]).flat() : [] }
}

function tick({ dt, buf }) {
  const t0 = performance.now()
  acc += Math.min(dt, 0.25)
  let n = 0
  while (acc >= STEP && n++ < 8) {
    simT += STEP; acc -= STEP
    if (net) stepCars(STEP)
    if (opts.people && walk) { stepPeople(STEP); stepBikes(STEP) }
  }
  if (acc > STEP) acc = 0 // fell behind: drop time rather than spiral
  if (!job && area && (dirty || (walkDirty && opts.people)) && (!net || simT - lastBuild > 1.5)) { lastBuild = simT; job = rebuild() }
  if (job) { // (the first network in one go: there is nothing to show meanwhile)
    budget = net ? Math.max(t0 + BUILD_MS, performance.now() + BUILD_MIN) : Infinity
    if (job.next().done) job = null
    budget = Infinity
  }
  if (opts.people && walk && Math.floor(simT / 60) !== Math.floor((simT - n * STEP) / 60)) makeStatics() // benches change hands
  const msg = output(buf)
  msg.ms = performance.now() - t0
  postMessage(msg, [msg.buf.buffer])
}

// 8 floats per thing: x, y (up), z (south), yaw, then per kind (cars: pitch, colour, brake, seed + 2 × shrink;
// people: walk phase (fallen: how far over; petted, pose 5: for how long), pose + seed, shirt, trousers); then 2 per car in the same order: id,
// speed; then 1 per person and cyclist, from pbase: id (the page finds each thing in the answer before by it, and
// draws between the two); then 2 per person and cyclist, from vbase: their velocity (x, z per second)
function output(buf) {
  const counts = [0, 0, 0, 0, 0, 0]
  for (const c of cars) counts[c.kind]++
  const nPeople = opts.people ? peds.length + statics.length : 0, nBikes = opts.people ? bikes.length : 0
  const base = (cars.length + nPeople + nBikes) * 8, pbase = base + cars.length * 2, vbase = pbase + nPeople + nBikes, need = vbase + (nPeople + nBikes) * 2
  let a = buf && buf.length >= need ? buf : new Float32Array(Math.max(need, 1024) * 1.5)
  const off = [0]
  for (let k = 1; k < 6; k++) off[k] = off[k - 1] + counts[k - 1]
  const fill = off.slice()
  const rem = acc
  for (const car of cars) {
    const k = fill[car.kind]++, i = k * 8
    a[base + k * 2] = car.id; a[base + k * 2 + 1] = car.v
    const s = car.s + car.v * rem
    // the front bumper on its way (changing lanes: shifted right by lat, towards where it came from), and the rear
    // axle trailing it on a tow bar (a tractrix): the body turns as a car does, through junctions, across lanes and
    // over short pieces of road (placed on the way behind, it jumped where that ran back over two or three of them)
    let lat = car.lc ? car.lc.d * (1 - ease(Math.min(1, car.lc.t + (car.v * rem) / car.lc.run))) : 0
    if (car.shove) { const k = (simT + rem - car.shove.t) / 3.5; if (k >= 1) car.shove = null; else lat += car.shove.d * (1 - ease(k)) } // knocked aside by a player, easing back
    posOn(car, s, tmp); let fx = tmp.x + tmp.ty * lat, fy = tmp.y - tmp.tx * lat; const fh = tmp.h
    if (car.jt != null) { const k = (simT + rem - car.jt) / 0.6; if (k >= 1) car.jt = null; else { fx += car.jx * (1 - ease(k)); fy += car.jy * (1 - ease(k)) } } // moved by a new network: easing over
    const W = car.L * AXLE
    let dx = fx - car.rx, dy = fy - car.ry, l = Math.hypot(dx, dy)
    if (!(l > W * 0.5 && l < W * 1.5)) { posOn(car, s - W, tmp); dx = fx - tmp.x - tmp.ty * lat; dy = fy - tmp.y + tmp.tx * lat; l = Math.hypot(dx, dy) || 1 } // new here
    dx /= l; dy /= l
    car.rx = fx - dx * W; car.ry = fy - dy * W
    posOn(car, s - car.L, tmp)
    a[i] = fx - (dx * car.L) / 2; a[i + 1] = (fh + tmp.h) / 2; a[i + 2] = -(fy - (dy * car.L) / 2)
    a[i + 3] = Math.atan2(dy, dx); a[i + 4] = Math.atan2(fh - tmp.h, car.L); a[i + 5] = car.color
    // brake lights, plus 2 × blinker (1 left, 2 right): changing lanes, or turning at the junction ahead
    let blink = car.lc ? (car.lc.d > 0 ? 1 : 2) : 0
    const c = car.seg.conn ? car.seg : car.route[0]
    if (!blink && c && c.type !== 'S' && (car.seg.conn || car.seg.len - car.s < 45)) blink = c.type === 'L' ? 1 : 2
    // the seed, plus 2 × how far it has shrunk (0 to 15: growing in after it came, shrinking away as it goes)
    const t = simT + rem, g = Math.min(1, (t - (car.born ?? -1e9)) / FADE, car.die ? 1 - (t - car.die) / FADE : 1)
    a[i + 6] = (car.acc < -1.2 || car.v < 0.5 ? 1 : 0) + 2 * blink; a[i + 7] = car.seed + 2 * Math.round(15 * (1 - Math.max(0, g)))
  }
  let j = cars.length * 8
  let q = pbase
  // people and cyclists between their last two steps, rem / STEP of the way (drawn as they stood after each step, they
  // moved every other frame at 60 fps); one who hopped far (a new path) at once, and one with no step behind them
  // (just come, or sitting: no ox) where they are: (x - undefined) * 0 is NaN, not 0 (#591: it blacked the view out)
  const u = Math.min(1, rem / STEP), now = simT + rem
  const put = (p, pose) => {
    const f = p.fall ? fallAngle(p.fall) : 0, mv = p.ox != null && Math.abs(p.x - p.ox) + Math.abs(p.y - p.oy) < 2, k = mv ? 1 - u : 0, q = vbase + j / 4 - cars.length * 2
    let x = mv ? p.x - (p.x - p.ox) * k : p.x, y = mv ? p.y - (p.y - p.oy) * k : p.y
    if (pose === 0 || pose === 3) { // set down somewhere else within a few metres (a new network's line for their path, a hop begun): drawn where they were, easing over, as the cars are
      const d = now - p.qt, ex = x - p.qx, ey = y - p.qy, lim = (pose === 3 ? 8 : 4.5) * d + 0.15
      if (d < 0.5 && ex * ex + ey * ey > lim * lim && ex * ex + ey * ey < 64) { p.jx = p.dx - x; p.jy = p.dy - y; p.jt = now }
      p.qx = x; p.qy = y; p.qt = now
      if (p.jt != null) { const e = (now - p.jt) / 0.5; if (e >= 1) p.jt = null; else { x += p.jx * (1 - ease(e)); y += p.jy * (1 - ease(e)) } }
      p.dx = x; p.dy = y
    }
    a[j] = x; a[j + 1] = (mv ? p.h - (p.h - p.oh) * k : p.h) + Math.sin(f) * 0.13; a[j + 2] = -y; a[j + 3] = p.ang
    a[q] = mv ? (p.x - p.ox) / STEP : 0; a[q + 1] = mv ? -(p.y - p.oy) / STEP : 0
    a[j + 4] = p.fall ? f : p.pet ? p.pet.t : p.mode === 'wait' ? 0 : mv ? p.phase - (p.phase - p.oph) * k : p.phase // (the legs' turn between the two steps, like the place)
    a[j + 5] = (p.fall ? 4 : p.pet && pose !== 2 ? 5 : p.mode === 'wait' ? 1 : pose) + p.seed * 0.9; a[j + 6] = p.shirt; a[j + 7] = p.pants
    j += 8
  }
  if (opts.people) {
    for (const p of peds) { put(p, 0); a[q++] = p.id }
    for (const p of statics) { put(p, p.pose); a[q++] = p.id }
    for (const b of bikes) { put(b, 3); a[q++] = b.id }
  }
  return { type: 'frame', buf: a, counts, nPeople, nBikes, base, pbase, vbase, simT: simT + rem, cars: cars.length, people: peds.length + statics.length }
}
// a point s metres along the car's way (behind: its previous segment, ahead: its route)
function posOn(car, s, o) {
  let seg = car.seg
  if (s < 0 && car.prev) { seg = car.prev; s += seg.len }
  else if (s > seg.len && car.route[0]) { s -= seg.len; seg = car.route[0] }
  return at(seg, s, o)
}

// someone on a carriageway's paving (1), in the strip within KERB of it (-1), neither (0: up on a deck too, the street being below)
function onPaving(p) { const q = !p.wp.c.deck && inRoad(p.x, p.y); return !q ? 0 : Math.abs(-(p.x - q[2]) * q[1] + (p.y - q[3]) * q[0]) < q[4].w / 2 ? 1 : -1 }
// ?lifedebug on the page: what is near a point, why cars are standing, totals
function debug({ x, y, r, ids }) {
  if (ids) return { type: 'debug', cars: cars.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, seg: c.seg.conn ? `${c.seg.from.key}>${c.seg.to.key} ${c.seg.type}` : c.seg.key, s: +c.s.toFixed(1), len: +c.seg.len.toFixed(1), v: +c.v.toFixed(1), why: c.why, wait: +c.wait.toFixed(1), stopT: +c.stopT.toFixed(1), committed: !!c.committed, lc: !!c.lc, next: c.route[0] ? (c.route[0].conn ? 'conn ' + c.route[0].type : c.route[0].key) : null, k: c.k, n: c.seg.cars.length })) }
  const why = {}
  for (const c of cars) if (c.v < 0.3) { const k = c.k < c.seg.cars.length - 1 ? 'queue' : c.seg.conn ? 'junction' : c.why || 'ahead'; why[k] = (why[k] || 0) + 1 }
  return {
    type: 'debug', why, total: cars.length, meanV: cars.reduce((a, c) => a + c.v, 0) / (cars.length || 1), carTarget, stuck, peds: peds.length, statics: statics.length, bikes: bikes.length, pedTarget, simT,
    lcTotal, changing: cars.filter((c) => c.lc).map((c) => { posOn(c, c.s, tmp); return [Math.round(tmp.x), Math.round(tmp.y), c.id, +c.lc.t.toFixed(2)] }), // [x, north, id, progress]
    obstacles: obstacles.size, blocked: blocked.length,
    // people on a carriageway who are not crossing it (roadWalk), people crossing one along a path that runs down it
    // for longer than across (alongRoad), people waiting or sitting on one (roadStand), and the benches
    roadWalk: walk ? peds.filter((p) => !p.fall && !p.xing && !p.xin && p.mode !== 'wait' && onPaving(p) > 0).length : 0,
    kerbWalk: walk ? peds.filter((p) => !p.fall && !p.xing && !p.xin && p.mode !== 'wait' && onPaving(p) < 0).length : 0,
    roadWalkers: walk ? peds.filter((p) => !p.fall && !p.xing && !p.xin && p.mode !== 'wait' && inRoad(p.x, p.y)).slice(0, 8).map((p) => { const q = inRoad(p.x, p.y); return [Math.round(p.x), Math.round(p.y), p.mode, p.wp.p.kind, p.wp.off ? 'sidewalk' : p.wp.p.crossing ? 'crossing' : 'path', q[4].kind, q[4].drive ? 'drive' : 'nodrive', +(q[4].w / 2 - Math.abs(-(p.x - q[2]) * q[1] + (p.y - q[3]) * q[0])).toFixed(1)] }) : [], // (the last: metres inside the paving, under 0: in the kerb strip)
    alongRoad: peds.filter((p) => p.xin && p.xin.u1 - p.xin.u0 > p.xin.p.w + 8).length,
    roadStand: walk ? statics.filter((p) => inRoad(p.x, p.y)).length : 0,
    benches: walk ? walk.benches.map((b) => [b.x, b.y, b.ang]) : [],
    ctls: net?.ctls.length, lanes: net?.lanes.length,
    lanesNear: net?.lanes.filter((L) => { const m = L.x.length >> 1; return Math.hypot(L.x[m] - x, L.y[m] - y) < r }).slice(0, 30)
      .map((L) => ({ kind: L.cls, a: L.p.a, b: L.p.b, dir: L.dir, li: L.li, cars: L.cars.length, len: L.len | 0, level: L.p.tile.level })),
  }
}
