// Landmarks scanned from LiDAR (tools/landmark_scan.py: the City of Vancouver's 2022 set, OGL-Vancouver; outside it
// LidarBC / CanElevation / Coquitlam / Metro Vancouver open sets): a low-poly mesh each (data/<id>.bin, and .lo.bin
// with a quarter of the triangles), fetched when the view comes within NEAR m of it. Further off, and until it has
// loaded, its footprint massing stands there instead (all of them in one mesh). Both wear the generic
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
    const foot = l.rings.flatMap((r) => pairs(r).map(([la, lo]) => { const p = city.world.fromLatLon(la, lo); return [p.x, p.z] }))
    return { id, l, x: a.x, z: a.z, foot, g: groundOf(foot), seed: ((k * 0.618034) % 1) * 0.98 + 0.01, mesh: [], loading: [], want: 0, shown: 0 }
  })
  const kind = (pattern, l) => pattern + l.storey / 64
  // stood on the lowest drawn ground round its outline: the map's ground as loaded now (the coarse 64 m grid at the
  // start, the detail tiles' later), so it is stood again as finer tiles come in (meshes moved, the massing rebuilt)
  function groundOf(foot) { return Math.min(...foot.map(([x, z]) => city.world.heightAt(x, z))) }
  let reground = false
  const offTile = city.on('tile:load', () => { reground = true })

  // ---------- far: the footprint massing of every landmark not drawn near ----------
  let far = null
  function farOf(s) { // its massing's triangles, made once
    const pos = [], col = [], win = []
    const tri = (ps, c, ws, want) => { // wound to face `want`
      const [a, b, d] = ps, nx = (b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]), ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]), nz = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])
      const o = nx * want[0] + ny * want[1] + nz * want[2] < 0 ? [0, 2, 1] : [0, 1, 2]
      for (const i of o) { pos.push(...ps[i]); col.push(...c); win.push(...ws[i]) }
    }
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
    return { pos, col, win }
  }
  function buildFar() {
    const parts = L.filter((s) => !s.shown).map((s) => (s.far ??= farOf(s)))
    const cat = (k, n) => { const a = new Float32Array(parts.reduce((t, p) => t + p[k].length, 0)); let o = 0; for (const p of parts) { a.set(p[k], o); o += p[k].length } return new THREE.BufferAttribute(a, n) }
    const pos = cat('pos', 3)
    if (far) { city.scene.remove(far); far.geometry.dispose(); far = null }
    if (!pos.count) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', pos)
    geo.setAttribute('color', cat('col', 3))
    geo.setAttribute('aWin', cat('win', 4))
    geo.computeVertexNormals()
    far = add(new THREE.Mesh(geo, mat))
  }
  function add(m) { m.castShadow = m.receiveShadow = true; m.userData.landmarks = true; city.scene.add(m); return m }

  // ---------- near: the scan (level 2), a quarter of its triangles (1) a little further off or zoomed out ----------
  let nGot = 0, nWant = 0 // scans fetched / asked for in this burst (city.loading)
  async function load(s, lv) {
    s.loading[lv] = true
    city.loading?.track('landmarks', nGot, ++nWant)
    const buf = await fetch(new URL(`./data/${s.id}${lv === 1 ? '.lo' : ''}.bin`, import.meta.url)).then((r) => r.arrayBuffer()).catch(() => null)
    city.loading?.track('landmarks', ++nGot, nWant); if (nGot >= nWant) nGot = nWant = 0
    if (!buf || dead) return
    const dv = new DataView(buf), nv = dv.getUint32(4, true), nt = dv.getUint32(8, true), q = dv.getFloat32(12, true)
    const P = new Int16Array(buf, 16, nv * 3), o = 16 + nv * 6
    const I = nv < 65536 ? new Uint16Array(buf, o, nt * 3) : new Uint32Array(buf, o, nt * 3)
    const o2 = o + nt * 3 * I.BYTES_PER_ELEMENT, C = new Uint8Array(buf, o2, nt * 3), S = new Int8Array(buf, o2 + nt * 3, nt)
    const pos = new Float32Array(nt * 9), col = new Float32Array(nt * 9), win = new Float32Array(nt * 12)
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], n = new THREE.Vector3(), e = new THREE.Vector3()
    for (let t = 0; t < nt; t++) {
      for (let j = 0; j < 3; j++) { const i = I[t * 3 + j] * 3; v[j].set(s.x + P[i] * q, P[i + 1] * q, s.z + P[i + 2] * q) }
      n.subVectors(v[1], v[0]).cross(e.subVectors(v[2], v[0]))
      const hl = Math.hypot(n.x, n.z) || 1, tx = -n.z / hl, tz = n.x / hl // along the wall, level
      const c = [C[t * 3], C[t * 3 + 1], C[t * 3 + 2]].map((x) => (x / 255) ** 1.8)
      for (let j = 0; j < 3; j++) {
        pos.set([v[j].x, v[j].y, v[j].z], t * 9 + j * 3); col.set(c, t * 9 + j * 3)
        win.set(S[t] ? [kind(S[t], s.l), v[j].x * tx + v[j].z * tz, v[j].y, s.seed + s.l.use] : [0, 0, 999, s.seed], t * 12 + j * 4)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geo.setAttribute('aWin', new THREE.BufferAttribute(win, 4))
    geo.computeVertexNormals() // not indexed: flat
    s.mesh[lv] = add(new THREE.Mesh(geo, mat))
    s.mesh[lv].position.y = s.g
    show(s) && buildFar()
    city.requestRender()
  }
  // the level it wants if that has loaded, else the other one, else the massing; true when the massing changes
  function show(s) {
    const lv = !s.want ? 0 : s.mesh[s.want] ? s.want : s.mesh[3 - s.want] ? 3 - s.want : 0
    for (const k of [1, 2]) if (s.mesh[k]) s.mesh[k].visible = lv === k
    const was = s.shown; s.shown = lv
    return !was !== !lv
  }

  let dead = false, t = 0
  function check() {
    const c = city.view.center, mpp = city.view.metresPerPixel
    let changed = false, moved = false
    if (reground) {
      reground = false
      for (const s of L) {
        const g = groundOf(s.foot)
        if (Math.abs(g - s.g) < 0.05) continue
        s.g = g; s.far = null; moved = true; changed ||= !s.shown
        for (const m of s.mesh) if (m) m.position.y = g
      }
    }
    for (const s of L) {
      const d = Math.hypot(s.x - c.x, s.z - c.z) - s.l.r, k = s.want ? 1.15 : 1
      const want = mpp > 4 || d > NEAR * k ? 0 : mpp < 0.5 * k && d < NEAR * 0.4 * k ? 2 : 1
      if (want === s.want) continue
      s.want = want; moved = true
      if (want && !s.mesh[want] && !s.loading[want]) load(s, want)
      changed = show(s) || changed
    }
    if (changed) buildFar()
    if (moved) city.requestRender()
  }
  buildFar()
  check()
  const offFrame = city.on('frame', (dt) => { if ((t += dt) > 0.4) { t = 0; check() } })
  const offView = city.on('view', check)
  for (const r of scanMasks) city.world.suppressBuildings?.(r)
  return {
    dispose() {
      dead = true; offFrame(); offView(); offTile()
      for (const m of [far, ...L.flatMap((s) => s.mesh)]) if (m) { city.scene.remove(m); m.geometry.dispose() }
      mat.dispose()
    },
  }
}
