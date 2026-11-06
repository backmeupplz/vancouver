import * as THREE from 'three'
import { MapControls } from './vendor/MapControls.js'

const $ = (s) => document.querySelector(s)
const status = (t) => ($('#status').textContent = t)
const rand = mulberry(1)
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (a) => a[Math.floor(rand() * a.length)]

const [meta, buf, groundTex] = await Promise.all([
  fetch('meta.json').then((r) => r.json()),
  fetch('city.bin').then((r) => r.arrayBuffer()),
  new THREE.TextureLoader().loadAsync('ground.jpg'),
])
status('Building the city…')
await new Promise(requestAnimationFrame)

const mobile = matchMedia('(pointer: coarse)').matches || innerWidth < 700
const renderer = new THREE.WebGLRenderer({ antialias: true, canvas: $('canvas') })
renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 2 : 2))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = !mobile
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.outputColorSpace = THREE.SRGBColorSpace

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0b1016)

// world: x east, z south, y up; 1 unit = 1 metre
const W = meta.w, H = meta.h

// ---------- ground ----------
groundTex.colorSpace = THREE.SRGBColorSpace
groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy()
const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshLambertMaterial({ map: groundTex }))
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)

// ---------- light ----------
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x5a5440, 1.6))
const sun = new THREE.DirectionalLight(0xfff1dc, 2.4)
sun.position.set(-2600, 3200, 1400)
sun.castShadow = true
sun.shadow.mapSize.set(4096, 4096)
Object.assign(sun.shadow.camera, { left: -W / 2 - 200, right: W / 2 + 200, top: H / 2 + 200, bottom: -H / 2 - 200, near: 10, far: 9000 })
sun.shadow.bias = -0.0004
sun.shadow.normalBias = 1.2
scene.add(sun)

// ---------- parse city.bin ----------
const dv = new DataView(buf)
let o = 0
const u8 = () => dv.getUint8(o++)
const u16 = () => ((o += 2), dv.getUint16(o - 2, true))
const i16 = () => ((o += 2), dv.getInt16(o - 2, true))
const u32 = () => ((o += 4), dv.getUint32(o - 4, true))

// ---------- buildings ----------
// palettes per class: house, apartment, glass tower, brick, concrete, white
const PAL = [
  { wall: [0xd9d2c3, 0xc9c0ad, 0xe6e0d4, 0xb8b2a4, 0xcfc6b8, 0xa9b4b8], roof: [0x5f6366, 0x6e6a66, 0x7a5a48, 0x4f5559, 0x8a8a86, 0x6b4d3c] },
  { wall: [0xd8d4cc, 0xc8c6c0, 0xe2ddd2, 0xbfc5c8, 0xd2cabc], roof: [0x9a9a96, 0x8c8e8e, 0xa8a49c] },
  { wall: [0x7fa6c4, 0x8cb3cf, 0x6f97b8, 0x9cbfd6, 0x5f87a8, 0xa8c4d4, 0x78a0b0], roof: [0xb8c2c8, 0x9aa6ae, 0xc4ccd0] },
  { wall: [0xa8604a, 0x9a5442, 0xb57058, 0x8e4e3e], roof: [0x6e5a50, 0x7c6a60] },
  { wall: [0xb9b6ae, 0xc6c2b8, 0xa8a8a2, 0xd0ccc2], roof: [0x8e8e8a, 0x9a9890, 0x7e8080] },
  { wall: [0xeeeeea, 0xe4e6e6, 0xf2f0ea], roof: [0xbcbcb8, 0xc8c8c4] },
]
const EXAG = 1.5 // heights are stretched like the painting's
const nb = u32()
const pos = [], nor = [], col = [], win = [], idx = []
const c = new THREE.Color()
const pushV = (x, y, z, nx, ny, nz, color, w, u) => {
  pos.push(x, y, z); nor.push(nx * 127, ny * 127, nz * 127); col.push(color.r * 255, color.g * 255, color.b * 255); win.push(w, u)
  return pos.length / 3 - 1
}
for (let b = 0; b < nb; b++) {
  const n = u16(), h = (u16() / 10) * EXAG, mn = (u16() / 10) * EXAG, k = u8()
  const pts = []
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector2(i16() / 2, -i16() / 2)) // (x, z)
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse() // CCW in (x,z) = clockwise seen from above
  const pal = PAL[k]
  const wallC = new THREE.Color(pick(pal.wall)).offsetHSL(0, 0, (rand() - 0.5) * 0.06)
  const roofC = new THREE.Color(pick(pal.roof)).offsetHSL(0, 0, (rand() - 0.5) * 0.06)
  const winType = h < 12 ? 0 : k === 2 ? 2 : 1 // 0 none, 1 punched windows, 2 curtain wall
  // walls
  let u = 0
  for (let i = 0; i < n; i++) {
    const a = pts[i], p = pts[(i + 1) % n]
    const dx = p.x - a.x, dz = p.y - a.y, len = Math.hypot(dx, dz) || 1
    const nx = dz / len, nz = -dx / len // outward for this winding
    c.copy(wallC).multiplyScalar(0.86 + 0.14 * Math.abs(nx))
    const v0 = pushV(a.x, mn, a.y, nx, 0, nz, c, winType, u)
    const v1 = pushV(p.x, mn, p.y, nx, 0, nz, c, winType, u + len)
    const v2 = pushV(p.x, h, p.y, nx, 0, nz, c, winType, u + len)
    const v3 = pushV(a.x, h, a.y, nx, 0, nz, c, winType, u)
    idx.push(v0, v2, v1, v0, v3, v2)
    u += len
  }
  // roof
  const base = pos.length / 3
  for (const p of pts) pushV(p.x, h, p.y, 0, 1, 0, roofC, 0, 0)
  for (const [a, bb, cc] of THREE.ShapeUtils.triangulateShape(pts, [])) idx.push(base + a, base + cc, base + bb)
}
const bg = new THREE.BufferGeometry()
bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
bg.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(nor), 3, true))
bg.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(col), 3, true))
bg.setAttribute('aWin', new THREE.Float32BufferAttribute(win, 2))
bg.setIndex(idx)
const bmat = new THREE.MeshLambertMaterial({ vertexColors: true })
bmat.onBeforeCompile = (s) => {
  s.vertexShader = s.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aWin;\nvarying vec3 vWin;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWin = vec3(aWin, position.y);')
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWin;')
    .replace('#include <color_fragment>', `#include <color_fragment>
      if (vWin.x > 0.5) {
        float fl = fract(vWin.z / 3.2), cl = fract(vWin.y / (vWin.x > 1.5 ? 1.6 : 3.0));
        if (vWin.x > 1.5) {
          float g = step(0.12, fl) * step(0.08, cl);
          diffuseColor.rgb *= mix(1.18, 0.78 + 0.1 * sin(vWin.z * 0.07 + vWin.y * 0.3), g);
        } else {
          float g = step(0.35, fl) * step(fl, 0.85) * step(0.3, cl) * step(cl, 0.8);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.4, 0.48), g * 0.75);
        }
      }`)
}
const buildings = new THREE.Mesh(bg, bmat)
buildings.castShadow = buildings.receiveShadow = true
scene.add(buildings)

// ---------- trees ----------
const nt = u32()
const treeData = []
for (let i = 0; i < nt; i++) treeData.push([i16() / 2, -i16() / 2, u8()])
// early autumn: mostly green, some yellow, a little orange and red
const FALL = [0x4e7a2c, 0x5f8a30, 0x3f6b2a, 0x6f9234, 0x4a7428, 0x588a34, 0x6a8f2e, 0x7d9a2e, 0x8f9a3a, 0x557d32, 0x46702c, 0x648c36,
  0x5a7f2a, 0x7a9438, 0xa8a030, 0xb8a434, 0xc9a227, 0xd98f22, 0xb8682a]
const PINE = [0x2f5a2e, 0x2a5030, 0x355f30, 0x3c6a32, 0x264a2a, 0x46703a]
const decid = [], conif = []
for (const t of treeData) (t[2] && rand() > 0.22 ? conif : decid).push(t)
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), tp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
const treeMat = new THREE.MeshLambertMaterial({ flatShading: true })
function trees(list, geo, size) {
  const m = new THREE.InstancedMesh(geo, treeMat, list.length)
  list.forEach(([x, z, wood], i) => {
    const [r, h] = size(wood)
    q.setFromAxisAngle(up, rand() * 6.28)
    m.setMatrixAt(i, m4.compose(tp.set(x, h / 2, z), q, sc.set(r, h, r)))
    m.setColorAt(i, c.set(wood && geo === coneGeo ? (rand() < 0.08 ? pick(FALL) : pick(PINE)) : pick(FALL)).offsetHSL(0, 0, (rand() - 0.5) * 0.08))
  })
  m.castShadow = true
  m.receiveShadow = true
  scene.add(m)
}
const coneGeo = new THREE.ConeGeometry(1, 1, 6)
const blobGeo = new THREE.IcosahedronGeometry(0.62, 0).scale(1, 0.8, 1).translate(0, 0.1, 0)
trees(decid, blobGeo, (wood) => { const r = 3.2 + rand() * 3 + (wood ? 1.2 : 0); return [r * 2, r * 1.8 + 4] })
trees(conif, coneGeo, () => { const r = 3.5 + rand() * 2.5; return [r, 16 + rand() * 22] })

// ---------- boats ----------
const nbo = u32()
const hull = new THREE.BoxGeometry(2.6, 1.6, 9).translate(0, 0.8, 0)
const boats = new THREE.InstancedMesh(hull, new THREE.MeshLambertMaterial(), nbo)
for (let i = 0; i < nbo; i++) {
  const x = i16() / 2, z = -i16() / 2, a = i16() / 1000
  const s = 0.6 + rand() * 0.9
  q.setFromAxisAngle(up, a + Math.PI / 2)
  boats.setMatrixAt(i, m4.compose(tp.set(x, 0, z), q, sc.set(s, s, s)))
  boats.setColorAt(i, c.set(rand() < 0.85 ? 0xf4f4f0 : pick([0x2a4d7a, 0xb03a2e, 0x333840])))
}
boats.castShadow = true
scene.add(boats)

// ---------- bridges ----------
const nbr = u32()
const deck = [], deckIdx = [], pillars = []
for (let i = 0; i < nbr; i++) {
  const n = u16(), w = Math.max(3, (u8() / 10) * 2.6)
  const p = []
  for (let j = 0; j < n; j++) p.push([i16() / 2, -i16() / 2, u16() / 10])
  let lastPillar = -1e9, along = 0
  for (let j = 0; j < n; j++) {
    const a = p[Math.max(0, j - 1)], b = p[Math.min(n - 1, j + 1)]
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1
    const sx = (-dz / l) * w / 2, sz = (dx / l) * w / 2
    const [x, z, h] = p[j]
    const y = h + 0.3
    const base = deck.length / 3
    deck.push(x - sx, y, z - sz, x + sx, y, z + sz, x - sx, y - 1.4, z - sz, x + sx, y - 1.4, z + sz)
    if (j) {
      const pb = base - 4
      deckIdx.push(pb, base, pb + 1, pb + 1, base, base + 1) // top
      deckIdx.push(pb, pb + 2, base, base, pb + 2, base + 2) // side
      deckIdx.push(pb + 1, base + 1, pb + 3, pb + 3, base + 1, base + 3) // side
      along += Math.hypot(x - p[j - 1][0], z - p[j - 1][1])
    }
    if (h > 5 && along - lastPillar > 45) { pillars.push([x, z, h - 1.4, w]); lastPillar = along }
  }
}
const dg = new THREE.BufferGeometry()
dg.setAttribute('position', new THREE.Float32BufferAttribute(deck, 3))
dg.setIndex(deckIdx)
dg.computeVertexNormals()
const concrete = new THREE.MeshLambertMaterial({ color: 0xc9c6bd, side: THREE.DoubleSide })
const deckMesh = new THREE.Mesh(dg, concrete)
deckMesh.castShadow = deckMesh.receiveShadow = true
scene.add(deckMesh)
const pil = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), concrete, pillars.length)
pillars.forEach(([x, z, h, w], i) => pil.setMatrixAt(i, m4.compose(tp.set(x, 0, z), q.identity(), sc.set(Math.min(w * 0.6, 8), h, 2.5))))
pil.castShadow = true
scene.add(pil)

// ---------- landmarks ----------
const white = new THREE.MeshLambertMaterial({ color: 0xf2f2ee })
const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; scene.add(m); return m }
if (meta.bcplace) {
  const [x, y, r] = meta.bcplace, z = -y
  add(new THREE.CylinderGeometry(r * 0.95, r, 30, 48), new THREE.MeshLambertMaterial({ color: 0xbfc3c4 }), x, 15, z)
  add(new THREE.SphereGeometry(r * 0.92, 48, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.28, 1), white, x, 30, z)
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2
    add(new THREE.CylinderGeometry(0.8, 0.8, 22), white, x + Math.cos(a) * r * 0.98, 41, z + Math.sin(a) * r * 0.98)
  }
}
if (meta.scienceworld) {
  const [x, y] = meta.scienceworld
  add(new THREE.CylinderGeometry(20, 22, 14, 24), new THREE.MeshLambertMaterial({ color: 0xa8b0b4 }), x, 7, -y)
  add(new THREE.IcosahedronGeometry(23, 2), new THREE.MeshLambertMaterial({ color: 0xd6dcde, flatShading: true }), x, 35, -y)
}
// cruise ships at Canada Place (lat/lon picked off the map)
const ll = (lat, lon) => [(lon - meta.lon0) * meta.kx, -(lat - meta.lat0) * meta.ky]
// Canada Place pier runs ENE between these two points; ships berth on both long sides
const [ax, az] = ll(49.2880, -123.1144), [bx, bz] = ll(49.2896, -123.1078)
const pl = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / pl, uz = (bz - az) / pl
for (const [side, at, len] of [[-1, 0.45, 290], [1, 0.55, 265]]) {
  const x = ax + ux * pl * at + uz * side * 88, z = az + uz * pl * at - ux * side * 88
  const ship = new THREE.Group()
  const hullM = new THREE.Mesh(new THREE.BoxGeometry(34, 14, len).translate(0, 7, 0), new THREE.MeshLambertMaterial({ color: 0x1d2a3a }))
  const s1 = new THREE.Mesh(new THREE.BoxGeometry(32, 22, len * 0.82).translate(0, 25, -len * 0.04), white)
  const s2 = new THREE.Mesh(new THREE.BoxGeometry(26, 10, len * 0.55).translate(0, 41, -len * 0.06), white)
  const fun = new THREE.Mesh(new THREE.BoxGeometry(8, 12, 16).translate(0, 52, len * 0.12), new THREE.MeshLambertMaterial({ color: 0x2b4a7a }))
  for (const m of [hullM, s1, s2, fun]) { m.castShadow = m.receiveShadow = true; ship.add(m) }
  ship.position.set(x, 0, z)
  ship.rotation.y = Math.atan2(ux, uz)
  scene.add(ship)
}
// the five white sails at the pier's tip
for (let i = 0; i < 5; i++) {
  const t = 0.62 + i * 0.07, x = ax + ux * pl * t, z = az + uz * pl * t
  add(new THREE.ConeGeometry(14, 30, 4), white, x + uz * (i % 2 ? 12 : -12), 38, z - ux * (i % 2 ? 12 : -12))
}

// ---------- camera ----------
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000)
const target = new THREE.Vector3(...[ll(49.2795, -123.1215)].map(([x, z]) => [x, 0, z])[0])
cam.position.copy(target).add(new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.92).multiplyScalar(6000))
cam.zoom = 1
function fit() {
  const a = innerWidth / innerHeight
  const view = a > 1 ? 5200 : 3400
  Object.assign(cam, { left: (-view * a) / 2, right: (view * a) / 2, top: view / 2, bottom: -view / 2 })
  cam.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
}
fit()
addEventListener('resize', fit)
const controls = new MapControls(cam, renderer.domElement)
controls.target.copy(target)
controls.enableDamping = true
controls.minZoom = 0.6
controls.maxZoom = 40
controls.maxPolarAngle = 1.25
controls.minPolarAngle = 0.15
controls.zoomToCursor = true
controls.update()
// keep the camera over the map
const half = new THREE.Vector3(W / 2, 0, H / 2)
controls.addEventListener('change', () => {
  const t = controls.target, cl = t.clone().clamp(half.clone().negate(), half)
  if (!cl.equals(t)) { cam.position.add(cl.clone().sub(t)); t.copy(cl) }
})

renderer.setAnimationLoop(() => {
  controls.update()
  renderer.render(scene, cam)
})
renderer.shadowMap.autoUpdate = false
renderer.shadowMap.needsUpdate = true
window.view = { cam, controls, ll } // handy from the console
status('')
$('#hint').hidden = false
