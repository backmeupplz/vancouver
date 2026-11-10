import * as THREE from 'three'
import { MapControls } from './vendor/MapControls.js'
import { createCity, loadPlugins } from './city.js'
import { Tiles, holed, holedTrees } from './core/tiles.js'
import { groundMaterial, roadMaterial, buildingMaterial, aoMaterial, treeAtlas, treeMaterial, night, late, surface, occluder } from './core/materials.js'
import { StreetLights } from './core/lights.js'
import { Trees3D } from './core/trees3d.js'
import { look, lookFor, lookUniforms, LOOK_GLSL, Bloom } from './core/look.js'
import { createQuality } from './core/quality.js'

// World: metres east (x) and north of an origin downtown (tools/common.py); three.js x = east, y = up, z = south.
// Heights are real elevations. The camera is orthographic, looking north, 30° down; the view lives in the URL
// as #x,y,s (drawing pixels at 6 px per metre, CSS px per drawing px).
const $ = (s) => document.querySelector(s)
const loadingEl = $('#loading')
const status = (t, frac) => { loadingEl.querySelector('.step').textContent = t; if (frac !== undefined) loadingEl.querySelector('.fill').style.width = `${Math.round(frac * 100)}%` }
addEventListener('error', (e) => { if (/WebGL unavailable/.test(e.message)) return; loadingEl?.classList.add('error'); if (loadingEl?.isConnected) status(`Something went wrong: ${e.message}`) })

let city = null // the plugin host (city.js)
let dirty = true // render on demand: only when something changed
let shadowStale = false, lampsStale = false, lastShadow = 0 // new tiles refresh the shadow map, at most twice a second
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
const quality = createQuality(renderer.getContext(), (t) => applyQuality(t)) // Auto / High / Low (core/quality.js)
let PR = Math.min(devicePixelRatio, quality.tier.pixelRatio)
renderer.setPixelRatio(PR)
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.autoUpdate = false
renderer.outputColorSpace = THREE.SRGBColorSpace
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0e1620)
const treeScene = new THREE.Scene() // billboards, drawn after the ink pass
const overlay = new THREE.Scene() // plugins' effects, drawn last without outlines
scene.name = 'scene'; treeScene.name = 'trees'; overlay.name = 'overlay' // (names: tools/bench.mjs's GPU time per pass)

// ---------- light ----------
const hemi = new THREE.HemisphereLight(0xe8eef8, 0x8a8070, 2.0)
scene.add(hemi)
const sun = new THREE.DirectionalLight(0xfff1dc, 2.3)
const SUN = new THREE.Vector3(-0.55, 0.62, 0.56).normalize() // afternoon, from the south-west (plugins may move it)
// shadows by quality tier: 'high' a 4096 px map with soft edges, 'low' (and phones) 2048 px with plain PCF, or 'off'
function shadowQuality(t) {
  const hi = t.shadows === 'high' && !mobile, size = hi ? 4096 : 2048, type = hi ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap
  if (sun.castShadow === (t.shadows !== 'off') && renderer.shadowMap.type === type && sun.shadow.mapSize.x === size) return
  sun.castShadow = t.shadows !== 'off'; renderer.shadowMap.type = type
  if (sun.shadow.mapSize.x !== size) { sun.shadow.mapSize.setScalar(size); sun.shadow.map?.dispose(); sun.shadow.map = null }
  for (const s of [scene, treeScene]) s.traverse((o) => { if (o.material) for (const m of [o.material].flat()) m.needsUpdate = true }) // shaders follow the shadow type
  renderer.shadowMap.needsUpdate = true
}
shadowQuality(quality.tier)
sun.shadow.bias = -0.0005
scene.add(sun, sun.target)

// ---------- the map ----------
const mats = { ground: groundMaterial(), road: roadMaterial(), paint: roadMaterial(true), building: buildingMaterial(), tree: treeMaterial(treeAtlas(renderer)), ao: aoMaterial() }
// the overview tiles' own (tiles.js holed): a street-level view sees them past the detail tiles, and not where those show
const farMats = { ground: holed(groundMaterial(true)), road: holed(roadMaterial()), paint: mats.paint, building: holed(buildingMaterial(true)), tree: holedTrees(mats.tree) }
const lights = new StreetLights() // night lights: lamps and shop windows (core/lights.js)
let lightStale = true
const tiles = new Tiles({
  scene, treeScene, mats, farMats, lights,
  // shadows follow new tiles at most twice a second; a tile that loads hidden changes neither them nor the picture
  // (t: the tile that came or went; one outside the shadow map's square, with room for a tower's shadow, leaves the shadows be:
  // a street-level view's overview tiles kept redrawing them, and the night lights with them, twice a second)
  onChange: (shown = true, t) => { dirty = true; if (shown) { if (!t || nearShadows(t)) shadowStale = true; else if (!t.level) lampsStale = true; trees3d?.changed() } }, // (a detail tile brings its lamps)
  onLoad: (t) => city?.emit('tile:load', tileInfo(t)),
  onUnload: (t) => { trees3d?.changed(); city?.emit('tile:unload', tileInfo(t)) },
})
const trees3d = new Trees3D({ scene, tiles, treeMaterial: mats.tree }) // real trees near a perspective camera
tiles.cached = quality.tier.cached; trees3d.share = quality.tier.trees3d; trees3d.fine = quality.tier.detail; mats.ao.visible = quality.tier.detail // (the wall-foot shade: High)
const tileInfo = (t) => ({ level: t.level, i: t.i, j: t.j, ox: t.ox, oy: t.oy, size: t.level ? 4096 : 1024, graph: t.graph, terrain: t.terrain, footprints: t.footprints, overhangs: t.overhangs, signs: t.signs, water: t.water,
  trees: t.trees ? { pos: t.trees.geometry.attributes.iPos.array, size: t.trees.geometry.attributes.iSize.array } : null })
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
// two fingers: pinch to zoom (at the pinch) and twist (past 12°) to turn, or move both up or down to tilt. A gesture locks to
// the first it looks like, so a pinch doesn't wobble the map round as OrbitControls' DOLLY_ROTATE does (it turns
// and tilts with any drift of the fingers' midpoint).
{
  let g = null
  const two = () => { // the two fingers in a fixed order (events come from either one)
    const [p, q] = controls._pointers.map((id) => controls._pointerPositions[id])
    return { d: Math.hypot(p.x - q.x, p.y - q.y), a: Math.atan2(p.y - q.y, p.x - q.x), x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
  }
  controls._handleTouchStartDollyRotate = () => { g = { ...two(), mode: null, s: 0, t: 0, v: 0 } }
  controls._handleTouchMoveDollyRotate = () => {
    if (!g) return
    const n = two(), ds = Math.log(n.d / g.d), da = Math.atan2(Math.sin(n.a - g.a), Math.cos(n.a - g.a)), dy = n.y - g.y
    if (!g.mode) { // decide: 14 px of parallel travel is a tilt; 6% of scale or 5° of twist is a pinch
      g.s += ds; g.t += da; g.v += dy
      if (Math.abs(g.v) > 14 && Math.abs(g.s) < 0.06 && Math.abs(g.t) < 0.09) g.mode = 'tilt'
      else if (Math.abs(g.s) > 0.06 || Math.abs(g.t) > 0.09) g.mode = 'pinch'
    }
    if (g.mode === 'pinch') {
      controls._dollyOut(Math.exp(ds * controls.zoomSpeed)); controls._updateZoomParameters(n.x, n.y)
      g.tw = (g.tw || 0) + da
      if (Math.abs(g.tw) > 0.2) controls._rotateLeft(da) // turning starts past a 12° twist, so pinches stay straight
    } else if (g.mode === 'tilt') controls._rotateUp((2 * Math.PI * dy * controls.rotateSpeed) / renderer.domElement.clientHeight)
    Object.assign(g, n)
  }
}
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
    const r = cam.position.clone().sub(controls.target), t = controls.target.clone().addScaledVector(r, -controls.target.y / r.y) // the centre's view ray at sea level
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
const OCCLUDER = { foot: [1, 0.4], car: [1.2, 1.2], bus: [1.6, 1.8], boat: [1.5, 2] } // per player mode: centre height, radius
let own = null // { camera, opts: { focus, radius, shadowRadius } }
const ownSeen = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3()
let shMap = null // the map view's shadow fit, put back exactly on release
const ownCamera = {
  use(camera, opts) { own = { camera, opts }; settle(); controls.enabled = false; shMap = { ...sh, persp: false }; sh.x = NaN; dirty = true; ownSeen.copy(opts.focus); city.emit('view', city.view) },
  release() {
    own = null; controls.enabled = true; dirty = true
    trees3d.off(); mats.tree.uniforms.cyl.value = 0
    settle()
    if (Number.isFinite(shMap?.x)) { Object.assign(sh, shMap); fitShadows() } else Object.assign(sh, { x: NaN, persp: false })
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
function nearShadows(t) {
  const s = t.level ? 4096 : 1024, m = sh.r + 400
  return !(sh.x >= -1e9) || (t.ox < sh.x + m && t.ox + s > sh.x - m && t.oy < -sh.z + m && t.oy + s > -sh.z - m)
}
function updateShadows() {
  if (own?.camera.isPerspectiveCamera) return perspectiveShadows(own.camera, own.opts.shadowRadius ?? 300)
  const r = own ? own.opts.shadowRadius ?? 300 : Math.hypot(innerWidth, innerHeight * 2) / K / cam.zoom / 2 + 80
  const t = own ? own.opts.focus : controls.target
  // the fit depends on the view alone, not on the way it got there (a fit kept from an earlier view left the screen's
  // edges unshadowed, or a zoomed-in view with a blurrier map, #548): its size in steps of 2^¼ from 1.5 r, its centre on a
  // grid of a quarter of it, so the screen is always inside (at least 1.3 r) and the same view gets the same shadows
  const R = 2 ** (Math.ceil(4 * Math.log2(r * 1.5)) / 4), g = R / 4, x = Math.round(t.x / g) * g, z = Math.round(t.z / g) * g
  if (!sh.persp && sh.x === x && sh.z === z && sh.r === R) return
  Object.assign(sh, { x, y: 0, z, r: R, persp: false })
  fitShadows()
}
// A perspective camera sees its shadows mostly close by: a square of half-size r that reaches from just behind the
// camera to 1.5 r ahead of it, refitted (and redrawn) each time the camera has moved on a fifth of r. The light sits
// 2 km away instead of 8, so its depth range, and with it the depth bias in metres, is four times tighter: shadows
// start right at the foot of a wall instead of a few metres off it.
function perspectiveShadows(C, r) {
  C.getWorldDirection(v1); v1.y = 0
  if (v1.lengthSq() < 1e-6) v1.set(0, 0, -1)
  v1.normalize()
  const x = C.position.x + v1.x * r * 0.55, z = C.position.z + v1.z * r * 0.55
  if (sh.persp && Math.hypot(x - sh.x, z - sh.z) < r * 0.2 && Math.abs(r - sh.r) < r * 0.1) return
  Object.assign(sh, { x, y: own.opts.focus.y, z, r, persp: true })
  fitShadows()
}
function fitShadows() {
  const texel = (2 * sh.r) / sun.shadow.mapSize.x, sx = Math.round(sh.x / texel) * texel, sz = Math.round(sh.z / texel) * texel
  const D = sh.persp ? 2000 : 8000
  sun.shadow.normalBias = texel * 1.2
  sun.shadow.bias = sh.persp ? -0.0005 / 4 : -0.0005
  sun.target.position.set(sx, sh.y, sz)
  sun.position.copy(sun.target.position).addScaledVector(SUN, D)
  Object.assign(sun.shadow.camera, { left: -sh.r, right: sh.r, top: sh.r, bottom: -sh.r, near: 10, far: D * 2 })
  sun.shadow.camera.updateProjectionMatrix()
  renderer.shadowMap.needsUpdate = true
  lightStale = true // the night lights cover the same square
}
// the night lights' texture over the shadows' square, redrawn with it (and as tiles arrive); a perspective camera's
// shadows reach only a few hundred metres: its lights cover the streamed square round the focus. By day none
function updateLights() {
  lights.head.visible = night.value >= 0.01 && quality.tier.lights > 1024
  if (night.value < 0.01 || !Number.isFinite(sh.x)) { lights.off(); lightStale = true; return }
  if (!lightStale) return
  lightStale = false
  const p = own?.camera.isPerspectiveCamera && own.opts
  if (p) lights.draw(renderer, p.focus.x, p.focus.z, Math.min(1100, p.radius ?? 900), quality.tier.lights)
  else lights.draw(renderer, sh.x, sh.z, sh.r, quality.tier.lights)
}

// ---------- ink: edges in the depth buffer drawn as dark lines, plus the colour grade and the camera's look ----------
// (core/look.js: exposure, contrast, saturation, ACES, bloom). The scene is drawn into a half-float target where the
// tier has HDR (high: lamps and windows can be brighter than white, for the bloom and the tone curve's shoulder), else
// into 8-bit sRGB (low: half the bandwidth, no banding in the dark)
const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType })
rt.depthTexture = new THREE.DepthTexture(1, 1)
function setHDR(on) {
  if ((rt.texture.type === THREE.HalfFloatType) === on) return
  rt.texture.type = on ? THREE.HalfFloatType : THREE.UnsignedByteType; rt.texture.colorSpace = on ? THREE.NoColorSpace : THREE.SRGBColorSpace; rt.dispose()
}
// the weather's grade (sat, gain, desat, tint) of a scene pixel; lit windows and lamp light (alpha < 1) skip it
const GRADE = `uniform float sat, desat; uniform vec3 gain, tint;
  vec3 graded(vec4 col) {
    vec3 cc = max(mix(vec3(dot(col.rgb, vec3(0.2126, 0.7152, 0.0722))), col.rgb, sat), 0.0) * gain;
    cc = mix(cc, vec3(dot(cc, vec3(0.2126, 0.7152, 0.0722))), desat) * tint;
    return mix(cc, col.rgb, 1.0 - col.a);
  }`
const ink = new THREE.ShaderMaterial({
  defines: { LOOK: 1 },
  uniforms: { tBloom: look.tBloom, bloomK: look.bloom, tColor: { value: rt.texture }, tDepth: { value: rt.depthTexture }, sat: { value: 1.2 }, gain: { value: new THREE.Vector3(1, 1, 1) }, tint: { value: new THREE.Vector3(1, 1, 1) },
    desat: { value: 0 }, px: { value: new THREE.Vector2() }, uvs: { value: new THREE.Vector2(1, 1) }, off: { value: new THREE.Vector2() }, lim: { value: new THREE.Vector2(1, 1) }, range: { value: 1 }, thr: { value: 1 }, ink: { value: 0 },
    cnear: { value: 1 }, cfar: { value: 2 }, fade: { value: new THREE.Vector2(1e9, 2e9) }, inkFade: { value: new THREE.Vector2(1e9, 2e9) }, tSky: { value: null }, fogCol: { value: new THREE.Color() },
    zenCol: { value: new THREE.Color() }, domeK: { value: 0 }, projInv: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() } },
  vertexShader: `varying vec2 vUv;
    #ifdef SKYFOG
    uniform mat4 projInv, camWorld; varying vec3 vRay; // the view ray through this pixel, in the world
    #endif
    void main() {
      vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0);
      #ifdef SKYFOG
      vec4 v = projInv * vec4(position.xy, 1.0, 1.0); vRay = mat3(camWorld) * (v.xyz / v.w);
      #endif
    }`,
  // orthographic: depth is linear, edges are jumps in metres. PERSP (a plugin's perspective camera): 1/distance is
  // linear across a plane, so edges are jumps in 1/distance relative to it, faded out from inkFade.x to .y metres (the
  // fog's fade.x to .y swaps the fog colour for the sky behind)
  // The scene may fill only part of the target (adaptive resolution): uvs is that part, lim its last texel centre,
  // off the sub-texel shift of a map camera snapped to the texel grid.
  // NOINK (quality tier ink: 'off'): the grade only, no depth taps.
  fragmentShader: `uniform sampler2D tColor, tDepth; uniform vec2 px, uvs, off, lim; uniform float range, thr, ink; varying vec2 vUv;
    ${GRADE}
    ${LOOK_GLSL}
    #ifdef BLOOM
    uniform sampler2D tBloom; uniform float bloomK;
    #endif
    vec2 uv;
    // the depth taps on whole texels, step texels apart from the centre's: below full resolution (0.8) every 5th row and
    // column falls on a texel edge, where the centre and its neighbours rounded to texels on their own, so a flat road
    // read as a ladder of edges in front of the van
    #ifdef LOWRES
    // below full resolution (adaptive): a texel is more than half a CSS px, and whole-texel lines were that many CSS px
    // wide and blocky. Here the depth is read bilinearly (exact on any plane, so no ladders either) at the output's own
    // pixels, the taps half a CSS px (px) apart: a line a CSS px wide, smooth at its ends, at any scale
    float z(vec2 o) {
      vec2 n = vec2(textureSize(tDepth, 0)), q = uv * n + o * px * n - 0.5, f = fract(q), m = lim * n;
      ivec2 a = ivec2(clamp(floor(q), vec2(0.0), m)), b = ivec2(clamp(floor(q) + 1.0, vec2(0.0), m));
      return mix(mix(texelFetch(tDepth, a, 0).x, texelFetch(tDepth, ivec2(b.x, a.y), 0).x, f.x), mix(texelFetch(tDepth, ivec2(a.x, b.y), 0).x, texelFetch(tDepth, b, 0).x, f.x), f.y);
    }
    #else
    float z(vec2 o) { vec2 n = vec2(textureSize(tDepth, 0)); return texelFetch(tDepth, ivec2(clamp(floor(uv * n) + o * floor(px * n + 0.5), vec2(0.0), lim * n)), 0).x; }
    #endif
    #ifdef PERSP
    uniform float cnear, cfar; uniform vec2 fade, inkFade;
    #ifdef SKYFOG
    uniform sampler2D tSky; uniform vec3 fogCol, zenCol; uniform float domeK; varying vec3 vRay;
    #endif
    float d(vec2 o) { return (cfar - z(o) * (cfar - cnear)) / (cnear * cfar); }
    #else
    float d(vec2 o) { return z(o) * range; }
    #endif
    void main() {
      uv = vUv * uvs + off;
      vec4 col = texture2D(tColor, uv);
      float c = d(vec2(0.0));
      #ifdef SKYFOG
      // fog towards the sky behind, not one flat colour: far buildings fade into the sky gradient instead of
      // standing in it as pale cut-outs that the far plane slices (materials fogged to fogCol; swap it for the sky)
      // The sky behind is the background texture, or the weather plugin's dome over it (domeK): its gradient from the
      // fog colour at the horizon up to the zenith, by the height of the view ray (clouds and sun left out)
      if (texture2D(tDepth, uv).x < 1.0) {
        vec3 sky = mix(texture2D(tSky, vec2(0.5, vUv.y)).rgb, mix(fogCol, zenCol, smoothstep(0.0, 0.55, max(normalize(vRay).y, 0.0))), domeK);
        col.rgb += smoothstep(fade.x, fade.y, 1.0 / c) * (sky - fogCol);
      }
      #endif
      #ifdef NOINK
      float e = 0.0;
      #else
      // one-sided: only the nearer side of a depth step (the curvature is positive there) draws the line, so an edge is
      // one texel wide instead of two (the far side's negative curvature is the same edge again)
      float lap = max(max(d(vec2(1.0, 0.0)) + d(vec2(-1.0, 0.0)) - 2.0 * c, d(vec2(0.0, 1.0)) + d(vec2(0.0, -1.0)) - 2.0 * c), 0.0);
      #ifdef PERSP
      lap /= c;
      #endif
      #ifdef LOWRES
      lap /= px.x * float(textureSize(tDepth, 0).x); // a step's curvature at taps a fraction of a texel apart, as at a whole texel
      #endif
      float e = smoothstep(thr, thr * 6.0, lap) * ink;
      #ifdef PERSP
      e *= 1.0 - smoothstep(inkFade.x, inkFade.y, 1.0 / c);
      #endif
      #endif
      vec3 cc = exposed(graded(vec4(mix(col.rgb, col.rgb * vec3(0.16, 0.18, 0.22), e), col.a)));
      #ifdef BLOOM
      cc += texture2D(tBloom, vUv).rgb * bloomK;
      #endif
      vec2 r = (vUv - 0.5) * vec2(px.y / px.x, 1.0); // a faint vignette, the same in portrait and landscape
      cc = tone(cc) * (1.0 - 0.12 * smoothstep(0.35, 1.0, length(r) / length(vec2(px.y / px.x, 1.0) * 0.5)));
      gl_FragColor = vec4(cc, 1.0);
      #include <colorspace_fragment>
      gl_FragDepth = texture2D(tDepth, uv).x;
    }`,
  depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth,
})
lookUniforms(ink.uniforms)
const bloom = new Bloom(`uniform sampler2D tColor; uniform vec2 uvs, off; ${GRADE} ${LOOK_GLSL}
  vec3 source(vec2 u) { return exposed(graded(texture2D(tColor, u * uvs + off))); }`, ink.uniforms)
const define = (k, on) => { if (!!ink.defines[k] === on) return; if (on) ink.defines[k] = 1; else delete ink.defines[k]; ink.needsUpdate = true }
define('NOINK', quality.tier.ink === 'off')
setHDR(quality.tier.hdr)
const post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ink)
post.frustumCulled = false
const postScene = new THREE.Scene(), postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
postScene.add(post)
// ---------- anti-aliasing: the scene itself is multisampled (rt), but the ink lines are found per pixel in its
// depth, so they step like any 1 px line. With FXAA the ink pass and what is drawn after it (trees, overlay) go to aa
// (sRGB, so blending stays linear) and FXAA (NVIDIA's, Jasper Flick's version as in three.js's FXAAShader, MIT)
// smooths the lines into the canvas. setAA(mode), for quality tiers (window.view.setAA): 'auto' (the default: MSAA,
// see msaa below, + FXAA), 'fxaa' (FXAA only: the low tier), 'msaa' (the MSAA scene only), 'off' (neither). FXAA runs
// where a scene texel is over 2/3 CSS px (pixel ratio x adaptive resolution under 1.5), map and street level alike:
// there the steps show, worst when adaptive resolution stretches the scene (at 0.5 they were 2 px stairs, #557); at
// 2x and full resolution they are half as big and the pass would cost four times as much ----------
const aa = new THREE.WebGLRenderTarget(1, 1, { colorSpace: THREE.SRGBColorSpace })
const fxaa = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { tDiffuse: { value: aa.texture }, px: { value: new THREE.Vector2() } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 px; varying vec2 vUv;
    float L(vec2 uv) { return dot(sqrt(texture2D(tDiffuse, uv).rgb), vec3(0.3, 0.59, 0.11)); } // perceptual luma
    float L(vec2 uv, float u, float v) { return L(uv + px * vec2(u, v)); }
    const float STEPS[6] = float[6](1.0, 1.5, 2.0, 2.0, 2.0, 4.0);
    void main() {
      vec2 uv = vUv;
      float m = L(uv), n = L(uv, 0.0, 1.0), e = L(uv, 1.0, 0.0), s = L(uv, 0.0, -1.0), w = L(uv, -1.0, 0.0);
      float hi = max(max(max(max(n, e), s), w), m), lo = min(min(min(min(n, e), s), w), m), con = hi - lo;
      if (con >= max(0.0312, 0.063 * hi)) {
        float ne = L(uv, 1.0, 1.0), nw = L(uv, -1.0, 1.0), se = L(uv, 1.0, -1.0), sw = L(uv, -1.0, -1.0);
        float f = clamp(abs((2.0 * (n + e + s + w) + ne + nw + se + sw) / 12.0 - m) / con, 0.0, 1.0);
        f = smoothstep(0.0, 1.0, f); f *= f;
        bool hor = abs(n + s - 2.0 * m) * 2.0 + abs(ne + se - 2.0 * e) + abs(nw + sw - 2.0 * w) >= abs(e + w - 2.0 * m) * 2.0 + abs(ne + nw - 2.0 * n) + abs(se + sw - 2.0 * s);
        float pl = hor ? n : e, nl = hor ? s : w, pg = abs(pl - m), ng = abs(nl - m), stp = hor ? px.y : px.x, opp = pl, grad = pg;
        if (pg < ng) { stp = -stp; opp = nl; grad = ng; }
        vec2 ue = uv, es = hor ? vec2(px.x, 0.0) : vec2(0.0, px.y);
        if (hor) ue.y += stp * 0.5; else ue.x += stp * 0.5;
        float el = (m + opp) * 0.5, gt = grad * 0.25;
        vec2 pu = ue + es, nu = ue - es;
        float pd = L(pu) - el, nd = L(nu) - el;
        bool pe = abs(pd) >= gt, ne2 = abs(nd) >= gt;
        for (int i = 1; i < 6 && !pe; i++) { pu += es * STEPS[i]; pd = L(pu) - el; pe = abs(pd) >= gt; }
        if (!pe) pu += es * 8.0;
        for (int i = 1; i < 6 && !ne2; i++) { nu -= es * STEPS[i]; nd = L(nu) - el; ne2 = abs(nd) >= gt; }
        if (!ne2) nu -= es * 8.0;
        float pD = hor ? pu.x - uv.x : pu.y - uv.y, nD = hor ? uv.x - nu.x : uv.y - nu.y;
        bool sg = pD <= nD ? pd >= 0.0 : nd >= 0.0;
        float eb = sg == (m - el >= 0.0) ? 0.0 : 0.5 - min(pD, nD) / (pD + nD);
        float b = max(f, eb);
        if (hor) uv.y += stp * b; else uv.x += stp * b;
      }
      gl_FragColor = texture2D(tDiffuse, uv);
      #include <colorspace_fragment>
    }`,
  depthTest: false, depthWrite: false,
}))
fxaa.frustumCulled = false
const fxaaScene = new THREE.Scene()
fxaaScene.name = 'fxaa'; postScene.name = 'ink'
fxaaScene.add(fxaa)
let aaMode = quality.tier.aa
function setAA(mode) { aaMode = mode; dirty = true } // the quality tier's aa
// MSAA samples for camera C: 'auto' skips them for the map on a screen of 1.75+ device px per CSS px, where its
// pixels are finer than the ink lines that draw the edges anyway (4x MSAA was ~40% of the map's frame at 2x).
// A change reallocates rt: only when a plugin's camera comes or goes or the tier changes.
const msaa = (C, pr) => aaMode === 'off' || aaMode === 'fxaa' || (aaMode === 'auto' && !C.isPerspectiveCamera && pr >= 1.75) ? 0 : 4
// the scene is drawn into the corner `scale` of rt (adaptive resolution, below), the ink pass stretches it over the
// canvas; the trees and the overlay are drawn at full resolution
function draw(scale = res) {
  const w = renderer.domElement.width, h = renderer.domElement.height, pr = renderer.getPixelRatio()
  if (rt.width !== w || rt.height !== h) rt.setSize(w, h)
  const rw = Math.max(1, Math.round(w * scale)), rh = Math.max(1, Math.round(h * scale))
  rt.viewport.set(0, 0, rw, rh); rt.scissor.set(0, 0, rw, rh); rt.scissorTest = rw < w
  const C = own ? own.camera : cam, zoom = own ? ownCamera.zoom : cam.zoom, u = ink.uniforms
  if (rt.samples !== msaa(C, pr)) { rt.samples = msaa(C, pr); rt.dispose() }
  // the outline's width: a CSS px, in whole texels (else slopes read as edges); below full resolution half a CSS px
  // between bilinear taps (LOWRES)
  define('LOWRES', scale < 1)
  const step = scale < 1 ? 0.5 * pr * scale : Math.max(1, Math.round(pr * scale))
  u.px.value.set(step / w, step / h); u.uvs.value.set(rw / w, rh / h); u.lim.value.set((rw - 0.5) / w, (rh - 0.5) / h)
  u.range.value = C.far - C.near
  define('PERSP', !!C.isPerspectiveCamera)
  const skyFog = !!(C.isPerspectiveCamera && scene.fog?.isFog && scene.background?.isTexture)
  define('SKYFOG', skyFog)
  if (skyFog) {
    u.tSky.value = scene.background; u.fogCol.value.copy(scene.fog.color)
    const zen = city?.weather?.atmosphere?.zenith // the weather plugin's sky dome (it fades in with the fov, as here)
    u.domeK.value = zen == null ? 0 : THREE.MathUtils.smoothstep(C.fov, 14, 40)
    if (zen != null) u.zenCol.value.setHex(zen)
    C.updateMatrixWorld(); u.projInv.value.copy(C.projectionMatrixInverse); u.camWorld.value.copy(C.matrixWorld)
  }
  if (C.isPerspectiveCamera) {
    const d = v1.copy(own.opts.focus).sub(C.position).dot(C.getWorldDirection(v2)) // metres to the focus
    u.cnear.value = C.near; u.cfar.value = C.far; u.thr.value = Math.min(0.004, Math.max(0.35 / (K * zoom), 0.9) / Math.max(1, d))
    if (scene.fog?.isFog) u.fade.value.set(scene.fog.near, scene.fog.far); else u.fade.value.set(1e9, 2e9)
    // the outlines fade out within ~1.5 km even in a long clear view: far off they would be all there is of a building
    u.inkFade.value.set(Math.min(u.fade.value.x, 600), Math.min(u.fade.value.y, 1600))
  } else u.thr.value = Math.max(0.35 / (K * cam.zoom), 0.9)
  u.ink.value = THREE.MathUtils.smoothstep(zoom, 0.05, 0.16) * (1 - 0.45 * night.value) // softer by night, as the light draws the edges
  // a light grade: the materials carry natural, map-like colours of their own (a strong blue gain read as neon)
  u.sat.value = 1.0 + 0.12 * THREE.MathUtils.smoothstep(zoom, 0.04, 0.2)
  const near = THREE.MathUtils.smoothstep(zoom, 0.04, 0.12)
  u.gain.value.set(1 + 0.05 * near, 1 + 0.06 * near, 1 + 0.09 * near)
  treeScene.fog = scene.fog
  renderer.info.autoReset = false; renderer.info.reset()
  const smooth = (aaMode === 'fxaa' || aaMode === 'auto') && pr * scale < 1.5 // (scene texels bigger than 2/3 CSS px: their steps show)
  if (smooth && (aa.width !== w || aa.height !== h)) aa.setSize(w, h)
  // below full resolution the map camera renders from a spot snapped to the target's texel grid and the ink pass
  // shifts the picture back by the remainder: the coarse pixels move with the map instead of resampling a crawl
  // over the fine facade lines with every pan
  const snap = scale < 1 && !C.isPerspectiveCamera
  u.off.value.set(0, 0)
  if (snap) {
    C.updateMatrixWorld()
    const e = C.matrixWorld.elements, tx = (C.right - C.left) / C.zoom / rw, ty = (C.top - C.bottom) / C.zoom / rh
    const a = (C.position.x * e[0] + C.position.y * e[1] + C.position.z * e[2]) / tx, b = (C.position.x * e[4] + C.position.y * e[5] + C.position.z * e[6]) / ty
    const fa = a - Math.round(a), fb = b - Math.round(b)
    v2.copy(C.position); C.position.addScaledVector(v1.set(e[0], e[1], e[2]), -fa * tx).addScaledVector(v1.set(e[4], e[5], e[6]), -fb * ty); C.updateMatrixWorld()
    u.off.value.set(fa / w, fb / h)
  }
  renderer.setRenderTarget(rt); renderer.render(scene, C)
  const glow = quality.tier.bloom && look.bloom.value > 0.01
  define('BLOOM', glow)
  if (glow) bloom.render(renderer, w, h)
  if (snap) { C.position.copy(v2); C.updateMatrixWorld() }
  renderer.setRenderTarget(smooth ? aa : null); renderer.render(postScene, postCam)
  const tm = mats.tree.uniforms
  tm.lampTrees.value = C.isPerspectiveCamera || zoom >= 0.25 ? 1 : 0 // (a texture fetch per billboard corner: not for the whole city)
  // the billboards are lit and graded as the 3D trees are (the map's a little less saturated)
  tm.sat.value = ink.uniforms.sat.value * (tm.cyl.value ? 1 : 0.88); tm.gain.value.copy(ink.uniforms.gain.value); tm.tint.value.copy(ink.uniforms.tint.value); tm.desat.value = ink.uniforms.desat.value
  tm.sunDir.value.subVectors(sun.position, sun.target.position).normalize(); tm.sunCol.value.copy(sun.color).multiplyScalar(sun.visible ? sun.intensity : 0)
  tm.sky.value.copy(hemi.color).multiplyScalar(hemi.intensity); tm.gnd.value.copy(hemi.groundColor).multiplyScalar(hemi.intensity)
  renderer.autoClear = false
  renderer.render(treeScene, C)
  if (overlay.children.length) renderer.render(overlay, C)
  renderer.autoClear = true
  if (smooth) { fxaa.material.uniforms.px.value.set(1 / w, 1 / h); renderer.setRenderTarget(null); renderer.render(fxaaScene, postCam) }
}

// ---------- adaptive resolution: when frames drawn back to back keep coming late (over 20 ms: 60 fps or better is
// on time), the scene is drawn at a lower share `res` of the canvas resolution, a step at a time down to the quality
// tier's floor; after a while of on-time frames it probes a step back up (and after a probe that was too much goes
// straight back and waits twice as long; a probe that holds halves the wait again). Auto drops to the low tier when even
// the floor is late while no tiles stream (their uploads, not the pixels), and goes back up after upMs of on-time frames
// at full resolution (twice as long each time it had to drop again soon after, #548). When the view stops and nothing animates,
// one last frame is drawn at full resolution, so a still map is sharp; a view that stops while things animate (traffic,
// ships, weather) goes straight back to full resolution half a second later, and stays there while its frames are on time.
let res = 1, pinned = false, loadedAt = 0, lateMs = 0, onTimeMs = 0, probeMs = 3000, upMs = 20000, promotedAt = -1e9, streamAt = -1e9, probedAt = -1e9, settleAt = Infinity, floorLate = 0, stillAt = 0, seenZoom = 0, probeFrom = 1
const seen = new THREE.Matrix4()
function settle() { settleAt = performance.now() + 2500; lateMs = onTimeMs = 0; dirty = true } // a new camera or tier compiles shaders: no measure
// ms: since the last frame; cpu: the main thread's own work in it (a frame late from building a tile is not one a
// lower resolution would help)
function adaptResolution(ms, cpu, now, C) {
  if (!seen.equals(C.matrixWorld) || seenZoom !== C.zoom) { seen.copy(C.matrixWorld); seenZoom = C.zoom; stillAt = now }
  if (pinned || document.hidden || now < settleAt || ms > 250 || cpu > 10) return // nor is a stall (a hidden tab, a long task)
  // nor are frames while tiles stream in: their uploads' GPU time lands in them, and a lower resolution would not help.
  // It used to step the resolution down to the floor on every load and stay there for a minute (#557); after a
  // load the next probe back up comes soon
  if (now - streamAt < 300) { lateMs = 0; loadedAt = now; return }
  if (loadedAt) { loadedAt = 0; probeMs = 3000 }
  if (res < 1 && now - stillAt > 500 && now - probedAt > probeMs) { probeFrom = res; res = 1; onTimeMs = lateMs = 0; probedAt = now; floorLate = 0; return }
  if (ms > 20) { lateMs += ms; onTimeMs = 0 } else { lateMs = Math.max(0, lateMs - ms * 0.1); onTimeMs += ms } // more than 1 in ~20 late adds up
  if (lateMs > 600) {
    lateMs = 0
    if (now - probedAt < 3000) { probeMs = Math.min(60000, probeMs * 2); if (res > probeFrom) { res = probeFrom; return } } // a probe too far: straight back
    if (res > quality.tier.minRes + 0.01) res = Math.max(quality.tier.minRes, Math.round(res * 10 - 1) / 10)
    else if (now - streamAt > 2000 && ++floorLate >= 3) { floorLate = 0; if (quality.demote() && now - promotedAt < 2 * upMs) upMs = Math.min(600000, upMs * 2) }
  } else if (res < 1 && onTimeMs > probeMs) {
    if (now - probedAt > 2 * probeMs) probeMs = Math.max(3000, probeMs / 2) // the last probe held
    probeFrom = res; res = Math.min(1, Math.round(res * 10 + 1) / 10); onTimeMs = 0; probedAt = now; floorLate = 0
  } else if (res >= 1 && onTimeMs > upMs && quality.promote()) promotedAt = now
}
function applyQuality(t) { // a new tier (core/quality.js)
  PR = Math.min(devicePixelRatio, t.pixelRatio)
  renderer.setPixelRatio(PR); renderer.setSize(innerWidth, innerHeight)
  shadowQuality(t)
  setAA(t.aa)
  setHDR(t.hdr); if (!t.bloom) bloom.dispose()
  define('NOINK', t.ink === 'off')
  tiles.cached = t.cached; trees3d.share = t.trees3d; trees3d.fine = t.detail; trees3d.changed(); mats.ao.visible = t.detail
  lightStale = true
  if (!pinned) res = 1
  settle()
  city?.emit('quality', t)
}

// ---------- frame loop ----------
let lastFrame = performance.now(), drew = false, cpu = 0, frameMs = 16.7 // (frameMs: drawn back to back, smoothed, for #perf)
function loop(now) {
  requestAnimationFrame(loop)
  const t0 = performance.now()
  if (!own) controls.update()
  if (tiles.made.length || tiles.warming.length) streamAt = t0
  tiles.pump(renderer) // new tiles: made and uploaded a little per frame, drawn or not
  const ms = now - lastFrame, dt = Math.min(0.1, ms / 1000 || 0); lastFrame = now
  if (city?.animating) dirty = true
  if (!dirty) { if (drew && res < 1) draw(1); drew = false; return } // still: once more, sharp
  if (drew) { adaptResolution(ms, cpu, now, own ? own.camera : cam); frameMs += (Math.min(ms, 250) - frameMs) * 0.1 }
  drew = true
  dirty = false
  if (own) {
    tiles.update(own.camera, own.opts.focus, own.opts.radius, own.camera.isPerspectiveCamera ? Math.min(own.camera.far, quality.tier.overview) : 0)
    tiles.setDetail(quality.tier.detail, true, 1)
    if (own.opts.focus.distanceTo(ownSeen) > 20) { ownSeen.copy(own.opts.focus); city?.emit('view', city.view) }
  } else {
    tiles.update(cam, controls.target)
    tiles.setDetail(quality.tier.detail && cam.zoom >= 0.3, cam.zoom >= 0.3, cam.zoom >= (quality.tier.detail ? 0.15 : 0.3) ? 2 : 0) // parked cars: specks from 0.15
  }
  if (!own && now - lastGroundCheck > 300) { // keep the orbit target on the ground
    lastGroundCheck = now
    const g = zAt(controls.target.x, -controls.target.z)
    // moved along the view ray, so the picture stays put (orthographic): straight up, it jumped a few pixels on every hill
    if (Math.abs(g - controls.target.y) > 2) { v1.subVectors(cam.position, controls.target); v1.multiplyScalar((g - controls.target.y) / v1.y); controls.target.add(v1); cam.position.add(v1) }
  }
  city?.emit('frame', dt, now / 1000)
  if (own?.camera.isPerspectiveCamera) { mats.tree.uniforms.cyl.value = 1; trees3d.update(own.camera) } else if (own) { mats.tree.uniforms.cyl.value = 0; trees3d.off() }
  // trees and building parts between a street-level camera and the player dissolve (materials.js occluder)
  const pl = own?.camera.isPerspectiveCamera && city?.player, oc = pl && OCCLUDER[pl.mode]
  if (oc) occluder.value.set(pl.x, pl.y + oc[0], pl.z, oc[1]); else occluder.value.w = 0
  updateShadows()
  if ((shadowStale || lampsStale) && now - lastShadow > 500) { if (shadowStale) renderer.shadowMap.needsUpdate = true; shadowStale = lampsStale = false; lastShadow = now; lightStale = true }
  trees3d.all(renderer.shadowMap.needsUpdate) // (every 3D tree casts its shadow; else only those in view are drawn)
  updateLights()
  if (shadowStale || lampsStale) dirty = true // come back for it
  draw()
  cpu = performance.now() - t0
}
requestAnimationFrame(loop)
document.addEventListener('visibilitychange', () => { dirty = true })

// ---------- plugins ----------
city = createCity({
  scene, overlay, camera: cam, renderer, controls, zAt, ll,
  toLatLon: (x, n) => ({ lat: LAT_O + n / KY, lon: LON_O + x / KX }),
  sun, hemi, setSun: (v) => { SUN.copy(v).normalize(); sh.x = NaN; dirty = true },
  post: { uniforms: { tint: ink.uniforms.tint, desat: ink.uniforms.desat }, lookFor: (el) => { lookFor(el); dirty = true } },
  requestRender: () => { dirty = true },
  data: {},
  tiles,
  night,
  late,
  surface,
  suppressBuildings: (ring) => tiles.addMask(ring.map(([lat, lon]) => ll(lat, lon))),
  ownCamera,
  quality,
})
window.city = city
// About → Graphics: Auto / High / Low
function showQuality() {
  for (const b of document.querySelectorAll('#gfx [data-q]')) b.setAttribute('aria-pressed', String(b.dataset.q === quality.setting))
  $('#gfx span').textContent = quality.setting === 'auto' ? `(${quality.tier.name})` : ''
}
for (const b of document.querySelectorAll('#gfx [data-q]')) b.onclick = () => { quality.set(b.dataset.q); showQuality() }
city.on('quality', showQuality); showQuality()
window.view = { cam, controls, setView, zAt, renderer, tiles, trees3d, setAA, quality, get res() { return res }, set res(v) { res = v; pinned = true } } // (res: tools pin the adaptive resolution)

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
tiles.rush = false
settle() // from now on frame times measure the GPU (adaptive resolution)
requestAnimationFrame(() => loadingEl.classList.add('done'))
setTimeout(() => loadingEl.remove(), 800)
$('#hint').hidden = false
// #perf: the frame rate (of frames drawn back to back: a still map draws none) and the adaptive resolution when it is
// down; while tiles stream in, how many of those in view are in, with a bar. Twice a second, never in the way
{
  const el = $('#perf'), fps = el.querySelector('.fps'), n = el.querySelector('.n'), bar = el.querySelector('.bar i')
  el.hidden = false
  setInterval(() => {
    const [got, want] = tiles.counts(), busy = got < want || tiles.made.length > 0 || tiles.warming.length > 0
    fps.textContent = `${Math.round(1000 / frameMs)} fps${res < 1 ? ` · ${Math.round(res * 100)}%` : ''}`
    el.classList.toggle('busy', busy)
    if (busy) { n.textContent = `${got}/${want}`; bar.style.width = `${Math.round((100 * got) / Math.max(1, want))}%` }
  }, 500)
}
loadPlugins(city)
