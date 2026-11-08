// Landmarks scanned from the City of Vancouver's 2022 LiDAR (tools/landmark_scan.py; Open Government Licence -
// Vancouver): a low-poly mesh each (data/<id>.bin), fetched when the view comes within NEAR m of it. Further off, and
// until it has loaded, its footprint massing stands there instead (all of them in one mesh). Both wear the generic
// buildings' facade material (core/materials.js): windows by the storey, lit at night; roofs keep the LiDAR's colours.
// bin: 'LMS1', vertex count, triangle count, metres per unit (f32); int16 x, y (up, over the ground), z (south) a
// vertex from the anchor; uint16 (uint32 past 65535 vertices) indices; per triangle sRGB bytes and a facade pattern.
import { buildingMaterial } from '../../core/materials.js'
import { getJSON } from '../../core/util.js'
const man = await getJSON(new URL('./data/scans.json', import.meta.url))
const pairs = (f) => { const o = []; for (let i = 0; i < f.length; i += 2) o.push([f[i], f[i + 1]]); return o }
export const scanned = new Set(Object.keys(man))
export const scanMasks = Object.values(man).flatMap((l) => l.rings.map(pairs))
const NEAR = 1100 // m from the view's centre: the scan; past NEAR * 1.15 the massing again
const lin = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255].map((c) => (c / 255) ** 1.8) // as tile-worker.js

export default function scans(city) {
  const { THREE } = city
  const mat = buildingMaterial()
  const L = Object.entries(man).map(([id, l], k) => {
    const a = city.world.fromLatLon(...l.at)
    const g = Math.min(...l.rings.flatMap((r) => pairs(r).map(([la, lo]) => { const p = city.world.fromLatLon(la, lo); return city.world.heightAt(p.x, p.z) })))
    return { id, l, x: a.x, z: a.z, g, seed: ((k * 0.618034) % 1) * 0.98 + 0.01, mesh: null, loading: false, near: false }
  })
  const kind = (pattern, l) => pattern + l.storey / 64

  // ---------- far: the footprint massing of every landmark not drawn near ----------
  let far = null
  function buildFar() {
    const pos = [], col = [], win = []
    const tri = (ps, c, ws, want) => { // wound to face `want`
      const [a, b, d] = ps, nx = (b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]), ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]), nz = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])
      const o = nx * want[0] + ny * want[1] + nz * want[2] < 0 ? [0, 2, 1] : [0, 1, 2]
      for (const i of o) { pos.push(...ps[i]); col.push(...c); win.push(...ws[i]) }
    }
    for (const s of L) {
      if (s.near && s.mesh) continue
      const wall = lin(s.l.wall), roof = lin(s.l.roof), wk = kind(s.l.pattern, s.l), rw = [0, 0, 999, s.seed]
      for (const [mn, h, ...f] of s.l.far) {
        const r = pairs(f).map(([la, lo]) => { const p = city.world.fromLatLon(la, lo); return [p.x, p.z] })
        const [cx, cz] = r.reduce((m, p) => [m[0] + p[0] / r.length, m[1] + p[1] / r.length], [0, 0])
        const y0 = s.g + mn, y1 = s.g + h, w = (uu, y) => [wk, uu, y - s.g, s.seed + s.l.use]
        let u = 0
        for (let i = 0; i < r.length; i++) {
          const a = r[i], b = r[(i + 1) % r.length], len = Math.hypot(b[0] - a[0], b[1] - a[1])
          const want = [(a[0] + b[0]) / 2 - cx, 0, (a[1] + b[1]) / 2 - cz] // outward, near enough for a footprint
          const A0 = [a[0], y0, a[1]], B0 = [b[0], y0, b[1]], B1 = [b[0], y1, b[1]], A1 = [a[0], y1, a[1]]
          tri([A0, B0, B1], wall, [w(u, y0), w(u + len, y0), w(u + len, y1)], want)
          tri([A0, B1, A1], wall, [w(u, y0), w(u + len, y1), w(u, y1)], want)
          u += len
        }
        for (const t of THREE.ShapeUtils.triangulateShape(r.map(([x, z]) => new THREE.Vector2(x, z)), [])) tri(t.map((i) => [r[i][0], y1, r[i][1]]), roof, [rw, rw, rw], [0, 1, 0])
      }
    }
    if (far) { city.scene.remove(far); far.geometry.dispose(); far = null }
    if (!pos.length) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    geo.setAttribute('aWin', new THREE.Float32BufferAttribute(win, 4))
    geo.computeVertexNormals()
    far = add(new THREE.Mesh(geo, mat))
  }
  function add(m) { m.castShadow = m.receiveShadow = true; m.userData.landmarks = true; city.scene.add(m); return m }

  // ---------- near: the scan ----------
  async function load(s) {
    s.loading = true
    const buf = await fetch(new URL(`./data/${s.l.file}`, import.meta.url)).then((r) => r.arrayBuffer()).catch(() => null)
    if (!buf || dead) return
    const dv = new DataView(buf), nv = dv.getUint32(4, true), nt = dv.getUint32(8, true), q = dv.getFloat32(12, true)
    const P = new Int16Array(buf, 16, nv * 3), o = 16 + nv * 6
    const I = nv < 65536 ? new Uint16Array(buf, o, nt * 3) : new Uint32Array(buf, o, nt * 3)
    const o2 = o + nt * 3 * I.BYTES_PER_ELEMENT, C = new Uint8Array(buf, o2, nt * 3), S = new Int8Array(buf, o2 + nt * 3, nt)
    const pos = new Float32Array(nt * 9), col = new Float32Array(nt * 9), win = new Float32Array(nt * 12)
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], n = new THREE.Vector3(), e = new THREE.Vector3()
    for (let t = 0; t < nt; t++) {
      for (let j = 0; j < 3; j++) { const i = I[t * 3 + j] * 3; v[j].set(s.x + P[i] * q, s.g + P[i + 1] * q, s.z + P[i + 2] * q) }
      n.subVectors(v[1], v[0]).cross(e.subVectors(v[2], v[0]))
      const hl = Math.hypot(n.x, n.z) || 1, tx = -n.z / hl, tz = n.x / hl // along the wall, level
      const c = [C[t * 3], C[t * 3 + 1], C[t * 3 + 2]].map((x) => (x / 255) ** 1.8)
      for (let j = 0; j < 3; j++) {
        pos.set([v[j].x, v[j].y, v[j].z], t * 9 + j * 3); col.set(c, t * 9 + j * 3)
        win.set(S[t] ? [kind(S[t], s.l), v[j].x * tx + v[j].z * tz, v[j].y - s.g, s.seed + s.l.use] : [0, 0, 999, s.seed], t * 12 + j * 4)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geo.setAttribute('aWin', new THREE.BufferAttribute(win, 4))
    geo.computeVertexNormals() // not indexed: flat
    s.mesh = add(new THREE.Mesh(geo, mat))
    s.mesh.visible = s.near
    if (s.near) buildFar()
    city.requestRender()
  }

  let dead = false, t = 0
  function check() {
    const c = city.view.center, wide = city.view.metresPerPixel > 4
    let changed = false
    for (const s of L) {
      const d = Math.hypot(s.x - c.x, s.z - c.z) - s.l.r
      const near = !wide && (s.near ? d < NEAR * 1.15 : d < NEAR)
      if (near === s.near) continue
      s.near = near; changed = true
      if (s.mesh) s.mesh.visible = near
      else if (near && !s.loading) load(s)
    }
    if (changed) { buildFar(); city.requestRender() }
  }
  buildFar()
  check()
  const offFrame = city.on('frame', (dt) => { if ((t += dt) > 0.4) { t = 0; check() } })
  const offView = city.on('view', check)
  for (const r of scanMasks) city.world.suppressBuildings?.(r)
  return {
    dispose() {
      dead = true; offFrame(); offView()
      for (const m of [far, ...L.map((s) => s.mesh)]) if (m) { city.scene.remove(m); m.geometry.dispose() }
      mat.dispose()
    },
  }
}
