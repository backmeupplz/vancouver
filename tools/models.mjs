// node tools/models.mjs --out DIR [--only cars,people] [--hour 13,22] [--rain 1] [--cell 340x230]
// The model viewer: every code-built model on a neutral ground, four views each (front three-quarter, side, rear
// three-quarter, from above), one PNG per group and hour (DIR/cars-13.png, DIR/cars-22.png, ...), with rough ink edges
// (the page's ink pass is in main.js; here: EdgesGeometry) so shapes can be judged without loading the city.
// Groups (GROUPS below, in the page): player (van, courier, buses, cabs), cars (the near fleet), far (the far
// fleet), people (near people in their poses, cyclists), boats. Add a model: one line in its group.
import { mkdirSync } from 'node:fs'
import { args, server } from './pw.mjs'
import { createRequire } from 'node:module'
const { chromium } = createRequire('/Users/borodutch/code/agentboard/')('playwright')
const [o] = args(process.argv.slice(2), { out: '.', only: '', hour: '13,22', rain: 0, cell: '340x230' })
mkdirSync(o.out, { recursive: true })

const PAGE = /* js */ `
import * as THREE from '/vendor/three.module.min.js'
import { carModels, peopleModels, farModels, bikeModels, lifeMaterial, H } from '/plugins/life/models.js'
import { makeVan } from '/plugins/drive/van.js'
import { makeWalker, poseWalker, sitWalker } from '/plugins/drive/walker.js'
import { makeBus } from '/plugins/drive/bus.js'
import { CABS, makeCab } from '/plugins/drive/cabs.js'
import { makeBoat } from '/plugins/sail/boat.js'
import { shipModels, seabusGeo } from '/plugins/ships/models.js'

const uni = { uNight: { value: 0 }, uTime: { value: 0.4 }, uRain: { value: 0 }, uCam: { value: new THREE.Vector3() } }
const mats = {}
const lifeMat = (kind) => mats[kind] || (mats[kind] = lifeMaterial(THREE, uni, kind))
// one instance of a life model (the instanced shader's inputs: iA x, y, z, yaw; iB per kind, see life/worker.js output())
function lifeObj(geo, kind, iB) {
  const g = new THREE.InstancedBufferGeometry().copy(geo); g.instanceCount = 1
  const ib = new THREE.InstancedInterleavedBuffer(new Float32Array([0, 0, 0, 0, ...iB]), 8)
  g.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 4, 0)); g.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 4, 4))
  const m = new THREE.Mesh(g, lifeMat(kind)); m.frustumCulled = false
  geo.computeBoundingBox(); m.userData.box = geo.boundingBox.clone(); m.userData.tris = geo.attributes.position.count / 3
  if (kind === 'car') m.userData.edges = geo
  return m
}
const PAINT = [0xc8ccd0, 0x23272b, 0xf1f1ee, 0x8e2a2a, 0x2b4a7a, 0x6d7478, 0x2f6b4f, 0xd8b23a, 0xb8502c, 0x3d7fa6]
const car = (g, i, brake = 0) => lifeObj(g, 'car', [0, PAINT[i % PAINT.length], brake, 0.3])
const person = (g, pose, seed, i, phase = 1.2) => lifeObj(g, pose === 3 ? 'bike' : 'person', [phase, pose + seed * 0.9, PAINT[(i + 3) % PAINT.length], PAINT[(i + 1) % 2 + 4]])
const named = (o, ...names) => (o.map ? o : [o]).map((g, i) => [names[i] || names[0] + ' ' + i, g])
const far = farModels(THREE)
const GROUPS = {
  player: () => [
    ['van', makeVan(THREE)], ['courier', (() => { const w = makeWalker(THREE); poseWalker(w, 1.2, 1, false); return w })()],
    ['courier running', (() => { const w = makeWalker(THREE); poseWalker(w, 1.2, 1, true); return w })()],
    ...[['on a bench', 'seat', 0.45], ['on a log', 'seat', 0.25], ['on an edge', 'edge'], ['cross-legged', 'ground'], ['petting', 'crouch']].map(([n, kind, h]) => ['courier ' + n, (() => { const w = makeWalker(THREE); poseWalker(w, 0, 0, false); sitWalker(w, kind, h); return w })()]),
    ['bus', makeBus(THREE, {})], ['trolley artic', makeBus(THREE, { artic: true, trolley: true })],
    ...CABS.map((c) => ['cab ' + c.id, makeCab(THREE, c)]),
  ],
  cars: () => carModels(THREE).map((g, i) => [g.name || 'car ' + i, car(g, i, i % 3 === 1 ? 3 : 0)]),
  far: () => [...far.cars.map((g, i) => ['far car ' + i, car(g, i)]), ['far person', person(far.person, 0, 0.3, 0)], ['far bike', person(far.bike, 3, 0.3, 1)]],
  people: () => [
    ...peopleModels(THREE).flatMap((g, i) => { g.scale(H, H, H); return [[(g.name || 'person ' + i) + ' walk', person(g, 0, 0.11 + i * 0.13, i)], [(g.name || 'person ' + i) + ' wait', person(g, 1, 0.47 + i * 0.07, i + 2)]] }),
    ['sitting', person(peopleModels(THREE)[0].scale(H, H, H), 2, 0.6, 5)],
    ...(bikeModels ? bikeModels(THREE).map((g, i) => [g.name || 'bike ' + i, person(g, 3, 0.2 + i * 0.3, i, 0.6)]) : []),
  ],
  boats: () => { const m = new THREE.MeshLambertMaterial({ vertexColors: true }), mesh = (g) => new THREE.Mesh(g, m), b = makeBoat(THREE); b.userData.boom.rotation.y = b.userData.jib.rotation.y = 0.5; return [['player sloop', b], ...Object.values(shipModels(THREE)).flatMap((v) => [...new Set([v[0], v[v.length - 1]])].map((x) => [x.kind + ' ' + v.indexOf(x), mesh(x.geo)])), ['seabus', mesh(seabusGeo(THREE))]] },
}

const q = new URLSearchParams(location.search), [CW, CH] = q.get('cell').split('x').map(Number), night = +q.get('night')
uni.uNight.value = night; uni.uRain.value = +q.get('rain')
const VIEWS = [[35, 16], [90, 4], [215, 16], [-40, 55]]
const rows = GROUPS[q.get('group')]()
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1); renderer.setSize(CW * VIEWS.length, CH * rows.length); renderer.setScissorTest(true)
document.body.style.cssText = 'margin:0;background:#000'; document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene(); scene.background = new THREE.Color(night ? 0x141a24 : 0xbfd3e0)
scene.add(new THREE.HemisphereLight(night ? 0x5a6a88 : 0xffffff, night ? 0x20242c : 0x8a8f96, night ? 0.9 : 1.7))
const sun = new THREE.DirectionalLight(0xfff4e0, night ? 0.25 : 2.2); sun.position.set(4, 9, 6); scene.add(sun)
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: night ? 0x2a2e36 : 0x9a9da2 })); scene.add(ground)
const ink = new THREE.LineBasicMaterial({ color: 0x15181c })
const cam = new THREE.PerspectiveCamera(24, CW / CH, 0.1, 2000), box = new THREE.Box3(), c = new THREE.Vector3(), s = new THREE.Vector3()
rows.forEach(([name, obj], r) => {
  if (obj.userData.lights && night) { obj.userData.lights[0].emissiveIntensity = 1.6; obj.userData.lights[1].emissiveIntensity = 1.2 }
  if (obj.userData.night) obj.userData.night.value = night
  let tris = obj.userData.tris || 0
  if (obj.userData.edges) obj.add(new THREE.LineSegments(new THREE.EdgesGeometry(obj.userData.edges, 28), ink))
  else if (!obj.userData.box) obj.traverse((m) => { if (m.isMesh && m.geometry.attributes.position) { tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; if (!m.material.transparent) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 28), ink)) } })
  scene.add(obj); obj.updateMatrixWorld(true)
  if (obj.userData.box) box.copy(obj.userData.box); else box.setFromObject(obj)
  box.getCenter(c); box.getSize(s)
  const R = Math.max(s.x, s.y * 1.5, s.z) * 0.5 + 0.25, d = R / Math.tan((cam.fov * Math.PI) / 360) * 1.12
  const long = !obj.userData.box && s.z > s.x ? 90 : 0 // (the drive plugin's models face -z, the life plugin's +x)
  VIEWS.forEach(([az, el], v) => {
    const a = ((az + long) * Math.PI) / 180, e = (el * Math.PI) / 180
    cam.position.set(c.x + d * Math.cos(e) * Math.cos(a), c.y + d * Math.sin(e), c.z + d * Math.cos(e) * Math.sin(a) * (long ? -1 : 1)); cam.lookAt(c)
    const y = (rows.length - 1 - r) * CH
    renderer.setViewport(v * CW, y, CW, CH); renderer.setScissor(v * CW, y, CW, CH); renderer.render(scene, cam)
  })
  scene.remove(obj)
  const t = document.createElement('div'); t.textContent = name + '  ·  ' + Math.round(tris) + ' tris'
  t.style.cssText = 'position:absolute;left:6px;top:' + (r * CH + 4) + 'px;font:600 13px system-ui;color:' + (night ? '#fff' : '#111')
  document.body.appendChild(t)
})
window.done = [CW * VIEWS.length, CH * rows.length]
`

const srv = await server(o.port)
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] })
try {
  const groups = o.only ? o.only.split(',') : ['player', 'cars', 'far', 'people', 'boats']
  for (const group of groups) for (const hour of String(o.hour).split(',')) {
    const page = await browser.newPage(), errs = []
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text())); page.on('pageerror', (e) => errs.push(e.message)); page.on('response', (r) => r.status() >= 400 && !r.url().endsWith('favicon.ico') && errs.push(r.status() + ' ' + r.url()))
    await page.route(/__models\.html/, (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><body><script type="module">${PAGE}</script>` }))
    await page.goto(`http://127.0.0.1:${srv.port}/__models.html?group=${group}&night=${+hour >= 20 || +hour < 6 ? 1 : 0}&rain=${+o.rain}&cell=${o.cell}`)
    const size = await page.waitForFunction(() => window.done, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null)
    if (size && size[1]) { await page.screenshot({ path: `${o.out}/${group}-${hour}.png`, clip: { x: 0, y: 0, width: size[0], height: size[1] }, fullPage: true }) }
    console.log(`${o.out}/${group}-${hour}.png errors=${errs.length}${errs.length ? ' ' + errs.join(' | ').slice(0, 300) : ''}${size && !size[1] ? ' (empty group)' : ''}`)
    await page.close()
  }
} finally { await browser.close(); srv.stop() }
