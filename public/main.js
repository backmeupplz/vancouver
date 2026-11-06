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
for (const g of grids) {
  const pos = [], uv = [], idx = []
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const x = Math.min(g.x1, g.x0 + i * g.step), y = Math.min(g.y1, g.y0 + j * g.step)
    pos.push(x, g.z[j * g.nx + i] / 10, -y); uv.push((x - g.x0) / (g.x1 - g.x0), (y - g.y0) / (g.y1 - g.y0))
    if (i && j) { const a = j * g.nx + i; idx.push(a - g.nx - 1, a - g.nx, a - 1, a - g.nx, a, a - 1) }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx); geo.computeVertexNormals()
  g.tex.colorSpace = THREE.SRGBColorSpace
  g.tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: g.tex }))
  g.mat = m.material
  m.receiveShadow = true
  scene.add(m)
}

// zoomed in the 3D trees stand on plain ground; zoomed out the crowns painted into the ground stand in for them
const loader = new THREE.TextureLoader()
function groundFor(trees) {
  for (const g of grids) {
    if (trees && !g.plain) {
      g.plain = loader.load(g.tex.image.src.replace('.jpg', '-plain.jpg'), (t) => { if (treeGroup.visible) { g.mat.map = t; g.mat.needsUpdate = true; dirty = true } })
      Object.assign(g.plain, { colorSpace: THREE.SRGBColorSpace, anisotropy: g.tex.anisotropy })
    }
    const want = trees ? g.plain : g.tex
    if (want.image && g.mat.map !== want) { g.mat.map = want; g.mat.needsUpdate = true }
  }
}

// ---------- light ----------
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x5a5440, 1.7))
const sun = new THREE.DirectionalLight(0xfff1dc, 2.5)
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
const PAL = [ // wall and roof colours per class: house, apartment, glass tower, brick, concrete, white
  { wall: [0xe8e4da, 0xd9d2c3, 0xc9c0ad, 0xa9b4b8, 0xd8c8a8, 0xbfcfd8, 0x9fb7c8, 0xd6c48a, 0xa8b894, 0xc98a6a, 0xf0ece0, 0x8fa4b4], roof: [0x4a4f55, 0x5f6366, 0x6e6a66, 0x7a5a48, 0x3e4349, 0x8a8a86, 0x6b4d3c, 0x8c4a3a, 0x52606a] },
  { wall: [0xe8dcc4, 0xd8c8a8, 0xf0ece4, 0xd2cabc, 0xe2ddd2, 0xc8c6c0, 0xe6d2b0], roof: [0x9a9a96, 0x8c8e8e, 0xa8a49c] },
  { wall: [0x7fa6c4, 0x8cb3cf, 0x6f97b8, 0x9cbfd6, 0x5f87a8, 0xa8c4d4, 0x78a0b0], roof: [0xb8c2c8, 0x9aa6ae, 0xc4ccd0] },
  { wall: [0xa8604a, 0x9a5442, 0xb57058, 0x8e4e3e], roof: [0x6e5a50, 0x7c6a60] },
  { wall: [0xc9c2b2, 0xd6cfbf, 0xb8b4aa, 0xe0d8c6], roof: [0x8e8e8a, 0x9a9890, 0x7e8080] },
  { wall: [0xeeeeea, 0xe4e6e6, 0xf2f0ea], roof: [0xbcbcb8, 0xc8c8c4] },
]
const nb = (o = after, u32())
const v3 = (x, y, z) => new THREE.Vector3(x, y, z)
const n_ = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3()
// one triangle with its own flat normal, wound so the normal points along `want`
function tri(B, a, b, d, color, want, win = [0, 0, 0, 0, 0, 0, 0, 0, 0]) {
  n_.crossVectors(e1.subVectors(b, a), e2.subVectors(d, a)).normalize()
  if (n_.dot(want) < 0) { [b, d] = [d, b]; n_.negate(); win = [...win.slice(0, 3), ...win.slice(6, 9), ...win.slice(3, 6)] }
  for (const p of [a, b, d]) { B.pos.push(p.x, p.y, p.z); B.nor.push(n_.x * 127, n_.y * 127, n_.z * 127); B.col.push(color.r * 255, color.g * 255, color.b * 255) }
  B.win.push(...win)
}
const UP = v3(0, 1, 0)
for (let b = 0; b < nb; b++) {
  const n = u16(), base = i16() / 10, h = u16() / 10, mn = u16() / 10, k = u8(), pitched = u8()
  const pts = []
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector2(i16() / 2, -i16() / 2)) // (x, z)
  let roof = null
  if (pitched) roof = { cx: i16() / 2, cy: i16() / 2, a: i16() / 1000, hl: u16() / 10, hw: u16() / 10, ridge: u16() / 10 }
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse()
  let cx = 0, cz = 0
  for (const p of pts) { cx += p.x / n; cz += p.y / n }
  const B = chunk(cx, -cz).b ??= { pos: [], nor: [], col: [], win: [] }
  const pal = PAL[k]
  const wallC = new THREE.Color(pick(pal.wall)).offsetHSL(0, 0, (rand() - 0.5) * 0.06)
  const roofC = new THREE.Color(pick(pal.roof)).offsetHSL(0, 0, (rand() - 0.5) * 0.06)
  const winType = h < 4 ? 0 : k === 2 ? 2 : k === 0 && !roof && h < 8 ? 0 : 1 // 0 none, 1 punched windows, 2 curtain wall
  const y0 = base + mn, y1 = base + h
  let u = 0
  for (let i = 0; i < n; i++) {
    const a = pts[i], p = pts[(i + 1) % n]
    const len = Math.hypot(p.x - a.x, p.y - a.y) || 1
    const out = v3((p.y - a.y) / len, 0, -(p.x - a.x) / len)
    c.copy(wallC).multiplyScalar(0.84 + 0.16 * Math.abs(out.x))
    const A = v3(a.x, y0, a.y), P = v3(p.x, y0, p.y), Pt = v3(p.x, y1, p.y), At = v3(a.x, y1, a.y)
    const w = (uu, yy) => [winType, uu, yy - base]
    tri(B, A, P, Pt, c, out, [...w(u, y0), ...w(u + len, y0), ...w(u + len, y1)])
    tri(B, A, Pt, At, c, out, [...w(u, y0), ...w(u + len, y1), ...w(u, y1)])
    u += len
  }
  if (!roof) {
    const top = pts.map((p) => v3(p.x, y1, p.y))
    for (const [a, bb, cc] of THREE.ShapeUtils.triangulateShape(pts, [])) tri(B, top[a], top[bb], top[cc], roofC, UP)
    if (h > 18 && n >= 4) { // a plant room on top of the taller buildings
      const pk = pts.map((p) => new THREE.Vector2(cx + (p.x - cx) * 0.38, cz + (p.y - cz) * 0.38)), y2 = y1 + 3 + rand() * 2.5
      const pc = c.copy(roofC).offsetHSL(0, 0, 0.08).clone()
      for (let i = 0; i < pk.length; i++) { // (triangulateShape may have dropped a repeated last point)
        const a = pk[i], p = pk[(i + 1) % pk.length], len = Math.hypot(p.x - a.x, p.y - a.y) || 1, out = v3((p.y - a.y) / len, 0, -(p.x - a.x) / len)
        const sh = pc.clone().multiplyScalar(0.8 + 0.2 * Math.abs(out.x))
        tri(B, v3(a.x, y1, a.y), v3(p.x, y1, p.y), v3(p.x, y2, p.y), sh, out); tri(B, v3(a.x, y1, a.y), v3(p.x, y2, p.y), v3(a.x, y2, a.y), sh, out)
      }
      for (const [a, bb, cc] of THREE.ShapeUtils.triangulateShape(pk, [])) tri(B, v3(pk[a].x, y2, pk[a].y), v3(pk[bb].x, y2, pk[bb].y), v3(pk[cc].x, y2, pk[cc].y), pc, UP)
    }
    continue
  }
  // pitched roof over the footprint's rectangle: gable along the long side, hipped when it is near square
  const { cx: rx, cy: ry, a, hl, hw, ridge } = roof, O = 0.45 // eave overhang
  const ax = v3(Math.cos(a), 0, -Math.sin(a)), bx = v3(-Math.sin(a), 0, -Math.cos(a))
  const C = v3(rx, 0, -ry), at = (s, t, y) => C.clone().addScaledVector(ax, s).addScaledVector(bx, t).setY(y)
  const yr = base + ridge, L = hl + O, Wd = hw + O, gable = hl / hw > 1.15, r = gable ? L : Math.max(0.01, L - Wd)
  const rc = new THREE.Color(pick(PAL[0].roof)).offsetHSL(0, 0, (rand() - 0.5) * 0.08)
  for (const s of [1, -1]) {
    const side = bx.clone().multiplyScalar(s).add(UP)
    tri(B, at(-L, s * Wd, y1), at(L, s * Wd, y1), at(r, 0, yr), rc, side)
    tri(B, at(-L, s * Wd, y1), at(r, 0, yr), at(-r, 0, yr), rc, side)
    const end = ax.clone().multiplyScalar(s)
    if (gable) tri(B, at(s * hl, Wd, y1), at(s * hl, -Wd, y1), at(s * hl, 0, yr), c.copy(wallC).multiplyScalar(0.92), end)
    else tri(B, at(s * L, Wd, y1), at(s * L, -Wd, y1), at(s * r, 0, yr), rc, end.clone().add(UP))
  }
}
const bmat = new THREE.MeshLambertMaterial({ vertexColors: true })
bmat.onBeforeCompile = (s) => {
  s.vertexShader = s.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aWin;\nvarying vec3 vWin;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWin = aWin;')
  // windows fade to their average colour once a floor is under ~3 px tall, so they never shimmer
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWin;')
    .replace('#include <color_fragment>', `#include <color_fragment>
      if (vWin.x > 0.5) {
        bool curtain = vWin.x > 1.5;
        vec2 g = vec2(vWin.y / (curtain ? 1.6 : 3.0), vWin.z / 3.2);
        vec2 fw = max(fwidth(g), vec2(1e-4));
        float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
        vec2 f = fract(g);
        vec3 glass = curtain ? vec3(0.30, 0.42, 0.55) : vec3(0.26, 0.33, 0.42);
        vec2 lo = curtain ? vec2(0.08, 0.1) : vec2(0.3, 0.32), hi = curtain ? vec2(1.0, 1.0) : vec2(0.8, 0.85);
        vec2 inside = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f));
        float w = inside.x * inside.y, cover = (hi.x - lo.x) * (hi.y - lo.y);
        float amt = curtain ? 0.7 : 0.8;
        vec3 shade = glass * (0.9 + 0.2 * sin(vWin.y * 0.11 + vWin.z * 0.37));
        diffuseColor.rgb = mix(mix(diffuseColor.rgb, glass, cover * amt), mix(diffuseColor.rgb, shade, w * amt), detail);
      }`)
}
for (const ch of chunks.values()) {
  const B = ch.b; if (!B) continue
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(B.nor), 3, true))
  g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(B.col), 3, true))
  g.setAttribute('aWin', new THREE.Float32BufferAttribute(B.win, 3))
  const m = new THREE.Mesh(g, bmat)
  m.castShadow = m.receiveShadow = true
  scene.add(m)
  delete ch.b
}

// ---------- trees: painted billboards (the camera never changes its tilt, so a flat picture reads as a tree),
// drawn when zoomed in; zoomed out their crowns are painted into the ground ----------
const nt = u32()
const treeGroup = new THREE.Group()
const ATL = 256, atlas = document.createElement('canvas')
atlas.width = ATL * 4; atlas.height = ATL * 2
{ // 6 broadleaf and 2 conifer pictures in grey, tinted per tree
  const g2 = atlas.getContext('2d'), INK = '#141a14'
  for (let v = 0; v < 8; v++) {
    const ox = (v % 4) * ATL, oy = Math.floor(v / 4) * ATL, r = mulberry(v + 11)
    const X = (x) => ox + x * ATL, Y = (y) => oy + y * ATL
    g2.fillStyle = INK; g2.fillRect(X(0.465), Y(0.7), ATL * 0.07, ATL * 0.29)
    g2.fillStyle = '#6b5240'; g2.fillRect(X(0.475), Y(0.7), ATL * 0.05, ATL * 0.28)
    if (v < 6) {
      const puffs = []
      for (let i = 0; i < 18; i++) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.28; puffs.push([0.5 + Math.cos(a) * d, 0.45 + Math.sin(a) * d * 0.8, 0.14 + r() * 0.08]) }
      puffs.sort((a, b) => a[1] - b[1])
      g2.fillStyle = INK
      for (const [x, y, rr] of puffs) { g2.beginPath(); g2.arc(X(x), Y(y), (rr + 0.025) * ATL, 0, 7); g2.fill() }
      for (const [x, y, rr] of puffs) {
        const gr = g2.createRadialGradient(X(x - rr * 0.35), Y(y - rr * 0.4), 0, X(x), Y(y), rr * ATL)
        const lift = 1 - (y - 0.2) * 0.5
        gr.addColorStop(0, `rgb(${255 * lift},${255 * lift},${255 * lift})`); gr.addColorStop(1, `rgb(${150 * lift},${150 * lift},${150 * lift})`)
        g2.fillStyle = gr; g2.beginPath(); g2.arc(X(x), Y(y), rr * ATL, 0, 7); g2.fill()
        g2.strokeStyle = 'rgba(20,26,20,0.55)'; g2.lineWidth = ATL * 0.008
        g2.beginPath(); g2.arc(X(x), Y(y), rr * ATL, 0.1, 1.9); g2.stroke()
      }
    } else {
      const tiers = 6
      const tier = (grow, fill) => {
        for (let i = 0; i < tiers; i++) {
          const y0 = 0.04 + i * 0.13, y1 = y0 + 0.26 + i * 0.02, w = 0.09 + i * 0.055 + grow
          g2.fillStyle = fill(i); g2.beginPath(); g2.moveTo(X(0.5), Y(y0 - grow)); g2.lineTo(X(0.5 + w), Y(y1 + grow * 0.5)); g2.lineTo(X(0.5 - w), Y(y1 + grow * 0.5)); g2.closePath(); g2.fill()
        }
      }
      tier(0.025, () => INK)
      tier(0, (i) => { const gr = g2.createLinearGradient(X(0.3), 0, X(0.7), 0); const l = 1 - i * 0.05; gr.addColorStop(0, `rgb(${235 * l},${235 * l},${235 * l})`); gr.addColorStop(1, `rgb(${120 * l},${120 * l},${120 * l})`); return gr })
    }
  }
}
const atlasTex = new THREE.CanvasTexture(atlas)
atlasTex.colorSpace = THREE.SRGBColorSpace
atlasTex.anisotropy = 4
const treeMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: atlasTex } },
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
  fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying vec3 vCol;
    void main() {
      vec4 t = texture2D(map, vUv);
      if (t.a < 0.05) discard;
      gl_FragColor = vec4(vCol * t.rgb * 1.55, smoothstep(0.3, 0.7, t.a));
      #include <colorspace_fragment>
    }`,
  alphaToCoverage: true,
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
  const n = list.length, P = new Float32Array(n * 3), S = new Float32Array(n * 2), C = new Float32Array(n * 3), V = new Float32Array(n)
  let lo = Infinity, hi = -Infinity
  list.forEach(([x, y, z, k, col, h], i) => {
    const conif = k === 5, r = conif ? Math.max(1.8, h * 0.2) : Math.min(8.5, Math.max(2.6, h * 0.36))
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
  treeGroup.add(new THREE.Mesh(g, treeMat))
}
treeGroup.visible = false
scene.add(treeGroup)
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), tp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)

// ---------- boats ----------
const nbo = u32()
const boats = new THREE.InstancedMesh(new THREE.BoxGeometry(2.6, 1.6, 9).translate(0, 0.8, 0), new THREE.MeshLambertMaterial(), nbo)
for (let i = 0; i < nbo; i++) {
  const x = i16() / 2, y = i16() / 2, z = i16() / 10, a = i16() / 1000, s = 0.6 + rand() * 0.9
  q.setFromAxisAngle(up, a + Math.PI / 2)
  boats.setMatrixAt(i, m4.compose(tp.set(x, z, -y), q, sc.set(s, s, s)))
  boats.setColorAt(i, c.set(rand() < 0.85 ? 0xf4f4f0 : pick([0x2a4d7a, 0xb03a2e, 0x333840])))
}
boats.computeBoundingSphere()
boats.castShadow = true
scene.add(boats)

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
  uniforms: { tColor: { value: rt.texture }, tDepth: { value: rt.depthTexture }, px: { value: new THREE.Vector2() }, range: { value: 1 }, thr: { value: 1 }, ink: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `uniform sampler2D tColor, tDepth; uniform vec2 px; uniform float range, thr, ink; varying vec2 vUv;
    float d(vec2 o) { return texture2D(tDepth, vUv + o * px).x * range; }
    void main() {
      vec4 col = texture2D(tColor, vUv);
      float c = d(vec2(0.0));
      float lap = max(abs(d(vec2(1.0, 0.0)) + d(vec2(-1.0, 0.0)) - 2.0 * c), abs(d(vec2(0.0, 1.0)) + d(vec2(0.0, -1.0)) - 2.0 * c));
      float e = smoothstep(thr, thr * 3.0, lap) * ink;
      gl_FragColor = vec4(mix(col.rgb, col.rgb * vec3(0.16, 0.18, 0.22), e), 1.0);
      #include <colorspace_fragment>
    }`,
  depthTest: false, depthWrite: false,
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
  renderer.setRenderTarget(rt); renderer.render(scene, cam)
  renderer.setRenderTarget(null); renderer.render(postScene, postCam)
}

// trees under ~4 px and cars under ~2 px are not drawn (the ground has the crowns painted in)
function loop() {
  requestAnimationFrame(loop)
  controls.update()
  if (!dirty) return
  dirty = false
  const treesOn = cam.zoom >= 0.14
  if (treesOn !== treeGroup.visible) { treeGroup.visible = treesOn; renderer.shadowMap.needsUpdate = true; groundFor(treesOn) }
  const carsOn = cam.zoom >= 0.1 && !document.hidden
  if (carsOn !== cars.visible) { cars.visible = carsOn; traffic.postMessage({ run: carsOn }) }
  updateShadows()
  draw()
}
cars.visible = false
loop()
document.addEventListener('visibilitychange', () => { dirty = true })
window.view = { cam, controls, setView, zAt, roads }
status('')
$('#hint').hidden = false
