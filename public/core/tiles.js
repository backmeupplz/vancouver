// Streams map tiles for what is on screen. Two levels: 4096 m medium tiles cover any view; 1024 m detail tiles
// replace a medium tile once every detail tile of it that is on screen has arrived (so there are never holes).
// Decoding and geometry building happen in workers; this file only makes three.js objects from their buffers.
import * as THREE from 'three'
import { FAMILY, night } from './materials.js'
import { kit, kitMaterial } from './kit.js'
import { FORMS, ASPECT } from './treeforms.js'
import { sampleGrid } from './util.js'

const SIZES = [1024, 4096]
const ij = (level, i, j) => (level * 4096 + i + 2048) * 4096 + j + 2048 // a tile's number (|i|, |j| < 2048)
const DETAIL_ZOOM = 0.11 // camera.zoom from which detail tiles load (a 1 km tile is ~700 px wide)
// tiles kept off screen (detail, overview) for coming back, at most: a detail tile is ~4 MB of geometry, held twice
// (JS and GPU), so phones keep fewer (a 3 GB iPhone's tab is killed somewhere past 1 GB); the quality tier may keep fewer
const MAX_CACHED = matchMedia('(pointer: coarse)').matches ? [24, 16] : [80, 48]
const v0 = new THREE.Vector3()
const bytes = (m) => { // a mesh's buffers not on the GPU yet
  let n = m.isInstancedMesh && m.instanceMatrix.array ? m.instanceMatrix.array.byteLength : 0
  for (const a of Object.values(m.geometry.attributes)) n += a.array?.byteLength || 0
  return n + (m.geometry.index?.array?.byteLength || 0)
}
const WORKERS = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 2))
// the season's colours (?season=spring|summer|autumn|winter to see another): the tiles carry autumn's
const SEASON = new URLSearchParams(location.search).get('season') || ['winter', 'winter', 'spring', 'spring', 'summer', 'summer', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'winter'][new Date().getMonth()]
const SEASONAL = { winter: [0, 8, 8, 8, 8, 5, 6, 7, 8, 8], spring: [0, 0, 0, 0, 0, 5, 6, 7, 0, 10], summer: [0, 0, 0, 0, 0, 5, 6, 7, 0, 0], autumn: null }[SEASON]
// Under a perspective camera the overview tiles reach past the detail tiles (Tiles.update's `far`) and both show at
// once: the overview tiles' materials (holed) leave out every 1 km cell where a detail tile shows. holeMap has a
// texel per detail tile of the map (255: shown), holeAt its first cell and size (i0, j0, width, height).
export const holes = { holeMap: { value: null }, holeAt: { value: new THREE.Vector4() } }
export const HOLE_GLSL = `uniform sampler2D holeMap; uniform vec4 holeAt;
  bool holed(vec2 xz) { // world x, z
    ivec2 c = ivec2(floor(vec2(xz.x, -xz.y) / 1024.0) - holeAt.xy);
    return c.x >= 0 && c.y >= 0 && c.x < int(holeAt.z) && c.y < int(holeAt.w) && texelFetch(holeMap, c, 0).r > 0.5;
  }`
// an overview tile's copy of a map material (core/materials.js): no fragments where a detail tile shows
export function holed(m) {
  const before = m.onBeforeCompile, key = m.customProgramCacheKey
  m.onBeforeCompile = (s, r) => {
    before.call(m, s, r)
    Object.assign(s.uniforms, holes)
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vHole;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvHole = (modelMatrix * vec4(transformed, 1.0)).xz;')
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec2 vHole;\n${HOLE_GLSL}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (holed(vHole)) discard;')
  }
  m.customProgramCacheKey = () => `${key.call(m)}-holed`
  return m
}
// the billboards' copy (materials.js treeMaterial), sharing its uniforms: no trees standing where a detail tile shows
export function holedTrees(m) {
  const h = m.clone()
  h.uniforms = { ...m.uniforms, ...holes }
  h.vertexShader = HOLE_GLSL + m.vertexShader.replace('void main() {', 'void main() {\n  if (holed((modelMatrix * vec4(iPos, 1.0)).xz)) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }')
  return h
}
const HULLS = [0xf2f1ec, 0x2c3c58, 0x30483a, 0x3c6a96] // white, navy, dark green, blue
// parked cars: mostly white, silver, grey and black, as on the street
const PAINT = [0xe8e8e6, 0xe8e8e6, 0xb4b8bc, 0xb4b8bc, 0x6e7378, 0x26282b, 0x26282b, 0x2a3a5a, 0x9a2a26, 0x3a5a8a, 0xb8ad94, 0x3c5a48]
// a street light: a pole 6.6 m tall, an arm along +x and its head
function poleGeo() {
  const k = kit(THREE)
  k.c(0x4a4e54).cyl(0.1, 0.07, 6.6, 6, 1)
  k.c(0x4a4e54).box(0, 1.9, 6.45, 6.55, -0.05, 0.05)
  k.c(0xfff0d0).box(1.5, 2.0, 6.3, 6.45, -0.14, 0.14)
  const g = k.geometry(true)
  g.userData.shared = true
  return g
}
// a parked car, forward +x, on the ground: a body, a glass cabin under a roof in the paint (the instance colour)
function carGeo() {
  const k = kit(THREE)
  k.c(null).box(-2.25, 2.25, 0.22, 0.85, -0.9, 0.9)
  k.c(0x2b3a4a).box(-1.25, 1.05, 0.85, 1.32, -0.84, 0.84, 0.84, 0.86)
  k.c(null).box(-1.05, 0.8, 1.32, 1.4, -0.7, 0.7)
  const g = k.geometry(true)
  g.userData.shared = true
  return g
}

// a boat 1 long along +x (bow east), its waterline at 0: a pointed hull, a deck and cabin, a mast (sailboats)
function boatGeos() {
  const solid = (shape, y0, y1) => new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 1 }).rotateX(-Math.PI / 2).translate(0, y0, 0)
  const outline = (pts) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)))
  const hull = solid(outline([[-0.5, -0.15], [0.22, -0.16], [0.5, 0], [0.22, 0.16], [-0.5, 0.15]]), -0.03, 0.075)
  const top = solid(outline([[-0.34, -0.1], [0.12, -0.1], [0.2, 0], [0.12, 0.1], [-0.34, 0.1]]), 0.075, 0.13)
  const mast = new THREE.BoxGeometry(0.018, 1.25, 0.018).translate(0.06, 0.075 + 0.625, 0)
  const geos = { hull, top, mast }
  for (const g of Object.values(geos)) { g.deleteAttribute('uv'); g.computeVertexNormals(); g.userData.shared = true }
  return geos
}

// the beaches (tile-worker.js beach): a driftwood log 1 long along +x and 1 thick, its middle on the origin: a
// bark-less trunk, seven-sided, knobbly and a little bent, thicker at its butt (+x); the root ball at a butt (1 across,
// facing +x, its middle on the origin); a lifeguard tower facing +x (white legs and seat, a red and white sunshade);
// a beach volleyball net 9.5 long along x (posts, net, white tape). Colours: instance colour (logs) or vertex colours.
function beachGeos() {
  const k = kit(THREE), seg = 7, rnd = (i) => { const v = Math.sin(i * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v) }
  const rings = [[-0.5, 0.4, 0], [-0.2, 0.47, 0.03], [0.15, 0.5, 0.04], [0.5, 0.55, 0]] // x, radius, bend (y)
  const pt = (r, j) => { const [x, rad, bend] = rings[r], a = (j / seg) * Math.PI * 2, w = rad * (0.88 + 0.24 * rnd(r * 13 + j)); return [x, Math.sin(a) * w + bend, Math.cos(a) * w] }
  k.c(null)
  for (let r = 0; r < rings.length - 1; r++) for (let j = 0; j < seg; j++) k.quad(pt(r, j), pt(r + 1, j), pt(r + 1, j + 1), pt(r, j + 1))
  k.c(0xe0d4c0, 1) // sawn ends, paler
  for (let j = 0; j < seg; j++) { k.tri([-0.5, 0, 0], pt(0, j), pt(0, j + 1)); k.tri([0.5, 0, 0], pt(3, j + 1), pt(3, j)) }
  const log = k.geometry(true)
  const r = kit(THREE).c(0xe4e0d8)
  r.cyl(0.32, 0.5, 0.35, 7, 3).rot(0, 'z', -Math.PI / 2) // the stump flaring out towards +x
  for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2 + rnd(i) * 0.5, l = 0.55 + rnd(i + 7) * 0.35; r.rod([0.3, 0, 0], [0.35 + rnd(i + 3) * 0.25, Math.sin(a) * l, Math.cos(a) * l], 0.09, 0.03, 5) }
  const roots = r.geometry(true)
  const t = kit(THREE), W = 0xf4f2ee, RED = 0xc8302c
  t.c(W)
  for (const [x, z] of [[-0.6, -0.6], [-0.6, 0.6], [0.6, -0.6], [0.6, 0.6]]) t.rod([x, 0, z], [x * 0.75, 1.9, z * 0.75], 0.07, 0.06, 5)
  t.box(-0.6, 0.6, 1.85, 1.97, -0.6, 0.6) // platform
  t.box(-0.5, -0.38, 1.97, 2.85, -0.45, 0.45).box(-0.1, 0.3, 1.97, 2.3, -0.4, 0.4) // backrest, seat
  t.rod([0.75, 0, -0.3], [0.5, 1.9, -0.3], 0.04).rod([0.75, 0, 0.3], [0.5, 1.9, 0.3], 0.04) // ladder
  for (let y = 0.4; y < 1.9; y += 0.45) t.box(0.73 - y * 0.13, 0.77 - y * 0.13, y - 0.03, y + 0.03, -0.3, 0.3)
  t.c(0x8a8a88).rod([-0.42, 1.97, 0], [-0.42, 3.3, 0], 0.03)
  for (let i = 0; i < 8; i++) { const s = t.at(); t.c(i % 2 ? W : RED).cyl(1.1, 0.05, 0.45, 2, 2, (i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2).move(s, -0.42, 3.05, 0) }
  t.c(RED).box(-0.62, 0.62, 1.6, 1.85, 0.6, 0.64).box(-0.62, 0.62, 1.6, 1.85, -0.64, -0.6) // red side boards
  const tower = t.geometry(true)
  const n = kit(THREE)
  n.c(0xd8d6d0).rod([-4.75, 0, 0], [-4.75, 2.55, 0], 0.06).rod([4.75, 0, 0], [4.75, 2.55, 0], 0.06)
  n.c(0x2c2e30).box(-4.5, 4.5, 1.5, 2.37, -0.015, 0.015)
  n.c(0xf4f2ee).box(-4.5, 4.5, 2.37, 2.43, -0.02, 0.02)
  const net = n.geometry(true)
  for (const g of [log, roots, tower, net]) g.userData.shared = true
  return { log, roots, tower, net }
}
const DRIFT = [0xb9b5ad, 0xc4c0b8, 0xaaa59c, 0xa89a88, 0xcfcac0, 0x9c968c] // sun-bleached silver-grey, a few browner

export class Tiles {
  // lights: core/lights.js (night lights; optional)
  constructor({ scene, treeScene, mats, farMats = mats, lights, base = 'tiles/', onLoad, onUnload, onChange }) {
    Object.assign(this, { scene, treeScene, mats, farMats, lights, onLoad, onUnload, onChange })
    this.base = new URL(base, location.href).href // absolute: workers resolve relative URLs against their own path
    this.tiles = new Map() // "level/i_j" -> tile
    this.byIJ = new Map() // numeric ij(level, i, j) -> tile, for lookups many times a frame (no key strings)
    this.queue = []
    this.busy = 0
    this.frame = 0
    this.workers = Array.from({ length: WORKERS }, () => new Worker(new URL('./tile-worker.js', import.meta.url), { type: 'module' }))
    this.pending = new Map()
    let seq = 0
    this.request = (msg) => new Promise((ok) => { const id = ++seq; this.pending.set(id, ok); this.workers[id % WORKERS].postMessage({ id, ...msg }) })
    for (const w of this.workers) w.onmessage = ({ data }) => { const ok = this.pending.get(data.id); this.pending.delete(data.id); ok?.(data) }
    this.unitMat = new THREE.MeshLambertMaterial()
    this.quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)
    this.boatGeo = boatGeos()
    this.beachGeo = beachGeos()
    this.carGeo = carGeo(); this.carMat = kitMaterial(THREE, night); this.poleGeo = poleGeo()
    this.cars = 2 // parked cars shown: 0 none, 1 in the lots (not the kerbs'), 2 all (setDetail)
    this.balconies = true; this.fine = true
    this.made = [] // worker results waiting to become three.js objects, one tile per frame (pump)
    this.warming = [] // tiles whose buffers are being uploaded to the GPU, a few MB per frame, before they show
    this.rush = true // while the loading screen is up: no pacing, everything at once
    this.cached = MAX_CACHED
  }

  async init() {
    const idx = await fetch(this.base + 'index.json', { cache: 'no-cache' }).then((r) => r.json())
    this.index = idx
    this.have = [new Set(idx.l0), new Set(idx.l1)]
    // each tile's ?v=: the bake that last changed it (tools/common.py write_index), so a rebake refetches only those
    const v = idx.built || 0
    this.ver = [idx.l0, idx.l1].map((l, lv) => new Map(l.map((k, n) => [k, idx[`v${lv}`]?.[n] ?? v])))
    { // the hole map (holes): a texel per detail tile
      const ij = idx.l0.map((k) => k.split('_').map(Number)), i0 = Math.min(...ij.map((c) => c[0])), j0 = Math.min(...ij.map((c) => c[1]))
      const w = Math.max(...ij.map((c) => c[0])) - i0 + 1, h = Math.max(...ij.map((c) => c[1])) - j0 + 1
      const tex = new THREE.DataTexture(new Uint8Array(w * h), w, h, THREE.RedFormat)
      tex.needsUpdate = true
      holes.holeMap.value = tex; holes.holeAt.value.set(i0, j0, w, h)
      this.shown = new Uint8Array(w * h)
    }
    // a coarse height grid of the whole map (tools/heights.py), so heights are right before tiles arrive
    try {
      const r = await fetch(`${this.base}heights.bin?v=${idx.vh || idx.built || 0}`)
      const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
      const dv = new DataView(buf)
      this.coarse = { x0: dv.getFloat32(4, true), y1: dv.getFloat32(8, true), c: dv.getFloat32(12, true), w: dv.getUint32(16, true), h: dv.getUint32(20, true), z: new Int16Array(buf, 24) }
    } catch (e) { console.warn('heights', e) }
    if (this.coarse) this.makeBase(`${this.base}base.png?v=${idx.vb || idx.built || 0}`)
    return idx
  }

  // the whole map at 1 px = 64 m (tools/heights.py), always drawn under the tiles: nothing is ever black while
  // tiles load, at any zoom. Its heights are the lower envelope of the coarse grid, a little sunk, so it never
  // pokes through the real ground.
  makeBase(url) {
    const g = this.coarse, step = 2, nx = Math.floor((g.w - 1) / step) + 1, ny = Math.floor((g.h - 1) / step) + 1
    const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), idx = new Uint32Array((nx - 1) * (ny - 1) * 6)
    const Z = (i, j) => g.z[Math.min(g.h - 1, j) * g.w + Math.min(g.w - 1, i)] / 10
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let lo = Infinity
      for (let a = -1; a <= step; a++) for (let b = -1; b <= step; b++) lo = Math.min(lo, Z(Math.max(0, i * step + a), Math.max(0, j * step + b)))
      const k = j * nx + i
      pos.set([g.x0 + i * step * g.c, lo - 4, -(g.y1 - j * step * g.c)], k * 3)
      uv.set([(i * step + 0.5) / g.w, 1 - (j * step + 0.5) / g.h], k * 2)
    }
    let o = 0
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i; idx.set([a, a + nx, a + 1, a + 1, a + nx, a + nx + 1], o); o += 6 }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(new THREE.BufferAttribute(idx, 1))
    geo.computeVertexNormals()
    const tex = new THREE.TextureLoader().load(url, () => this.onChange?.())
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4
    const mat = new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 16 })
    // in chunks sharing one vertex buffer, so the camera culls what it doesn't see (a street-level view sees ~1 of 64)
    const base = new THREE.Group(), C = 8, cw = Math.ceil((nx - 1) / C), ch = Math.ceil((ny - 1) / C)
    for (let cj = 0; cj < ny - 1; cj += ch) for (let ci = 0; ci < nx - 1; ci += cw) {
      const i1 = Math.min(nx - 1, ci + cw), j1 = Math.min(ny - 1, cj + ch), sub = []
      for (let j = cj; j < j1; j++) for (let i = ci; i < i1; i++) { const a = j * nx + i; sub.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1) }
      const cg = new THREE.BufferGeometry()
      for (const k of ['position', 'uv', 'normal']) cg.setAttribute(k, geo.attributes[k])
      cg.setIndex(new THREE.BufferAttribute(new Uint32Array(sub), 1))
      const bb = new THREE.Box3()
      for (let j = cj; j <= j1; j++) for (let i = ci; i <= i1; i++) bb.expandByPoint(v0.fromArray(pos, (j * nx + i) * 3))
      cg.boundingBox = bb; cg.boundingSphere = bb.getBoundingSphere(new THREE.Sphere())
      const m = new THREE.Mesh(cg, mat)
      m.renderOrder = 1; m.matrixAutoUpdate = false // after the tiles: where they cover it, the depth test skips its pixels
      base.add(m)
    }
    this.scene.add(base)
    this.baseMesh = base
  }

  // highest coarse ground in a rectangle (world metres, y north): tall ground stands up into the view from outside it
  maxHeight(x0, x1, y0, y1) {
    const g = this.coarse
    if (!g) return 0
    const i0 = Math.max(0, Math.floor((x0 - g.x0) / g.c)), i1 = Math.min(g.w - 1, Math.ceil((x1 - g.x0) / g.c))
    const j0 = Math.max(0, Math.floor((g.y1 - y1) / g.c)), j1 = Math.min(g.h - 1, Math.ceil((g.y1 - y0) / g.c))
    const s = Math.max(1, Math.floor(Math.max(i1 - i0, j1 - j0) / 64))
    let m = 0
    for (let j = j0; j <= j1; j += s) for (let i = i0; i <= i1; i += s) m = Math.max(m, g.z[j * g.w + i] / 10)
    return m
  }

  key(level, i, j) { return `${level}/${i}_${j}` }

  // the ground rectangle on screen (world metres, y north), padded north for tall things; with a perspective
  // camera (city.view.useCamera) a square of half-size `radius` around the target
  viewRect(camera, target, radius) {
    if (camera.isPerspectiveCamera) { const x = target.x, y = -target.z; return { x0: x - radius, x1: x + radius, y0: y - radius, y1: y + radius } }
    // the screen's corners on the ground at the target's height, as the camera is turned and tilted (right-drag): a
    // rectangle that assumed the default view (north up, 30° down) missed the corners of a turned or lower view
    const z = camera.zoom, hw = (camera.right - camera.left) / z / 2, vh = (camera.top - camera.bottom) / z / 2
    camera.updateMatrixWorld()
    const h0 = target.y || 0, e = camera.matrixWorld.elements // columns: right, up, back
    const at = (sx, sy) => { const t = (sx * e[1] + sy * e[5]) / e[9]; return [target.x + sx * e[0] + sy * e[4] - t * e[8], -(target.z + sx * e[2] + sy * e[6] - t * e[10])] }
    const tl = at(-hw, vh), tr = at(hw, vh), bl = at(-hw, -vh), br = at(hw, -vh)
    // ground higher than the target shows from further on past the top edge (and from nearer at the bottom edge),
    // 1/tan(the view's tilt) m per metre of height difference, plus 80 m for what stands on it
    const l = Math.hypot(e[8], e[10]) || 1e-6, fx = -e[8] / l, fy = e[10] / l, cot = l / e[9] // the view's way on the ground
    const band = (a, b, d) => this.maxHeight(Math.min(a[0], b[0], a[0] + fx * d, b[0] + fx * d), Math.max(a[0], b[0], a[0] + fx * d, b[0] + fx * d),
      Math.min(a[1], b[1], a[1] + fy * d, b[1] + fy * d), Math.max(a[1], b[1], a[1] + fy * d, b[1] + fy * d)) - h0
    const far = Math.min(3500, Math.max(0, band(tl, tr, 3500)) * cot) + 80, near = -Math.min(2500, Math.max(0, band(bl, br, -2500)) * cot) - 80
    const ps = [bl, br, tl, tr, ...[tl, tr].map((p) => [p[0] + fx * far, p[1] + fy * far]), ...[bl, br].map((p) => [p[0] + fx * near, p[1] + fy * near])]
    const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1])
    const pad = Math.max(60, hw * 0.15) // a little beyond the edges, so panning reveals loaded ground
    return { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, y0: Math.min(...ys) - pad, y1: Math.max(...ys) + pad }
  }

  // far (a perspective camera): the overview tiles show out to this far, beyond the detail tiles within radius
  update(camera, target, radius = 900, far = 0) {
    if (!this.index) return
    this.frame++
    const r = this.viewRect(camera, target, radius)
    // the map camera loads ahead of a pan: the rectangle reaches 0.8 s further the way the view moves (at most
    // 1.5 km), so the next detail tiles are in before they come on screen (a tile that isn't yet leaves a gap)
    const now = performance.now(), m = this.motion ||= { x: target.x, y: -target.z, t: now, vx: 0, vy: 0 }, dt = (now - m.t) / 1000
    if (dt > 0.5 || camera.isPerspectiveCamera) m.vx = m.vy = 0
    else if (dt > 0.004) { const k = Math.min(1, dt * 6); m.vx += ((target.x - m.x) / dt - m.vx) * k; m.vy += ((-target.z - m.y) / dt - m.vy) * k }
    if (dt > 0.004) Object.assign(m, { x: target.x, y: -target.z, t: now })
    const seen = { ...r } // on screen (the overview tile fills a gap only there)
    const lx = Math.max(-1500, Math.min(1500, m.vx * 0.8)), ly = Math.max(-1500, Math.min(1500, m.vy * 0.8))
    if (lx > 0) r.x1 += lx; else r.x0 += lx
    if (ly > 0) r.y1 += ly; else r.y0 += ly
    const wantDetail = camera.isPerspectiveCamera ? radius <= 1100 : camera.zoom >= DETAIL_ZOOM
    const R = camera.isPerspectiveCamera && far > radius ? this.viewRect(camera, target, far) : r // the overview tiles' square
    const need = []
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2
    for (let i = Math.floor(R.x0 / 4096); i <= Math.floor(R.x1 / 4096); i++) for (let j = Math.floor(R.y0 / 4096); j <= Math.floor(R.y1 / 4096); j++) {
      if (!this.have[1].has(`${i}_${j}`)) continue
      const p = this.get(1, i, j)
      p.used = this.frame
      if (p.state === 'new') need.push([p, Math.hypot((i + 0.5) * 4096 - cx, (j + 0.5) * 4096 - cy)])
      const inner = (i + 1) * 4096 >= r.x0 && i * 4096 <= r.x1 && (j + 1) * 4096 >= r.y0 && j * 4096 <= r.y1
      let kidsReady = wantDetail && inner, any = false, shown = false, gap = false
      if (wantDetail && inner) {
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
          const ki = i * 4 + a, kj = j * 4 + b
          if (!this.have[0].has(`${ki}_${kj}`)) continue
          if ((ki + 1) * 1024 < r.x0 || ki * 1024 > r.x1 || (kj + 1) * 1024 < r.y0 || kj * 1024 > r.y1) continue
          const k = this.get(0, ki, kj)
          k.used = this.frame; any = true
          if (k.state === 'new') need.push([k, Math.hypot((ki + 0.5) * 1024 - cx, (kj + 0.5) * 1024 - cy) - 1e5])
          if (k.state !== 'ready' && k.state !== 'missing') { kidsReady = false; gap ||= (ki + 1) * 1024 >= seen.x0 && ki * 1024 <= seen.x1 && (kj + 1) * 1024 >= seen.y0 && kj * 1024 <= seen.y1 }
          else if (k.visible && k.state === 'ready') shown = true
        }
      }
      // detail tiles that show stay while new ones arrive at the edge, and the overview tile shows with them, holed
      // where they show, so the gap is the overview tile's and not the base layer's (not all of it: that flashed the
      // whole 4 km every time a pan reached a new row of detail tiles). Zooming out, they stay until the overview
      // tile has arrived.
      const fine = wantDetail && any && (kidsReady || shown), up = p.state === 'ready' || p.state === 'missing'
      this.show(p, !fine || gap || R !== r) // past the detail tiles too: both, the overview tile holed
      // (and with both, not in the sun's shadow map: its buildings would shade the detail tiles' cells twice)
      const cast = R === r && !fine
      if (p.group && p.cast !== cast) { p.cast = cast; p.group.traverse((o) => { if (o.isMesh && o.material === this.farMats.building) o.castShadow = cast }) }
      for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
        const k = this.tiles.get(this.key(0, i * 4 + a, j * 4 + b))
        if (!k) continue
        if (!fine && !up && k.visible && k.state === 'ready') k.used = this.frame
        this.show(k, k.used === this.frame && (fine || !up))
      }
    }
    for (const t of this.tiles.values()) if (t.used < this.frame && t.visible) this.show(t, false)
    need.sort((x, y) => x[1] - y[1])
    for (const [t] of need) this.load(t)
    this.evict()
    this.updateHoles()
  }

  // the hole map from the detail tiles that show now (uploaded when it changed)
  updateHoles() {
    const H = holes.holeAt.value, next = this.shown.fill(0)
    for (const t of this.tiles.values()) {
      if (t.level || !t.visible || t.state !== 'ready') continue
      const a = t.i - H.x, b = t.j - H.y
      if (a >= 0 && b >= 0 && a < H.z && b < H.w) next[b * H.z + a] = 255
    }
    const tex = holes.holeMap.value
    if (tex && next.some((v, k) => v !== tex.image.data[k])) { tex.image.data.set(next); tex.needsUpdate = true }
  }
  // is (x, y) (world metres, y north) in a cell where a detail tile shows
  inHole(x, y) {
    const H = holes.holeAt.value, a = Math.floor(x / 1024) - H.x, b = Math.floor(y / 1024) - H.y
    return a >= 0 && b >= 0 && a < H.z && b < H.w && holes.holeMap.value.image.data[b * H.z + a] > 0
  }

  get(level, i, j) {
    const k = this.key(level, i, j)
    let t = this.tiles.get(k)
    if (!t) { t = { level, i, j, ox: i * SIZES[level], oy: j * SIZES[level], state: 'new', used: 0, visible: false }; this.tiles.set(k, t); this.byIJ.set(ij(level, i, j), t) }
    return t
  }

  show(t, on) {
    if (t.visible === on) return
    t.visible = on
    if (t.group && t.state !== 'warming') this.showAll(t, on) // else once uploaded
    this.onChange?.()
  }

  async load(t) {
    t.state = 'loading'
    const res = await this.request({ url: `${this.base}${t.level}/${t.i}_${t.j}.bin?v=${this.ver[t.level].get(`${t.i}_${t.j}`) ?? (this.index.built || 0)}`, level: t.level })
    if (res.error) { // a network blip or an aborted fetch: again in a few seconds (as 'missing' the cell kept no detail for the session)
      console.warn(res.error); t.state = 'failed'
      setTimeout(() => { if (t.state === 'failed') { t.state = 'new'; this.onChange?.() } }, 3000)
      return
    }
    if (res.missing) { t.state = 'missing'; this.onChange?.(); return }
    if (t.state !== 'loading') return // evicted while loading
    t.res = res
    this.made.push(t)
  }

  // once per animation frame (main.js), drawn or not: turns at most one worker result into three.js objects, or
  // uploads up to ~3 MB of a made tile's buffers to the GPU (a bigger mesh alone), so neither a new tile nor a tile that has waited
  // hidden (a detail tile under its overview tile) costs one big upload in the frame it appears. A tile counts
  // as ready, and shows, only once it is all on the GPU. While the loading screen is up (rush), all at once.
  pump(renderer) {
    if (!this.made.length && !this.warming.length) return
    if (!this.warmScene) { // a 1×1 target and a plain material: drawing a mesh there uploads all its buffers
      // (one material per kind of mesh: a shared one would be recompiled between instanced and plain meshes)
      this.warmScene = new THREE.Scene(); this.warmMats = [0, 1, 2].map(() => new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }))
      this.warmTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }); this.warmCam = new THREE.Camera()
    }
    const alive = (t) => this.tiles.get(this.key(t.level, t.i, t.j)) === t
    let spent = 0
    do {
      const t = this.first(this.warming) // on screen first, then detail tiles: the far overview tiles wait
      if (t) { // upload the next mesh of the first made tile
        const m = alive(t) && t.warm.at(-1)
        if (m) {
          const b = this.rush ? 0 : bytes(m)
          if (spent && spent + b > 3e6) return
          t.warm.pop(); spent += b; this.upload(renderer, m); continue
        }
        this.warming.splice(this.warming.indexOf(t), 1)
        if (!alive(t)) continue
        t.state = 'ready'; t.warm = null
        this.showAll(t, t.visible)
        this.onLoad?.(t)
        this.onChange?.(t.visible) // a tile that shows changes the picture (and the shadows); a hidden one only the plan
        if (!this.rush) return
      }
      const n = this.made.splice(this.made.indexOf(this.first(this.made)), 1)[0] // else make the next tile (as warming); its buffers go up from the next frame
      if (!n) return
      if (n.state !== 'loading' || !alive(n)) continue
      this.make(n, n.res); n.res = null
      n.state = 'warming'; n.warm = []
      this.showAll(n, false)
      n.group.traverse((o) => { if (o.isMesh) n.warm.push(o) })
      for (const o of n.side) n.warm.push(o)
      this.warming.push(n)
      if (!this.rush) return
    } while (this.rush || spent < 3e6)
  }

  // which waiting tile goes next: one on screen (a zoom in and out leaves tiles it passed queued), a detail one first
  first(list) {
    let best, rank = 9
    for (const t of list) { const k = (t.used === this.frame ? 0 : 2) + (t.level ? 1 : 0); if (k < rank) { best = t; rank = k } }
    return best
  }

  upload(renderer, m) {
    const geo = m.geometry, w = this.warmScene, M = this.warmMats
    if (!bytes(m)) return
    const proxy = m.isInstancedMesh ? new THREE.InstancedMesh(geo, M[m.instanceColor ? 2 : 1], 0) : new THREE.Mesh(geo, M[0])
    if (m.isInstancedMesh) Object.assign(proxy, { instanceMatrix: m.instanceMatrix, instanceColor: m.instanceColor, count: m.count })
    proxy.frustumCulled = false
    w.add(proxy)
    const rt = renderer.getRenderTarget(), info = renderer.info.autoReset
    renderer.info.autoReset = false
    renderer.setRenderTarget(this.warmTarget); renderer.render(w, this.warmCam); renderer.setRenderTarget(rt)
    renderer.info.autoReset = info
    w.remove(proxy)
  }

  make(t, res) {
    const g = new THREE.Group(), mt = t.level ? this.farMats : this.mats
    g.position.set(t.ox, 0, -t.oy)
    g.visible = t.visible
    t.terrain = res.terrain
    t.graph = res.graph
    t.footprints = res.footprints || null
    t.signs = res.signs || null
    t.water = res.water || null
    t.carriage = res.carriage || null
    // once a geometry is on the GPU its arrays are dropped from memory (bounds are computed first, for culling)
    const free = (geo, b) => {
      if (b) { geo.boundingBox = new THREE.Box3(v0.fromArray(b), new THREE.Vector3().fromArray(b, 3)); geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere()) } else { geo.computeBoundingSphere(); geo.computeBoundingBox() }
      for (const a of [...Object.values(geo.attributes), geo.index]) if (a) a.onUpload(function () { this.array = null }) }
    const add = (geo, mat, opts = {}, b) => { free(geo, b); const m = new THREE.Mesh(geo, mat); Object.assign(m, opts); m.matrixAutoUpdate = false; m.updateMatrix(); g.add(m); return m }
    if (res.ground) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(res.ground.position, 3))
      geo.setAttribute('cls', new THREE.BufferAttribute(res.ground.cls, 1))
      geo.setIndex(new THREE.BufferAttribute(res.ground.index, 1))
      geo.setAttribute('normal', new THREE.BufferAttribute(res.ground.normal, 3, true))
      t.ground = add(geo, mt.ground, { receiveShadow: true }, res.ground.box)
      if (res.ground.coarse) { // the same vertices, fewer triangles: the map further out (setDetail)
        const cg = new THREE.BufferGeometry()
        for (const k of ['position', 'cls', 'normal']) cg.setAttribute(k, geo.attributes[k])
        cg.setIndex(new THREE.BufferAttribute(res.ground.coarse, 1))
        t.coarse = add(cg, mt.ground, { receiveShadow: true }, res.ground.box)
        t.ground.visible = this.fine; t.coarse.visible = !this.fine
      }
    }
    for (const [r, mat] of [[res.roads, mt.road], [res.paint, mt.paint]]) { // bridge surfaces; paint on the ground
      if (!r) continue
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(r.position, 3))
      geo.setAttribute('aRoad', new THREE.BufferAttribute(r.aRoad, 4))
      geo.setAttribute('aRoad2', new THREE.BufferAttribute(r.aRoad2, 4))
      geo.setIndex(new THREE.BufferAttribute(r.index, 1))
      geo.setAttribute('normal', new THREE.BufferAttribute(r.normal, 3, true))
      add(geo, mat, { receiveShadow: true, renderOrder: mat === mt.paint ? 1 : 0 }, r.box)
    }
    const bgeo = (b) => {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(b.position, 3))
      geo.setAttribute('normal', new THREE.BufferAttribute(b.normal, 3, true))
      geo.setAttribute('color', new THREE.BufferAttribute(b.color, 3, true))
      geo.setAttribute('aWin', new THREE.BufferAttribute(b.aWin, 4))
      geo.setAttribute('aFac', new THREE.BufferAttribute(b.aFac, 4))
      return geo
    }
    // in pieces of ~1.5 MB: pump() uploads a few MB a frame, and an overview tile's buildings (20+ MB) in one piece
    // cost a 70 ms frame (each piece keeps the tile's bounds)
    if (res.buildings?.position.length) {
      const B = res.buildings, nv = B.position.length / 3, arrays = Object.entries(B).filter(([k, a]) => k !== 'box' && ArrayBuffer.isView(a))
      const step = Math.ceil(1.5e6 / (arrays.reduce((s, [, a]) => s + a.byteLength, 0) / nv) / 3) * 3 // whole triangles
      for (let v = 0; v < nv; v += step) {
        const e = Math.min(nv, v + step), part = Object.fromEntries(arrays.map(([k, a]) => [k, a.subarray(v * a.length / nv, e * a.length / nv)]))
        add(bgeo(part), mt.building, { castShadow: true, receiveShadow: true }, B.box)
      }
    }
    if (res.balconies) { t.balcony = add(bgeo(res.balconies), mt.building, { castShadow: true, receiveShadow: true }, res.balconies.box); t.balcony.visible = this.balconies }
    if (res.ao) { // after the paint
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(res.ao.position, 3)); geo.setAttribute('t', new THREE.BufferAttribute(res.ao.t, 1)); geo.setIndex(new THREE.BufferAttribute(res.ao.index, 1))
      add(geo, this.mats.ao, { renderOrder: 2 }, res.ao.box)
    }
    if (res.lights?.poles) { // the street lights' poles, up close
      const P = res.lights.poles, n = P.length / 4, m = new THREE.InstancedMesh(this.poleGeo, this.carMat, n), M = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3()
      for (let i = 0; i < n; i++) { const a = P[i * 4 + 3]; m.setMatrixAt(i, M.compose(v.set(P[i * 4], P[i * 4 + 1], P[i * 4 + 2]), q.setFromAxisAngle(up, Number.isNaN(a) ? 0 : a), sc.set(1, 1, 1))) }
      m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false; m.computeBoundingSphere()
      t.poles = m; g.add(m); m.visible = this.balconies
    }
    if (res.parked) for (const k of ['lot', 'kerb']) if (res.parked[k]) { t[k] = this.parkedCars(res.parked[k]); g.add(t[k]); t[k].visible = this.cars > (k === 'lot' ? 0 : 1) }
    if (res.boats) { // berthed boats: hull (instance colour), deck and cabin, a mast on the sailboats
      const B = res.boats, n = B.length / 6, M = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0)
      const sails = []
      for (let i = 0; i < n; i++) if (B[i * 6 + 5] & 1) sails.push(i)
      const parts = [['hull', n], ['top', n], ['mast', sails.length]].map(([k, m]) => { const im = new THREE.InstancedMesh(this.boatGeo[k], this.unitMat, m); im.receiveShadow = true; im.castShadow = k !== 'mast'; return im })
      for (let i = 0; i < n; i++) {
        M.compose(p.set(B[i * 6], B[i * 6 + 1], B[i * 6 + 2]), q.setFromAxisAngle(up, B[i * 6 + 3]), sc.setScalar(B[i * 6 + 4]))
        parts[0].setMatrixAt(i, M); parts[1].setMatrixAt(i, M)
        parts[0].setColorAt(i, c.setHex(HULLS[(B[i * 6 + 5] >> 1) & 3])); parts[1].setColorAt(i, c.setHex(0xe6e4de))
      }
      sails.forEach((i, k) => { parts[0].getMatrixAt(i, M); parts[2].setMatrixAt(k, M); parts[2].setColorAt(k, c.setHex(0xd4d6d8)) })
      for (const im of parts) if (im.count) { im.computeBoundingSphere(); im.matrixAutoUpdate = false; g.add(im) }
    }
    if (res.beach) { t.beach = this.beachMeshes(res.beach.d); for (const o of t.beach) { o.visible = this.fine; g.add(o) } } // from 0.3 on the map (1-2 px a metre)
    this.scene.add(g)
    t.group = g
    t.side = [] // drawn elsewhere than the tile's group (trees and lamp heads after the ink pass, lights.js), shown with it
    if (res.trees) t.side.push(t.trees = this.makeTrees(t, res.trees, mt.tree))
    if (res.lights && this.lights) {
      const { pool, head } = this.lights.meshes(t, res.lights, g.position)
      this.lights.scene.add(pool); t.side.push(pool)
      if (head) { this.treeScene.add(head); t.side.push(head) }
    }
  }

  showAll(t, on) { t.group.visible = on; for (const o of t.side) o.visible = on }

  beachMeshes(B) { // 8 floats a thing (tile-worker.js beach): logs lie on the sand (sunk a little, tilted with it), roll at random
    const n = B.length / 8, G = this.beachGeo, M = new THREE.Matrix4(), q = new THREE.Quaternion(), r = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), c = new THREE.Color()
    const up = new THREE.Vector3(0, 1, 0), ax = new THREE.Vector3(1, 0, 0), az = new THREE.Vector3(0, 0, 1)
    const count = (f) => { let m = 0; for (let i = 0; i < n; i++) if (f(B[i * 8 + 6])) m++; return m }
    const im = (geo, m, shadow = true) => { const o = new THREE.InstancedMesh(geo, this.carMat, m); o.castShadow = shadow; o.receiveShadow = true; o.count = 0; return o }
    const logs = im(G.log, count((k) => k < 16)), roots = im(G.roots, count((k) => k < 16 && k & 4), false), tower = im(G.tower, count((k) => k === 16)), net = im(G.net, count((k) => k === 17), false)
    for (let i = 0; i < n; i++) {
      const x = B[i * 8], h = B[i * 8 + 1], z = B[i * 8 + 2], a = B[i * 8 + 3], len = B[i * 8 + 4], dia = B[i * 8 + 5], kind = B[i * 8 + 6], rise = B[i * 8 + 7]
      const seed = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1
      q.setFromAxisAngle(up, a)
      if (kind < 16) {
        q.multiply(r.setFromAxisAngle(az, Math.atan2(rise, len))).multiply(r.setFromAxisAngle(ax, seed * Math.PI * 2))
        M.compose(p.set(x, h + dia * 0.38, z), q, sc.set(len, dia, dia))
        logs.setMatrixAt(logs.count, M); logs.setColorAt(logs.count++, c.setHex(DRIFT[Math.floor(seed * DRIFT.length)]))
        if (kind & 4) { // the root ball at the butt end
          q.setFromAxisAngle(up, a).multiply(r.setFromAxisAngle(az, Math.atan2(rise, len)))
          M.compose(p.set(x + (Math.cos(a) * len) / 2, h + rise / 2 + dia * 0.45, z - (Math.sin(a) * len) / 2), q, sc.setScalar(dia * 2.2))
          roots.setMatrixAt(roots.count, M); roots.setColorAt(roots.count++, c.setHex(DRIFT[Math.floor(seed * DRIFT.length)]))
        }
      } else {
        const o = kind === 16 ? tower : net
        o.setMatrixAt(o.count++, M.compose(p.set(x, h, z), q, sc.set(kind === 17 ? len / 9.5 : 1, 1, 1)))
      }
    }
    const out = [logs, roots, tower, net].filter((o) => o.count)
    for (const o of out) { o.matrixAutoUpdate = false; o.computeBoundingSphere() }
    return out
  }

  parkedCars(A) { // 5 floats a car (tile-worker.js parked)
    const n = A.length / 5, m = new THREE.InstancedMesh(this.carGeo, this.carMat, n), M = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color()
    for (let i = 0; i < n; i++) {
      m.setMatrixAt(i, M.compose(p.set(A[i * 5], A[i * 5 + 1], A[i * 5 + 2]), q.setFromAxisAngle(up, A[i * 5 + 3]), one))
      m.setColorAt(i, c.setHex(PAINT[Math.floor(A[i * 5 + 4] * PAINT.length)]))
    }
    m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false
    m.computeBoundingSphere()
    return m
  }

  makeTrees(t, { pos, info }, mat) {
    const n = pos.length / 3
    const P = new Float32Array(n * 3), S = new Float32Array(n * 2), C = new Float32Array(n * 3), V = new Float32Array(n), CL = new Float32Array(n)
    // does a crown of radius r round tile-local (x, y north) reach over a carriageway or cycle track (the tile's 1 m mask)
    const R = t.carriage, on = (x, y) => { if (!R || x < 0 || y < 0 || x >= R.n || y >= R.n) return false; const k = Math.floor(y) * R.n + Math.floor(x); return !!(R.bits[k >> 3] & (1 << (k & 7))) }
    const over = (x, y, r) => { for (let a = 0; a < 8; a++) if (on(x + Math.cos(a * 0.785) * r, y + Math.sin(a * 0.785) * r)) return true; return on(x, y) }
    // per form (treeforms.js): the crown's width at least / at most by the tree's height (columns and conifers stay
    // slim however much canopy they own, a spreading tree stays wide); old tiles without crown widths: its usual width
    const MINW = [0.5, 0.18, 0.75, 0.6, 0.22, 0.3, 0.4, 0.35, 0.65], MAXW = [1.3, 0.42, 1.7, 1.3, 0.45, 0.6, 0.95, 0.8, 1.5]
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < n; i++) {
      const shape = info[i * 4], fam = SEASONAL ? SEASONAL[info[i * 4 + 1] & 15] ?? 0 : info[i * 4 + 1] & 15, cq = info[i * 4 + 1] >> 4, h = Math.max(3, info[i * 4 + 2]), seed = Math.abs(info[i * 4 + 3])
      P[i * 3] = pos[i * 3]; P[i * 3 + 1] = pos[i * 3 + 1]; P[i * 3 + 2] = pos[i * 3 + 2]
      // the crown's width from the LiDAR canopy (tools/tiles.py crown_q), in the colour byte's high nibble
      const fm = Math.min(FORMS - 1, shape), w = cq ? Math.min(Math.max(2 + cq * 1.4, h * MINW[fm]), h * MAXW[fm]) : h / ASPECT[fm]
      // street trees are pruned up (the 3D trees and the billboards alike): leaves at least 2.5 m up over sidewalks, 4.5 m
      // where the crown reaches over a carriageway; a young tree too small for that keeps its crown off the street instead
      let cw = Math.min(30, Math.max(1.2, w)), clear = fm === 7 ? 0 : 2.5
      if (clear && over(pos[i * 3], -pos[i * 3 + 2], cw * 0.45)) {
        if (h >= 7.5) clear = 4.5
        else while (cw > 2 && over(pos[i * 3], -pos[i * 3 + 2], cw * 0.45)) cw -= 0.75
      }
      S[i * 2] = cw; S[i * 2 + 1] = h * 0.866; CL[i] = Math.min(0.7, clear / h)
      const f = FAMILY[fam] || FAMILY[0], c = f[Math.floor(seed * f.length) % f.length]
      const v = 0.94 + seed * 0.12
      C[i * 3] = c.r * v; C[i * 3 + 1] = c.g * v; C[i * 3 + 2] = c.b * v
      V[i] = shape
      lo = Math.min(lo, pos[i * 3 + 1]); hi = Math.max(hi, pos[i * 3 + 1] + h)
    }
    const g = new THREE.InstancedBufferGeometry().copy(this.quad)
    g.instanceCount = n
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(P, 3)); g.setAttribute('iSize', new THREE.InstancedBufferAttribute(S, 2))
    g.setAttribute('iCol', new THREE.InstancedBufferAttribute(C, 3)); g.setAttribute('iVar', new THREE.InstancedBufferAttribute(V, 1))
    g.setAttribute('iClear', new THREE.InstancedBufferAttribute(CL, 1))
    const s = SIZES[t.level]
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(s / 2, (lo + hi) / 2, -s / 2), s * 0.75 + (hi - lo))
    const m = new THREE.Mesh(g, mat)
    m.position.set(t.ox, 0, -t.oy)
    m.renderOrder = t.oy // northern tiles first: billboards overlap far to near
    m.visible = t.visible
    this.treeScene.add(m)
    return m
  }

  // generic buildings inside these rings (world metres, y north) are skipped: a plugin draws its own there.
  // Collected for a moment, then sent to the workers and the affected tiles rebuilt.
  addMask(ring) {
    (this.masks ||= []).push(ring)
    clearTimeout(this.maskT)
    this.maskT = setTimeout(() => {
      for (const w of this.workers) w.postMessage({ masks: this.masks })
      const bb = this.masks.map((r) => [Math.min(...r.map((p) => p[0])), Math.min(...r.map((p) => p[1])), Math.max(...r.map((p) => p[0])), Math.max(...r.map((p) => p[1]))])
      for (const t of [...this.tiles.values()]) {
        const s = SIZES[t.level]
        if (t.state !== 'ready' || !bb.some((b) => b[2] >= t.ox && b[0] <= t.ox + s && b[3] >= t.oy && b[1] <= t.oy + s)) continue
        const visible = t.visible
        this.drop(t)
        const n = this.get(t.level, t.i, t.j); n.visible = visible; n.used = this.frame
      }
      this.onChange?.()
    }, 50)
  }

  // ready tiles, for plugins that start after some have loaded
  forEach(fn) { for (const t of this.tiles.values()) if (t.state === 'ready') fn(t) }

  // what close views get: balconies and rooftop plant (`balconies`), the ground to 5 cm instead of 25 (`fine`)
  // and the parked cars: 0 none, 1 in the lots (a street-level view: traffic drives where the kerbs' stand), 2 all
  setDetail(balconies, fine, cars = 2) {
    if (balconies === this.balconies && fine === this.fine && cars === this.cars) return
    this.balconies = balconies; this.fine = fine; this.cars = cars
    for (const t of this.tiles.values()) {
      if (t.balcony) t.balcony.visible = balconies
      if (t.poles) t.poles.visible = balconies
      if (t.lot) t.lot.visible = cars > 0
      if (t.kerb) t.kerb.visible = cars > 1
      if (t.coarse) { t.ground.visible = fine; t.coarse.visible = !fine }
      if (t.beach) for (const o of t.beach) o.visible = fine
    }
  }

  evict() {
    for (const level of [0, 1]) {
      const list = [...this.tiles.values()].filter((t) => t.level === level && t.state === 'ready' && t.used < this.frame)
      const max = Math.min(MAX_CACHED[level], this.cached[level])
      if (list.length <= max) continue
      list.sort((a, b) => a.used - b.used)
      for (const t of list.slice(0, list.length - max)) this.drop(t)
    }
  }

  drop(t) {
    this.onUnload?.(t)
    for (const o of [t.group, ...(t.side || [])]) {
      if (!o) continue
      o.removeFromParent()
      // (an instanced mesh's own buffers, the instance matrices and colours, go only with its dispose())
      o.traverse((m) => { if (m.isInstancedMesh) m.dispose(); if (m.geometry && m.geometry !== this.quad && !m.geometry.userData.shared) m.geometry.dispose() })
    }
    this.tiles.delete(this.key(t.level, t.i, t.j))
    this.byIJ.delete(ij(t.level, t.i, t.j))
  }

  // street furniture: the nearest point to (x, y) (world metres, y north) at least `margin` m off the carriageways and
  // cycle tracks the ground draws (the detail tiles' 1 m masks), within maxD m; null where (x, y) is clear already, or
  // no detail tile has it, or nothing clear is that near
  offRoad(x, y, margin = 0.6, maxD = 8) {
    const on = (px, py) => this.onRoad(px, py)
    const clear = (px, py) => !on(px, py) && !on(px + margin, py) && !on(px - margin, py) && !on(px, py + margin) && !on(px, py - margin)
    if (!this.tiles.get(this.key(0, Math.floor(x / 1024), Math.floor(y / 1024)))?.carriage || clear(x, y)) return null
    for (let r = 0.5; r <= maxD; r += 0.5) {
      const n = Math.max(8, Math.ceil(r * 6))
      for (let a = 0; a < n; a++) { const px = x + Math.cos((a / n) * 2 * Math.PI) * r, py = y + Math.sin((a / n) * 2 * Math.PI) * r; if (clear(px, py)) return { x: px, y: py } }
    }
    return null
  }

  // is (x, y) on a carriageway or cycle track as drawn (false where no detail tile is loaded)
  onRoad(x, y) {
    const t = this.tiles.get(this.key(0, Math.floor(x / 1024), Math.floor(y / 1024))), R = t?.carriage
    if (!R) return false
    const k = Math.floor(y - t.oy) * R.n + Math.floor(x - t.ox)
    return !!(R.bits[k >> 3] & (1 << (k & 7)))
  }

  // ground height (metres) at world x east, y north: from the finest loaded tile
  // (called hundreds of times a frame: looked up by number, nothing allocated)
  heightAt(x, y) {
    for (let level = 0; level < 2; level++) {
      const s = SIZES[level], t = this.byIJ.get(ij(level, Math.floor(x / s), Math.floor(y / s)))
      if (t?.terrain) return sampleGrid(t.terrain.h, t.terrain.n, s, x - t.ox, y - t.oy)
    }
    const g = this.coarse
    if (!g) return 0
    const fx = Math.min(g.w - 1.0001, Math.max(0, (x - g.x0) / g.c)), fy = Math.min(g.h - 1.0001, Math.max(0, (g.y1 - y) / g.c))
    const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j, Z = (a, b) => g.z[b * g.w + a] / 10
    return Z(i, j) * (1 - u) * (1 - v) + Z(i + 1, j) * u * (1 - v) + Z(i, j + 1) * (1 - u) * v + Z(i + 1, j + 1) * u * v
  }

  // how much of what's on screen has arrived (0..1), for the loading screen
  progress() {
    let want = 0, got = 0
    for (const t of this.tiles.values()) if (t.used === this.frame) { want++; if (t.state === 'ready' || t.state === 'missing') got++ }
    return want ? got / want : 0
  }
}
