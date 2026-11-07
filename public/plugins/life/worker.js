// Life: the simulation thread. Cars drive the map tiles' road graph (© OpenStreetMap contributors, ODbL) on the
// right, in lanes, through junctions on Bezier curves, keeping their distance with the intelligent driver model;
// they change lanes (MOBIL: to pass, to get into the lane for the next turn, where a lane ends) and
// they obey traffic signals (two phases by approach axis, with a walk phase for people), stop signs and give-way
// rules, and yield to people on the crosswalks. People walk the sidewalks and footways, cross at junctions and
// crossings, wait at bus stops and sit on benches; cyclists ride the cycleways.
// The page sends the tiles near the view ('tiles'), the simulated area ('area'), settings ('opts') and a 'tick'
// per drawn frame; each tick answers with every car and person as 8 floats in a transferable Float32Array.
// 'obstacles' are things the page drives or walks (city.traffic.setObstacle): cars brake for them, people step
// around them; 'bump' stops a car the player hit for a moment.

const STEP = 1 / 30 // fixed simulation step, seconds
const IDM = { a: 1.4, b: 2.2, T: 1.3, s0: 2.2 }
// lane changes: about how many seconds of sideways motion (over at least `run` metres), MOBIL politeness,
// threshold and keep-right bias (m/s²), how far before the stop line drivers get into the lane for their turn,
// safe braking for a free and a needed change; MARGIN: how close to an obstacle's outline a path is blocked
const LC = { T: 3, run: 20, p: 0.3, th: 0.3, bias: 0.2, zone: 120, bsafe: 3, bmust: 4.5 }
const MARGIN = 1.5
// by road kind: motorway, trunk, primary, secondary, tertiary, residential, service, living
const V0 = [24, 19, 14, 13.5, 12.5, 10, 5, 4.2] // free speed, m/s
const DENS = [22, 20, 40, 34, 24, 4, 0.8, 0.8] // cars per lane-km at the evening rush
// car kinds: sedan, suv, van, truck, taxi, police (the page has a model for each)
const CAR_LEN = [4.5, 4.8, 5.4, 8.6, 4.6, 4.9]
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
let obstacles = new Map(), blocked = [], nextId = 1, lcTotal = 0
let stuck = 0, simT = 0, acc = 0, stamp = 0, carTarget = 0, pedTarget = 0, bikeTarget = 0
const tmp = {}, tmp2 = {}

onmessage = ({ data: m }) => {
  if (m.type === 'tiles') {
    for (const k of m.drop) tiles.delete(k)
    for (const t of m.add) tiles.set(t.key, t)
    dirty = walkDirty = true
  } else if (m.type === 'area') {
    area = m.area; dirty = walkDirty = true
  } else if (m.type === 'opts') {
    const people = opts.people
    Object.assign(opts, m.opts)
    if (opts.people !== people) walkDirty = true
    if (!opts.people) { for (const p of peds) release(p); peds = []; bikes = []; statics = [] }
    targets()
  } else if (m.type === 'obstacles') {
    obstacles = new Map(m.list.map((o) => [o.id, Object.assign(o, { c: Math.cos(o.ang), s: Math.sin(o.ang) })]))
    blockSegs()
  } else if (m.type === 'bump') {
    const car = cars.find((c) => c.id === m.id)
    if (car) { car.v = 0; car.hold = simT + 2 + Math.random() * 2 }
  } else if (m.type === 'tick') tick(m)
  else if (m.type === 'debug') postMessage(debug(m))
}

// ---------------------------------------------------------------- geometry helpers
function poly(X, Y, H) {
  const n = X.length, cum = new Float32Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1])
  return { x: X, y: Y, h: H, cum, len: cum[n - 1] }
}
// point, height and unit tangent at distance s along a polyline
function at(p, s, o) {
  const c = p.cum, n = c.length
  let lo = 0, hi = n - 1
  if (s >= p.len) lo = n - 2
  else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m }
  hi = lo + 1
  const d = c[hi] - c[lo], f = d > 1e-6 ? Math.min(1, (s - c[lo]) / d) : 0
  const dx = p.x[hi] - p.x[lo], dy = p.y[hi] - p.y[lo], l = Math.hypot(dx, dy) || 1
  o.x = p.x[lo] + dx * f; o.y = p.y[lo] + dy * f; o.h = p.h[lo] + (p.h[hi] - p.h[lo]) * f; o.tx = dx / l; o.ty = dy / l
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

// ground height from one tile's terrain grid (world x, y north), as the tile worker drapes that tile's roads
function tileH(t, x, y) {
  const { n, h } = t.terrain, size = t.size, c = size / (n - 1)
  const fx = Math.min(n - 1.0001, Math.max(0, (x - t.ox) / c)), fy = Math.min(n - 1.0001, Math.max(0, (size - (y - t.oy)) / c))
  const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j
  return h[j * n + i] * (1 - u) * (1 - v) + h[j * n + i + 1] * u * (1 - v) + h[(j + 1) * n + i] * (1 - u) * v + h[(j + 1) * n + i + 1] * u * v
}
function groundH(x, y) {
  const t = tiles.get(`0/${Math.floor(x / 1024)}_${Math.floor(y / 1024)}`) || tiles.get(`1/${Math.floor(x / 4096)}_${Math.floor(y / 4096)}`)
  return t ? tileH(t, x, y) : 0
}

// a piece's centre line, densified like the tile worker's road strips (every <= 8 m, deck heights on bridges)
function centre(p) {
  if (p._c) return p._c
  const pts = p.pts, n = pts.length >> 1, zs = p.z, t = p.tile
  const X = [], Y = [], H = []
  for (let i = 0; i < n - 1; i++) {
    const x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[i * 2 + 2], y1 = pts[i * 2 + 3]
    const m = zs ? 1 : Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 8))
    for (let k = 0; k < m; k++) {
      const f = k / m, x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f
      X.push(x); Y.push(y); H.push(zs ? zs[i] + (zs[i + 1] - zs[i]) * f : tileH(t, x, y))
    }
  }
  const x = pts[n * 2 - 2], y = pts[n * 2 - 1]
  X.push(x); Y.push(y); H.push(zs ? zs[n - 1] : tileH(t, x, y))
  const c = poly(Float32Array.from(X), Float32Array.from(Y), Float32Array.from(H))
  c.deck = !!zs
  return (p._c = c)
}
// a parallel line `off` metres to the right (mitred like the road strips), optionally reversed, lifted
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
    X[k] = c.x[i] + ty * off * m; Y[k] = c.y[i] - tx * off * m; H[k] = c.h[i] + lift
  }
  return poly(X, Y, H)
}

// pieces of the loaded tiles within r of the area centre: detail tiles where loaded, overview tiles elsewhere,
// each piece once (tiles assign a piece by its middle point, so a piece lives in exactly one tile per level)
function gather(cx, cy, r, keep) {
  const out = [], seen = new Set(), r2 = r * r
  const list = [...tiles.values()].sort((a, b) => a.level - b.level)
  for (const t of list) {
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
function buildCars() {
  const pieces = gather(area.x, area.y, area.r, (p) => p.drive && p.kind <= 7 && p.pts.length >= 4)
  const nodes = new Map()
  const node = (id, x, y) => {
    let n = nodes.get(id)
    if (!n) nodes.set(id, (n = { id, x, y, deg: 0, best: 9, half: 0, ins: [], outs: [], conns: [], ctl: null, pedX: 0 }))
    return n
  }
  for (const p of pieces) {
    const c = centre(p), m = c.x.length - 1
    p.na = node(p.a, c.x[0], c.y[0]); p.nb = node(p.b, c.x[m], c.y[m])
    for (const n of [p.na, p.nb]) { n.deg++; n.best = Math.min(n.best, p.kind); n.half = Math.max(n.half, p.w / 2) }
  }
  const cws = new Map()
  const cw = (n, p) => { const k = n.id + ':' + p.key; let o = cws.get(k); if (!o) cws.set(k, (o = { n: 0 })); return o }
  const cutAt = (n) => n.deg >= 3 ? Math.max(8.4, n.half + 1.2) : n.deg === 2 ? 2.5 : 0
  const lanes = []
  for (const p of pieces) {
    const c = centre(p), total = Math.max(1, p.lanes || 1)
    const per = p.oneway ? total : Math.max(1, total >> 1), lw = p.w / total
    const lift = 0.18 + (18 - p.kind) * 0.004 + (c.deck ? 0.35 : 0)
    for (const dir of p.oneway ? [0] : [0, 1]) {
      const from = dir ? p.nb : p.na, to = dir ? p.na : p.nb
      let s0 = cutAt(from), s1 = cutAt(to)
      if (s0 + s1 > c.len * 0.8) { const f = (c.len * 0.8) / (s0 + s1); s0 *= f; s1 *= f }
      for (let li = 0; li < per; li++) {
        const off = p.oneway ? (li - (per - 1) / 2) * lw : total === 1 ? p.w / 4 : (li + 0.5) * lw
        let line = offsetLine(c, off, dir === 1, lift)
        if (s0 + s1 > 0) line = cut(line, s0, s1)
        const L = Object.assign(line, { conn: false, p, dir, li, n: per, off, lw: total === 1 ? p.w / 2 : lw, cls: p.kind, v0: V0[p.kind], from, to, cars: [], outs: [],
          key: `${p.key}:${dir}:${li}`, cwStart: cw(from, p), cwEnd: cw(to, p), stop: false, giveWay: false, internal: false })
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
    if (nd.deg === 1) continue // a dead end or the edge of the area: cars leave the simulation here
    for (const L of nd.ins) {
      const hin = endHeading(L), opts = []
      for (const M of nd.outs) {
        if (M.p === L.p) continue
        const ang = turn(hin, startHeading(M))
        if (Math.abs(ang) > 2.7) continue
        opts.push({ M, ang, type: nd.deg === 2 || Math.abs(ang) < 0.6 ? 'S' : ang > 0 ? 'L' : 'R' })
      }
      const ok = ({ M, type }) => type === 'S' ? M.li === Math.min(L.li, M.n - 1) || (L.li === L.n - 1 && M.li > L.li)
        : type === 'R' ? L.li === L.n - 1 && M.li === M.n - 1 : L.li === 0 && M.li === 0
      let use = opts.filter(ok)
      if (!use.length && opts.length) { // nowhere this lane may go: the straightest way on
        const o = opts.sort((a, b) => Math.abs(a.ang) - Math.abs(b.ang))[0]
        use = opts.filter((a) => a.M.p === o.M.p && a.M.dir === o.M.dir && a.M.li === Math.min(L.li, a.M.n - 1))
      }
      for (const { M, type } of use) { const c = connector(L, M, type, nd); L.outs.push(c); nd.conns.push(c) }
    }
  }
  // who crosses whose path inside each junction, and who gives way
  for (const nd of nodes.values()) {
    if (nd.deg < 3) continue
    const C = nd.conns
    for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) {
      const a = C[i], b = C[j]
      if (a.from === b.from || !(a.to === b.to || crosses(a, b))) continue
      a.conflicts.push(b); b.conflicts.push(a)
      const pa = prio(a, nd), pb = prio(b, nd)
      if (pa > pb || b.from.stop || b.from.giveWay) b.yields.push(a)
      if (pb > pa || a.from.stop || a.from.giveWay) a.yields.push(b)
    }
  }
  const ctls = signals(nodes, pieces)
  const entries = lanes.filter((L) => L.from.deg === 1 && L.len > 12)
  return { nodes, lanes, entries, ctls, cws, cum: cumWeights(lanes, (L) => L.len * DENS[L.cls]), ecum: cumWeights(entries, (L) => DENS[L.cls] ** 2) }
}
const prio = (c, nd) => (c.type === 'S' ? 2 : c.type === 'R' ? 1 : 0) + (c.from.cls === nd.best ? 3 : 0)

function connector(L, M, type, nd) {
  const e = L.x.length - 1, x0 = L.x[e], y0 = L.y[e], h0 = L.h[e], x3 = M.x[0], y3 = M.y[0], h3 = M.h[0]
  const a0 = endHeading(L), a3 = startHeading(M), d = Math.hypot(x3 - x0, y3 - y0), k = d * 0.42
  const n = Math.max(2, Math.min(12, Math.ceil(d / 2))), X = new Float32Array(n + 1), Y = new Float32Array(n + 1), H = new Float32Array(n + 1)
  for (let i = 0; i <= n; i++) {
    const s = i / n, u = 1 - s, b0 = u * u * u, b1 = 3 * u * u * s, b2 = 3 * u * s * s, b3 = s * s * s
    X[i] = b0 * x0 + b1 * (x0 + Math.cos(a0) * k) + b2 * (x3 - Math.cos(a3) * k) + b3 * x3
    Y[i] = b0 * y0 + b1 * (y0 + Math.sin(a0) * k) + b2 * (y3 - Math.sin(a3) * k) + b3 * y3
    H[i] = h0 + (h3 - h0) * s
  }
  // mv: the way on (which road, which way); ends: this lane ends here and merges into the next lane over
  return Object.assign(poly(X, Y, H), { conn: true, node: nd, from: L, to: M, type, cars: [], conflicts: [], yields: [], reserved: 0, group: 0,
    mv: M.p.key + ':' + M.dir, ends: type === 'S' && L.li > M.li,
    v0: type === 'S' ? Math.min(L.v0, M.v0) : type === 'R' ? 5.5 : 7, w: (type === 'S' ? 4 : 1) * (8 - M.cls) })
}
function crosses(a, b) {
  for (let i = 0; i < a.x.length - 1; i++) for (let j = 0; j < b.x.length - 1; j++) {
    const ax = a.x[i], ay = a.y[i], bx = a.x[i + 1], by = a.y[i + 1], cx = b.x[j], cy = b.y[j], dx = b.x[j + 1], dy = b.y[j + 1]
    const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
    if (Math.abs(d) < 1e-9) continue
    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d, u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d
    if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) return true
  }
  return false
}
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
function signals(nodes, pieces) {
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
function targets() {
  const h = opts.hour, day = smooth(5.5, 8, h) * (1 - smooth(20, 23.5, h))
  const carTod = 0.16 + 0.5 * day + 0.3 * Math.exp(-(((h - 8.2) / 1.3) ** 2)) + 0.38 * Math.exp(-(((h - 17) / 1.6) ** 2))
  const lanesKm = net ? net.cum[net.cum.length - 1] / 1000 : 0
  carTarget = opts.cars ? Math.min(opts.maxCars, Math.round(lanesKm * carTod * opts.density)) : 0
  if (walk) {
    pedTarget = opts.people ? Math.min(opts.maxPeople - statics.length, Math.round(walk.weight * (0.1 + 0.9 * day) * opts.density)) : 0
    bikeTarget = opts.people && opts.bikes ? Math.min(300, Math.round(walk.bikeWeight * (0.05 + 0.95 * day) * opts.density)) : 0
  }
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

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
  Object.assign(car, { seg: L, s, v: L.v0 * 0.5, route: [], prev: null, committed: null, stopT: 0, wait: 0, lc: null, lcNext: 0, lcCool: 0, hold: 0 })
  insert(L, car)
  cars.push(car)
}
function spawnCar(entry) {
  if (!net) return
  if (entry) {
    const L = sample(net.entries, net.ecum)
    if (!L || (L.cars.length && L.cars[0].s - L.cars[0].L < 30)) return // room to come in and brake
    const car = newCar(L.cls)
    place(car, L, car.L + 0.5)
    car.v = L.v0 * 0.7
    return
  }
  for (let tries = 0; tries < 6; tries++) {
    const L = sample(net.lanes, net.cum)
    if (!L || L.len < 10 || L.block) continue
    const car = newCar(L.cls), s = car.L + Math.random() * (L.len - car.L)
    if (L.cars.some((o) => Math.abs(o.s - s) < car.L + 6)) continue
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
  if (!net.sgrid) { // lanes and junction paths by 20 m cell, built the first time something is in the way
    net.sgrid = grid(20)
    for (const g of [...net.lanes, ...[...net.nodes.values()].flatMap((n) => n.conns)]) {
      let last = null
      for (let i = 0; i < g.x.length; i++) { const k = Math.floor(g.x[i] / 20) * 65536 + Math.floor(g.y[i] / 20); if (k !== last) net.sgrid.add(g.x[i], g.y[i], g); last = k }
    }
  }
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
function inObstacle(x, y, h, m) {
  for (const o of obstacles.values()) {
    if (o.h != null && Math.abs(h - o.h) > 3) continue
    const px = x - o.x, py = y - o.y
    if (Math.abs(px * o.c + py * o.s) < o.len / 2 + m && Math.abs(-px * o.s + py * o.c) < o.w / 2 + m) return o
  }
  return null
}

// may this car enter junction connector c, `dist` metres ahead?
function permit(car, c, dist) {
  if (car.committed === c) return true
  car.why = ''
  const L = c.from, nd = c.node, ctl = nd.ctl
  if (ctl && !L.internal) {
    const st = light(ctl, c.group)
    if (st === 0) return (car.why = 'red', false)
    if (st === 1 && dist > (car.v * car.v) / (2 * IDM.b) + 1.5) return (car.why = 'amber', false)
  }
  if (L.stop && car.stopT < 0.8) return (car.why = 'stop', false)
  if (nd.pedX > 0 || L.cwEnd.n > 0 || c.to.cwStart.n > 0) return (car.why = 'ped', false)
  const M = c.to
  if (nd.deg >= 3 && M.cars.length && M.cars[0].s - M.cars[0].L < car.L + 1 && M.cars[0].v < 2) return (car.why = 'box', false) // don't block the box
  if (car.wait < 25) {
    for (const o of c.conflicts) if (o.cars.length || o.reserved) return (car.why = 'conflict', false)
    for (const o of c.yields) { // someone with right of way about to arrive?
      const F = o.from, a = F.cars
      if (!a.length) continue
      const lead = a[a.length - 1]
      if (lead.route[0] === o && lead.v > 0.8 && F.len - lead.s < 6 + lead.v * 3) return (car.why = 'yield', false)
    }
  }
  if (dist < 2.5 + car.v * 0.4) { car.committed = c; c.reserved++ }
  return true
}
// distance to what is ahead and its speed; stop: a stop line
function gap(car) {
  const seg = car.seg, a = seg.cars
  let g = 1e9, gv = 0, hard = false
  if (car.k < a.length - 1) { const o = a[car.k + 1]; g = o.s - o.L - car.s; gv = o.v }
  if (seg.ghosts?.length || seg.block || car.lc?.ghost) {
    const r = leadOn(seg, car.s, car)
    if (r[0] < g) [g, gv, hard] = r
    if (car.lc?.ghost) { // still half in the old lane: don't touch who is ahead there (it is clear of them before it gets there)
      const F = car.lc.from, q = leadOn(F, (car.s * F.len) / seg.len, car)
      q[0] += IDM.s0 - 0.3
      if (q[0] < g) [g, gv, hard] = q
    }
  }
  if (g < 1e9) return [g, gv, hard]
  let d = seg.len - car.s, prev = seg
  const look = 25 + car.v * 4
  plan(car, look + 20)
  const R = car.route
  for (let i = 0; i < R.length; i++) {
    const nx = R[i]
    if (d > look) break
    if (!nx) return [1e9, 0, false]
    if (nx.conn && !prev.conn) {
      // an obstacle in the junction or just past it: don't enter
      if (nx.block || (nx.to.block && blockAhead(nx.to, 0)[0] < car.L + 2)) return [d - 0.6, 0, true]
      // a lane too short to wait on between two junctions: the second must be clear before entering the first
      const nx2 = R[i + 2]
      if (car.committed !== nx && nx.to.len < car.L + 4 && nx2?.conn && !permit(car, nx2, d + nx.len + nx.to.len)) return [d - 0.6, 0, true]
      if (!permit(car, nx, d)) return [d - 0.6, 0, true]
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
    if (car.wait > 50) { dropCar(i); stuck++; continue } // hopelessly stuck: clear it
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
  if (net) {
    const want = carTarget
    if (cars.length < want * 0.85) for (let k = 0; k < 40 && cars.length < want; k++) spawnCar(false)
    else if (cars.length < want) for (let k = 0; k < 3; k++) spawnCar(true)
    else if (cars.length > want * 1.25) dropCar((Math.random() * cars.length) | 0)
  }
}

// ---------------------------------------------------------------- people
// sidewalk centre offset of a road with sidewalks (the tile worker's band: kerb, boulevard on tertiary and
// residential streets, then the walk)
function sidewalk(p) {
  if (p.band === false || p._band === false || p.kind < 2 || p.kind > 7 || p.kind === 6) return 0
  const blvd = p.kind === 4 || p.kind === 5 ? 2.2 : 0, w = p.kind <= 3 ? 3.2 : 2.0
  return p.w / 2 + blvd + w / 2
}
const FOOT = new Set([8, 9, 11, 12, 13])
function buildWalk() {
  const r = area.vr + 250
  let pieces = gather(area.vx, area.vy, r, (p) => p.pts.length >= 4 && (FOOT.has(p.kind) || p.kind === 10 || sidewalk(p) > 0))
  // Streets whose sidewalks are mapped as separate footways (sidewalk=separate) have no sidewalk band drawn, but
  // the tile graph doesn't say which (a `band` flag on the pieces wins if the core ever adds one). Where footways
  // run alongside, people walk those instead: that catches ~85% of the band-less streets downtown (checked against
  // the tiles' own flags) and costs little elsewhere, since the footways right there carry the people
  const fg = grid(12)
  for (const p of pieces) {
    if (p.kind !== 9 && p.kind !== 8) continue
    const c = centre(p)
    for (let i = 0; i < c.x.length - 1; i++) {
      const dx = c.x[i + 1] - c.x[i], dy = c.y[i + 1] - c.y[i], l = Math.hypot(dx, dy) || 1, n = Math.ceil(l / 4)
      for (let k = 0; k < n; k++) fg.add(c.x[i] + (dx * k) / n, c.y[i] + (dy * k) / n, [dx / l, dy / l, c.x[i] + (dx * k) / n, c.y[i] + (dy * k) / n])
    }
  }
  for (const p of pieces) {
    if (p.band !== undefined || p._band !== undefined || !sidewalk(p)) continue
    const c = centre(p), lo = p.w / 2 - 0.5, hi = p.w / 2 + 9
    let tried = 0, hit = 0
    for (let u = Math.min(6, c.len / 2); u < c.len; u += 12) {
      at(c, u, tmp); tried++
      let l = false, r = false
      fg.near(tmp.x, tmp.y, (q) => {
        if (Math.abs(q[0] * tmp.tx + q[1] * tmp.ty) < 0.9) return
        const ox = q[2] - tmp.x, oy = q[3] - tmp.y, along = ox * tmp.tx + oy * tmp.ty, side = -ox * tmp.ty + oy * tmp.tx
        if (Math.abs(along) < 8 && Math.abs(side) > lo && Math.abs(side) < hi) { if (side > 0) l = true; else r = true }
      })
      if (l || r) hit++
    }
    p._band = !(tried && hit / tried >= 0.4)
  }
  pieces = pieces.filter((p) => FOOT.has(p.kind) || p.kind === 10 || sidewalk(p) > 0)
  const nodes = new Map(), wps = []
  const node = (id, x, y) => { let n = nodes.get(id); if (!n) nodes.set(id, (n = { id, x, y, legs: [], bikes: [] })); return n }
  const dt = (x, y) => { const d = Math.hypot(x - DOWNTOWN[0], y - DOWNTOWN[1]); return 1 + 2.5 * Math.exp(-d / 1500) }
  const h = opts.hour, day = smooth(6, 9, h) * (1 - smooth(19, 22.5, h))
  for (const p of pieces) {
    const c = centre(p), off = sidewalk(p), bike = p.kind === 10
    const lift = off ? 0.12 + (c.deck ? 0.3 : 0) : 0.18 + (18 - p.kind) * 0.004 - 0.03 + (c.deck ? 0.35 : 0)
    const m = c.x.length >> 1, mx = c.x[m], my = c.y[m]
    const per = off ? (p.kind <= 3 ? 0.03 : 0.012) * 2 : p.kind === 8 ? 0.07 : p.kind === 9 ? 0.03 : p.kind === 12 ? 0.008 : 0.016 * (0.3 + day)
    const wp = { p, c, off, bike, lift, w: p.w, na: node(p.a, c.x[0], c.y[0]), nb: node(p.b, c.x[c.x.length - 1], c.y[c.y.length - 1]), legs: [null, null],
      weight: bike ? 0 : c.len * per * dt(mx, my), bikeWeight: bike ? c.len * 0.004 * dt(mx, my) : 0 }
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
    const cn = net?.nodes.get(n.id)
    n.car = cn && cn.deg >= 2 ? cn : null
    n.dX = cn && cn.deg >= 3 ? 5.6 : 0
    const bands = n.legs.filter((l) => l.band).sort((a, b) => a.ang - b.ang)
    n.bands = bands
    const reach = Math.max(0, ...bands.map((l) => l.wp.off))
    for (const l of n.legs) {
      l.cut = Math.min(l.band ? n.dX : reach, l.wp.c.len * 0.45)
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
  for (const q of poisOf([0, 1], area.vx, area.vy, r)) { const n = nodes.get(q.id); if (n) n.crossOK = true }
  for (const n of nodes.values()) if (!n.car) n.crossOK = false
  const foot = wps.filter((w) => !w.bike), cycl = wps.filter((w) => w.bike)
  // benches and bus stops, facing the nearest path or street
  const near = grid(25)
  for (const w of wps) for (let i = 0; i < w.c.x.length; i++) near.add(w.c.x[i], w.c.y[i], w)
  const face = (x, y) => {
    let bd = 1e9, bx = 0, by = 0
    near.near(x, y, (w) => { for (let i = 0; i < w.c.x.length; i++) { const d = (w.c.x[i] - x) ** 2 + (w.c.y[i] - y) ** 2; if (d < bd) { bd = d; bx = w.c.x[i]; by = w.c.y[i] } } })
    return bd < 1e9 ? Math.atan2(by - y, bx - x) : Math.random() * 6.28
  }
  const benches = poisOf([4], area.vx, area.vy, r).map((q) => ({ x: q.x, y: q.y, h: groundH(q.x, q.y) + 0.1, ang: face(q.x, q.y), id: q.id }))
  const stops = poisOf([5], area.vx, area.vy, r).map((q) => ({ x: q.x, y: q.y, h: groundH(q.x, q.y) + 0.13, ang: face(q.x, q.y), id: q.id }))
  return { nodes, foot, cycl, cum: cumWeights(foot, (w) => w.weight), bcum: cumWeights(cycl, (w) => w.bikeWeight),
    weight: foot.reduce((s, w) => s + w.weight, 0), bikeWeight: cycl.reduce((s, w) => s + w.bikeWeight, 0), benches, stops }
}
function makeStatics() {
  statics = []
  const seeded = (id) => { let a = id % 2147483647; return () => { a = (a * 48271) % 2147483647; return a / 2147483647 } }
  if (!walk || !opts.people) return
  const h = opts.hour, day = smooth(6, 9, h) * (1 - smooth(19, 23, h))
  const rnd = (id, k) => { const x = Math.sin(id * 0.0001 + k * 12.9898) * 43758.5453; return x - Math.floor(x) }
  for (const b of walk.benches) {
    if (rnd(b.id, 1) > 0.15 + 0.55 * day) continue
    const two = rnd(b.id, 2) < 0.35
    for (const side of two ? [-0.45, 0.45] : [(rnd(b.id, 3) - 0.5) * 0.8]) {
      const ax = Math.cos(b.ang), ay = Math.sin(b.ang)
      statics.push(person(b.x + ay * side - ax * 0.05, b.y - ax * side - ay * 0.05, b.h, b.ang, 2, seeded(b.id + side * 7)))
    }
  }
  for (const s of walk.stops) {
    const n = Math.floor(rnd(s.id, 4) * (1 + 3.5 * (0.15 + day)))
    for (let i = 0; i < n; i++) {
      const a = rnd(s.id, 5 + i) * 6.28, d = 0.6 + rnd(s.id, 9 + i) * 1.4
      statics.push(person(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, s.h, s.ang + (rnd(s.id, 13 + i) - 0.5) * 1.2, 1, seeded(s.id + i)))
    }
  }
  if (statics.length > opts.maxPeople / 3) statics.length = Math.floor(opts.maxPeople / 3)
}
function person(x, y, h, ang, pose, r = Math.random) {
  return { x, y, h, ang, pose, shirt: SHIRT[(r() * SHIRT.length) | 0], pants: PANTS[(r() * PANTS.length) | 0], seed: r(), phase: r() * 6.28, v: 1.05 + r() * 0.5, life: 60 + r() * 300 }
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
  p.lat = w.off ? (Math.random() - 0.5) * 0.9 : (Math.random() - 0.5) * Math.max(0.2, w.w - 1.2)
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
    if (a.length) { const o = a[a.length - 1]; if (o.v > 0.5 && L.len - o.s < 5 + o.v * 2.5) return false }
  }
  for (const c of cn.conns) if ((c.cars.length || c.reserved) && (!leg || c.from.p === leg.wp.p || c.to.p === leg.wp.p)) return false
  return true
}
function crosswalk(n, leg) { return n.car ? net.cws.get(n.car.id + ':' + leg.wp.p.key) : null }
function arrive(p, leg, side) {
  const n = leg.n
  if (n.legs.length === 1 && Math.hypot(n.x - area.vx, n.y - area.vy) > area.vr) { p.dead = true; return }
  const ci = side === 0 ? leg.corner : side > 0 ? leg.k : (leg.k - 1 + n.bands.length) % n.bands.length
  const corner = n.corners[ci] || n.corners[0]
  const nb = n.bands.length
  if (n.crossOK && nb >= 2 && Math.random() < 0.45) {
    const opts = [n.bands[ci], n.bands[(ci + 1) % nb]].filter((l) => l !== p.crossed)
    const X = opts[(Math.random() * opts.length) | 0]
    if (X) {
      const sX = X === n.bands[ci] ? 1 : -1
      portPos(X, sX, 0, tmp2)
      hop(p, tmp2, () => { p.mode = 'wait'; p.waitT = 0; p.cross = X; p.crossSide = sX; p.ang = X.ang + (sX > 0 ? -Math.PI / 2 : Math.PI / 2) })
      return
    }
  }
  p.crossed = null
  let ports = corner.filter((q) => q.leg !== leg || q.side !== side)
  if (!ports.length) ports = corner
  const q = ports[(Math.random() * ports.length) | 0]
  startWalkFrom(p, q.leg, q.side)
}
function startWalkFrom(p, leg, side) {
  const x = p.x, y = p.y, h = p.h
  startWalk(p, leg, side)
  pedPos(p)
  const o = { x: p.x, y: p.y, h: p.h }
  // a footway that crosses a street through its middle node: wait for the street to clear first
  const far = leg.wp.legs[1 - leg.end].n
  const xing = !leg.band && far.car && !far.bands.length && leg.wp.c.len < 30 ? far : null
  p.x = x; p.y = y; p.h = h
  const go = () => {
    if (xing) { p.mode = 'wait'; p.waitT = 0; p.xnode = xing } else p.mode = 'walk'
  }
  if (Math.hypot(o.x - x, o.y - y) > 0.3) hop(p, o, go)
  else go()
}
function pedPos(p) {
  const w = p.wp
  at(w.c, p.u, tmp)
  const off = p.side * w.off + p.lat
  p.x = tmp.x - tmp.ty * off; p.y = tmp.y + tmp.tx * off; p.h = tmp.h + w.lift
  p.ang = Math.atan2(tmp.ty * p.dir, tmp.tx * p.dir)
}
function release(p) {
  if (p.cw) { p.cw.n--; p.cw = null }
  if (p.xheld) { p.xheld.pedX--; p.xheld = null }
}
function stepPeople(dt) {
  for (const p of peds) {
    p.life -= dt
    if (p.xheld && simT > p.xuntil) { p.xheld.pedX--; p.xheld = null }
    if (p.mode === 'walk') {
      const u0 = p.u
      p.u += p.dir * p.v * dt; p.phase += p.v * dt * 4.2
      if ((p.dir > 0 && p.u >= p.uEnd) || (p.dir < 0 && p.u <= p.uEnd)) {
        p.u = p.uEnd; pedPos(p)
        const leg = p.wp.legs[p.dir > 0 ? 1 : 0]
        if (p.life < 0 && peds.length > pedTarget * 0.8) { p.dead = true; continue }
        arrive(p, leg, p.side * (leg.end ? -1 : 1))
      } else {
        pedPos(p)
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
      p.ht += p.v * dt; p.phase += p.v * dt * 4.2
      if (obstacles.size && p.hlen > 0.01) { // wait while something is in the way
        const f = Math.min(1, p.ht / p.hlen)
        if (inObstacle(p.hx0 + (p.hx1 - p.hx0) * f, p.hy0 + (p.hy1 - p.hy0) * f, p.hh0 + (p.hh1 - p.hh0) * f, 0.5)) p.ht -= p.v * dt
      }
      const f = p.hlen > 0.01 ? Math.min(1, p.ht / p.hlen) : 1
      p.x = p.hx0 + (p.hx1 - p.hx0) * f; p.y = p.hy0 + (p.hy1 - p.hy0) * f; p.h = p.hh0 + (p.hh1 - p.hh0) * f
      if (p.hlen > 0.05) p.ang = Math.atan2(p.hy1 - p.hy0, p.hx1 - p.hx0)
      if (f >= 1) p.then()
    } else if (p.mode === 'wait') {
      p.waitT += dt
      if (p.cross) {
        const n = p.cross.n
        if (mayCross(n, p.cross) || p.waitT > 60) {
          const X = p.cross, sX = p.crossSide
          p.cw = crosswalk(n, X); if (p.cw) p.cw.n++
          portPos(X, -sX, 0, tmp2)
          p.cross = null
          hop(p, tmp2, () => { if (p.cw) { p.cw.n--; p.cw = null } p.crossed = X; arrive(p, X, -sX) })
        }
      } else if (p.xnode) {
        if (mayCross(p.xnode, null) || p.waitT > 60) {
          p.xheld = p.xnode.car; p.xheld.pedX++; p.xuntil = simT + (p.wp.c.len + 10) / p.v; p.xnode = null; p.mode = 'walk'
        }
      } else p.mode = 'walk'
    }
    if ((p.x - area.vx) ** 2 + (p.y - area.vy) ** 2 > (area.vr + 300) ** 2) p.dead = true
  }
  for (let i = peds.length - 1; i >= 0; i--) if (peds[i].dead) { release(peds[i]); peds[i] = peds[peds.length - 1]; peds.pop() }
  if (walk) {
    for (let k = 0; k < (peds.length < pedTarget * 0.6 ? 60 : 3) && peds.length < pedTarget; k++) spawnPed()
  }
}
function spawnPed() {
  const w = sample(walk.foot, walk.cum)
  if (!w) return
  const c = w.c, u = Math.random() * c.len
  at(c, u, tmp)
  if ((tmp.x - area.vx) ** 2 + (tmp.y - area.vy) ** 2 > (area.vr + 150) ** 2) return
  const p = person(0, 0, 0, 0, 0)
  const dir = Math.random() < 0.5 ? 1 : -1, leg = w.legs[dir > 0 ? 0 : 1]
  startWalk(p, leg, w.off ? (Math.random() < 0.5 ? 1 : -1) : 0)
  p.u = Math.min(Math.max(u, Math.min(p.u, p.uEnd)), Math.max(p.u, p.uEnd))
  pedPos(p)
  peds.push(p)
}
function stepBikes(dt) {
  if (walk && bikes.length < bikeTarget) {
    const w = sample(walk.cycl, walk.bcum)
    if (w) {
      const b = person(0, 0, 0, 0, 3)
      Object.assign(b, { wp: w, dir: Math.random() < 0.5 ? 1 : -1, u: Math.random() * w.c.len, v: 4 + Math.random() * 2.5 })
      bikes.push(b)
    }
  }
  for (const b of bikes) {
    b.u += b.dir * b.v * dt; b.phase += b.v * dt * 2.2
    const c = b.wp.c
    if (b.u > c.len || b.u < 0) {
      const leg = b.wp.legs[b.u > c.len ? 1 : 0], n = leg.n
      const opts = n.bikes.filter((l) => l !== leg)
      const nx = opts.length ? opts[(Math.random() * opts.length) | 0] : Math.random() < 0.5 ? null : leg
      if (!nx || (b.x - area.vx) ** 2 + (b.y - area.vy) ** 2 > (area.vr + 200) ** 2) { b.dead = true; continue }
      b.wp = nx.wp; b.dir = nx.end ? -1 : 1; b.u = nx.end ? nx.wp.c.len : 0
    }
    at(b.wp.c, b.u, tmp)
    const off = -b.dir * Math.min(0.9, b.wp.w / 4)
    b.x = tmp.x - tmp.ty * off; b.y = tmp.y + tmp.tx * off; b.h = tmp.h + b.wp.lift
    b.ang = Math.atan2(tmp.ty * b.dir, tmp.tx * b.dir)
  }
  bikes = bikes.filter((b) => !b.dead)
}

// ---------------------------------------------------------------- the loop
function rebuild() {
  lastBuild = simT
  const t0 = performance.now()
  if (dirty) {
    const old = net
    net = buildCars()
    dirty = false
    // keep the cars whose lanes still exist
    const byKey = new Map(net.lanes.map((L) => [L.key, L]))
    const keep = []
    for (const car of cars) {
      const L = byKey.get((car.seg.conn ? car.seg.to : car.seg).key)
      if (!L) continue
      const s = car.seg.conn ? Math.min(L.len, car.L) : Math.min(car.s, L.len)
      const F = car.lc && !car.seg.conn && byKey.get(car.lc.from.key) // mid lane change: carry on
      Object.assign(car, { seg: L, s, route: [], prev: null, committed: null, lc: F ? { ...car.lc, from: F } : null })
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
    walk = buildWalk()
    walkDirty = false
    // keep the people whose paths still exist, walking on from where they were
    const byKey = new Map([...walk.foot, ...walk.cycl].map((w) => [w.p.key, w]))
    const move = (p) => {
      release(p)
      const w = p.wp && byKey.get(p.wp.p.key)
      if (!w) return false
      const leg = w.legs[p.dir > 0 ? 0 : 1], u = Math.min(w.c.len, Math.max(0, p.u))
      if (p.pose !== 3) { const lat = p.lat, side = p.side; startWalk(p, leg, side * (leg.end ? -1 : 1)); p.lat = lat; p.u = p.dir > 0 ? Math.min(u, p.uEnd) : Math.max(u, p.uEnd) }
      else { p.wp = w; p.u = u }
      p.cross = p.xnode = p.crossed = null
      return true
    }
    peds = peds.filter(move); bikes = bikes.filter(move)
    makeStatics()
  }
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
  return { heads: new Float32Array(heads), ctls: new Float32Array(ctls), simT, benches: walk && opts.people ? walk.benches.map((b) => [b.x, b.y, b.h, b.ang]).flat() : [] }
}

function tick({ dt, buf }) {
  const t0 = performance.now()
  if (area && (dirty || (walkDirty && opts.people)) && (!net || simT - lastBuild > 1.5)) rebuild()
  acc += Math.min(dt, 0.25)
  let n = 0
  while (acc >= STEP && n++ < 8) {
    simT += STEP; acc -= STEP
    if (net) stepCars(STEP)
    if (opts.people && walk) { stepPeople(STEP); stepBikes(STEP) }
  }
  if (acc > STEP) acc = 0 // fell behind: drop time rather than spiral
  if (opts.people && walk && Math.floor(simT / 60) !== Math.floor((simT - n * STEP) / 60)) makeStatics() // benches change hands
  const msg = output(buf)
  msg.ms = performance.now() - t0
  postMessage(msg, [msg.buf.buffer])
}

// 8 floats per thing: x, y (up), z (south), yaw, then per kind (cars: pitch, colour, brake, seed;
// people: walk phase, pose + seed, shirt, trousers); then 2 per car in the same order: id, speed
function output(buf) {
  const counts = [0, 0, 0, 0, 0, 0]
  for (const c of cars) counts[c.kind]++
  const nPeople = opts.people ? peds.length + statics.length : 0, nBikes = opts.people ? bikes.length : 0
  const base = (cars.length + nPeople + nBikes) * 8, need = base + cars.length * 2
  let a = buf && buf.length >= need ? buf : new Float32Array(Math.max(need, 1024) * 1.5)
  const off = [0]
  for (let k = 1; k < 6; k++) off[k] = off[k - 1] + counts[k - 1]
  const fill = off.slice()
  const rem = acc
  for (const car of cars) {
    const k = fill[car.kind]++, i = k * 8
    a[base + k * 2] = car.id; a[base + k * 2 + 1] = car.v
    const s = car.s + car.v * rem
    // changing lanes: shifted right by lat (towards where it came from) and turned into the move a little
    let lat = 0, yaw = 0
    if (car.lc) {
      const t = Math.min(1, car.lc.t + (car.v * rem) / car.lc.run)
      lat = car.lc.d * (1 - ease(t)); yaw = Math.max(-0.6, Math.min(0.6, Math.atan((car.lc.d * 6 * t * (1 - t)) / car.lc.run)))
    }
    posOn(car, s, tmp); const fx = tmp.x + tmp.ty * lat, fy = tmp.y - tmp.tx * lat, fh = tmp.h
    posOn(car, s - car.L, tmp); tmp.x += tmp.ty * lat; tmp.y -= tmp.tx * lat
    const dx = fx - tmp.x, dy = fy - tmp.y, l = Math.hypot(dx, dy) || 1
    a[i] = (fx + tmp.x) / 2; a[i + 1] = (fh + tmp.h) / 2; a[i + 2] = -(fy + tmp.y) / 2
    a[i + 3] = Math.atan2(dy, dx) + yaw; a[i + 4] = Math.atan2(fh - tmp.h, l); a[i + 5] = car.color
    // brake lights, plus 2 × blinker (1 left, 2 right): changing lanes, or turning at the junction ahead
    let blink = car.lc ? (car.lc.d > 0 ? 1 : 2) : 0
    const c = car.seg.conn ? car.seg : car.route[0]
    if (!blink && c && c.type !== 'S' && (car.seg.conn || car.seg.len - car.s < 45)) blink = c.type === 'L' ? 1 : 2
    a[i + 6] = (car.acc < -1.2 || car.v < 0.5 ? 1 : 0) + 2 * blink; a[i + 7] = car.seed
  }
  let j = cars.length * 8
  const put = (p, pose) => {
    a[j] = p.x; a[j + 1] = p.h; a[j + 2] = -p.y; a[j + 3] = p.ang
    a[j + 4] = p.mode === 'wait' ? 0 : p.phase; a[j + 5] = (p.mode === 'wait' ? 1 : pose) + p.seed * 0.9; a[j + 6] = p.shirt; a[j + 7] = p.pants
    j += 8
  }
  if (opts.people) {
    for (const p of peds) put(p, 0)
    for (const p of statics) put(p, p.pose)
    for (const b of bikes) put(b, 3)
  }
  return { type: 'frame', buf: a, counts, nPeople, nBikes, base, simT: simT + rem, cars: cars.length, people: peds.length + statics.length }
}
// a point s metres along the car's way (behind: its previous segment, ahead: its route)
function posOn(car, s, o) {
  let seg = car.seg
  if (s < 0 && car.prev) { seg = car.prev; s += seg.len }
  else if (s > seg.len && car.route[0]) { s -= seg.len; seg = car.route[0] }
  return at(seg, s, o)
}

// ?lifedebug on the page: what is near a point, why cars are standing, totals
function debug({ x, y, r }) {
  const why = {}
  for (const c of cars) if (c.v < 0.3) { const k = c.k < c.seg.cars.length - 1 ? 'queue' : c.seg.conn ? 'junction' : c.why || 'ahead'; why[k] = (why[k] || 0) + 1 }
  return {
    type: 'debug', why, total: cars.length, meanV: cars.reduce((a, c) => a + c.v, 0) / (cars.length || 1), carTarget, stuck, peds: peds.length, statics: statics.length, bikes: bikes.length, pedTarget, simT,
    lcTotal, changing: cars.filter((c) => c.lc).map((c) => { posOn(c, c.s, tmp); return [Math.round(tmp.x), Math.round(tmp.y), c.id, +c.lc.t.toFixed(2)] }), // [x, north, id, progress]
    obstacles: obstacles.size, blocked: blocked.length,
    ctls: net?.ctls.length, lanes: net?.lanes.length,
    lanesNear: net?.lanes.filter((L) => { const m = L.x.length >> 1; return Math.hypot(L.x[m] - x, L.y[m] - y) < r }).slice(0, 30)
      .map((L) => ({ kind: L.cls, a: L.p.a, b: L.p.b, dir: L.dir, li: L.li, cars: L.cars.length, len: L.len | 0, level: L.p.tile.level })),
  }
}
