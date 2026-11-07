// Real low-poly trees near a perspective camera (city.view.useCamera): the map's tree billboards are painted for
// the 30° map camera and read as crowns on sticks at street level, so within RADIUS of the camera each tree is
// drawn as a trunk and a crown (lumpy icosahedra for broadleaf trees, stacked cones for conifers, fronds for
// palms) from the same per-tile tree data (shape, colour, height). The billboards hide inside that circle (the
// tree material's near3d uniforms), so each tree is drawn exactly once. Flat-shaded Lambert like the rest of
// the map, so the sun, the shadows and the ink outlines all apply. One InstancedMesh per shape.
import * as THREE from 'three'

const PHONE = matchMedia('(pointer: coarse)').matches
const R0 = PHONE ? 140 : 190 // metres around the camera (times the quality tier's trees3d share)
const MAX = PHONE ? 1200 : 3000 // trees drawn in 3D at most (the nearest; the circle shrinks in dense parks)
const STEP = 8 // the camera moves this far before the set is rebuilt
const CELL = 64 // per-tile grid of trees, metres
const TRUNK = new THREE.Color(0x4a3a2e), PALM = new THREE.Color(0x5a4636)

// unit trees: 1 tall, crown about 1 wide, origin at the foot. Vertex attribute `crown` is 1 where the instance
// colour applies (leaves) and 0 on the trunk; `shade` darkens lumps a little so a crown isn't one flat colour.
function part(geo, crown, shade, col) {
  if (geo.index) geo = geo.toNonIndexed()
  const n = geo.attributes.position.count
  geo.setAttribute('crown', new THREE.Float32BufferAttribute(new Float32Array(n).fill(crown), 1))
  const c = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { c[i * 3] = col.r * shade; c[i * 3 + 1] = col.g * shade; c[i * 3 + 2] = col.b * shade }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3))
  geo.deleteAttribute('uv')
  return geo
}
function merge(parts) {
  const out = new THREE.BufferGeometry()
  for (const k of ['position', 'normal', 'color', 'crown']) {
    const size = parts[0].attributes[k].itemSize, arr = new Float32Array(parts.reduce((a, g) => a + g.attributes[k].array.length, 0))
    let o = 0
    for (const g of parts) { arr.set(g.attributes[k].array, o); o += g.attributes[k].array.length }
    out.setAttribute(k, new THREE.BufferAttribute(arr, size))
  }
  return out
}
const WHITE = new THREE.Color(1, 1, 1)
const trunk = (top, r = 0.035, col = TRUNK) => part(new THREE.CylinderGeometry(r * 0.75, r, top, 6, 1).translate(0, top / 2, 0), 0, 1, col)
// the biggest lump of a crown rounder (80 faces), the others 20: ~160 triangles a broadleaf tree
const lump = (x, y, z, r, shade, sy = 1, detail = 0) => part(new THREE.IcosahedronGeometry(r, detail).scale(1, sy, 1).rotateY(x * 7 + z * 3).translate(x, y, z), 1, shade, WHITE)
function broadleaf(bottom, lumps, trunkTop) { // crown from `bottom` to 1
  const h = 1 - bottom, cy = bottom + h * 0.5
  return merge([trunk(trunkTop), ...lumps.map(([x, y, z, r, s], i) => lump(x * 0.5, cy + y * h * 0.5, z * 0.5, r * Math.min(1, h * 1.25), s, h * 1.6 > 1 ? 1.25 : 1, i ? 0 : 1))])
}
function conifer(tiers, bottom, w) {
  const parts = [trunk(bottom + 0.1, 0.04)]
  for (let i = 0; i < tiers; i++) {
    const f = i / tiers, y0 = bottom + (1 - bottom) * f * 0.8, hgt = (1 - bottom) * (1.6 / tiers + 0.08), r = w * (1 - f * 0.75) * 0.5
    parts.push(part(new THREE.ConeGeometry(r, Math.min(hgt, 1 - y0), 7, 1).translate(0, y0 + Math.min(hgt, 1 - y0) / 2, 0), 1, 0.86 + 0.14 * f, WHITE))
  }
  return merge(parts)
}
function palm() {
  const parts = [part(new THREE.CylinderGeometry(0.02, 0.03, 0.86, 6, 1).translate(0, 0.43, 0), 0, 1, PALM)]
  for (let i = 0; i < 8; i++) { // fronds: long flat boxes, drooping out from the top
    const g = new THREE.BoxGeometry(0.46, 0.012, 0.08).translate(0.23, 0, 0).rotateZ(-0.35 - (i % 2) * 0.25).rotateY((i / 8) * Math.PI * 2).translate(0, 0.88, 0)
    parts.push(part(g, 1, 0.9 + (i % 3) * 0.06, WHITE))
  }
  parts.push(lump(0, 0.88, 0, 0.06, 0.8))
  return merge(parts)
}
// shapes (tools/tiles.py): 0 round, 1 columnar, 2 spreading, 3 weeping, 4 fir, 5 cedar, 6 pine, 7 palm
const L5 = [[0, 0.1, 0, 0.42, 1], [-0.45, -0.25, 0.2, 0.32, 0.9], [0.45, -0.2, -0.15, 0.33, 0.95], [0.1, -0.3, 0.5, 0.3, 0.86], [-0.05, 0.5, -0.3, 0.3, 1.06]]
const SHAPES = [
  () => broadleaf(0.3, L5, 0.55),
  () => broadleaf(0.18, [[0, 0.25, 0, 0.5, 1.02], [0, -0.35, 0.1, 0.48, 0.9], [0.1, 0.65, -0.1, 0.36, 1.06]], 0.4),
  () => broadleaf(0.36, [...L5, [0.65, 0.05, 0.35, 0.28, 0.96], [-0.6, 0.1, -0.4, 0.28, 0.92]], 0.6),
  () => broadleaf(0.12, [[0, 0.3, 0, 0.45, 1.02], [-0.4, -0.3, 0.2, 0.36, 0.86], [0.4, -0.35, -0.2, 0.36, 0.88], [0, -0.4, -0.45, 0.33, 0.84]], 0.5),
  () => conifer(5, 0.08, 0.8),
  () => conifer(6, 0.06, 0.9),
  () => broadleaf(0.5, [[0, 0.2, 0, 0.42, 1], [-0.5, -0.1, 0.25, 0.3, 0.9], [0.5, 0, -0.2, 0.32, 0.94]], 0.8),
  palm,
]

export class Trees3D {
  constructor({ scene, tiles, treeMaterial }) {
    Object.assign(this, { scene, tiles, treeMaterial })
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
    mat.onBeforeCompile = (s) => { // the instance colour tints the leaves only
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float crown;')
        .replace('#include <color_vertex>', THREE.ShaderChunk.color_vertex.replace('vColor.xyz *= instanceColor.xyz;', 'vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, crown);'))
        // a tree the camera stands in (a street tree over the sidewalk) would fill the view with leaves: not drawn
        // (its shadow still is)
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec3 foot = (modelMatrix * instanceMatrix[3]).xyz;
          if (distance(foot.xz, cameraPosition.xz) < length(instanceMatrix[0].xyz) * 0.6 + 1.5 && cameraPosition.y < foot.y + length(instanceMatrix[1].xyz) + 1.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);`)
    }
    mat.customProgramCacheKey = () => 'tree3d'
    this.meshes = SHAPES.map((f) => {
      const m = new THREE.InstancedMesh(f(), mat, MAX)
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3)
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.instanceColor.setUsage(THREE.DynamicDrawUsage)
      m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false
      return m
    })
    this.group = new THREE.Group()
    this.group.add(...this.meshes)
    this.at = new THREE.Vector3(Infinity, 0, 0)
    this.grids = new WeakMap()
    this.share = 1 // of the radius (main.js, from the quality tier)
    this.near = [] // scratch: [distance², tile, index]
    this.M = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.s = new THREE.Vector3(); this.p = new THREE.Vector3(); this.c = new THREE.Color()
  }

  // per frame while a perspective camera draws the map; off() when it doesn't
  update(camera) {
    if (!this.group.parent) this.scene.add(this.group)
    const cx = camera.position.x, cz = camera.position.z
    if (Math.hypot(cx - this.at.x, cz - this.at.z) < STEP && !this.dirty) return false
    this.dirty = false
    this.at.set(cx, 0, cz)
    this.rebuild(cx, cz)
    return true
  }
  off() {
    if (!this.group.parent) return
    this.group.removeFromParent()
    this.at.set(Infinity, 0, 0)
    this.treeMaterial.uniforms.near3d.value.set(0, 0, 0)
  }
  // a tile came or went: rebuild on the next update
  changed() { this.dirty = true }

  grid(t) { // tree indices of a tile by 64 m cell
    let g = this.grids.get(t)
    if (g) return g
    const P = t.trees.geometry.attributes.iPos.array, n = P.length / 3, s = t.level ? 4096 : 1024, k = s / CELL
    const cnt = new Uint32Array(k * k + 1)
    for (let i = 0; i < n; i++) cnt[this.cell(P, i, k) + 1]++
    for (let i = 0; i < k * k; i++) cnt[i + 1] += cnt[i]
    const idx = new Uint32Array(n), fill = cnt.slice(0, k * k)
    for (let i = 0; i < n; i++) idx[fill[this.cell(P, i, k)]++] = i
    g = { start: cnt, idx, k }
    this.grids.set(t, g)
    return g
  }
  cell(P, i, k) { return Math.min(k - 1, Math.max(0, Math.floor(-P[i * 3 + 2] / CELL))) * k + Math.min(k - 1, Math.max(0, Math.floor(P[i * 3] / CELL))) }

  rebuild(cx, cz) {
    const RADIUS = R0 * this.share, near = this.near, R2 = RADIUS * RADIUS
    let n = 0
    for (const t of this.tiles.tiles.values()) {
      if (t.state !== 'ready' || !t.trees?.visible) continue
      const s = t.level ? 4096 : 1024, lx = cx - t.ox, ly = -cz - t.oy // camera in tile-local metres (y north)
      if (lx < -RADIUS || ly < -RADIUS || lx > s + RADIUS || ly > s + RADIUS) continue
      const g = this.grid(t), P = t.trees.geometry.attributes.iPos.array
      const i0 = Math.max(0, Math.floor((lx - RADIUS) / CELL)), i1 = Math.min(g.k - 1, Math.floor((lx + RADIUS) / CELL))
      const j0 = Math.max(0, Math.floor((ly - RADIUS) / CELL)), j1 = Math.min(g.k - 1, Math.floor((ly + RADIUS) / CELL))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        for (let q = g.start[j * g.k + i]; q < g.start[j * g.k + i + 1]; q++) {
          const e = g.idx[q], dx = P[e * 3] - lx, dy = -P[e * 3 + 2] - ly, d2 = dx * dx + dy * dy
          if (d2 >= R2) continue
          const r = near[n] || (near[n] = [0, null, 0])
          r[0] = d2; r[1] = t; r[2] = e; n++
        }
      }
    }
    let R = RADIUS
    if (n > MAX) { // keep the nearest
      const live = near.slice(0, n).sort((a, b) => a[0] - b[0])
      for (let i = 0; i < n; i++) near[i] = live[i]
      R = Math.sqrt(near[MAX][0]); n = MAX
    }
    const counts = this.meshes.map(() => 0), { M, q, s, p, c } = this
    for (let k = 0; k < n; k++) {
      const [, t, e] = near[k], A = t.trees.geometry.attributes
      const shape = A.iVar.array[e] | 0, mesh = this.meshes[shape], w = A.iSize.array[e * 2], h = A.iSize.array[e * 2 + 1] / 0.866
      const x = A.iPos.array[e * 3], y = A.iPos.array[e * 3 + 1], z = A.iPos.array[e * 3 + 2]
      const seed = (x * 0.37 + z * 0.73) % 6.283
      p.set(t.ox + x, y - 0.1, -t.oy + z)
      q.setFromAxisAngle(UP, seed)
      s.set(w * (shape === 1 ? 1.1 : 1), h, w * (0.9 + 0.2 * Math.abs(Math.sin(seed * 3.1))))
      const i = counts[shape]++
      mesh.setMatrixAt(i, M.compose(p, q, s))
      c.fromArray(A.iCol.array, e * 3).multiplyScalar(0.8) // lit by the sun, a little darker than the painted billboards
      mesh.setColorAt(i, c)
    }
    this.meshes.forEach((m, i) => { // upload only what is drawn
      m.count = counts[i]
      for (const a of [m.instanceMatrix, m.instanceColor]) { a.clearUpdateRanges(); a.addUpdateRange(0, counts[i] * a.itemSize); a.needsUpdate = true }
    })
    // the billboards inside the circle step aside
    this.treeMaterial.uniforms.near3d.value.set(cx, cz, R)
  }
}
const UP = new THREE.Vector3(0, 1, 0)
