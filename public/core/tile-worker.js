// Turns a streamed map tile (tools/tiles.py) into ready-to-draw geometry buffers, off the page's thread.
// Coordinates in the buffers are local to the tile: x east, y up, z south, metres from the tile's SW corner.
import earcut from '../vendor/earcut.js'
const GROUND_LIFT = 0 // the ground is one non-overlapping layer (tools/tiles.py), so no class needs lifting
const KIND = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living', 'pedestrian', 'footway', 'cycleway',
  'path', 'steps', 'track', 'rail', 'lightrail', 'runway', 'taxiway']
const K = Object.fromEntries(KIND.map((k, i) => [k, i]))

let MASKS = [] // world-metre rings where plugins draw their own buildings (landmarks): generic ones are skipped
onmessage = async ({ data }) => {
  if (data.masks) { MASKS = data.masks.map((r) => ({ r, bb: bbox(r) })); return }
  const { id, url, level } = data
  try {
    const r = await fetch(url)
    if (r.status === 404) return postMessage({ id, missing: true })
    if (!r.ok) throw new Error(`${url}: ${r.status}`)
    const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    const t = parse(buf)
    const out = build(t, level)
    for (const g of [out.ground, out.roads, out.paint, out.buildings, out.balconies]) if (g?.position) g.box = box(g.position)
    postMessage({ id, ...out }, transferables(out))
  } catch (e) { postMessage({ id, error: String(e) }) }
}

// bounds of a position buffer, so the page doesn't loop over it (min x, y, z, max x, y, z)
function box(p) {
  const b = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { const v = p[i + k]; if (v < b[k]) b[k] = v; if (v > b[k + 3]) b[k + 3] = v }
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
  const rd = roads(t, terr, lines, level)
  out.roads = rd.surf; out.paint = rd.paint
  out.graph = graph(t, lines)
  out.graph.pois = pois(t)
  const b = buildings(t, terr, level)
  out.buildings = b.walls; out.balconies = b.balconies; out.units = b.units
  if (level === 0) { out.footprints = b.footprints; out.water = water(t) }
  out.trees = trees(t, terr)
  return out
}

function terrain(t) {
  const s = t.sections.TERR, n = t.dv.getUint16(s.off, true)
  const h = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) h[i] = t.dv.getInt16(s.off + 2 + i * 2, true) / 10
  return { n, h, size: t.size } // row 0 = north
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
function heightAt(terr, x, y) { // tile-local metres, y north
  const { n, h, size } = terr, c = size / (n - 1)
  const fx = Math.min(n - 1.0001, Math.max(0, x / c)), fy = Math.min(n - 1.0001, Math.max(0, (size - y) / c))
  const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j
  return h[j * n + i] * (1 - u) * (1 - v) + h[j * n + i + 1] * u * (1 - v) + h[(j + 1) * n + i] * (1 - u) * v + h[(j + 1) * n + i + 1] * u * v
}

// ground: polygons per class, triangulated here and draped over the terrain (long edges split on slopes)
function ground(t, terr, level) {
  const s = t.sections.GRND
  if (!s) return null
  const dv = t.dv
  let o = s.off
  const runs = dv.getUint16(o, true); o += 2
  const pos = [], cls = [], idx = []
  const seen = new Map() // shared vertices: one per (point, class), so each tile uploads about a third as much
  const vert = (x, y, c, lift) => {
    const key = Math.round(x * 50) * 1e7 + Math.round(y * 50) + c * 1e14
    let i = seen.get(key)
    if (i === undefined) { i = pos.length / 3; seen.set(key, i); pos.push(x, heightAt(terr, x, y) + lift, -y); cls.push(c) }
    return i
  }
  let hmin = Infinity, hmax = -Infinity
  for (const v of terr.h) { hmin = Math.min(hmin, v); hmax = Math.max(hmax, v) }
  const maxEdge = hmax - hmin < 2 ? Infinity : t.size / (terr.n - 1) // one terrain cell
  for (let r = 0; r < runs; r++) {
    const c = dv.getUint8(o), np = dv.getUint32(o + 1, true); o += 5
    const lift = c * GROUND_LIFT + 0.02
    for (let p = 0; p < np; p++) {
      const nr = dv.getUint16(o, true); o += 2
      const flat = [], holes = []
      for (let k = 0; k < nr; k++) {
        const [pts, o2] = readRing(t, o); o = o2
        if (k) holes.push(flat.length / 2)
        for (const v of pts) flat.push(v)
      }
      const tri = earcut(flat, holes)
      const emit = (ax, ay, bx, by, cx, cy, depth) => { // split long triangles so the ground follows the hills
        const ab = Math.hypot(bx - ax, by - ay), bc = Math.hypot(cx - bx, cy - by), ca = Math.hypot(ax - cx, ay - cy), m = Math.max(ab, bc, ca)
        if (m > maxEdge && depth < 20) {
          if (m === ab) { const mx = (ax + bx) / 2, my = (ay + by) / 2; emit(ax, ay, mx, my, cx, cy, depth + 1); emit(mx, my, bx, by, cx, cy, depth + 1) }
          else if (m === bc) { const mx = (bx + cx) / 2, my = (by + cy) / 2; emit(ax, ay, bx, by, mx, my, depth + 1); emit(ax, ay, mx, my, cx, cy, depth + 1) }
          else { const mx = (cx + ax) / 2, my = (cy + ay) / 2; emit(ax, ay, bx, by, mx, my, depth + 1); emit(mx, my, bx, by, cx, cy, depth + 1) }
          return
        }
        const va = vert(ax, ay, c, lift), vb = vert(bx, by, c, lift), vc = vert(cx, cy, c, lift)
        // face up: earcut keeps the ring's winding; pick the order whose normal points +y
        const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        if (cross > 0) idx.push(va, vb, vc); else idx.push(va, vc, vb)
      }
      for (let i = 0; i < tri.length; i += 3) {
        const a = tri[i] * 2, b = tri[i + 1] * 2, d = tri[i + 2] * 2
        emit(flat[a], flat[a + 1], flat[b], flat[b + 1], flat[d], flat[d + 1], 0)
      }
    }
  }
  const nv = pos.length / 3
  if (!nv) return null
  const P = new Float32Array(pos)
  return { position: P, normal: normals(terr, P), cls: new Uint8Array(cls), index: nv > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) }
}

// detail tiles: a WATER_N x WATER_N mask (1 = water), cell (i east, j north) from the tile's SW corner
const WATER_N = 256, WATER = 19 // GROUND class index of water (tools/tiles.py)
function water(t) {
  const s = t.sections.GRND
  if (!s) return null
  const dv = t.dv, n = WATER_N, c = t.size / n, mask = new Uint8Array(n * n)
  let o = s.off, any = false
  const runs = dv.getUint16(o, true); o += 2
  for (let r = 0; r < runs; r++) {
    const cls = dv.getUint8(o), np = dv.getUint32(o + 1, true); o += 5
    for (let p = 0; p < np; p++) {
      const nr = dv.getUint16(o, true); o += 2
      const flat = [], holes = []
      for (let k = 0; k < nr; k++) {
        const [pts, o2] = readRing(t, o); o = o2
        if (cls !== WATER) continue
        if (k) holes.push(flat.length / 2)
        for (const v of pts) flat.push(v)
      }
      if (cls !== WATER || !flat.length) continue
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
    }
  }
  return any ? { n, mask } : null
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
    out.push({ kind, lanes, oneway: !!(flags & 1), band: !!(flags & 2), drive: !!(flags & 8), crossing: !!(flags & 16), turns, layer, w, a, b, pts, z })
  }
  return out
}

// road surfaces as strips. Two layers: the "band" (sidewalks, boulevards, kerbs) under everything, then the
// carriageways on top, so a big road's sidewalk never covers a side street. Markings are drawn by the shader
// from per-vertex (along, across) coordinates; they fade out near junctions.
function roads(t, terr, lines, level) {
  // Road surfaces, sidewalks and paths are part of the ground (baked as non-overlapping polygons). Here: bridge
  // decks (full surfaces, raised on their LiDAR heights) and, as thin decals on the ground, the paint: lane lines,
  // stop lines, the crosswalks OpenStreetMap maps, and rails.
  const deg = new Map()
  for (const L of lines) for (const n of [L.a, L.b]) deg.set(n, (deg.get(n) || 0) + 1)
  const mk = () => ({ P: [], A: [], B: [], I: [], nv: 0 })
  const surf = mk(), paint = mk()
  const strip = (T, pts, zs, half, lift, kind, extra, w, junctionA, junctionB) => {
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
    let s = 0
    const cum = [0]
    for (let i = 1; i < m; i++) { s += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]); cum.push(s) }
    const len = s
    for (let i = 0; i < m; i++) {
      const p = Math.max(0, i - 1), q = Math.min(m - 1, i + 1)
      let tx = xs[q] - xs[p], ty = ys[q] - ys[p]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl
      let nx = -ty, ny = tx, k = 1
      if (i > 0 && i < m - 1) {
        let ax = xs[i] - xs[i - 1], ay = ys[i] - ys[i - 1]; const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al
        k = 1 / Math.max(0.5, Math.abs(-ay * nx + ax * ny))
      }
      for (const side of [-1, 1]) {
        const px = xs[i] + nx * half * k * side, py = ys[i] + ny * half * k * side
        const y = zz[i] ?? heightAt(terr, px, py) // decals follow the ground under each edge, not the centre line
        T.P.push(px, y + lift, -py)
        T.A.push(cum[i], side * half, w, kind)
        T.B.push(extra, junctionA ? cum[i] : 999, junctionB ? len - cum[i] : 999, len)
      }
      if (i) { const b = T.nv + (i - 1) * 2; T.I.push(b, b + 2, b + 1, b + 1, b + 2, b + 3) }
    }
    T.nv += m * 2
  }
  // bridge decks: a fascia on both sides and an underside, so a deck reads as a slab, not a ribbon
  const deck = (L) => {
    const T = surf, pts = L.pts, zs = L.z, m = pts.length / 2, half = L.w / 2 + (L.band ? 2.5 : 0.6), th = L.kind <= K.tertiary ? 1.6 : 0.9
    for (let i = 0; i < m - 1; i++) {
      const x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[i * 2 + 2], y1 = pts[i * 2 + 3]
      const l = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / l, ny = (x1 - x0) / l
      for (const sd of [-1, 1]) {
        const ax = x0 + nx * half * sd, ay = y0 + ny * half * sd, bx = x1 + nx * half * sd, by = y1 + ny * half * sd
        const b = T.nv
        T.P.push(ax, zs[i] + 0.35, -ay, bx, zs[i + 1] + 0.35, -by, bx, zs[i + 1] - th, -by, ax, zs[i] - th, -ay)
        for (let k = 0; k < 4; k++) { T.A.push(0, half * sd, L.w, 101); T.B.push(0, 999, 999, l) }
        if (sd > 0) T.I.push(b, b + 1, b + 2, b, b + 2, b + 3); else T.I.push(b, b + 2, b + 1, b, b + 3, b + 2)
        T.nv += 4
      }
      const b = T.nv
      T.P.push(x0 - nx * half, zs[i] - th, -(y0 - ny * half), x1 - nx * half, zs[i + 1] - th, -(y1 - ny * half), x1 + nx * half, zs[i + 1] - th, -(y1 + ny * half), x0 + nx * half, zs[i] - th, -(y0 + ny * half))
      for (let k = 0; k < 4; k++) { T.A.push(0, 0, L.w, 101); T.B.push(0, 999, 999, l) }
      T.I.push(b, b + 1, b + 2, b, b + 2, b + 3); T.nv += 4
    }
  }
  const len = (L) => { let s = 0; for (let i = 0; i < L.pts.length / 2 - 1; i++) s += Math.hypot(L.pts[i * 2 + 2] - L.pts[i * 2], L.pts[i * 2 + 3] - L.pts[i * 2 + 1]); return s }
  const order = [...lines].sort((p, q) => q.kind - p.kind)
  for (const L of order) {
    const ja = (deg.get(L.a) || 0) >= 3, jb = (deg.get(L.b) || 0) >= 3
    if (L.z) { // bridges: the whole surface, raised
      if (L.kind > K.track && L.kind !== K.rail && L.kind !== K.lightrail) continue
      if (L.band) { const bl = L.kind === K.residential || L.kind === K.tertiary ? 0 : 0, walk = 2.0; strip(surf, L.pts, L.z, L.w / 2 + walk, 0.3, 100, bl * 256 + walk * 16, L.w, false, false) }
      strip(surf, L.pts, L.z, L.w / 2, 0.36 + (18 - L.kind) * 0.004, L.kind, L.lanes + (L.oneway ? 32 : 0), L.w, ja, jb)
      continue
    }
    if (level !== 0) continue // the overview shows surfaces only
    const l = len(L)
    if (L.kind <= K.living && (L.lanes >= 2 || L.kind <= K.trunk) && l > 12) {
      strip(paint, L.pts, null, L.w / 2, 0.05, L.kind, L.lanes + (L.oneway ? 32 : 0), L.w, ja && l > 30, jb && l > 30)
    } else if (L.crossing) {
      strip(paint, L.pts, null, Math.max(1.5, L.w / 2 + 0.4), 0.06, 102, 0, L.w, false, false) // zebra
    } else if (L.kind === K.rail || L.kind === K.lightrail) {
      strip(paint, L.pts, null, 1.3, 0.05, L.kind, 0, L.w, false, false)
    }
  }
  const pack = (T) => {
    if (!T.nv) return null
    const PP = new Float32Array(T.P)
    return { position: PP, normal: normals(terr, PP), aRoad: new Float32Array(T.A), aRoad2: new Float32Array(T.B), index: T.nv > 65535 ? new Uint32Array(T.I) : new Uint16Array(T.I) }
  }
  return { surf: pack(surf), paint: pack(paint) }
}

// drivable/walkable graph for plugins (traffic, people): pieces with global node ids and world points
function graph(t, lines) {
  const pieces = []
  for (const L of lines) {
    const pts = new Float32Array(L.pts.length)
    for (let i = 0; i < L.pts.length / 2; i++) { pts[i * 2] = L.pts[i * 2] + t.ox; pts[i * 2 + 1] = L.pts[i * 2 + 1] + t.oy }
    pieces.push({ kind: L.kind, lanes: L.lanes, oneway: L.oneway, drive: L.drive, band: L.band, turns: L.turns, w: L.w, a: L.a, b: L.b, pts, z: L.z })
  }
  return { pieces }
}

// ---------------------------------------------------------------- buildings
const PALETTES = [ // style ids from tools/tiles.py (HOUSE, APT, ...)
  // 0 house
  { wall: [0xf2efe6, 0xe8e0cc, 0xd9d2c3, 0xc9d6dc, 0xb8c8d4, 0xe6d6a8, 0xb8c8a8, 0xd8a890, 0xf0e8d8, 0xa8b8c4, 0xe0c8b0, 0x8fa4b4], roof: [0x4a4f55, 0x5f6366, 0x6e6a66, 0x7a5a48, 0x3e4349, 0x8c4a3a, 0x9a5038, 0x52606a, 0x6b4d3c] },
  // 1 apartments
  { wall: [0xf6f6f2, 0xf0f2f0, 0xe8eef0, 0xf2ece0, 0xeadcc0, 0xe4e6e6, 0xe8d0b0, 0xd8c8a8, 0xc8d0d4], roof: [0xc4c6c4, 0xb4b8b8, 0xd2d0ca, 0xa8acae, 0x5a6068, 0x6a7078] },
  // 2 office / glass
  { wall: [0xe6ecee, 0xd6e0e4, 0xc8d4dc, 0xf0f2f0, 0xb8c8d0], roof: [0xc4c6c4, 0xb4b8b8, 0x9ea4a8, 0x5a6068] },
  // 3 brick / heritage (Gastown, Chinatown, Yaletown warehouses: red and brown brick, a few painted)
  { wall: [0x8a4c3c, 0x7c4636, 0x925844, 0x744234, 0x9a6448, 0x845440, 0x7a5040, 0xb08a6a], roof: [0x6e5a50, 0x7c6a60, 0x4a4f55, 0x5a5e62] },
  // 4 commercial
  { wall: [0xc9c2b2, 0xd6cfbf, 0xb8b4aa, 0xe0d8c6, 0xb8c4cc, 0xd8d8d4, 0xc4a888, 0xa8b0b4], roof: [0xc4c6c4, 0xb4b8b8, 0xd2d0ca, 0xa8acae, 0x9ea4a8, 0x7c8288] },
  // 5 civic / white
  { wall: [0xf2f0ea, 0xeeeeea, 0xe4e6e6, 0xe8e0d0, 0xd8d0c0], roof: [0xbcbcb8, 0xc8c8c4, 0x6a8a7a, 0x5a6068] },
  // 6 glass condo tower: white and pale grey mullions and slab edges around blue-green glass
  { wall: [0xf4f6f4, 0xeef2f2, 0xe2e8ea, 0xf6f4ee, 0xd8e0e4], roof: [0xc8cac8, 0xbcc0c0, 0xd4d4d0] },
  // 7 concrete (West End towers, 1960s-70s offices, parkades)
  { wall: [0xc8c0b0, 0xbab4a8, 0xd2cab8, 0xaca8a0, 0xc4beb4, 0xd8ceb8, 0xb0b4b4], roof: [0xb8b8b4, 0xa8aaa8, 0xc4c4c0] },
  // 8 metal shed (warehouses, mills, port sheds)
  { wall: [0xb8bcbe, 0xa8b0b4, 0xc8c8c0, 0x8a98a4, 0xd0ccbc, 0x7c8c84, 0xc4b8a0, 0x9aa4ac], roof: [0xb0b4b6, 0xc0c4c4, 0xa0a8ac, 0xd8dad8, 0x8c949a] },
  // 9 big box / mall
  { wall: [0xd8d2c4, 0xe4e0d6, 0xc8c4bc, 0xd4ccbc, 0xe8e4dc], roof: [0xd8d8d4, 0xe0e0dc, 0xc8cac8] },
  // 10 stone
  { wall: [0xc8bca4, 0xb8ae98, 0xd4c8b0, 0xa8a090, 0xbcb4a4], roof: [0x5a6a64, 0x6a5a50, 0x4a4f55, 0x5a8a78] },
  // 11 character house: painted wood siding (deep greens, blues, greys, creams, a burgundy)
  { wall: [0x5f7a68, 0x6a8098, 0x8a9a8c, 0xe8e0c8, 0x7e8c94, 0x9a5048, 0xd8c89c, 0x4e6a7a, 0xa8b4a0, 0xf0ece0, 0x8a7a68], roof: [0x3e4246, 0x4a4f55, 0x2f3236, 0x5a5048, 0x55595c] },
  // 12 Vancouver Special: white or cream stucco
  { wall: [0xf2efe6, 0xece6d6, 0xe8e4dc, 0xf4f0e8, 0xe0dccc], roof: [0x4a4642, 0x5a5048, 0x3e4349, 0x6a5a4c] },
]
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]
// colours meant as seen (OSM building:colour / roof:colour, the material palettes): vertex colours are linear
const lin = (h) => hex(h).map((c) => c ** 2.2)
const TRUE = new Set([3, 8, 10, 11]) // palettes given as seen (brick, metal, stone, painted wood)
const shade = (c, f) => [Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)]
const RAIL = [0xb8dce0, 0xc8e4e8, 0xa8ccd8, 0xd8e8ea, 0x98c0cc].map(hex)

function buildings(t, terr, level) {
  const s = t.sections.BLDG
  const W = { pos: [], nor: [], col: [], win: [] }, Bal = { pos: [], nor: [], col: [], win: [] }
  const units = [], fp = [], fpStart = [0] // footprints: world x, north pairs; ring i is fp[fpStart[i]..fpStart[i+1])
  if (!s) return {}
  const dv = t.dv
  let o = s.off
  const n = dv.getUint32(o, true); o += 4
  const detail = level === 0
  for (let bi = 0; bi < n; bi++) {
    const fl = dv.getUint8(o), style0 = dv.getUint8(o + 1), base = dv.getInt16(o + 2, true) / 10, h = dv.getUint16(o + 4, true) / 10
    o += 6
    let mn = 0, roofShape = 0, ridge = 0, wallHex = 0, roofHex = 0, gid = 0, gH = h
    if (fl & 1) { mn = dv.getUint16(o, true) / 10; o += 2 }
    if (fl & 2) { roofShape = dv.getUint8(o); ridge = dv.getUint16(o + 1, true) / 10; o += 3 }
    const roofBits = roofShape & 48; roofShape &= 15 // 16: ridge along the short axis, 32: a shed roof's high side flipped
    if (fl & 4) { wallHex = dv.getUint32(o, true) | 0x1000000; o += 4 }
    if (fl & 8) { roofHex = dv.getUint32(o, true) | 0x1000000; o += 4 }
    if (fl & 16) { gH = dv.getUint16(o, true) / 10; gid = dv.getUint32(o + 2, true); o += 6 }
    let fh = 0, bits = 0, plant = null // storey height; bits 1 storefront, 2 residential; rooftop plant the LiDAR saw
    if (fl & 32) { fh = dv.getUint8(o) / 20; bits = dv.getUint8(o + 1); o += 2 }
    if (fl & 64) {
      const nu = dv.getUint8(o); o += 1; plant = []
      for (let k = 0; k < nu; k++, o += 8) plant.push([dv.getInt16(o, true) * t.k, dv.getInt16(o + 2, true) * t.k, dv.getUint8(o + 4) / 10, dv.getUint8(o + 5) / 10, dv.getUint8(o + 6) / 20, (dv.getUint8(o + 7) / 256) * Math.PI])
    }
    const [flatPts, o2] = readRing(t, o); o = o2
    const np = flatPts.length / 2
    let pts = []
    for (let p = 0; p < np; p++) pts.push([flatPts[p * 2], flatPts[p * 2 + 1]])
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
    // 7 big box, 8 Vancouver Special, 9 glass condo; the storefront and the storey height ride along (see materials.js)
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
    const fq = Math.max(1, Math.min(31, Math.round(((fh || 3.2) - 2.4) / 0.15)))
    const styleW = style + (fq + (front && style !== 6 && style !== 7 ? 32 : 0)) / 64
    const storey = 2.4 + fq * 0.15
    const balc = detail && h - mn > 9 && np <= 120 && (fl & 32 ? bits & 2 && (style === 3 || style === 9 || style0 === 7 && tower) : style === 3)
    const pal = PALETTES[style0] || PALETTES[4]
    const wall = shade(wallHex & 0x1000000 ? lin(wallHex & 0xffffff) : (TRUE.has(style0) ? lin : hex)(pick(pal.wall)), 0.97 + gr() * 0.06)
    const ownRoof = !roofShape || style0 === 8 || style0 >= 11
    const roofC = shade(roofHex & 0x1000000 ? lin(roofHex & 0xffffff) : (ownRoof && TRUE.has(style0) ? lin : hex)(pick(ownRoof ? pal.roof : PALETTES[0].roof)), 0.96 + gr() * 0.08)
    const y0 = base + mn, y1 = base + h
    // walls
    let u = 0
    for (let i = 0; i < np; i++) {
      const a = pts[i], p = pts[(i + 1) % np], len = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1
      const nx = (p[1] - a[1]) / len, nz = (p[0] - a[0]) / len // outward in (x, z=-y)
      const w = (uu, yy) => [styleW, uu, yy - base, seed]
      quad(W, [a[0], y0, -a[1]], [p[0], y0, -p[1]], [p[0], y1, -p[1]], [a[0], y1, -a[1]], wall, [nx, 0, nz], w(u, y0), w(u + len, y0), w(u + len, y1), w(u, y1))
      u += len
    }
    const flat = !roofShape || !ridge || ridge <= h
    if (flat) {
      const tris = earcut2(pts)
      for (let i = 0; i < tris.length; i += 3) {
        const A = pts[tris[i]], B = pts[tris[i + 1]], C = pts[tris[i + 2]]
        tri(W, [A[0], y1, -A[1]], [B[0], y1, -B[1]], [C[0], y1, -C[1]], roofC, [0, 1, 0], ROOFW(seed))
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
        const bb = bbox(pts), ar = (bb[2] - bb[0]) * (bb[3] - bb[1])
        if (plant) { // what the LiDAR saw up there
          for (const [ux, uy, su, sv, uh, ang] of plant) box3(Bal, ux, uy, y1, su, sv, uh, ang, shade([0.86, 0.88, 0.9], 0.85 + gr() * 0.2))
        } else if (ar > 120) {
          const want = Math.min(7, Math.round(ar / 260) + (gr() < 0.5 ? 1 : 0))
          for (let tries = 0, got = 0; tries < want * 4 && got < want; tries++) {
            const ux = bb[0] + gr() * (bb[2] - bb[0]), uy = bb[1] + gr() * (bb[3] - bb[1]), sx = 1.4 + gr() * 3, sy = 1.2 + gr() * 2.2
            if (![[ux, uy], [ux + sx, uy], [ux - sx, uy], [ux, uy + sy], [ux, uy - sy]].every(([x, y]) => inPoly(x, y, pts))) continue
            const g = 0.75 + gr() * 0.25
            units.push(ux, y1, -uy, sx, 0.8 + gr() * 1.4, sy, g); got++
          }
        }
      }
    } else roof(W, pts, y1, base + ridge, roofShape, roofBits, roofC, wall, seed)
    // balconies: a slab and a railing (glass, or concrete on the older towers) on every floor, all the way round
    if (balc) {
      const D = 1.15, ring = offset(pts, D)
      const slabC = shade(wall, 1.05), railC = style0 === 7 ? shade(wall, 0.78) : RAIL[Math.floor(seed * RAIL.length)], pw = ROOFW(seed)
      const fy0 = base + Math.max(mn, front ? 4.5 : 0) + storey
      for (let fy = Math.max(fy0, y0 + 2.5); fy < y1 - 2.4; fy += storey) {
        for (let i = 0; i < np; i++) {
          const a = pts[i], p = pts[(i + 1) % np], A = ring[i], P = ring[(i + 1) % np]
          const len = Math.hypot(p[0] - a[0], p[1] - a[1])
          if (len < 2.5) continue
          const nx = (p[1] - a[1]) / len, nz = (p[0] - a[0]) / len
          quad(Bal, [a[0], fy, -a[1]], [p[0], fy, -p[1]], [P[0], fy, -P[1]], [A[0], fy, -A[1]], slabC, [0, 1, 0], pw)
          quad(Bal, [A[0], fy - 0.4, -A[1]], [P[0], fy - 0.4, -P[1]], [P[0], fy, -P[1]], [A[0], fy, -A[1]], shade(slabC, 0.86 + 0.14 * Math.abs(nx)), [nx, 0, nz], pw)
          quad(Bal, [A[0], fy, -A[1]], [P[0], fy, -P[1]], [P[0], fy + 1.05, -P[1]], [A[0], fy + 1.05, -A[1]], shade(railC, 0.9 + 0.1 * Math.abs(nx)), [nx, 0, nz], pw)
        }
      }
    }
  }
  return { walls: pack(W), balconies: Bal.pos.length ? pack(Bal) : null, units: units.length ? new Float32Array(units) : null,
    footprints: fpStart.length > 1 ? { pts: new Float32Array(fp), start: new Uint32Array(fpStart) } : null }
}
const ROOFW = (seed) => [0, 0, 999, seed]
function pack(B) {
  return { position: new Float32Array(B.pos), normal: new Int8Array(B.nor), color: new Uint8Array(B.col), aWin: new Float32Array(B.win) }
}
// one triangle with a flat normal, wound so the normal points along `want`; w = aWin per vertex (or one for all)
function tri(B, a, b, c, col, want, w, w2, w3) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  const l = Math.hypot(...n) || 1; n = n.map((v) => v / l)
  let ws = [w, w2 || w, w3 || w]
  if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) { [b, c] = [c, b]; n = n.map((v) => -v); ws = [ws[0], ws[2], ws[1]] }
  for (const p of [a, b, c]) { B.pos.push(p[0], p[1], p[2]); B.nor.push(n[0] * 127, n[1] * 127, n[2] * 127); B.col.push(col[0] * 255, col[1] * 255, col[2] * 255) }
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
// a box standing on a roof at y, centred on (x, y north), su along angle a, sv across it, uh tall
function box3(B, x, yN, y, su, sv, uh, a, col) {
  const ca = Math.cos(a), sa = Math.sin(a), pw = ROOFW(0.5)
  const c = (s, t, h) => [x + ca * s - sa * t, y + h, -(yN + sa * s + ca * t)]
  const u = su / 2, v = sv / 2, top = shade(col, 1.08)
  quad(B, c(-u, -v, uh), c(u, -v, uh), c(u, v, uh), c(-u, v, uh), top, [0, 1, 0], pw)
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
function inPoly(x, y, pts) {
  let c = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j]
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c
  }
  return c
}
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
