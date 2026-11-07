import * as THREE from 'three'
import { MapControls } from './vendor/MapControls.js'
import { createCity, loadPlugins } from './city.js'
import { Tiles } from './core/tiles.js'
import { groundMaterial, roadMaterial, buildingMaterial, treeAtlas, treeMaterial, night } from './core/materials.js'

// World: metres east (x) and north of an origin downtown (tools/world.py); three.js x = east, y = up, z = south.
// Heights are real elevations. The camera is orthographic, looking north, 30° down; the view lives in the URL
// as #x,y,s (drawing pixels at 6 px per metre, CSS px per drawing px).
const $ = (s) => document.querySelector(s)
const loadingEl = $('#loading')
const status = (t, frac) => { loadingEl.querySelector('.step').textContent = t; if (frac !== undefined) loadingEl.querySelector('.fill').style.width = `${Math.round(frac * 100)}%` }
addEventListener('error', (e) => { if (/WebGL unavailable/.test(e.message)) return; loadingEl?.classList.add('error'); if (loadingEl?.isConnected) status(`Something went wrong: ${e.message}`) })

let city = null // the plugin host (city.js)
let dirty = true // render on demand: only when something changed
let shadowStale = false, lastShadow = 0 // new tiles refresh the shadow map, at most twice a second
const mobile = matchMedia('(pointer: coarse)').matches || innerWidth < 700

// No WebGL (hardware acceleration off, an old or locked-down browser): say so plainly and stop
function noWebGL(detail) {
  loadingEl.classList.add('error')
  loadingEl.querySelector('.card').innerHTML = `
    <div class="title">Vancouver in code needs WebGL</div>
    <p class="step" style="text-align:left;line-height:1.5">This browser couldn't start 3D graphics (WebGL 2), which the map needs. Usually one of these fixes it:</p>
    <ul class="step" style="text-align:left;line-height:1.5;padding-left:18px;margin:0 0 12px">
      <li>Turn on hardware acceleration (Chrome/Edge/Brave: Settings → System; Firefox: Settings → Performance), then restart the browser.</li>
      <li>Update the browser or your graphics drivers, or try a current Chrome, Firefox or Safari.</li>
      <li>Check <a href="https://get.webgl.org/webgl2/" target="_blank" rel="noopener">get.webgl.org/webgl2</a>: if the cube doesn't spin there, WebGL is blocked on this device.</li>
    </ul>
    <p class="step" style="font-size:11px;opacity:.7">${detail ? String(detail).replace(/[<&>]/g, '') : ''}</p>`
  throw new Error('WebGL unavailable')
}
{
  const probe = document.createElement('canvas').getContext('webgl2')
  if (!probe) noWebGL('WebGL 2 is not available in this browser.')
  probe.getExtension('WEBGL_lose_context')?.loseContext()
}
let renderer
try { renderer = new THREE.WebGLRenderer({ antialias: false, canvas: $('canvas'), powerPreference: 'high-performance' }) } catch (e) { noWebGL(e.message) }
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap
renderer.shadowMap.autoUpdate = false
renderer.outputColorSpace = THREE.SRGBColorSpace
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0e1620)
const treeScene = new THREE.Scene() // billboards, drawn after the ink pass
const overlay = new THREE.Scene() // plugins' effects, drawn last without outlines

// ---------- light ----------
const hemi = new THREE.HemisphereLight(0xe8eef8, 0x8a8070, 2.0)
scene.add(hemi)
const sun = new THREE.DirectionalLight(0xfff1dc, 2.3)
const SUN = new THREE.Vector3(-0.55, 0.62, 0.56).normalize() // afternoon, from the south-west (plugins may move it)
sun.castShadow = true
sun.shadow.mapSize.setScalar(mobile ? 2048 : 4096)
sun.shadow.bias = -0.0005
scene.add(sun, sun.target)

// ---------- the map ----------
const mats = { ground: groundMaterial(), road: roadMaterial(), paint: roadMaterial(true), building: buildingMaterial(), tree: treeMaterial(treeAtlas()) }
const tiles = new Tiles({
  scene, treeScene, mats,
  onChange: () => { dirty = true; shadowStale = true }, // shadows follow new tiles at most twice a second
  onLoad: (t) => city?.emit('tile:load', tileInfo(t)),
  onUnload: (t) => city?.emit('tile:unload', tileInfo(t)),
})
const tileInfo = (t) => ({ level: t.level, i: t.i, j: t.j, ox: t.ox, oy: t.oy, size: t.level ? 4096 : 1024, graph: t.graph, terrain: t.terrain, footprints: t.footprints, water: t.water })
status('Loading the map…', 0.05)
const index = await tiles.init()
const [LAT_O, LON_O] = index.origin, [KX, KY] = index.k
const ll = (lat, lon) => [(lon - LON_O) * KX, (lat - LAT_O) * KY]
const zAt = (x, n) => tiles.heightAt(x, n)

// ---------- camera ----------
const K = 6, BX = 23551.5, BY = 9727.5 // view hash: drawing px per metre and the drawing origin
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 100, 30000)
const VIEW = new THREE.Vector3(0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)) // from the target towards the camera
function fit() {
  const w = innerWidth / K / 2, h = innerHeight / K / 2
  Object.assign(cam, { left: -w, right: w, top: h, bottom: -h })
  cam.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  dirty = true
}
const controls = new MapControls(cam, renderer.domElement)
controls.enableDamping = true
controls.zoomToCursor = true
controls.minZoom = mobile ? 0.035 : 0.02 // phones: not the whole region at once
controls.maxZoom = 6
controls.maxPolarAngle = 1.3
controls.minPolarAngle = 0.15
function setView(X, Y, s) { // drawing px at the screen centre, CSS px per drawing px
  const E = (X - BX) / K, N = (BY - Y) / (K * VIEW.y)
  controls.target.set(E, 0, -N)
  cam.position.copy(controls.target).addScaledVector(VIEW, 12000)
  cam.zoom = s; cam.updateProjectionMatrix(); controls.update()
}
function fromHash() {
  const [x, y, s] = location.hash.slice(1).split(',').map(Number)
  if ([x, y, s].every(Number.isFinite) && s > 0) { setView(x, y, s); return true }
}
if (!fromHash()) setView(13312, 10752, mobile && innerWidth < 600 ? 0.05 : 0.07) // downtown and the North Shore
fit()
addEventListener('resize', fit)
addEventListener('hashchange', () => { fromHash(); dirty = true })
let hashT = 0
function onView() {
  clearTimeout(hashT)
  hashT = setTimeout(() => {
    const t = controls.target
    history.replaceState(null, '', `#${Math.round(t.x * K + BX)},${Math.round(BY + t.z * K * VIEW.y)},${cam.zoom.toFixed(4)}`)
  }, 150)
}
// keep the camera over the map
const [EX0, EY0, EX1, EY1] = index.extent
const lo = new THREE.Vector3(EX0, -1e4, -EY1), hi = new THREE.Vector3(EX1, 1e4, -EY0)
controls.addEventListener('change', () => {
  const t = controls.target, cl = t.clone().clamp(lo, hi)
  if (!cl.equals(t)) { cam.position.add(cl.clone().sub(t)); t.copy(cl) }
  dirty = true
  onView()
  city?.emit('view', city.view)
})
let lastGroundCheck = 0

// ---------- a plugin's own camera (city.view.useCamera): MapControls off, the map is drawn through that camera,
// tiles stream and shadows fit around opts.focus (read every frame, so the plugin just moves it) ----------
let own = null // { camera, opts: { focus, radius, shadowRadius } }
const ownSeen = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3()
let shMap = null // the map view's shadow fit, put back exactly on release
const ownCamera = {
  use(camera, opts) { own = { camera, opts }; controls.enabled = false; shMap = { ...sh }; sh.x = NaN; dirty = true; ownSeen.copy(opts.focus); city.emit('view', city.view) },
  release() {
    own = null; controls.enabled = true; dirty = true
    if (Number.isFinite(shMap?.x)) { Object.assign(sh, shMap); fitShadows() } else sh.x = NaN
    city.emit('view', city.view)
  },
  get active() { return own },
  // the map zoom that would show the focus at the same scale (camera.zoom units)
  get zoom() {
    const C = own.camera
    if (!C.isPerspectiveCamera) return C.zoom
    const d = Math.max(1, v1.copy(own.opts.focus).sub(C.position).dot(C.getWorldDirection(v2)))
    return innerHeight / (K * 2 * d * Math.tan(C.fov * Math.PI / 360) / C.zoom)
  },
}

// ---------- shadows: a sharp shadow map over what is on screen, refitted only when the view moves past it ----------
const sh = { x: NaN, y: 0, z: 0, r: 0 }
function updateShadows() {
  const r = own ? own.opts.shadowRadius ?? 300 : Math.hypot(innerWidth, innerHeight * 2) / K / cam.zoom / 2 + 80
  const t = own ? own.opts.focus : controls.target
  if (Math.hypot(t.x - sh.x, t.z - sh.z) < sh.r * 0.35 && r < sh.r && r > sh.r * 0.4) return
  sh.x = t.x; sh.y = t.y; sh.z = t.z; sh.r = r * 1.5
  fitShadows()
}
function fitShadows() {
  const texel = (2 * sh.r) / sun.shadow.mapSize.x, sx = Math.round(sh.x / texel) * texel, sz = Math.round(sh.z / texel) * texel
  sun.shadow.normalBias = texel * 1.2
  sun.target.position.set(sx, sh.y, sz)
  sun.position.copy(sun.target.position).addScaledVector(SUN, 8000)
  Object.assign(sun.shadow.camera, { left: -sh.r, right: sh.r, top: sh.r, bottom: -sh.r, near: 10, far: 16000 })
  sun.shadow.camera.updateProjectionMatrix()
  renderer.shadowMap.needsUpdate = true
}

// ---------- ink: edges in the depth buffer drawn as dark lines, plus the colour grade ----------
const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType })
rt.depthTexture = new THREE.DepthTexture(1, 1)
const ink = new THREE.ShaderMaterial({
  uniforms: { tColor: { value: rt.texture }, tDepth: { value: rt.depthTexture }, sat: { value: 1.2 }, gain: { value: new THREE.Vector3(1, 1, 1) }, tint: { value: new THREE.Vector3(1, 1, 1) },
    desat: { value: 0 }, px: { value: new THREE.Vector2() }, range: { value: 1 }, thr: { value: 1 }, ink: { value: 0 },
    cnear: { value: 1 }, cfar: { value: 2 }, fade: { value: new THREE.Vector2(1e9, 2e9) } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  // orthographic: depth is linear, edges are jumps in metres. PERSP (a plugin's perspective camera): 1/distance is
  // linear across a plane, so edges are jumps in 1/distance relative to it, faded out from fade.x to fade.y metres
  fragmentShader: `uniform sampler2D tColor, tDepth; uniform vec2 px; uniform float range, thr, ink, sat, desat; uniform vec3 gain, tint; varying vec2 vUv;
    #ifdef PERSP
    uniform float cnear, cfar; uniform vec2 fade;
    float d(vec2 o) { return (cfar - texture2D(tDepth, vUv + o * px).x * (cfar - cnear)) / (cnear * cfar); }
    #else
    float d(vec2 o) { return texture2D(tDepth, vUv + o * px).x * range; }
    #endif
    void main() {
      vec4 col = texture2D(tColor, vUv);
      float c = d(vec2(0.0));
      float lap = max(abs(d(vec2(1.0, 0.0)) + d(vec2(-1.0, 0.0)) - 2.0 * c), abs(d(vec2(0.0, 1.0)) + d(vec2(0.0, -1.0)) - 2.0 * c));
      #ifdef PERSP
      lap /= c;
      #endif
      float e = smoothstep(thr, thr * 6.0, lap) * ink;
      #ifdef PERSP
      e *= 1.0 - smoothstep(fade.x, fade.y, 1.0 / c);
      #endif
      vec3 cc = mix(col.rgb, col.rgb * vec3(0.16, 0.18, 0.22), e);
      cc = max(mix(vec3(dot(cc, vec3(0.2126, 0.7152, 0.0722))), cc, sat), 0.0);
      cc *= gain;
      cc = mix(cc, vec3(dot(cc, vec3(0.2126, 0.7152, 0.0722))), desat) * tint;
      cc = mix(cc, col.rgb, 1.0 - col.a); // lit windows (alpha < 1) skip the grade
      gl_FragColor = vec4(cc, 1.0);
      #include <colorspace_fragment>
      gl_FragDepth = texture2D(tDepth, vUv).x;
    }`,
  depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth,
})
const post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ink)
post.frustumCulled = false
const postScene = new THREE.Scene(), postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
postScene.add(post)
function draw() {
  const w = renderer.domElement.width, h = renderer.domElement.height, pr = renderer.getPixelRatio()
  if (rt.width !== w || rt.height !== h) rt.setSize(w, h)
  const C = own ? own.camera : cam, zoom = own ? ownCamera.zoom : cam.zoom, u = ink.uniforms
  u.px.value.set(pr / w, pr / h)
  u.range.value = C.far - C.near
  if (!!ink.defines.PERSP !== !!C.isPerspectiveCamera) { if (C.isPerspectiveCamera) ink.defines.PERSP = 1; else delete ink.defines.PERSP; ink.needsUpdate = true }
  if (C.isPerspectiveCamera) {
    const d = v1.copy(own.opts.focus).sub(C.position).dot(C.getWorldDirection(v2)) // metres to the focus
    u.cnear.value = C.near; u.cfar.value = C.far; u.thr.value = Math.min(0.004, Math.max(0.35 / (K * zoom), 0.9) / Math.max(1, d))
    if (scene.fog?.isFog) u.fade.value.set(scene.fog.near, scene.fog.far); else u.fade.value.set(1e9, 2e9)
  } else u.thr.value = Math.max(0.35 / (K * cam.zoom), 0.9)
  u.ink.value = THREE.MathUtils.smoothstep(zoom, 0.05, 0.16)
  u.sat.value = 0.96 + 0.24 * THREE.MathUtils.smoothstep(zoom, 0.04, 0.2)
  const near = THREE.MathUtils.smoothstep(zoom, 0.04, 0.12)
  u.gain.value.set(1 + 0.1 * near, 1 + 0.17 * near, 1 + 0.38 * near)
  treeScene.fog = scene.fog
  renderer.info.autoReset = false; renderer.info.reset()
  renderer.setRenderTarget(rt); renderer.render(scene, C)
  renderer.setRenderTarget(null); renderer.render(postScene, postCam)
  const tm = mats.tree.uniforms
  tm.sat.value = ink.uniforms.sat.value * 0.88; tm.gain.value.copy(ink.uniforms.gain.value); tm.tint.value.copy(ink.uniforms.tint.value); tm.desat.value = ink.uniforms.desat.value
  renderer.autoClear = false
  renderer.render(treeScene, C)
  if (overlay.children.length) renderer.render(overlay, C)
  renderer.autoClear = true
}

// ---------- frame loop ----------
let lastFrame = performance.now()
function loop(now) {
  requestAnimationFrame(loop)
  if (!own) controls.update()
  const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0); lastFrame = now
  if (city?.animating) dirty = true
  if (!dirty) return
  dirty = false
  if (own) {
    tiles.update(own.camera, own.opts.focus, own.opts.radius)
    tiles.setBalconies(true)
    if (own.opts.focus.distanceTo(ownSeen) > 20) { ownSeen.copy(own.opts.focus); city?.emit('view', city.view) }
  } else {
    tiles.update(cam, controls.target)
    tiles.setBalconies(cam.zoom >= 0.3)
  }
  if (!own && now - lastGroundCheck > 300) { // keep the orbit target on the ground
    lastGroundCheck = now
    const g = zAt(controls.target.x, -controls.target.z)
    if (Math.abs(g - controls.target.y) > 2) { const d = g - controls.target.y; controls.target.y += d; cam.position.y += d }
  }
  city?.emit('frame', dt, now / 1000)
  updateShadows()
  if (shadowStale && now - lastShadow > 500) { shadowStale = false; lastShadow = now; renderer.shadowMap.needsUpdate = true }
  if (shadowStale) dirty = true // come back for it
  draw()
}
requestAnimationFrame(loop)
document.addEventListener('visibilitychange', () => { dirty = true })

// ---------- plugins ----------
city = createCity({
  scene, overlay, camera: cam, renderer, controls, zAt, ll,
  toLatLon: (x, n) => ({ lat: LAT_O + n / KY, lon: LON_O + x / KX }),
  sun, hemi, setSun: (v) => { SUN.copy(v).normalize(); sh.x = NaN; dirty = true },
  post: { uniforms: { tint: ink.uniforms.tint, desat: ink.uniforms.desat } },
  requestRender: () => { dirty = true },
  data: {},
  tiles,
  night,
  suppressBuildings: (ring) => tiles.addMask(ring.map(([lat, lon]) => ll(lat, lon))),
  ownCamera,
})
window.city = city
window.view = { cam, controls, setView, zAt, renderer, tiles }

// ---------- loading screen: until what's on screen has arrived ----------
await new Promise((ok) => {
  const tick = () => {
    const p = tiles.progress()
    status('Loading the map…', 0.1 + 0.9 * p)
    if (p >= 1 && tiles.tiles.size) ok(); else setTimeout(tick, 100)
  }
  tick()
})
status('Ready', 1)
requestAnimationFrame(() => loadingEl.classList.add('done'))
setTimeout(() => loadingEl.remove(), 800)
$('#hint').hidden = false
loadPlugins(city)
