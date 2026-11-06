// Traffic for the In code tab, off the page's thread. Cars drive OpenStreetMap's lanes on the
// right, turn through junctions on curves, keep their distance (intelligent driver model), stop at
// two-phase signals where major roads cross and give way at the other junctions. Each tick posts
// x, y, z, heading per car in three.js coordinates.
const LANE = 3.2
const V0 = [22, 14, 13, 11, 8.5] // free speed by road class, m/s
const IDM = { a: 1.5, b: 2.5, T: 1.2, s0: 2 }
const GREEN = 20, AMBER = 3, CLEAR = 2, CYCLE = 2 * (GREEN + AMBER + CLEAR)
let rand = Math.random
let lanes, cars, laneCum, out, running = false, t = 0, last = 0

function polyline(x, y, z) {
  const n = x.length, cum = new Float64Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1])
  return { x, y, z, cum, len: cum[n - 1] }
}
function at(p, s) { // position and direction at distance s
  s = Math.max(0, Math.min(p.len, s))
  let lo = 0, hi = p.cum.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.cum[m] < s) lo = m; else hi = m }
  const f = (s - p.cum[lo]) / Math.max(1e-9, p.cum[hi] - p.cum[lo]), dx = p.x[hi] - p.x[lo], dy = p.y[hi] - p.y[lo]
  return [p.x[lo] + dx * f, p.y[lo] + dy * f, p.z[lo] + (p.z[hi] - p.z[lo]) * f, Math.atan2(dy, dx)]
}
function cut(p, s0, s1) { // the polyline between s0 and len - s1
  const x = [], y = [], z = [], b = p.len - s1
  const push = (q) => { x.push(q[0]); y.push(q[1]); z.push(q[2]) }
  push(at(p, s0))
  for (let i = 0; i < p.cum.length; i++) if (p.cum[i] > s0 + 0.05 && p.cum[i] < b - 0.05) push([p.x[i], p.y[i], p.z[i]])
  push(at(p, b))
  return polyline(Float64Array.from(x), Float64Array.from(y), Float64Array.from(z))
}
const heading = (p, end) => { const i = end ? p.x.length - 2 : 0; return Math.atan2(p.y[i + 1] - p.y[i], p.x[i + 1] - p.x[i]) }
const turn = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

function build({ nNodes, meta, pts }) {
  const P = meta.length / 7
  const nodes = Array.from({ length: nNodes }, () => ({ deg: 0, half: 0, majors: 0, best: 9, ins: [], outs: [], busy: new Map(), signal: false, ref: 0, off: rand() * CYCLE }))
  for (let i = 0; i < P; i++) {
    const [a, b, cls, ow, per] = meta.subarray(i * 7, i * 7 + 5)
    for (const n of [nodes[a], nodes[b]]) {
      n.deg++; n.half = Math.max(n.half, ((ow ? per : 2 * per) * LANE) / 2 + 1.5)
      if (cls <= 2) n.majors++
      n.best = Math.min(n.best, cls)
    }
  }
  const all = []
  for (let i = 0; i < P; i++) {
    const [a, b, cls, ow, per, first, n] = meta.subarray(i * 7, i * 7 + 7)
    for (const dir of ow ? [0] : [0, 1]) {
      const idx = [...Array(n).keys()].map((k) => first + (dir ? n - 1 - k : k))
      const from = dir ? b : a, to = dir ? a : b
      for (let li = 0; li < per; li++) {
        // li 0 is the leftmost lane; each direction keeps right of the centre line
        const off = ow ? (li - (per - 1) / 2) * LANE : (li + 0.5) * LANE
        const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n)
        idx.forEach((s, k) => {
          const p = idx[Math.max(0, k - 1)], q = idx[Math.min(n - 1, k + 1)]
          let tx = pts[q * 3] - pts[p * 3], ty = pts[q * 3 + 1] - pts[p * 3 + 1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l
          x[k] = pts[s * 3] + ty * off; y[k] = pts[s * 3 + 1] - tx * off; z[k] = pts[s * 3 + 2]
        })
        let p = polyline(x, y, z)
        if (p.len < 1) continue
        const s0 = nodes[from].deg >= 3 ? Math.min(nodes[from].half, p.len * 0.45) : 0
        const s1 = nodes[to].deg >= 3 ? Math.min(nodes[to].half, p.len * 0.45) : 0
        if (s0 + s1 > 0) p = cut(p, s0, s1)
        const lane = { ...p, piece: i, dir, li, n: per, cls, v0: V0[cls], from, to, cars: [], outs: [], conn: false }
        all.push(lane); nodes[from].outs.push(lane); nodes[to].ins.push(lane)
      }
    }
  }
  nodes.forEach((nd, ni) => {
    nd.signal = nd.deg >= 3 && nd.majors >= 2
    const major = nd.ins.find((l) => l.cls <= 2)
    if (major) nd.ref = heading(major, true)
    for (const L of nd.ins) {
      const hin = heading(L, true), dead = nd.deg === 1
      const opts = []
      for (const M of nd.outs) {
        const u = M.piece === L.piece
        if (u && !dead) continue
        const ang = turn(hin, heading(M, false))
        if (!u && Math.abs(ang) > 2.6) continue
        opts.push({ M, ang, type: u ? 'U' : Math.abs(ang) < 0.5 ? 'S' : ang > 0 ? 'L' : 'R' })
      }
      const ok = ({ M, type }) => type === 'S' ? M.li === Math.min(L.li, M.n - 1)
        : type === 'R' ? L.li === L.n - 1 && M.li === M.n - 1 : L.li === 0 && M.li === 0
      let use = opts.filter(ok)
      if (!use.length && opts.length) { // nowhere this lane may go: take the straightest way on
        const o = opts.sort((p, q) => Math.abs(p.ang) - Math.abs(q.ang))[0]
        use = opts.filter((p) => p.M.piece === o.M.piece && p.M.dir === o.M.dir && p.M.li === Math.min(L.li, p.M.n - 1))
      }
      for (const { M, type } of use) L.outs.push(connector(L, M, type, nd))
    }
  })
  return all
}
function connector(L, M, type, nd) {
  const e = L.x.length - 1, x0 = L.x[e], y0 = L.y[e], z0 = L.z[e], x3 = M.x[0], y3 = M.y[0], z3 = M.z[0]
  const h0 = heading(L, true), h3 = heading(M, false), d = Math.hypot(x3 - x0, y3 - y0)
  const k = type === 'U' ? Math.max(4, d * 0.8) : d * 0.45
  const x = [], y = [], z = []
  for (let i = 0; i <= 8; i++) {
    const s = i / 8, u = 1 - s, b = [u * u * u, 3 * u * u * s, 3 * u * s * s, s * s * s]
    x.push(b[0] * x0 + b[1] * (x0 + Math.cos(h0) * k) + b[2] * (x3 - Math.cos(h3) * k) + b[3] * x3)
    y.push(b[0] * y0 + b[1] * (y0 + Math.sin(h0) * k) + b[2] * (y3 - Math.sin(h3) * k) + b[3] * y3)
    z.push(z0 + (z3 - z0) * s)
  }
  const c = { ...polyline(Float64Array.from(x), Float64Array.from(y), Float64Array.from(z)), conn: true, node: nd, to: M, cars: [], type,
    approach: L.piece * 2 + L.dir, cls: Math.min(L.cls, M.cls), v0: type === 'S' ? Math.min(L.v0, M.v0) : type === 'U' ? 3 : 6.5, from: L }
  c.group = Math.abs(Math.cos(h0 - nd.ref)) > 0.7 ? 0 : 1
  c.w = (type === 'S' ? 3 : 1) * (6 - M.cls)
  return c
}

function light(c) { // 2 green, 1 amber, 0 red
  const u = (t + c.node.off - c.group * (GREEN + AMBER + CLEAR) + CYCLE * 2) % CYCLE
  return u < GREEN ? 2 : u < GREEN + AMBER ? 1 : 0
}
function insert(seg, car) {
  const a = seg.cars; let i = 0
  while (i < a.length && a[i].s < car.s) i++
  a.splice(i, 0, car)
  if (seg.conn) seg.node.busy.set(seg.approach, (seg.node.busy.get(seg.approach) || 0) + 1)
}
function remove(seg, car) {
  const a = seg.cars, i = a.indexOf(car)
  if (i >= 0) a.splice(i, 1)
  if (seg.conn) seg.node.busy.set(seg.approach, seg.node.busy.get(seg.approach) - 1)
}
function choose(car) {
  const outs = car.seg.outs
  if (!outs.length) { car.next = null; return }
  let r = 0
  for (const c of outs) r += c.w
  r *= rand()
  for (const c of outs) { r -= c.w; if (r <= 0) { car.next = c; return } }
  car.next = outs[outs.length - 1]
}
function place(car) {
  for (let tries = 0; tries < 10; tries++) {
    let r = rand() * laneCum[laneCum.length - 1], lo = 0, hi = laneCum.length - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (laneCum[m] < r) lo = m + 1; else hi = m }
    const seg = lanes[lo]
    if (seg.len < car.L + 2) continue
    const s = car.L + rand() * (seg.len - car.L)
    if (tries < 9 && seg.cars.some((o) => Math.abs(o.s - s) < car.L + 5)) continue
    Object.assign(car, { seg, s, v: seg.v0 * 0.5, prev: null, wait: 0, committed: null })
    insert(seg, car); choose(car)
    return
  }
}
function respawn(car) { remove(car.seg, car); place(car) }

function permit(car, c, dist) {
  if (car.committed === c) return true
  const nd = c.node
  let go = true
  if (nd.signal) { const st = light(c); go = st === 2 || (st === 1 && dist < (car.v * car.v) / (2 * IDM.b) + 1) }
  else if (nd.deg >= 3 && c.from.cls > nd.best && car.wait < 5) for (const [k, n] of nd.busy) if (k !== c.approach && n > 0) { go = false; break }
  if (go && dist < 3) car.committed = c
  return go
}
function gap(car) { // distance to what is ahead, its speed, and whether it is a stop line
  const seg = car.seg, a = seg.cars
  if (car.k < a.length - 1) { const o = a[car.k + 1]; return [o.s - o.L - car.s, o.v, false] }
  let dist = seg.len - car.s
  let M = seg.to
  if (!seg.conn) {
    const c = car.next
    if (!c) return [1e9, 0, false]
    if (!permit(car, c, dist)) return [dist - 1, 0, true]
    if (c.cars.length) { const o = c.cars[0]; return [dist + o.s - o.L, o.v, false] }
    dist += c.len; M = c.to
  }
  if (M.cars.length) { const o = M.cars[0]; return [dist + o.s - o.L, o.v, false] }
  return [1e9, 0, false]
}
let stamp = 0
function step(dt) {
  t += dt; stamp++
  for (const car of cars) {
    const seg = car.seg
    if (seg.stamp !== stamp) { seg.stamp = stamp; seg.cars.sort((p, q) => p.s - q.s); seg.cars.forEach((o, k) => (o.k = k)) }
  }
  for (const car of cars) {
    const [g, vl, stop] = gap(car)
    const v0 = car.seg.v0 * car.vf, v = car.v
    const ss = IDM.s0 + Math.max(0, v * IDM.T + (v * (v - vl)) / (2 * Math.sqrt(IDM.a * IDM.b)))
    car.acc = Math.max(-9, IDM.a * (1 - (v / v0) ** 4 - (ss / Math.max(0.1, g)) ** 2))
    car.stopAt = stop ? car.s + Math.max(0, g) : Infinity
  }
  for (const car of cars) {
    const v = Math.max(0, car.v + car.acc * dt)
    car.s += Math.max(0, ((car.v + v) / 2) * dt); car.v = v
    if (car.s > car.stopAt) { car.s = car.stopAt; car.v = 0 }
    car.wait = car.v < 0.3 ? car.wait + dt : 0
    if (car.wait > 60) { respawn(car); continue } // a real deadlock: clear it
    while (car.s > car.seg.len) {
      const old = car.seg
      const nx = old.conn ? old.to : car.next
      if (!nx) { respawn(car); break }
      remove(old, car)
      car.s -= old.len; car.prev = old; car.seg = nx
      if (car.committed === nx) car.committed = null
      insert(nx, car)
      if (!nx.conn) choose(car)
    }
  }
}
function post() {
  const a = new Float32Array(cars.length * 4)
  cars.forEach((car, i) => {
    let seg = car.seg, s = car.s - car.L / 2
    if (s < 0 && car.prev) { seg = car.prev; s += seg.len }
    const [x, y, z, h] = at(seg, s)
    a[i * 4] = x; a[i * 4 + 1] = z + 0.05; a[i * 4 + 2] = -y; a[i * 4 + 3] = h
  })
  postMessage(a, [a.buffer])
}
const raf = self.requestAnimationFrame?.bind(self) ?? ((f) => setTimeout(() => f(performance.now()), 16))
function tick(now) {
  if (!running) return
  const dt = Math.min(0.1, (now - last) / 1000); last = now
  const n = Math.ceil(dt / 0.05)
  for (let i = 0; i < n; i++) step(dt / n)
  post()
  raf(tick)
}
onmessage = ({ data }) => {
  if ('run' in data) {
    const was = running; running = data.run
    if (running && !was && cars) { last = performance.now(); raf(tick) }
    return
  }
  lanes = build(data.roads)
  laneCum = new Float64Array(lanes.length)
  lanes.forEach((l, i) => (laneCum[i] = (i ? laneCum[i - 1] : 0) + l.len * (6 - l.cls)))
  cars = Array.from(data.len, (L) => ({ L, vf: 0.85 + rand() * 0.25 }))
  for (const car of cars) place(car)
  for (let i = 0; i < 200; i++) step(0.1) // settle into queues before anyone sees it
  post()
  if (running) { last = performance.now(); raf(tick) }
}
