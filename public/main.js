import * as THREE from 'three'
import { MapControls } from './vendor/MapControls.js'

// World: isoworld's east-north-up metres (tools/bake.py); three.js x = east, y = up, z = south.
// The camera is theirs too (orthographic, looking north, 30° down, 6 drawing px per metre), so a
// view is shared with the Illustrated tab as #x,y,s in their drawing pixels.
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
let dirty = true // render on demand: only when the view, the cars or the window changed

const [meta, buf] = await Promise.all([fetch('meta.json').then((r) => r.json()), fetch('city.bin').then((r) => r.arrayBuffer())])
const texs = await Promise.all(meta.regions.map((r) => new THREE.TextureLoader().loadAsync(r.tex)))
status('Building the city…')
await new Promise(requestAnimationFrame)

const mobile = matchMedia('(pointer: coarse)').matches || innerWidth < 700
const renderer = new THREE.WebGLRenderer({ antialias: false, canvas: $('canvas'), powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap
renderer.shadowMap.autoUpdate = false
renderer.outputColorSpace = THREE.SRGBColorSpace
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0e1620)

const dv = new DataView(buf)
let o = 0
const u8 = () => dv.getUint8(o++)
const u16 = () => ((o += 2), dv.getUint16(o - 2, true))
const i16 = () => ((o += 2), dv.getInt16(o - 2, true))
const u32 = () => ((o += 4), dv.getUint32(o - 4, true))
const c = new THREE.Color()

// ---------- terrain ----------
const grids = meta.regions.map((r, i) => {
  o = r.zoff
  const nx = u16(), ny = u16(), z = new Int16Array(buf.slice(o, o + nx * ny * 2))
  o += nx * ny * 2
  return { ...r, nx, ny, z, tex: texs[i] }
})
const after = o
function zAt(x, y) {
  const g = grids.find((g) => x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1) || grids[0]
  const fx = Math.min(g.nx - 1.001, Math.max(0, (x - g.x0) / g.step)), fy = Math.min(g.ny - 1.001, Math.max(0, (y - g.y0) / g.step))
  const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j, Z = (a, b) => g.z[b * g.nx + a] / 10
  return Z(i, j) * (1 - u) * (1 - v) + Z(i + 1, j) * u * (1 - v) + Z(i, j + 1) * (1 - u) * v + Z(i + 1, j + 1) * u * v
}
// ground: one terrain mesh per 512 m tile. Zoomed out it shows the region texture (tree crowns
// painted in); zoomed in the region's plain texture, then the tile's own 0.5 m/px picture once loaded.
const tilesOf = []
for (const g of grids) {
  g.tex.colorSpace = THREE.SRGBColorSpace
  g.tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  const T = g.tile, have = new Set(g.tiles.map(([i, j]) => `${i}_${j}`)), SEG = 26
  for (let ti = Math.floor(g.x0 / T); ti <= Math.floor(g.x1 / T); ti++) for (let tj = Math.floor(g.y0 / T); tj <= Math.floor(g.y1 / T); tj++) {
    const x0 = Math.max(g.x0, ti * T), x1 = Math.min(g.x1, (ti + 1) * T), y0 = Math.max(g.y0, tj * T), y1 = Math.min(g.y1, (tj + 1) * T)
    if (x1 - x0 < 1 || y1 - y0 < 1) continue
    const pos = [], uv = [], uv1 = [], idx = []
    for (let j = 0; j <= SEG; j++) for (let i = 0; i <= SEG; i++) {
      const x = x0 + ((x1 - x0) * i) / SEG, y = y0 + ((y1 - y0) * j) / SEG
      pos.push(x, zAt(x, y), -y)
      uv.push((x - g.x0) / (g.x1 - g.x0), (y - g.y0) / (g.y1 - g.y0)); uv1.push((x - ti * T) / T, (y - tj * T) / T)
      if (i && j) { const a = j * (SEG + 1) + i; idx.push(a - SEG - 2, a - SEG - 1, a - 1, a - SEG - 1, a, a - 1) }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2))
    geo.setIndex(idx); geo.computeVertexNormals()
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: g.tex }))
    m.receiveShadow = true
    scene.add(m)
    tilesOf.push({ g, m, x0, x1, y0, y1, url: have.has(`${ti}_${tj}`) ? `tiles/${g.name}/${ti}_${tj}.webp` : null, tex: null, used: 0 })
  }
}
// textures decode off the main thread (createImageBitmap), so streaming tiles never stalls a frame
const bitmaps = new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY' })
const loader = {
  load(url, ok, _, fail) {
    const t = new THREE.Texture()
    t.flipY = false
    bitmaps.load(url, (b) => { t.image = b; t.needsUpdate = true; ok?.(t) }, undefined, fail)
    return t
  },
}
const MAXT = mobile ? 16 : 32
let loading = 0, frameNo = 0
function setMap(t, map) { if (t.m.material.map !== map) { t.m.material.map = map; t.m.material.needsUpdate = true } }
function groundFor(near) {
  frameNo++
  for (const g of grids) if (near && !g.plain) {
    g.plain = loader.load(g.tex.image.src.replace('.jpg', '-plain.jpg'), () => { dirty = true; groundFor(treeGroup.visible) })
    Object.assign(g.plain, { colorSpace: THREE.SRGBColorSpace, anisotropy: g.tex.anisotropy })
  }
  // what is on screen, on the ground: the view, stretched north for the 30° tilt, plus a margin for hills
  const t = controls.target, hw = innerWidth / 2 / (K * cam.zoom) + 120, hh = innerHeight / (K * cam.zoom) + 260
  const ex0 = t.x - hw, ex1 = t.x + hw, ny0 = -t.z - hh, ny1 = -t.z + hh
  for (const tile of tilesOf) {
    const seen = near && tile.x1 > ex0 && tile.x0 < ex1 && tile.y1 > ny0 && tile.y0 < ny1
    if (seen && tile.url && !tile.tex && loading < 6) {
      loading++
      tile.tex = loader.load(tile.url, (tx) => { loading--; if (tile.tex === tx) tile.ready = true; dirty = true; groundFor(treeGroup.visible) }, undefined, () => { loading--; tile.url = null; tile.tex = null })
      Object.assign(tile.tex, { colorSpace: THREE.SRGBColorSpace, anisotropy: g_aniso(), channel: 1 })
    }
    if (seen) tile.used = frameNo
    setMap(tile, seen && tile.ready && tile.tex ? tile.tex : near && tile.g.plain?.image ? tile.g.plain : tile.g.tex)
  }
  const held = tilesOf.filter((t) => t.tex)
  if (held.length > MAXT) for (const t of held.sort((a, b) => a.used - b.used).slice(0, held.length - MAXT)) {
    if (t.used === frameNo) break
    setMap(t, near && t.g.plain?.image ? t.g.plain : t.g.tex); t.tex.image?.close?.(); t.tex.dispose(); t.tex = null; t.ready = false
  }
}
const g_aniso = () => Math.min(8, renderer.capabilities.getMaxAnisotropy())

// ---------- light ----------
scene.add(new THREE.HemisphereLight(0xe8eef8, 0x8a8070, 2.0))
const sun = new THREE.DirectionalLight(0xfff1dc, 2.3)
const SUN = new THREE.Vector3(-0.55, 0.62, 0.56).normalize() // afternoon, from the south-west
sun.castShadow = true
sun.shadow.mapSize.setScalar(mobile ? 2048 : 4096)
sun.shadow.bias = -0.0005
sun.shadow.normalBias = 0.6
scene.add(sun, sun.target)

// ---------- chunks: everything is grouped by 600 m cells so the camera culls what is off screen ----------
const CH = 600
const chunks = new Map()
const chunk = (x, y) => { const k = `${Math.floor(x / CH)},${Math.floor(y / CH)}`; if (!chunks.has(k)) chunks.set(k, {}); return chunks.get(k) }

// ---------- buildings ----------
// Facade styles, chosen per building (vertex attribute aWin = style, distance along the walls, height
// above the ground, per-building seed): 0 plain, 1 punched windows, 2 curtain wall, 3 balcony slabs
// and glass, 4 punched windows over a glass storefront.
const HOUSE_WALL = [0xf2efe6, 0xe8e0cc, 0xd9d2c3, 0xc9d6dc, 0xb8c8d4, 0xe6d6a8, 0xb8c8a8, 0xd8a890, 0xf0e8d8, 0xa8b8c4, 0xe0c8b0]
const HOUSE_ROOF = [0x4a4f55, 0x5f6366, 0x6e6a66, 0x7a5a48, 0x3e4349, 0x8c4a3a, 0x9a5038, 0x52606a, 0x6b4d3c]
const LOW_WALL = [0xe8dcc4, 0xf0ece4, 0xd8c8a8, 0xe2ddd2, 0xc8c6c0, 0xe6d2b0, 0xd0b898, 0xc8d0d4]
const BRICK = [0xa8604a, 0x9a5442, 0xb57058, 0x8e4e3e, 0xb86a50]
const TOWER_FRAME = [0xf6f6f2, 0xf0f2f0, 0xe8eef0, 0xf2ece0, 0xeadcc0, 0xe4e6e6, 0xe8d0b0]
const FLAT_ROOF = [0xc4c6c4, 0xb4b8b8, 0xd2d0ca, 0xa8acae, 0xbcb8b0, 0x9ea4a8, 0x5a6068, 0x6a7078, 0x7c8288]
const nb = (o = after, u32())
const v3 = (x, y, z) => new THREE.Vector3(x, y, z)
const n_ = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3()
const ROOFW = (seed) => [0, 0, 999, seed] // roofs: no windows, no contact shadow
// one triangle with its own flat normal, wound so the normal points along `want`; w = per-vertex aWin
function tri(B, a, b, d, color, want, w) {
  n_.crossVectors(e1.subVectors(b, a), e2.subVectors(d, a)).normalize()
  let ws = w.length === 4 ? [w, w, w] : [w.slice(0, 4), w.slice(4, 8), w.slice(8, 12)]
  if (n_.dot(want) < 0) { [b, d] = [d, b]; n_.negate(); ws = [ws[0], ws[2], ws[1]] }
  for (const p of [a, b, d]) { B.pos.push(p.x, p.y, p.z); B.nor.push(n_.x * 127, n_.y * 127, n_.z * 127); B.col.push(color.r * 255, color.g * 255, color.b * 255) }
  for (const x of ws) B.win.push(...x)
}
function inPoly(x, z, pts) {
  let c = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j]
    if ((a.y > z) !== (b.y > z) && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) c = !c
  }
  return c
}
const units = [] // rooftop plant: x, y, z, sx, sy, sz, grey
const UP = v3(0, 1, 0)
for (let b = 0; b < nb; b++) {
  const n = u16(), base = i16() / 10, h = u16() / 10, mn = u16() / 10, k = u8(), pitched = u8()
  const pts = []
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector2(i16() / 2, -i16() / 2)) // (x, z)
  let roof = null
  if (pitched) roof = { cx: i16() / 2, cy: i16() / 2, a: i16() / 1000, hl: u16() / 10, hw: u16() / 10, ridge: u16() / 10 }
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse()
  let cx = 0, cz = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const p of pts) { cx += p.x / n; cz += p.y / n; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.y); z1 = Math.max(z1, p.y) }
  const B = chunk(cx, -cz).b ??= { pos: [], nor: [], col: [], win: [] }
  const seed = rand(), r = rand(), tower = h > 20
  let style, wall, roofHex
  if (tower) {
    style = k === 2 && r < 0.55 ? 2 : r < 0.15 ? 2 : r < 0.9 ? 3 : 1
    wall = style === 1 ? pick([...LOW_WALL, ...BRICK.slice(0, 2)]) : pick(TOWER_FRAME)
    roofHex = pick(FLAT_ROOF)
  } else if (k === 0) { // houses and small buildings
    style = h < 4 ? 0 : 1; wall = pick(HOUSE_WALL); roofHex = roof ? 0 : pick(FLAT_ROOF)
  } else if (k === 3) { style = 1; wall = pick(BRICK); roofHex = pick([0x8a7a70, 0x9a8a80, 0xb0aaa0]) }
  else if (k === 4 || k === 2) { style = h < 5 ? 0 : 4; wall = pick([...LOW_WALL, 0xb8c4cc, 0xd8d8d4, 0xc4a888]); roofHex = pick(FLAT_ROOF) }
  else { style = h > 9 && r < 0.4 ? 3 : 1; wall = pick([...LOW_WALL, ...TOWER_FRAME]); roofHex = pick(FLAT_ROOF) }
  const wallC = new THREE.Color(wall).offsetHSL(0, 0, (rand() - 0.5) * 0.05)
  const roofC = new THREE.Color(roofHex || 0).offsetHSL(0, 0, (rand() - 0.5) * 0.05)
  const y0 = base + mn, y1 = base + h
  const flat = !roof
  const par = flat && h >= 5 && n <= 80 ? (tower ? 1.2 : 0.8) : 0 // parapet
  let u = 0
  for (let i = 0; i < n; i++) {
    const a = pts[i], p = pts[(i + 1) % n]
    const len = Math.hypot(p.x - a.x, p.y - a.y) || 1
    const out = v3((p.y - a.y) / len, 0, -(p.x - a.x) / len)
    const A = v3(a.x, y0, a.y), P = v3(p.x, y0, p.y), Pt = v3(p.x, y1, p.y), At = v3(a.x, y1, a.y)
    const w = (uu, yy) => [style, uu, yy - base, seed]
    tri(B, A, P, Pt, wallC, out, [...w(u, y0), ...w(u + len, y0), ...w(u + len, y1)])
    tri(B, A, Pt, At, wallC, out, [...w(u, y0), ...w(u + len, y1), ...w(u, y1)])
    if (par) { // the outside of the parapet in the wall's colour, its inside in shade
      const Pp = v3(p.x, y1 + par, p.y), Ap = v3(a.x, y1 + par, a.y), pw = ROOFW(seed), inC = c.copy(roofC).multiplyScalar(0.72).clone()
      tri(B, At, Pt, Pp, wallC, out, pw); tri(B, At, Pp, Ap, wallC, out, pw)
      const inn = out.clone().negate()
      tri(B, At, Pt, Pp, inC, inn, pw); tri(B, At, Pp, Ap, inC, inn, pw)
    }
    u += len
  }
  if (flat) {
    const top = pts.map((p) => v3(p.x, y1, p.y))
    for (const [a, bb, cc] of THREE.ShapeUtils.triangulateShape(pts, [])) tri(B, top[a], top[bb], top[cc], roofC, UP, ROOFW(seed))
    if (h > 18 && n >= 4) { // a plant room on top of the taller buildings
      const pk = pts.map((p) => new THREE.Vector2(cx + (p.x - cx) * 0.38, cz + (p.y - cz) * 0.38)), y2 = y1 + 3 + rand() * 2.5
      const pc = new THREE.Color(rand() < 0.5 ? wall : roofHex).offsetHSL(0, 0, 0.04)
      for (let i = 0; i < pk.length; i++) { // (triangulateShape may have dropped a repeated last point)
        const a = pk[i], p = pk[(i + 1) % pk.length], len = Math.hypot(p.x - a.x, p.y - a.y) || 1, out = v3((p.y - a.y) / len, 0, -(p.x - a.x) / len)
        tri(B, v3(a.x, y1, a.y), v3(p.x, y1, p.y), v3(p.x, y2, p.y), pc, out, ROOFW(seed)); tri(B, v3(a.x, y1, a.y), v3(p.x, y2, p.y), v3(a.x, y2, a.y), pc, out, ROOFW(seed))
      }
      for (const [a, bb, cc] of THREE.ShapeUtils.triangulateShape(pk, [])) tri(B, v3(pk[a].x, y2, pk[a].y), v3(pk[bb].x, y2, pk[bb].y), v3(pk[cc].x, y2, pk[cc].y), roofC.clone().offsetHSL(0, 0, 0.06), UP, ROOFW(seed))
    }
    // rooftop units (air handlers, vents) scattered over flat roofs
    const area = (x1 - x0) * (z1 - z0)
    if (h >= 4 && area > 120) {
      const want = Math.min(7, Math.round(area / 260) + (rand() < 0.5 ? 1 : 0))
      for (let t = 0, got = 0; t < want * 4 && got < want; t++) {
        const ux = x0 + rand() * (x1 - x0), uz = z0 + rand() * (z1 - z0), sx = 1.4 + rand() * 3, sz = 1.2 + rand() * 2.2
        if (!inPoly(ux, uz, pts) || !inPoly(ux + sx, uz, pts) || !inPoly(ux - sx, uz, pts) || !inPoly(ux, uz + sz, pts) || !inPoly(ux, uz - sz, pts)) continue
        if (h > 18 && Math.hypot(ux - cx, uz - cz) < 0.45 * Math.min(x1 - x0, z1 - z0)) continue // the plant room is there
        units.push(ux, y1, uz, sx, 0.8 + rand() * 1.4, sz, 0.75 + rand() * 0.25); got++
      }
    }
    continue
  }
  // pitched roof over the footprint's rectangle: gable along the long side, hipped when it is near square
  const { cx: rx, cy: ry, a, hl, hw, ridge } = roof, O = 0.45 // eave overhang
  const ax = v3(Math.cos(a), 0, -Math.sin(a)), bx = v3(-Math.sin(a), 0, -Math.cos(a))
  const C = v3(rx, 0, -ry), at = (s, t, y) => C.clone().addScaledVector(ax, s).addScaledVector(bx, t).setY(y)
  const yr = base + ridge, L = hl + O, Wd = hw + O, gable = hl / hw > 1.15, rr = gable ? L : Math.max(0.01, L - Wd)
  const rc = new THREE.Color(pick(HOUSE_ROOF)).offsetHSL(0, 0, (rand() - 0.5) * 0.08)
  for (const s of [1, -1]) {
    const side = bx.clone().multiplyScalar(s).add(UP)
    tri(B, at(-L, s * Wd, y1), at(L, s * Wd, y1), at(rr, 0, yr), rc, side, ROOFW(seed))
    tri(B, at(-L, s * Wd, y1), at(rr, 0, yr), at(-rr, 0, yr), rc, side, ROOFW(seed))
    const end = ax.clone().multiplyScalar(s)
    if (gable) tri(B, at(s * hl, Wd, y1), at(s * hl, -Wd, y1), at(s * hl, 0, yr), wallC, end, ROOFW(seed))
    else tri(B, at(s * L, Wd, y1), at(s * L, -Wd, y1), at(s * rr, 0, yr), rc, end.clone().add(UP), ROOFW(seed))
  }
}
const bmat = new THREE.MeshLambertMaterial({ vertexColors: true })
bmat.onBeforeCompile = (s) => {
  s.vertexShader = s.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 aWin;\nvarying vec4 vWin;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWin = aWin;')
  // every pattern fades to its average colour once a floor is under ~3 px tall, so it never shimmers
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', `#include <common>
      varying vec4 vWin;
      vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); } // colours below are picked as on screen; lighting is linear
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float thin(float width, float fw) { return smoothstep(0.6, 1.3, width / fw); } // 1 while a feature is over ~a pixel wide
      float box(vec2 f, vec2 lo, vec2 hi, vec2 fw) { vec2 a = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f)); return a.x * a.y; }`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      float style = vWin.x, seed = vWin.w, z = vWin.z;
      vec3 base = diffuseColor.rgb;
      // glass colour per building: teal, blue, sea green, deep blue
      vec3 glassC = srgb(seed < 0.45 ? vec3(0.42, 0.72, 0.78) : seed < 0.65 ? vec3(0.42, 0.60, 0.78) : seed < 0.85 ? vec3(0.40, 0.70, 0.66) : vec3(0.30, 0.46, 0.62));
      if (style > 0.5) {
        vec3 pat, avg;
        if (style > 2.5 && style < 3.5) { // balconies: a light slab, its shadow, then glass between mullions; some bays solid
          // every feature fades to its own coverage once it is thinner than a pixel, so nothing sub-pixel can shimmer
          vec2 g = vec2(vWin.y / 3.2, z / 3.0), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
          float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
          float bay = floor(vWin.y / 4.5), solid = step(0.72, hash(vec2(bay, seed * 91.0)));
          float slab = mix(0.36, 1.0 - smoothstep(0.36 - fw.y, 0.36 + fw.y, f.y), thin(0.36, fw.y));
          float shadeL = (1.0 - smoothstep(0.36 - fw.y, 0.36 + fw.y, f.y)) * 0.0 + smoothstep(0.36 - fw.y, 0.36 + fw.y, f.y) * (1.0 - smoothstep(0.44 - fw.y, 0.44 + fw.y, f.y));
          float shade = mix(0.08, shadeL, thin(0.08, fw.y));
          float mull = mix(0.04, 1.0 - smoothstep(0.04 - fw.x, 0.04 + fw.x, f.x), thin(0.04, fw.x));
          vec3 glass = glassC * (0.85 + 0.45 * mix(0.7, f.y, thin(0.5, fw.y)));
          vec2 g2 = vec2(vWin.y / 2.25, z / 3.0), fw2 = max(fwidth(g2), vec2(1e-4));
          vec3 wallBay = mix(base, glassC * 0.8, mix(0.19, box(fract(g2), vec2(0.3, 0.38), vec2(0.7, 0.86), fw2 * 1.5), thin(0.4, max(fw2.x, fw2.y))) * 0.85);
          pat = mix(mix(glass, base, mull), wallBay, solid);
          pat = mix(pat, glassC * 0.45, shade);
          pat = mix(pat, min(base * 1.12, vec3(1.0)), slab);
          avg = mix(glassC * 0.9, base * 1.1, 0.48);
          diffuseColor.rgb = mix(avg, pat, detail);
        } else if (style > 1.5 && style < 2.5) { // curtain wall: light frame grid, glass brighter towards each floor's top
          vec2 g = vec2(vWin.y / 1.6, z / 3.4), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
          float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
          vec2 lo = vec2(0.13, 0.26);
          float ix = mix(0.87, smoothstep(lo.x - fw.x, lo.x + fw.x, f.x), thin(lo.x, fw.x));
          float iy = mix(0.74, smoothstep(lo.y - fw.y, lo.y + fw.y, f.y), thin(lo.y, fw.y));
          vec3 glass = glassC * (0.72 + 0.45 * mix(0.6, f.y, thin(0.5, fw.y)) + 0.06 * sin(vWin.y * 0.05 + z * 0.02));
          pat = mix(base, glass, ix * iy);
          avg = mix(base, glassC * 0.95, 0.64);
          diffuseColor.rgb = mix(avg, pat, detail);
        } else { // punched windows; style 4 adds a storefront on the ground floor
          vec2 g = vec2(vWin.y / 3.0, z / 3.2), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
          float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
          vec3 glass = srgb(vec3(0.40, 0.52, 0.62)) * (0.8 + 0.35 * f.y);
          float w = box(f, vec2(0.28, 0.3), vec2(0.78, 0.84), fw);
          pat = mix(base, glass, w * 0.9);
          pat = mix(pat, base * 0.82, mix(0.02, box(f, vec2(0.28, 0.26), vec2(0.78, 0.3), fw), thin(0.04, fw.y)) * 0.8); // sill
          avg = mix(base, glass, 0.25 * 0.9);
          vec3 col = mix(avg, pat, detail);
          if (style > 3.5 && z < 4.2) { // storefront: glass in a dark frame under a light sign band
            vec2 sg = vec2(vWin.y / 2.6, z / 4.2), sfw = max(fwidth(sg), vec2(1e-4)), sf = fract(sg);
            float sdet = clamp(1.6 - 2.5 * max(sfw.x, sfw.y), 0.0, 1.0);
            vec3 shop = mix(srgb(vec3(0.16, 0.2, 0.24)), glassC * 0.9, box(sf, vec2(0.06, 0.05), vec2(0.94, 0.72), sfw));
            shop = mix(shop, min(base * 1.12, vec3(1.0)), step(0.8, sf.y));
            col = mix(mix(srgb(vec3(0.3, 0.38, 0.44)), base, 0.2), shop, sdet);
          }
          diffuseColor.rgb = col;
        }
      }
      // contact shadow where walls meet the ground
      diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.0, 5.0, z));`)
}
for (const ch of chunks.values()) {
  const B = ch.b; if (!B) continue
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(B.nor), 3, true))
  g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(B.col), 3, true))
  g.setAttribute('aWin', new THREE.Float32BufferAttribute(B.win, 4))
  const m = new THREE.Mesh(g, bmat)
  m.castShadow = m.receiveShadow = true
  scene.add(m)
  delete ch.b
}
const roofUnits = (() => {
  const n = units.length / 7, m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshLambertMaterial(), n)
  const mm = new THREE.Matrix4()
  for (let i = 0; i < n; i++) {
    const [x, y, z, sx, sy, sz, g] = units.slice(i * 7, i * 7 + 7)
    m.setMatrixAt(i, mm.makeScale(sx, sy, sz).setPosition(x, y, z)); m.setColorAt(i, c.setRGB(g * 0.92, g * 0.95, g))
  }
  m.computeBoundingSphere(); m.castShadow = m.receiveShadow = true
  scene.add(m)
  return m
})()

// ---------- trees: painted billboards (the camera never changes its tilt, so a flat picture reads as a tree),
// drawn when zoomed in; zoomed out their crowns are painted into the ground ----------
const nt = u32()
const treeGroup = new THREE.Group()
const ATL = 256, atlas = document.createElement('canvas')
atlas.width = ATL * 4; atlas.height = ATL * 2
{ // 6 broadleaf and 2 conifer pictures in grey, tinted per tree: leaf clumps lit from the upper left
  const g2 = atlas.getContext('2d'), RIM = 'rgba(16,24,14,0.85)'
  const grey = (l) => `rgb(${255 * l},${255 * l},${255 * l})`
  for (let v = 0; v < 8; v++) {
    const ox = (v % 4) * ATL, oy = Math.floor(v / 4) * ATL, r = mulberry(v + 11)
    const X = (x) => ox + x * ATL, Y = (y) => oy + y * ATL
    g2.fillStyle = '#4a3a2e'; g2.fillRect(X(0.47), Y(0.72), ATL * 0.06, ATL * 0.27)
    if (v < 6) {
      // the crown's outline: a few big lobes; then many small clumps inside it, shaded by where they sit
      const lobes = []
      for (let i = 0; i < 7; i++) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.17; lobes.push([0.5 + Math.cos(a) * d, 0.44 + Math.sin(a) * d * 0.85, 0.2 + r() * 0.06]) }
      g2.fillStyle = RIM
      for (const [x, y, rr] of lobes) { g2.beginPath(); g2.arc(X(x), Y(y), (rr + 0.012) * ATL, 0, 7); g2.fill() }
      g2.save(); g2.beginPath()
      for (const [x, y, rr] of lobes) { g2.moveTo(X(x) + rr * ATL, Y(y)); g2.arc(X(x), Y(y), rr * ATL, 0, 7) }
      g2.clip()
      g2.fillStyle = grey(0.42); g2.fillRect(ox, oy, ATL, ATL)
      const clumps = []
      for (let i = 0; i < 70; i++) clumps.push([0.18 + r() * 0.64, 0.12 + r() * 0.62, 0.035 + r() * 0.045])
      clumps.sort((a, b) => a[1] - b[1])
      for (const [x, y, rr] of clumps) {
        const light = Math.max(0.35, Math.min(1, 1.15 - (y - 0.15) * 0.9 - (x - 0.3) * 0.5)) // top-left lit, bottom-right in shade
        g2.fillStyle = grey(light * 0.62); g2.beginPath(); g2.arc(X(x + rr * 0.15), Y(y + rr * 0.2), rr * ATL, 0, 7); g2.fill()
        g2.fillStyle = grey(light); g2.beginPath(); g2.arc(X(x), Y(y), rr * 0.82 * ATL, 0, 7); g2.fill()
      }
      g2.restore()
    } else {
      const tiers = 7
      for (let i = 0; i < tiers; i++) {
        const y0 = 0.03 + i * 0.11, y1 = y0 + 0.24 + i * 0.015, w = 0.08 + i * 0.05
        g2.fillStyle = RIM; g2.beginPath(); g2.moveTo(X(0.5), Y(y0 - 0.012)); g2.lineTo(X(0.5 + w + 0.012), Y(y1 + 0.006)); g2.lineTo(X(0.5 - w - 0.012), Y(y1 + 0.006)); g2.closePath(); g2.fill()
        const gr = g2.createLinearGradient(X(0.5 - w), 0, X(0.5 + w), 0), l = 1 - i * 0.04
        gr.addColorStop(0, grey(0.95 * l)); gr.addColorStop(0.5, grey(0.7 * l)); gr.addColorStop(1, grey(0.42 * l))
        g2.fillStyle = gr; g2.beginPath(); g2.moveTo(X(0.5), Y(y0)); g2.lineTo(X(0.5 + w), Y(y1)); g2.lineTo(X(0.5 - w), Y(y1)); g2.closePath(); g2.fill()
      }
    }
  }
}
const atlasTex = new THREE.CanvasTexture(atlas)
atlasTex.colorSpace = THREE.SRGBColorSpace
atlasTex.anisotropy = 4
const treeMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: atlasTex }, sat: { value: 1.2 }, gain: { value: new THREE.Vector3(1, 1, 1) } },
  vertexShader: `attribute vec3 iPos; attribute vec2 iSize; attribute vec3 iCol; attribute float iVar;
    varying vec2 vUv; varying vec3 vCol;
    void main() {
      float row = floor(iVar / 4.0);
      vUv = vec2((mod(iVar, 4.0) + uv.x) / 4.0, (uv.y + 1.0 - row) / 2.0);
      vCol = iCol;
      vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
      mv.xy += position.xy * iSize;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `uniform sampler2D map; uniform float sat; uniform vec3 gain; varying vec2 vUv; varying vec3 vCol;
    void main() {
      vec4 t = texture2D(map, vUv);
      if (t.a < 0.04) discard;
      vec3 cc = vCol * t.rgb * 1.3;
      cc = max(mix(vec3(dot(cc, vec3(0.2126, 0.7152, 0.0722))), cc, sat), 0.0) * gain;
      gl_FragColor = vec4(cc, t.a);
      #include <colorspace_fragment>
    }`,
  transparent: true, // drawn after the ink pass, far to near, against the scene's depth (see draw)
})
const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)
const tlists = new Map()
for (let i = 0; i < nt; i++) {
  const x = i16() / 2, y = i16() / 2, z = i16() / 10, k = u8(), col = u8(), h = u8() / 4
  const key = `${Math.floor(x / CH)},${Math.floor(y / CH)}`
  if (!tlists.has(key)) tlists.set(key, [])
  tlists.get(key).push([x, y, z, k, col, h])
}
for (const [key, list] of tlists) {
  list.sort((a, b) => b[1] * 0.866 - b[2] * 0.5 - (a[1] * 0.866 - a[2] * 0.5)) // far (north, low) first
  const n = list.length, P = new Float32Array(n * 3), S = new Float32Array(n * 2), C = new Float32Array(n * 3), V = new Float32Array(n)
  let lo = Infinity, hi = -Infinity
  list.forEach(([x, y, z, k, col, h], i) => {
    const conif = k === 5, r = conif ? Math.max(2.2, h * 0.24) : Math.min(11, Math.max(3.6, h * 0.48))
    P.set([x, z, -y], i * 3)
    S.set([conif ? r * 2.6 : r * 2.5, h * 0.866 * (conif ? 1.05 : 1.08)], i * 2)
    c.set(meta.treePal[col]).offsetHSL(0, 0, (rand() - 0.5) * 0.06); C.set([c.r, c.g, c.b], i * 3)
    V[i] = conif ? 6 + (rand() * 2 | 0) : rand() * 6 | 0
    lo = Math.min(lo, z); hi = Math.max(hi, z + h)
  })
  const g = new THREE.InstancedBufferGeometry().copy(quad)
  g.instanceCount = n
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(P, 3)); g.setAttribute('iSize', new THREE.InstancedBufferAttribute(S, 2))
  g.setAttribute('iCol', new THREE.InstancedBufferAttribute(C, 3)); g.setAttribute('iVar', new THREE.InstancedBufferAttribute(V, 1))
  const [cx, cy] = key.split(',').map((v) => (+v + 0.5) * CH)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, (lo + hi) / 2, -cy), CH * 0.75 + (hi - lo))
  const mesh = new THREE.Mesh(g, treeMat)
  mesh.renderOrder = -cy // chunks further north first
  treeGroup.add(mesh)
}
treeGroup.visible = false
const treeScene = new THREE.Scene()
treeScene.add(treeGroup)
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), tp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)

// ---------- boats: pointed white hulls with a cabin, a mast on the sailboats ----------
const nbo = u32()
const hullShape = new THREE.Shape([[-0.5, -0.16], [0.28, -0.16], [0.5, 0], [0.28, 0.16], [-0.5, 0.16]].map(([x, y]) => new THREE.Vector2(x, y)))
const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 1, bevelEnabled: false }).rotateX(-Math.PI / 2)
const cabinGeo = new THREE.BoxGeometry(0.34, 0.9, 0.2).translate(-0.06, 1.45, 0)
const hulls = new THREE.InstancedMesh(hullGeo, new THREE.MeshLambertMaterial(), nbo)
const cabins = new THREE.InstancedMesh(cabinGeo, new THREE.MeshLambertMaterial({ color: 0xdfe4e8 }), nbo)
const mastM = []
for (let i = 0; i < nbo; i++) {
  const x = i16() / 2, y = i16() / 2, z = i16() / 10, a = i16() / 1000, L = u8() / 10
  q.setFromAxisAngle(up, a)
  m4.compose(tp.set(x, z, -y), q, sc.set(L, 1.1, L)); hulls.setMatrixAt(i, m4); cabins.setMatrixAt(i, m4)
  hulls.setColorAt(i, c.set(rand() < 0.86 ? 0xf6f6f2 : pick([0x2a4d7a, 0xb03a2e, 0x333840])))
  if (rand() < 0.4) mastM.push(new THREE.Matrix4().makeTranslation(x, z + 1 + L * 0.55, -y).multiply(new THREE.Matrix4().makeScale(0.3, L * 1.1, 0.3)))
}
const masts = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xe8e8e4 }), mastM.length)
mastM.forEach((m, i) => masts.setMatrixAt(i, m))
for (const m of [hulls, cabins, masts]) { m.computeBoundingSphere(); m.castShadow = true; scene.add(m) }
const boatDetail = [cabins, masts, roofUnits] // sub-pixel zoomed out, where they would only shimmer

// ---------- bridges ----------
const nbr = u32()
const deck = [], deckIdx = [], pillars = []
for (let i = 0; i < nbr; i++) {
  const n = u16(), w = Math.max(3, (u8() / 10) * 2.6)
  const p = []
  for (let j = 0; j < n; j++) p.push([i16() / 2, -i16() / 2, i16() / 10])
  let lastPillar = -1e9, along = 0
  for (let j = 0; j < n; j++) {
    const a = p[Math.max(0, j - 1)], b = p[Math.min(n - 1, j + 1)]
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1
    const sx = (-dz / l) * w / 2, sz = (dx / l) * w / 2
    const [x, z, y] = p[j]
    const base = deck.length / 3
    deck.push(x - sx, y + 0.3, z - sz, x + sx, y + 0.3, z + sz, x - sx, y - 1.1, z - sz, x + sx, y - 1.1, z + sz)
    if (j) {
      const pb = base - 4
      deckIdx.push(pb, base, pb + 1, pb + 1, base, base + 1, pb, pb + 2, base, base, pb + 2, base + 2, pb + 1, base + 1, pb + 3, pb + 3, base + 1, base + 3)
      along += Math.hypot(x - p[j - 1][0], z - p[j - 1][1])
    }
    const g = zAt(x, -z)
    if (y - g > 5 && along - lastPillar > 45) { pillars.push([x, z, g, y - 1.1 - g, w]); lastPillar = along }
  }
}
const dg = new THREE.BufferGeometry()
dg.setAttribute('position', new THREE.Float32BufferAttribute(deck, 3))
dg.setIndex(deckIdx); dg.computeVertexNormals()
const concrete = new THREE.MeshLambertMaterial({ color: 0xc9c6bd, side: THREE.DoubleSide })
const deckMesh = new THREE.Mesh(dg, concrete)
deckMesh.castShadow = deckMesh.receiveShadow = true
scene.add(deckMesh)
const pil = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), concrete, pillars.length)
pillars.forEach(([x, z, g, h, w], i) => pil.setMatrixAt(i, m4.compose(tp.set(x, g, z), q.identity(), sc.set(Math.min(w * 0.6, 8), h, 2.5))))
pil.computeBoundingSphere()
pil.castShadow = true
scene.add(pil)

// ---------- roads (for traffic): per piece [from, to, class, oneway, lanes, first point, points], points x,y,z ----------
const nNodes = u32(), np = u32(), rmeta = new Int32Array(np * 7), rpts = []
for (let i = 0; i < np; i++) {
  const a = u32(), b = u32(), cls = u8(), ow = u8(), per = u8(), n = u16()
  rmeta.set([a, b, cls, ow, per, rpts.length / 3, n], i * 7)
  for (let j = 0; j < n; j++) rpts.push(i16() / 2, i16() / 2, i16() / 10)
}
const roads = { nNodes, meta: rmeta, pts: new Float32Array(rpts) }

// ---------- landmarks ----------
const white = new THREE.MeshLambertMaterial({ color: 0xf2f2ee })
const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; scene.add(m); return m }
if (meta.bcplace) {
  const [x, y, r] = meta.bcplace, z = -y, g = zAt(x, y)
  add(new THREE.CylinderGeometry(r * 0.95, r, 30, 48), new THREE.MeshLambertMaterial({ color: 0xbfc3c4 }), x, g + 15, z)
  add(new THREE.SphereGeometry(r * 0.92, 48, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.28, 1), white, x, g + 30, z)
  const mast = new THREE.CylinderGeometry(0.8, 0.8, 22)
  for (let i = 0; i < 36; i++) { const a = (i / 36) * Math.PI * 2; add(mast, white, x + Math.cos(a) * r * 0.98, g + 41, z + Math.sin(a) * r * 0.98) }
}
if (meta.scienceworld) {
  const [x, y] = meta.scienceworld, g = zAt(x, y)
  add(new THREE.CylinderGeometry(20, 22, 14, 24), new THREE.MeshLambertMaterial({ color: 0xa8b0b4 }), x, g + 7, -y)
  add(new THREE.IcosahedronGeometry(23, 2), new THREE.MeshLambertMaterial({ color: 0xd6dcde, flatShading: true }), x, g + 35, -y)
}
const ll = (lat, lon) => [(lon - meta.origin[1]) * meta.k[0], (lat - meta.origin[0]) * meta.k[1]]
{ // Canada Place: pier, five sails and two cruise ships
  const [ax, ay] = ll(49.2880, -123.1144), [bx, by] = ll(49.2896, -123.1078), sea = zAt(ax, ay)
  const pl = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / pl, uz = -(by - ay) / pl, az = -ay
  for (const [side, at, len] of [[-1, 0.45, 290], [1, 0.55, 265]]) {
    const x = ax + ux * pl * at + uz * side * 88, z = az + uz * pl * at - ux * side * 88
    const ship = new THREE.Group()
    const parts = [[34, 14, len, 7, 0, 0x1d2a3a], [32, 22, len * 0.82, 25, -len * 0.04, 0xf2f2ee], [26, 10, len * 0.55, 41, -len * 0.06, 0xf2f2ee], [8, 12, 16, 52, len * 0.12, 0x2b4a7a]]
    for (const [w, h, l, y, zz, col] of parts) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l).translate(0, y, zz), col === 0xf2f2ee ? white : new THREE.MeshLambertMaterial({ color: col }))
      m.castShadow = m.receiveShadow = true; ship.add(m)
    }
    ship.position.set(x, sea, z); ship.rotation.y = Math.atan2(ux, uz)
    scene.add(ship)
  }
  for (let i = 0; i < 5; i++) {
    const t = 0.62 + i * 0.07, x = ax + ux * pl * t, z = az + uz * pl * t
    add(new THREE.ConeGeometry(14, 30, 4), white, x + uz * (i % 2 ? 12 : -12), sea + 38, z - ux * (i % 2 ? 12 : -12))
  }
}

// ---------- traffic: simulated in a worker, drawn as instances placed in the vertex shader ----------
const CARS = mobile ? 2600 : 5200
const carGeo = (() => {
  const body = new THREE.BoxGeometry(1, 0.5, 1).translate(0, 0.25, 0)
  const cab = new THREE.BoxGeometry(0.55, 0.5, 0.86).translate(-0.06, 0.75, 0)
  const g = new THREE.InstancedBufferGeometry()
  const pos = [...body.toNonIndexed().getAttribute('position').array, ...cab.toNonIndexed().getAttribute('position').array]
  const nor = [...body.toNonIndexed().getAttribute('normal').array, ...cab.toNonIndexed().getAttribute('normal').array]
  const nBody = body.toNonIndexed().getAttribute('position').count
  const win = []
  for (let i = 0; i < pos.length / 3; i++) win.push(i >= nBody && nor[i * 3 + 1] < 0.5 ? 1 : 0) // cabin sides are glass
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('aGlass', new THREE.Float32BufferAttribute(win, 1))
  return g
})()
const iPos = new THREE.InstancedBufferAttribute(new Float32Array(CARS * 4), 4)
const iSize = new THREE.InstancedBufferAttribute(new Float32Array(CARS * 3), 3)
const iCol = new THREE.InstancedBufferAttribute(new Float32Array(CARS * 3), 3)
const TYPES = [[4.5, 1.8, 1.45, 0.62], [4.9, 1.95, 1.75, 0.24], [5.6, 2.0, 2.2, 0.1], [3.8, 1.7, 1.4, 0.04]]
const CCOL = [0xf3f2ec, 0xc4c8cd, 0x2b2f35, 0xc23a2f, 0x2f5ea6, 0x5b6068, 0x22345a, 0x3f7a4b, 0xf0c232, 0xd6ccb4, 0x8b2533, 0xecebe5, 0x9aa1aa]
const carLen = new Float32Array(CARS)
for (let i = 0; i < CARS; i++) {
  let r = rand(), t = TYPES[0]
  for (const ty of TYPES) { r -= ty[3]; if (r <= 0) { t = ty; break } }
  iSize.setXYZ(i, t[0], t[2], t[1]); carLen[i] = t[0]
  c.set(pick(CCOL)); iCol.setXYZ(i, c.r, c.g, c.b)
}
carGeo.setAttribute('iPos', iPos); carGeo.setAttribute('iSize', iSize); carGeo.setAttribute('iCol', iCol)
carGeo.instanceCount = 0
const carMat = new THREE.MeshLambertMaterial()
carMat.onBeforeCompile = (s) => {
  s.vertexShader = s.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 iPos;\nattribute vec3 iSize;\nattribute vec3 iCol;\nattribute float aGlass;\nvarying vec3 vCar;')
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nfloat cs = cos(iPos.w), sn = sin(iPos.w);\nobjectNormal = vec3(cs * objectNormal.x + sn * objectNormal.z, objectNormal.y, -sn * objectNormal.x + cs * objectNormal.z);')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed *= iSize;\ntransformed = vec3(cs * transformed.x + sn * transformed.z, transformed.y, -sn * transformed.x + cs * transformed.z) + iPos.xyz;\nvCar = mix(iCol, vec3(0.16, 0.2, 0.26), aGlass);')
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCar;')
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vCar;')
}
const cars = new THREE.Mesh(carGeo, carMat)
cars.frustumCulled = false
cars.receiveShadow = true
scene.add(cars)
const traffic = new Worker('code-traffic.js')
traffic.postMessage({ roads, cars: CARS, len: carLen, seed: 1 })
traffic.onmessage = ({ data }) => {
  iPos.array.set(data); iPos.needsUpdate = true
  carGeo.instanceCount = data.length / 4
  if (cars.visible) dirty = true
}

// ---------- camera: isoworld's ----------
const K = 6, BX = 23551.5, BY = 9727.5, DW = 26624, DH = 21504 // their drawing: px per metre, origin, size
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 100, 16000)
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
controls.minZoom = 0.015
controls.maxZoom = 4
controls.maxPolarAngle = 1.3
controls.minPolarAngle = 0.15
function setView(X, Y, s) { // their drawing px at the screen centre, CSS px per drawing px
  const E = (X - BX) / K, N = (BY - Y) / (K * VIEW.y)
  controls.target.set(E, 0, -N)
  cam.position.copy(controls.target).addScaledVector(VIEW, 8000)
  cam.zoom = s; cam.updateProjectionMatrix(); controls.update()
}
function fromHash() {
  const [x, y, s] = location.hash.slice(1).split(',').map(Number)
  if ([x, y, s].every(Number.isFinite) && s > 0) { setView(x, y, s); return true }
}
if (!fromHash()) { // as the Illustrated tab opens: the whole central drawing
  const a = innerWidth / innerHeight
  setView(DW / 2, DH / 2, mobile && innerWidth < 600 ? (a < DW / DH ? innerHeight / DH : innerWidth / DW) : Math.min(innerWidth / DW, innerHeight / DH))
}
fit()
addEventListener('resize', fit)
queueMicrotask(() => onView()) // the tab links carry the view from the start
addEventListener('hashchange', () => { fromHash(); dirty = true })
let hashT = 0
function onView() {
  clearTimeout(hashT)
  hashT = setTimeout(() => {
    const t = controls.target, h = `#${Math.round(t.x * K + BX)},${Math.round(BY + t.z * K * VIEW.y)},${cam.zoom.toFixed(4)}`
    history.replaceState(null, '', h)
    for (const a of document.querySelectorAll('.tabs a')) a.hash = h
  }, 150)
}
// keep the camera over the map
const lo = new THREE.Vector3(Math.min(...grids.map((g) => g.x0)), 0, -Math.max(...grids.map((g) => g.y1)))
const hi = new THREE.Vector3(Math.max(...grids.map((g) => g.x1)), 0, -Math.min(...grids.map((g) => g.y0)))
controls.addEventListener('change', () => {
  const t = controls.target, cl = t.clone().clamp(lo, hi)
  if (!cl.equals(t)) { cam.position.add(cl.clone().sub(t)); t.copy(cl) }
  dirty = true
  onView()
})

// shadows: a sharp shadow map over what is on screen, redrawn only when the view moves past it
const sh = { x: NaN, z: 0, r: 0 }
function updateShadows() {
  const r = Math.hypot(innerWidth, innerHeight * 2) / K / cam.zoom / 2 + 60
  const t = controls.target
  if (Math.hypot(t.x - sh.x, t.z - sh.z) < sh.r * 0.35 && r < sh.r && r > sh.r * 0.4) return
  sh.x = t.x; sh.z = t.z; sh.r = r * 1.5
  // snapped to whole shadow texels so the shadows do not crawl, with the bias scaled to the texel
  const texel = (2 * sh.r) / sun.shadow.mapSize.x, sx = Math.round(t.x / texel) * texel, sz = Math.round(t.z / texel) * texel
  sun.shadow.normalBias = texel * 1.2
  sun.target.position.set(sx, 0, sz)
  sun.position.copy(sun.target.position).addScaledVector(SUN, 6000)
  Object.assign(sun.shadow.camera, { left: -sh.r, right: sh.r, top: sh.r, bottom: -sh.r, near: 10, far: 12000 })
  sun.shadow.camera.updateProjectionMatrix()
  renderer.shadowMap.needsUpdate = true
}

// ink: the scene renders into a multisampled target, then edges in its depth (where the second
// derivative jumps: silhouettes and creases, never flat or sloped faces) are drawn as dark lines
const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType })
rt.depthTexture = new THREE.DepthTexture(1, 1)
const ink = new THREE.ShaderMaterial({
  uniforms: { tColor: { value: rt.texture }, tDepth: { value: rt.depthTexture }, sat: { value: 1.2 }, gain: { value: new THREE.Vector3(1, 1, 1) }, px: { value: new THREE.Vector2() }, range: { value: 1 }, thr: { value: 1 }, ink: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `uniform sampler2D tColor, tDepth; uniform vec2 px; uniform float range, thr, ink, sat; uniform vec3 gain; varying vec2 vUv;
    float d(vec2 o) { return texture2D(tDepth, vUv + o * px).x * range; }
    void main() {
      vec4 col = texture2D(tColor, vUv);
      float c = d(vec2(0.0));
      float lap = max(abs(d(vec2(1.0, 0.0)) + d(vec2(-1.0, 0.0)) - 2.0 * c), abs(d(vec2(0.0, 1.0)) + d(vec2(0.0, -1.0)) - 2.0 * c));
      float e = smoothstep(thr, thr * 6.0, lap) * ink; // faint creases fade in instead of switching on
      vec3 cc = mix(col.rgb, col.rgb * vec3(0.16, 0.18, 0.22), e);
      cc = max(mix(vec3(dot(cc, vec3(0.2126, 0.7152, 0.0722))), cc, sat), 0.0); // the illustration's saturation (less zoomed out)
      cc *= gain; // and its brighter, cooler light (fitted on side-by-side renders)
      gl_FragColor = vec4(cc, 1.0);
      #include <colorspace_fragment>
      gl_FragDepth = texture2D(tDepth, vUv).x; // the scene's depth, for the trees drawn on top
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
  ink.uniforms.px.value.set(pr / w, pr / h) // one CSS pixel
  ink.uniforms.range.value = cam.far - cam.near
  ink.uniforms.thr.value = 0.35 / (K * cam.zoom) // metres per CSS pixel
  ink.uniforms.ink.value = THREE.MathUtils.smoothstep(cam.zoom, 0.05, 0.16)
  ink.uniforms.sat.value = 0.96 + 0.24 * THREE.MathUtils.smoothstep(cam.zoom, 0.04, 0.2)
  const near = THREE.MathUtils.smoothstep(cam.zoom, 0.04, 0.12) // the grade is for the close views; zoomed out the colours already match
  ink.uniforms.gain.value.set(1 + 0.1 * near, 1 + 0.17 * near, 1 + 0.38 * near)
  renderer.info.autoReset = false; renderer.info.reset()
  renderer.setRenderTarget(rt); renderer.render(scene, cam)
  renderer.setRenderTarget(null); renderer.render(postScene, postCam)
  if (treeGroup.visible) {
    treeMat.uniforms.sat.value = ink.uniforms.sat.value * 0.88
    treeMat.uniforms.gain.value.copy(ink.uniforms.gain.value)
    renderer.autoClear = false; renderer.render(treeScene, cam); renderer.autoClear = true
  }
}

// trees under ~4 px and cars under ~2 px are not drawn (the ground has the crowns painted in)
function loop() {
  requestAnimationFrame(loop)
  controls.update()
  if (!dirty) return
  dirty = false
  const treesOn = cam.zoom >= 0.14
  if (treesOn !== treeGroup.visible) { treeGroup.visible = treesOn; renderer.shadowMap.needsUpdate = true }
  groundFor(treesOn)
  for (const m of boatDetail) m.visible = cam.zoom >= 0.12
  masts.visible = cam.zoom >= 0.3 // thinner than a pixel below that
  const carsOn = cam.zoom >= 0.1 && !document.hidden
  if (carsOn !== cars.visible) { cars.visible = carsOn; traffic.postMessage({ run: carsOn }) }
  updateShadows()
  draw()
}
cars.visible = false
loop()
document.addEventListener('visibilitychange', () => { dirty = true })
window.view = { cam, controls, setView, zAt, roads, renderer }
status('')
$('#hint').hidden = false
