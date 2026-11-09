// Turns a streamed map tile (tools/tiles.py) into ready-to-draw geometry buffers, off the page's thread.
// Coordinates in the buffers are local to the tile: x east, y up, z south, metres from the tile's SW corner.
// Walls by what they face and the single-arm street lights follow Slop Toronto's rules (MIT, © 2026 Mr.doob, © 2026 John
// Fewell; THIRD_PARTY.md).
import earcut from '../vendor/earcut.js'
import { mulberry32 as mulberry, inPoly, sampleGrid } from './util.js'
const GROUND_LIFT = 0 // the ground is one non-overlapping layer (tools/tiles.py), so no class needs lifting
const KIND = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living', 'pedestrian', 'footway', 'cycleway',
  'path', 'steps', 'track', 'rail', 'lightrail', 'runway', 'taxiway']
const K = Object.fromEntries(KIND.map((k, i) => [k, i]))

let MASKS = [] // world-metre rings where plugins draw their own buildings (landmarks): generic ones are skipped
globalThis.onmessage = async ({ data }) => { // (globalThis: tools/crosswalk_check.mjs imports this under node)
  if (data.masks) { MASKS = data.masks.map((r) => ({ r, bb: bbox(r) })); return }
  const { id, url, level } = data
  try {
    const r = await fetch(url)
    if (r.status === 404) return postMessage({ id, missing: true })
    if (!r.ok) throw new Error(`${url}: ${r.status}`)
    const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    const t = parse(buf)
    const out = build(t, level)
    for (const g of [out.ground, out.roads, out.paint, out.buildings, out.balconies, out.ao]) if (g?.position) g.box = box(g.position)
    if (out.lights) out.lights.box = box(out.lights.pos, 4)
    postMessage({ id, ...out }, transferables(out))
  } catch (e) { postMessage({ id, error: String(e) }) }
}

// bounds of a position buffer, so the page doesn't loop over it (min x, y, z, max x, y, z)
function box(p, stride = 3) {
  const b = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
  for (let i = 0; i < p.length; i += stride) for (let k = 0; k < 3; k++) { const v = p[i + k]; if (v < b[k]) b[k] = v; if (v > b[k + 3]) b[k + 3] = v }
  return b
}

function transferables(o, list = []) {
  for (const v of Object.values(o)) {
    if (ArrayBuffer.isView(v)) list.push(v.buffer)
    else if (v && typeof v === 'object') transferables(v, list)
  }
  return [...new Set(list)]
}

// ---------------------------------------------------------------- parse
function parse(buf) {
  const dv = new DataView(buf)
  let o = 0
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (magic !== 'VTL2') throw new Error('not a tile (or an old one)')
  const ox = dv.getFloat32(8, true), oy = dv.getFloat32(12, true), size = dv.getFloat32(16, true)
  o = 20
  const t = { ox, oy, size, k: (2 * size) / 32766, sections: {} } // must match tools/tiles.py Out.k
  while (o < buf.byteLength) {
    const tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))
    const len = dv.getUint32(o + 4, true)
    t.sections[tag] = { off: o + 8, len }
    o += 8 + len
  }
  t.dv = dv; t.buf = buf
  return t
}

// count + delta-encoded int16 points -> Float32Array of tile-local metres; returns [pts, newOffset]
function readRing(t, o) {
  const dv = t.dv, n = dv.getUint32(o, true), pts = new Float32Array(n * 2)
  let x = 0, y = 0
  o += 4
  for (let i = 0; i < n; i++) { x += dv.getInt16(o, true); y += dv.getInt16(o + 2, true); o += 4; pts[i * 2] = x * t.k; pts[i * 2 + 1] = y * t.k }
  return [pts, o]
}

// ---------------------------------------------------------------- build
function build(t, level) {
  const terr = terrain(t)
  const out = { terrain: terr }
  out.ground = ground(t, terr, level)
  const lines = readLines(t)
  const ps = pois(t)
  const carriage = level === 0 ? roadMask(t) : null
  const rd = roads(t, terr, lines, level, ps, carriage)
  out.roads = rd.surf; out.paint = rd.paint
  out.graph = graph(t, lines)
  out.graph.pois = ps
  const b = buildings(t, terr, level, lines, carriage)
  out.buildings = b.walls; out.balconies = b.balconies; out.ao = b.ao
  const tr = trees(t, terr)
  if (level === 0) {
    const S = solids(t, b.footprints, tr) // what stands on the ground: nothing placed inside another
    out.water = water(t); out.carriage = carriage; out.boats = boats(t, terr); out.lights = lights(t, terr, lines, ps, b, carriage, S)
    out.signs = signs(t, b.fronts)
    out.parked = parked(t, terr, lines, ps, b.footprints, S)
    out.footprints = withCars(b.footprints, out.parked.lot, t)
    out.beach = beach(t, terr)
    if (out.beach) out.footprints = withBoxes(out.footprints, out.beach.solid, t)
  }
  out.trees = tr
  return out
}

// The things standing on a detail tile's ground (tile-local): the buildings' footprints and the trees' trunks, then the
// lamp poles and parked cars as they are placed, each kept out of the others. free(x, y, r): a disc of radius r there
// clear of them all; freeBox(x, y, angle, half length, half width): a box (a car) clear of them all
function solids(t, fp, tr) {
  const G = 8, grid = new Map(), cell = (x, y) => Math.floor(x / G) * 4096 + Math.floor(y / G)
  const put = (x0, y0, x1, y1, v) => { for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++) for (let j = Math.floor(y0 / G); j <= Math.floor(y1 / G); j++) { const k = i * 4096 + j; let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(v) } }
  const near = (x0, y0, x1, y1, fn) => { const seen = new Set(); for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++) for (let j = Math.floor(y0 / G); j <= Math.floor(y1 / G); j++) for (const v of grid.get(i * 4096 + j) || []) if (!seen.has(v)) { seen.add(v); if (fn(v)) return true } return false }
  if (fp) for (let r = 0; r < fp.start.length - 1; r++) {
    const ring = []
    for (let q = fp.start[r]; q < fp.start[r + 1]; q += 2) ring.push([fp.pts[q] - t.ox, fp.pts[q + 1] - t.oy])
    const [x0, y0, x1, y1] = bbox(ring)
    put(x0, y0, x1, y1, { ring })
  }
  const P = tr?.pos
  for (let i = 0; P && i < P.length; i += 3) put(P[i], -P[i + 2], P[i], -P[i + 2], { disc: [P[i], -P[i + 2], 0.25] })
  const corners = (x, y, a, l, w) => { const fx = Math.cos(a), fy = Math.sin(a); return [[0, 0], [1, 1], [-1, 1], [-1, -1], [1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([p, q]) => [x + fx * p * l + fy * q * w, y + fy * p * l - fx * q * w]) }
  const inBox = ([x, y, a, l, w], px, py, m = 0) => { const fx = Math.cos(a), fy = Math.sin(a), dx = px - x, dy = py - y; return Math.abs(dx * fx + dy * fy) < l + m && Math.abs(dx * fy - dy * fx) < w + m }
  return {
    free: (x, y, r) => !near(x - r - 1, y - r - 1, x + r + 1, y + r + 1, (v) => v.ring ? inPoly(x, y, v.ring) : v.disc ? Math.hypot(v.disc[0] - x, v.disc[1] - y) < v.disc[2] + r : inBox(v.box, x, y, r)),
    freeBox: (x, y, a, l, w) => {
      const cs = corners(x, y, a, l, w), b = [x, y, a, l, w]
      return !near(x - l - 1, y - l - 1, x + l + 1, y + l + 1, (v) => v.ring ? cs.some(([px, py]) => inPoly(px, py, v.ring)) || v.ring.some(([px, py]) => inBox(b, px, py))
        : v.disc ? inBox(b, v.disc[0], v.disc[1], v.disc[2]) : cs.some(([px, py]) => inBox(v.box, px, py)) || corners(...v.box).some(([px, py]) => inBox(b, px, py)))
    },
    addDisc: (x, y, r) => put(x - r, y - r, x + r, y + r, { disc: [x, y, r] }),
    addBox: (x, y, a, l, w) => put(x - l, y - l, x + l, y + l, { box: [x, y, a, l, w] }),
  }
}

function terrain(t) {
  const s = t.sections.TERR, n = t.dv.getUint16(s.off, true)
  const h = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) h[i] = t.dv.getInt16(s.off + 2 + i * 2, true) / 10
  const out = { n, h, size: t.size } // row 0 = north
  const m = t.sections.TERM // the next tiles' terrain, M rows round this one (tools/tiles.py margins()): out.ext, the grid with them
  if (m && t.dv.getUint16(m.off, true) === n) {
    const M = t.dv.getUint16(m.off + 2, true), N = n + 2 * M, e = new Float32Array(N * N), c = t.size / (n - 1)
    let o = m.off + 4
    const rd = () => { const v = t.dv.getInt16(o, true) / 10; o += 2; return v }
    for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) e[j * N + i] = rd()
    for (let j = N - M; j < N; j++) for (let i = 0; i < N; i++) e[j * N + i] = rd()
    for (let j = M; j < N - M; j++) for (let i = 0; i < M; i++) e[j * N + i] = rd()
    for (let j = M; j < N - M; j++) for (let i = N - M; i < N; i++) e[j * N + i] = rd()
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) e[(j + M) * N + i + M] = h[j * n + i]
    out.ext = { n: N, h: e, size: t.size + 2 * M * c, off: M * c }
  }
  return out
}
// surface normals from the terrain's slope (cheaper than averaging faces, and the same across tile edges)
function normals(terr, pos) {
  const n = new Int8Array(pos.length), e = 2
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = -pos[i + 2]
    const dx = heightAt(terr, x + e, y) - heightAt(terr, x - e, y), dy = heightAt(terr, x, y + e) - heightAt(terr, x, y - e)
    let nx = -dx / (2 * e), ny = 1, nz = dy / (2 * e) // three.js z = -north
    const l = Math.hypot(nx, ny, nz)
    n[i] = (nx / l) * 127; n[i + 1] = (ny / l) * 127; n[i + 2] = (nz / l) * 127
  }
  return n
}
const heightAt = (terr, x, y) => sampleGrid(terr.h, terr.n, terr.size, x, y) // tile-local metres, y north
// the ground at tile-local (x, y) on past the tile's edge (a decal, a building reaching into the next tile): the next
// tiles' terrain (terr.ext, tools/tiles.py margins()), else carried on on the slope at the edge
function groundOut(terr, x, y) {
  const e = terr.ext
  if (e) return sampleGrid(e.h, e.n, e.size, x + e.off, y + e.off)
  const S = terr.size, cx = Math.min(S, Math.max(0, x)), cy = Math.min(S, Math.max(0, y)), h = heightAt(terr, cx, cy)
  const gx = cx === x ? 0 : (h - heightAt(terr, cx - Math.sign(x - cx) * 4, cy)) / 4, gy = cy === y ? 0 : (h - heightAt(terr, cx, cy - Math.sign(y - cy) * 4)) / 4
  return h + gx * Math.abs(x - cx) + gy * Math.abs(y - cy)
}

// ground: polygons per class, triangulated here and draped over the terrain (long edges split on slopes). Detail
// tiles carry two sets of triangles over one set of vertices: `index` follows the terrain to 5 cm (street level, close
// zooms), `coarse` to 25 cm (the map further out, where 25 cm is under a pixel: a third of the triangles)
const GROUND_TOL = [0.05, 0.4], GROUND_COARSE = 0.25
function ground(t, terr, level) {
  const s = t.sections.GRND
  if (!s) return null
  const dv = t.dv
  let o = s.off
  const runs = dv.getUint16(o, true); o += 2
  const pos = [], cls = [], idx = Object.assign([], { rim: [] }), coarse = level === 0 ? Object.assign([], { rim: [] }) : null
  const seen = new Map() // shared vertices: one per (point, class), so each tile uploads about a third as much
  const vert = (x, y, c, lift) => {
    const key = Math.round(x * 50) * 1e7 + Math.round(y * 50) + c * 1e14
    let i = seen.get(key)
    if (i === undefined) { i = pos.length / 3; seen.set(key, i); pos.push(x, hz(x, y, c) + lift, -y); cls.push(c) }
    return i
  }
  let hmin = Infinity, hmax = -Infinity
  for (const v of terr.h) { hmin = Math.min(hmin, v); hmax = Math.max(hmax, v) }
  // Triangles are split where the terrain bends under them, not everywhere: an edge is halved while the ground along it
  // strays more than tol from the straight line between its ends, or it is longer than 4 terrain cells. The test
  // looks at the edge alone, so both triangles that share an edge split it alike (no cracks; where polygons meet, a gap
  // is under tol); slopes and flat ground keep big triangles (an 8 m grid split everywhere was ~3x the triangles for the same picture).
  const cell = t.size / (terr.n - 1), cap = hmax - hmin < 2 ? Infinity : cell * 4
  const hz = (x, y, c) => { const h = heightAt(terr, x, y); return c === PIER ? Math.max(h, 0.45) : h }
  const bends = (ax, ay, bx, by, c, tol) => {
    if (ax > bx || (ax === bx && ay > by)) return bends(bx, by, ax, ay, c, tol) // one way along an edge, whichever side asks
    const L = Math.hypot(bx - ax, by - ay)
    if (L > cap) return true
    if (cap === Infinity || L < 1.5) return false
    const ha = hz(ax, ay, c), hb = hz(bx, by, c), k = Math.ceil(L / (cell / 2))
    for (let i = 1; i < k; i++) { const f = i / k; if (Math.abs(hz(ax + (bx - ax) * f, ay + (by - ay) * f, c) - ha - (hb - ha) * f) > tol) return true }
    return false
  }
  // one triangle into `out`, split first along the longest edge that bends
  // fl: which of its edges (1 ab, 2 bc, 4 ca) lie on its polygon's border: those triangles are listed in out.rim
  const emit = (out, tol, c, lift, ax, ay, bx, by, cx, cy, depth, fl) => {
    if (depth < 20) {
      const ab = bends(ax, ay, bx, by, c, tol) ? Math.hypot(bx - ax, by - ay) : 0, bc = bends(bx, by, cx, cy, c, tol) ? Math.hypot(cx - bx, cy - by) : 0
      const ca = bends(cx, cy, ax, ay, c, tol) ? Math.hypot(ax - cx, ay - cy) : 0, m = Math.max(ab, bc, ca), d = depth + 1
      if (m > 0) {
        if (m === ab) { const mx = (ax + bx) / 2, my = (ay + by) / 2; emit(out, tol, c, lift, ax, ay, mx, my, cx, cy, d, fl & 5); emit(out, tol, c, lift, mx, my, bx, by, cx, cy, d, fl & 3) }
        else if (m === bc) { const mx = (bx + cx) / 2, my = (by + cy) / 2; emit(out, tol, c, lift, ax, ay, bx, by, mx, my, d, fl & 3); emit(out, tol, c, lift, ax, ay, mx, my, cx, cy, d, fl & 6) }
        else { const mx = (cx + ax) / 2, my = (cy + ay) / 2; emit(out, tol, c, lift, ax, ay, bx, by, mx, my, d, fl & 5); emit(out, tol, c, lift, mx, my, bx, by, cx, cy, d, fl & 6) }
        return
      }
    }
    const va = vert(ax, ay, c, lift), vb = vert(bx, by, c, lift), vc = vert(cx, cy, c, lift)
    // face up: earcut keeps the ring's winding; pick the order whose normal points +y
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (fl) out.rim.push(out.length, cross > 0 ? fl : ((fl & 4) >> 2) | (fl & 2) | ((fl & 1) << 2)) // (its border edges in the order kept)
    if (cross > 0) out.push(va, vb, vc); else out.push(va, vc, vb)
  }
  const polys = [] // [class, rings], read first: their borders are welded together before they're triangulated
  for (let r = 0; r < runs; r++) {
    const c = dv.getUint8(o), np = dv.getUint32(o + 1, true); o += 5
    for (let p = 0; p < np; p++) {
      const nr = dv.getUint16(o, true), rings = []; o += 2
      for (let k = 0; k < nr; k++) { const [pts, o2] = readRing(t, o); o = o2; rings.push(pts) }
      polys.push([c, rings])
    }
  }
  const W = weld(polys.flatMap(([, rings]) => rings), t.size, t.k * 1.5)
  let ri = 0
  for (const [c, rings] of polys) {
    const lift = c * GROUND_LIFT + 0.02, flat = [], holes = []
    for (let k = 0; k < rings.length; k++) {
      const ring = W.rings[ri++]
      if (ring.length < 3 || (k && !flat.length)) continue // welded down to nothing (a sliver of a ring)
      if (k) holes.push(flat.length / 2)
      for (const i of ring) flat.push(W.xy[i * 2], W.xy[i * 2 + 1])
    }
    const tri = flat.length ? earcut(flat, holes) : []
    const st = [0, ...holes, flat.length / 2], ringEdge = (i, j) => { // along one ring: consecutive points, or with only
      // points in a straight line between them (earcut leaves those out: the next polygon's corner welded onto this border)
      const r = st.findIndex((v) => v > i), r0 = st[r - 1], n = st[r] - r0
      if (j < r0 || j >= st[r]) return false
      const on = (k, l) => { // the points after k up to l along the ring, all on segment k-l?
        const ax = flat[k * 2], ay = flat[k * 2 + 1], dx = flat[l * 2] - ax, dy = flat[l * 2 + 1] - ay, L = Math.hypot(dx, dy) || 1
        for (let m = r0 + ((k - r0 + 1) % n), c = 0; m !== l; m = r0 + ((m - r0 + 1) % n), c++) if (c > 64 || Math.abs((flat[m * 2] - ax) * dy - (flat[m * 2 + 1] - ay) * dx) / L > 0.01) return false
        return true
      }
      return on(i, j) || on(j, i)
    }
    for (let i = 0; i < tri.length; i += 3) {
      const a = tri[i] * 2, b = tri[i + 1] * 2, d = tri[i + 2] * 2
      const fl = (ringEdge(tri[i], tri[i + 1]) ? 1 : 0) | (ringEdge(tri[i + 1], tri[i + 2]) ? 2 : 0) | (ringEdge(tri[i + 2], tri[i]) ? 4 : 0)
      emit(idx, GROUND_TOL[level], c, lift, flat[a], flat[a + 1], flat[b], flat[b + 1], flat[d], flat[d + 1], 0, fl)
      if (coarse) emit(coarse, GROUND_COARSE, c, lift, flat[a], flat[a + 1], flat[b], flat[b + 1], flat[d], flat[d + 1], 0, fl)
    }
  }
  // T-junctions: a border edge one triangle has with another's corner on it (the two sides split it differently: one
  // halved where the ground bends under its own edge, the next polygon's border there a little different) opens a
  // hairline the base map shows through; the triangle is split at those corners
  const fixT = (out) => {
    const grid = new Map(), G = 2
    const cellsOn = (ax, ay, bx, by, fn) => { // the G cells segment a-b passes through (a grid walk), key i * 65536 + j
      let i = Math.floor(ax / G), j = Math.floor(ay / G)
      const i1 = Math.floor(bx / G), j1 = Math.floor(by / G), dx = bx - ax, dy = by - ay, si = Math.sign(dx), sj = Math.sign(dy)
      const ti = dx ? G / Math.abs(dx) : Infinity, tj = dy ? G / Math.abs(dy) : Infinity
      let ni = dx ? ((si > 0 ? (i + 1) * G - ax : ax - i * G) / Math.abs(dx)) : Infinity, nj = dy ? ((sj > 0 ? (j + 1) * G - ay : ay - j * G) / Math.abs(dy)) : Infinity
      fn(i * 65536 + j)
      for (let n = 0; n < 4096 && (i !== i1 || j !== j1); n++) { if (ni < nj) { i += si; ni += ti } else { j += sj; nj += tj } fn(i * 65536 + j) }
    }
    const mark = new Uint8Array(pos.length / 3)
    for (let r = 0; r < out.rim.length; r += 2) for (let e = 0; e < 3; e++) { const v = out[out.rim[r] + e]; if (mark[v]) continue; mark[v] = 1; const k = Math.floor(pos[v * 3] / G) * 65536 + Math.floor(-pos[v * 3 + 2] / G); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(v) }
    const add = []
    for (let r = 0; r < out.rim.length; r += 2) {
      const q = out.rim[r], fl = out.rim[r + 1], loop = [], cc = cls[out[q]], lift = cc * GROUND_LIFT + 0.02
      for (let e = 0; e < 3; e++) {
        const a = out[q + e], b = out[q + (e + 1) % 3], ax = pos[a * 3], ay = -pos[a * 3 + 2], bx = pos[b * 3], by = -pos[b * 3 + 2], L2 = (bx - ax) ** 2 + (by - ay) ** 2
        loop.push(a)
        if (L2 < 0.01 || !(fl & (1 << e))) continue // (an edge inside its polygon: its neighbour there has the same points)
        let on = null, seen = null; const L = Math.sqrt(L2)
        const vs = []; cellsOn(ax, ay, bx, by, (k) => { const l = grid.get(k); if (l) for (const v of l) vs.push(v) })
        for (const v of vs) {
          const vx = pos[v * 3], vy = -pos[v * 3 + 2], f = ((vx - ax) * (bx - ax) + (vy - ay) * (by - ay)) / L2
          if (f <= 1e-3 || f >= 1 - 1e-3 || Math.abs((vx - ax) * (by - ay) - (vy - ay) * (bx - ax)) / L >= 0.03) continue
          const k = Math.round(vx * 50) * 65536 + Math.round(vy * 50)
          if (!on) { on = []; seen = new Set() }
          if (!seen.has(k)) { seen.add(k); on.push([f, vx, vy]) }
        }
        if (!on) continue
        on.sort((u, w) => u[0] - w[0])
        for (const [, x, y] of on) loop.push(vert(x, y, cc, lift))
      }
      if (loop.length === 3) continue
      const gx = (pos[out[q] * 3] + pos[out[q + 1] * 3] + pos[out[q + 2] * 3]) / 3, gy = -(pos[out[q] * 3 + 2] + pos[out[q + 1] * 3 + 2] + pos[out[q + 2] * 3 + 2]) / 3, g = vert(gx, gy, cc, lift)
      out[q] = loop[0]; out[q + 1] = loop[1]; out[q + 2] = g
      for (let j = 1; j < loop.length; j++) add.push(loop[j], loop[(j + 1) % loop.length], g)
    }
    for (const v of add) out.push(v)
  }
  fixT(idx); if (coarse) fixT(coarse)
  const nv = pos.length / 3
  if (!nv) return null
  const P = new Float32Array(pos), I = nv > 65535 ? Uint32Array : Uint16Array
  return { position: P, normal: normals(terr, P), cls: new Uint8Array(cls), index: new I(idx), coarse: coarse && new I(coarse) }
}

// The bake's ground polygons meet along shared borders, but not always point for point: one side has a point the other
// lacks (a T-junction: between them the two sides follow the terrain differently), or the two round a corner to
// different 6 cm steps (a sliver). Either opens a hairline crack that shows the base map below, and the ink pass
// outlines it: dotted dark lines along kerbs, lawns and road edges. So points closer than tol become one (those on
// the tile's edge stay put: the next tile's ground meets them there), and each ring edge takes in the points within
// tol of it, so both sides of a border run through the same points and their triangles share edges.
// Returns the points (xy) and each ring as point indices.
function weld(rings, size, tol) {
  const C = Math.max(2, size / 1024), cells = new Map(), xy = [], tol2 = tol * tol
  const cell = (x, y) => (Math.floor(x / C) + 1024) * 4096 + Math.floor(y / C) + 1024
  const find = (x, y) => {
    for (let i = Math.floor((x - tol) / C); i <= Math.floor((x + tol) / C); i++) for (let j = Math.floor((y - tol) / C); j <= Math.floor((y + tol) / C); j++) {
      for (const p of cells.get((i + 1024) * 4096 + j + 1024) || []) if ((xy[p * 2] - x) ** 2 + (xy[p * 2 + 1] - y) ** 2 <= tol2) return p
    }
    return -1
  }
  const add = (x, y) => { let p = find(x, y); if (p < 0) { p = xy.length / 2; xy.push(x, y); const k = cell(x, y); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(p) } return p }
  const edge = (x, y) => x < tol || y < tol || x > size - tol || y > size - tol
  const ids = rings.map((r) => new Int32Array(r.length / 2))
  for (const pass of [true, false]) rings.forEach((r, n) => { for (let i = 0; i < r.length; i += 2) if (edge(r[i], r[i + 1]) === pass) ids[n][i / 2] = add(r[i], r[i + 1]) })
  // the welded points in a flat grid of cells (CSR), and each edge walked a column of cells at a time along its longer axis
  const G = Math.ceil(size / C) + 3, np = xy.length / 2, start = new Int32Array(G * G + 1), list = new Int32Array(np)
  const at = (i, j) => Math.min(G - 1, Math.max(0, i + 1)) * G + Math.min(G - 1, Math.max(0, j + 1))
  for (let p = 0; p < np; p++) start[at(Math.floor(xy[p * 2] / C), Math.floor(xy[p * 2 + 1] / C)) + 1]++
  for (let c = 0; c < G * G; c++) start[c + 1] += start[c]
  const fill = start.slice(0, G * G)
  for (let p = 0; p < np; p++) list[fill[at(Math.floor(xy[p * 2] / C), Math.floor(xy[p * 2 + 1] / C))]++] = p
  const out = ids.map((ring) => {
    const res = []
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]
      if (a === b) continue
      res.push(a)
      const ax = xy[a * 2], ay = xy[a * 2 + 1], dx = xy[b * 2] - ax, dy = xy[b * 2 + 1] - ay, L2 = dx * dx + dy * dy, on = []
      const sw = Math.abs(dy) > Math.abs(dx), au = sw ? ay : ax, av = sw ? ax : ay, du = sw ? dy : dx, dv = sw ? dx : dy
      const u0 = Math.min(au, au + du), u1 = Math.max(au, au + du)
      for (let ci = Math.floor((u0 - tol) / C); ci <= Math.floor((u1 + tol) / C); ci++) {
        const lo = Math.max(u0, ci * C - tol), hi = Math.min(u1, (ci + 1) * C + tol), v0 = av + (dv * (lo - au)) / du, v1 = av + (dv * (hi - au)) / du
        for (let cj = Math.floor((Math.min(v0, v1) - tol) / C); cj <= Math.floor((Math.max(v0, v1) + tol) / C); cj++) {
          const c = sw ? at(cj, ci) : at(ci, cj)
          for (let q = start[c]; q < start[c + 1]; q++) {
            const p = list[q]
            if (p === a || p === b) continue
            const px = xy[p * 2] - ax, py = xy[p * 2 + 1] - ay, f = (px * dx + py * dy) / L2
            if (f > 0 && f < 1 && (px - f * dx) ** 2 + (py - f * dy) ** 2 <= tol2) on.push(f, p)
          }
        }
      }
      if (on.length) { const o = []; for (let j = 0; j < on.length; j += 2) o.push([on[j], on[j + 1]]); o.sort((u, v) => u[0] - v[0]); for (const [, p] of o) if (p !== res[res.length - 1]) res.push(p) }
    }
    return res
  })
  return { xy, rings: out }
}

// detail tiles: a WATER_N x WATER_N mask (1 = water), cell (i east, j north) from the tile's SW corner
const WATER_N = 256, WATER = 19, PIER = 20 // GROUND class indices of water and piers (tools/tiles.py)
function water(t) { const m = raster(t, new Set([WATER]), WATER_N); return m && { n: WATER_N, mask: m } }
// and a 1 m mask of the carriageways and cycle tracks as drawn (bits, row-major from the SW corner): street furniture
// stands outside it (city.world.offRoad)
const ROADS_N = 1024, CARR = new Set([25, 29, 30]) // cycle, road, arterial
function roadMask(t) {
  const m = raster(t, CARR, ROADS_N)
  if (!m) return null
  const bits = new Uint8Array(m.length / 8)
  for (let i = 0; i < m.length; i++) if (m[i]) bits[i >> 3] |= 1 << (i & 7)
  return { n: ROADS_N, bits }
}
// an n x n mask of the ground classes in `want`: the cells whose centres are inside their polygons, or null if none
function raster(t, want, n) {
  const c = t.size / n, mask = new Uint8Array(n * n)
  let any = false
  eachPoly(t, want, (flat, holes) => {
    const tri = earcut(flat, holes)
    for (let q = 0; q < tri.length; q += 3) { // fill the cells whose centres are inside the triangle
      const ax = flat[tri[q] * 2] / c - 0.5, ay = flat[tri[q] * 2 + 1] / c - 0.5, bx = flat[tri[q + 1] * 2] / c - 0.5, by = flat[tri[q + 1] * 2 + 1] / c - 0.5
      const cx = flat[tri[q + 2] * 2] / c - 0.5, cy = flat[tri[q + 2] * 2 + 1] / c - 0.5
      const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      if (Math.abs(det) < 1e-9) continue
      const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), i1 = Math.min(n - 1, Math.floor(Math.max(ax, bx, cx)))
      const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy))), j1 = Math.min(n - 1, Math.floor(Math.max(ay, by, cy)))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const u = ((bx - i) * (cy - j) - (by - j) * (cx - i)) / det, v = ((cx - i) * (ay - j) - (cy - j) * (ax - i)) / det
        if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) { mask[j * n + i] = 1; any = true }
      }
    }
  })
  return any ? mask : null
}
// fn(flat, holes) for each ground polygon of a class in `want` (tile-local x, north pairs; holes: earcut's hole starts)
function eachPoly(t, want, fn) {
  const s = t.sections.GRND
  if (!s) return
  const dv = t.dv
  let o = s.off
  const runs = dv.getUint16(o, true); o += 2
  for (let r = 0; r < runs; r++) {
    const cls = dv.getUint8(o), np = dv.getUint32(o + 1, true); o += 5
    for (let p = 0; p < np; p++) {
      const nr = dv.getUint16(o, true); o += 2
      const flat = [], holes = []
      for (let k = 0; k < nr; k++) {
        const [pts, o2] = readRing(t, o); o = o2
        if (!want.has(cls)) continue
        if (k) holes.push(flat.length / 2)
        for (const v of pts) flat.push(v)
      }
      if (want.has(cls) && flat.length) fn(flat, holes)
    }
  }
}

function readLines(t) {
  const s = t.sections.LINE
  const out = []
  if (!s) return out
  const dv = t.dv
  let o = s.off
  const nn = dv.getUint32(o, true); o += 4
  const nodes = new Array(nn)
  for (let i = 0; i < nn; i++) { nodes[i] = Number(dv.getBigUint64(o, true)); o += 8 }
  const n = dv.getUint32(o, true); o += 4
  for (let i = 0; i < n; i++) {
    const kind = dv.getUint8(o), lanes = dv.getUint8(o + 1), flags = dv.getUint8(o + 2), layer = dv.getInt8(o + 3), w = dv.getUint16(o + 4, true) / 100
    const a = nodes[dv.getUint32(o + 6, true)], b = nodes[dv.getUint32(o + 10, true)]
    o += 14
    const [pts, o2] = readRing(t, o); o = o2
    const np = pts.length / 2
    let z = null
    if (flags & 4) { z = new Float32Array(np); for (let p = 0; p < np; p++) { z[p] = dv.getInt16(o, true) / 10; o += 2 } }
    let turns = null // OSM turn lanes, a bitmask per lane left to right: 1 left, 2 slight left, 4 through, 8 slight right, 16 right, 32 u-turn, 64 merge
    if (flags & 32) { const nf = dv.getUint8(o); const f = [...new Uint8Array(t.buf, o + 1, nf)]; o += 1 + nf; const nb = dv.getUint8(o); const b = [...new Uint8Array(t.buf, o + 1, nb)]; o += 1 + nb; turns = { f, b } }
    out.push({ kind, lanes, oneway: !!(flags & 1), band: !!(flags & 2), drive: !!(flags & 8), crossing: !!(flags & 16), tunnel: !!(flags & 64), roof: !!(flags & 128), turns, layer, w, a, b, pts, z, tube: null })
  }
  const tl = t.sections.TUNL // detail tiles: per point of each tunnel piece 0 underground, 1 open (the ground is cut there), 2 a portal
  if (tl) for (let i = 0, o = tl.off + 4, n = dv.getUint32(tl.off, true); i < n; i++) {
    const L = out[dv.getUint32(o, true)], np = L.pts.length / 2
    L.tube = new Uint8Array(t.buf.slice(o + 4, o + 4 + np)); o += 4 + np
  }
  return out
}

// road surfaces as strips. Two layers: the "band" (sidewalks, boulevards, kerbs) under everything, then the
// carriageways on top, so a big road's sidewalk never covers a side street. Markings are drawn by the shader
// from per-vertex (along, across) coordinates, measured from the edge of the junction box (setback()): lane lines
// fade out before it, the stop line stands behind the crosswalk.
function roads(t, terr, lines, level, ps, R) {
  // Road surfaces, sidewalks and paths are part of the ground (baked as non-overlapping polygons). Here: bridge
  // decks (full surfaces, raised on their LiDAR heights) and, as thin decals on the ground, the paint: lane lines,
  // stop lines, the crosswalks OpenStreetMap maps (crosswalks()), and rails.
  const deg = new Map()
  for (const L of lines) for (const n of [L.a, L.b]) deg.set(n, (deg.get(n) || 0) + 1)
  const mk = () => ({ P: [], A: [], B: [], I: [], nv: 0 })
  const surf = Object.assign(mk(), { runs: [] }), paint = mk()
  // jA, jB: how far from each end the junction box there reaches (null: no junction, no stop line)
  const ext = terr.ext, decalH = (x, y) => groundOut(terr, x, y)
  const strip = (T, pts, zs, half, lift, kind, extra, w, jA, jB, mitre = null) => {
    if (T === surf) T.runs.push({ i0: T.I.length, i1: T.I.length, kind }) // (unstack(): which triangles are whose)
    const xs = [], ys = [], zz = []
    for (let i = 0; i < pts.length / 2 - 1; i++) {
      const x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[i * 2 + 2], y1 = pts[i * 2 + 3]
      const L = Math.hypot(x1 - x0, y1 - y0), n = zs ? 1 : Math.max(1, Math.ceil(L / 6))
      for (let k = 0; k < n; k++) {
        const f = k / n
        xs.push(x0 + (x1 - x0) * f); ys.push(y0 + (y1 - y0) * f)
        zz.push(zs ? zs[i] + (zs[i + 1] - zs[i]) * f : null)
      }
    }
    const last = pts.length / 2 - 1
    xs.push(pts[last * 2]); ys.push(pts[last * 2 + 1]); zz.push(zs ? zs[last] : null)
    const m = xs.length
    if (m < 2) return
    const S = terr.size, edgeAt = (x, y) => Math.abs(x) < 0.05 ? [0, 0] : Math.abs(x - S) < 0.05 ? [0, S] : Math.abs(y) < 0.05 ? [1, 0] : Math.abs(y - S) < 0.05 ? [1, S] : null
    const edges = [edgeAt(xs[0], ys[0]), edgeAt(xs[m - 1], ys[m - 1])]
    if (zs) for (const [i, j, e] of [[0, 1, 0], [m - 1, m - 2, 1]]) { // a deck's ends 5 cm on, under the next deck's (no hairline where two meet at a slant)
      if (mitre?.[e]) continue // (one row with the next deck's there)
      const dx = xs[i] - xs[j], dy = ys[i] - ys[j], l = Math.hypot(dx, dy)
      if (l > 0.2) { xs[i] += (dx / l) * 0.05; ys[i] += (dy / l) * 0.05 }
    }
    let s = 0
    const cum = [0]
    for (let i = 1; i < m; i++) { s += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]); cum.push(s) }
    const len = s
    let rows = 0
    const row = (i, lx, ly, rx, ry) => { // one row across: its left and right points
      const e = i === 0 ? edges[0] : i === m - 1 ? edges[1] : null
      if (e) { // on the tile's edge: both points slid along the strip onto it
        const j = i ? i - 1 : 1, dx = xs[i] - xs[j], dy = ys[i] - ys[j], d = e[0] ? dy : dx, l = Math.hypot(dx, dy) || 1
        if (Math.abs(d / l) > 0.2) {
          const slide = (px, py) => { const u = Math.max(-3 * half, Math.min(3 * half, (e[1] - (e[0] ? py : px)) / (d / l))); return [px + (dx / l) * u, py + (dy / l) * u] };
          [lx, ly] = slide(lx, ly); [rx, ry] = slide(rx, ry)
        }
      }
      for (const [side, px, py] of [[-1, rx, ry], [1, lx, ly]]) {
        const y = zz[i] ?? decalH(px, py) // decals follow the ground under each edge, not the centre line
        T.P.push(px, y + lift, -py)
        T.A.push(cum[i], side * half, w, kind)
        T.B.push(extra, jA == null ? 999 : cum[i] - jA, jB == null ? 999 : len - cum[i] - jB, len)
      }
      if (rows) { const b = T.nv + (rows - 1) * 2; T.I.push(b, b + 2, b + 1, b + 1, b + 2, b + 3) }
      rows++
    }
    for (let i = 0; i < m; i++) {
      const p = Math.max(0, i - 1), q = Math.min(m - 1, i + 1), cx = xs[i], cy = ys[i]
      let tx = xs[q] - xs[p], ty = ys[q] - ys[p]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl
      let nx = -ty, ny = tx, k = 1
      const mt = i === 0 ? mitre?.[0] : i === m - 1 ? mitre?.[1] : null
      if (mt) [nx, ny, k] = mt
      else if (i > 0 && i < m - 1) {
        const la = Math.hypot(cx - xs[i - 1], cy - ys[i - 1]) || 1, lb = Math.hypot(xs[i + 1] - cx, ys[i + 1] - cy) || 1
        const ax = (cx - xs[i - 1]) / la, ay = (cy - ys[i - 1]) / la, bx = (xs[i + 1] - cx) / lb, by = (ys[i + 1] - cy) / lb
        const turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
        if (Math.abs(turn) > 0.6) { // a sharp corner (a ramp's hairpin): the outer edge round it, the inner one mitred
          const sin = Math.sign(turn), a0 = Math.atan2(ax, -ay), R = Math.ceil(Math.abs(turn) / 0.35) + 1, back = half * Math.tan(Math.abs(turn) / 2)
          const mx = -ay + -by, my = ax + bx, ml = Math.hypot(mx, my), d = half / Math.max(1e-3, Math.cos(turn / 2))
          const inner = back <= Math.min(la, lb) && ml > 1e-6 ? [cx + (mx / ml) * d * sin, cy + (my / ml) * d * sin] : null
          for (let r = 0; r < R; r++) {
            const a = a0 + (turn * r) / (R - 1), ux = Math.cos(a), uy = Math.sin(a)
            const out = [cx - ux * half * sin, cy - uy * half * sin], inn = inner || [cx + ux * half * sin, cy + uy * half * sin] // (folded: faces away, not drawn)
            if (sin > 0) row(i, ...inn, ...out); else row(i, ...out, ...inn)
          }
          continue
        }
        k = 1 / Math.max(0.5, Math.abs(-ay * nx + ax * ny))
      }
      row(i, cx + nx * half * k, cy + ny * half * k, cx - nx * half * k, cy - ny * half * k)
    }
    T.nv += rows * 2
    if (T === surf) T.runs.at(-1).i1 = T.I.length
  }
  const len = (L) => { let s = 0; for (let i = 0; i < L.pts.length / 2 - 1; i++) s += Math.hypot(L.pts[i * 2 + 2] - L.pts[i * 2], L.pts[i * 2 + 3] - L.pts[i * 2 + 1]); return s }
  const order = [...lines].sort((p, q) => q.kind - p.kind), caps = new Map()
  const deckEnds = new Map() // node -> [[piece, end index, unit direction away from the node]] of the decks (not rail) there
  for (const L of lines) if (L.z && L.kind <= K.track && !L.tunnel) {
    const P = L.pts, n = P.length / 2
    for (const [e, f, id] of [[0, 1, L.a], [n - 1, n - 2, L.b]]) { const dx = P[f * 2] - P[e * 2], dy = P[f * 2 + 1] - P[e * 2 + 1], dl = Math.hypot(dx, dy) || 1; let a = deckEnds.get(id); if (!a) deckEnds.set(id, (a = [])); a.push([L, e, dx / dl, dy / dl]) }
  }
  const mitreAt = (L, id, start) => { // the shared row's (normal, scale) at L's end at node id, or null
    const a = deckEnds.get(id)
    if (!a || a.length !== 2) return null
    const [p, q] = a[0][0] === L ? a : [a[1], a[0]], ax = p[2], ay = p[3], bx = q[2], by = q[3]
    if (ax * -bx + ay * -by < Math.cos(0.6)) return null // (a sharp turn: square ends, the plate between)
    let tx = ax - bx, ty = ay - by; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl
    if (!start) { tx = -tx; ty = -ty }
    const own = start ? [ax, ay] : [-ax, -ay] // L's way along at that end
    return [-ty, tx, 1 / Math.max(0.5, tx * own[0] + ty * own[1])]
  }
  const ends = level === 0 ? carEnds(lines) : null
  const box = (L, e) => setback(ends, L, e)
  for (const L of order) {
    const ja = (deg.get(L.a) || 0) >= 3, jb = (deg.get(L.b) || 0) >= 3
    if (L.z) { // bridges: the whole surface, raised
      if (L.kind > K.track && L.kind !== K.rail && L.kind !== K.lightrail) continue
      const lift = 0.36 + (18 - L.kind) * 0.004 + (L.kind >= K.pedestrian ? 0.05 : 0), P = L.pts, n = P.length / 2 // (a foot or cycle deck mapped across a road deck's edge lies 5 cm over it, not in it)
      for (const [e, f, id] of L.kind <= K.track ? [[0, 1, L.a], [n - 1, n - 2, L.b]] : []) { // its square end at node id: (x, y, height, direction out of the node, half width)
        const dx = P[f * 2] - P[e * 2], dy = P[f * 2 + 1] - P[e * 2 + 1], dl = Math.hypot(dx, dy) || 1
        let c = caps.get(id); if (!c) caps.set(id, (c = []))
        c.push({ x: P[e * 2], y: P[e * 2 + 1], h: L.z[e] + lift, a: Math.atan2(dy / dl, dx / dl), half: L.w / 2, kind: L.kind, mitred: !!mitreAt(L, id, e === 0) })
      }
      if (L.band) { const bl = L.kind === K.residential || L.kind === K.tertiary ? 0 : 0, walk = 2.0; strip(surf, L.pts, L.z, L.w / 2 + walk, 0.3, 100, bl * 256 + walk * 16, L.w, null, null) }
      strip(surf, L.pts, L.z, L.w / 2, lift, L.kind, L.lanes + (L.oneway ? 32 : 0), L.w, ja ? 0 : null, jb ? 0 : null, [mitreAt(L, L.a, true), mitreAt(L, L.b, false)])
      continue
    }
    if (level !== 0) continue // the overview shows surfaces only
    const l = len(L)
    if (L.kind <= K.living && (L.lanes >= 2 || L.kind <= K.trunk) && l > 12) {
      strip(paint, L.pts, null, L.w / 2, 0.05, L.kind, L.lanes + (L.oneway ? 32 : 0), L.w, ja && l > 30 ? box(L, 0) ?? 0 : null, jb && l > 30 ? box(L, 1) ?? 0 : null)
    } else if (L.kind === K.rail || L.kind === K.lightrail) {
      strip(paint, L.pts, null, 1.3, 0.05, L.kind, 0, L.w, null, null)
    }
  }
  for (const c of caps.values()) { // between one deck's end and the next round the node, where they open apart: a fan of plain deck
    if (c.length < 2 || c.every((q) => q.mitred)) continue // (two decks going on from each other share their end row)
    c.sort((p, q) => p.a - q.a)
    const h = c.reduce((s, q) => s + q.h, 0) / c.length, X = c[0].x, Y = c[0].y
    for (let i = 0; i < c.length; i++) {
      const p = c[i], q = c[(i + 1) % c.length], gap = ((q.a - p.a + 4 * Math.PI) % (2 * Math.PI)) - Math.PI // p's left edge round to q's right one
      if (gap <= 0.01 || gap >= Math.PI - 0.01) continue // (they overlap there, or face each other: nothing open)
      const k = Math.ceil(gap / 0.35), v = surf.nv
      for (let s = 0; s <= k; s++) {
        const f = s / k, a = p.a + Math.PI / 2 + gap * f, r = p.half + (q.half - p.half) * f, hh = p.h + (q.h - p.h) * f
        surf.P.push(X + Math.cos(a) * r, hh, -(Y + Math.sin(a) * r)); surf.A.push(0, 0, 999, p.kind); surf.B.push(0, 0, 0, 1)
      }
      surf.P.push(X, h, -Y); surf.A.push(0, 0, 999, p.kind); surf.B.push(0, 0, 0, 1)
      for (let s = 0; s < k; s++) surf.I.push(v + k + 1, v + s, v + s + 1)
      surf.nv += k + 2
    }
  }
  if (ends) for (const c of onCarriage(crosswalks(lines, ends, ps, t.ox, t.oy), R)) { // kerb to kerb, square across the carriageway
    const nx = -c.ty * c.w / 2, ny = c.tx * c.w / 2
    strip(paint, [c.x - nx, c.y - ny, c.x + nx, c.y + ny], null, CW / 2, 0.06, 102, c.lines, CW, null, null)
  }
  unstack(surf)
  // the decks drawn here by 4 m cell: no decal under one (within 2.5 m) or over it
  const dg = new Map()
  for (let q = 0; q < surf.I.length; q += 3) {
    const v = [surf.I[q], surf.I[q + 1], surf.I[q + 2]].map((i) => [surf.P[i * 3], -surf.P[i * 3 + 2], surf.P[i * 3 + 1]])
    for (let u = Math.floor(Math.min(v[0][0], v[1][0], v[2][0]) / 4); u <= Math.floor(Math.max(v[0][0], v[1][0], v[2][0]) / 4); u++)
      for (let w = Math.floor(Math.min(v[0][1], v[1][1], v[2][1]) / 4); w <= Math.floor(Math.max(v[0][1], v[1][1], v[2][1]) / 4); w++) { const k = u * 65536 + w; let l = dg.get(k); if (!l) dg.set(k, (l = [])); l.push(v) }
  }
  const underDeck = (x, y, z) => {
    for (const [a, b, c] of dg.get(Math.floor(x / 4) * 65536 + Math.floor(y / 4)) || []) {
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
      if (!d) continue
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d, l3 = 1 - l1 - l2
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue
      const top = l1 * a[2] + l2 * b[2] + l3 * c[2]
      if (top > z - 0.3 && top < z + 2.5) return true
    }
    return false
  }
  const M = ext ? ext.off - 0.1 : 2, S = terr.size // past the next tiles' terrain this tile has (a piece reaching far out: the bake cuts them at the edges) there is no ground to lay paint on
  refine(paint, decalH, (x, y, z) => x < -M || y < -M || x > S + M || y > S + M || underDeck(x, y, z))
  const pack = (T) => {
    if (!T.nv) return null
    const PP = new Float32Array(T.P)
    return { position: PP, normal: normals(terr, PP), aRoad: new Float32Array(T.A), aRoad2: new Float32Array(T.B), index: T.nv > 65535 ? new Uint32Array(T.I) : new Uint16Array(T.I) }
  }
  return { surf: pack(surf), paint: pack(paint) }
}

// Decals split where the ground bends under them, as the ground's own triangles are (ground(): an edge is halved
// while the ground along it strays more than 5 cm from the straight line between its ends), so they lie on it: a wide
// road's stripe across a camber, a crosswalk over a crown. Each point keeps its lift over the ground (heightAt: h).
// Deck strips drawn over each other within 30 cm (two ways mapped across each other, a footway beside a road deck, two
// pieces meeting at a slant) flicker where they overlap: the roads first, then the rest by kind (the sidewalk bands
// among themselves), each strip's triangles left out where one already drawn covers them, split to 30 cm along its edge
function unstack(T) {
  const P = T.P, A = T.A, B = T.B, runs = T.runs
  const layer = (r) => r.kind >= 100 ? 1 : 0, grid = [new Map(), new Map()], G = 2
  const inside = (t, x, y, h) => { // is (x, y) on accepted triangle t, within 30 cm of its height?
    const [ax, ay, ah, bx, by, bh, cx, cy, ch] = t, d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (!d) return false
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, l3 = 1 - l1 - l2
    return l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6 && Math.abs(l1 * ah + l2 * bh + l3 * ch - h) < 0.3
  }
  const near = (g, x0, y0, x1, y1, h0, h1) => { // the accepted triangles whose box meets this one's (and its heights, 30 cm on)
    const out = new Set()
    for (let u = Math.floor(x0 / G); u <= Math.floor(x1 / G); u++) for (let w = Math.floor(y0 / G); w <= Math.floor(y1 / G); w++) for (const t of g.get(u * 65536 + w) || [])
      if (t[9] <= x1 && t[11] >= x0 && t[10] <= y1 && t[12] >= y0 && Math.min(t[2], t[5], t[8]) < h1 + 0.3 && Math.max(t[2], t[5], t[8]) > h0 - 0.3) out.add(t)
    return [...out]
  }
  const v3 = (v) => [P[v * 3], -P[v * 3 + 2], P[v * 3 + 1]]
  const lerp = (a, b, f) => { const m = P.length / 3; for (let c = 0; c < 3; c++) P.push(P[a * 3 + c] + (P[b * 3 + c] - P[a * 3 + c]) * f); for (let c = 0; c < 4; c++) { A.push(A[a * 4 + c] + (A[b * 4 + c] - A[a * 4 + c]) * f); B.push(B[a * 4 + c] + (B[b * 4 + c] - B[a * 4 + c]) * f) } return m }
  const cut = (poly, f) => { // the part of a convex polygon (vertex ids) where f(v) <= 0, new vertices on its edges
    const out = []
    for (let i = 0; i < poly.length; i++) {
      const u = poly[i], w = poly[(i + 1) % poly.length], fu = f(u), fw = f(w)
      if (fu <= 1e-6) out.push(u)
      if ((fu < -1e-6 && fw > 1e-6) || (fu > 1e-6 && fw < -1e-6)) out.push(lerp(u, w, fu / (fu - fw)))
    }
    return out
  }
  const sep = (P1, P2) => { // a separating axis among convex P1's edges (apart, or touching along it)
    const n = P1.length, mx = P1.reduce((s, p) => s + p[0], 0) / n, my = P1.reduce((s, p) => s + p[1], 0) / n
    for (let i = 0; i < n; i++) {
      const [x0, y0] = P1[i], [x1, y1] = P1[(i + 1) % n], nx = y0 - y1, ny = x1 - x0, side = Math.sign(nx * (mx - x0) + ny * (my - y0)), nl = Math.hypot(nx, ny) || 1
      if (nl > 1e-9 && P2.every(([x, y]) => side * (nx * (x - x0) + ny * (y - y0)) / nl < 1e-3)) return true
    }
    return false
  }
  const area2 = (poly) => { let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += P[a * 3] * -P[b * 3 + 2] - P[b * 3] * -P[a * 3 + 2] } return Math.abs(s) }
  const out = []
  for (const r of [...runs].sort((p, q) => layer(p) - layer(q) || p.kind - q.kind)) {
    const g = grid[layer(r)], keep = []
    const tri = (a, b, c) => {
      const [pa, pb, pc] = [v3(a), v3(b), v3(c)], me = [pa, pb, pc]
      const cand = near(g, Math.min(pa[0], pb[0], pc[0]), Math.min(pa[1], pb[1], pc[1]), Math.max(pa[0], pb[0], pc[0]), Math.max(pa[1], pb[1], pc[1]), Math.min(pa[2], pb[2], pc[2]), Math.max(pa[2], pb[2], pc[2]))
        .filter((t) => { const T3 = [[t[0], t[1]], [t[3], t[4]], [t[6], t[7]]]; return !sep(me, T3) && !sep(T3, me) }) // (those it really overlaps)
      if (!cand.length) return keep.push(a, b, c)
      // what is left of it off them: convex pieces of [vertex ids], cut by each one's edges in turn
      let polys = [[a, b, c]]
      for (const t of cand) {
        const T3 = [[t[0], t[1]], [t[3], t[4]], [t[6], t[7]]], next = []
        for (let poly of polys) {
          const pv = poly.map((v) => [P[v * 3], -P[v * 3 + 2]])
          if (sep(pv, T3) || sep(T3, pv)) { next.push(poly); continue } // (a piece clear of it)
          const pieces = []
          let inner = poly
          for (let i = 0; i < 3 && inner.length >= 3; i++) {
            const [x0, y0] = T3[i], [x1, y1] = T3[(i + 1) % 3], [x2, y2] = T3[(i + 2) % 3], nx = y0 - y1, ny = x1 - x0, sd = Math.sign(nx * (x2 - x0) + ny * (y2 - y0)) || 1
            const f = (v) => sd * (nx * (P[v * 3] - x0) + ny * (-P[v * 3 + 2] - y0)) // > 0: on its side of this edge
            const outside = cut(inner, f) // (off this edge of it; the rest goes on to the next edge)
            if (outside.length >= 3 && area2(outside) > 1e-4) pieces.push(outside) // (not a sliver of nothing)
            inner = cut(inner, (v) => -f(v))
          }
          // where they overlap: the same surface (within 30 cm) only; one passing over or under the other stays whole
          const d = (t[4] - t[7]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[1] - t[7]), hAt = (x, y) => { const l1 = ((t[4] - t[7]) * (x - t[6]) + (t[6] - t[3]) * (y - t[7])) / d, l2 = ((t[7] - t[1]) * (x - t[6]) + (t[0] - t[6]) * (y - t[7])) / d; return l1 * t[2] + l2 * t[5] + (1 - l1 - l2) * t[8] }
          if (inner.length >= 3 && d && inner.some((v) => Math.abs(hAt(P[v * 3], -P[v * 3 + 2]) - P[v * 3 + 1]) < 0.3)) next.push(...pieces)
          else next.push(poly)
        }
        polys = next
      }
      for (const poly of polys) for (let i = 1; i < poly.length - 1; i++) keep.push(poly[0], poly[i], poly[i + 1])
    }
    for (let i = r.i0; i < r.i1; i += 3) tri(T.I[i], T.I[i + 1], T.I[i + 2])
    for (let i = 0; i < keep.length; i += 3) {
      const t = [...v3(keep[i]), ...v3(keep[i + 1]), ...v3(keep[i + 2])]
      t.push(Math.min(t[0], t[3], t[6]), Math.min(t[1], t[4], t[7]), Math.max(t[0], t[3], t[6]), Math.max(t[1], t[4], t[7])) // (its box: 9..12)
      for (let u = Math.floor(Math.min(t[0], t[3], t[6]) / G); u <= Math.floor(Math.max(t[0], t[3], t[6]) / G); u++)
        for (let w = Math.floor(Math.min(t[1], t[4], t[7]) / G); w <= Math.floor(Math.max(t[1], t[4], t[7]) / G); w++) { const k = u * 65536 + w; let l = g.get(k); if (!l) g.set(k, (l = [])); l.push(t) }
      out.push(keep[i], keep[i + 1], keep[i + 2])
    }
  }
  const inRun = new Uint8Array(T.I.length); for (const r of runs) inRun.fill(1, r.i0, r.i1)
  for (let i = 0; i < T.I.length; i += 3) if (!inRun[i]) out.push(T.I[i], T.I[i + 1], T.I[i + 2]) // (the plates between deck ends)
  T.I = out; T.nv = P.length / 3
}

// hidden(x, y, z): a decal point a deck covers (paint under a deck, or poking through its end): dropped, split to 0.75 m
// along the deck's edge first
function refine(T, h, hidden, tol = 0.05) {
  const P = T.P, A = T.A, B = T.B, lift = []
  for (let v = 0; v < T.nv; v++) lift.push(P[v * 3 + 1] - h(P[v * 3], -P[v * 3 + 2]))
  const mids = new Map()
  const bends = (a, b) => {
    const ax = P[a * 3], ay = -P[a * 3 + 2], bx = P[b * 3], by = -P[b * 3 + 2], L = Math.hypot(bx - ax, by - ay)
    if (L < 0.3) return 0
    const ha = h(ax, ay), hb = h(bx, by), k = Math.max(2, Math.ceil(L / 2))
    for (let i = 1; i < k; i++) { const f = i / k; if (Math.abs(h(ax + (bx - ax) * f, ay + (by - ay) * f) - ha - (hb - ha) * f) > tol) return L }
    return 0
  }
  const mid = (a, b) => {
    const key = a < b ? a * 4194304 + b : b * 4194304 + a
    let m = mids.get(key)
    if (m !== undefined) return m
    m = P.length / 3; mids.set(key, m)
    const x = (P[a * 3] + P[b * 3]) / 2, y = -(P[a * 3 + 2] + P[b * 3 + 2]) / 2, l = (lift[a] + lift[b]) / 2
    P.push(x, h(x, y) + l, -y); lift.push(l)
    for (let c = 0; c < 4; c++) { A.push((A[a * 4 + c] + A[b * 4 + c]) / 2); B.push((B[a * 4 + c] + B[b * 4 + c]) / 2) }
    return m
  }
  const d2 = (p, q) => (P[p * 3] - P[q * 3]) ** 2 + (P[p * 3 + 2] - P[q * 3 + 2]) ** 2
  const at = (w) => { let x = 0, y = 0, z = 0; for (const [v, f] of w) { x += P[v * 3] * f; y -= P[v * 3 + 2] * f; z += P[v * 3 + 1] * f } return hidden(x, y, z) }
  const out = [], tri = (a, b, c, d) => {
    const hid = [[[a, 1]], [[b, 1]], [[c, 1]], [[a, 0.5], [b, 0.5]], [[b, 0.5], [c, 0.5]], [[c, 0.5], [a, 0.5]], [[a, 1 / 3], [b, 1 / 3], [c, 1 / 3]]].map(at)
    if (hid.some(Boolean)) {
      const ab = d2(a, b), bc = d2(b, c), ca = d2(c, a), m = Math.max(ab, bc, ca)
      if (hid.every(Boolean) || m < 0.56 || d > 24) return
      if (m === ab) { const q = mid(a, b); tri(a, q, c, d + 1); tri(q, b, c, d + 1) }
      else if (m === bc) { const q = mid(b, c); tri(a, b, q, d + 1); tri(a, q, c, d + 1) }
      else { const q = mid(c, a); tri(a, b, q, d + 1); tri(q, b, c, d + 1) }
      return
    }
    if (d < 16) {
      let ab = bends(a, b), bc = bends(b, c), ca = bends(c, a), m = Math.max(ab, bc, ca)
      if (!m) { // straight edges round a hump or a hollow (a crown, the twist of a slope): its longest edge (the hairline
        // this opens to the next triangle is under 5 cm, inside the decal)
        const x = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, y = -(P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3
        if (Math.abs(h(x, y) + (lift[a] + lift[b] + lift[c]) / 3 - (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3) > tol) {
          ab = d2(a, b); bc = d2(b, c); ca = d2(c, a); m = Math.max(ab, bc, ca)
        }
      }
      if (m > 0) {
        if (m === ab) { const q = mid(a, b); tri(a, q, c, d + 1); tri(q, b, c, d + 1) }
        else if (m === bc) { const q = mid(b, c); tri(a, b, q, d + 1); tri(a, q, c, d + 1) }
        else { const q = mid(c, a); tri(a, b, q, d + 1); tri(q, b, c, d + 1) }
        return
      }
    }
    out.push(a, b, c)
  }
  for (let i = 0; i < T.I.length; i += 3) tri(T.I[i], T.I[i + 1], T.I[i + 2], 0)
  T.I = out; T.nv = P.length / 3
}

// ---------------------------------------------------------------- crosswalks
// the crosswalks whose middle and both ends lie on the carriageway as drawn (R: roadMask; null keeps them all): one
// placed outside a junction box that falls off it (a short leg, a bend: along() goes on straight) goes where it was
// mapped, else it is left out
function onCarriage(cws, R) {
  if (!R) return cws
  const on = (x, y) => [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].every(([a, b]) => onMask(R, x + a, y + b))
  const fits = (c, w) => [-1, 0, 1].every((s) => on(c.x - c.ty * (w / 2 - 0.75) * s, c.y + c.tx * (w / 2 - 0.75) * s))
  const out = []
  for (const c of cws) {
    if (fits(c, c.w)) out.push(c)
    else if (c.jct && c.hit && fits(c.hit, c.w)) out.push({ ...c, ...c.hit, jct: false })
  }
  return out
}
// One per crossing leg, square across the carriageway it crosses and kerb to kerb as drawn, from OpenStreetMap's
// crossing ways (footway / cycleway=crossing, often split in two at the road) and its marked crossing nodes (POIs 7:
// bars, 8: two lines), which often map the same crossing twice. Near a junction it stands just outside the junction
// box, in line with the corners and in front of the stop line, whichever way OSM drew it (diagonally through the
// box, past the kerbs); elsewhere where it is mapped.
const CW = 3 // crosswalk width, metres
const CAR = (L) => L.kind <= K.living && !L.z && !L.crossing
// the carriageway ends at each node: { L, e (0 its start, 1 its end), dx, dy (unit, away from the node) }
function carEnds(lines) {
  const ends = new Map()
  for (const L of lines) {
    if (!CAR(L)) continue
    const P = L.pts, m = P.length - 2
    for (const e of [0, 1]) {
      const i = e ? m : 0, j = e ? m - 2 : 2, dx = P[j] - P[i], dy = P[j + 1] - P[i + 1], l = Math.hypot(dx, dy) || 1, id = e ? L.b : L.a
      let a = ends.get(id); if (!a) ends.set(id, (a = []))
      a.push({ L, e, dx: dx / l, dy: dy / l })
    }
  }
  return ends
}
// how far the junction box at end e of L reaches along it: the half widths of the carriageways across it there,
// longer when they cross at a slant; null where three or more carriageways don't meet (no junction)
function setback(ends, L, e) {
  const a = ends?.get(e ? L.b : L.a)
  if (!a || a.length < 3) return null
  const q = a.find((o) => o.L === L && o.e === e)
  let s = 0
  for (const o of a) { const sin = Math.abs(q.dx * o.dy - q.dy * o.dx); if (o !== q && sin > 0.35) s = Math.max(s, o.L.w / 2 / sin) }
  return Math.min(s, 20)
}
// the point d metres along L from end e (on past it in a straight line), with the tangent pointing on from that end
function along(L, e, d) {
  const P = L.pts, n = P.length / 2
  for (let k = 0; k < n - 1; k++) {
    const i = e ? n - 1 - k : k, j = e ? i - 1 : i + 1
    const x0 = P[i * 2], y0 = P[i * 2 + 1], dx = P[j * 2] - x0, dy = P[j * 2 + 1] - y0, l = Math.hypot(dx, dy) || 1
    if (d <= l || k === n - 2) return { x: x0 + (dx / l) * d, y: y0 + (dy / l) * d, tx: dx / l, ty: dy / l }
    d -= l
  }
}
// -> [{ x, y, tx, ty (along the carriageway), w (its width), lines (1: two lines, 0: bars) }], tile-local
function crosswalks(lines, ends, ps, ox, oy) {
  const cars = lines.filter(CAR), grid = new Map(), G = 16
  const cell = (x, y) => Math.floor(x / G) * 4096 + Math.floor(y / G)
  cars.forEach((L, k) => { for (let i = 0; i < L.pts.length / 2 - 1; i++) { // (car, segment) pairs on a grid
    const P = L.pts, n = Math.ceil(Math.hypot(P[i * 2 + 2] - P[i * 2], P[i * 2 + 3] - P[i * 2 + 1]) / G)
    for (let s = 0; s <= n; s++) {
      const f = s / n || 0, c = cell(P[i * 2] + (P[i * 2 + 2] - P[i * 2]) * f, P[i * 2 + 1] + (P[i * 2 + 3] - P[i * 2 + 1]) * f)
      let a = grid.get(c); if (!a) grid.set(c, (a = [])); if (a.at(-2) !== k || a.at(-1) !== i) a.push(k, i)
    }
  } })
  // the carriageway points within 1 m of segment a-b (or of point a): { L, x, y, u (metres along L), sin (how square it is crossed) }
  const hits = (ax, ay, bx, by) => {
    const out = [], seen = new Set()
    for (let gx = Math.floor((Math.min(ax, bx) - 1) / G); gx <= Math.floor((Math.max(ax, bx) + 1) / G); gx++) for (let gy = Math.floor((Math.min(ay, by) - 1) / G); gy <= Math.floor((Math.max(ay, by) + 1) / G); gy++) {
      const a = grid.get(gx * 4096 + gy) || []
      for (let k = 0; k < a.length; k += 2) {
        const L = cars[a[k]], i = a[k + 1], key = a[k] * 65536 + i
        if (seen.has(key)) continue
        seen.add(key)
        const P = L.pts, x0 = P[i * 2], y0 = P[i * 2 + 1], dx = P[i * 2 + 2] - x0, dy = P[i * 2 + 3] - y0, l2 = dx * dx + dy * dy || 1
        const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex
        let f = -1
        if (Math.abs(den) > 1e-9) { // segments crossing
          const s = ((ax - x0) * ey - (ay - y0) * ex) / den, r = ((ax - x0) * dy - (ay - y0) * dx) / den
          if (s >= 0 && s <= 1 && r >= 0 && r <= 1) f = s
        }
        if (f < 0) for (const [px, py] of [[ax, ay], [bx, by]]) { // an end of the crossing on (or just off) the carriageway
          const s = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2))
          if (Math.hypot(x0 + dx * s - px, y0 + dy * s - py) < 1) { f = s; break }
        }
        if (f < 0) continue
        let u = 0
        for (let j = 0; j < i; j++) u += Math.hypot(P[j * 2 + 2] - P[j * 2], P[j * 2 + 3] - P[j * 2 + 1])
        const el = Math.hypot(ex, ey)
        out.push({ L, x: x0 + dx * f, y: y0 + dy * f, u: u + Math.sqrt(l2) * f, sin: el > 1e-6 ? Math.abs(dx * ey - dy * ex) / Math.sqrt(l2) / el : 1, tx: dx / Math.sqrt(l2), ty: dy / Math.sqrt(l2) })
      }
    }
    return out
  }
  const lens = new Map(), len = (L) => {
    let s = lens.get(L)
    if (s === undefined) { s = 0; for (let j = 0; j < L.pts.length / 2 - 1; j++) s += Math.hypot(L.pts[j * 2 + 2] - L.pts[j * 2], L.pts[j * 2 + 3] - L.pts[j * 2 + 1]); lens.set(L, s) }
    return s
  }
  // where a crossing at hit h goes: just outside the junction box when a junction is near, else where it is.
  // (cx, cy): which way the crossing lies from the hit, to tell the legs apart when OSM ends it in the junction
  const place = (h, cx, cy) => {
    let best = null
    for (const e of [0, 1]) {
      const sb = setback(ends, h.L, e), dist = e ? len(h.L) - h.u : h.u
      if (sb == null || dist > sb + 12) continue
      const p = along(h.L, e, sb + 1 + CW / 2), side = p.tx * cx + p.ty * cy
      if (!best || dist < best.dist - 0.5 || (Math.abs(dist - best.dist) <= 0.5 && side > best.side)) best = { ...p, dist, side, jct: true }
    }
    return best || { x: h.x, y: h.y, tx: h.tx, ty: h.ty, dist: 0, side: 0, jct: false }
  }
  const out = []
  const add = (g, cx, cy, ls, node) => { // hits g at one spot (the road's pieces meet there): the one placed best
    let h = null, p = null
    for (const o of g) { const q = place(o, cx - o.x, cy - o.y); if (!p || (q.jct ? 10 : 0) + q.side > (p.jct ? 10 : 0) + p.side) { h = o; p = q } }
    const c = { x: p.x, y: p.y, tx: p.tx, ty: p.ty, w: h.L.w, lines: ls, node, jct: p.jct, hit: { x: h.x, y: h.y, tx: h.tx, ty: h.ty } }
    const o = out.find((o) => Math.hypot(o.x - c.x, o.y - c.y) < 3.5 && Math.abs(o.tx * c.tx + o.ty * c.ty) > 0.8)
    if (!o) return out.push(c)
    if (c.jct && !o.jct) Object.assign(o, { x: c.x, y: c.y, tx: c.tx, ty: c.ty, w: c.w, jct: true })
    if (node && !o.node) Object.assign(o, { lines: ls, node })
  }
  for (const q of ps) { // marked crossing nodes on a carriageway (not in the middle of a junction: which way would it go?)
    if (q.kind !== 7 && q.kind !== 8) continue
    const x = q.x - ox, y = q.y - oy, hs = hits(x, y, x, y)
    if (!hs.length || hs.some((h) => [0, 1].some((e) => (e ? len(h.L) - h.u : h.u) < 1 && setback(ends, h.L, e) != null))) continue
    add(hs, x, y, q.kind === 8 ? 1 : 0, true)
  }
  for (const C of lines) {
    if (!C.crossing) continue
    const P = C.pts, n = P.length / 2
    let hs = []
    for (let i = 0; i < n - 1; i++) hs.push(...hits(P[i * 2], P[i * 2 + 1], P[i * 2 + 2], P[i * 2 + 3]))
    if (!hs.length) continue
    const top = Math.max(...hs.map((h) => h.sin))
    hs = hs.filter((h) => h.sin >= top - 0.2) // the carriageway it crosses, not one it runs along
    let mx = 0, my = 0
    for (let i = 0; i < n; i++) { mx += P[i * 2] / n; my += P[i * 2 + 1] / n }
    // hits within 2 m of each other are one crossing (the road's pieces meet there); a crossing of two carriageways (a divided road) is two
    const groups = []
    for (const h of hs) { const g = groups.find((g) => Math.hypot(g[0].x - h.x, g[0].y - h.y) < 2); if (g) g.push(h); else groups.push([h]) }
    for (const g of groups) add(g, mx, my, 0, false)
  }
  return out
}

// drivable/walkable graph for plugins (traffic, people): pieces with global node ids and world points
function graph(t, lines) {
  const pieces = []
  for (const L of lines) {
    const pts = new Float32Array(L.pts.length)
    for (let i = 0; i < L.pts.length / 2; i++) { pts[i * 2] = L.pts[i * 2] + t.ox; pts[i * 2 + 1] = L.pts[i * 2 + 1] + t.oy }
    pieces.push({ kind: L.kind, lanes: L.lanes, oneway: L.oneway, drive: L.drive, band: L.band, tunnel: L.tunnel ? TUBE_H(L.kind) : 0, roof: L.roof, turns: L.turns, w: L.w, a: L.a, b: L.b, pts, z: L.z })
  }
  return { pieces }
}

// ---------------------------------------------------------------- buildings
const PALETTES = [ // style ids from tools/tiles.py (HOUSE, APT, ...); colours as seen (sRGB), like OSM's
  // 0 house
  { wall: [0xe8e4d8, 0xd8d0bc, 0xc8c0b0, 0xb8c4c8, 0xa8b8c4, 0xd4c49c, 0xa8b498, 0xc89880, 0xe0d8c8, 0x98a8b4, 0xd0b8a0, 0x8094a4], roof: [0x4a4f55, 0x5f6366, 0x6e6a66, 0x7a5a48, 0x3e4349, 0x8c4a3a, 0x9a5038, 0x52606a, 0x6b4d3c] },
  // 1 apartments
  { wall: [0xe6e2d8, 0xd6d0c4, 0xcfc6b4, 0xe0d6c0, 0xc4b494, 0xb09a7c, 0x9a6e58, 0x8c5c4a, 0xd2ccc0, 0xbcbab2, 0xc8b898], roof: [0x8c8e8c, 0x9a9c9a, 0x7e8284, 0xa8a8a4, 0x5a6068, 0x6a7078] },
  // 2 office / glass
  { wall: [0xd8dcdc, 0xc8d0d4, 0xb8c4cc, 0xe0e2e0, 0xa8b8c0], roof: [0x9a9c9a, 0x8c9090, 0x7e8488, 0x5a6068] },
  // 3 brick / heritage (Gastown, Chinatown, Yaletown warehouses: red and brown brick, a few painted)
  { wall: [0x8a4c3c, 0x7c4636, 0x925844, 0x744234, 0x9a6448, 0x845440, 0x7a5040, 0xb08a6a], roof: [0x6e5a50, 0x7c6a60, 0x4a4f55, 0x5a5e62] },
  // 4 commercial
  { wall: [0xc4bcaa, 0xd0c8b8, 0xb0aca2, 0xd8d0be, 0xa8b4bc, 0xcccbc6, 0xb89c7c, 0x9ca4a8], roof: [0x9c9e9c, 0x8c9090, 0xaaa8a2, 0x868a8c, 0x7a7e82, 0x5c6266] },
  // 5 civic / white
  { wall: [0xe4e2dc, 0xdcdcd8, 0xd0d2d2, 0xd8d0c0, 0xc8c0b0], roof: [0x9a9a96, 0xa8a8a4, 0x5a7a6a, 0x5a6068] },
  // 6 glass condo tower: white and pale grey mullions and slab edges around blue-green glass
  { wall: [0xe8ecea, 0xe0e6e6, 0xd2dadc, 0xeae8e2, 0xc8d2d6], roof: [0xa4a6a4, 0x989c9c, 0xb0b0ac] },
  // 7 concrete (West End towers, 1960s-70s offices, parkades)
  { wall: [0xc0b8a8, 0xb0aa9e, 0xcac2b0, 0xa29e96, 0xbab4aa, 0xd0c6b0, 0xa6aaaa], roof: [0x989894, 0x8a8c8a, 0xa4a4a0] },
  // 8 metal shed (warehouses, mills, port sheds)
  { wall: [0xb8bcbe, 0xa8b0b4, 0xc8c8c0, 0x8a98a4, 0xd0ccbc, 0x7c8c84, 0xc4b8a0, 0x9aa4ac], roof: [0xb0b4b6, 0xc0c4c4, 0xa0a8ac, 0xd8dad8, 0x8c949a] },
  // 9 big box / mall
  { wall: [0xd0cabc, 0xdcd8ce, 0xbebab2, 0xccc4b4, 0xe0dcd4], roof: [0xb8b8b4, 0xc4c4c0, 0xa8aaa8] },
  // 10 stone
  { wall: [0xc8bca4, 0xb8ae98, 0xd4c8b0, 0xa8a090, 0xbcb4a4], roof: [0x5a6a64, 0x6a5a50, 0x4a4f55, 0x5a8a78] },
  // 11 character house: painted wood siding (deep greens, blues, greys, creams, a burgundy)
  { wall: [0x5f7a68, 0x6a8098, 0x8a9a8c, 0xe8e0c8, 0x7e8c94, 0x9a5048, 0xd8c89c, 0x4e6a7a, 0xa8b4a0, 0xf0ece0, 0x8a7a68], roof: [0x3e4246, 0x4a4f55, 0x2f3236, 0x5a5048, 0x55595c] },
  // 12 Vancouver Special: white or cream stucco
  { wall: [0xf2efe6, 0xece6d6, 0xe8e4dc, 0xf4f0e8, 0xe0dccc], roof: [0x4a4642, 0x5a5048, 0x3e4349, 0x6a5a4c] },
]
const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]
// colours meant as seen (OSM building:colour / roof:colour, the material palettes): vertex colours are linear
const lin = (h) => hex(h).map((c) => c ** 1.8) // a little lighter than linear: the stylized map reads brighter than a photo
const shade = (c, f) => [Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)]

// one building record of a tile's BLDG section at byte o (tools/tiles.py) -> its fields, its ring ([x, north], tile-local)
// and the next record's offset
function readBuilding(t, o) {
  const dv = t.dv
  const fl = dv.getUint8(o), style0 = dv.getUint8(o + 1), base = dv.getInt16(o + 2, true) / 10, h = dv.getUint16(o + 4, true) / 10
  o += 6
  let mn = 0, roofShape = 0, ridge = 0, wallHex = 0, roofHex = 0, gid = 0, gH = h
  if (fl & 1) { mn = dv.getUint16(o, true) / 10; o += 2 }
  if (fl & 2) { roofShape = dv.getUint8(o); ridge = dv.getUint16(o + 1, true) / 10; o += 3 }
  const roofBits = roofShape & 48; roofShape &= 15 // 16: ridge along the short axis, 32: a shed roof's high side flipped
  if (fl & 4) { wallHex = dv.getUint32(o, true) | 0x1000000; o += 4 }
  if (fl & 8) { roofHex = dv.getUint32(o, true) | 0x1000000; o += 4 }
  if (fl & 16) { gH = dv.getUint16(o, true) / 10; gid = dv.getUint32(o + 2, true); o += 6 }
  let fh = 0, bits = 0, plant = null // storey height; bits 1 storefront, 2 residential, 4 planted roof, 8 rooftop pool, 16 solar panels; rooftop plant the LiDAR saw
  if (fl & 32) { fh = dv.getUint8(o) / 20; bits = dv.getUint8(o + 1); o += 2 }
  let fx = 0, facing = 0 // the building's own facade (tools/facades.py): balcony kind | pattern << 4, balcony facing octants
  if (fl & 128) { fx = dv.getUint8(o); facing = dv.getUint8(o + 1); o += 2 }
  if (fl & 64) {
    const nu = dv.getUint8(o); o += 1; plant = []
    for (let k = 0; k < nu; k++, o += 8) plant.push([dv.getInt16(o, true) * t.k, dv.getInt16(o + 2, true) * t.k, dv.getUint8(o + 4) / 10, dv.getUint8(o + 5) / 10, dv.getUint8(o + 6) / 20, (dv.getUint8(o + 7) / 256) * Math.PI])
  }
  const [flat, o2] = readRing(t, o)
  const pts = []
  for (let p = 0; p < flat.length / 2; p++) pts.push([flat[p * 2], flat[p * 2 + 1]])
  return { fl, style0, base, h, mn, roofShape, roofBits, ridge, wallHex, roofHex, gid, gH, fh, bits, fx, facing, plant, pts, o: o2 }
}

// carriage: the detail tile's 1 m carriageway mask (roadMask), for the light storefronts spill onto the street
function buildings(t, terr, level, lines, carriage) {
  const s = t.sections.BLDG
  const W = { pos: [], nor: [], col: [], win: [], fac: [] }, Bal = { pos: [], nor: [], col: [], win: [], fac: [] }
  const fp = [], fpStart = [0] // footprints: world x, north pairs; ring i is fp[fpStart[i]..fpStart[i+1])
  const fronts = [] // storefront walls that face a street: ax, ay, px, py, ground height (for the shop signs)
  const spill = [] // tile-local x, north: where a lit shop window throws light on the sidewalk
  const AO = { P: [], T: [], I: [] } // the shade on the ground round the walls' feet (skirt)
  if (!s) return {}
  if (level === 0) tubes(W, lines)
  if (level === 0) railings(W, Bal, lines, terr) // (a road on a roof has the building's parapet)
  const dv = t.dv
  let o = s.off
  const n = dv.getUint32(o, true); o += 4
  const detail = level === 0
  const recs = []
  for (let bi = 0; bi < n; bi++) { const b = readBuilding(t, o); o = b.o; recs.push(b) }
  // each wall's own look, as the 2022 LiDAR saw it (tools/lidar_walls.py; FACD: per building its wall count, 0 for none,
  // then 4 bytes a wall): glazing, spandrel tone, window bay and size, storey height
  const fs = t.sections.FACD
  if (fs && detail) for (let bi = 0, q = fs.off; bi < n && q < fs.off + fs.len; bi++) {
    const k = dv.getUint8(q); q += 1
    if (k && k === recs[bi].pts.length) recs[bi].looks = new Uint8Array(t.buf, q, k * 4)
    q += k * 4
  }
  // which walls a neighbour covers (party walls: windowless), from every footprint of the tile (detail tiles)
  const G = 16, grid = new Map(), gk = (i, j) => i * 4096 + j
  if (detail) for (const b of recs) {
    const [x0, y0, x1, y1] = bbox(b.pts)
    for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++) for (let j = Math.floor(y0 / G); j <= Math.floor(y1 / G); j++) { const k = gk(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(b) }
  }
  // a wall from y0 to y1, (x, y) just outside it and (ix, iy) just inside: covered for at least half its height by a
  // neighbour standing beside it (not one overlapping it: a part over a bigger outline, a duplicate)
  const covered = (self, x, y, ix, iy, y0, y1) => grid.get(gk(Math.floor(x / G), Math.floor(y / G)))?.some((b) => b !== self && b.base + b.mn < y0 + 2 && b.base + b.h >= y0 + 0.6 * (y1 - y0) && inPoly(x, y, b.pts) && !inPoly(ix, iy, b.pts))
  for (const rec of recs) {
    const { fl, style0, base, h, mn, roofShape, roofBits, ridge, wallHex, roofHex, gH, fh, bits, fx, facing, plant, pts, looks } = rec
    let { gid } = rec
    const np = pts.length
    if (MASKS.length) {
      let cx = 0, cy = 0
      for (const [x, y] of pts) { cx += x / np; cy += y / np }
      cx += t.ox; cy += t.oy
      if (MASKS.some((m) => cx >= m.bb[0] && cx <= m.bb[2] && cy >= m.bb[1] && cy <= m.bb[3] && inPoly(cx, cy, m.r))) continue
    }
    if (detail && mn < 2.5) { for (const [x, y] of pts) fp.push(x + t.ox, y + t.oy); fpStart.push(fp.length) } // parts you can drive under are left out
    if (!gid) gid = (Math.imul(Math.round(pts[0][0] * 10 + t.ox), 73856093) ^ Math.imul(Math.round(pts[0][1] * 10 + t.oy), 19349663)) >>> 0 || 1
    if (area(pts) < 0) pts.reverse() // counter-clockwise (y north)
    const gr = mulberry(gid), pick = (a) => a[Math.floor(gr() * a.length)]
    const seed = gr(), r = gr(), tower = gH > 20
    // facade pattern: -1 none, 1 punched windows, 2 curtain wall, 3 glass balconies, 5 wood siding, 6 ribbed metal,
    // 7 big box, 8 Vancouver Special, 9 glass condo, 10 window bands; the storefront and the storey height ride along
    // (see materials.js)
    let style = 1
    if (style0 === 0) style = h < 4 ? -1 : r < 0.5 ? 5 : 1
    else if (style0 === 2) style = 2
    else if (style0 === 6) style = tower ? (r < 0.8 ? 9 : 2) : 2
    else if (style0 === 1) style = tower ? (r < 0.15 ? 2 : r < 0.85 ? 3 : 1) : h > 9 && r < 0.4 ? 3 : 1
    else if (style0 === 8) style = 6
    else if (style0 === 9) style = 7
    else if (style0 === 11) style = h < 3 ? -1 : 5
    else if (style0 === 12) style = 8
    const front = !!(bits & 1) || (style0 === 4 && !(fl & 32) && h >= 5) // old tiles: commercial = storefront
    if (style0 === 4 && h < 5) style = -1
    if (fx >> 4) style = fx >> 4
    const fq = Math.max(1, Math.min(31, Math.round(((fh || 3.2) - 2.4) / 0.15)))
    const styleW = style + (fq + (front && style !== 6 && style !== 7 ? 32 : 0)) / 64
    const storey = 2.4 + fq * 0.15
    // what the windows light up for (materials.js): 1 homes, 2 work (offices, shops, civic), 0 not known; it rides on the seed
    const use = bits & 2 || style0 === 0 || style0 === 1 || style0 === 6 || style0 >= 11 ? 1 : style0 === 2 || style0 === 4 || style0 === 5 || style0 === 7 || style0 === 9 ? 2 : 0
    const bk = fx & 15 // balconies: 1 none, 2 glass, 3 solid fronts; 0: by the pattern
    const balc = detail && h - mn > 9 && np <= 120 && (bk ? bk > 1 : fl & 32 ? bits & 2 && (style === 3 || style === 9 || style0 === 7 && tower) : style === 3)
    const pal = PALETTES[style0] || PALETTES[4]
    const wall = shade(wallHex & 0x1000000 ? lin(wallHex & 0xffffff) : lin(pick(pal.wall)), 0.97 + gr() * 0.06)
    const ownRoof = !roofShape || style0 === 8 || style0 >= 11
    const roofC = shade(roofHex & 0x1000000 ? lin(roofHex & 0xffffff) : lin(pick(ownRoof ? pal.roof : PALETTES[0].roof)), 0.96 + gr() * 0.08)
    const y0 = base + mn, y1 = base + h
    if (front && carriage && mn < 2.5) shopSpill(pts, carriage, spill)
    if (detail && mn < 0.5 && np <= 120) skirt(AO, pts, terr)
    // a plinth: one base for a footprint on a slope leaves its walls in the air on the downhill side, so a part standing
    // on the ground (no min height) has its walls carried on, windowless, down to the lowest drawn ground along its outline
    const lo = mn < 0.5 ? lowest(terr, pts) - 0.3 : y0, plinth = lo < y0 - 0.45, plC = shade(wall, 0.82)
    // walls, each by what it faces (after Slop Toronto's footprint edges): on the low and mid-rise walls of brick, siding
    // and punched windows (rows of shops and houses; not glass towers) a wall a neighbour covers for 60% of its height or
    // more, or a sliver, is a windowless party wall; a storefront only where the wall looks onto a street (all of
    // them where the tile can't tell: the overview); the rest keep the building's pattern
    const rowWalls = detail && y1 - y0 < 25 && (style === 1 || style === 5 || style === 8 || style === 10) // brick, siding, punched: not glass towers
    const shopEdges = front && carriage ? pts.map((a, i) => streetSide(a, pts[(i + 1) % np], carriage)) : null
    if (shopEdges && mn < 2.5 && h >= 4) for (let i = 0; i < np; i++) if (shopEdges[i]) fronts.push(pts[i][0], pts[i][1], pts[(i + 1) % np][0], pts[(i + 1) % np][1], base)
    let u = 0
    for (let i = 0; i < np; i++) {
      const a = pts[i], p = pts[(i + 1) % np], len = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1
      const nx = (p[1] - a[1]) / len, nz = (p[0] - a[0]) / len // outward in (x, z=-y)
      const mx = (a[0] + p[0]) / 2, my = (a[1] + p[1]) / 2
      const party = rowWalls && (len < 2 || covered(rec, mx + nx * 0.8, my - nz * 0.8, mx - nx * 0.8, my + nz * 0.8, y0, y1))
      const kind = party ? fq / 64 : shopEdges && !shopEdges[i] && styleW % 1 >= 0.5 ? styleW - 0.5 : styleW
      const w = (uu, yy) => [kind, uu, yy - base, seed + use]
      if (looks && !party) FAC = looks.subarray(i * 4, i * 4 + 4)
      quad(W, [a[0], y0, -a[1]], [p[0], y0, -p[1]], [p[0], y1, -p[1]], [a[0], y1, -a[1]], wall, [nx, 0, nz], w(u, y0), w(u + len, y0), w(u + len, y1), w(u, y1))
      FAC = NOFAC
      if (plinth) quad(W, [a[0], lo, -a[1]], [p[0], lo, -p[1]], [p[0], y0, -p[1]], [a[0], y0, -a[1]], plC, [nx, 0, nz], [0, u, 0, seed], [0, u + len, 0, seed], [0, u + len, 0, seed], [0, u, 0, seed])
      u += len
    }
    const flat = !roofShape || !ridge || ridge <= h
    if (flat) {
      // a planted roof (the bake's bit 4: the orthophoto or OSM; else a green roof colour) gets its planting drawn
      const green = !!(bits & 4) || (roofC[1] > roofC[0] * 1.15 && roofC[1] > roofC[2] * 1.05)
      const rw = green ? [15, 0, 999, seed] : ROOFW(seed), tris = earcut2(pts)
      for (let i = 0; i < tris.length; i += 3) {
        const A = pts[tris[i]], B = pts[tris[i + 1]], C = pts[tris[i + 2]]
        tri(W, [A[0], y1, -A[1]], [B[0], y1, -B[1]], [C[0], y1, -C[1]], roofC, [0, 1, 0], rw)
      }
      // parapet and rooftop plant on the bigger flat roofs
      if (detail && h >= 5 && np <= 60) {
        const par = tower ? 1.1 : 0.7, inC = shade(roofC, 0.72)
        for (let i = 0; i < np; i++) {
          const a = pts[i], p = pts[(i + 1) % np], len = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1
          const nx = (p[1] - a[1]) / len, nz = (p[0] - a[0]) / len
          quad(W, [a[0], y1, -a[1]], [p[0], y1, -p[1]], [p[0], y1 + par, -p[1]], [a[0], y1 + par, -a[1]], wall, [nx, 0, nz], ROOFW(seed))
          quad(W, [a[0], y1, -a[1]], [p[0], y1, -p[1]], [p[0], y1 + par, -p[1]], [a[0], y1 + par, -a[1]], inC, [-nx, 0, -nz], ROOFW(seed))
        }
        if (plant) for (const [ux, uy, su, sv, uh, ang] of plant) box3(Bal, ux, uy, y1, su, sv, uh, ang, shade([0.86, 0.88, 0.9], 0.85 + gr() * 0.2)) // what the LiDAR saw up there
        rooftop(Bal, pts, y1, gr, { bits, green, plant, tower, wall, shed: style0 === 4 || style0 === 8 || style0 === 9 || style0 === 2 && h < 15 })
      }
    } else roof(W, pts, y1, base + ridge, roofShape, roofBits, roofC, wall, seed)
    // balconies: a slab and a railing (glass, or concrete on the older towers) on every floor, all the way round.
    // The slab tops are geometry; the slab fronts and railings of all the floors are one sheet per wall, 1.15 m out
    // from it, that materials.js draws them on, open between them (2 triangles a floor and wall instead of 6)
    if (balc) {
      const D = 1.15, ring = offset(pts, D), solid = bk === 3 || !bk && style0 === 7, slabC = shade(wall, 1.05), pw = ROOFW(seed)
      const fy0 = Math.max(base + Math.max(mn, front ? 4.5 : 0) + storey, y0 + 2.5), floors = Math.ceil((y1 - 2.4 - fy0) / storey)
      const b0 = fy0 - 0.4, b1 = fy0 + (floors - 1) * storey + 1.05, bw = (yy) => [11 + (fq + (solid ? 32 : 0)) / 64, 0, yy - b0, seed]
      for (let i = 0; floors > 0 && i < np; i++) {
        const a = pts[i], p = pts[(i + 1) % np], A = ring[i], P = ring[(i + 1) % np]
        const len = Math.hypot(p[0] - a[0], p[1] - a[1])
        if (len < 2.5) continue
        const nx = (p[1] - a[1]) / len, nz = (p[0] - a[0]) / len
        if (facing && !faces(facing, nx, -nz)) continue
        quad(Bal, [A[0], b0, -A[1]], [P[0], b0, -P[1]], [P[0], b1, -P[1]], [A[0], b1, -A[1]], slabC, [nx, 0, nz], bw(b0), bw(b0), bw(b1), bw(b1))
        for (let k = 0, fy = fy0; k < floors; k++, fy += storey) quad(Bal, [a[0], fy, -a[1]], [p[0], fy, -p[1]], [P[0], fy, -P[1]], [A[0], fy, -A[1]], slabC, [0, 1, 0], pw)
      }
    }
  }
  return { fronts, walls: pack(W), balconies: Bal.pos.length ? pack(Bal) : null,
    footprints: fpStart.length > 1 ? { pts: new Float32Array(fp), start: new Uint32Array(fpStart) } : null, spill,
    ao: AO.P.length ? { position: new Float32Array(AO.P), t: new Float32Array(AO.T), index: AO.P.length / 3 > 65535 ? new Uint32Array(AO.I) : new Uint16Array(AO.I) } : null }
}
// ambient occlusion where the walls meet the ground: a strip 3 m out from the foot of every wall, darkest at the wall
// (materials.js aoMaterial multiplies the ground under it); courtyards and the gaps between buildings get it twice
const SKIRT = 3
function skirt(B, pts, terr) { // on the drawn ground both sides (a plinth carries the walls down to it)
  const out = offset(pts, SKIRT), n = pts.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, v = B.P.length / 3
    for (const [q, t] of [[pts[i], 0], [pts[j], 0], [out[j], 1], [out[i], 1]]) { B.P.push(q[0], groundOut(terr, q[0], q[1]) + 0.06, -q[1]); B.T.push(t) }
    B.I.push(v, v + 2, v + 1, v, v + 3, v + 2)
  }
}
// the lowest drawn ground along a ring (tile-local), every 2 m
function lowest(terr, pts) {
  let lo = Infinity
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], p = pts[(i + 1) % pts.length], k = Math.ceil(Math.hypot(p[0] - a[0], p[1] - a[1]) / 2)
    for (let s = 0; s < k; s++) lo = Math.min(lo, groundOut(terr, a[0] + ((p[0] - a[0]) * s) / k, a[1] + ((p[1] - a[1]) * s) / k))
  }
  return lo
}
const onMask = (R, x, y) => { const i = Math.floor(x), j = Math.floor(y); if (i < 0 || j < 0 || i >= R.n || j >= R.n) return false; const k = j * R.n + i; return !!(R.bits[k >> 3] & (1 << (k & 7))) }
// does the wall a -> p (a counter-clockwise ring's) look onto a street: 3 m long or more, a carriageway within 18 m straight out
function streetSide(a, p, R) {
  const len = Math.hypot(p[0] - a[0], p[1] - a[1])
  if (len < 3) return false
  const nx = (p[1] - a[1]) / len, ny = -(p[0] - a[0]) / len, mx = (a[0] + p[0]) / 2, my = (a[1] + p[1]) / 2
  for (let d = 3; d <= 18; d += 3) if (onMask(R, mx + nx * d, my + ny * d)) return true
  return false
}
// a storefront's walls that face a street (a carriageway within 18 m straight out): a light every 3.5 m along them,
// 2.2 m out on the sidewalk
function shopSpill(pts, R, out) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], p = pts[(i + 1) % pts.length], len = Math.hypot(p[0] - a[0], p[1] - a[1])
    if (!streetSide(a, p, R)) continue
    const ex = (p[0] - a[0]) / len, ey = (p[1] - a[1]) / len, nx = ey, ny = -ex
    const n = Math.max(1, Math.round(len / 3.5))
    for (let k = 0; k < n; k++) { const f = (k + 0.5) / n; out.push(a[0] + ex * len * f + nx * 2.2, a[1] + ey * len * f + ny * 2.2) }
  }
}

// ---------------------------------------------------------------- parked cars
// In the parking lots (the ground's parking polygons): rows of stalls 2.6 m wide either side of 6.5 m aisles, square
// to the lot's long side, a car in most, none under a building; along the kerbs of the residential and smaller streets,
// one every 6.5 m a side in about half the spaces (where the street has a parking lane: parkSide), facing the way
// traffic runs there, not by junctions, crossings, signals and stops. -> { lot, kerb }: 5 floats a car: tile-local x, ground height, z, heading (about +y from +x), seed
const PARKING = 14, CAR_L = 4.6, CAR_W = 1.9
// a parking lane along both kerbs: residential and living streets and two-lane tertiaries (arterials stay clear), where
// the travel lanes keep at least 2.1 m each beside the parked cars. The life plugin's traffic narrows its lanes the same
// way (plugins/life/worker.js parkSide: keep the two in step), so it passes them instead of through them
const parkSide = (kind, lanes, w) => (kind === K.residential || kind === K.living || kind === K.tertiary && lanes <= 2) && w - 2 * CAR_W >= 2.1 * Math.max(2, lanes) ? CAR_W : 0
const rnd01 = (x, y) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v) }
function parked(t, terr, lines, ps, fp, S) {
  const size = t.size, lot = [], kerb = []
  const G = 16, grid = new Map(), gk = (i, j) => i * 4096 + j // building footprints by cell, for "under a building"
  if (fp) for (let r = 0; r < fp.start.length - 1; r++) {
    const ring = []
    for (let q = fp.start[r]; q < fp.start[r + 1]; q += 2) ring.push([fp.pts[q] - t.ox, fp.pts[q + 1] - t.oy])
    const [x0, y0, x1, y1] = bbox(ring)
    for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++) for (let j = Math.floor(y0 / G); j <= Math.floor(y1 / G); j++) { const k = gk(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(ring) }
  }
  const built = (x, y) => grid.get(gk(Math.floor(x / G), Math.floor(y / G)))?.some((r) => inPoly(x, y, r))
  const inside = (x, y) => x >= 0 && y >= 0 && x < size && y < size
  const room = (x, y, ex, ey) => !S || S.freeBox(x, y, Math.atan2(ey, ex), CAR_L / 2, CAR_W / 2) // (clear of the buildings, trunks, poles, the cars already parked)
  const car = (out, x, y, ex, ey) => { out.push(x, heightAt(terr, x, y), -y, Math.atan2(ey, ex), rnd01(y, x)); S?.addBox(x, y, Math.atan2(ey, ex), CAR_L / 2, CAR_W / 2) }
  eachPoly(t, new Set([PARKING]), (flat, holes) => {
    const rings = []
    for (let k = 0; k <= holes.length; k++) { const a = k ? holes[k - 1] : 0, b = k < holes.length ? holes[k] : flat.length / 2, r = []; for (let i = a; i < b; i++) r.push([flat[i * 2], flat[i * 2 + 1]]); rings.push(r) }
    if (Math.abs(area(rings[0])) < 150) return
    const { cx, cy, a, hl, hw } = obb(rings[0]), ca = Math.cos(a), sa = Math.sin(a)
    const on = (x, y) => inPoly(x, y, rings[0]) && !rings.slice(1).some((h) => inPoly(x, y, h))
    // across the long side: stall row (nose to the aisle), aisle, stall row, then the next pair back to back
    for (let v = -hw + CAR_L / 2 + 0.4, k = 0; v < hw - CAR_L / 2; v += k % 2 ? CAR_L + 0.6 : CAR_L + 6.5, k++) {
      const face = k % 2 ? -1 : 1 // towards the aisle
      for (let u = -hl + 1.6; u < hl - 1.3; u += 2.6) {
        const x = cx + ca * u - sa * v, y = cy + sa * u + ca * v
        if (!inside(x, y) || rnd01(x, y) > 0.72) continue
        const fx = -sa * face, fy = ca * face, ok = [[1, 1], [1, -1], [-1, 1], [-1, -1]].every(([p, q]) => on(x + fx * p * CAR_L / 2 + fy * q * CAR_W / 2, y + fy * p * CAR_L / 2 - fx * q * CAR_W / 2))
        if (ok && !built(x, y) && room(x, y, fx, fy)) car(lot, x, y, fx, fy)
      }
    }
  })
  const deg = new Map()
  for (const L of lines) for (const n of [L.a, L.b]) deg.set(n, (deg.get(n) || 0) + 1)
  const stops = new Map(), sk = (x, y) => Math.floor(x / 10) * 100003 + Math.floor(y / 10)
  for (const p of ps) if (p.kind !== 3 && p.kind !== 4) stops.set(sk(p.x - t.ox, p.y - t.oy), 1)
  const nearStop = (x, y) => { for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (stops.has(sk(x + i * 10, y + j * 10))) return true; return false }
  for (const L of lines) {
    if (!parkSide(L.kind, L.lanes, L.w) || L.z || L.layer < 0 || L.crossing) continue
    const P = L.pts, off = L.w / 2 - 0.95
    let total = 0
    for (let i = 0; i < P.length / 2 - 1; i++) total += Math.hypot(P[i * 2 + 2] - P[i * 2], P[i * 2 + 3] - P[i * 2 + 1])
    const s0 = (deg.get(L.a) || 0) >= 3 ? 12 : 3, s1 = total - ((deg.get(L.b) || 0) >= 3 ? 12 : 3)
    let run = 0, s = s0
    for (let i = 0; i < P.length / 2 - 1; i++) {
      const x0 = P[i * 2], y0 = P[i * 2 + 1], len = Math.hypot(P[i * 2 + 2] - x0, P[i * 2 + 3] - y0)
      if (len < 1e-3) continue
      const ex = (P[i * 2 + 2] - x0) / len, ey = (P[i * 2 + 3] - y0) / len
      for (; s < Math.min(run + len, s1); s += 6.5) {
        const f = s - run
        for (const side of [-1, 1]) { // right of a → b (side -1) faces a → b; the left side the other way, unless one-way
          const x = x0 + ex * f - ey * off * side, y = y0 + ey * f + ex * off * side
          const d = side < 0 || L.oneway ? 1 : -1
          if (!inside(x, y) || rnd01(x, y) > 0.5 || nearStop(x, y) || built(x, y) || !room(x, y, ex * d, ey * d)) continue
          car(kerb, x, y, ex * d, ey * d)
        }
      }
      run += len
    }
  }
  return { lot: lot.length ? new Float32Array(lot) : null, kerb: kerb.length ? new Float32Array(kerb) : null }
}

// ---------------------------------------------------------------- lights at night (lights.js draws them)
// Street lamps: OpenStreetMap's where mapped, else along the streets, the sides taking turns, on the sidewalk 1.2 m
// past the kerb: brighter and closer together on the bigger streets (not where a mapped lamp stands within 14 m, nor
// out where no building stands within ~50 m: the farms and the parks stay dark; motorways and arterials are lit); and
// the storefronts' spill.
// -> { pos: tile-local x, height, z, brightness per light, lamps first; lamps: how many }
const ARM = 1.8 // a single-arm street light's reach over the road (its pool and head are there)
const LAMP = [[1, 18], [1, 18], [1, 18], [0.85, 20], [0.85, 22], [0.75, 34], null, [0.75, 34], [0.7, 24]] // brightness, step by kind (to pedestrian)
// a pole's foot off the carriageways (R: roadMask, 1 m; the cells round it too): where it is, else the nearest spot
// within 4 m that is, else null (a lamp on a street's far kerb, a mapped lamp on a junction's corner)
function offRoad(R, x, y, ok = () => true) { // (ok: and wherever else it may stand)
  const on = (x, y) => { if (R) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (onMask(R, x + a, y + b)) return true; return !ok(x, y) }
  if (!on(x, y)) return [x, y]
  for (let r = 1; r <= 4; r++) for (let k = 0; k < 16; k++) { const px = x + r * Math.cos(k * Math.PI / 8), py = y + r * Math.sin(k * Math.PI / 8); if (!on(px, py)) return [px, py] }
  return null
}
function lights(t, terr, lines, ps, b, R, S) {
  const clear = (x, y) => !S || S.free(x, y, 0.3) // (off the buildings, the trunks, the poles already up)
  const size = t.size, G = 25, gn = Math.ceil(size / G), built = new Uint8Array(gn * gn), mapped = new Map()
  const cell = (x, y) => Math.floor(y / G) * gn + Math.floor(x / G)
  const fpp = b.footprints?.pts
  if (fpp) for (let i = 0; i < fpp.length; i += 2) { const x = fpp[i] - t.ox, y = fpp[i + 1] - t.oy; if (x >= 0 && y >= 0 && x < size && y < size) built[cell(x, y)] = 1 }
  const near = (x, y) => { const i = Math.floor(x / G), j = Math.floor(y / G); for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) { const a = i + di, c = j + dj; if (a >= 0 && c >= 0 && a < gn && c < gn && built[c * gn + a]) return true } return false }
  const key = (x, y) => Math.floor(x / 14) * 100003 + Math.floor(y / 14)
  const pos = []
  const poles = [] // tile-local x, ground, z, the arm's heading (about +y from +x; NaN: a post-top lamp)
  for (const p of ps) if (p.kind === 3) { const f = offRoad(R, p.x - t.ox, p.y - t.oy, clear); if (!f) continue; const [x, y] = f; if (x < 0 || y < 0 || x >= size || y >= size) continue; const g = heightAt(terr, x, y); pos.push(x, g, -y, 0.8); poles.push(x, g, -y, NaN); mapped.set(key(x, y), 1); S?.addDisc(x, y, 0.15) }
  const taken = (x, y) => { for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (mapped.has(key(x + di * 14, y + dj * 14))) return true; return false }
  for (const L of lines) {
    const lit = LAMP[L.kind]
    if (!lit || L.layer < 0 || L.crossing) continue
    const P = L.pts, big = L.kind <= K.primary, [bright, step] = lit
    let s = L.a % step, k = 0, run = 0 // the same lamps whichever tile draws the street
    for (let i = 0; i < P.length / 2 - 1; i++) {
      const x0 = P[i * 2], y0 = P[i * 2 + 1], x1 = P[i * 2 + 2], y1 = P[i * 2 + 3], len = Math.hypot(x1 - x0, y1 - y0)
      if (len < 1e-3) continue
      const ex = (x1 - x0) / len, ey = (y1 - y0) / len
      for (; s < run + len; s += step, k++) {
        const f = (s - run) / len, side = k & 1 ? 1 : -1
        const cx = x0 + (x1 - x0) * f, cy = y0 + (y1 - y0) * f, up = L.z && L.z[i] + (L.z[i + 1] - L.z[i]) * f - heightAt(terr, cx, cy) > 1
        const off = L.w / 2 + (up && !L.band ? -0.4 : 1.2) // (up on a deck: on it, by its railing)
        const f_ = up ? [cx - ey * off * side, cy + ex * off * side] : offRoad(R, cx - ey * off * side, cy + ex * off * side, clear)
        if (!f_) continue
        const [x, y] = f_
        if (x < 0 || y < 0 || x >= size || y >= size || taken(x, y) || (!big && !near(x, y))) continue
        const z = up ? L.z[i] + (L.z[i + 1] - L.z[i]) * f : heightAt(terr, x, y), ax = ey * side, ay = -ex * side // the arm reaches over the kerb lane
        pos.push(x + ax * ARM, z, -(y + ay * ARM), bright); poles.push(x, z, -y, Math.atan2(ay, ax)); if (!up) S?.addDisc(x, y, 0.15)
      }
      run += len
    }
  }
  const lamps = pos.length / 4
  const sp = b.spill || []
  for (let i = 0; i < sp.length; i += 2) { const x = sp[i], y = sp[i + 1]; if (x >= 0 && y >= 0 && x < size && y < size) pos.push(x, heightAt(terr, x, y), -y, 1) }
  if (!pos.length) return null
  return { pos: new Float32Array(pos), lamps, poles: poles.length ? new Float32Array(poles) : null }
}
// the parked cars in the lots are footprints too (plugins bump into them; the kerbs' are left out, traffic passes them)
// more solid boxes on the footprints the walker and the van bump into: tile-local (x, north, angle, half length, half width) each
function withBoxes(fp, boxes, t) {
  if (!boxes.length) return fp
  const pts = fp ? [...fp.pts] : [], start = fp ? [...fp.start] : [0]
  for (const [bx, by, a, l, w] of boxes) {
    const x = bx + t.ox, y = by + t.oy, fx = Math.cos(a), fy = Math.sin(a)
    for (const [p, q] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) pts.push(x + fx * p * l + fy * q * w, y + fy * p * l - fx * q * w)
    start.push(pts.length)
  }
  return { pts: new Float32Array(pts), start: new Uint32Array(start) }
}
function withCars(fp, cars, t) {
  const boxes = []
  for (let i = 0; cars && i < cars.length; i += 5) boxes.push([cars[i], -cars[i + 2], cars[i + 3], CAR_L / 2, CAR_W / 2])
  return withBoxes(fp, boxes, t)
}
const ROOFW = (seed) => [0, 0, 999, seed]
// What stands on a flat roof, seen from the map's 30° (detail tiles, close zooms): small HVAC units the LiDAR's 2 m grid
// misses, as many as the roof is big (fewer on a planted roof or beside the plant the LiDAR saw); a mechanical
// penthouse on towers no LiDAR measured; rows of skylights on big commercial and industrial roofs; and from the
// bake (tools/tiles.py bits): a pool on its deck (8) and rows of solar panels (16). All in the roof's own frame,
// on the roof, not on each other; deterministic per building (gr).
function rooftop(B, pts, y, gr, o) {
  const { cx, cy, a, hl, hw } = obb(pts), ca = Math.cos(a), sa = Math.sin(a), ar = Math.abs(area(pts)), taken = []
  const at = (u, v) => [cx + ca * u - sa * v, cy + sa * u + ca * v]
  // a box su x sv at (u, v) in the roof's frame, if it is on the roof and clear of the others (pad m around them)
  const put = (u, v, su, sv, uh, col, pad = 0.6, top) => {
    if (taken.some((r) => Math.abs(r[0] - u) < (r[2] + su) / 2 + pad && Math.abs(r[1] - v) < (r[3] + sv) / 2 + pad)) return false
    for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const [x, yy] = at(u + du * (su / 2 + 0.4), v + dv * (sv / 2 + 0.4)); if (!inPoly(x, yy, pts)) return false }
    const [x, yN] = at(u, v)
    box3(B, x, yN, y, su, sv, uh, a, col, top)
    taken.push([u, v, su, sv])
    return true
  }
  if (o.bits & 8 && hl > 6 && hw > 4) { // a pool on its deck
    const L = Math.min(hl * 0.6, 12), Wd = Math.min(hw * 0.45, 5), u = (gr() - 0.5) * (hl - L) , v = (gr() - 0.5) * (hw - Wd)
    if (put(u, v, L + 2.4, Wd + 2.4, 0.12, [0.72, 0.7, 0.66], 0.6)) box3(B, ...at(u, v), y + 0.12, L, Wd, 0.06, a, [0.3, 0.6, 0.7], [13, 0, 999, 0.5])
  }
  if (o.bits & 16) for (let v = -hw + 1.6; v < hw - 1.6; v += 2.3) { // solar panels in rows
    const L = 2 * hl - 3.2, top = (s, t) => [14, s, t, 0.5]
    if (L > 3) put(0, v, L, 1.2, 0.35, [0.1, 0.12, 0.2], 0.4, top)
  }
  if (o.tower && !o.plant && ar > 250) { const su = Math.min(hl, 14), sv = Math.min(hw, 9); put((gr() - 0.5) * (hl - su), (gr() - 0.5) * (hw - sv), su, sv, 3.2, shade(o.wall, 0.9), 0.8) }
  if (o.shed && !o.green && ar > 400) for (let u = -hl + 4; u < hl - 4; u += 6) for (let v = -hw + 4; v < hw - 4; v += 8) put(u, v, 1.6, 3.2, 0.4, [0.5, 0.62, 0.7], 0.3)
  if (ar > 900 && !o.green) put((gr() - 0.5) * hl, (gr() - 0.5) * hw, 4 + gr() * 2, 2.4 + gr(), 1.7, [0.6, 0.62, 0.64], 1) // an air handler
  let n = Math.min(10, Math.max(1, Math.round(ar / 140)))
  if (o.green) n = Math.ceil(n / 3); else if (o.plant?.length) n = Math.ceil(n / 2)
  for (let tries = 0, got = 0; tries < n * 5 && got < n; tries++) { // in twos and threes, side by side
    const su = 1.4 + gr() * 1.8, sv = 1.1 + gr() * 1.2, uh = 0.8 + gr() * 0.8, g = gr() < 0.3 ? 0.42 : 0.62 + gr() * 0.12, col = [g, g * 1.01, g * 1.03]
    const u = (gr() * 2 - 1) * hl, v = (gr() * 2 - 1) * hw, k = gr() < 0.5 ? 1 : gr() < 0.5 ? 2 : 3
    if (!put(u, v, su, sv, uh, col)) continue
    for (let i = 1; i < k; i++) put(u + i * (su + 0.5), v, su, sv, uh, col, 0.2)
    got++
  }
}
// per point of a centre line (x, north pairs): the unit normal to its left, stretched to mitre the bends, and the
// unit tangent
function sides(P) {
  const n = P.length / 2, out = []
  for (let i = 0; i < n; i++) {
    const p = Math.max(0, i - 1), q = Math.min(n - 1, i + 1)
    let tx = P[q * 2] - P[p * 2], ty = P[q * 2 + 1] - P[p * 2 + 1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl
    let k = 1
    if (i > 0 && i < n - 1) { const ax = P[i * 2] - P[i * 2 - 2], ay = P[i * 2 + 1] - P[i * 2 - 1], al = Math.hypot(ax, ay) || 1; k = 1 / Math.max(0.5, Math.abs((ay * ty + ax * tx) / al)) }
    out.push([-ty * k, tx * k, tx, ty])
  }
  return out
}
// railings along the raised decks' edges (bridges, viaducts, guideways, footbridges and their stairs, roads on roofs):
// a concrete parapet on road decks (0.9 m) and guideways (0.7 m), on foot and cycle decks a curb and a 1.2 m railing,
// its posts and bars drawn by materials.js (pattern 12) on one sheet a side in the balcony mesh (close views and the
// high tier: the map and the low tier see the curb). Not where the deck is down at the ground nor where another deck
// runs alongside (a sidewalk deck, the other carriageway). At the deck's edge: its strip (L.w / 2, + 2 m of sidewalk with
// a band), where the drive plugin's van and walker stop (railAt there)
const PARAPET = lin(0xbcb8ae), RAILING = lin(0x8a9096)
const railAt = (L) => L.w / 2 + (L.band ? 2 : 0) // metres from the centre line (the drive plugin's railAt)
function railings(W, Bal, lines, terr) {
  const decks = lines.filter((L) => L.z && !L.tunnel && !L.roof && (L.kind <= K.track || L.kind === K.rail || L.kind === K.lightrail))
  if (!decks.length) return
  const C = 16, grid = new Map(), segs = [] // deck centre-line segments by 16 m cell
  for (const L of decks) for (let i = 0; i < L.pts.length / 2 - 1; i++) {
    const s = [L.pts[i * 2], L.pts[i * 2 + 1], L.pts[i * 2 + 2], L.pts[i * 2 + 3], L.z[i], L.z[i + 1], railAt(L), L]; segs.push(s)
    for (let a = Math.floor((Math.min(s[0], s[2]) - s[6]) / C); a <= Math.floor((Math.max(s[0], s[2]) + s[6]) / C); a++)
      for (let b = Math.floor((Math.min(s[1], s[3]) - s[6]) / C); b <= Math.floor((Math.max(s[1], s[3]) + s[6]) / C); b++) {
        const k = a * 65536 + b; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(s)
      }
  }
  const beside = (x, y, h, L) => { // inside another deck's edge, at about this height
    for (const s of grid.get(Math.floor(x / C) * 65536 + Math.floor(y / C)) || []) {
      if (s[7] === L) continue
      const dx = s[2] - s[0], dy = s[3] - s[1], u = Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / (dx * dx + dy * dy || 1)))
      if (Math.hypot(x - s[0] - dx * u, y - s[1] - dy * u) < s[6] + 0.8 && Math.abs(s[4] + (s[5] - s[4]) * u - h) < 2.5) return true
    }
    return false
  }
  for (const L of decks) {
    const P = L.pts, z = L.z, n = P.length / 2, side = sides(P), R = railAt(L), foot = L.kind >= K.pedestrian && L.kind <= K.track
    const ph = foot ? 0.15 : L.kind === K.rail || L.kind === K.lightrail ? 0.7 : 0.9, T = 0.25, top = 0.36
    for (const sg of [1, -1]) {
      const at = (i, off, y) => [P[i * 2] + side[i][0] * sg * off, y, -(P[i * 2 + 1] + side[i][1] * sg * off)]
      const ok = []
      for (let i = 0; i < n; i++) {
        const x = P[i * 2] + side[i][0] * sg * (R + T / 2), y = P[i * 2 + 1] + side[i][1] * sg * (R + T / 2)
        ok.push(z[i] - heightAt(terr, x, y) > 1 && !beside(x, y, z[i], L))
      }
      let u = 0
      for (let i = 0; i < n - 1; i++) {
        const j = i + 1, len = Math.hypot(P[j * 2] - P[i * 2], P[j * 2 + 1] - P[i * 2 + 1])
        u += len
        if (!ok[i] || !ok[j]) continue
        const nx = (side[i][0] + side[j][0]) * sg, nn = (side[i][1] + side[j][1]) * sg, l = Math.hypot(nx, nn) || 1, out = [nx / l, 0, -nn / l], inw = [-nx / l, 0, nn / l]
        const y0 = z[i] + top, y1 = z[j] + top, pw = ROOFW(0.5)
        quad(W, at(i, R + T, z[i] - 0.5), at(j, R + T, z[j] - 0.5), at(j, R + T, y1 + ph), at(i, R + T, y0 + ph), PARAPET, out, pw) // outer face, over the deck's edge
        quad(W, at(i, R, y0), at(j, R, y1), at(j, R, y1 + ph), at(i, R, y0 + ph), PARAPET, inw, pw)
        quad(W, at(i, R, y0 + ph), at(j, R, y1 + ph), at(j, R + T, y1 + ph), at(i, R + T, y0 + ph), shade(PARAPET, 1.06), [0, 1, 0], pw)
        if (!foot) continue
        const rw = (uu, h) => [12, uu, h, 0.5] // materials.js pattern 12: along, height over the deck
        for (const want of [out, inw]) quad(Bal, at(i, R + T / 2, y0 + ph), at(j, R + T / 2, y1 + ph), at(j, R + T / 2, y1 + 1.2), at(i, R + T / 2, y0 + 1.2), RAILING, want, rw(u - len, ph), rw(u, ph), rw(u, 1.2), rw(u - len, 1.2))
      }
    }
  }
}
// tunnels (tools/tiles.py tunnel_profiles): a dark tube round the road all the way (seen from both sides, so a chase
// camera that swings out of it on a bend sees its walls), and where the bake cut the ground near a portal its concrete
// box, roof flush with the ground, and at the portal a face with the opening in it
const TUBE_H = (kind) => (kind === K.rail || kind === K.lightrail ? 6 : kind >= K.pedestrian ? 3 : 5), SLAB = 0.6 // tools/tiles.py tube_h, SLAB
const TUBE_IN = lin(0x38393c), TUBE_FLOOR = lin(0x2e3033), CONCRETE = lin(0xb4b0a6)
function tubes(W, lines) {
  const pw = ROOFW(0.5)
  for (const L of lines) {
    if (!L.tunnel || !L.z || !L.tube) continue
    const P = L.pts, z = L.z, n = P.length / 2, H = TUBE_H(L.kind), hw = L.w / 2 + 0.6, ho = hw + SLAB, side = sides(P)
    const at = (i, off, y) => [P[i * 2] + side[i][0] * off, y, -(P[i * 2 + 1] + side[i][1] * off)]
    const both = (a, b, c, d, col, want) => { quad(W, a, b, c, d, col, want, pw); quad(W, a, b, c, d, col, want.map((v) => -v), pw) }
    for (let i = 0; i < n - 1; i++) {
      const j = i + 1, nx = side[i][0] + side[j][0], nn = side[i][1] + side[j][1], l = Math.hypot(nx, nn) || 1
      for (const sg of [1, -1]) both(at(i, sg * hw, z[i]), at(j, sg * hw, z[j]), at(j, sg * hw, z[j] + H), at(i, sg * hw, z[i] + H), TUBE_IN, [(sg * nx) / l, 0, (-sg * nn) / l])
      both(at(i, -hw, z[i] + H), at(j, -hw, z[j] + H), at(j, hw, z[j] + H), at(i, hw, z[i] + H), TUBE_IN, [0, -1, 0])
      quad(W, at(i, -hw, z[i] + 0.25), at(j, -hw, z[j] + 0.25), at(j, hw, z[j] + 0.25), at(i, hw, z[i] + 0.25), TUBE_FLOOR, [0, 1, 0], pw)
      if (!L.tube[i] && !L.tube[j]) continue
      for (const sg of [1, -1]) quad(W, at(i, sg * ho, z[i] - 0.5), at(j, sg * ho, z[j] - 0.5), at(j, sg * ho, z[j] + H + SLAB), at(i, sg * ho, z[i] + H + SLAB), CONCRETE, [(sg * nx) / l, 0, (-sg * nn) / l], pw)
      quad(W, at(i, -ho, z[i] + H + SLAB), at(j, -ho, z[j] + H + SLAB), at(j, ho, z[j] + H + SLAB), at(i, ho, z[i] + H + SLAB), CONCRETE, [0, 1, 0], pw)
    }
    for (const i of [0, n - 1]) { // the portal: pillars either side of the opening, a headwall over it
      if (L.tube[i] !== 2) continue
      const [, , tx, ty] = side[i], out = i ? 1 : -1, a = Math.atan2(ty, tx), x = P[i * 2] + tx * out * 0.2, y = P[i * 2 + 1] + ty * out * 0.2
      for (const sg of [1, -1]) box3(W, x + side[i][0] * sg * (hw + SLAB / 2), y + side[i][1] * sg * (hw + SLAB / 2), z[i] - 0.5, 0.8, SLAB, H + 0.5, a, CONCRETE)
      box3(W, x, y, z[i] + H, 0.8, 2 * ho + 1, SLAB + 0.9, a, CONCRETE)
    }
  }
}
// a wall facing (east, north) is in one of the octants (bit 0 east, 2 north, ...) or next to one: footprints get
// simplified and inset after their facing was measured
function faces(mask, e, n) {
  const k = (((Math.round(Math.atan2(n, e) / (Math.PI / 4)) % 8) + 8) % 8)
  return !!(mask & (1 << k) || mask & (1 << ((k + 1) & 7)) || mask & (1 << ((k + 7) & 7)))
}
function pack(B) {
  return { position: new Float32Array(B.pos), normal: new Int8Array(B.nor), color: new Uint8Array(B.col), aWin: new Float32Array(B.win), aFac: new Uint8Array(B.fac) }
}
// the wall look (tools/lidar_walls.py's 4 bytes) the triangles being added carry: materials.js aFac
const NOFAC = [0, 0, 0, 0]
let FAC = NOFAC
// one triangle with a flat normal, wound so the normal points along `want`; w = aWin per vertex (or one for all)
function tri(B, a, b, c, col, want, w, w2, w3) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  const l = Math.hypot(...n) || 1; n = n.map((v) => v / l)
  let ws = [w, w2 || w, w3 || w]
  if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) { [b, c] = [c, b]; n = n.map((v) => -v); ws = [ws[0], ws[2], ws[1]] }
  for (const p of [a, b, c]) { B.pos.push(p[0], p[1], p[2]); B.nor.push(n[0] * 127, n[1] * 127, n[2] * 127); B.col.push(col[0] * 255, col[1] * 255, col[2] * 255); B.fac.push(FAC[0], FAC[1], FAC[2], FAC[3]) }
  for (const x of ws) B.win.push(...x)
}
function quad(B, a, b, c, d, col, want, wa, wb, wc, wd) {
  if (!wb) { wb = wc = wd = wa }
  tri(B, a, b, c, col, want, wa, wb, wc); tri(B, a, c, d, col, want, wa, wc, wd)
}
// pitched roofs over the footprint's rectangle: gable (ridge along the long side, or across it with bit 16), hipped,
// pyramidal, shed (high side flipped with bit 32), domes
function roof(W, pts, y1, yr, shape, bits, rc, wall, seed) {
  const o = obb(pts), O = 0.45
  let { cx, cy, a, hl, hw } = o
  a = ((a % Math.PI) + Math.PI) % Math.PI // the same frame as tools/tiles.py fit_roof, so "+v" means the same side
  if (bits & 16) { a += Math.PI / 2; [hl, hw] = [hw, hl] }
  const ax = [Math.cos(a), Math.sin(a)], bx = [-Math.sin(a), Math.cos(a)]
  const at = (s, t, y) => [cx + ax[0] * s + bx[0] * t, y, -(cy + ax[1] * s + bx[1] * t)]
  const L = hl + O, Wd = hw + O, pw = ROOFW(seed), endC = shade(wall, 0.92)
  if (shape === 4 || shape === 6) { // dome: a few rings
    const R = Math.min(hl, hw), steps = 6, seg = 16
    for (let k = 0; k < steps; k++) {
      const a0 = (k / steps) * Math.PI / 2, a1 = ((k + 1) / steps) * Math.PI / 2
      for (let q = 0; q < seg; q++) {
        const t0 = (q / seg) * Math.PI * 2, t1 = ((q + 1) / seg) * Math.PI * 2
        const P = (al, th) => [cx + Math.cos(th) * Math.cos(al) * R, y1 + Math.sin(al) * (yr - y1), -(cy + Math.sin(th) * Math.cos(al) * R)]
        quad(W, P(a0, t0), P(a0, t1), P(a1, t1), P(a1, t0), rc, [Math.cos((t0 + t1) / 2), 0.6, -Math.sin((t0 + t1) / 2)], pw)
      }
    }
    return
  }
  if (shape === 5) { // shed: one plane from the low eaves (y1) to the high edge (yr), walls under the high side
    const sg = (bits & 32 ? 1 : -1) * (bits & 16 ? -1 : 1), yw = yr - ((yr - y1) * O) / (2 * Wd) // the plane's height above the wall line
    quad(W, at(-L, -sg * Wd, y1 - ((yr - y1) * O) / (2 * Wd)), at(L, -sg * Wd, y1 - ((yr - y1) * O) / (2 * Wd)), at(L, sg * Wd, yr), at(-L, sg * Wd, yr), rc, [-bx[0] * sg, 1, bx[1] * sg], pw)
    quad(W, at(-hl, sg * hw, y1), at(hl, sg * hw, y1), at(hl, sg * hw, yw), at(-hl, sg * hw, yw), endC, [bx[0] * sg, 0, -bx[1] * sg], pw)
    for (const s of [1, -1]) tri(W, at(s * hl, -sg * hw, y1), at(s * hl, sg * hw, y1), at(s * hl, sg * hw, yw), endC, [ax[0] * s, 0, -ax[1] * s], pw)
    return
  }
  const gable = shape === 1
  const r = gable ? L : shape === 3 ? 0.01 : Math.max(0.01, L - Wd)
  for (const s of [1, -1]) {
    const side = [bx[0] * s, 1, -bx[1] * s]
    tri(W, at(-L, s * Wd, y1), at(L, s * Wd, y1), at(r, 0, yr), rc, side, pw)
    tri(W, at(-L, s * Wd, y1), at(r, 0, yr), at(-r, 0, yr), rc, side, pw)
    const end = [ax[0] * s, 0, -ax[1] * s]
    if (gable) tri(W, at(s * hl, Wd, y1), at(s * hl, -Wd, y1), at(s * hl, 0, yr), endC, end, pw)
    else tri(W, at(s * L, Wd, y1), at(s * L, -Wd, y1), at(s * r, 0, yr), rc, [end[0], 1, end[2]], pw)
  }
}
// a box standing on a roof at y, centred on (x, y north), su along angle a, sv across it, uh tall; topW: the top's aWin,
// one for all corners or a function (along, across) of each corner
function box3(B, x, yN, y, su, sv, uh, a, col, topW) {
  const ca = Math.cos(a), sa = Math.sin(a), pw = ROOFW(0.5)
  const c = (s, t, h) => [x + ca * s - sa * t, y + h, -(yN + sa * s + ca * t)]
  const u = su / 2, v = sv / 2, top = shade(col, 1.08), tw = typeof topW === 'function' ? topW : () => topW || pw
  quad(B, c(-u, -v, uh), c(u, -v, uh), c(u, v, uh), c(-u, v, uh), top, [0, 1, 0], tw(-u, -v), tw(u, -v), tw(u, v), tw(-u, v))
  quad(B, c(-u, -v, 0), c(u, -v, 0), c(u, -v, uh), c(-u, -v, uh), col, [sa, 0, ca], pw)
  quad(B, c(u, v, 0), c(-u, v, 0), c(-u, v, uh), c(u, v, uh), col, [-sa, 0, -ca], pw)
  quad(B, c(u, -v, 0), c(u, v, 0), c(u, v, uh), c(u, -v, uh), shade(col, 0.92), [ca, 0, -sa], pw)
  quad(B, c(-u, v, 0), c(-u, -v, 0), c(-u, -v, uh), c(-u, v, uh), shade(col, 0.92), [-ca, 0, sa], pw)
}
function obb(pts) {
  let best = null
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length], a = Math.atan2(q[1] - p[1], q[0] - p[0]), ca = Math.cos(a), sa = Math.sin(a)
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
    for (const [x, y] of pts) { const u = x * ca + y * sa, v = -x * sa + y * ca; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v) }
    const ar = (u1 - u0) * (v1 - v0)
    if (!best || ar < best.ar) best = { ar, a, u0, u1, v0, v1 }
  }
  const { a, u0, u1, v0, v1 } = best, uc = (u0 + u1) / 2, vc = (v0 + v1) / 2
  let hl = (u1 - u0) / 2, hw = (v1 - v0) / 2, ang = a
  if (hw > hl) { [hl, hw] = [hw, hl]; ang += Math.PI / 2 }
  return { cx: uc * Math.cos(a) - vc * Math.sin(a), cy: uc * Math.sin(a) + vc * Math.cos(a), a: ang, hl, hw }
}
function offset(pts, D) {
  const n = pts.length
  return pts.map((p, i) => {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n]
    let n1 = [p[1] - a[1], -(p[0] - a[0])], n2 = [b[1] - p[1], -(b[0] - p[0])]
    const l1 = Math.hypot(...n1) || 1, l2 = Math.hypot(...n2) || 1
    n1 = [n1[0] / l1, n1[1] / l1]; n2 = [n2[0] / l2, n2[1] / l2]
    let m = [n1[0] + n2[0], n1[1] + n2[1]]; const ml = Math.hypot(...m)
    if (ml < 1e-6) return [p[0] + n1[0] * D, p[1] + n1[1] * D]
    m = [m[0] / ml, m[1] / ml]
    const k = Math.min(D * 2.5, D / Math.max(0.3, m[0] * n1[0] + m[1] * n1[1]))
    return [p[0] + m[0] * k, p[1] + m[1] * k]
  })
}
const area = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1] } return s / 2 }
const bbox = (p) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) } return [x0, y0, x1, y1] }
// small ear-clipping triangulator for building roofs (simple polygons, counter-clockwise)
function earcut2(pts) {
  const n = pts.length, V = [...Array(n).keys()], out = []
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  let guard = 0
  while (V.length > 3 && guard++ < n * n) {
    let cut = false
    for (let i = 0; i < V.length; i++) {
      const ia = V[(i + V.length - 1) % V.length], ib = V[i], ic = V[(i + 1) % V.length]
      const a = pts[ia], b = pts[ib], c = pts[ic]
      if (cross(a, b, c) <= 1e-9) continue
      let inside = false
      for (const j of V) {
        if (j === ia || j === ib || j === ic) continue
        const p = pts[j]
        if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) { inside = true; break }
      }
      if (inside) continue
      out.push(ia, ib, ic); V.splice(i, 1); cut = true; break
    }
    if (!cut) break
  }
  if (V.length === 3) out.push(V[0], V[1], V[2])
  else if (V.length > 3) for (let i = 1; i < V.length - 1; i++) out.push(V[0], V[i], V[i + 1]) // give up gracefully: a fan
  return out
}

// points: kind (0 traffic signals, 1 crossing, 2 stop sign, 3 street lamp, 4 bench, 5 bus stop, 6 give way),
// OSM node id (signals sit on the junction node, so it matches graph piece ends), world x, north
function pois(t) {
  const s = t.sections.POIS
  if (!s) return []
  const dv = t.dv, n = dv.getUint32(s.off, true), out = []
  let o = s.off + 4
  for (let i = 0; i < n; i++) { out.push({ kind: dv.getUint8(o), id: Number(dv.getBigUint64(o + 1, true)), x: dv.getInt16(o + 9, true) * t.k + t.ox, y: dv.getInt16(o + 11, true) * t.k + t.oy }); o += 13 }
  return out
}

// ---------------------------------------------------------------- shop signs
// the SHOP section (tools/tiles.py: named businesses: kind 0 shop, 1 cafe, 2 food, 3 bar, 4 service, 5 office/craft, x, north, name),
// each put on the nearest street-facing storefront wall within 10 m, no two within 3 m of each other
// -> { d: 8 floats a sign (tile-local x, north, height above ground, outward x, outward north, width, kind | style << 3, name index), names } or null
const SIGN_Z = 3.4
function signs(t, fronts) {
  const s = t.sections.SHOP
  if (!s || !fronts.length) return null
  const dv = t.dv, n = dv.getUint32(s.off, true), d = [], names = [], at = []
  let o = s.off + 4
  for (let i = 0; i < n; i++) {
    const kind = dv.getUint8(o), x = dv.getInt16(o + 1, true) * t.k, y = dv.getInt16(o + 3, true) * t.k, ln = dv.getUint8(o + 5)
    const name = new TextDecoder().decode(new Uint8Array(t.buf, o + 6, ln)); o += 6 + ln
    let best = 100, e = -1, f = 0
    for (let j = 0; j < fronts.length; j += 5) {
      const ax = fronts[j], ay = fronts[j + 1], dx = fronts[j + 2] - ax, dy = fronts[j + 3] - ay, l2 = dx * dx + dy * dy
      if (l2 < 9) continue
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)), q = (x - ax - dx * u) ** 2 + (y - ay - dy * u) ** 2
      if (q < best) { best = q; e = j; f = u }
    }
    if (e < 0) continue
    const ax = fronts[e], ay = fronts[e + 1], dx = fronts[e + 2] - ax, dy = fronts[e + 3] - ay, len = Math.hypot(dx, dy)
    const w = Math.min(len - 0.6, 2.2 + name.length * 0.28, 6.5), half = w / 2 / len
    f = Math.max(half, Math.min(1 - half, f)) // the board stays on the wall
    const px = ax + dx * f, py = ay + dy * f
    if (at.some((q) => (q[0] - px) ** 2 + (q[1] - py) ** 2 < 9)) continue
    at.push([px, py])
    let h = 0; for (let c = 0; c < name.length; c++) h = (h * 31 + name.charCodeAt(c)) >>> 0
    d.push(px, py, fronts[e + 4] + SIGN_Z, dy / len, -dx / len, w, kind | ((kind === 1 ? 3 : h % 3) << 3), names.length)
    names.push(name)
  }
  return d.length ? { d: new Float32Array(d), names } : null
}

// ---------------------------------------------------------------- boats at their berths (marinas)
// -> 6 floats each: tile-local x, water level, z, heading (radians, from east towards north), length, kind (1 sail | colour << 1)
function boats(t, terr) {
  const s = t.sections.BOAT
  if (!s) return null
  const dv = t.dv, n = dv.getUint32(s.off, true)
  if (!n) return null
  const out = new Float32Array(n * 6)
  for (let i = 0, o = s.off + 4; i < n; i++, o += 7) {
    const x = dv.getInt16(o, true) * t.k, y = dv.getInt16(o + 2, true) * t.k
    out.set([x, Math.max(0, heightAt(terr, x, y)), -y, (dv.getUint8(o + 4) / 256) * Math.PI * 2, dv.getUint8(o + 5) / 10, dv.getUint8(o + 6)], i * 6)
  }
  return out
}

// ---------------------------------------------------------------- the beaches: driftwood logs, lifeguard towers, volleyball nets
// the LOGS section (tools/tiles.py beach_bits: x, north, angle 1/256 turn, length 1/10 m, diameter 1/100 m, kind: 0-7 a
// log, +4 with a root ball; 16 a lifeguard tower; 17 a net) -> { d: 8 floats each (tile-local x, height of the ground
// under its middle, z, angle (from east towards north), length, diameter, kind, rise from end to end), solid: boxes } or null
function beach(t, terr) {
  const s = t.sections.LOGS
  if (!s) return null
  const dv = t.dv, n = dv.getUint32(s.off, true), d = new Float32Array(n * 8), solid = []
  for (let i = 0, o = s.off + 4; i < n; i++, o += 8) {
    const x = dv.getInt16(o, true) * t.k, y = dv.getInt16(o + 2, true) * t.k, a = (dv.getUint8(o + 4) / 256) * Math.PI * 2
    const len = dv.getUint8(o + 5) / 10, dia = dv.getUint8(o + 6) / 100, kind = dv.getUint8(o + 7), ex = (Math.cos(a) * len) / 2, ey = (Math.sin(a) * len) / 2
    const h0 = heightAt(terr, x - ex, y - ey), h1 = heightAt(terr, x + ex, y + ey)
    d.set([x, Math.max(0, kind < 16 ? (h0 + h1) / 2 : heightAt(terr, x, y)), -y, a, len, dia, kind, kind < 16 ? h1 - h0 : 0], i * 8)
    if (kind < 16) solid.push([x, y, a, len / 2, dia / 2])
    else if (kind === 16) solid.push([x, y, a, 1.1, 1.1])
  }
  return n ? { d, solid } : null
}

// ---------------------------------------------------------------- trees
function trees(t, terr) {
  const s = t.sections.TREE
  if (!s) return null
  const dv = t.dv
  let o = s.off
  const n = dv.getUint32(o, true); o += 4
  if (!n) return null
  const pos = new Float32Array(n * 3), info = new Float32Array(n * 4) // shape, colour family, height, seed
  for (let i = 0; i < n; i++) {
    const x = dv.getInt16(o, true) * t.k, y = dv.getInt16(o + 2, true) * t.k, shape = dv.getUint8(o + 4), col = dv.getUint8(o + 5), h = dv.getUint8(o + 6) / 4
    o += 7
    pos[i * 3] = x; pos[i * 3 + 1] = heightAt(terr, x, y); pos[i * 3 + 2] = -y
    info[i * 4] = shape; info[i * 4 + 1] = col; info[i * 4 + 2] = h; info[i * 4 + 3] = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1
  }
  return { pos, info }
}

export { parse, build, readLines, pois, carEnds, crosswalks, onCarriage, roadMask, terrain, roads, eachPoly } // for tools/crosswalk_check.mjs, drive_check.mjs, deck_check.mjs, drawn_check.mjs
