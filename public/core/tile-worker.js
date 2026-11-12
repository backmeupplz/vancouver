// Turns a streamed map tile (tools/tiles.py) into ready-to-draw geometry buffers, off the page's thread.
// Coordinates in the buffers are local to the tile: x east, y up, z south, metres from the tile's SW corner.
// Walls by what they face and the single-arm street lights follow Slop Toronto's rules (MIT, © 2026 Mr.doob, © 2026 John
// Fewell; THIRD_PARTY.md).
import earcut, { refine as delaunay } from '../vendor/earcut.js'
import { mulberry32 as mulberry, inPoly, sampleGrid, sampleTerr, wallGrid, wallHeight, wallNear, gores, stripped, SEA0, BED_TOP, BED_S, FLOAT_UP, pierIndex, pierTop } from './util.js'
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
    const size = level ? 4096 : 1024
    if (out.ground?.index) { out.ground.cells = cells(out.ground, 'index', size); if (out.ground.coarse) out.ground.coarseCells = cells(out.ground, 'coarse', size) }
    if (out.buildings?.position.length) out.buildings.cells = cells(out.buildings, null, size)
    if (out.balconies?.position.length) out.balconies.cells = cells(out.balconies, null, size) // (near-only: tiles.js nearDetail)
    if (out.lights) out.lights.box = box(out.lights.pos, 4)
    postMessage({ id, ...out }, transferables(out))
  } catch (e) { postMessage({ id, error: String(e) }) }
}

// A mesh's triangles sorted by the cell of a 4 x 4 grid over the tile that all three corners lie in (the ones across a
// border last), so the page draws each cell as a mesh of its own (core/tiles.js cellMeshes) and the camera culls the
// ones it doesn't see: a street-level view drew every tile it touched whole. g[key]: the index to sort (null: the
// mesh has none, its vertices are moved). Returns, per cell that has any: cell (16: the border's), first, count (in
// indices, or vertices), then its bounds (min x, y, z, max x, y, z).
function cells(g, key, size) {
  const n = 4, N = n * n, c = size / n, p = g.position, ix = key && g[key], nt = (ix ? ix.length : p.length / 3) / 3
  const of = new Uint8Array(nt), cnt = new Uint32Array(N + 2), order = new Uint32Array(nt)
  const cell = (v) => Math.min(n - 1, Math.max(0, Math.floor(p[v * 3] / c))) + n * Math.min(n - 1, Math.max(0, Math.floor(-p[v * 3 + 2] / c)))
  for (let t = 0; t < nt; t++) {
    const a = ix ? ix[t * 3] : t * 3, b = ix ? ix[t * 3 + 1] : a + 1, d = ix ? ix[t * 3 + 2] : a + 2, k = cell(a)
    cnt[(of[t] = k === cell(b) && k === cell(d) ? k : N) + 1]++
  }
  for (let k = 0; k <= N; k++) cnt[k + 1] += cnt[k]
  const at = cnt.slice()
  for (let t = 0; t < nt; t++) order[at[of[t]]++] = t
  if (ix) {
    const o = new ix.constructor(ix.length)
    for (let i = 0; i < nt; i++) { const t = order[i] * 3; o[i * 3] = ix[t]; o[i * 3 + 1] = ix[t + 1]; o[i * 3 + 2] = ix[t + 2] }
    g[key] = o
  } else {
    const nv = p.length / 3
    for (const [k, a] of Object.entries(g)) {
      if (k === 'box' || !ArrayBuffer.isView(a) || a.length % nv) continue
      const s = (a.length / nv) * 3, o = new a.constructor(a.length)
      for (let i = 0; i < nt; i++) { const f = order[i] * s; for (let j = 0; j < s; j++) o[i * s + j] = a[f + j] }
      g[k] = o
    }
  }
  const P = g.position, I = key && g[key], out = []
  for (let k = 0; k <= N; k++) {
    if (cnt[k + 1] === cnt[k]) continue
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = cnt[k] * 3; i < cnt[k + 1] * 3; i++) { const v = (I ? I[i] : i) * 3; for (let j = 0; j < 3; j++) { const x = P[v + j]; if (x < b[j]) b[j] = x; if (x > b[j + 3]) b[j + 3] = x } }
    out.push(k, cnt[k] * 3, (cnt[k + 1] - cnt[k]) * 3, ...b)
  }
  return new Float64Array(out)
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
  if (out.ground?.pier) terr.pier = out.ground.pier // (after ground(): the ground is draped on the raw terrain)
  const lines = readLines(t)
  if (level === 0) tubeWalls(lines)
  const ps = pois(t)
  const carriage = level === 0 ? roadMask(t) : null
  const lot = level === 0 ? roadMask(t, new Set([PARKING])) : null // the car parks: shops face them too
  const rd = roads(t, terr, lines, level, ps, carriage)
  out.roads = rd.surf; out.paint = rd.paint
  out.graph = graph(t, lines)
  out.graph.pois = ps
  const b = buildings(t, terr, level, lines, carriage, lot)
  out.buildings = b.walls; out.balconies = b.balconies; out.ao = b.ao
  const tr = trees(t, terr)
  if (level === 0) {
    const S = solids(t, b.footprints, tr) // what stands on the ground: nothing placed inside another
    out.water = water(t); out.carriage = carriage; out.boats = boats(t, terr); out.lights = lights(t, terr, lines, ps, b, carriage, S)
    out.signs = mergeSigns(signs(t, b.fronts), b.extraSigns)
    out.parked = parked(t, terr, lines, ps, b.footprints, S)
    out.footprints = withCars(b.footprints, out.parked.lot, t); out.overhangs = b.overhangs
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
  const fs = t.sections.TFIN // the 2 m offsets under the streets (tools/tiles.py road_fine): 16 x 16 node blocks, the rest none
  if (fs) {
    const N = Math.round(t.size / 2) + 1, nb = Math.ceil(N / 16), cnt = t.dv.getUint16(fs.off, true), B = new Int16Array(nb * nb).fill(-1), V = new Float32Array(cnt * 256)
    for (let k = 0, o = fs.off + 2; k < cnt; k++, o += 2 + 512) { B[t.dv.getUint16(o, true)] = k; for (let q = 0; q < 256; q++) V[k * 256 + q] = t.dv.getInt16(o + 2 + q * 2, true) / 100 }
    out.f = { n: N, nb, B, V }
  }
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
  const w = t.sections.SEAW // the seawalls (tools/tiles.py seawall_section): the ground on their walks, the water at their feet
  if (w) {
    const dv = t.dv, nr = dv.getUint32(w.off, true), P = [], starts = [0]
    let o = w.off + 4
    for (let r = 0; r < nr; r++) {
      const n = dv.getUint32(o, true); o += 4
      for (let i = 0; i < n; i++, o += 11) P.push(dv.getInt16(o, true) * t.k, dv.getInt16(o + 2, true) * t.k, dv.getInt16(o + 4, true) / 100, dv.getInt16(o + 6, true) / 100, dv.getUint8(o + 8) / 10, dv.getUint8(o + 9) / 255, dv.getUint8(o + 10))
      starts.push(P.length / 7)
    }
    const e = out.ext // (the walk's terrain a few metres in may lie in the next tile)
    const sg = t.sections.SEAG // the walks' ground (tools/seawall.py walk_ground): the same in every tile a run passes; older tiles: this tile's terrain
    const sb = t.sections.SEAB // where each point's top lets go of the ground, and over how many metres (tools/tiles.py: 1/10 m, u8, per point of SEAW); older tiles: the reach and 10 m
    const D = sb ? Float32Array.from({ length: (P.length / 7) * 2 }, (_, i) => dv.getUint8(sb.off + i) / 10) : null
    out.wall = wallGrid(Float32Array.from(P), starts, sg ? (x, y, i) => dv.getInt16(sg.off + 2 * i, true) / 100 : (x, y) => out.f && x >= 0 && y >= 0 && x <= t.size && y <= t.size ? sampleTerr(out, x, y) : e ? sampleGrid(e.h, e.n, e.size, x + e.off, y + e.off) : sampleGrid(h, n, t.size, x, y), D)
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
// the drawn ground at tile-local (x, y north): the terrain with its 2 m offsets, and the seawalls' walks and feet (low: core/util.js wallHeight)
const heightAt = (terr, x, y, low) => {
  const g0 = sampleTerr(terr, x, y), g = terr.wall ? wallHeight(terr.wall, g0, x, y, low) : g0
  if (terr.pier && !low) { const p = pierTop(terr.pier, x, y); if (p !== null && p > g) return p } // (a pier's deck, as drawn)
  return g
}
// does an edge from (ax, ay) to (bx, by) lie on the 2 m offsets (its ends, its middle: a node of the 2 m cell there
// moved)? Sampled every metre there (the rest of an offset block is the 8 m grid, sampled as anywhere)
const fineOn = (terr, ax, ay, bx, by) => {
  const f = terr.f
  if (!f) return false
  const node = (i, j) => { const s = f.B[(j >> 4) * f.nb + (i >> 4)]; return s >= 0 && f.V[s * 256 + (j & 15) * 16 + (i & 15)] !== 0 }
  const at = (x, y) => { const i = Math.min(f.n - 2, Math.max(0, Math.floor(x / 2))), j = Math.min(f.n - 2, Math.max(0, Math.floor((terr.size - y) / 2))); return node(i, j) || node(i + 1, j) || node(i, j + 1) || node(i + 1, j + 1) }
  return at(ax, ay) || at(bx, by) || at((ax + bx) / 2, (ay + by) / 2)
}
// the ground at tile-local (x, y) on past the tile's edge (a decal, a building reaching into the next tile): the next
// tiles' terrain (terr.ext, tools/tiles.py margins()), else carried on on the slope at the edge
function groundOut(terr, x, y) {
  const e = terr.ext
  if (terr.f && x >= 0 && y >= 0 && x <= terr.size && y <= terr.size) return heightAt(terr, x, y) // (in the tile: with its 2 m offsets, which TERM's ring of the next tiles' grids leaves out)
  if (e) { const g = sampleGrid(e.h, e.n, e.size, x + e.off, y + e.off); return terr.wall ? wallHeight(terr.wall, g, x, y) : g }
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
  const decks = level === 0 ? readDecks(t) : [] // fixed piers: drawn after the ground (class code 256 + k while triangulating)
  for (const d of decks) d.cls = d.flags & 4 ? 15 : PIER // (a paved deck: plaza pavers)
  const seen = new Map() // shared vertices: one per (point, class), so each tile uploads about a third as much
  const vert = (x, y, c, lift) => {
    const key = (Math.round(x * 1000) + 3e6) * 1e7 + Math.round(y * 1000) + 3e6 + c * 1e14 // (to the mm: two points of a sliver 2 cm across stay two)
    let i = seen.get(key)
    if (i === undefined) { i = pos.length / 3; seen.set(key, i); pos.push(x, hz(x, y, c) + lift, -y); cls.push(c >= 256 ? decks[c - 256].cls : c) }
    return i
  }
  let hmin = Infinity, hmax = -Infinity
  for (const v of terr.h) { hmin = Math.min(hmin, v); hmax = Math.max(hmax, v) }
  if (terr.f) { let lo = 0, hi = 0; for (const v of terr.f.V) { lo = Math.min(lo, v); hi = Math.max(hi, v) } hmin += lo; hmax += hi } // (the 2 m offsets: a flat tile's street in a cut)
  // Triangles are split where the terrain bends under them, not everywhere: an edge is halved while the ground along it
  // strays more than tol from the straight line between its ends, or it is longer than 4 terrain cells. The test
  // looks at the edge alone, so both triangles that share an edge split it alike (no cracks; where polygons meet, a gap
  // is under tol); slopes and flat ground keep big triangles (an 8 m grid split everywhere was ~3x the triangles for the same picture).
  const cell = t.size / (terr.n - 1), cap = hmax - hmin < 2 ? Infinity : cell * 4
  const hz = (x, y, c) => c >= 256 ? Math.max(heightAt(terr, x, y, true) + PIER_LAY, decks[c - 256].z) : heightAt(terr, x, y, c === WATER || c === SAND) // (a float's rise is added below, once its water is known)
  const bends = (ax, ay, bx, by, c, tol) => {
    if (ax > bx || (ax === bx && ay > by)) return bends(bx, by, ax, ay, c, tol) // one way along an edge, whichever side asks
    const L = Math.hypot(bx - ax, by - ay)
    if (L > cap) return true
    // by a seawall (where it moves the ground: its walk, its foot, its blend into a bank or a cliff) the ground bends
    // within a cell: followed to a centimetre, down to half-metre edges, so two tiles whose points along their shared edge
    // differ still draw the same ground there (a 5 cm step showed between them)
    const mv = (x, y) => Math.abs(heightAt(terr, x, y) - sampleTerr(terr, x, y)) > 0.01
    const wall = terr.wall && L >= 0.5 && wallNear(terr.wall, (ax + bx) / 2, (ay + by) / 2) && (mv(ax, ay) || mv(bx, by) || mv((ax + bx) / 2, (ay + by) / 2))
    if (wall) tol = Math.min(tol, 0.01)
    else if (cap === Infinity || L < 1.5) return false
    const fine = wall || fineOn(terr, ax, ay, bx, by)
    if (fine && !wall && L < 2) return false // (the offsets have nothing finer than their 2 m)
    const H = c >= 256 ? (x, y) => hz(x, y, c) : (x, y) => heightAt(terr, x, y) // (a deck: where it is drawn, flat at its z over the water, on the bank where that stands higher)
    const ha = H(ax, ay), hb = H(bx, by), k = Math.ceil(L / (wall ? 0.25 : fine ? 1 : cell / 2)) // (the terrain, also under a pier: its border with the water is split alike on both sides; every metre over the 2 m offsets)
    for (let i = 1; i < k; i++) { const f = i / k; if (Math.abs(H(ax + (bx - ax) * f, ay + (by - ay) * f) - ha - (hb - ha) * f) > tol) return true }
    return false
  }
  // one triangle into `out`, split at the middle of every edge that bends, all at once, so each split halves them: 12
  // splits take the longest edge (1.4 km) under the 1.5 m no edge is split below, and a piece of an edge is as deep on
  // either side of it, so the limit cuts both sides alike. (One edge at a time, a long flat edge
  // kept its far corner through every split: a fan of ever thinner slivers along an edge that is straight where its
  // pieces aren't, cut off by the depth limit before the edges the next triangles split were split here too.)
  // fl: which of its edges (1 ab, 2 bc, 4 ca) lie on its polygon's border: those triangles are listed in out.rim
  const emit = (out, tol, c, lift, ax, ay, bx, by, cx, cy, depth, fl) => {
    const S = [bends(ax, ay, bx, by, c, tol), bends(bx, by, cx, cy, c, tol), bends(cx, cy, ax, ay, c, tol)], k = S[0] + S[1] + S[2]
    if (k && depth < 12) {
      const V = [[ax, ay], [bx, by], [cx, cy]], F = [fl & 1, fl & 2, fl & 4], d = depth + 1
      const M = V.map((p, i) => [(p[0] + V[(i + 1) % 3][0]) / 2, (p[1] + V[(i + 1) % 3][1]) / 2])
      const T = (p, q, r, f0, f1, f2) => emit(out, tol, c, lift, p[0], p[1], q[0], q[1], r[0], r[1], d, (f0 ? 1 : 0) | (f1 ? 2 : 0) | (f2 ? 4 : 0))
      if (k === 3) { T(V[0], M[0], M[2], F[0], 0, F[2]); T(M[0], V[1], M[1], F[0], F[1], 0); T(M[2], M[1], V[2], 0, F[1], F[2]); T(M[0], M[1], M[2], 0, 0, 0); return }
      if (k === 1) { const i = S.indexOf(true), j = (i + 1) % 3, o = (i + 2) % 3; T(V[i], M[i], V[o], F[i], 0, F[o]); T(M[i], V[j], V[o], F[i], F[j], 0); return }
      const j = S.indexOf(false), e = (j + 1) % 3, g = (j + 2) % 3 // edges e and g split, j not: a corner at V[g], a quad left
      T(M[e], V[g], M[g], F[e], F[g], 0)
      if (Math.hypot(M[e][0] - V[j][0], M[e][1] - V[j][1]) < Math.hypot(M[g][0] - V[e][0], M[g][1] - V[e][1])) { T(V[j], V[e], M[e], F[j], F[e], 0); T(V[j], M[e], M[g], 0, 0, F[g]) }
      else { T(V[j], V[e], M[g], F[j], 0, F[g]); T(V[e], M[e], M[g], F[e], 0, 0) }
      return
    }
    const va = vert(ax, ay, c, lift), vb = vert(bx, by, c, lift), vc = vert(cx, cy, c, lift)
    // face up: earcut keeps the ring's winding; pick the order whose normal points +y
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (fl) out.rim.push(out.length, cross > 0 ? fl : ((fl & 4) >> 2) | (fl & 2) | ((fl & 1) << 2)) // (its border edges in the order kept)
    if (cross > 0) out.push(va, vb, vc); else out.push(va, vc, vb)
  }
  // a ring edge longer than DENSE gets its halves' points (a long border opposite short ones made needles: 300 m long,
  // 30 cm across, tilted across by the terrain along them)
  const DENSE = cap === Infinity ? Infinity : cell * 16
  const halve = (out, ax, ay, bx, by) => {
    if (Math.hypot(bx - ax, by - ay) <= DENSE) return
    const mx = (ax + bx) / 2, my = (ay + by) / 2
    halve(out, ax, ay, mx, my); out.push(mx, my); halve(out, mx, my, bx, by)
  }
  // a ring edge along the tile's edge gets a point on every terrain node it passes: the next tile's ground meets it
  // there, and with its own corners elsewhere along the edge each side's splits (bends) fell in other places, so the
  // two sides followed the terrain differently, up to 11 cm apart: a line across the street at every tile edge (#557).
  // Between nodes the terrain along the edge is a straight line, so neither side splits it again: both are the same
  const rimNodes = (out, ax, ay, bx, by) => {
    const S = t.size, on = (u) => Math.abs(u) < 1e-3 || Math.abs(u - S) < 1e-3, ux = on(ax) && Math.abs(bx - ax) < 1e-3
    if (!ux && !(on(ay) && Math.abs(by - ay) < 1e-3)) return false
    const u0 = ux ? ay : ax, u1 = ux ? by : bx, s = Math.sign(u1 - u0)
    for (let k = s > 0 ? Math.floor(u0 / cell) + 1 : Math.ceil(u0 / cell) - 1; s * (k * cell - u1) < -1e-3; k += s) {
      if (Math.abs(k * cell - u0) > 1e-3) out.push(ux ? ax : k * cell, ux ? k * cell : ay)
    }
    return true
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
      for (let n = 0; n < ring.length; n++) { // (long edges halved down to DENSE: alike from either side, so neighbours keep sharing them)
        const a = ring[n] * 2, b = ring[(n + 1) % ring.length] * 2
        flat.push(W.xy[a], W.xy[a + 1])
        if (!rimNodes(flat, W.xy[a], W.xy[a + 1], W.xy[b], W.xy[b + 1])) halve(flat, W.xy[a], W.xy[a + 1], W.xy[b], W.xy[b + 1])
      }
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
    delaunay(tri, flat) // (fewer slivers, so fewer splits on slopes; before conform(): a flip can lay an edge back over a point)
    let tris = conform(tri, flat)
    delaunay(tris, flat); tris = conform(tris, flat) // (again: with the cut triangles the flips get out of the needles left)
    for (let i = 0; i < tris.length; i += 3) {
      const u = tris[i], v = tris[i + 1], w = tris[i + 2], a = u * 2, b = v * 2, d = w * 2
      const fl = (ringEdge(u, v) ? 1 : 0) | (ringEdge(v, w) ? 2 : 0) | (ringEdge(w, u) ? 4 : 0)
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
          if (f <= 1e-3 || f >= 1 - 1e-3 || Math.abs((vx - ax) * (by - ay) - (vy - ay) * (bx - ax)) / L >= 1e-4) continue // (right on it: the bake's borders are shared point for point)
          const k = Math.round(vx * 50) * 65536 + Math.round(vy * 50)
          if (!on) { on = []; seen = new Set() }
          if (!seen.has(k)) { seen.add(k); on.push([f, vx, vy]) }
        }
        if (!on) continue
        on.sort((u, w) => u[0] - w[0])
        for (const [, x, y] of on) loop.push(vert(x, y, cc, lift))
      }
      if (loop.length === 3) continue
      const [A, B, C] = [out[q], out[q + 1], out[q + 2]].map((v) => [pos[v * 3], -pos[v * 3 + 2]])
      const across = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / Math.max(Math.hypot(B[0] - A[0], B[1] - A[1]), Math.hypot(C[0] - B[0], C[1] - B[1]), Math.hypot(A[0] - C[0], A[1] - C[1]))
      if (across < 0.01) { // a sliver: a fan from its first corner (its centre would be a new point all but on its long edge, the next triangles' edge)
        out[q] = loop[0]; out[q + 1] = loop[1]; out[q + 2] = loop[2]
        for (let j = 2; j < loop.length - 1; j++) add.push(loop[0], loop[j], loop[j + 1])
        continue
      }
      const g = vert((A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, cc, lift)
      out[q] = loop[0]; out[q + 1] = loop[1]; out[q + 2] = g
      for (let j = 1; j < loop.length; j++) add.push(loop[j], loop[(j + 1) % loop.length], g)
    }
    for (const v of add) out.push(v)
  }
  fixT(idx); if (coarse) fixT(coarse)
  // floats: a class 20 vertex by water rides it (FLOAT_UP over the sea, materials.js: the tide); the rest, on land, lie on the terrain
  const wk = new Set(), k2 = (x, z) => Math.round(x / 2) * 65536 + Math.round(z / 2), ptid = new Map(), pnorm = new Map()
  for (let i = 0; i < cls.length; i++) if (cls[i] === WATER) wk.add(k2(pos[i * 3], pos[i * 3 + 2]))
  const rides = new Uint8Array(cls.length)
  if (wk.size) for (let i = 0; i < cls.length; i++) {
    if (cls[i] !== PIER) continue
    const cx = Math.round(pos[i * 3] / 2), cz = Math.round(pos[i * 3 + 2] / 2)
    let on = false
    for (let d = 0; d < 9 && !on; d++) on = wk.has((cx + d % 3 - 1) * 65536 + cz + Math.floor(d / 3) - 1)
    if (on) { rides[i] = 1; pos[i * 3 + 1] = Math.max(pos[i * 3 + 1], SEA0) + FLOAT_UP; ptid.set(i, 255) }
  }
  // skirt: a float's border edge hangs FLOAT_SKIRT of timber down toward the water (not on the tile's edge)
  if (level === 0 && ptid.size) {
    const ed = new Map(), S = t.size, on = (u) => Math.abs(u) < 1e-3 || Math.abs(u - S) < 1e-3
    for (let q = 0; q < idx.length; q += 3) {
      if (cls[idx[q]] !== PIER) continue
      for (let e = 0; e < 3; e++) {
        const a = idx[q + e], b = idx[q + (e + 1) % 3], k = a < b ? a * 4294967296 + b : b * 4294967296 + a
        const r = ed.get(k)
        if (r) r.n++; else ed.set(k, { a, b, c: idx[q + (e + 2) % 3], n: 1 })
      }
    }
    for (const { a, b, c, n } of ed.values()) {
      if (n !== 1 || !rides[a] || !rides[b]) continue
      const ax = pos[a * 3], az = pos[a * 3 + 2], bx = pos[b * 3], bz = pos[b * 3 + 2]
      if ((on(ax) && on(bx) && Math.abs(ax - bx) < 1e-3) || (on(-az) && on(-bz) && Math.abs(az - bz) < 1e-3)) continue
      let nx = bz - az, nz = ax - bx; const L = Math.hypot(nx, nz) || 1
      nx /= L; nz /= L
      if ((pos[c * 3] - ax) * nx + (pos[c * 3 + 2] - az) * nz > 0) { nx = -nx; nz = -nz } // away from the deck
      const ta = pos[a * 3 + 1], tb = pos[b * 3 + 1], v = []
      for (const [x, y, z, td] of [[ax, ta, az, 255], [bx, tb, bz, 255], [bx, tb - FLOAT_SKIRT, bz, 128], [ax, ta - FLOAT_SKIRT, az, 128]]) { const i = pos.length / 3; pos.push(x, y, z); cls.push(PIER); ptid.set(i, td); pnorm.set(i, [nx, 0, nz]); v.push(i) }
      // (v0 top a, v1 top b, v2 bottom b) faces (uz, -ux) * SKIRT: out when that points along the outward normal
      const ux = bx - ax, uz = bz - az
      const facing = uz * nx + (-ux) * nz
      if (facing > 0) idx.push(v[0], v[1], v[2], v[0], v[2], v[3]); else idx.push(v[0], v[2], v[1], v[0], v[3], v[2])
    }
  }
  // fixed decks: after fixT (a deck is no part of the partition: no welding, no rim, T-junctions never reach it), triangulated
  // like a ground polygon, flat at its z where the ground runs under it (hz: never under the bank it meets)
  const deckFrom = idx.length, n0 = pos.length / 3, deckRuns = []
  decks.forEach((d, k) => {
    const flat = [], holes = []
    for (let r = 0; r < d.rings.length; r++) {
      const ring = d.rings[r]
      if (ring.length < 6 || (r && !flat.length)) continue
      if (r) holes.push(flat.length / 2)
      for (let i = 0; i < ring.length; i += 2) {
        const j = (i + 2) % ring.length
        flat.push(ring[i], ring[i + 1]); halve(flat, ring[i], ring[i + 1], ring[j], ring[j + 1])
      }
    }
    if (flat.length < 6) return
    const tri = earcut(flat, holes)
    delaunay(tri, flat)
    const tris = conform(tri, flat), lift = d.cls * GROUND_LIFT + 0.02, from = idx.length
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i] * 2, b = tris[i + 1] * 2, c = tris[i + 2] * 2
      emit(idx, GROUND_TOL[level], 256 + k, lift, flat[a], flat[a + 1], flat[b], flat[b + 1], flat[c], flat[c + 1], 0, 0)
      if (coarse) emit(coarse, GROUND_COARSE, 256 + k, lift, flat[a], flat[a + 1], flat[b], flat[b + 1], flat[c], flat[c + 1], 0, 0)
    }
    deckRuns.push([from, idx.length, d.flags])
  })
  const nv = pos.length / 3
  if (!nv) return null
  const P = new Float32Array(pos), I = nv > 65535 ? Uint32Array : Uint16Array
  // tidal, a byte a vertex (materials.js ground: the tide). Water: how far it is from a beach's edge, 255 on it and one
  // less every half metre out (0: no beach within 127 m, always water): the beach's bed falls away from its edge, so
  // the waterline moves out as the tide falls, wherever the triangles' corners are. A beach's edge: the water's
  // triangle edges whose ends both lie on sand's (within 2-4 m), with the sea within 64 m (not a river's bar).
  // Other ground: 255 within FLOOD_R of the sea (it floods when the tide stands over it), else 0
  const tidal = new Uint8Array(nv), sandAt = new Set(), tk = (i, dx, dz) => (Math.round(P[i * 3] / 2) + dx) * 65536 + Math.round(P[i * 3 + 2] / 2) + dz
  const SEA_TOP = SEA0 + 0.01, FLOOD_R = 24, BC = 64, ck = (x, z) => Math.floor(x / BC) * 65536 + Math.floor(z / BC)
  const seaAt = new Set(), floodAt = new Set(), fk = (i, dx, dz) => (Math.floor(P[i * 3] / FLOOD_R) + dx) * 65536 + Math.floor(P[i * 3 + 2] / FLOOD_R) + dz
  for (let i = 0; i < nv; i++) {
    if (cls[i] === SAND) sandAt.add(tk(i, 0, 0))
    else if (cls[i] === WATER && P[i * 3 + 1] <= SEA_TOP) { seaAt.add(ck(P[i * 3], P[i * 3 + 2])); floodAt.add(fk(i, 0, 0)) }
  }
  if (seaAt.size) {
    const near = (set, key) => { for (let d = 0; d < 9; d++) if (set.has(key(d % 3 - 1, Math.floor(d / 3) - 1))) return true; return false }
    const edge = new Uint8Array(nv), segs = new Map() // beach edges by BC cell: [ax, az, bx, bz, ...]
    if (sandAt.size) for (let i = 0; i < nv; i++) if (cls[i] === WATER && P[i * 3 + 1] < 3 && near(sandAt, (dx, dz) => tk(i, dx, dz)) && near(seaAt, (dx, dz) => ck(P[i * 3] + dx * BC, P[i * 3 + 2] + dz * BC))) edge[i] = 1
    for (let q = 0; q < idx.length; q += 3) for (let e = 0; e < 3; e++) {
      const a = idx[q + e], b = idx[q + (e + 1) % 3]
      if (a > b || !edge[a] || !edge[b]) continue
      const ax = P[a * 3], az = P[a * 3 + 2], bx = P[b * 3], bz = P[b * 3 + 2]
      for (let i = Math.floor(Math.min(ax, bx) / BC); i <= Math.floor(Math.max(ax, bx) / BC); i++) for (let j = Math.floor(Math.min(az, bz) / BC); j <= Math.floor(Math.max(az, bz) / BC); j++) {
        const k = i * 65536 + j; let l = segs.get(k); if (!l) segs.set(k, (l = [])); l.push(ax, az, bx, bz)
      }
    }
    // how far each of the water's vertices is from a beach's edge
    const dist = new Float32Array(nv).fill(127), pts = new Map() // pts: ground known under the water near a beach, by BC cell: [x, z, how far out its height puts it, ...]
    const cells = (map, x, z, r, f) => { for (let u = -r; u <= r; u++) for (let v = -r; v <= r; v++) { const l = map.get((Math.floor(x / BC) + u) * 65536 + Math.floor(z / BC) + v); if (l) f(l) } }
    if (edge.some((e) => e)) for (let i = 0; i < nv; i++) {
      if (cls[i] !== WATER) continue
      if (edge[i]) { dist[i] = 0; const k = ck(P[i * 3], P[i * 3 + 2]); let l = pts.get(k); if (!l) pts.set(k, (l = [])); l.push(P[i * 3], P[i * 3 + 2], 0); continue } // (also on its own: an edge's corner with no edge drawn from it)
      const x = P[i * 3], z = P[i * 3 + 2]; let best = 127
      cells(segs, x, z, 2, (l) => { for (let s = 0; s < l.length; s += 4) {
        const dx = l[s + 2] - l[s], dz = l[s + 3] - l[s + 1], f = Math.min(1, Math.max(0, ((x - l[s]) * dx + (z - l[s + 1]) * dz) / (dx * dx + dz * dz || 1)))
        best = Math.min(best, Math.hypot(x - l[s] - dx * f, z - l[s + 1] - dz * f))
      } })
      dist[i] = best
      // the water baked on ground that stands over the sea (the foreshore the survey saw): as far out as its height puts it
      if (best < 127 && P[i * 3 + 1] > SEA_TOP) { const own = Math.max(0, (BED_TOP - P[i * 3 + 1]) / BED_S); if (own < best) { dist[i] = own; const k = ck(x, z); let l = pts.get(k); if (!l) pts.set(k, (l = [])); l.push(x, z, own) } }
    }
    for (let i = 0; i < nv; i++) {
      if (cls[i] === PIER) continue
      if (cls[i] !== WATER) { if (cls[i] !== SAND && near(floodAt, (dx, dz) => fk(i, dx, dz))) tidal[i] = 255; continue }
      let best = dist[i]; const x = P[i * 3], z = P[i * 3 + 2]
      if (best > 0 && pts.size) cells(pts, x, z, 2, (l) => { for (let s = 0; s < l.length; s += 3) best = Math.min(best, l[s + 2] + Math.hypot(x - l[s], z - l[s + 1])) })
      tidal[i] = best >= 127 ? 0 : 255 - Math.round(best * 2)
    }
  }
  for (const [i, v] of ptid) tidal[i] = v
  const normal = normals(terr, P)
  for (const [i, n] of pnorm) { normal[i * 3] = n[0] * 127; normal[i * 3 + 1] = 0; normal[i * 3 + 2] = n[2] * 127 }
  for (let i = n0 * 3; i < normal.length; i += 3) { normal[i] = 0; normal[i + 1] = 127; normal[i + 2] = 0 } // (a deck: straight up)
  let pier = null
  if (level === 0) { // the pier index: the drawn class 20 triangles (not the skirt), so what stands on a pier reads what is drawn
    const T = [], Y = [], F = []
    const add = (q, f) => {
      for (const v of [idx[q], idx[q + 1], idx[q + 2]]) T.push(P[v * 3], -P[v * 3 + 2]), Y.push(P[v * 3 + 1])
      F.push(f)
    }
    for (const [a, b, f] of deckRuns) for (let q = a; q < b; q += 3) add(q, (f & 1 ? 8 : 0) | 16)
    for (let q = 0; q < deckFrom; q += 3) {
      const a = idx[q], b = idx[q + 1], c = idx[q + 2]
      if (cls[a] !== PIER || pnorm.has(a)) continue
      for (const v of [a, b, c]) T.push(P[v * 3], -P[v * 3 + 2]), Y.push(P[v * 3 + 1])
      F.push(rides[a] | (rides[b] << 1) | (rides[c] << 2))
    }
    if (F.length) pier = pierIndex(new Float32Array(T), new Float32Array(Y), new Uint8Array(F), t.size)
  }
  return { position: P, normal, cls: new Uint8Array(cls), tidal, index: new I(idx), coarse: coarse && new I(coarse), pier }
}

// earcut's triangles made conforming: earcut can run an edge straight over one of the polygon's points (it leaves out a
// point in a straight line between its neighbours, also where a bridge to a hole lines up with a border, common on the
// tiles' grid) with a flat triangle on the other side, so the triangles either side of that line split it differently
// (a crack). A triangle with a point on an edge is cut in two there, flat triangles go -> the triangles (indices)
function conform(tri, flat) {
  const G = 4, grid = new Map(), out = []
  for (let i = 0; i < flat.length / 2; i++) { const k = Math.floor(flat[i * 2] / G) * 65536 + Math.floor(flat[i * 2 + 1] / G); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i) }
  const on = (p, q) => { // a point right inside edge p-q, else -1
    const ax = flat[p * 2], ay = flat[p * 2 + 1], dx = flat[q * 2] - ax, dy = flat[q * 2 + 1] - ay, L = Math.hypot(dx, dy)
    if (L < 1e-6) return -1
    for (let s = 0; s < L + G / 2; s += G / 2) {
      const f = Math.min(1, s / L), ci = Math.floor((ax + dx * f) / G), cj = Math.floor((ay + dy * f) / G)
      for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) for (const m of grid.get((ci + u) * 65536 + cj + v) || []) {
        const px = flat[m * 2] - ax, py = flat[m * 2 + 1] - ay, g = (px * dx + py * dy) / (L * L)
        if (g > 1e-6 && g < 1 - 1e-6 && Math.abs(px * dy - py * dx) / L < 1e-5) return m
      }
    }
    return -1
  }
  for (let i = 0; i < tri.length; i += 3) {
    const work = [tri[i], tri[i + 1], tri[i + 2]]
    for (let n = 0; work.length; n++) {
      if (n > 256) { out.push(...work); break } // (a guard)
      const w = work.pop(), v = work.pop(), u = work.pop()
      let cut = false
      for (const [p, q, o] of [[u, v, w], [v, w, u], [w, u, v]]) {
        const m = on(p, q)
        if (m < 0) continue
        if (m !== o) work.push(p, m, o, m, q, o) // (o on the edge: a flat triangle, none at all)
        cut = true; break
      }
      if (!cut) out.push(u, v, w)
    }
  }
  return out
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
const FLOAT_SKIRT = 0.6
// fixed piers (section PIER, optional: a tile without it has only floats): a level timber deck on piles, drawn from the
// bake's z (u16 count; per deck u8 flags 1 road 2 railing 4 paved, i16 z in dm, u16 rings as GRND). Constants: tools/tiles.py pier_decks
const PIER_THICK = 0.35, PIER_LAY = 0.06, PILE = 0.3, PILE_STEP = 5, PILE_IN = 0.25, PILE_DEEP = 1.6
function readDecks(t) {
  if (t.decks) return t.decks
  const s = t.sections.PIER, out = []
  t.decks = out
  if (!s) return out
  const dv = t.dv, n = dv.getUint16(s.off, true)
  let o = s.off + 2
  for (let i = 0; i < n; i++) {
    const flags = dv.getUint8(o), z = dv.getInt16(o + 1, true) / 10, nr = dv.getUint16(o + 3, true), rings = []
    o += 5
    for (let k = 0; k < nr; k++) { const [pts, o2] = readRing(t, o); o = o2; rings.push(pts) }
    out.push({ flags, z, rings })
  }
  return out
}
const WATER_N = 256, WATER = 19, PIER = 20, SAND = 10 // GROUND class indices of water, piers and sand (tools/tiles.py)
function water(t) { const m = raster(t, new Set([WATER]), WATER_N); return m && { n: WATER_N, mask: m } }
// and a 1 m mask of the carriageways and cycle tracks as drawn (bits, row-major from the SW corner): street furniture
// stands outside it (city.world.offRoad)
const ROADS_N = 1024, CARR = new Set([25, 29, 30]) // cycle, road, arterial
function roadMask(t, want = CARR) {
  const m = raster(t, want, ROADS_N)
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

function readLines(t, tag = 'LINE') { // (XDCK: the next tiles' decks reaching over this one, as LINE)
  const s = t.sections[tag]
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
  const tl = tag === 'LINE' && t.sections.TUNL // detail tiles: per point of each tunnel piece 0 underground, 1 open (the ground is cut there), 2 a portal
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
  let cur = {} // the piece strip() draws now, for unstack(): { a, b, foreign }
  const surf = Object.assign(mk(), { runs: [] }), paint = mk()
  // jA, jB: how far from each end the junction box there reaches (null: no junction, no stop line)
  const ext = terr.ext, decalH = (x, y) => groundOut(terr, x, y)
  const DK = [], gore = gores(DK)
  const strip = (T, pts, zs, half, lift, kind, extra, w, jA, jB, mitre = null, trim = null) => {
    if (T === surf) T.runs.push({ i0: T.I.length, i1: T.I.length, kind, ...cur }) // (unstack(): which triangles are whose)
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
      if (mitre?.[e] || edges[e]) continue // (one row with the next deck's there; on the tile's edge, the next tile's piece goes on from it)
      const dx = xs[i] - xs[j], dy = ys[i] - ys[j], l = Math.hypot(dx, dy)
      if (l > 0.2) { xs[i] += (dx / l) * 0.05; ys[i] += (dy / l) * 0.05 }
    }
    let s = 0
    const cum = [0]
    for (let i = 1; i < m; i++) { s += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]); cum.push(s) }
    const len = s
    let rows = 0
    const row = (i, lx, ly, rx, ry, al = half, ar = half) => { // one row across: its left and right points (and how far out they are)
      const e = i === 0 ? edges[0] : i === m - 1 ? edges[1] : null
      if (e) { // on the tile's edge: both points slid along the strip onto it
        const j = i ? i - 1 : 1, dx = xs[i] - xs[j], dy = ys[i] - ys[j], d = e[0] ? dy : dx, l = Math.hypot(dx, dy) || 1
        if (Math.abs(d / l) > 0.7) { // (only where it crosses the edge steeply: along it, the slide would skew the row metres along the strip)
          const slide = (px, py) => { const u = Math.max(-1.5 * half, Math.min(1.5 * half, (e[1] - (e[0] ? py : px)) / (d / l))); return [px + (dx / l) * u, py + (dy / l) * u] };
          [lx, ly] = slide(lx, ly); [rx, ry] = slide(rx, ry)
        }
      }
      for (const [side, px, py] of [[-1, rx, ry], [1, lx, ly]]) {
        const y = zz[i] ?? decalH(px, py) // decals follow the ground under each edge, not the centre line
        T.P.push(px, y + lift, -py)
        T.A.push(cum[i], side < 0 ? -ar : al, w, kind)
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
      const [al, ar] = trim ? trim(cx, cy, nx, ny, k, half, zz[i]) : [half, half]
      row(i, cx + nx * al * k, cy + ny * al * k, cx - nx * ar * k, cy - ny * ar * k, al, ar)
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
  const xdck = level === 0 ? readLines(t, 'XDCK').filter(stripped) : []
  DK.push(...lines.filter(stripped), ...xdck)
  for (const L of order) {
    const ja = (deg.get(L.a) || 0) >= 3, jb = (deg.get(L.b) || 0) >= 3
    if (L.z) { // bridges: the whole surface, raised
      if (L.kind > K.track && L.kind !== K.rail && L.kind !== K.lightrail) continue
      cur = { a: L.a, b: L.b }
      const lift = 0.36 + (18 - L.kind) * 0.004 + (L.kind >= K.pedestrian ? 0.05 : 0), P = L.pts, n = P.length / 2 // (a foot or cycle deck mapped across a road deck's edge lies 5 cm over it, not in it)
      for (const [e, f, id] of L.kind <= K.track ? [[0, 1, L.a], [n - 1, n - 2, L.b]] : []) { // its square end at node id: (x, y, height, direction out of the node, half width)
        const dx = P[f * 2] - P[e * 2], dy = P[f * 2 + 1] - P[e * 2 + 1], dl = Math.hypot(dx, dy) || 1
        let c = caps.get(id); if (!c) caps.set(id, (c = []))
        c.push({ x: P[e * 2], y: P[e * 2 + 1], h: L.z[e] + lift, a: Math.atan2(dy / dl, dx / dl), half: L.w / 2, kind: L.kind, mitred: !!mitreAt(L, id, e === 0) })
      }
      const trim = gore(L)
      if (L.band) { const bl = L.kind === K.residential || L.kind === K.tertiary ? 0 : 0, walk = 2.0; strip(surf, L.pts, L.z, L.w / 2 + walk, 0.3, 100, bl * 256 + walk * 16, L.w, null, null, null, trim) }
      strip(surf, L.pts, L.z, L.w / 2, lift, L.kind, L.lanes + (L.oneway ? 32 : 0), L.w, ja ? 0 : null, jb ? 0 : null, [mitreAt(L, L.a, true), mitreAt(L, L.b, false)], trim)
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
  for (const L of xdck) { // the next tiles' decks over this one: their strips as theirs draw them, not drawn here (unstack())
    cur = { a: L.a, b: L.b, foreign: true }
    const trim = gore(L)
    if (L.band) strip(surf, L.pts, L.z, L.w / 2 + 2.0, 0.3, 100, 2.0 * 16, L.w, null, null, null, trim)
    strip(surf, L.pts, L.z, L.w / 2, 0.36 + (18 - L.kind) * 0.004 + (L.kind >= K.pedestrian ? 0.05 : 0), L.kind, L.lanes + (L.oneway ? 32 : 0), L.w, null, null, null, trim)
  }
  cur = {}
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
  for (const I of [surf.I, surf.xI]) for (let q = 0; q < I.length; q += 3) { // (the next tiles' decks over this one too)
    const v = [I[q], I[q + 1], I[q + 2]].map((i) => [surf.P[i * 3], -surf.P[i * 3 + 2], surf.P[i * 3 + 1]])
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
  refine(paint, decalH, (x, y, z) => x < -M || y < -M || x > S + M || y > S + M || underDeck(x, y, z), 0.05, (ax, ay, bx, by) => fineOn(terr, ax, ay, bx, by))
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
  const xI = [] // (what is left of the next tiles' strips: covering this one's, not drawn here)
  for (const r of [...runs].sort((p, q) => layer(p) - layer(q) || p.kind - q.kind || p.a - q.a || p.b - q.b)) { // (by kind, then piece: the next tile decides alike)
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
      ;(r.foreign ? xI : out).push(keep[i], keep[i + 1], keep[i + 2])
    }
  }
  T.xI = xI
  const inRun = new Uint8Array(T.I.length); for (const r of runs) inRun.fill(1, r.i0, r.i1)
  for (let i = 0; i < T.I.length; i += 3) if (!inRun[i]) out.push(T.I[i], T.I[i + 1], T.I[i + 2]) // (the plates between deck ends)
  T.I = out; T.nv = P.length / 3
}

// hidden(x, y, z): a decal point a deck covers (paint under a deck, or poking through its end): dropped, split to 0.75 m
// along the deck's edge first
function refine(T, h, hidden, tol = 0.05, fine = null) {
  const P = T.P, A = T.A, B = T.B, lift = []
  for (let v = 0; v < T.nv; v++) lift.push(P[v * 3 + 1] - h(P[v * 3], -P[v * 3 + 2]))
  const mids = new Map()
  const bends = (a, b) => {
    const ax = P[a * 3], ay = -P[a * 3 + 2], bx = P[b * 3], by = -P[b * 3 + 2], L = Math.hypot(bx - ax, by - ay)
    if (L < 0.3) return 0
    const ha = h(ax, ay), hb = h(bx, by), k = Math.max(2, Math.ceil(L / (fine && fine(ax, ay, bx, by) ? 1 : 2))) // (every metre over the ground's 2 m offsets under the streets)
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
    pieces.push({ kind: L.kind, lanes: L.lanes, oneway: L.oneway, drive: L.drive, band: L.band, tunnel: L.tunnel ? TUBE_H(L.kind) : 0, tw: L.tw, roof: L.roof, turns: L.turns, w: L.w, a: L.a, b: L.b, pts, z: L.z })
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
function buildings(t, terr, level, lines, carriage, lot) {
  const s = t.sections.BLDG
  const W = { pos: [], nor: [], col: [], win: [], fac: [] }, Bal = { pos: [], nor: [], col: [], win: [], fac: [] }
  const fp = [], fpStart = [0] // footprints: world x, north pairs; ring i is fp[fpStart[i]..fpStart[i+1])
  const oh = [], ohStart = [0], ohLo = [] // the parts left out of them (you can drive under): the same, and the height of each one's underside (a chase camera is up there)
  const fronts = [] // storefront walls that face a street: ax, ay, px, py, ground height (for the shop signs)
  const spill = [] // tile-local x, north: where a lit shop window throws light on the sidewalk
  const extraSigns = [] // boards the lot code adds to the shop signs: pylon boards, tower names (mergeSigns)
  const towerNames = level === 0 ? shopNames(t).filter((q) => q.kind === 6) : [] // a named tower's name, at the middle of the wall that looks onto a street (tools/tiles.py)
  const strips = [] // STRIP buildings (strip malls): their ring and which walls face a car park, for the pylon signs
  const solidsOut = [] // posts and pylons: footprints (the walker and the van stop at them)
  const AO = { P: [], T: [], I: [] } // the shade on the ground round the walls' feet (skirt)
  if (!s) return {}
  if (level === 0) tubes(W, lines)
  if (level === 0) railings(W, Bal, lines, terr) // (a road on a roof has the building's parapet)
  if (level === 0 && terr.wall) seawalls(W, Bal, terr.wall, terr)
  if (level === 0) piers(W, Bal, readDecks(t), terr, lines, t.size)
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
  // the baked archetype (tools/archetype.py, BARC: 2 bytes a building: arch | era << 4, trim | flags << 3); old tiles have none
  const bs = t.sections.BARC
  if (bs && detail && bs.len >= n * 2) for (let bi = 0; bi < n; bi++) {
    const b0 = dv.getUint8(bs.off + bi * 2), b1 = dv.getUint8(bs.off + bi * 2 + 1)
    recs[bi].barc = { arch: b0 & 15, era: b0 >> 4, trim: b1 & 7, aflags: b1 >> 3 }
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
    const { fl, style0, base, h, mn, roofShape, roofBits, ridge, wallHex, roofHex, gH, fh, bits, fx, facing, plant, pts, looks, barc } = rec
    let { gid } = rec
    const np = pts.length
    if (MASKS.length) {
      let cx = 0, cy = 0
      for (const [x, y] of pts) { cx += x / np; cy += y / np }
      cx += t.ox; cy += t.oy
      if (MASKS.some((m) => cx >= m.bb[0] && cx <= m.bb[2] && cy >= m.bb[1] && cy <= m.bb[3] && inPoly(cx, cy, m.r))) continue
    }
    if (detail && mn > 1.5 && h - mn < 0.7 && h < 3.6 && np <= 8) for (const [x, y] of pts) { // a porch roof: posts under its free corners
      const ix = x * 0.9 + pts.reduce((m, q) => m + q[0], 0) / np * 0.1, iy = y * 0.9 + pts.reduce((m, q) => m + q[1], 0) / np * 0.1
      if (!grid.get(gk(Math.floor(ix / G), Math.floor(iy / G)))?.some((b) => b !== rec && b.mn < 0.5 && inPoly(ix, iy, b.pts))) post(W, ix, iy, groundOut(terr, ix, iy), base + mn)
    }
    if (detail && mn < 2.5) { for (const [x, y] of pts) fp.push(x + t.ox, y + t.oy); fpStart.push(fp.length) } // parts you can drive under are left out
    else if (detail && h - mn > 0.7) { for (const [x, y] of pts) oh.push(x + t.ox, y + t.oy); ohStart.push(oh.length); ohLo.push(base + mn) }
    if (!gid) gid = (Math.imul(Math.round(pts[0][0] * 10 + t.ox), 73856093) ^ Math.imul(Math.round(pts[0][1] * 10 + t.oy), 19349663)) >>> 0 || 1
    if (area(pts) < 0) pts.reverse() // counter-clockwise (y north)
    const gr = mulberry(gid), pick = (a) => a[Math.floor(gr() * a.length)]
    const seed = gr(), r = gr(), tower = gH > 20
    // facade pattern: -1 none, 1 punched windows, 2 curtain wall, 3 glass balconies, 5 wood siding, 6 ribbed metal,
    // 7 big box, 8 Vancouver Special, 9 glass condo, 10 window bands; the storefront and the storey height ride along
    // (see materials.js)
    let style = 1
    if (style0 === 0) style = h < 2.5 ? -1 : r < 0.5 ? 5 : 1 // (a bungalow's eaves stand under 4 m: windows still)
    else if (style0 === 2) style = 2
    else if (style0 === 6) style = tower ? (r < 0.8 ? 9 : 2) : 2
    else if (style0 === 1) style = tower ? (r < 0.15 ? 2 : r < 0.85 ? 3 : 1) : h > 9 && r < 0.4 ? 3 : 1
    else if (style0 === 8) style = 6
    else if (style0 === 9) style = 7
    else if (style0 === 11) style = h < 2.5 ? -1 : 5
    else if (style0 === 12) style = 8
    const front = !!(bits & 1) || (style0 === 4 && !(fl & 32) && h >= 5) // old tiles: commercial = storefront
    if (style0 === 4 && h < 5) style = -1
    if (fx >> 4) style = fx >> 4
    // archetype from what a tile carries (BUILDINGS.md step 1): 1 siding house, 2 stucco house, 3 Vancouver Special, 7 walk-up,
    // 8 mid-rise, 12 heritage, 13 main street, 14 strip mall; 0 as before. It picks the wall pattern (materials.js 21 home,
    // 22 flats, 23 heritage, 24 retail), the trim colour and the roof edges
    const style1 = style, parea = area(pts), flatTop = !roofShape || !ridge || ridge <= h
    const shopEdges = (front || style0 === 0 && parea > 500 && flatTop) && carriage ? pts.map((a, i) => { const p = pts[(i + 1) % np]; return streetSide(a, p, carriage) || (lot && streetSide(a, p, lot, 12)) }) : null
    let arch = 0
    // baked: 1 craftsman (siding), 2 bungalow 4 builder 5 contemporary 6 row (stucco), 3 Special, 7 walk-up, 8 mid-rise, 12 heritage, 13 main street, 14 strip.
    // A house the bake knows no era for (no year: it is 0) keeps the guess's house walls; every other 0 is "none"
    if (barc?.arch && !(fx >> 4) && style > 0) arch = BARC_ARCH[barc.arch]
    else if (detail && !(fx >> 4) && style > 0) {
      if (style0 === 11) arch = 1
      else if (style0 === 12) arch = 3
      else if (style0 === 0 && parea < 450 && h - mn >= 2.5 && mn < 0.5) arch = style === 5 ? 1 : 2
      else if (barc) arch = 0
      else if (style0 === 0 && parea > 500 && flatTop && shopEdges?.some((e) => e)) arch = 14
      else if ((style0 === 1 || style0 === 7) && bits & 2 && gH >= 5) arch = gH < 14 ? 7 : gH < 24 ? 8 : 0
      else if ((style0 === 3 || style0 === 10) && gH < 45) arch = 12
      else if (style0 === 4 && bits & 1 && gH < 8 && shopEdges) arch = 13
    }
    if (barc && arch >= 13 && !(arch === 14 ? shopEdges?.some((e) => e) : shopEdges)) arch = 0 // (a shop front needs a street to face, as the guess did)
    const trim = barc ? barc.trim : [0, 0, 0, 1, 2, 6][Math.floor(seed * 6)]
    if (arch === 1 || arch === 2) style = 21
    else if (arch === 7 || arch === 8) style = 22
    else if (arch === 12) style = 23
    else if (arch >= 13) style = 24
    const fq = Math.max(1, Math.min(31, Math.round(((fh || 3.2) - 2.4) / 0.15)))
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
    const lows = mn < 0.5 ? wallLows(terr, pts) : null, lo = lows ? Math.min(...lows) - 0.3 : y0, plinth = lo < y0 - 0.45, plC = shade(wall, 0.82)
    // walls, each by what it faces (after Slop Toronto's footprint edges): on the low and mid-rise walls of brick, siding
    // and punched windows (rows of shops and houses; not glass towers) a wall a neighbour covers for 60% of its height or
    // more, or a sliver, is a windowless party wall; a storefront only where the wall looks onto a street (all of
    // them where the tile can't tell: the overview); the rest keep the building's pattern
    const rowWalls = detail && y1 - y0 < 25 && (style1 === 1 || style1 === 5 || style1 === 8 || style1 === 10 || arch > 0) // brick, siding, punched: not glass towers
    // the house's front door: on the wall that looks onto the street, nearest it (materials.js draws it in that wall's
    // middle window bay, on the ground floor)
    const home = detail && carriage && mn < 0.5 && np <= 60 && h - mn >= 2.5 && (style0 === 0 || style0 >= 11 || style0 === 1 && h < 16 || arch === 7 || arch === 8) && arch < 12
    let door = -1
    if (home) { let best = 99; for (let i = 0; i < np; i++) { const d = streetSide(pts[i], pts[(i + 1) % np], carriage, 24); if (d && d < best) { best = d; door = i } } }
    const ring = detail && (arch === 12 || arch === 13) && carriage ? offset(pts, 0.4) : null
    for (let i = 0; i < np; i++) {
      const a = pts[i], p = pts[(i + 1) % np], len = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1
      const nx = (p[1] - a[1]) / len, nz = (p[0] - a[0]) / len // outward in (x, z=-y)
      const mx = (a[0] + p[0]) / 2, my = (a[1] + p[1]) / 2
      // the pattern of this wall: retail only on the walls that face a street or a car park (a mall's back: blank panels)
      const wk = arch >= 13 && !shopEdges[i] ? (arch === 14 ? 17 : style1) : style
      const lk = looks && looks[i * 4] & 7, B = bayOf(lk && (wk === 1 || wk === 2 || wk === 10) ? LOOK_STYLE[lk] : wk, looks ? looks[i * 4 + 1] : 0)
      const nb = Math.round(len / B) // whole window bays on each wall: none cut by a corner, none on a sliver
      const party = nb < 1 || rowWalls && (len < 2 || covered(rec, mx + nx * 0.8, my - nz * 0.8, mx - nx * 0.8, my + nz * 0.8, y0, y1))
      const fb = front && wk !== 6 && wk !== 7 && wk < 23 && !(shopEdges && !shopEdges[i]) // the storefront's tall ground floor
      const kind = party ? fq / 64 : wk + (fq + (fb ? 32 : 0)) / 64
      // on a slope a wall whose own ground runs more than 0.45 m under the building's foot goes down to it with its
      // pattern, its floors counted from there (the shop on the low street, the hill behind): no blank plinth under it
      const own = lows ? lows[i] - 0.3 : y0, foot = own < y0 - 0.45 ? Math.max(lo, own) : y0
      const dr = i === door && !party ? 4 : 0, u0 = (dr ? 64 * (1 + (i & 7)) - (nb >> 1) : 1 + ((i * 37) & 63)) * B, us = (nb || 1) * B / len
      // heritage and retail walls carry their height (a cornice, a parapet cap) over the door bit, in 4s of the last channel
      const hq = !party && wk >= 23 ? 8 * Math.min(500, Math.round(2 * (y1 - (foot < y0 ? foot : base)))) : 0, sd = hq ? 0.005 + 0.99 * seed : seed
      const w = (s, yy) => [kind, u0 + s * us, yy - (foot < y0 ? foot : base), sd + use + dr + hq]
      if (arch && arch !== 3 && arch !== 12 && !party) FAC = [128 | arch, trim, 0, 0]
      else if (looks && !party) FAC = looks.subarray(i * 4, i * 4 + 4)
      quad(W, [a[0], foot, -a[1]], [p[0], foot, -p[1]], [p[0], y1, -p[1]], [a[0], y1, -a[1]], wall, [nx, 0, nz], w(0, foot), w(len, foot), w(len, y1), w(0, y1))
      FAC = NOFAC
      if (towerNames.length && !party && len >= 6) { // a named tower's name over the door (the bake put its record on this wall)
        const q = towerNames.find((r) => Math.hypot(r.x - mx, r.y - my) < 1.5)
        if (q) {
          const w = Math.min(len - 0.6, 2.2 + q.name.length * 0.28, 6.5)
          let hh = 0; for (let c = 0; c < q.name.length; c++) hh = (hh * 31 + q.name.charCodeAt(c)) >>> 0
          extraSigns.push({ x: mx, y: my, z: foot + SIGN_Z, nx, ny: -nz, w, kind: 5 | (2 << 3), name: q.name })
        }
      }
      if (ring && !party && len >= 3 && y1 - foot >= 5 && (arch === 13 ? shopEdges[i] : streetSide(a, p, carriage, 18))) { // a cornice box 0.4 m out and 0.6 m tall under the top (the ring is mitred, so corners meet)
        const A = ring[i], P = ring[(i + 1) % np], cc = shade(wall, 1.12), cw = ROOFW(seed), yb = y1 - 0.6
        quad(W, [A[0], yb, -A[1]], [P[0], yb, -P[1]], [P[0], y1, -P[1]], [A[0], y1, -A[1]], cc, [nx, 0, nz], cw)
        quad(W, [a[0], yb, -a[1]], [p[0], yb, -p[1]], [P[0], yb, -P[1]], [A[0], yb, -A[1]], shade(cc, 0.6), [0, -1, 0], cw)
        quad(W, [a[0], y1, -a[1]], [p[0], y1, -p[1]], [P[0], y1, -P[1]], [A[0], y1, -A[1]], cc, [0, 1, 0], cw)
      }
      if (i === door && !party && (arch === 7 || arch === 8)) { // a canopy over the entrance (materials.js draws the double door in the middle bay)
        const f = ((nb >> 1) + 0.5) / nb, ex = (p[0] - a[0]) / len, ey = (p[1] - a[1]) / len
        box3(Bal, a[0] + (p[0] - a[0]) * f + ey * 0.6, a[1] + (p[1] - a[1]) * f - ex * 0.6, foot + 2.6, 2.6, 1.2, 0.12, Math.atan2(ey, ex), shade(wall, 0.9))
      }
      if (i === door && !party && (arch === 1 || arch === 2) && streetSide(a, p, carriage, 27) >= 9) { // a stoop: a landing and three steps at the door bay (materials.js lifts the door 0.5 m)
        const f = ((nb >> 1) + 0.5) / nb, ex = (p[0] - a[0]) / len, ey = (p[1] - a[1]) / len, cx = a[0] + (p[0] - a[0]) * f, cy = a[1] + (p[1] - a[1]) * f
        const clear = (d) => ![-0.7, 0.7].some((s) => grid.get(gk(Math.floor((cx + ex * s + ey * d) / G), Math.floor((cy + ey * s - ex * d) / G)))?.some((b) => inPoly(cx + ex * s + ey * d, cy + ey * s - ex * d, b.pts)))
        if (clear(1.7) && clear(1.0)) stoop(Bal, cx, cy, ex, ey, foot, terr, wall)
      }
      if (arch === 14 && !party && mn < 0.5 && len >= 6 && shopEdges?.[i] && lot && streetSide(a, p, lot, 12) && !streetSide(a, p, carriage, 9) && h >= 3.2) canopy(Bal, a, p, len, foot, terr, solidsOut, seed, (x, y) => grid.get(gk(Math.floor(x / G), Math.floor(y / G)))?.some((b) => b !== rec && inPoly(x, y, b.pts))) // a strip mall's walk over the car park side
      if (shopEdges?.[i] && mn < 2.5 && h >= 4) {
        fronts.push(a[0], a[1], p[0], p[1], foot) // (the shop signs, on the fascia over the glass)
        if (!party && len >= 3 && wk < 23 && ((seed * 7919) % 1) < 0.6) awnings(W, a, p, len, foot, nx, nz, seed)
      }
      if (plinth && foot === y0) quad(W, [a[0], lo, -a[1]], [p[0], lo, -p[1]], [p[0], y0, -p[1]], [a[0], y0, -a[1]], plC, [nx, 0, nz], [0, 0, 0, seed], [0, len, 0, seed], [0, len, 0, seed], [0, 0, 0, seed])
    }
    if (detail && arch === 14 && mn < 0.5 && np <= 60) strips.push({ pts, h: y1 - y0, gid })
    if (detail && mn > 1.5) { // a raised part's underside (an overhang, a skybridge, a canopy): from under it you looked up into it
      const tris = earcut2(pts), c = shade(roofC, 0.62), w = ROOFW(seed)
      for (let i = 0; i < tris.length; i += 3) { const A = pts[tris[i]], B = pts[tris[i + 1]], C = pts[tris[i + 2]]; tri(W, [A[0], y0, -A[1]], [B[0], y0, -B[1]], [C[0], y0, -C[1]], c, [0, -1, 0], w) }
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
    } else roof(W, pts, y1, base + ridge, roofShape, roofBits, roofC, wall, seed, detail && arch && arch !== 3 && arch < 12 ? lin(TRIM[trim]) : null)
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
  // strip malls' pylon signs where a service drive meets the lot (BUILDINGS.md step 3)
  if (detail && strips.length && lot && carriage) pylons(t, terr, lines, carriage, lot, strips, (x, y) => grid.get(gk(Math.floor(x / G), Math.floor(y / G)))?.some((b) => inPoly(x, y, b.pts)), Bal, solidsOut, extraSigns)
  if (detail && t.sections.FNCE) fences(t, terr, carriage, (x, y) => grid.get(gk(Math.floor(x / G), Math.floor(y / G)))?.some((b) => inPoly(x, y, b.pts)), Bal, solidsOut)
  for (const [x, y, a, l, w] of solidsOut) { // (before the parked cars: they keep clear of them)
    const X = x + t.ox, Y = y + t.oy, fx = Math.cos(a), fy = Math.sin(a)
    for (const [pp, q] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) fp.push(X + fx * pp * l + fy * q * w, Y + fy * pp * l - fx * q * w)
    fpStart.push(fp.length)
  }
  return { extraSigns, fronts, walls: pack(W), balconies: Bal.pos.length ? pack(Bal) : null,
    footprints: fpStart.length > 1 ? { pts: new Float32Array(fp), start: new Uint32Array(fpStart) } : null, spill,
    overhangs: ohLo.length ? { pts: new Float32Array(oh), start: new Uint32Array(ohStart), lo: new Float32Array(ohLo) } : null,
    ao: AO.P.length ? { position: new Float32Array(AO.P), t: new Float32Array(AO.T), index: AO.P.length / 3 > 65535 ? new Uint32Array(AO.I) : new Uint16Array(AO.I) } : null }
}
// a front stoop at tile-local (cx, cy) on a wall running (ex, ey): 1.4 m wide, a 0.5 m landing and two lower steps, 1.5 m out
function stoop(B, cx, cy, ex, ey, foot, terr, wall) {
  const a = Math.atan2(ey, ex), nx = ey, ny = -ex, c = lin(0xb7b2a8)
  let g = foot
  for (const [d, q] of [[0.2, 0], [1.5, 0.7], [1.5, -0.7]]) g = Math.min(g, groundOut(terr, cx + nx * d + ex * q, cy + ny * d + ey * q))
  g -= 0.05
  for (const [d0, d1, top] of [[0, 0.9, 0.5], [0.9, 1.2, 0.33], [1.2, 1.5, 0.17]]) box3(B, cx + nx * (d0 + d1) / 2, cy + ny * (d0 + d1) / 2, g, 1.4, d1 - d0, foot + top - g, a, c)
}
const CANOPY = [0x7a2f2a, 0x3a4a5c, 0x4a4f50, 0x2f4a3a, 0x8a6a2a]
// a strip mall's canopy along a wall that looks onto its car park: a slab 2.4 m out at 3 m, a post every 6 m (footprints: sol)
function canopy(B, a, p, len, foot, terr, sol, seed, blocked) {
  const ex = (p[0] - a[0]) / len, ey = (p[1] - a[1]) / len, nx = ey, ny = -ex, D = 2.4, L = len - 0.6
  const at = (s, d) => [a[0] + ex * (0.3 + s) + nx * d, a[1] + ey * (0.3 + s) + ny * d]
  for (const s of [0, L / 2, L]) if (blocked(...at(s, D))) return
  const [mx, my] = at(L / 2, D / 2)
  box3(B, mx, my, foot + 3.0, L, D, 0.18, Math.atan2(ey, ex), lin(CANOPY[Math.floor(seed * 7919) % CANOPY.length]))
  const n = Math.max(1, Math.ceil(L / 6))
  for (let k = 0; k <= n; k++) {
    const [x, y] = at(Math.min(L - 0.1, Math.max(0.1, (L * k) / n)), D - 0.15)
    if (blocked(x, y)) continue
    post(B, x, y, groundOut(terr, x, y), foot + 3.0)
    sol.push([x, y, 0, 0.12, 0.12])
  }
}
// the FNCE section (tools/tiles.py: kind 0 fence, 1 wall, 2 hedge, height dm, a ring of points a piece): a chain-link strip in the
// railing pattern, a low wall, a hedge box, each in pieces of 4 m or less that follow the ground; none in a building or on a carriageway.
// They stand in the footprints too (solid: 0.1 m half width, the hedge's 0.45). Near-only, in the detail mesh.
const FENCE_C = lin(0x8a8d90), WALL_C = lin(0xbdb6a8), HEDGE_C = [lin(0x3f6b34), lin(0x4a7a3a), lin(0x365d30)]
function fences(t, terr, carriage, inAny, B, sol) {
  const s = t.sections.FNCE, dv = t.dv, n = dv.getUint32(s.off, true)
  let o = s.off + 4
  const free = (x, y) => !inAny(x, y) && !(carriage && [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]].some(([dx, dy]) => onMask(carriage, x + dx, y + dy)))
  for (let i = 0; i < n; i++) {
    const kind = dv.getUint8(o), hd = dv.getUint8(o + 1); const [P, o2] = readRing(t, o + 2); o = o2
    const h = kind === 0 ? 1.12 : kind === 1 ? Math.min(2.4, Math.max(0.5, hd / 10 || 1.1)) : Math.min(3, Math.max(0.8, hd / 10 || 1.4))
    let u = 0
    for (let j = 0; j < P.length / 2 - 1; j++) {
      const ax = P[j * 2], ay = P[j * 2 + 1], dx = P[j * 2 + 2] - ax, dy = P[j * 2 + 3] - ay, L = Math.hypot(dx, dy), m = Math.max(1, Math.ceil(L / 4))
      for (let k = 0; k < m; k++) {
        const x0 = ax + (dx * k) / m, y0 = ay + (dy * k) / m, x1 = ax + (dx * (k + 1)) / m, y1 = ay + (dy * (k + 1)) / m, l = L / m, mx = (x0 + x1) / 2, my = (y0 + y1) / 2
        const u0 = u; u += l
        if (!free(mx, my) || !free(x0, y0) || !free(x1, y1)) continue
        const g0 = groundOut(terr, x0, y0), g1 = groundOut(terr, x1, y1), a = Math.atan2(dy, dx), nx = dy / L, nz = dx / L
        if (kind === 0) {
          const rw = (uu, hh) => [12, uu, hh, 0.5]
          for (const q of [1, -1]) quad(B, [x0, g0 - 0.05, -y0], [x1, g1 - 0.05, -y1], [x1, g1 + h, -y1], [x0, g0 + h, -y0], FENCE_C, [nx * q, 0, nz * q], rw(u0, 0.06), rw(u, 0.06), rw(u, 1.16), rw(u0, 1.16))
        } else {
          const g = Math.min(g0, g1) - 0.1, hw = kind === 1 ? 0.1 : 0.45
          box3(B, mx, my, g, l + (kind === 2 ? 0.3 : 0.02), hw * 2, h + 0.1, a, kind === 1 ? WALL_C : HEDGE_C[(i + k) % 3])
        }
        sol.push([mx, my, a, l / 2, kind === 0 ? 0.08 : hw])
      }
    }
  }
}
// the SHOP section's names, tile-local: [{ x, y, name }]
function shopNames(t) {
  const s = t.sections.SHOP, out = []
  if (!s) return out
  const dv = t.dv, n = dv.getUint32(s.off, true)
  for (let i = 0, o = s.off + 4; i < n; i++) {
    const ln = dv.getUint8(o + 5)
    out.push({ kind: dv.getUint8(o), x: dv.getInt16(o + 1, true) * t.k, y: dv.getInt16(o + 3, true) * t.k, name: new TextDecoder().decode(new Uint8Array(t.buf, o + 6, ln)) }); o += 6 + ln
  }
  return out
}
// a pylon sign for each strip mall: where an OSM service way enters the mall's car park off a street (a carriageway within 14 m of
// where it crosses the lot's edge), 2 m inside the lot and 4.2 m off the drive; three boards in the shops' own names (shop signs
// plugin: two entries a board, one a side). No SHOP names near, no entry, or no clear spot: none.
function pylons(t, terr, lines, carriage, lot, strips, inAny, B, sol, out) {
  const names = shopNames(t)
  if (!names.length) return
  const ent = []
  const nearLot = (x, y) => [[0, 0], [3.5, 0], [-3.5, 0], [0, 3.5], [0, -3.5]].some(([dx, dy]) => onMask(lot, x + dx, y + dy)) // (the drive is road ground: the lot's cells begin beside it)
  for (const L of lines) {
    if (L.kind !== K.service || L.z || L.tunnel) continue
    const P = L.pts, pts = []
    for (let i = 0; i < P.length / 2 - 1; i++) {
      const dx = P[i * 2 + 2] - P[i * 2], dy = P[i * 2 + 3] - P[i * 2 + 1], n = Math.max(1, Math.ceil(Math.hypot(dx, dy)))
      for (let k = 0; k < n; k++) pts.push([P[i * 2] + (dx * k) / n, P[i * 2 + 1] + (dy * k) / n])
    }
    pts.push([P[P.length - 2], P[P.length - 1]])
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], in0 = nearLot(x0, y0), in1 = nearLot(x1, y1)
      if (in0 === in1) continue
      const [ex, ey] = in1 ? [x1, y1] : [x0, y0], d = Math.hypot(x1 - x0, y1 - y0) || 1, sg = in1 ? 1 : -1
      ent.push({ x: ex, y: ey, ux: ((x1 - x0) / d) * sg, uy: ((y1 - y0) / d) * sg })
    }
  }
  const nearStreet = (x, y) => { for (const r of [4, 8, 12, 14]) for (let k = 0; k < 8; k++) if (onMask(carriage, x + r * Math.cos(k * Math.PI / 4), y + r * Math.sin(k * Math.PI / 4))) return true; return false }
  const made = []
  for (const sp of strips) {
    let cx = 0, cy = 0
    for (const [x, y] of sp.pts) { cx += x / sp.pts.length; cy += y / sp.pts.length }
    let best = 100 * 100, e = null
    for (const c of ent) { const q = (c.x - cx) ** 2 + (c.y - cy) ** 2; if (q < best && nearStreet(c.x, c.y)) { best = q; e = c } }
    if (!e || made.some((m) => (m.x - e.x) ** 2 + (m.y - e.y) ** 2 < 100)) continue
    const nm = []
    for (const q of names) if ((q.x - cx) ** 2 + (q.y - cy) ** 2 < 80 * 80 && !nm.includes(q.name)) nm.push(q.name)
    if (!nm.length) continue
    for (const sd of [1, -1]) {
      const px = e.x + e.ux * 2 - e.uy * sd * 4.2, py = e.y + e.uy * 2 + e.ux * sd * 4.2
      const ok = [[0.9, 0.4], [-0.9, 0.4], [0.9, -0.4], [-0.9, -0.4]].every(([u, v]) => { const x = px + e.ux * u - e.uy * v, y = py + e.uy * u + e.ux * v; return onMask(lot, x, y) && !onMask(carriage, x, y) && !inAny(x, y) })
      if (!ok) continue
      made.push({ x: e.x, y: e.y })
      const a = Math.atan2(e.uy, e.ux), g = groundOut(terr, px, py)
      box3(B, px, py, g, 1.6, 0.5, 6.5, a, lin(0x4a4d52))
      sol.push([px, py, a, 0.8, 0.25])
      nm.slice(0, 3).forEach((name, j) => {
        for (const f of [1, -1]) {
          let h = 0; for (let c = 0; c < name.length; c++) h = (h * 31 + name.charCodeAt(c)) >>> 0
          out.push({ x: px - e.uy * f * 0.27, y: py + e.ux * f * 0.27, z: g + 5.9 - j * 0.55, nx: -e.uy * f, ny: e.ux * f, w: 1.5, kind: h % 3 << 3, name })
        }
      })
      break
    }
  }
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
// a storefront's awnings along the wall a -> p (outward nx, nz in x, z): one a shop (about 7.5 m), sloping 1.3 m out
// from 3 m up, a valance at the front, each its own canvas colour; seen from under them too
const AWN = [0x2f5a3c, 0x7a2a2a, 0x1f2e4a, 0x2a2a2a, 0xb0402e, 0x8a6a3a, 0x3a6a7a, 0x5a2a4a].map(lin)
function awnings(W, a, p, len, foot, nx, nz, seed) {
  const n = Math.max(1, Math.round(len / 7.5)), ex = (p[0] - a[0]) / len, ey = (p[1] - a[1]) / len, ox = nx * 1.3, oy = -nz * 1.3, pw = ROOFW(seed)
  const y0 = foot + 3.05, y1 = foot + 2.6, yv = y1 - 0.28
  for (let k = 0; k < n; k++) {
    const c = AWN[Math.floor(((seed * 13.7 + k * 0.381) % 1) * AWN.length)], s0 = (k * len) / n + 0.3, s1 = ((k + 1) * len) / n - 0.3
    const A = [a[0] + ex * s0, a[1] + ey * s0], P = [a[0] + ex * s1, a[1] + ey * s1]
    const top = [[A[0], y0, -A[1]], [P[0], y0, -P[1]], [P[0] + ox, y1, -(P[1] + oy)], [A[0] + ox, y1, -(A[1] + oy)]]
    quad(W, ...top, c, [nx * 0.4, 1, nz * 0.4], pw)
    quad(W, ...top, shade(c, 0.6), [-nx * 0.4, -1, -nz * 0.4], pw) // (its underside)
    quad(W, top[3], top[2], [P[0] + ox, yv, -(P[1] + oy)], [A[0] + ox, yv, -(A[1] + oy)], shade(c, 0.9), [nx, 0, nz], pw)
  }
}
// a porch post (0.2 m square) from the ground at y0 up to y1 at tile-local (x, y north)
function post(W, x, y, y0, y1) {
  const r = 0.1, c = lin(0xf2f0ea), pw = ROOFW(0.5), P = (dx, dy, yy) => [x + dx, yy, -(y + dy)]
  for (const [dx, dy, ex, ey] of [[-r, -r, 1, 0], [r, -r, 0, 1], [r, r, -1, 0], [-r, r, 0, -1]])
    quad(W, P(dx, dy, y0), P(dx + 2 * r * ex, dy + 2 * r * ey, y0), P(dx + 2 * r * ex, dy + 2 * r * ey, y1), P(dx, dy, y1), c, [ey, 0, ex], pw)
}
// the lowest drawn ground along each wall of a counter-clockwise ring, at its foot and 0.6 m out (every 2 m)
function wallLows(terr, pts) {
  const n = pts.length
  return pts.map((a, i) => {
    const p = pts[(i + 1) % n], l = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1, k = Math.ceil(l / 2), ox = ((p[1] - a[1]) / l) * 0.6, oy = (-(p[0] - a[0]) / l) * 0.6
    let lo = Infinity
    for (let s = 0; s <= k; s++) { const x = a[0] + ((p[0] - a[0]) * s) / k, y = a[1] + ((p[1] - a[1]) * s) / k; lo = Math.min(lo, groundOut(terr, x, y), groundOut(terr, x + ox, y + oy)) }
    return lo
  })
}
// the window bay a facade pattern lays along a wall (materials.js, by the pattern after the wall's LiDAR glazing: LOOK_STYLE;
// lb: the LiDAR's bay code)
const LOOK_STYLE = [1, 1, 16, 10, 2, 17, 1, 1]
function bayOf(style, lb) {
  const b = lb > 0.5 ? 0.5 + 0.05 * lb : 0
  if (style === 2) return b ? Math.min(3.2, Math.max(1, b)) : 1.6
  if (style === 10) return b ? Math.min(3, Math.max(1, b)) : 1.5
  if (style === 3) return 3.2
  if (style === 9) return 1.5
  if (style === 5) return 3.4
  if (style === 8) return 4.2
  if (style === 6) return 0.9
  if (style === 21) return 3.4
  if (style === 22) return 3.6
  if (style === 23) return b ? Math.min(3.2, Math.max(1, b)) : 1.7
  if (style === 24) return 2.6
  if (style === 17) return 4
  if (style === 1 || style === 16) return b || 3
  return 0.5 // (big box, blank walls: no bays to fit)
}
const onMask = (R, x, y) => { const i = Math.floor(x), j = Math.floor(y); if (i < 0 || j < 0 || i >= R.n || j >= R.n) return false; const k = j * R.n + i; return !!(R.bits[k >> 3] & (1 << (k & 7))) }
// does the wall a -> p (a counter-clockwise ring's) look onto a street: 3 m long or more, a carriageway within 18 m straight out
// (or within `far` m): how far, 0 if not
function streetSide(a, p, R, far = 18) {
  const len = Math.hypot(p[0] - a[0], p[1] - a[1])
  if (len < 3) return 0
  const nx = (p[1] - a[1]) / len, ny = -(p[0] - a[0]) / len, mx = (a[0] + p[0]) / 2, my = (a[1] + p[1]) / 2
  for (let d = 3; d <= far; d += 3) if (onMask(R, mx + nx * d, my + ny * d)) return d
  return 0
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
  const gore = gores([...lines.filter(stripped), ...readLines(t, 'XDCK').filter(stripped)])
  for (const L of lines) {
    const lit = LAMP[L.kind]
    if (!lit || L.layer < 0 || L.tunnel || L.crossing) continue
    const trim = L.z && stripped(L) ? gore(L) : null
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
        if (!f_ || (up && trim && trim(cx, cy, -ey, ex, 1, L.w / 2, L.z[i] + (L.z[i + 1] - L.z[i]) * f)[side > 0 ? 0 : 1] < off)) continue // (none where the deck is trimmed at a gore)
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
// one stretch i to j of a kerb with a railing over it (at(i, off, y): the point `off` out from the edge at i, T thick, R from the
// centre): the kerb from y0 to y0 + ph (its outer face down to yb), and, when `fence`, the railing (materials.js pattern 12) to 1.2 m
function rail(W, Bal, at, i, j, R, T, y0i, y0j, ybi, ybj, ph, out, inw, ua, ub, fence) {
  const pw = ROOFW(0.5)
  quad(W, at(i, R + T, ybi), at(j, R + T, ybj), at(j, R + T, y0j + ph), at(i, R + T, y0i + ph), PARAPET, out, pw) // outer face, over the deck's edge
  quad(W, at(i, R, y0i), at(j, R, y0j), at(j, R, y0j + ph), at(i, R, y0i + ph), PARAPET, inw, pw)
  quad(W, at(i, R, y0i + ph), at(j, R, y0j + ph), at(j, R + T, y0j + ph), at(i, R + T, y0i + ph), shade(PARAPET, 1.06), [0, 1, 0], pw)
  if (!fence) return
  const rw = (uu, h) => [12, uu, h, 0.5] // along, height over the deck
  for (const want of [out, inw]) quad(Bal, at(i, R + T / 2, y0i + ph), at(j, R + T / 2, y0j + ph), at(j, R + T / 2, y0j + 1.2), at(i, R + T / 2, y0i + 1.2), RAILING, want, rw(ua, ph), rw(ub, ph), rw(ub, 1.2), rw(ua, 1.2))
}
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
        rail(W, Bal, at, i, j, R, T, z[i] + top, z[j] + top, z[i] - 0.5, z[j] - 0.5, ph, out, inw, u - len, u, foot)
      }
    }
  }
}
// fixed piers: timber fascia under the deck's edge, square piles every PILE_STEP m down to under the lowest tide, and a railing
// (flag 2) with gaps where a stair, ramp or gangway (a deck line or steps) meets the edge. Per 2 m of every ring edge off the tile's edge
const TIMBER = lin(0x7a6248), DECK_RAIL_GAP = 2.5
function piers(W, Bal, decks, terr, lines, size) {
  if (!decks.length) return
  const opens = lines.filter((L) => L.kind === K.steps || (L.z && !L.tunnel)) // where the rail stops
  const gap = (x, y) => opens.some((L) => {
    for (let i = 0; i < L.pts.length / 2 - 1; i++) {
      const ax = L.pts[i * 2], ay = L.pts[i * 2 + 1], dx = L.pts[i * 2 + 2] - ax, dy = L.pts[i * 2 + 3] - ay, f = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
      if (Math.hypot(x - ax - dx * f, y - ay - dy * f) < DECK_RAIL_GAP) return true
    }
    return false
  })
  const edge = (u) => Math.abs(u) < 1e-3 || Math.abs(u - size) < 1e-3
  const top = (d, x, y) => Math.max(heightAt(terr, x, y, true) + PIER_LAY, d.z)
  for (const d of decks) {
    d.rings.forEach((ring, r) => {
      const n = ring.length / 2
      if (n < 3) return
      let area = 0
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1] }
      const sg = (area > 0 ? 1 : -1) * (r ? -1 : 1) // outward (away from the deck): right of a counter-clockwise outer ring
      let s0 = 0, nextPile = 0
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ax = ring[i * 2], ay = ring[i * 2 + 1], bx = ring[j * 2], by = ring[j * 2 + 1], L = Math.hypot(bx - ax, by - ay)
        if (L < 1e-3) continue
        const ex = (by - ay) / L * sg, ey = -(bx - ax) / L * sg // outward normal (x east, y north)
        if (!((edge(ax) && edge(bx) && Math.abs(ax - bx) < 1e-3) || (edge(ay) && edge(by) && Math.abs(ay - by) < 1e-3))) {
          const k = Math.max(1, Math.ceil(L / 2)), out = [ex, 0, -ey], inw = [-ex, 0, ey]
          let prev = null
          for (let m = 0; m <= k; m++) {
            const f = m / k, x = ax + (bx - ax) * f, y = ay + (by - ay) * f, g = heightAt(terr, x, y, true), zt = top(d, x, y), air = zt - g
            if (prev && prev.air > 0.3 && air > 0.3) {
              const P0 = [prev.x, prev.zt, -prev.y], P1 = [x, zt, -y]
              quad(W, [P0[0], P0[1] - PIER_THICK, P0[2]], [P1[0], P1[1] - PIER_THICK, P1[2]], P1, P0, TIMBER, out, ROOFW(0.5))
            }
            if (d.flags & 2 && prev && prev.air > 0.6 && air > 0.6 && !gap((x + prev.x) / 2, (y + prev.y) / 2)) {
              const ps = [prev, { x, y, zt }]
              const atI = (i2, off, yy) => { const q = ps[i2]; return [q.x + ex * (off - 0.25), yy, -(q.y + ey * (off - 0.25))] } // (the rail's outer face on the edge, 0.25 m thick inward)
              rail(W, Bal, atI, 0, 1, 0, 0.25, prev.zt, zt, prev.zt - 0.2, zt - 0.2, 0.15, out, inw, s0 + L * (m - 1) / k, s0 + L * m / k, true)
            }
            prev = { x, y, zt, air }
          }
          // piles: every PILE_STEP m along the ring (from its first point), PILE_IN inside the edge
          for (; nextPile < s0 + L; nextPile += PILE_STEP) {
            if (nextPile < s0) continue
            const f = (nextPile - s0) / L, x = ax + (bx - ax) * f - ex * PILE_IN, y = ay + (by - ay) * f - ey * PILE_IN, g = heightAt(terr, x, y, true), zt = top(d, x, y)
            if (zt - g > 0.6) box3(W, x, y, Math.min(g, SEA0) - PILE_DEEP, PILE, PILE, zt - PIER_THICK - (Math.min(g, SEA0) - PILE_DEEP), 0, shade(TIMBER, 0.8))
          }
        } else while (nextPile < s0 + L) nextPile += PILE_STEP
        s0 += L
      }
    })
  }
}
// the seawalls (tools/seawall.py, terrain()'s wall): a stone face from the walk's edge (the drawn ground on top) down
// past the water or sand at its foot (SW_DEEP under it: under the lowest tide, #605), a coping stone along its top
// (0.7 m wide over the line, 6 cm proud of the walk), closed at the ends of each stretch that stands, and a railing on
// it where OSM maps one. Its own tile's stretch only (the pieces reach 60 m past it for the ground)
const STONE = lin(0x9d978b), COPING = lin(0xc8c2b4), SW_FACE = 18, SW_DEEP = 3 // materials.js pattern 18: stone courses
function seawalls(W, Bal, WL, terr) {
  const P = WL.P, R = WL.runs, inside = (x, y) => x >= 0 && y >= 0 && x <= terr.size && y <= terr.size
  for (let r = 0; r < R.length - 1; r++) {
    const n = R[r + 1] - R[r], o = R[r], xy = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) { xy[i * 2] = P[(o + i) * 7]; xy[i * 2 + 1] = P[(o + i) * 7 + 1] }
    const side = sides(xy), top = [], low = []
    for (let i = 0; i < n; i++) { top.push(heightAt(terr, xy[i * 2], xy[i * 2 + 1], false)); low.push(heightAt(terr, xy[i * 2], xy[i * 2 + 1], true)) }
    const at = (i, off, y) => [xy[i * 2] + side[i][0] * off, y, -(xy[i * 2 + 1] + side[i][1] * off)]
    const stands = (i) => i >= 0 && i < n - 1 && Math.max(top[i] - low[i], top[i + 1] - low[i + 1]) >= 0.3
    let u = 0
    for (let i = 0; i < n - 1; i++) {
      const j = i + 1, len = Math.hypot(xy[j * 2] - xy[i * 2], xy[j * 2 + 1] - xy[i * 2 + 1]); u += len
      const mx = (xy[i * 2] + xy[j * 2]) / 2, my = (xy[i * 2 + 1] + xy[j * 2 + 1]) / 2
      if (!inside(mx, my) || !stands(i)) continue
      const nx = side[i][0] + side[j][0], ny = side[i][1] + side[j][1], l = Math.hypot(nx, ny) || 1, out = [-nx / l, 0, ny / l], up = [0, 1, 0], inw = [nx / l, 0, -ny / l]
      const c0 = top[i] + 0.06, c1 = top[j] + 0.06, f0 = Math.min(low[i], top[i] - 0.3) - SW_DEEP, f1 = Math.min(low[j], top[j] - 0.3) - SW_DEEP, seed = (o + i) % 7 / 7
      const sw = (uu, z) => [SW_FACE, uu, z, seed]
      // (the face just out past the cut in the ground along the line, tools/tiles.py; the coping over the cut)
      quad(W, at(i, -0.22, f0), at(j, -0.22, f1), at(j, -0.22, c1), at(i, -0.22, c0), STONE, out, sw(u - len, f0), sw(u, f1), sw(u, c1), sw(u - len, c0))
      quad(W, at(i, -0.25, c0), at(j, -0.25, c1), at(j, 0.45, c1), at(i, 0.45, c0), COPING, up, ROOFW(0.5))
      quad(W, at(i, -0.25, c0 - 0.12), at(j, -0.25, c1 - 0.12), at(j, -0.25, c1), at(i, -0.25, c0), COPING, out, ROOFW(0.5))
      quad(W, at(i, 0.45, top[i] - 0.05), at(j, 0.45, top[j] - 0.05), at(j, 0.45, c1), at(i, 0.45, c0), COPING, inw, ROOFW(0.5))
      // where the wall starts or stops standing (a run's end, where it fades into the ground): the stone's end closed
      const ax = (xy[j * 2] - xy[i * 2]) / (len || 1), ay = (xy[j * 2 + 1] - xy[i * 2 + 1]) / (len || 1)
      for (const [e, k, c, f, sg] of [[i - 1, i, c0, f0, -1], [j, j, c1, f1, 1]]) {
        if (stands(e)) continue
        const end = [sg * ax, 0, -sg * ay]
        quad(W, at(k, -0.25, c - 0.12), at(k, 0.45, top[k] - 0.05), at(k, 0.45, c), at(k, -0.25, c), COPING, end, ROOFW(0.5))
        quad(W, at(k, -0.22, f), at(k, 0.2, f), at(k, 0.2, c), at(k, -0.22, c), STONE, end, sw(0, f), sw(0.42, f), sw(0.42, c), sw(0, c))
      }
      if (P[(o + i) * 7 + 6] && P[(o + j) * 7 + 6]) {
        const rw = (uu, h) => [12, uu, h, 0.5] // materials.js pattern 12 (railings())
        for (const want of [out, inw]) quad(Bal, at(i, 0.2, c0), at(j, 0.2, c1), at(j, 0.2, c1 + 1.1), at(i, 0.2, c0 + 1.1), RAILING, want, rw(u - len, 0.06), rw(u, 0.06), rw(u, 1.16), rw(u - len, 1.16))
      }
    }
  }
}
// tunnels (tools/tiles.py tunnel_profiles): a dark tube round the road all the way (seen from both sides, so a chase
// camera that swings out of it on a bend sees its walls), and where the bake cut the ground near a portal its concrete
// box, roof flush with the ground, and at the portal a face with the opening in it
const TUBE_H = (kind) => (kind === K.rail || kind === K.lightrail ? 6 : kind >= K.pedestrian ? 3 : 5), SLAB = 0.6 // tools/tiles.py tube_h, SLAB
const TUBE_IN = lin(0x38393c), TUBE_FLOOR = lin(0x2e3033), CONCRETE = lin(0xb4b0a6)
// Twin tubes mapped closer than they are wide (the George Massey tunnel's two) share the wall between them, halfway:
// each tunnel piece's inner half width at its points, to its left and right (L.wall), and the least of them (L.tw:
// the drive plugin's walls)
function tubeWalls(lines) {
  const T = lines.filter((L) => L.tunnel && L.z && L.pts.length >= 4)
  for (const L of T) {
    const P = L.pts, n = P.length / 2, hw = L.w / 2 + 0.6, side = sides(P), wall = new Float32Array(n * 2).fill(hw)
    for (const Q of T) {
      if (Q === L) continue
      const B = Q.pts, m = B.length / 2 - 2
      for (let i = 0; i < n; i++) {
        const x = P[i * 2], y = P[i * 2 + 1]
        let d = 1e9, at = null
        for (let k = 0; k <= m; k++) {
          const ax = B[k * 2], ay = B[k * 2 + 1], dx = B[k * 2 + 2] - ax, dy = B[k * 2 + 3] - ay, l2 = dx * dx + dy * dy || 1, u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)), e = Math.hypot(x - ax - dx * u, y - ay - dy * u)
          if (e < d) { d = e; at = [ax + dx * u, ay + dy * u, Q.z[k] + (Q.z[k + 1] - Q.z[k]) * u, dx, dy, (k === 0 && u === 0) || (k === m && u === 1)] }
        }
        if (!at || at[5] || d >= hw + Q.w / 2 + 0.6 + 0.3 || Math.abs(at[2] - L.z[i]) > 3) continue // (Q goes on from L's end; clear of it; over or under it)
        if (Math.abs(at[3] * side[i][2] + at[4] * side[i][3]) < 0.77 * Math.hypot(at[3], at[4])) continue // (across it)
        const e = (at[0] - x) * side[i][0] + (at[1] - y) * side[i][1] > 0 ? 0 : 1
        wall[i * 2 + e] = Math.min(wall[i * 2 + e], Math.max(1.5, d / 2 - 0.15))
      }
    }
    L.wall = wall; L.tw = Math.min(...wall)
  }
}
function tubes(W, lines) {
  const pw = ROOFW(0.5)
  for (const L of lines) {
    if (!L.tunnel || !L.z || !L.tube) continue
    const P = L.pts, z = L.z, n = P.length / 2, H = TUBE_H(L.kind), hw = L.w / 2 + 0.6, side = sides(P)
    const wl = (i, sg) => L.wall ? L.wall[i * 2 + (sg > 0 ? 0 : 1)] : hw // the wall's inside, from the centre line
    const at = (i, sg, off, y) => [P[i * 2] + side[i][0] * sg * off, y, -(P[i * 2 + 1] + side[i][1] * sg * off)]
    const in_ = (i, sg, y) => at(i, sg, wl(i, sg), y), out = (i, sg, y) => at(i, sg, wl(i, sg) + SLAB, y)
    const both = (a, b, c, d, col, want) => { quad(W, a, b, c, d, col, want, pw); quad(W, a, b, c, d, col, want.map((v) => -v), pw) }
    for (let i = 0; i < n - 1; i++) {
      const j = i + 1, nx = side[i][0] + side[j][0], nn = side[i][1] + side[j][1], l = Math.hypot(nx, nn) || 1
      for (const sg of [1, -1]) both(in_(i, sg, z[i]), in_(j, sg, z[j]), in_(j, sg, z[j] + H), in_(i, sg, z[i] + H), TUBE_IN, [(sg * nx) / l, 0, (-sg * nn) / l])
      both(in_(i, -1, z[i] + H), in_(j, -1, z[j] + H), in_(j, 1, z[j] + H), in_(i, 1, z[i] + H), TUBE_IN, [0, -1, 0])
      quad(W, in_(i, -1, z[i] + 0.25), in_(j, -1, z[j] + 0.25), in_(j, 1, z[j] + 0.25), in_(i, 1, z[i] + 0.25), TUBE_FLOOR, [0, 1, 0], pw)
      if (!L.tube[i] && !L.tube[j]) continue
      for (const sg of [1, -1]) if (wl(i, sg) >= hw && wl(j, sg) >= hw) quad(W, out(i, sg, z[i] - 0.5), out(j, sg, z[j] - 0.5), out(j, sg, z[j] + H + SLAB), out(i, sg, z[i] + H + SLAB), CONCRETE, [(sg * nx) / l, 0, (-sg * nn) / l], pw) // (not the wall twin tubes share)
      quad(W, out(i, -1, z[i] + H + SLAB), out(j, -1, z[j] + H + SLAB), out(j, 1, z[j] + H + SLAB), out(i, 1, z[i] + H + SLAB), CONCRETE, [0, 1, 0], pw)
    }
    for (const i of [0, n - 1]) { // the portal: pillars either side of the opening, a headwall over it
      if (L.tube[i] !== 2) continue
      const [, , tx, ty] = side[i], o = i ? 1 : -1, a = Math.atan2(ty, tx), x = P[i * 2] + tx * o * 0.2, y = P[i * 2 + 1] + ty * o * 0.2
      for (const sg of [1, -1]) box3(W, x + side[i][0] * sg * (wl(i, sg) + SLAB / 2), y + side[i][1] * sg * (wl(i, sg) + SLAB / 2), z[i] - 0.5, 0.8, SLAB, H + 0.5, a, CONCRETE)
      const c = (wl(i, 1) - wl(i, -1)) / 2 // (the opening's middle)
      box3(W, x + side[i][0] * c, y + side[i][1] * c, z[i] + H, 0.8, wl(i, 1) + wl(i, -1) + 2 * SLAB + 1, SLAB + 0.9, a, CONCRETE)
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
// the trim colours of the wall patterns (materials.js TRIM: keep in step); a building's own comes from its seed
const BARC_ARCH = [0, 1, 2, 3, 2, 2, 2, 7, 8, 0, 0, 0, 12, 13, 14, 0] // the baked archetype -> the page's (towers and tilt-ups keep their style's look)
const TRIM = [0xf2f0ea, 0xe8e2d0, 0x3a3d40, 0x5a4634, 0x2f3e36, 0x7a2f2a, 0xc8ccd0, 0x8a8f94]
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
function roof(W, pts, y1, yr, shape, bits, rc, wall, seed, trimC) {
  if (shape === 7 && !hipByInset(W, pts, y1, yr, rc, seed, trimC)) shape = 2 // (an old page draws 7 as the box hip, which is also the fallback)
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
    if (trimC) { // the fascia along the eave (0.22 m) and, on a gable, the rake boards up the slopes: the outline the ink pass draws
      tri(W, at(-L, s * Wd, y1), at(L, s * Wd, y1), at(L, s * Wd, y1 - 0.22), trimC, side, pw); tri(W, at(-L, s * Wd, y1), at(L, s * Wd, y1 - 0.22), at(-L, s * Wd, y1 - 0.22), trimC, side, pw)
      if (gable) for (const e of [1, -1]) { const q = [e * L, s * Wd, y1], z = [e * L, 0, yr]; quad(W, at(q[0], q[1], q[2]), at(z[0], z[1], z[2]), at(z[0], z[1], z[2] - 0.22), at(q[0], q[1], q[2] - 0.22), trimC, [ax[0] * e, 0, -ax[1] * e], pw) }
    }
    if (gable) { const g = 20 + Math.min(15.9, yr - y1) / 16; tri(W, at(s * hl, Wd, y1), at(s * hl, -Wd, y1), at(s * hl, 0, yr), endC, end, [g, Wd, 0, seed], [g, -Wd, 0, seed], [g, 0, yr - y1, seed]) } // (materials.js: shingles, an attic window)
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
// shape 7, a hip by inset (tools/tiles.py slope_roof): every wall's slope runs up to the outline inset by D = 0.55 x the
// outline's inradius estimate (2 area / perimeter), and a flat cap closes it. False (nothing drawn) if the inset turned
// inside out, so the caller draws the box hip
function hipByInset(W, pts, y1, yr, rc, seed, trimC) {
  const n = pts.length, A = area(pts)
  if (n < 3 || A <= 0) return false
  let per = 0
  for (let i = 0; i < n; i++) per += Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1])
  const D = (0.55 * 2 * A) / per
  const ring = offset(pts.slice().reverse(), D).reverse() // (offset grows a counter-clockwise outline: shrink it as a clockwise one)
  if (!(area(ring) > 0.02 * A && area(ring) < A)) return false
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = ring[i], d = ring[(i + 1) % n]
    if ((b[0] - a[0]) * (d[0] - c[0]) + (b[1] - a[1]) * (d[1] - c[1]) <= 0) return false
  }
  const pw = ROOFW(seed)
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = ring[i], d = ring[(i + 1) % n], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const nrm = [(b[1] - a[1]) / len, 0.8, (b[0] - a[0]) / len]
    quad(W, [a[0], y1, -a[1]], [b[0], y1, -b[1]], [d[0], yr, -d[1]], [c[0], yr, -c[1]], rc, nrm, pw)
    if (trimC) quad(W, [a[0], y1, -a[1]], [b[0], y1, -b[1]], [b[0], y1 - 0.22, -b[1]], [a[0], y1 - 0.22, -a[1]], trimC, [nrm[0], 0, nrm[2]], pw)
  }
  const tris = earcut2(ring)
  for (let i = 0; i < tris.length; i += 3) { const P = ring[tris[i]], Q = ring[tris[i + 1]], R = ring[tris[i + 2]]; tri(W, [P[0], yr, -P[1]], [Q[0], yr, -Q[1]], [R[0], yr, -R[1]], rc, [0, 1, 0], pw) }
  return true
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
// the signs the lot code adds (pylon boards, tower names) after the SHOP ones, in the same d / names shape
function mergeSigns(sg, extra) {
  if (!extra?.length) return sg
  const d = sg ? [...sg.d] : [], names = sg ? [...sg.names] : []
  for (const e of extra) { let i = names.indexOf(e.name); if (i < 0) { i = names.length; names.push(e.name) } d.push(e.x, e.y, e.z, e.nx, e.ny, e.w, e.kind, i) }
  return { d: new Float32Array(d), names }
}
function signs(t, fronts) {
  const s = t.sections.SHOP
  if (!s || !fronts.length) return null
  const dv = t.dv, n = dv.getUint32(s.off, true), d = [], names = [], at = []
  let o = s.off + 4
  for (let i = 0; i < n; i++) {
    const kind = dv.getUint8(o), x = dv.getInt16(o + 1, true) * t.k, y = dv.getInt16(o + 3, true) * t.k, ln = dv.getUint8(o + 5)
    const name = new TextDecoder().decode(new Uint8Array(t.buf, o + 6, ln)); o += 6 + ln
    if (kind === 6) continue // a tower's name: buildings() puts it on its own wall
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
// log, +4 with a root ball; 16 a lifeguard tower; 17 a net; 18-22 a picnic table, bin, stand, washroom, fountain) -> { d: 8 floats each (tile-local x, height of the ground
// under its middle, z, angle (from east towards north), length, diameter, kind, rise from end to end), solid: boxes } or null
const KIT_HALF = { 18: [0.9, 0.85], 19: [0.33, 0.33], 20: [2.2, 2.5], 21: [2.2, 3.2], 22: [0.2, 0.2] } // the beach things' footprints (tools/seawall.py KIT_SIZE / 2)
function beach(t, terr) {
  const s = t.sections.LOGS
  if (!s) return null
  const dv = t.dv, n = dv.getUint32(s.off, true), d = new Float32Array(n * 8), solid = []
  for (let i = 0, o = s.off + 4; i < n; i++, o += 8) {
    const x = dv.getInt16(o, true) * t.k, y = dv.getInt16(o + 2, true) * t.k, a = (dv.getUint8(o + 4) / 256) * Math.PI * 2
    const len = dv.getUint8(o + 5) / 10, dia = dv.getUint8(o + 6) / 100, kind = dv.getUint8(o + 7), ex = (Math.cos(a) * len) / 2, ey = (Math.sin(a) * len) / 2
    const h0 = heightAt(terr, x - ex, y - ey, true), h1 = heightAt(terr, x + ex, y + ey, true) // (a log lies on the sand at a wall's foot)
    d.set([x, Math.max(0, kind < 16 ? (h0 + h1) / 2 : heightAt(terr, x, y)), -y, a, len, dia, kind, kind < 16 ? h1 - h0 : 0], i * 8)
    if (kind < 16) solid.push([x, y, a, len / 2, dia / 2])
    else if (kind === 16) solid.push([x, y, a, 1.1, 1.1])
    else if (KIT_HALF[kind]) solid.push([x, y, a, ...KIT_HALF[kind]])
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

export { parse, build, readBuilding, readLines, pois, carEnds, crosswalks, onCarriage, roadMask, terrain, roads, eachPoly, ground } // for tools/crosswalk_check.mjs, drive_check.mjs, deck_check.mjs, drawn_check.mjs
