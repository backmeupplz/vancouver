// Salmonberry Parcel Co.: a cozy delivery minigame on the real streets. "Deliver" (or D) drops from the map into
// a third-person view behind a little van on the street nearest the middle of the screen; Esc flies back.
// Pick parcels up at real shops and cafés and drop them at other places and houses nearby. No fail states.
// Data: roads, buildings and water from the map tiles; named places from OpenStreetMap (places.json, made by
// tools/delivery_places.py), © OpenStreetMap contributors, ODbL. Sounds are synthesised with Web Audio.
import { makeVan } from './van.js'

const DRIVE_MAX_KIND = 7 // motorway .. living street (graph piece kinds): where a van belongs
const CELL = 32 // metres, spatial grid for roads and footprints
const WB = 2.7 // wheelbase
const MAX_SPEED = 17, MAX_REVERSE = 6 // m/s
const ARRIVE = 9 // metres from a marker that count as there
const EASE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const ckey = (cx, cy) => cx * 8192 + cy

const NAMES = ['Mei', 'Arjun', 'Sofia', 'Daniel', 'Priya', 'Kenji', 'Amara', 'Liam', 'Noor', 'Jasmine', 'Tomás', 'Hana', 'Owen', 'Leilani', 'Ravi', 'Grace', 'Mateo', 'Yuki', 'Farah', 'Theo', 'Ines', 'Sam', 'Marguerite', 'Kai']
const THANKS = ['Thanks so much!', 'Oh, lovely. Thank you!', 'Right on time, you’re a star.', 'Perfect, have a cozy day!', 'Ah, I was hoping it’d come today!', 'Thank you, drive safe!', 'Wonderful, cheers!']
const ITEMS = {
  bakery: ['a box of warm cinnamon buns', 'a sourdough loaf', 'a dozen bagels'], cafe: ['two oat-milk lattes', 'a bag of fresh beans', 'a tray of matcha lattes'],
  books: ['a stack of paperbacks', 'a signed novel'], florist: ['a bouquet of tulips', 'a little potted fern'], 'garden centre': ['a potted lemon tree', 'a sack of seed potatoes'],
  pharmacy: ['a small paper bag'], bicycle: ['a new bike bell', 'a set of panniers'], restaurant: ['a warm dinner for two', 'a box of dumplings'], 'fast food': ['a bag of fries, still hot'],
  'ice cream': ['a pint of salted caramel'], supermarket: ['a crate of groceries'], convenience: ['a carton of milk and some snacks'], greengrocer: ['a box of BC apples'],
  pet: ['a bag of cat food', 'a squeaky toy'], toys: ['a wooden train set'], music: ['a vinyl record'], hardware: ['a toolbox', 'a tin of paint'], doityourself: ['a tin of paint'],
  library: ['a pile of returned books'], tea: ['a tin of loose-leaf tea'], gift: ['a wrapped present'], clothes: ['a knitted sweater'], 'outdoor': ['a new rain jacket'],
  chocolate: ['a box of truffles'], deli: ['a picnic basket'], pub: ['a growler of local ale'], seafood: ['a cooler of fresh salmon'], 'post office': ['a sack of letters'],
}
const DEFAULT_ITEMS = ['a small parcel', 'a carefully taped box', 'a padded envelope', 'a parcel marked “fragile”']

export default function delivery(city) {
  const { THREE } = city
  const v3 = new THREE.Vector3(), v4 = new THREE.Vector3()

  // ================================================================ the street index (detail tiles, lazily)
  const infos = new Map(), overview = new Map(), built = new Map() // "i_j" -> tile info / its index
  const nodes = new Map(), tileEdges = new Map(), pendingGraph = new Set() // the road graph, see graph()
  const offTiles = [
    city.world.eachTile((t) => { const k = `${t.i}_${t.j}`; if (t.level === 0) { infos.set(k, t); built.delete(k); dropGraph(k); pendingGraph.add(k) } else overview.set(k, t) }),
    city.on('tile:unload', (t) => { const k = `${t.i}_${t.j}`; if (t.level === 0) { infos.delete(k); built.delete(k); dropGraph(k) } else overview.delete(k) }),
  ]
  function index(t) { // roads (drivable segments) and building footprints on a grid
    const segs = [], rg = new Map(), fg = new Map()
    const put = (g, k, v) => { let a = g.get(k); if (!a) g.set(k, (a = [])); if (a[a.length - 1] !== v) a.push(v) }
    for (const p of t.graph.pieces) {
      if (!p.drive || p.kind > DRIVE_MAX_KIND) continue
      for (let i = 0; i < p.pts.length / 2 - 1; i++) {
        const s = { p, i, x0: p.pts[i * 2], y0: p.pts[i * 2 + 1], x1: p.pts[i * 2 + 2], y1: p.pts[i * 2 + 3], z0: p.z ? p.z[i] : null, z1: p.z ? p.z[i + 1] : null }
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
    for (let i = Math.floor((x - r - 200) / 1024); i <= Math.floor((x + r + 200) / 1024); i++) for (let j = Math.floor((y - r - 200) / 1024); j <= Math.floor((y + r + 200) / 1024); j++) {
      const k = `${i}_${j}`
      let b = built.get(k)
      if (!b) { const t = infos.get(k); if (!t) continue; b = index(t); built.set(k, b) }
      fn(b)
    }
  }
  // the nearest drivable segment point within r metres; deck: only bridge segments
  function nearestRoad(x, y, r, deck = false) {
    let best = null, bd = r
    each(x, y, r, (b) => {
      const seen = new Set()
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
        for (const id of b.rg.get(ckey(cx, cy)) || []) {
          if (seen.has(id)) continue
          seen.add(id)
          const s = b.segs[id]
          if (deck && s.z0 == null) continue
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
  function insideBuilding(x, y) { const c = collide(x, y, 0.01); return !!c }
  function isWater(x, y) {
    const t = infos.get(`${Math.floor(x / 1024)}_${Math.floor(y / 1024)}`)
    if (!t?.water) return false
    const n = t.water.n, i = Math.floor(((x - t.ox) / 1024) * n), j = Math.floor(((y - t.oy) / 1024) * n)
    return i >= 0 && j >= 0 && i < n && j < n && t.water.mask[j * n + i] === 1
  }

  // ================================================================ routing over the loaded road graph
  // the graph grows and shrinks with the tiles: a tile's edges are added when a route first needs them
  function dropGraph(k) {
    pendingGraph.delete(k)
    for (const [n, e] of tileEdges.get(k) || []) { n.adj.splice(n.adj.indexOf(e), 1); if (!n.adj.length) nodes.delete(n.id) }
    tileEdges.delete(k)
  }
  function graph() {
    const node = (id, x, y) => { let n = nodes.get(id); if (!n) nodes.set(id, (n = { id, x, y, adj: [] })); return n }
    for (const k of pendingGraph) {
      const added = []
      for (const p of infos.get(k).graph.pieces) {
        if (!p.drive || p.kind > DRIVE_MAX_KIND) continue
        let len = 0
        for (let i = 0; i < p.pts.length / 2 - 1; i++) len += Math.hypot(p.pts[i * 2 + 2] - p.pts[i * 2], p.pts[i * 2 + 3] - p.pts[i * 2 + 1])
        const m = p.pts.length - 2, A = node(p.a, p.pts[0], p.pts[1]), B = node(p.b, p.pts[m], p.pts[m + 1])
        const ea = { to: B, len, p, fwd: true }, eb = { to: A, len, p, fwd: false }
        A.adj.push(ea); B.adj.push(eb); added.push([A, ea], [B, eb])
      }
      tileEdges.set(k, added)
    }
    pendingGraph.clear()
    return nodes
  }
  // a piece's points from segment point (i, u) to its a end (toB false) or b end, as [x, y, z|null] triples
  function partial(p, i, u, toB) {
    const P = p.pts, n = P.length / 2, out = []
    const at = (k) => [P[k * 2], P[k * 2 + 1], p.z ? p.z[k] : null]
    const x = P[i * 2] + (P[i * 2 + 2] - P[i * 2]) * u, y = P[i * 2 + 1] + (P[i * 2 + 3] - P[i * 2 + 1]) * u
    out.push([x, y, p.z ? p.z[i] + (p.z[i + 1] - p.z[i]) * u : null])
    if (toB) for (let k = i + 1; k < n; k++) out.push(at(k)); else for (let k = i; k >= 0; k--) out.push(at(k))
    return out
  }
  const lenOf = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s }
  // A* from the road under (x0, y0) to the road at the target; returns [[x, y, z|null], ...] or null
  function route(x0, y0, tgt) {
    const a = nearestRoad(x0, y0, 60), b = tgt.road
    if (!a || !b) return null
    const N = graph()
    if (a.s.p.a === b.s.p.a && a.s.p.b === b.s.p.b) { // on the same piece: along it
      const P = a.s.p.pts, at = (k) => [P[k * 2], P[k * 2 + 1], a.s.p.z ? a.s.p.z[k] : null], out = [[a.px, a.py, a.z]]
      if (a.s.i + a.u <= b.s.i + b.u) for (let k = a.s.i + 1; k <= b.s.i; k++) out.push(at(k))
      else for (let k = a.s.i; k > b.s.i; k--) out.push(at(k))
      out.push([b.px, b.py, b.z])
      return out
    }
    const startA = partial(a.s.p, a.s.i, a.u, false), startB = partial(a.s.p, a.s.i, a.u, true)
    const goalA = partial(b.s.p, b.s.i, b.u, false), goalB = partial(b.s.p, b.s.i, b.u, true)
    const goals = new Map([[b.s.p.a, { pts: goalA, c: lenOf(goalA) }], [b.s.p.b, { pts: goalB, c: lenOf(goalB) }]])
    const g = new Map(), prev = new Map(), heap = []
    const hpush = (f, id) => { heap.push([f, id]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break;[heap[p], heap[i]] = [heap[i], heap[p]]; i = p } }
    const hpop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break;[heap[m], heap[i]] = [heap[i], heap[m]]; i = m } } return top }
    const h = (n) => Math.hypot(n.x - b.px, n.y - b.py)
    for (const [id, pts] of [[a.s.p.a, startA], [a.s.p.b, startB]]) { const n = N.get(id); if (!n) continue; const c = lenOf(pts); if (!(g.get(id) <= c)) { g.set(id, c); prev.set(id, { start: pts }); hpush(c + h(n), id) } }
    let best = null, bestC = Infinity, steps = 0
    while (heap.length && steps++ < 40000) {
      const [f, id] = hpop()
      if (f >= bestC) break
      const gc = g.get(id), n = N.get(id)
      if (goals.has(id) && gc + goals.get(id).c < bestC) { bestC = gc + goals.get(id).c; best = id }
      for (const e of n.adj) {
        const c = gc + e.len
        if (c < (g.get(e.to.id) ?? Infinity)) { g.set(e.to.id, c); prev.set(e.to.id, { from: id, e }); hpush(c + h(e.to), e.to.id) }
      }
    }
    if (best == null) return null
    const chain = []
    let id = best
    for (let guard = 0; guard < 5000; guard++) {
      const pr = prev.get(id)
      if (pr.start) { chain.unshift(...pr.start); break }
      const P = pr.e.p, n = P.pts.length / 2, seg = []
      for (let k = 0; k < n; k++) seg.push([P.pts[k * 2], P.pts[k * 2 + 1], P.z ? P.z[k] : null])
      if (!pr.e.fwd) seg.reverse()
      chain.unshift(...seg.slice(1))
      id = pr.from
    }
    chain.push(...[...goals.get(best).pts].reverse().slice(1))
    return chain
  }

  // ================================================================ places (OpenStreetMap shops, cafés, ...)
  let places = null
  async function loadPlaces() {
    if (places) return places
    try {
      const d = await fetch(new URL('./places.json', import.meta.url)).then((r) => r.json())
      const grid = new Map() // by ~550 m lat/lon cells; world positions are worked out only for places asked about
      for (const [la, lo, name, k, addr] of d.places) {
        const key = ckey(Math.floor(la / 500), Math.floor(lo / 770))
        if (!grid.has(key)) grid.set(key, [])
        grid.get(key).push({ la: la / 1e5, lo: lo / 1e5, name, kind: d.kinds[k], addr })
      }
      places = grid
    } catch (e) { console.warn('delivery: no places', e); places = new Map() }
    return places
  }
  function placesNear(x, y, r0, r1) {
    const out = []
    if (!places) return out
    const { lat, lon } = city.world.toLatLon(x, -y), dla = r1 / 111000, dlo = r1 / 72000
    for (let a = Math.floor(((lat - dla) * 1e5) / 500); a <= Math.floor(((lat + dla) * 1e5) / 500); a++) for (let b = Math.floor(((lon - dlo) * 1e5) / 770); b <= Math.floor(((lon + dlo) * 1e5) / 770); b++) {
      for (const p of places.get(ckey(a, b)) || []) {
        if (p.x == null) { const v = city.world.fromLatLon(p.la, p.lo); p.x = v.x; p.y = -v.z }
        const d = Math.hypot(p.x - x, p.y - y)
        if (d >= r0 && d <= r1) out.push(p)
      }
    }
    return out
  }
  // where a van stops for a point: the nearest drivable road within reach
  function stopFor(x, y) {
    const r = nearestRoad(x, y, 70)
    if (!r || r.dist > 70) return null
    const dx = x - r.px, dy = y - r.py, l = Math.hypot(dx, dy) || 1, off = Math.min(l, Math.max(0, r.w / 2 - 1.4)) // the kerb lane
    return { x: r.px + (dx / l) * off, y: r.py + (dy / l) * off, road: r }
  }
  function houseNear(x, y, r0, r1) { // a house-sized footprint, for drop-offs away from named places
    const found = []
    each(x, y, r1, (b) => {
      if (!b.fp) return
      for (let r = 0; r < b.fp.start.length - 1; r++) {
        const w = b.bb[r * 4 + 2] - b.bb[r * 4], h = b.bb[r * 4 + 3] - b.bb[r * 4 + 1], cx = b.bb[r * 4] + w / 2, cy = b.bb[r * 4 + 1] + h / 2
        if (w * h < 50 || w * h > 700) continue
        const d = Math.hypot(cx - x, cy - y)
        if (d >= r0 && d <= r1) found.push({ x: cx, y: cy })
      }
    })
    for (let k = 0; k < 12 && found.length; k++) { const f = found.splice(Math.floor(Math.random() * found.length), 1)[0], s = stopFor(f.x, f.y); if (s) return { ...f, stop: s } }
    return null
  }

  // ================================================================ scene objects
  const van = makeVan(THREE)
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 5.0).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: radial('rgba(0,0,0,0.42)'), transparent: true, depthWrite: false, fog: false }))
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
  const routeMat = new THREE.ShaderMaterial({
    uniforms: { col: { value: new THREE.Color() }, t: { value: 0 } },
    vertexShader: 'attribute vec2 aR; varying vec2 vR; void main() { vR = aR; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 col; uniform float t; varying vec2 vR;
      void main() {
        float s = vR.x - abs(vR.y) * 1.6 - t * 7.0;
        float chev = 1.0 - smoothstep(0.32, 0.42, abs(fract(s / 4.5) - 0.5));
        float edge = 1.0 - smoothstep(0.7, 1.0, abs(vR.y));
        float a = (0.2 + 0.6 * chev) * edge * smoothstep(0.0, 6.0, vR.x);
        gl_FragColor = vec4(col, a);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  })
  const routeMesh = new THREE.Mesh(new THREE.BufferGeometry(), routeMat)
  routeMesh.frustumCulled = false
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
    splash() { if (!audio()) return; const t = ac.currentTime; tone(320, t, 0.3, 0.04, 'triangle'); tone(240, t + 0.05, 0.3, 0.03, 'triangle') },
    horn() { if (!audio()) return; const t = ac.currentTime; tone(523, t, 0.16, 0.05, 'square'); tone(523, t + 0.2, 0.18, 0.05, 'square'); tone(659, t, 0.16, 0.03, 'square'); tone(659, t + 0.2, 0.18, 0.03, 'square') },
  }
  function setMuted(m) { muted = m; try { localStorage.setItem('delivery.muted', m ? '1' : '0') } catch {}; if (ac) ac.out.gain.value = m ? 0 : 1; ui.mute.textContent = m ? 'Sound off' : 'Sound on' }

  // ================================================================ HUD
  const ui = makeUI()
  function makeUI() {
    const css = document.createElement('style')
    css.textContent = `
      .dlv { position: fixed; z-index: 25; font: 13px/1.35 system-ui, -apple-system, sans-serif; color: #fdf6ea; pointer-events: none; }
      .dlv[hidden] { display: none }
      .dlv.card, .dlv .card { background: rgba(38, 30, 28, 0.62); border: 1px solid rgba(255, 236, 214, 0.16); border-radius: 14px; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); box-shadow: 0 6px 22px rgba(0,0,0,.18); }
      .dlv button { pointer-events: auto; font: inherit; color: inherit; background: rgba(38, 30, 28, 0.62); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border: 1px solid rgba(255,236,214,.18); border-radius: 9px; padding: 5px 10px; cursor: pointer; }
      .dlv button:hover { background: rgba(70, 56, 52, 0.75) }
      .dlv-top { left: 12px; top: 12px; right: 12px; display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; }
      .dlv-co { padding: 9px 13px; min-width: 0; }
      .dlv-co .name { font-weight: 700; letter-spacing: .02em; color: #ffc9b5; font-size: 12px; text-transform: uppercase; }
      .dlv-co .stats { display: flex; gap: 12px; margin-top: 3px; font-variant-numeric: tabular-nums; font-size: 14px; }
      .dlv-co .stats b { font-weight: 650 }
      .dlv-co .stats span { color: #d9cbbb }
      .dlv-co .credit { font-size: 10px; color: #b9a99a; margin-top: 2px } .dlv-co .credit a { color: inherit; pointer-events: auto }
      .dlv-btns { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
      .dlv-job { left: 50%; top: 12px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 9px 16px 9px 10px; width: max-content; max-width: min(460px, calc(100vw - 24px)); box-sizing: border-box; }
      .dlv-arrow { flex: none; width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; background: rgba(255,255,255,.08); }
      .dlv-arrow svg { width: 30px; height: 30px; transition: transform .12s linear; }
      .dlv-job .what { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: #ffc9b5; font-weight: 650 }
      .dlv-job .where { font-size: 15px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 330px }
      .dlv-job .sub { color: #e2d4c4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 330px }
      .dlv-job .meta { display: flex; gap: 10px; color: #fdf6ea; font-variant-numeric: tabular-nums; margin-top: 1px }
      .dlv-job .late { color: #ffd38a }
      .dlv-help { left: 50%; bottom: 52px; transform: translateX(-50%); padding: 6px 12px; color: #e8dccd; font-size: 12px; white-space: nowrap; }
      .dlv-pop { left: 50%; top: 36%; transform: translate(-50%, -50%) scale(.9); padding: 12px 20px; text-align: center; opacity: 0; transition: opacity .3s, transform .3s; }
      .dlv-pop.on { opacity: 1; transform: translate(-50%, -50%) scale(1) }
      .dlv-pop .big { font-size: 22px; font-weight: 750; color: #ffe1a8 }
      .dlv-pop .q { color: #e8dccd; margin-top: 2px }
      .dlv-touch { inset: auto 0 0 0; height: 170px; display: none; }
      .dlv-touch button { position: absolute; bottom: 52px; width: 74px; height: 74px; border-radius: 50%; font-size: 15px; font-weight: 650; background: rgba(38,30,28,.5); border: 2px solid rgba(255,236,214,.35); touch-action: none; user-select: none; -webkit-user-select: none; }
      .dlv-touch button.on { background: rgba(232,115,90,.75) }
      .dlv-touch .l { left: 16px } .dlv-touch .r { left: 100px } .dlv-touch .gas { right: 16px; height: 100px; border-radius: 22px } .dlv-touch .brk { right: 100px; width: 66px; height: 66px }
      body.dlv-on.dlv-touchy .dlv-touch { display: block }
      body.dlv-on.dlv-touchy .dlv-help { display: none }
      body.dlv-on #bar, body.dlv-on #hint, body.dlv-on #about, body.dlv-on #tools, body.dlv-on .tool-panel { display: none !important }
      body.dlv-on.dlv-touchy .lofi { left: 50% !important; transform: translateX(-50%); bottom: 168px !important; }
      @media (max-width: 1000px) { .dlv-job { top: 74px } }
      @media (max-width: 640px) {
        .dlv-top { flex-direction: column; }
        .dlv-co { padding: 7px 11px }
        .dlv-btns { position: absolute; right: 0; top: 0 }
        .dlv-btns .opt { display: none }
        .dlv-job .where, .dlv-job .sub { max-width: 250px }
      }`
    document.head.append(css)
    const el = (cls, html, parent = document.body) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; d.hidden = true; parent.append(d); return d }
    const top = el('dlv dlv-top', `<div class="card dlv-co"><div class="name">Salmonberry Parcel Co.</div>
      <div class="stats"><span><b data-n>0</b> delivered</span><span><b data-m>$0.00</b></span><span data-c></span></div><div class="credit">Places © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</div></div>
      <div class="dlv-btns"><button class="opt" data-assist title="Gently lines the van up with the road (G)">Assist on</button><button class="opt" data-mute title="Sound (M)">Sound on</button><button data-exit title="Back to the map (Esc)">Back to map</button></div>`)
    const job = el('dlv dlv-job card', `<div class="dlv-arrow"><svg viewBox="0 0 30 30"><path d="M15 3 L25 25 L15 20 L5 25 Z" fill="#ffc9b5" stroke="#3a2a26" stroke-width="1.5" stroke-linejoin="round"/></svg></div>
      <div><div class="what" data-w></div><div class="where" data-p></div><div class="sub" data-s></div><div class="meta"><span data-d></span><span data-t></span></div></div>`)
    const help = el('dlv dlv-help card', 'WASD or arrows to drive · Space to brake · H horn · R back on the road · Esc to the map')
    const pop = el('dlv dlv-pop card', '<div class="big" data-b></div><div class="q" data-q></div>')
    const touch = el('dlv dlv-touch', '<button class="l" data-k="left" aria-label="Steer left">◀</button><button class="r" data-k="right" aria-label="Steer right">▶</button><button class="brk" data-k="brake" aria-label="Brake and reverse">Brake</button><button class="gas" data-k="gas" aria-label="Accelerate">Go</button>')
    const q = (e, s) => e.querySelector(s)
    return { top, job, help, pop, touch, all: [top, job, help, pop, touch], n: q(top, '[data-n]'), m: q(top, '[data-m]'), c: q(top, '[data-c]'), assist: q(top, '[data-assist]'), mute: q(top, '[data-mute]'), exit: q(top, '[data-exit]'),
      arrow: q(job, 'svg'), w: q(job, '[data-w]'), p: q(job, '[data-p]'), s: q(job, '[data-s]'), d: q(job, '[data-d]'), t: q(job, '[data-t]'), b: q(pop, '[data-b]'), qq: q(pop, '[data-q]'), css }
  }
  const touchy = matchMedia('(pointer: coarse)').matches
  const touchState = { left: false, right: false, gas: false, brake: false }
  for (const b of ui.touch.querySelectorAll('button')) {
    const k = b.dataset.k, set = (on) => (e) => { e.preventDefault(); touchState[k] = on; b.classList.toggle('on', on); if (on) audio() }
    b.addEventListener('pointerdown', (e) => { try { b.setPointerCapture(e.pointerId) } catch {} set(true)(e) })
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, set(false))
    b.addEventListener('contextmenu', (e) => e.preventDefault())
  }
  ui.exit.onclick = () => exit()
  ui.assist.onclick = () => { assist = !assist; ui.assist.textContent = assist ? 'Assist on' : 'Assist off' }
  ui.mute.onclick = () => setMuted(!muted)
  ui.mute.textContent = muted ? 'Sound off' : 'Sound on'
  let popT = 0
  function popup(big, line) {
    ui.b.textContent = big; ui.qq.textContent = line
    ui.pop.hidden = false
    requestAnimationFrame(() => ui.pop.classList.add('on'))
    clearTimeout(popT); popT = setTimeout(() => { ui.pop.classList.remove('on'); setTimeout(() => { if (!ui.pop.classList.contains('on')) ui.pop.hidden = true }, 350) }, 2600)
  }

  // ================================================================ the game state
  const pcam = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.4, 1800)
  const opts = { focus: new THREE.Vector3(), radius: 900, shadowRadius: 300 }
  const car = { x: 0, y: 0, h: 0, yaw: 0, speed: 0, steer: 0, spin: 0, pitch: 0, roll: 0, bank: 0, deck: false, bumpT: 0 }
  const chase = { pos: new THREE.Vector3(), look: new THREE.Vector3(), yaw: 0 }
  let state = 'off', anim = null, offFrame = null, t0 = 0, mapPose = null, fromPose = null, saved = null
  let assist = true, job = null, shift = { n: 0, money: 0 }, routePts = null, routeAt = 0, routeFrom = { x: 0, y: 0 }, hudAt = 0, jobRetry = 0
  const keys = new Set()

  const button = city.ui.addButton({ label: 'Deliver', icon: '📦', title: 'Drive a delivery van on these streets (D)', onClick: () => (state === 'off' ? enter() : state === 'play' && exit()) })

  function spawnPoint() { // the drivable street nearest the middle of the screen
    const c = city.view.center, x = c.x, y = -c.z
    let best = null, bd = Infinity
    const scan = (t) => {
      for (const p of t.graph.pieces) {
        if (!p.drive || p.kind > DRIVE_MAX_KIND || p.z) continue
        const pen = p.kind <= 1 ? 80 : p.kind === 6 ? 25 : 0 // rather a street than a motorway or a parking aisle
        for (let i = 0; i < p.pts.length / 2 - 1; i++) {
          const x0 = p.pts[i * 2], y0 = p.pts[i * 2 + 1], dx = p.pts[i * 2 + 2] - x0, dy = p.pts[i * 2 + 3] - y0, L2 = dx * dx + dy * dy || 1
          const u = clamp(((x - x0) * dx + (y - y0) * dy) / L2, 0, 1), d = Math.hypot(x - x0 - dx * u, y - y0 - dy * u) + pen
          if (d < bd) { bd = d; best = { x: x0 + dx * u, y: y0 + dy * u, dir: Math.atan2(dy, dx), w: p.w } }
        }
      }
    }
    for (const t of infos.values()) scan(t)
    if (!best || bd > 600) for (const t of overview.values()) scan(t)
    return best
  }
  const yawFromDir = (dir) => dir - Math.PI / 2 // road direction atan2(dy, dx) in (x, north) to the van's yaw
  const fwdX = (yaw) => -Math.sin(yaw), fwdY = (yaw) => Math.cos(yaw) // forward in (x, north)

  function enter() {
    if (state !== 'off') return
    const sp = spawnPoint()
    if (!sp) { city.ui.toast('No streets here: move the map over the city first'); return }
    audio()
    loadPlaces()
    document.activeElement?.blur?.() // a focused toolbar button would take Space (brake) as a click
    Object.assign(car, { x: sp.x - Math.cos(sp.dir + Math.PI / 2) * sp.w * 0.22, y: sp.y - Math.sin(sp.dir + Math.PI / 2) * sp.w * 0.22, yaw: yawFromDir(sp.dir), speed: 0, steer: 0, pitch: 0, roll: 0, bank: 0, deck: false })
    car.h = surface(car.x, car.y, city.world.heightAt(car.x, -car.y) + 0.2).y
    // where the map camera is: the dive starts there, and Esc returns there exactly
    const C = city.camera, T = city.controls.target
    mapPose = { look: T.clone(), dir: C.position.clone().sub(T).normalize(), H: (C.top - C.bottom) / C.zoom, fov: 2 }
    chase.yaw = car.yaw
    chasePose(0, true)
    shift = { n: 0, money: 0 }; job = null; routePts = null; jobRetry = 0
    saved = { bg: city.scene.background, fog: city.scene.fog }
    city.scene.add(van, icons.pickup, icons.drop)
    icons.pickup.visible = icons.drop.visible = false
    city.overlay.add(blob, beam, ring, ring2, routeMesh, pool)
    beam.visible = ring.visible = ring2.visible = false
    placeVan()
    fitCamera()
    state = 'in'; t0 = performance.now()
    city.view.useCamera(pcam, opts)
    anim = city.animate()
    offFrame = city.on('frame', frame)
    document.body.classList.add('dlv-on')
    document.body.classList.toggle('dlv-touchy', touchy)
    button.button.setAttribute('aria-pressed', 'true')
    pose(0)
  }
  function exit() {
    if (state !== 'play') return
    fromPose = { look: chase.look.clone(), dir: chase.pos.clone().sub(chase.look).normalize(), H: 2 * chase.pos.distanceTo(chase.look) * Math.tan((pcam.fov * Math.PI) / 360), fov: pcam.fov }
    state = 'out'; t0 = performance.now()
    for (const e of ui.all) e.hidden = true
    keys.clear()
    if (engine) engine.g.gain.setTargetAtTime(0, ac.currentTime, 0.2)
    const { n, money } = shift, all = saveTotals()
    if (n) setTimeout(() => city.ui.toast(`Shift done: ${n} ${n === 1 ? 'parcel' : 'parcels'}, $${money.toFixed(2)}${all ? ` ($${all.money.toFixed(2)} all time)` : ''}. Thanks for driving!`, 4500), 1800)
  }
  function finish() { // back on the map camera, exactly where it was
    state = 'off'
    city.view.release()
    offFrame?.(); offFrame = null
    anim?.(); anim = null
    city.scene.remove(van, icons.pickup, icons.drop)
    city.overlay.remove(blob, beam, ring, ring2, routeMesh, pool)
    city.scene.background = saved.bg; city.scene.fog = saved.fog
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

  // ---------------------------------------------------------------- camera
  function fitCamera() {
    pcam.aspect = innerWidth / innerHeight
    pcam.updateProjectionMatrix()
  }
  const chaseFov = () => (innerWidth < innerHeight ? 72 : 58)
  function chasePose(dt, snap) {
    const k = snap ? 1 : 1 - Math.exp(-3.2 * dt)
    if (Math.abs(car.speed) > 0.5 || snap) chase.yaw += wrap(car.yaw - chase.yaw) * k
    const fx = fwdX(chase.yaw), fy = fwdY(chase.yaw), sp = Math.max(0, car.speed)
    const back = 8.6 + sp * 0.14, up = 4.3 + sp * 0.05
    let bx = car.x - fx * back, by = car.y - fy * back
    // keep the boom out of buildings: shorten it to the first wall
    for (let s = 0.25; s <= 1.0001; s += 0.25) {
      if (insideBuilding(car.x - fx * back * s, car.y - fy * back * s)) { const f = Math.max(0.35, s - 0.25); bx = car.x - fx * back * f; by = car.y - fy * back * f; break }
    }
    const gy = Math.max(city.world.heightAt(bx, -by) + 1.4, car.h + up)
    v3.set(bx, gy, -by)
    if (snap) chase.pos.copy(v3); else chase.pos.lerp(v3, 1 - Math.exp(-7 * dt))
    v4.set(car.x + fwdX(car.yaw) * 6, car.h + 1.0, -(car.y + fwdY(car.yaw) * 6))
    if (snap) chase.look.copy(v4); else chase.look.lerp(v4, 1 - Math.exp(-10 * dt))
  }
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
    pcam.near = Math.max(0.4, dist * 0.04); pcam.far = dist + 1800
    pcam.updateProjectionMatrix()
    pcam.position.copy(look).addScaledVector(dir, dist)
    pcam.up.set(0, 1, 0); pcam.lookAt(look)
    opts.focus.copy(look)
    const half = (H / 2) * Math.max(1, pcam.aspect)
    opts.radius = clamp(half * 1.5, 900, 8000)
    opts.shadowRadius = clamp(half * 1.9, 300, 6000)
    atmosphere(smooth(0.55, 1, ek))
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
    const w = city.weather || {}, hr = hourNow()
    const night = w.isNight ?? (hr < 6 || hr > 20.5) ? 1 : 0
    const golden = night ? 0 : Math.max(smooth(2.2, 0, Math.abs(hr - 7.2)), smooth(2.2, 0, Math.abs(hr - 18.8)))
    const kind = w.kind || 'clear', wi = w.intensity ?? 0.5
    const grey = { clear: 0, cloudy: 0.25, overcast: 0.6, fog: 0.8, drizzle: 0.6, rain: 0.75, storm: 0.85, snow: 0.6 }[kind] ?? 0
    ca.set(0xcfe2ec).lerp(cc.set(0xf4cfaa), golden).lerp(cc.set(0x283350), night) // horizon
    cb.set(0x84b7dc).lerp(cc.set(0x8fa8d4), golden).lerp(cc.set(0x0f1628), night) // zenith
    ca.lerp(cc.set(night ? 0x2a3038 : 0xc4c9cc), grey); cb.lerp(cc.set(night ? 0x1c2128 : 0xa9b1b8), grey)
    let [n, f] = { clear: [140, 850], cloudy: [120, 780], overcast: [90, 620], fog: [20, 200], drizzle: [80, 560], rain: [60, 440], storm: [40, 320], snow: [50, 380] }[kind] || [140, 850]
    if (kind === 'fog') { n *= 1.5 - wi; f *= 1.5 - wi }
    if (night) { n *= 0.8; f *= 0.85 }
    // blend in from the map look: far fog first, the haze settles as the camera reaches the street
    const D = pcam.position.distanceTo(opts.focus)
    fog.color.copy(ca)
    fog.near = n + (D * 4 + 2000) * (1 - k); fog.far = f + (D * 8 + 4000) * (1 - k)
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
    const lights = night || kind === 'storm' || kind === 'fog' || golden > 0.6
    van.userData.lights[0].emissiveIntensity = lights ? 1.6 : 0.5
    van.userData.lights[1].emissiveIntensity = lights ? 1.2 : 0.4
    pool.visible = !!lights && k > 0.9
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
    const up = keys.has('ArrowUp') || keys.has('KeyW') || touchState.gas, down = keys.has('ArrowDown') || keys.has('KeyS') || touchState.brake
    return { steer: (L ? 1 : 0) - (R ? 1 : 0), up, down, hand: keys.has('Space') }
  }
  function drive(dt) {
    if (!(dt > 0)) return
    const I = input()
    // speed: throttle, brake / reverse, rolling drag, a gentle pull on slopes
    let a = 0
    if (I.up) a += car.speed < -0.3 ? 12 : 6.5 * (1 - clamp(car.speed / MAX_SPEED, 0, 1)) + 0.6
    if (I.down) a -= car.speed > 0.3 ? 11 : car.speed > -MAX_REVERSE ? 4 : 0
    if (I.hand) a -= Math.sign(car.speed) * Math.min(14, Math.abs(car.speed) / dt)
    a -= 9.8 * Math.sin(car.pitch) * 0.55
    car.speed += a * dt
    const drag = (0.5 + 0.011 * car.speed * car.speed + (I.up || I.down ? 0 : 1.2)) * dt
    car.speed = Math.abs(car.speed) <= drag ? 0 : car.speed - Math.sign(car.speed) * drag
    car.speed = clamp(car.speed, -MAX_REVERSE, MAX_SPEED)
    // steering: tighter when slow, smoothed
    const maxSteer = 0.58 / (1 + Math.abs(car.speed) / 9)
    car.steer += (I.steer * maxSteer - car.steer) * (1 - Math.exp(-(I.steer ? 5 : 8) * dt))
    // pushing against a wall still lets the van creep round (as if rolling at walking pace)
    const turn = Math.abs(car.speed) < 1.2 && (I.up || I.down) ? (I.up ? 1.2 : -1.2) : car.speed
    const yawRate = (turn * Math.tan(car.steer)) / WB
    car.yaw += yawRate * dt
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
    let nx = car.x + fx * car.speed * dt, ny = car.y + fy * car.speed * dt
    const blocked = (x, y) => {
      const s = surface(x, y, car.h)
      if (car.deck && !s.deck && car.h - s.y > 2 && !s.end) return 'edge'
      const ax = x + fx * Math.sign(car.speed || 1) * 2, ay = y + fy * Math.sign(car.speed || 1) * 2
      if (!s.deck && isWater(ax, ay) && !roadAt(ax, ay, car.h)) return 'water'
      return null
    }
    const why = blocked(nx, ny)
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
    if (hit > 2.5 && performance.now() - car.bumpT > 350) { car.bumpT = performance.now(); sfx.bump(clamp(hit / 10, 0.3, 1)); if (job) job.bumps++ ; shake = Math.min(0.5, hit * 0.04) }
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
    // engine note
    if (engine && !muted) {
      const t = ac.currentTime, sp = Math.abs(car.speed) / MAX_SPEED
      engine.o1.frequency.setTargetAtTime(38 + sp * 70 + (I.up ? 6 : 0), t, 0.1); engine.o2.frequency.setTargetAtTime(77 + sp * 140, t, 0.1)
      engine.g.gain.setTargetAtTime(0.018 + sp * 0.03 + (I.up ? 0.01 : 0), t, 0.15)
    }
  }
  let shake = 0, skyAt = 0
  function placeVan() {
    van.position.set(car.x, car.h - 0.02, -car.y)
    van.rotation.set(0, 0, 0)
    van.rotateY(car.yaw); van.rotateX(car.pitch); van.rotateZ(car.roll + car.bank)
    for (const w of van.userData.wheels) { w.spin.rotation.x = -car.spin; if (w.front) w.steer.rotation.y = car.steer }
    blob.position.set(car.x, car.h + 0.06, -car.y); blob.rotation.set(0, car.yaw, 0)
    pool.position.copy(blob.position); pool.rotation.copy(blob.rotation)
  }
  function resetToRoad() {
    const r = nearestRoad(car.x, car.y, 300)
    if (!r) return
    let yaw = yawFromDir(r.dir)
    if (Math.abs(wrap(yaw - car.yaw)) > Math.PI / 2) yaw = wrap(yaw + Math.PI)
    Object.assign(car, { x: r.px, y: r.py, yaw, speed: 0, steer: 0 })
    car.h = r.z != null ? r.z + 0.58 : city.world.heightAt(r.px, -r.py) + 0.2
    car.deck = r.z != null
  }

  // ---------------------------------------------------------------- jobs
  function itemFor(kind) { return pick(ITEMS[kind] || DEFAULT_ITEMS) }
  function target() { return job && (job.stage === 'pickup' ? job.from : job.to) }
  function newJob() {
    if (!places) return false
    const cands = placesNear(car.x, car.y, 150, 500)
    for (let k = 0; k < 20 && cands.length; k++) {
      const p = cands.splice(Math.floor(Math.random() * cands.length), 1)[0], s = stopFor(p.x, p.y)
      if (!s) continue
      job = { stage: 'pickup', from: { ...p, stop: s, label: p.name, sub: p.addr || p.kind }, to: null, item: itemFor(p.kind), bumps: 0, start: performance.now() }
      setTarget()
      return true
    }
    // no named places around: a parcel waiting at a house
    const h = houseNear(car.x, car.y, 150, 500)
    if (!h) return false
    job = { stage: 'pickup', from: { ...h, label: 'The depot drop box', sub: 'a parcel left for collection' }, to: null, item: pick(DEFAULT_ITEMS), bumps: 0, start: performance.now() }
    setTarget()
    return true
  }
  function chooseDrop() {
    const f = job.from
    const who = pick(NAMES)
    if (Math.random() < 0.55) {
      const cands = placesNear(f.x, f.y, 250, 750).filter((p) => p.name !== f.name)
      for (let k = 0; k < 20 && cands.length; k++) {
        const p = cands.splice(Math.floor(Math.random() * cands.length), 1)[0], s = stopFor(p.x, p.y)
        if (s) return { ...p, stop: s, who, label: p.name, sub: `for ${who}${p.addr ? `, ${p.addr}` : ''}` }
      }
    }
    const h = houseNear(f.x, f.y, 250, 750)
    return h ? { ...h, who, label: `${who}’s place`, sub: 'the house by the marker' } : null
  }
  function setTarget() {
    const t = target(), pickup = job.stage === 'pickup'
    const col = pickup ? 0xffb05c : 0x5fd6c4
    beamMat.uniforms.col.value.set(col); ringMat.color.set(col); ring2Mat.color.set(col); routeMat.uniforms.col.value.set(col)
    icons.pickup.visible = pickup; icons.drop.visible = !pickup
    beam.visible = ring.visible = ring2.visible = true
    const gy = surface(t.stop.x, t.stop.y, city.world.heightAt(t.stop.x, -t.stop.y) + 0.2).y
    for (const o of [beam, ring, ring2]) o.position.set(t.stop.x, gy + 0.08, -t.stop.y)
    t.gy = gy
    // a relaxed time: the way there at a gentle 7 m/s, plus a minute
    const r = route(car.x, car.y, { road: t.stop.road })
    const len = r ? lenOf(r) : Math.hypot(t.stop.x - car.x, t.stop.y - car.y) * 1.4
    job.limit = len / 7 + 60; job.start = performance.now(); job.dist = len
    routePts = null; routeAt = 0
  }
  function arrive() {
    const t = target()
    if (job.stage === 'pickup') {
      sfx.pickup()
      const to = chooseDrop()
      if (!to) { popup('Picked up!', 'Looking up the address…'); job.to = null; job.stage = 'wait'; hideMarkers(); jobRetry = performance.now() + 1000; return }
      job.to = to; job.stage = 'drop'
      popup('Picked up!', `${job.item[0].toUpperCase()}${job.item.slice(1)} for ${to.who}${to.name ? ` at ${to.name}` : ''}`)
      job.pickedAt = performance.now(); job.bumps = 0
      setTarget()
      return
    }
    // paid: a base for the distance, a tip for being on time and gentle with the parcel
    const used = (performance.now() - job.start) / 1000, left = Math.max(0, job.limit - used)
    const base = 6 + (job.dist / 1000) * 5, tip = Math.max(1, (left > 0 ? 3 + 7 * (left / job.limit) : 1.5) - job.bumps * 0.6)
    const pay = Math.round((base + tip) * 100) / 100
    shift.n++; shift.money += pay
    sfx.deliver()
    popup(`+$${pay.toFixed(2)}`, `${pick(THANKS)} (tip $${tip.toFixed(2)})`)
    job = null
    hideMarkers()
    jobRetry = performance.now() + 2500
  }
  function hideMarkers() { beam.visible = ring.visible = ring2.visible = icons.pickup.visible = icons.drop.visible = routeMesh.visible = false; routePts = null }
  function buildRoute(pts) {
    const P = [], A = [], I = []
    const dens = []
    for (let i = 0; i < pts.length; i++) {
      if (i) {
        const [x0, y0, z0] = pts[i - 1], [x1, y1, z1] = pts[i], L = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(L / 4)
        for (let k = 1; k <= n; k++) { const f = k / n; dens.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, z0 != null && z1 != null ? z0 + (z1 - z0) * f : null]) }
      } else dens.push(pts[0])
    }
    let s = 0
    for (let i = 0; i < dens.length; i++) {
      const p = dens[Math.max(0, i - 1)], q = dens[Math.min(dens.length - 1, i + 1)], [x, y, z] = dens[i]
      if (i) s += Math.hypot(x - dens[i - 1][0], y - dens[i - 1][1])
      let tx = q[0] - p[0], ty = q[1] - p[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l
      const h = (z != null ? z + 0.58 : city.world.heightAt(x, -y) + 0.2) + 0.25
      for (const side of [-1, 1]) { P.push(x - ty * 0.9 * side, h, -(y + tx * 0.9 * side)); A.push(s, side) }
      if (i) { const b = (i - 1) * 2; I.push(b, b + 1, b + 2, b + 1, b + 3, b + 2) }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
    g.setAttribute('aR', new THREE.Float32BufferAttribute(A, 2))
    g.setIndex(I)
    routeMesh.geometry.dispose(); routeMesh.geometry = g
    routeMesh.visible = true
    return s
  }

  // ---------------------------------------------------------------- per frame
  function frame(dt, time) {
    const now = performance.now()
    if (state === 'in' || state === 'out') {
      const e = clamp((now - t0) / (state === 'in' ? 2600 : 2200), 0, 1)
      pose(e)
      placeVan()
      if (e >= 1) {
        if (state === 'out') return finish()
        state = 'play'
        for (const el of [ui.top, ui.help, ui.touch]) el.hidden = false
        hudAt = 0
      }
      return
    }
    if (state !== 'play') return
    drive(dt)
    placeVan()
    chasePose(dt)
    const fov = chaseFov()
    if (pcam.fov !== fov || pcam.near !== 0.4) { pcam.fov = fov; pcam.near = 0.4; pcam.far = 1800; pcam.updateProjectionMatrix() }
    pcam.position.copy(chase.pos)
    if (shake > 0.001) { pcam.position.x += (Math.random() - 0.5) * shake; pcam.position.y += (Math.random() - 0.5) * shake; shake *= Math.exp(-10 * dt) }
    pcam.up.set(0, 1, 0); pcam.lookAt(chase.look)
    opts.focus.set(car.x + fwdX(car.yaw) * 180, car.h, -(car.y + fwdY(car.yaw) * 180))
    opts.radius = 900; opts.shadowRadius = 300
    // the job
    if (!job && now > jobRetry) { if (!newJob()) jobRetry = now + 1000 }
    if (job?.stage === 'wait' && now > jobRetry) { const to = chooseDrop(); if (to) { job.to = to; job.stage = 'drop'; setTarget() } else jobRetry = now + 1000 }
    const t = job && job.stage !== 'wait' ? target() : null
    if (t) {
      const d = Math.hypot(t.stop.x - car.x, t.stop.y - car.y)
      if (d < ARRIVE + t.stop.road.w / 2 && Math.abs(car.speed) < 7) arrive()
      else if (now - routeAt > 1200 && (Math.hypot(car.x - routeFrom.x, car.y - routeFrom.y) > 12 || !routePts)) {
        routeAt = now; routeFrom = { x: car.x, y: car.y }
        const r = route(car.x, car.y, { road: t.stop.road })
        if (r) { routePts = [[car.x, car.y, car.deck ? car.h - 0.58 : null], ...r, [t.stop.x, t.stop.y, null]]; t.routeLen = buildRoute(routePts) } else { routePts = null; routeMesh.visible = false }
      }
    }
    // markers: a soft pulse, the parcel/house turning and bobbing
    const tt = time
    beamMat.uniforms.t.value = tt; routeMat.uniforms.t.value = tt % 1000
    const pulse = (tt * 0.8) % 1
    ring2.scale.setScalar(1 + pulse * 0.9); ring2Mat.opacity = 0.8 * (1 - pulse)
    ring.scale.setScalar(1 + Math.sin(tt * 3) * 0.04)
    if (t) for (const ic of Object.values(icons)) if (ic.visible) { ic.position.set(t.stop.x, t.gy + 4.2 + Math.sin(tt * 2) * 0.35, -t.stop.y); ic.rotation.y = tt * 1.2 }
    if (now - hudAt > 100) { hudAt = now; hud(t) }
    if (now - skyAt > 1000) { skyAt = now; atmosphere(1) }
  }
  function hud(t) {
    ui.n.textContent = String(shift.n)
    ui.m.textContent = `$${shift.money.toFixed(2)}`
    const h = hourNow(), hh = Math.floor(h), mm = Math.floor((h - hh) * 60)
    ui.c.textContent = `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`
    if (!t) {
      ui.job.hidden = false; ui.arrow.style.opacity = 0.3
      ui.w.textContent = 'Next up'; ui.s.textContent = ''; ui.d.textContent = ''; ui.t.textContent = ''
      ui.p.textContent = job?.stage === 'wait' ? 'Looking up the address…' : shift.n ? 'Checking the order board…' : 'Finding your first parcel…'
      return
    }
    ui.job.hidden = false; ui.arrow.style.opacity = 1
    ui.w.textContent = job.stage === 'pickup' ? 'Pick up at' : `Deliver ${job.item}`
    ui.p.textContent = t.label; ui.s.textContent = t.sub || ''
    const d = t.routeLen && routePts ? t.routeLen : Math.hypot(t.stop.x - car.x, t.stop.y - car.y)
    ui.d.textContent = d > 950 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`
    const left = job.limit - (performance.now() - job.start) / 1000
    ui.t.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} for a good tip` : 'running late, no worries'
    ui.t.className = left > 0 ? '' : 'late'
    // the arrow: the target's direction relative to where the camera looks
    const cy = Math.atan2(chase.look.x - chase.pos.x, -(chase.look.z - chase.pos.z)) // compass bearing of the view
    const ty = Math.atan2(t.stop.x - car.x, t.stop.y - car.y)
    ui.arrow.style.transform = `rotate(${wrap(ty - cy)}rad)`
  }

  // ---------------------------------------------------------------- keys
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable
  const DRIVE = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'])
  function onKey(e) {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
    if (state === 'off') { if (e.code === 'KeyD' && !e.repeat && !e.shiftKey) enter(); return }
    if (e.code === 'Escape') { exit(); return }
    if (state !== 'play') return
    if (DRIVE.has(e.code)) { keys.add(e.code); e.preventDefault() }
    if (e.repeat) return
    if (e.code === 'KeyR') resetToRoad()
    else if (e.code === 'KeyH') sfx.horn()
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
      if (state !== 'off') { state = 'out'; finish() }
      for (const f of offTiles) f()
      removeEventListener('keydown', onKey); removeEventListener('keyup', onKeyUp); removeEventListener('blur', onBlur); removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVis)
      button.remove()
      for (const e of ui.all) e.remove()
      ui.css.remove()
      ac?.close()
    },
  }
}
