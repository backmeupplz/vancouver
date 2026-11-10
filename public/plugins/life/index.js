// Life: traffic, traffic lights and people on the real streets of whatever map tiles are loaded.
// The street graph, signals, crossings, stop signs, benches and bus stops come from the map tiles
// (OpenStreetMap, © OpenStreetMap contributors, ODbL). The simulation runs in worker.js; this file streams the
// nearby tiles to it, ticks it once per drawn frame and draws what it sends back: one instanced mesh per kind of
// car, one for people and one for cyclists (positioned in the vertex shader straight from the worker's floats; the
// cars moved on to each frame's time), plus the signal poles and heads at signalled junctions. Nothing runs when zoomed out, switched off or hidden.
// It publishes city.traffic (see PLUGINS.md): where the cars, people and signal poles are, obstacles (a player's van)
// they brake for, and bumps (a car hit stops a moment, a person knocked stumbles or falls over and gets up again).

import { kit } from '../../core/kit.js'
import { carModels, peopleModels, farModels, lifeMaterial, H, OUTFIT, signalModels, postModel, DETAIL, ARM_Y, ARM_BLADE, POST_BLADES, LENSES, POLE_LENSES, PED_LENSES } from './models.js'
import { blades } from './blades.js'

import { vancouver } from '../../core/util.js'
import { nearestStreet } from '../../core/streets.js'

const CAR_ZOOM = 0.08, PEOPLE_ZOOM = 0.25
const MAP_NEAR = 1.4 // the map's zoom from which it draws the detailed models too (a car 40 px long)
const NEAR = [150, 70, 240, 150], SIG_CAP = 200, POST_CAP = 150 // metres (cars, people, signals, street names): under a perspective camera, the detailed models (models.js) within these, times the quality tier's `near`
const KEY = 'vancouver.life'
const MOBILE = matchMedia('(pointer: coarse)').matches || innerWidth < 700
const MAX_CARS = MOBILE ? 2000 : 4000, MAX_PEOPLE = MOBILE ? 1500 : 3000, MAX_BIKES = 300, MAX_NEAR = 600
const KINDS = 6 // sedan, suv, van, truck, taxi, police

export default function life(city) {
  const { THREE } = city
  const set = { on: true, cars: true, people: true, bikes: true, density: 1 }
  try { Object.assign(set, JSON.parse(localStorage.getItem(KEY)) || {}) } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(set)) } catch {} }

  // ---------------------------------------------------------------- models
  const uni = { uNight: { value: 0 }, uTime: { value: 0 }, uRain: { value: 0 }, uCam: { value: new THREE.Vector3() } }
  let NEAR_CARS, NEAR_PEOPLE, SIG_NEAR, NAME_NEAR
  const nearRadii = () => { [NEAR_CARS, NEAR_PEOPLE, SIG_NEAR, NAME_NEAR] = NEAR.map((r) => r * (city.quality?.tier.near ?? 1)) }
  nearRadii()
  const nearCars = { value: 0 }, nearPeople = { value: 0 }
  const { cars: MODELS, person, bike } = farModels(THREE)
  const material = (kind, hide) => lifeMaterial(THREE, uni, kind, hide)
  const group = new THREE.Group(), glowGroup = new THREE.Group()
  city.scene.add(group); city.overlay.add(glowGroup)
  // instanced meshes whose per-instance data is an 8-float interleaved buffer filled from the worker
  function instanced(geo, mat, cap, parent = group) {
    const ib = new THREE.InstancedInterleavedBuffer(new Float32Array(cap * 8), 8).setUsage(THREE.DynamicDrawUsage)
    const g = new THREE.InstancedBufferGeometry().copy(geo)
    g.instanceCount = 0
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 4, 0))
    g.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 4, 4))
    const m = new THREE.Mesh(g, mat)
    m.frustumCulled = false; m.receiveShadow = true; m.matrixAutoUpdate = false
    parent.add(m)
    return { m, ib, cap }
  }
  const carMat = material('car', nearCars), personMat = material('person', nearPeople), bikeMat = material('bike')
  const carNearMat = material('car'), personNearMat = material('person')
  const carMeshes = MODELS.map((g) => instanced(g, carMat, MAX_CARS))
  const people = instanced(person, personMat, MAX_PEOPLE)
  // the detailed models near a perspective camera, filled from the same buffer (pickNear())
  const carsNear = carModels(THREE).map((g) => instanced(g, carNearMat, MAX_NEAR))
  const peopleNear = peopleModels(THREE).map((g) => instanced(g.scale(H, H, H), personNearMat, MAX_NEAR))
  const allNear = [...carsNear, ...peopleNear]
  const pickCar = MODELS.map((_, k) => (buf, s) => carsNear[DETAIL(k, buf[s + 7] % 2)]) // by kind and seed
  const pickPerson = (buf, s) => peopleNear[OUTFIT((buf[s + 5] % 1) / 0.9)] // by seed (pose + 0.9 seed)
  const bikes = instanced(bike, bikeMat, MAX_BIKES)
  // light on the road at night (overlay, additive): a headlight pool ahead of each car and a red glow behind,
  // sharing the cars' instance buffers. x is metres out from the bumper; z across; w: 0 ahead, 1 behind
  const poolGeo = new THREE.BufferGeometry()
  const quad = (x0, x1, z0, z1, w) => [x0, -z0, w, x1, -z1, w, x1, z1, w, x0, -z0, w, x1, z1, w, x0, z0, w]
  poolGeo.setAttribute('position', new THREE.Float32BufferAttribute([...quad(0, 10, 0.9, 3.4, 0), ...quad(0, 3, 0.9, 1.4, 1)], 3))
  const HALF = MODELS.map((g) => { g.computeBoundingBox(); return g.boundingBox.max.x })
  const WIDE = MODELS.map((g) => g.boundingBox.max.z * 2)
  const pools = carMeshes.map(({ ib }, k) => {
    const g = new THREE.InstancedBufferGeometry().copy(poolGeo)
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 4, 0)); g.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 4, 4))
    g.instanceCount = 0
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...uni, uHalf: { value: HALF[k] } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec4 iA, iB; uniform float uHalf; varying float vF, vRear, vBrake;
        void main() {
          vRear = position.z; vBrake = mod(iB.z, 2.0);
          float x = position.x, len = vRear > 0.5 ? 3.0 : 10.0;
          vF = 1.0 - x / len;
          x = vRear > 0.5 ? -(uHalf + x) : uHalf + x;
          vec3 p = vec3(x, 0.3, position.y);
          float c = cos(iA.w), s = sin(iA.w);
          vec3 w = vec3(p.x * c + p.z * s, p.y + p.x * sin(iB.x), -p.x * s + p.z * c) + iA.xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: `uniform float uNight; varying float vF, vRear, vBrake;
        void main() {
          vec3 c = vRear > 0.5 ? vec3(1.0, 0.08, 0.05) * (0.35 + 0.5 * vBrake) : vec3(1.0, 0.85, 0.6) * 0.8;
          gl_FragColor = vec4(c * vF * vF * uNight, 1.0);
        }`,
    })
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.matrixAutoUpdate = false
    glowGroup.add(m)
    return m
  })

  // ---------------------------------------------------------------- signals and benches (static, per network)
  // two sets: big simple heads that read on the map, and Vancouver-sized poles, heads and pedestrian signals
  // (models.js) under a perspective camera; the meshes of the near set have userData.near
  const sig = { group: new THREE.Group(), heads: null, ctls: null, state: null, ped: null, lamps: null, glow: null, near: null, meshes: [], d: null }
  group.add(sig.group)
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.15, 6.4, 6).translate(0, 3.2, 0)
  const armGeo = new THREE.BoxGeometry(1, 0.16, 0.16).translate(0.5, 0, 0)
  const headGeo = new THREE.BoxGeometry(0.42, 1.15, 0.42)
  const lampGeo = new THREE.BoxGeometry(0.14, 0.28, 0.3)
  // boxes: [x0, x1, y0, y1, z half-width, colour, part, taper (top scale), swing, z centre], as a plain kit geometry
  const model = (boxes) => { const k = kit(THREE); for (const [x0, x1, y0, y1, hw, c, , taper = 1, , zc = 0] of boxes) k.c(c).box(x0, x1, y0, y1, zc - hw, zc + hw, taper); return k.geometry(true) }
  const benchGeo = model([[-0.24, 0.2, 0.42, 0.5, 0.8, 0x9a6a3a], [-0.26, -0.2, 0.5, 0.95, 0.8, 0x9a6a3a], [-0.2, 0.15, 0, 0.42, 0.04, 0x3a3d42, 1, 1, 0, -0.65], [-0.2, 0.15, 0, 0.42, 0.04, 0x3a3d42, 1, 1, 0, 0.65]], true)
  const greyMat = new THREE.MeshLambertMaterial({ color: 0x6b7178 }), housingMat = new THREE.MeshLambertMaterial({ color: 0xd9a51e })
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const benchMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64
    const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)')
    x.fillStyle = g; x.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(c)
  })()
  const glowMat = new THREE.PointsMaterial({ size: 8, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false })
  const glowNear = new THREE.PointsMaterial({ size: 1.1, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  const sigGeo = signalModels(THREE)
  const discGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.03, 8).rotateX(Math.PI / 2), squareGeo = new THREE.BoxGeometry(0.03, 0.2, 0.24)
  const WALK = [new THREE.Color(0xff7a1a), new THREE.Color(0xf4f4ff)], WALK_DARK = [new THREE.Color(0x3a2a20), new THREE.Color(0x30323a)]
  const LIT = [0xff2a1a, 0xffa800, 0x2bff70].map((h) => new THREE.Color(h)), DARK = [0x3a2422, 0x3a3222, 0x1e3326].map((h) => new THREE.Color(h))
  const S = 1.5 // signal heads a bit larger than life
  function buildSignals(heads, ctls) {
    for (const m of sig.meshes) { m.removeFromParent(); m.dispose?.() }
    sig.meshes = []; sig.d = sig.lamps = sig.glow = null
    sig.heads = heads; sig.ctls = ctls
    const n = heads.length / 8
    let moved = 0
    for (let i = 0; i < n; i++) { // poles stand off the carriageways and cycle tracks as drawn (OSM's widths are only a guess); the arm reaches back over the lanes
      const o = i * 8, p = city.world.offRoad(heads[o], -heads[o + 1], 0.5, 10)
      if (!p) continue
      moved++
      const ax = Math.cos(heads[o + 3]), ay = Math.sin(heads[o + 3])
      heads[o + 4] = Math.max(1.5, Math.min(14, heads[o + 4] + (heads[o] - p.x) * ax + (heads[o + 1] + p.z) * ay))
      heads[o] = p.x; heads[o + 1] = -p.z; heads[o + 2] = city.world.heightAt(p.x, p.z)
    }
    if (window.lifeDebug) { let on = 0; for (let i = 0; i < n; i++) if (city.tiles?.onRoad?.(heads[i * 8], heads[i * 8 + 1])) on++; console.log(`life: ${n} signal poles, ${moved} moved off the street, ${on} still on it`) }
    sig.state = new Int8Array(n).fill(-1)
    if (!n) return
    const pole = new THREE.InstancedMesh(poleGeo, greyMat, n), arm = new THREE.InstancedMesh(armGeo, greyMat, n), head = new THREE.InstancedMesh(headGeo, housingMat, n)
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, n * 3)
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0)
    const gpos = new Float32Array(n * 3), gcol = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const [x, y, h, armYaw, armLen, headYaw] = heads.subarray(i * 8, i * 8 + 6)
      pole.setMatrixAt(i, M.makeTranslation(x, h, -y))
      arm.setMatrixAt(i, M.compose(V.set(x, h + 6.1, -y), Q.setFromAxisAngle(Y, armYaw), new THREE.Vector3(armLen, 1, 1)))
      const hx = x + Math.cos(armYaw) * armLen * 0.9, hy = y + Math.sin(armYaw) * armLen * 0.9, hh = h + 6.1 - 0.55 * S
      head.setMatrixAt(i, M.compose(V.set(hx, hh, -hy), Q.setFromAxisAngle(Y, headYaw), new THREE.Vector3(S, S, S)))
      for (let k = 0; k < 3; k++) {
        const fx = Math.cos(headYaw) * 0.24 * S, fy = Math.sin(headYaw) * 0.24 * S
        lamps.setMatrixAt(i * 3 + k, M.compose(V.set(hx + fx, hh + (0.36 - k * 0.36) * S, -(hy + fy)), Q.setFromAxisAngle(Y, headYaw), new THREE.Vector3(S, S, S)))
        lamps.setColorAt(i * 3 + k, DARK[k])
      }
      gpos.set([hx + Math.cos(headYaw) * 0.4 * S, hh, -(hy + Math.sin(headYaw) * 0.4 * S)], i * 3)
    }
    const glowGeo = new THREE.BufferGeometry()
    glowGeo.setAttribute('position', new THREE.BufferAttribute(gpos, 3)); glowGeo.setAttribute('color', new THREE.BufferAttribute(gcol, 3))
    const glow = new THREE.Points(glowGeo, glowMat)
    glow.frustumCulled = false
    for (const m of [pole, arm, head, lamps]) { m.computeBoundingSphere(); m.castShadow = false; m.receiveShadow = true; sig.group.add(m); sig.meshes.push(m) }
    glowGroup.add(glow); sig.meshes.push(glow)
    sig.lamps = lamps; sig.glow = glow
    // the near set, for the heads within SIG_NEAR of the camera (nearSignals() picks them into slots): the pole (in
    // its arm's frame), the arm, the overhead head; lit discs (3 overhead, 3 on the pole) and pedestrian squares
    // (hand, person). Their matrices are kept per head (16 floats each, 6 discs, 2 squares) and copied into the slots.
    const cap = Math.min(n, SIG_CAP)
    const dPole = new THREE.InstancedMesh(sigGeo.pole, benchMat, cap), dArm = new THREE.InstancedMesh(sigGeo.arm, benchMat, cap), dHead = new THREE.InstancedMesh(sigGeo.head, benchMat, cap)
    const discs = new THREE.InstancedMesh(discGeo, lampMat, cap * 6), peds = new THREE.InstancedMesh(squareGeo, lampMat, cap * 2)
    const mats = { pole: new Float32Array(n * 16), arm: new Float32Array(n * 16), head: new Float32Array(n * 16), discs: new Float32Array(n * 96), peds: new Float32Array(n * 32) }
    const Mp = new THREE.Matrix4(), Mh = new THREE.Matrix4(), T = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1), len = new THREE.Vector3()
    const lens = new Float32Array(n * 9)
    for (let i = 0; i < n; i++) {
      const [x, y, h, armYaw, armLen] = heads.subarray(i * 8, i * 8 + 5)
      Q.setFromAxisAngle(Y, armYaw)
      Mp.compose(V.set(x, h, -y), Q, one).toArray(mats.pole, i * 16)
      M.compose(V.set(x, h + ARM_Y, -y), Q, len.set(armLen, 1, 1)).toArray(mats.arm, i * 16)
      Mh.compose(V.set(x + Math.cos(armYaw) * armLen * 0.9, h + ARM_Y, -(y + Math.sin(armYaw) * armLen * 0.9)), Q, one).toArray(mats.head, i * 16)
      for (let k = 0; k < 3; k++) {
        M.multiplyMatrices(Mh, T.makeTranslation(...LENSES[k])).toArray(mats.discs, (i * 6 + k) * 16)
        M.multiplyMatrices(Mp, T.makeTranslation(...POLE_LENSES[k])).toArray(mats.discs, (i * 6 + 3 + k) * 16)
        V.set(LENSES[k][0], LENSES[k][1], LENSES[k][2] - 0.1).applyMatrix4(Mh).toArray(lens, i * 9 + k * 3)
      }
      for (let k = 0; k < 2; k++) M.multiplyMatrices(Mp, T.makeTranslation(...PED_LENSES[k])).toArray(mats.peds, (i * 2 + k) * 16)
    }
    discs.setColorAt(0, DARK[0]); peds.setColorAt(0, WALK_DARK[0]) // (makes their colour buffers)
    const dGlowGeo = new THREE.BufferGeometry()
    dGlowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3)); dGlowGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cap * 3), 3))
    const dGlow = new THREE.Points(dGlowGeo, glowNear)
    const meshes = { pole: dPole, arm: dArm, head: dHead, discs, peds }
    for (const m of Object.values(meshes)) { m.count = 0; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true; sig.group.add(m) }
    dGlow.frustumCulled = false; glowGroup.add(dGlow)
    sig.d = { meshes, mats, cap, discs, peds, glow: dGlow, lens, slot: new Int32Array(n).fill(-1), at: { x: NaN, z: NaN } }
    sig.ped = new Int8Array(n).fill(-1)
    for (const m of [...Object.values(meshes), dGlow]) { m.userData.near = true; sig.meshes.push(m) }
    sig.near = null // set the visibility on the next frame
  }
  // the heads within SIG_NEAR of (x, z) into the near set's slots (redone as the camera moves on), recoloured next tick
  function nearSignals(x, z) {
    const D = sig.d, H = sig.heads, n = H.length / 8, per = { pole: 1, arm: 1, head: 1, discs: 6, peds: 2 }
    let c = 0
    for (let i = 0; i < n; i++) {
      const dx = H[i * 8] - x, dz = -H[i * 8 + 1] - z
      if (c >= D.cap || dx * dx + dz * dz > SIG_NEAR * SIG_NEAR) { D.slot[i] = -1; continue }
      D.slot[i] = c
      for (const k in per) D.meshes[k].instanceMatrix.array.set(D.mats[k].subarray(i * 16 * per[k], (i + 1) * 16 * per[k]), c * 16 * per[k])
      c++
    }
    for (const k in per) { const m = D.meshes[k]; m.count = c * per[k]; m.instanceMatrix.needsUpdate = true }
    D.glow.geometry.setDrawRange(0, c)
    D.at.x = x; D.at.z = z
    sig.state.fill(-1); sig.ped.fill(-1); sigAt = -1
  }
  // ---------------------------------------------------------------- street names
  // the real names (core/streets.js) on the signals' mast-arm blades (the street ahead, across the approach, as in
  // Vancouver) and on a post at a corner of junctions without signals (one blade along each street), within NAME_NEAR
  const names = { at: { x: NaN, z: NaN }, arm: [], post: [], posts: null, mesh: null, low: null, words: null }
  const postGeo = postModel(THREE)
  const relook = () => { names.at.x = NaN } // a cell of names came in: pick again
  const across = (fx, fy) => (dx, dy) => Math.abs(dx * fx + dy * fy) < 0.5 * Math.hypot(dx, dy)
  const along = (a) => (dx, dy) => Math.abs(dx * Math.cos(a) + dy * Math.sin(a)) > 0.87 * Math.hypot(dx, dy)
  function buildPosts(p) {
    names.mesh?.removeFromParent(); names.mesh?.dispose()
    names.posts = p; names.post = []; names.mesh = null; names.at.x = NaN
    const n = p.length / 5
    for (let i = 0; i < n; i++) { const q = city.world.offRoad(p[i * 5], -p[i * 5 + 1], 0.5, 6); if (q) { p[i * 5] = q.x; p[i * 5 + 1] = -q.z; p[i * 5 + 2] = city.world.heightAt(q.x, q.z) } }
    if (!n) return
    names.mesh = new THREE.InstancedMesh(postGeo, benchMat, Math.min(n, POST_CAP))
    Object.assign(names.mesh, { count: 0, frustumCulled: false, castShadow: false, receiveShadow: true, visible: !!sig.near })
    names.mesh.userData.near = true
    sig.group.add(names.mesh)
  }
  function nearNames(x, z) {
    const tier = city.quality?.tier.name === 'low'
    if (names.low !== tier) { // the atlas follows the quality tier
      names.words?.mesh.removeFromParent(); names.words?.dispose()
      names.words = blades(THREE, city.renderer, SIG_CAP + POST_CAP * 2, tier); names.low = tier
      names.words.mesh.visible = !!sig.near; names.words.mesh.userData.near = true; sig.group.add(names.words.mesh)
    }
    names.at.x = x; names.at.z = z
    const near = [], R2 = NAME_NEAR * NAME_NEAR, M = new THREE.Matrix4(), T = new THREE.Matrix4()
    const H = sig.heads, D = sig.d
    if (D) for (let i = 0; i < H.length / 8; i++) { // the signals in the near set
      const dx = H[i * 8] - x, dz = -H[i * 8 + 1] - z, d = dx * dx + dz * dz
      if (D.slot[i] < 0 || d > R2) continue
      const a = H[i * 8 + 3], fx = Math.sin(a), fy = -Math.cos(a) // the approach, from the arm's yaw
      names.arm[i] ||= nearestStreet(H[i * 8] + fx * 7, H[i * 8 + 1] + fy * 7, 20, across(fx, fy), relook)?.name
      if (names.arm[i]) near.push({ d, m: new THREE.Matrix4().fromArray(D.mats.pole, i * 16).multiply(T.makeTranslation(ARM_BLADE.x, ARM_BLADE.y, 0)), b: ARM_BLADE, name: names.arm[i] })
    }
    const P = names.posts, mesh = names.mesh
    if (mesh) {
      mesh.count = 0
      const Q = new THREE.Quaternion(), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1)
      for (let i = 0; i < P.length / 5; i++) {
        const px = P[i * 5], py = P[i * 5 + 1], dx = px - x, dz = -py - z, d = dx * dx + dz * dz
        if (d > R2 || mesh.count >= mesh.instanceMatrix.count) continue
        for (let k = 0; k < 2; k++) names.post[i * 2 + k] ||= nearestStreet(px, py, 22, along(P[i * 5 + 3 + k]), relook)?.name
        if (!names.post[i * 2] && !names.post[i * 2 + 1]) continue // a post for names only
        M.compose(V.set(px, P[i * 5 + 2], -py), Q.setFromAxisAngle(Y, P[i * 5 + 3]), one)
        mesh.setMatrixAt(mesh.count++, M)
        for (let k = 0; k < 2; k++) {
          const nm = names.post[i * 2 + k]
          if (nm) near.push({ d, m: M.clone().multiply(T.makeTranslation(0, POST_BLADES[k].y, 0)).multiply(T.makeRotationY(POST_BLADES[k].turn)), b: POST_BLADES[k], name: nm })
        }
      }
      mesh.instanceMatrix.needsUpdate = true
    }
    near.sort((a, b) => a.d - b.d) // the nearest names first, should the atlas run out of slots
    names.words.begin()
    for (const o of near) names.words.add(o.m, o.b.w, o.b.h, o.name)
    names.words.end()
  }

  let benchMesh = null
  function buildBenches(b) {
    if (benchMesh) { benchMesh.removeFromParent(); benchMesh.dispose() }
    benchMesh = null
    const n = b.length / 4
    if (!n) return
    benchMesh = new THREE.InstancedMesh(benchGeo, benchMat, n)
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1)
    for (let i = 0; i < n; i++) benchMesh.setMatrixAt(i, M.compose(V.set(b[i * 4], b[i * 4 + 2], -b[i * 4 + 1]), Q.setFromAxisAngle(Y, b[i * 4 + 3]), one))
    benchMesh.computeBoundingSphere(); benchMesh.receiveShadow = true
    benchMesh.visible = peopleOn
    group.add(benchMesh)
  }
  // 2 green, 1 amber, 0 red (the worker's rule, on the worker's clock)
  function light(c, g, t) {
    const q = sig.ctls, o = c * 6, A = q[o + 4], u = (t + q[o + 1]) % q[o], v = g ? u - (q[o + 2] + A + q[o + 5]) : u, G = q[o + 2 + g]
    return v < 0 ? 0 : v < G ? 2 : v < G + A ? 1 : 0
  }
  let sigAt = 0
  function updateSignals(t) {
    if (!sig.lamps || Math.abs(t - sigAt) < 0.1) return
    sigAt = t
    const n = sig.state.length
    let changed = false
    const gc = sig.glow.geometry.attributes.color
    const D = sig.d, dp = D.glow.geometry.attributes.position, dc = D.glow.geometry.attributes.color
    let walked = false
    for (let i = 0; i < n; i++) {
      const c = sig.heads[i * 8 + 6], g = sig.heads[i * 8 + 7]
      // pedestrians cross this approach alongside the other direction's traffic: walk while it has green
      const walk = light(c, 1 - g, t) === 2 ? 1 : 0
      const j = D.slot[i]
      if (walk !== sig.ped[i]) {
        sig.ped[i] = walk; walked = true
        if (j >= 0) for (let k = 0; k < 2; k++) D.peds.setColorAt(j * 2 + k, k === walk ? WALK[k] : WALK_DARK[k])
      }
      const st = light(c, g, t)
      if (st === sig.state[i]) continue
      sig.state[i] = st; changed = true
      const top = st // lamps from the top: red (0), amber (1), green (2)
      for (let k = 0; k < 3; k++) { const col = k === top ? LIT[st] : DARK[k]; sig.lamps.setColorAt(i * 3 + k, col); if (j >= 0) { D.discs.setColorAt(j * 6 + k, col); D.discs.setColorAt(j * 6 + 3 + k, col) } }
      const p = sig.glow.geometry.attributes.position
      const hh = sig.heads[i * 8 + 2] + 6.1 - 0.55 * S
      p.setY(i, hh + (0.36 - top * 0.36) * S)
      gc.setXYZ(i, LIT[st].r, LIT[st].g, LIT[st].b)
      if (j >= 0) { dp.setXYZ(j, D.lens[i * 9 + top * 3], D.lens[i * 9 + top * 3 + 1], D.lens[i * 9 + top * 3 + 2]); dc.setXYZ(j, LIT[st].r, LIT[st].g, LIT[st].b) }
      p.needsUpdate = true
    }
    if (changed) { sig.lamps.instanceColor.needsUpdate = true; gc.needsUpdate = true; D.discs.instanceColor.needsUpdate = true; dp.needsUpdate = dc.needsUpdate = true }
    if (walked) D.peds.instanceColor.needsUpdate = true
  }

  // ---------------------------------------------------------------- the worker
  const worker = new Worker(new URL('./worker.js', import.meta.url))
  if (location.search.includes('lifedebug')) window.lifeDebug = (x, y, r = 30, ids) => new Promise((ok) => { debugCb = ok; worker.postMessage({ type: 'debug', x, y, r, ids }) })
  let debugCb = null
  let busy = false, accDt = 0, spare = null, simT = 0, simAt = 0, stats = { cars: 0, people: 0 }
  const vp = new THREE.Matrix4()
  let elapsed = 0, sentT = 0 // the frames' dt summed (the ticks' time), and the clock when the tick in flight was sent
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'frame') {
      busy = false; spare = m.buf
      if (!active) return
      // under a perspective camera the boxes within the near radii are hidden (in their shader, by uCam / uNear)
      // and those things are copied to the detailed models instead
      // (and on the map zoomed right in, MAP_NEAR: everything in view, about its middle)
      const C = city.view.camera, persp = !!C.isPerspectiveCamera, close = !persp && C.zoom >= MAP_NEAR, near = persp || close
      uni.uCam.value.copy(close ? city.controls.target : C.position)
      nearCars.value = close ? 400 ** 2 : near ? NEAR_CARS ** 2 : 0; nearPeople.value = close ? 400 ** 2 : near ? NEAR_PEOPLE ** 2 : 0
      // the cars: positions and (id, speed), drawn every frame from here (carsAt()); the time of the tick it answers
      if (snap.raw.length < m.cars * 8) { snap.raw = new Float32Array(m.cars * 12); snap.pos = new Float32Array(m.cars * 12); snap.aux = new Float32Array(m.cars * 3) }
      snap.raw.set(m.buf.subarray(0, m.cars * 8)); snap.aux.set(m.buf.subarray(m.base, m.base + m.cars * 2))
      snap.n = m.cars; snap.counts = m.counts; snap.t = sentT
      carsAt(elapsed) // (now: city.traffic.nearby pairs these ids with positions)
      // the people and cyclists likewise (peopleAt()), with their velocities, and the people's ids
      const nb = m.nPeople + m.nBikes
      if (snap.praw.length < nb * 8) { snap.praw = new Float32Array(nb * 12); snap.pq = new Float32Array(nb * 12); snap.pv = new Float32Array(nb * 3); snap.pid = new Float32Array(nb * 1.5) }
      snap.praw.set(m.buf.subarray(m.cars * 8, (m.cars + nb) * 8)); snap.pv.set(m.buf.subarray(m.vbase, m.vbase + nb * 2)); snap.pid.set(m.buf.subarray(m.pbase, m.pbase + m.nPeople))
      snap.pn = m.nPeople; snap.bn = m.nBikes
      peopleAt(elapsed)
      simT = m.simT; simAt = performance.now()
      stats = m
      if (window.lifeDebug) { const a = (window.lifeMs ||= []); a.push(m.ms); if (a.length > 600) a.shift(); window.lifeAt = performance.now() }
      city.requestRender()
    } else if (m.type === 'debug') debugCb?.(m)
    else if (m.type === 'net') {
      if (window.lifeDebug) console.log(`life: network ${m.ms.toFixed(0)} ms, ${m.heads.length / 8} signal heads`)
      buildSignals(m.heads, m.ctls)
      names.arm = []
      buildPosts(m.posts)
      buildBenches(m.benches)
      city.requestRender()
    }
  }
  // the cars at clock time t (the dt the ticks were sent with, summed): the latest snapshot moved on along each
  // car's heading at its speed for the time since the frame that asked for it. The worker answers a frame or so
  // later, sometimes two (a long tick, a busy main thread); drawn as they came, the cars lagged the camera by a
  // frame and stood still for one now and then, then jumped two (a stutter beside a moving van). Over a frame or two
  // a car's curve and braking are millimetres; never more than half a second on.
  function carsAt(t) {
    const n = snap.n, R = snap.raw, P = snap.pos, A = snap.aux, e = Math.min(0.5, Math.max(0, t - snap.t))
    P.set(R.subarray(0, n * 8))
    if (e > 0) for (let i = 0, s = 0; i < n; i++, s += 8) {
      const d = A[i * 2 + 1] * e
      if (!d) continue
      const h = d * Math.cos(R[s + 4])
      P[s] += Math.cos(R[s + 3]) * h; P[s + 1] += Math.sin(R[s + 4]) * d; P[s + 2] -= Math.sin(R[s + 3]) * h
    }
    const near = nearCars.value > 0
    for (const o of carsNear) o.n = 0
    for (let k = 0, off = 0; k < KINDS; k++) {
      const c = snap.counts[k] || 0, m = Math.min(c, carMeshes[k].cap)
      put(carMeshes[k], P, off, m); pools[k].geometry.instanceCount = m
      if (near) pickNear(P, off, m, Math.sqrt(nearCars.value), pickCar[k])
      off += c
    }
    for (const o of carsNear) show(o, o.n)
  }
  // the people and cyclists at clock time t, moved on from the latest snapshot like the cars (drawn as they came, they
  // moved only on the frames an answer arrived: a stutter whenever the worker answered a frame late)
  function peopleAt(t) {
    const n = snap.pn + snap.bn, R = snap.praw, Q = snap.pq, V = snap.pv, e = Math.min(0.5, Math.max(0, t - snap.t))
    Q.set(R.subarray(0, n * 8))
    if (e > 0) for (let i = 0; i < n; i++) { Q[i * 8] += V[i * 2] * e; Q[i * 8 + 2] += V[i * 2 + 1] * e }
    for (const o of peopleNear) o.n = 0
    const np = Math.min(snap.pn, people.cap)
    put(people, Q, 0, np)
    if (nearPeople.value > 0) pickNear(Q, 0, np, Math.sqrt(nearPeople.value), pickPerson)
    for (const o of peopleNear) show(o, o.n)
    put(bikes, Q, snap.pn, Math.min(snap.bn, bikes.cap))
    // the people for city.traffic.people, while a game asks for them: x, y, z, yaw and id
    snap.np = 0
    if (performance.now() - snap.asked < 2000) {
      if (snap.ppos.length < snap.pn * 5) snap.ppos = new Float32Array(snap.pn * 8)
      for (let i = 0; i < snap.pn; i++) { const q = i * 5, o = i * 8; snap.ppos[q] = Q[o]; snap.ppos[q + 1] = Q[o + 1]; snap.ppos[q + 2] = Q[o + 2]; snap.ppos[q + 3] = Q[o + 3]; snap.ppos[q + 4] = snap.pid[i] }
      snap.np = snap.pn
    }
  }
  function put(o, buf, off, n) { o.ib.array.set(buf.subarray(off * 8, (off + n) * 8)); show(o, n) }
  function show(o, n) { o.ib.clearUpdateRanges(); o.ib.addUpdateRange(0, n * 8); o.ib.needsUpdate = true; o.m.geometry.instanceCount = n }
  // the n things in buf at off within r of the camera (the same test as the boxes' shader) into the detailed model
  // pick(buf, s) chooses for each
  function pickNear(buf, off, n, r, pick) {
    const c = uni.uCam.value, r2 = r * r
    for (let i = 0; i < n; i++) {
      const s = (off + i) * 8, dx = buf[s] - c.x, dz = buf[s + 2] - c.z
      if (dx * dx + dz * dz >= r2) continue
      const d = pick(buf, s)
      if (d.n < d.cap) { const A = d.ib.array, j = d.n++ * 8; for (let k = 0; k < 8; k++) A[j + k] = buf[s + k] }
    }
  }

  // ---------------------------------------------------------------- city.traffic, for games
  const snap = { raw: new Float32Array(0), pos: new Float32Array(0), aux: new Float32Array(0), n: 0, counts: [], t: 0, ppos: new Float32Array(0), np: 0, asked: 0, praw: new Float32Array(0), pq: new Float32Array(0), pv: new Float32Array(0), pid: new Float32Array(0), pn: 0, bn: 0 }
  const pools2 = { people: [], poles: [] } // reused result objects, so a game can ask every frame without garbage
  const rec = (k, i) => pools2[k][i] || (pools2[k][i] = { id: 0, x: 0, y: 0, z: 0, heading: 0, r: 0 })
  const obstacles = new Map()
  let obsT = 0, obsAt = 0
  function sendObstacles() { // at most 10 times a second
    obsT = 0; obsAt = performance.now()
    worker.postMessage({ type: 'obstacles', list: [...obstacles].map(([id, o]) => ({ id, x: o.x, y: -o.z, ang: (o.heading || 0) - Math.PI / 2, len: o.length || 4.6, w: o.width || 1.9, speed: o.speed || 0, h: Number.isFinite(o.y) ? o.y : null })) })
  }
  const traffic = {
    // cars within r metres of (x, z): { id, x, y, z, heading, length, width, speed } (heading: forward is (sin, 0, cos))
    nearby(x, z, r) {
      const out = [], r2 = r * r, p = snap.pos
      if (!active) return out
      let k = 0, end = snap.counts[0] || 0
      for (let i = 0; i < snap.n; i++) {
        while (i >= end && k < KINDS - 1) end += snap.counts[++k]
        const o = i * 8, dx = p[o] - x, dz = p[o + 2] - z
        if (dx * dx + dz * dz > r2) continue
        out.push({ id: snap.aux[i * 2], x: p[o], y: p[o + 1], z: p[o + 2], heading: p[o + 3] + Math.PI / 2, length: HALF[k] * 2, width: WIDE[k], speed: snap.aux[i * 2 + 1] })
      }
      return out
    },
    // a player's vehicle or walker { x, z, heading, length, width, speed, y? } (null removes it): cars brake for it;
    // with y (its height) only lanes at that level, so a van on a bridge leaves the street below alone
    setObstacle(id, o) {
      if (o) obstacles.set(id, o); else obstacles.delete(id)
      if (!obsT) obsT = setTimeout(sendObstacles, Math.max(0, 100 - (performance.now() - obsAt)))
    },
    // the player hit car `id`: it stops for a few seconds
    bump(id, impulse, shove = 0) { worker.postMessage({ type: 'bump', id, shove }) }, // shove: metres it is knocked to its right (−: left), easing back into its lane
    // people within r metres of (x, z), into `out` (cleared; its objects are reused, read them right away):
    // { id, x, y, z, heading } (they face (sin, 0, cos) of heading, like the cars). Not the cyclists.
    people(x, z, r, out = []) {
      out.length = 0
      snap.asked = performance.now()
      if (!active || !peopleOn) return out
      const P = snap.ppos, r2 = r * r
      for (let i = 0; i < snap.np; i++) {
        const q = i * 5, dx = P[q] - x, dz = P[q + 2] - z
        if (!(dx * dx + dz * dz <= r2)) continue // (not a NaN one either)
        const o = rec('people', out.length)
        o.id = P[q + 4]; o.x = P[q]; o.y = P[q + 1]; o.z = P[q + 2]; o.heading = P[q + 3] + Math.PI / 2; o.r = 0.3
        out.push(o)
      }
      return out
    },
    // the traffic signal poles within r metres of (x, z), into `out` like people(): { x, y (foot), z, r (radius) }
    poles(x, z, r, out = []) {
      out.length = 0
      const H = sig.heads
      if (!active || !H) return out
      const r2 = r * r
      for (let i = 0; i < H.length; i += 8) {
        const dx = H[i] - x, dz = -H[i + 1] - z
        if (dx * dx + dz * dz > r2) continue
        const o = rec('poles', out.length)
        o.id = i / 8; o.x = H[i]; o.y = H[i + 2]; o.z = -H[i + 1]; o.heading = 0; o.r = 0.17
        out.push(o)
      }
      return out
    },
    // the player bumped into person `id` at `speed` m/s, pushing towards (dx, dz): a stumble, or (faster than a
    // brisk walk) a fall; they get up again after a few seconds
    knock(id, dx, dz, speed) { worker.postMessage({ type: 'knock', id, dx, dy: -dz, v: speed }) },
  }
  city.traffic = traffic
  city.emit('traffic:ready', traffic)

  // ---------------------------------------------------------------- tiles near the view -> worker
  const tiles = new Map(), sent = new Set()
  const tkey = (t) => `${t.level}/${t.i}_${t.j}`
  let simA = null, pedA = null, syncT = 0
  const offTiles = city.world.eachTile((t) => { tiles.set(tkey(t), t); schedule() })
  const offUnload = city.on('tile:unload', (t) => { tiles.delete(tkey(t)); schedule() })
  function schedule() { if (!syncT) syncT = setTimeout(sync, 250) }
  function sync() {
    syncT = 0
    if (!active) return
    const c = city.view.center, b = city.view.bounds, cx = c.x, cy = -c.z
    const rv = Math.hypot((b.x1 - b.x0) / 2, (b.z1 - b.z0) / 2), need = Math.min(rv, 2600)
    let moved = false
    if (!simA || Math.hypot(cx - simA.x, cy - simA.y) + need > simA.r || (simA.r > 2.4 * (need + 400) && simA.r > 1200)) {
      simA = { x: cx, y: cy, r: Math.min(3000, (need + 400) * 1.6) }; moved = true
    }
    const pr = Math.min(rv, 1500)
    if (!pedA || Math.hypot(cx - pedA.vx, cy - pedA.vy) + pr > pedA.vr || pedA.vr > 2.5 * (pr + 150)) {
      pedA = { vx: cx, vy: cy, vr: pr * 1.4 + 150 }; moved = true
    }
    const near = (t, x, y, r) => {
      const s = t.level ? 4096 : 1024, dx = Math.max(t.ox - x, 0, x - t.ox - s), dy = Math.max(t.oy - y, 0, y - t.oy - s)
      return dx * dx + dy * dy < (r + 100) ** 2
    }
    const add = [], drop = []
    for (const [k, t] of tiles) {
      if (sent.has(k) || !t.graph || !(near(t, simA.x, simA.y, simA.r) || near(t, pedA.vx, pedA.vy, pedA.vr))) continue
      sent.add(k)
      add.push({ key: k, level: t.level, ox: t.ox, oy: t.oy, size: t.level ? 4096 : 1024, terrain: { n: t.terrain.n, h: t.terrain.h, wall: t.terrain.wall, f: t.terrain.f },
        pieces: t.graph.pieces.filter((p) => p.kind <= 13), pois: (t.graph.pois || []).filter((q) => q.kind !== 3),
        fp: t.footprints ? { pts: t.footprints.pts, start: t.footprints.start } : null }) // (the buildings: people keep out of them)
    }
    for (const k of sent) {
      const t = tiles.get(k)
      if (!t || !(near(t, simA.x, simA.y, simA.r) || near(t, pedA.vx, pedA.vy, pedA.vr))) { sent.delete(k); drop.push(k) }
    }
    if (add.length || drop.length) worker.postMessage({ type: 'tiles', add, drop, masks: city.tiles?.masks || [] }) // (masks: the landmarks' outlines)
    if (moved) worker.postMessage({ type: 'area', area: { ...simA, ...pedA } })
  }

  // ---------------------------------------------------------------- on / off, settings, time of day
  const vanHour = () => vancouver(Date.now()).sec / 3600
  let active = false, peopleOn = false, stopAnim = null, lastOpts = ''
  function sendOpts() {
    const k = city.quality?.tier.life ?? 1 // graphics quality: fewer cars and people on a weaker GPU
    const o = { cars: set.cars, people: peopleOn, bikes: set.bikes, density: set.density * k, hour: +(city.weather?.hour ?? vanHour()).toFixed(1), maxCars: Math.round(MAX_CARS * k), maxPeople: Math.round(MAX_PEOPLE * k) }
    const s = JSON.stringify(o)
    if (s !== lastOpts) { lastOpts = s; worker.postMessage({ type: 'opts', opts: o }) }
  }
  function check() {
    const z = city.view.zoom
    const want = set.on && !document.hidden && z >= CAR_ZOOM && (set.cars || (set.people && z >= PEOPLE_ZOOM))
    const ppl = want && set.people && z >= PEOPLE_ZOOM
    if (ppl !== peopleOn) { peopleOn = ppl; if (benchMesh) benchMesh.visible = ppl }
    for (const o of carMeshes) o.m.visible = want && set.cars
    people.m.visible = bikes.m.visible = ppl
    for (const o of peopleNear) o.m.visible = ppl
    if (want !== active) {
      active = want
      group.visible = glowGroup.visible = want
      if (want) { stopAnim = city.animate(); schedule() } else { stopAnim?.(); stopAnim = null }
      city.requestRender()
    }
    if (active) { sendOpts(); schedule() }
  }
  const offView = city.on('view', check)
  const offWeather = city.on('weather', () => sendOpts()), offQuality = city.on('quality', () => { nearRadii(); if (sig.d) sig.d.at.x = NaN; names.at.x = NaN; sendOpts() }) // NaN: the signals' near set is picked again
  const onVis = () => check()
  document.addEventListener('visibilitychange', onVis)
  const clock = setInterval(() => active && sendOpts(), 15000)
  const offFrame = city.on('frame', (dt, t) => {
    if (!active) return
    uni.uNight.value = city.light.night; uni.uTime.value = t; uni.uRain.value = /rain|storm|drizzle/.test(city.weather?.kind) ? 1 : 0
    const persp = !!city.view.camera.isPerspectiveCamera
    if (sig.near !== persp) { sig.near = persp; for (const m of [...sig.meshes, names.mesh, names.words?.mesh]) if (m) m.visible = !!m.userData.near === persp }
    const cp = city.view.camera.position
    if (persp && sig.d && !(Math.hypot(cp.x - sig.d.at.x, cp.z - sig.d.at.z) <= SIG_NEAR * 0.25)) nearSignals(cp.x, cp.z)
    if (persp && !(Math.hypot(cp.x - names.at.x, cp.z - names.at.z) <= NAME_NEAR * 0.2)) nearNames(cp.x, cp.z)
    names.words?.night(city.light.night)
    for (const p of pools) p.visible = city.light.night > 0.08
    if (sig.glow) { glowMat.size = Math.max(3, 2.6 * 6 * city.view.zoom) * city.renderer.getPixelRatio(); glowMat.opacity = glowNear.opacity = 0.45 + 0.55 * city.light.night }
    accDt += dt; elapsed += dt
    if (snap.n) carsAt(elapsed)
    if (snap.pn || snap.bn) peopleAt(elapsed)
    if (!busy) {
      busy = true; sentT = elapsed
      const C = city.view.camera // what it sees: no car or person appears or vanishes there (worker.js seen())
      worker.postMessage({ type: 'tick', dt: accDt, buf: spare, view: [...vp.multiplyMatrices(C.projectionMatrix, C.matrixWorldInverse).elements] }, spare ? [spare.buffer] : [])
      spare = null; accDt = 0
    }
    updateSignals(simT + (performance.now() - simAt) / 1000)
  })

  // ---------------------------------------------------------------- panel
  const btn = city.ui.addButton({ label: 'Life', icon: '🚦', title: 'Traffic and people', panel: true })
  const el = btn.panel
  el.innerHTML = `
    <div style="display:grid;gap:6px;font-size:13px">
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="on"> <b style="flex:1">City life</b><span data-st style="color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums"></span></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="cars"> Cars, signals</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="people"> People</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="bikes"> Cyclists</label>
      <label style="display:flex;gap:8px;align-items:center">Busy <input type="range" min="0.2" max="2" step="0.1" data-d style="flex:1"></label>
      <div style="font-size:11px;color:var(--muted);line-height:1.35">Simulated, busier at rush hour (Vancouver time). Cars from neighbourhood zoom, people up close. Streets, signals, crossings, benches and stops © OpenStreetMap contributors.</div>
    </div>`
  for (const cb of el.querySelectorAll('[data-k]')) {
    cb.checked = set[cb.dataset.k]
    cb.addEventListener('change', () => { set[cb.dataset.k] = cb.checked; save(); check(); city.requestRender() })
  }
  const dens = el.querySelector('[data-d]')
  dens.value = String(set.density)
  dens.addEventListener('input', () => { set.density = +dens.value; save(); sendOpts() })
  const stEl = el.querySelector('[data-st]')
  const statT = setInterval(() => {
    if (el.hidden) return
    const z = city.view.zoom
    stEl.textContent = !set.on ? 'off' : !active ? (z < CAR_ZOOM ? 'zoom in' : '') : `${stats.cars || 0} cars${peopleOn ? ` · ${stats.people || 0} people` : ''}`
  }, 500)

  check()
  return {
    dispose() {
      offTiles(); offUnload(); offView(); offWeather(); offQuality(); offFrame()
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(clock); clearInterval(statT); clearTimeout(syncT); clearTimeout(obsT)
      if (city.traffic === traffic) delete city.traffic
      stopAnim?.()
      worker.terminate()
      group.removeFromParent(); glowGroup.removeFromParent()
      for (const o of [...carMeshes, people, bikes, ...allNear]) o.m.geometry.dispose()
      for (const m of [...pools, ...sig.meshes]) m.geometry?.dispose()
      benchMesh?.dispose(); names.mesh?.dispose(); names.words?.dispose(); postGeo.dispose()
      for (const m of [carMat, personMat, bikeMat, carNearMat, personNearMat, ...pools.map((p) => p.material), greyMat, housingMat, lampMat, benchMat, glowMat, glowNear]) m.dispose()
      for (const g of [...Object.values(sigGeo), discGeo, squareGeo]) g.dispose()
      glowTex.dispose()
      btn.remove()
      city.requestRender()
    },
  }
}
