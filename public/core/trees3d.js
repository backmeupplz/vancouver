// Real low-poly trees near a perspective camera (city.view.useCamera): within RADIUS of the camera each tree is drawn
// in 3D in its species' form (treeforms.js: round, columnar, spreading, weeping, fir, cedar, pine, palm, vase) from the
// same per-tile tree data (form, colour, height, crown width) as the billboards beyond, which are pictures of these same
// forms. The billboards hide inside that circle (the tree material's near3d uniforms), so each tree is drawn exactly
// once. Flat-shaded Lambert like the rest of the map, so the sun, the shadows and the ink outlines all apply. One
// InstancedMesh per form and level of detail.
import * as THREE from 'three'
import { occluder, OCCLUDE, DISSOLVE } from './materials.js'
import { treeForm, FORMS } from './treeforms.js'

const PHONE = matchMedia('(pointer: coarse)').matches
const R0 = PHONE ? 140 : 190 // metres around the camera (times the quality tier's trees3d share)
const MAX = PHONE ? 1200 : 3000 // trees drawn in 3D at most (the nearest; the circle shrinks in dense parks)
const STEP = 8 // the camera moves this far before the set is rebuilt
const CELL = 64 // per-tile grid of trees, metres
const TURN = 0.2 // radians the camera turns before the set is rebuilt
const LOD = 60 // metres (times the share): the nearer trees get the finer forms, the rest (and all on Low) the coarse
export class Trees3D {
  constructor({ scene, tiles, treeMaterial }) {
    Object.assign(this, { scene, tiles, treeMaterial })
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
    mat.onBeforeCompile = (s) => {
      s.uniforms.occluder = occluder
      s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>\nattribute float crown;\nattribute vec2 iBase;\nvarying float vFade;\nvarying vec3 vWp;\n${OCCLUDE}`)
        // street trees are pruned up: the crown starts at iBase.y (share of the height) instead of the model's iBase.x,
        // the trunk stretched to meet it, so vans, buses and walkers pass under the leaves
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          { float b0 = iBase.x, b = max(iBase.y, b0); transformed.y = transformed.y < b0 ? transformed.y * b / b0 : b + (transformed.y - b0) * (1.0 - b) / (1.0 - b0); }`)
        .replace('#include <color_vertex>', THREE.ShaderChunk.color_vertex.replace('vColor.xyz *= instanceColor.xyz;', 'vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, crown);'))
        // a tree whose crown is between the camera and the player, that the camera stands under (a street tree over
        // the sidewalk would fill the view with leaves) or whose crown is right by the lens, dissolves (its shadow stays)
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec3 foot = (modelMatrix * instanceMatrix[3]).xyz;
          float cw = length(instanceMatrix[0].xyz) * 0.5, ch = length(instanceMatrix[1].xyz);
          vec3 cc = foot + vec3(0.0, ch * 0.62, 0.0);
          float stand = step(distance(foot.xz, cameraPosition.xz), cw * 1.2 + 1.5) * step(cameraPosition.y, foot.y + ch + 1.0);
          vFade = max(occluded(cc, cw), max(stand, 1.0 - smoothstep(1.4, 1.9, distance(cc, cameraPosition) / cw)));
          vWp = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`)
      s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>\nvarying float vFade;\nvarying vec3 vWp;\n${DISSOLVE}`)
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\ndissolve(vWp, vFade);')
    }
    mat.customProgramCacheKey = () => 'tree3d3'
    this.meshes = Array.from({ length: FORMS * 2 }, (_, k) => { // [form 0 fine, form 0 coarse, form 1 fine, …]
      const geo = treeForm(THREE, k >> 1, k & 1), P = geo.attributes.position.array, Cr = geo.attributes.crown.array
      let b0 = 1
      for (let i = 0; i < Cr.length; i++) if (Cr[i] > 0.5) b0 = Math.min(b0, P[i * 3 + 1]) // where the model's leaves start
      geo.setAttribute('iBase', new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2).fill(Math.max(0.02, b0)), 2))
      const m = new THREE.InstancedMesh(geo, mat, MAX)
      m.userData.b0 = Math.max(0.02, b0)
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
    this.fine = true // the finer forms near the camera (main.js: the tier's detail)
    this.near = [] // scratch: [distance², tile, index]
    this.M = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.s = new THREE.Vector3(); this.p = new THREE.Vector3(); this.c = new THREE.Color()
  }

  // per frame while a perspective camera draws the map; off() when it doesn't
  update(camera) {
    if (!this.group.parent) this.scene.add(this.group)
    const cx = camera.position.x, cz = camera.position.z, e = camera.matrixWorld.elements
    // the trees in view come first in each mesh and only they are drawn (a street-level camera sees a sixth of the
    // circle; they were most of its triangles), all of them in a frame that redraws the shadow map (main.js: all(on)).
    // In view: within the camera's horizontal field and TURN more each side (it turns that far before the next
    // rebuild), or right by it (a crown overhead, a steep look down)
    const yaw = Math.atan2(-e[8], -e[10]), half = Math.atan(Math.tan(camera.fov * Math.PI / 360) * Math.max(1, camera.aspect)) + 2 * TURN
    const turned = Math.abs(Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw))) > TURN || Math.abs(half - this.half) > 0.02
    if (Math.hypot(cx - this.at.x, cz - this.at.z) < STEP && !turned && !this.dirty) return false
    this.dirty = false
    this.at.set(cx, 0, cz); this.yaw = yaw; this.half = half
    this.rebuild(cx, cz)
    return true
  }
  all(on) { if (on === this.whole) return; this.whole = on; this.meshes.forEach((m) => { m.count = on ? m.userData.all : m.userData.seen }) }
  off() {
    if (!this.group.parent) return
    this.group.removeFromParent()
    this.at.set(Infinity, 0, 0)
    this.treeMaterial.uniforms.near3d.value.set(0, 0, 0, 0)
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
          if (d2 >= R2 || (t.level && this.tiles.inHole(t.ox + P[e * 3], t.oy - P[e * 3 + 2]))) continue // a detail tile has it
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
    const counts = this.meshes.map(() => 0), { M, q, s, p, c } = this, L2 = this.fine ? (LOD * this.share) ** 2 : -1
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), cosH = Math.cos(Math.min(Math.PI, this.half))
    const inView = (t, e, d2) => { const P = t.trees.geometry.attributes.iPos.array, dx = t.ox + P[e * 3] - cx, dz = -t.oy + P[e * 3 + 2] - cz; return d2 < 900 || dx * fx + dz * fz > cosH * Math.sqrt(d2) }
    for (let pass = 0; pass < 2; pass++) { // in view, then the rest
      if (pass) this.meshes.forEach((m, i) => { m.userData.seen = counts[i] })
      for (let k = 0; k < n; k++) {
        const [d2, t, e] = near[k], A = t.trees.geometry.attributes
        if (inView(t, e, d2) === !!pass) continue
        const shape = Math.min(FORMS - 1, A.iVar.array[e] | 0), m = shape * 2 + (d2 < L2 ? 0 : 1), mesh = this.meshes[m], h = A.iSize.array[e * 2 + 1] / 0.866
        const w = A.iSize.array[e * 2], x = A.iPos.array[e * 3], y = A.iPos.array[e * 3 + 1], z = A.iPos.array[e * 3 + 2]
        const seed = (x * 0.37 + z * 0.73) % 6.283 // (the billboards turn and deepen their pictures alike, materials.js)
        p.set(t.ox + x, y - 0.1, -t.oy + z)
        q.setFromAxisAngle(UP, seed)
        s.set(w, h, w * (0.88 + 0.24 * Math.abs(Math.sin(seed * 3.1))))
        const i = counts[m]++
        mesh.setMatrixAt(i, M.compose(p, q, s))
        mesh.geometry.attributes.iBase.setXY(i, mesh.userData.b0, A.iClear.array[e]) // pruned up (tiles.js makeTrees)
        c.fromArray(A.iCol.array, e * 3) // the billboard's colour
        mesh.setColorAt(i, c)
      }
    }
    this.meshes.forEach((m, i) => { // upload only what is drawn
      m.userData.all = counts[i]; m.count = this.whole ? counts[i] : m.userData.seen; m.visible = counts[i] > 0
      for (const a of [m.instanceMatrix, m.instanceColor, m.geometry.attributes.iBase]) { a.clearUpdateRanges(); a.addUpdateRange(0, counts[i] * a.itemSize); a.needsUpdate = true }
    })
    // the billboards inside the circle step aside; over its last stretch they fade in over the 3D trees (and the camera
    // moves on up to STEP before the next rebuild: they are whole by then)
    this.treeMaterial.uniforms.near3d.value.set(cx, cz, R - STEP, (R - STEP) * 0.15)
  }
}
const UP = new THREE.Vector3(0, 1, 0)
