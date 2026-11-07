// Streams map tiles for what is on screen. Two levels: 4096 m medium tiles cover any view; 1024 m detail tiles
// replace a medium tile once every detail tile of it that is on screen has arrived (so there are never holes).
// Decoding and geometry building happen in workers; this file only makes three.js objects from their buffers.
import * as THREE from 'three'
import { FAMILY } from './materials.js'

const SIZES = [1024, 4096]
const DETAIL_ZOOM = 0.11 // camera.zoom from which detail tiles load (a 1 km tile is ~700 px wide)
const MAX_CACHED = [80, 48]
const WORKERS = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 2))

export class Tiles {
  constructor({ scene, treeScene, mats, base = 'tiles/', onLoad, onUnload, onChange }) {
    Object.assign(this, { scene, treeScene, mats, onLoad, onUnload, onChange })
    this.base = new URL(base, location.href).href // absolute: workers resolve relative URLs against their own path
    this.tiles = new Map() // "level/i_j" -> tile
    this.queue = []
    this.busy = 0
    this.frame = 0
    this.workers = Array.from({ length: WORKERS }, () => new Worker(new URL('./tile-worker.js', import.meta.url), { type: 'module' }))
    this.pending = new Map()
    let seq = 0
    this.request = (msg) => new Promise((ok) => { const id = ++seq; this.pending.set(id, ok); this.workers[id % WORKERS].postMessage({ id, ...msg }) })
    for (const w of this.workers) w.onmessage = ({ data }) => { const ok = this.pending.get(data.id); this.pending.delete(data.id); ok?.(data) }
    this.unitGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
    this.unitMat = new THREE.MeshLambertMaterial()
    this.quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)
    this.balconies = true
  }

  async init() {
    const idx = await fetch(this.base + 'index.json', { cache: 'no-cache' }).then((r) => r.json())
    this.index = idx
    this.have = [new Set(idx.l0), new Set(idx.l1)]
    // a coarse height grid of the whole map (tools/heights.py), so heights are right before tiles arrive
    try {
      const r = await fetch(`${this.base}heights.bin?v=${idx.built || 0}`)
      const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
      const dv = new DataView(buf)
      this.coarse = { x0: dv.getFloat32(4, true), y1: dv.getFloat32(8, true), c: dv.getFloat32(12, true), w: dv.getUint32(16, true), h: dv.getUint32(20, true), z: new Int16Array(buf, 24) }
    } catch (e) { console.warn('heights', e) }
    return idx
  }

  key(level, i, j) { return `${level}/${i}_${j}` }

  // the ground rectangle on screen (world metres, y north), padded north for tall things; with a perspective
  // camera (city.view.useCamera) a square of half-size `radius` around the target
  viewRect(camera, target, radius) {
    if (camera.isPerspectiveCamera) { const x = target.x, y = -target.z; return { x0: x - radius, x1: x + radius, y0: y - radius, y1: y + radius } }
    const z = camera.zoom, hw = (camera.right - camera.left) / z / 2, vh = (camera.top - camera.bottom) / z / 2
    const cx = target.x, cn = -target.z
    // ground depth seen = screen height / sin(30°); the target sits mid-screen
    return { x0: cx - hw - 60, x1: cx + hw + 60, y0: cn - vh * 2 - 60, y1: cn + vh * 2 + 60 + Math.min(2500, 300 / Math.max(z, 0.05)) }
  }

  update(camera, target, radius = 900) {
    if (!this.index) return
    this.frame++
    const r = this.viewRect(camera, target, radius)
    const wantDetail = camera.isPerspectiveCamera ? radius <= 1100 : camera.zoom >= DETAIL_ZOOM
    const need = []
    const range = (lvl) => { const s = SIZES[lvl]; return [Math.floor(r.x0 / s), Math.floor(r.x1 / s), Math.floor(r.y0 / s), Math.floor(r.y1 / s)] }
    const [a0, a1, b0, b1] = range(1)
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2
    for (let i = a0; i <= a1; i++) for (let j = b0; j <= b1; j++) {
      if (!this.have[1].has(`${i}_${j}`)) continue
      const p = this.get(1, i, j)
      p.used = this.frame
      if (p.state === 'new') need.push([p, Math.hypot((i + 0.5) * 4096 - cx, (j + 0.5) * 4096 - cy)])
      let kidsReady = wantDetail, any = false
      if (wantDetail) {
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
          const ki = i * 4 + a, kj = j * 4 + b
          if (!this.have[0].has(`${ki}_${kj}`)) continue
          if ((ki + 1) * 1024 < r.x0 || ki * 1024 > r.x1 || (kj + 1) * 1024 < r.y0 || kj * 1024 > r.y1) continue
          const k = this.get(0, ki, kj)
          k.used = this.frame; any = true
          if (k.state === 'new') need.push([k, Math.hypot((ki + 0.5) * 1024 - cx, (kj + 0.5) * 1024 - cy) - 1e5])
          if (k.state !== 'ready' && k.state !== 'missing') kidsReady = false
        }
      }
      const fine = wantDetail && any && kidsReady
      this.show(p, !fine)
      for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
        const k = this.tiles.get(this.key(0, i * 4 + a, j * 4 + b))
        if (k) this.show(k, fine && k.used === this.frame)
      }
    }
    for (const t of this.tiles.values()) if (t.used < this.frame && t.visible) this.show(t, false)
    need.sort((x, y) => x[1] - y[1])
    for (const [t] of need) this.load(t)
    this.evict()
  }

  get(level, i, j) {
    const k = this.key(level, i, j)
    let t = this.tiles.get(k)
    if (!t) { t = { level, i, j, ox: i * SIZES[level], oy: j * SIZES[level], state: 'new', used: 0, visible: false }; this.tiles.set(k, t) }
    return t
  }

  show(t, on) {
    if (t.visible === on) return
    t.visible = on
    if (t.group) { t.group.visible = on; t.trees && (t.trees.visible = on) }
    this.onChange?.()
  }

  async load(t) {
    t.state = 'loading'
    const res = await this.request({ url: `${this.base}${t.level}/${t.i}_${t.j}.bin?v=${this.index.built || 0}`, level: t.level })
    if (res.missing || res.error) { t.state = 'missing'; if (res.error) console.warn(res.error); this.onChange?.(); return }
    if (t.state !== 'loading') return // evicted while loading
    await new Promise(requestAnimationFrame) // at most about one new tile per frame, so panning never stutters
    if (t.state !== 'loading') return
    this.make(t, res)
    t.state = 'ready'
    this.onLoad?.(t)
    this.onChange?.()
  }

  make(t, res) {
    const g = new THREE.Group()
    g.position.set(t.ox, 0, -t.oy)
    g.visible = t.visible
    t.terrain = res.terrain
    t.graph = res.graph
    t.footprints = res.footprints || null
    t.water = res.water || null
    // once a geometry is on the GPU its arrays are dropped from memory (bounds are computed first, for culling)
    const free = (geo) => { geo.computeBoundingSphere(); geo.computeBoundingBox(); for (const a of [...Object.values(geo.attributes), geo.index]) if (a) a.onUpload(function () { this.array = null }) }
    const add = (geo, mat, opts = {}) => { free(geo); const m = new THREE.Mesh(geo, mat); Object.assign(m, opts); m.matrixAutoUpdate = false; m.updateMatrix(); g.add(m); return m }
    if (res.ground) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(res.ground.position, 3))
      geo.setAttribute('cls', new THREE.BufferAttribute(res.ground.cls, 1))
      geo.setIndex(new THREE.BufferAttribute(res.ground.index, 1))
      geo.setAttribute('normal', new THREE.BufferAttribute(res.ground.normal, 3, true))
      add(geo, this.mats.ground, { receiveShadow: true })
    }
    if (res.roads) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(res.roads.position, 3))
      geo.setAttribute('aRoad', new THREE.BufferAttribute(res.roads.aRoad, 4))
      geo.setAttribute('aRoad2', new THREE.BufferAttribute(res.roads.aRoad2, 4))
      geo.setIndex(new THREE.BufferAttribute(res.roads.index, 1))
      geo.setAttribute('normal', new THREE.BufferAttribute(res.roads.normal, 3, true))
      add(geo, this.mats.road, { receiveShadow: true })
    }
    const bgeo = (b) => {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(b.position, 3))
      geo.setAttribute('normal', new THREE.BufferAttribute(b.normal, 3, true))
      geo.setAttribute('color', new THREE.BufferAttribute(b.color, 3, true))
      geo.setAttribute('aWin', new THREE.BufferAttribute(b.aWin, 4))
      return geo
    }
    if (res.buildings?.position.length) add(bgeo(res.buildings), this.mats.building, { castShadow: true, receiveShadow: true })
    if (res.balconies) { t.balcony = add(bgeo(res.balconies), this.mats.building, { castShadow: true, receiveShadow: true }); t.balcony.visible = this.balconies }
    if (res.units) {
      const n = res.units.length / 7, m = new THREE.InstancedMesh(this.unitGeo, this.unitMat, n), M = new THREE.Matrix4(), c = new THREE.Color()
      for (let i = 0; i < n; i++) {
        const u = res.units.subarray(i * 7, i * 7 + 7)
        m.setMatrixAt(i, M.makeScale(u[3], u[4], u[5]).setPosition(u[0], u[1], u[2])); m.setColorAt(i, c.setRGB(u[6] * 0.92, u[6] * 0.95, u[6]))
      }
      m.castShadow = true; m.receiveShadow = true
      m.computeBoundingSphere()
      t.units = m; g.add(m); m.visible = this.balconies
    }
    this.scene.add(g)
    t.group = g
    if (res.trees) t.trees = this.makeTrees(t, res.trees)
  }

  makeTrees(t, { pos, info }) {
    const n = pos.length / 3
    const P = new Float32Array(n * 3), S = new Float32Array(n * 2), C = new Float32Array(n * 3), V = new Float32Array(n)
    const W = [0.75, 0.42, 1.0, 0.8, 0.36, 0.46, 0.62, 0.62], H = [1.08, 1.05, 1.0, 1.08, 1.05, 1.05, 1.0, 1.05]
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < n; i++) {
      const shape = info[i * 4], fam = info[i * 4 + 1], h = Math.max(3, info[i * 4 + 2]), seed = Math.abs(info[i * 4 + 3])
      P[i * 3] = pos[i * 3]; P[i * 3 + 1] = pos[i * 3 + 1]; P[i * 3 + 2] = pos[i * 3 + 2]
      S[i * 2] = Math.min(22, Math.max(2.6, h * W[shape])); S[i * 2 + 1] = h * 0.866 * H[shape]
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
    const s = SIZES[t.level]
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(s / 2, (lo + hi) / 2, -s / 2), s * 0.75 + (hi - lo))
    const m = new THREE.Mesh(g, this.mats.tree)
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

  setBalconies(on) {
    if (on === this.balconies) return
    this.balconies = on
    for (const t of this.tiles.values()) { if (t.balcony) t.balcony.visible = on; if (t.units) t.units.visible = on }
  }

  evict() {
    for (const level of [0, 1]) {
      const list = [...this.tiles.values()].filter((t) => t.level === level && t.state === 'ready' && t.used < this.frame)
      if (list.length <= MAX_CACHED[level]) continue
      list.sort((a, b) => a.used - b.used)
      for (const t of list.slice(0, list.length - MAX_CACHED[level])) this.drop(t)
    }
  }

  drop(t) {
    this.onUnload?.(t)
    for (const o of [t.group, t.trees]) {
      if (!o) continue
      o.removeFromParent()
      o.traverse((m) => { if (m.geometry && m.geometry !== this.unitGeo && m.geometry !== this.quad) m.geometry.dispose() })
    }
    this.tiles.delete(this.key(t.level, t.i, t.j))
  }

  // ground height (metres) at world x east, y north: from the finest loaded tile
  heightAt(x, y) {
    for (const level of [0, 1]) {
      const s = SIZES[level], t = this.tiles.get(this.key(level, Math.floor(x / s), Math.floor(y / s)))
      if (t?.terrain) {
        const { n, h } = t.terrain, c = s / (n - 1), lx = x - t.ox, ly = y - t.oy
        const fx = Math.min(n - 1.0001, Math.max(0, lx / c)), fy = Math.min(n - 1.0001, Math.max(0, (s - ly) / c))
        const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j
        return h[j * n + i] * (1 - u) * (1 - v) + h[j * n + i + 1] * u * (1 - v) + h[(j + 1) * n + i] * (1 - u) * v + h[(j + 1) * n + i + 1] * u * v
      }
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
