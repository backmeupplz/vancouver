// A lean WebGL viewer for @imnotchalk's Isometric Vancouver (vancouver.isoworld.xyz). Tiles,
// traffic data and traffic.js are all loaded from there (served with CORS *), nothing is copied.
// Tiles are decoded off the main thread (createImageBitmap) and drawn as textured quads, and the
// traffic simulation runs in a worker, so the page itself does almost nothing per frame.
const ORIGIN = 'https://vancouver.isoworld.xyz/'
const $ = (s) => document.querySelector(s)
const phone = matchMedia('(max-width: 600px)').matches
const TILE = 512

// Their page names the current tile folders; read it so a new version of the map shows up here too.
let W = 26624, H = 21504, TILES = 'v8', TRAFFIC = 'traffic-v3'
let BASE = { version: 'v1', x0: -255672, y0: -101424, k: 24, width: 25013, height: 8916 }
let UBC = { version: 'v1', x0: -45056, y0: 13312, width: 16384, height: 9216 }   // a separate frame, west of the main one
const [html, avif] = await Promise.all([
  fetch(ORIGIN).then((r) => r.text()).catch(() => ''),
  fetch(ORIGIN + 'tiles-avif-v8/0/0_0.avif').then((r) => r.blob()).then(createImageBitmap).then(() => true, () => false),
])
try {
  const m = html.match(/const W = (\d+), H = (\d+)/); if (m) { W = +m[1]; H = +m[2] }
  TILES = html.match(/TILES_VERSION = "(\w+)"/)?.[1] ?? TILES
  TRAFFIC = html.match(/startTraffic\(viewer, "([^"]+)"/)?.[1] ?? TRAFFIC
  const b = html.match(/const BASEMAP = (\{[^}]*\})/)?.[1]
  if (b) BASE = JSON.parse(b.replace(/(\w+):/g, '"$1":'))
  const u = html.match(/const UBC = (\{[^}]*\})/)?.[1]
  if (u) UBC = JSON.parse(u.replace(/(\w+):/g, '"$1":'))
} catch {}
const fmt = avif ? 'avif' : 'webp'
const pyramid = (id, url, w, h, x0, y0, k, smooth) => ({ id, url, w, h, x0, y0, k, smooth, maxL: Math.ceil(Math.log2(Math.max(w, h))) })
const basemap = pyramid('b', `${ORIGIN}basemap-${fmt}-${BASE.version}/`, BASE.width, BASE.height, BASE.x0, BASE.y0, BASE.k, true)
const drawing = pyramid('d', `${ORIGIN}tiles-${fmt}-${TILES}/`, W, H, 0, 0, 1, false)
const ubc = pyramid('u', `${ORIGIN}ubc-${fmt}-${UBC.version}/`, UBC.width, UBC.height, UBC.x0, UBC.y0, 1, false)
const world = { x0: BASE.x0, y0: BASE.y0, x1: BASE.x0 + BASE.width * BASE.k, y1: BASE.y0 + BASE.height * BASE.k }

// ---------------------------------------------------------------- GL
const canvas = $('#map')
const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true })
if (!gl) { $('#nogl').hidden = false; $('#controls').hidden = $('#info').hidden = true; throw new Error('WebGL 2 is not available') }
const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s }
const prog = gl.createProgram()
gl.attachShader(prog, sh(gl.VERTEX_SHADER, `#version 300 es
uniform vec4 r; in vec2 p; out vec2 uv;
void main() { uv = p; gl_Position = vec4(mix(r.xy, r.zw, p), 0, 1); }`))
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float; uniform sampler2D t; uniform float a; in vec2 uv; out vec4 o;
void main() { o = texture(t, uv) * a; }`))
gl.bindAttribLocation(prog, 0, 'p'); gl.linkProgram(prog); gl.useProgram(prog)
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
const uR = gl.getUniformLocation(prog, 'r'), uA = gl.getUniformLocation(prog, 'a')
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
gl.clearColor(0x0e / 255, 0x16 / 255, 0x20 / 255, 1)
function texture(img, smooth) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, smooth ? gl.LINEAR : gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

// ---------------------------------------------------------------- view (image px; s = CSS px per image px)
let cw = 1, ch = 1, dpr = 1
const v = { cx: W / 2, cy: H / 2, s: 0.05 }
let anim = null   // { s, cx, cy } or { s, ax, ay, sx, sy } (zoom about an anchor)
let fling = null  // { vx, vy } CSS px per ms
const sMin = () => Math.min(cw / (world.x1 - world.x0), ch / (world.y1 - world.y0))
const sMax = () => 6 / dpr
const clampS = (s) => Math.min(sMax(), Math.max(sMin(), s))
function clampView() {
  v.s = clampS(v.s)
  v.cx = Math.min(world.x1, Math.max(world.x0, v.cx)); v.cy = Math.min(world.y1, Math.max(world.y0, v.cy))
}
function resize() {
  dpr = Math.min(devicePixelRatio || 1, 3); cw = innerWidth; ch = innerHeight
  canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr)
  render()
}
function fitDrawing(now) {
  const a = cw / ch
  const s = phone ? (a < W / H ? ch / H : cw / W) : Math.min(cw / W, ch / H)   // phones fill the screen
  const t = { s, cx: W / 2, cy: H / 2 }
  if (now) Object.assign(v, t); else anim = t
  render()
}
function fitAll() {   // every drawn frame, UBC included
  const x0 = Math.min(0, UBC.x0), y0 = Math.min(0, UBC.y0), x1 = Math.max(W, UBC.x0 + UBC.width), y1 = Math.max(H, UBC.y0 + UBC.height)
  anim = { s: clampS(0.96 * Math.min(cw / (x1 - x0), ch / (y1 - y0))), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
  render()
}
function zoomAt(f, sx = cw / 2, sy = ch / 2) {
  const from = anim?.ax !== undefined && anim.sx === sx && anim.sy === sy ? anim.s : v.s
  anim = { s: clampS(from * f), ax: v.cx + (sx - cw / 2) / v.s, ay: v.cy + (sy - ch / 2) / v.s, sx, sy }
  fling = null; render()
}

// ---------------------------------------------------------------- tiles
const cache = new Map()   // key -> { tex | null (failed) | undefined (loading), used }
const MAX_TILES = phone ? 120 : 260
let inflight = 0, uploads = []
let wanted = []
function request() {
  while (inflight < 12 && wanted.length) {
    const [key, url, smooth] = wanted.shift()
    if (cache.has(key)) continue
    cache.set(key, { tex: undefined, used: 0 }); inflight++
    fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject())).then(createImageBitmap)
      .then((bmp) => uploads.push([key, bmp, smooth]), () => { cache.get(key).tex = null })
      .finally(() => { inflight--; render() })
  }
}
function evict(frame) {
  if (cache.size <= MAX_TILES) return
  const old = [...cache].filter(([, c]) => c.tex && c.used < frame).sort((a, b) => a[1].used - b[1].used)
  for (const [k, c] of old.slice(0, cache.size - MAX_TILES)) { gl.deleteTexture(c.tex); cache.delete(k) }
}
const clip = (x, y) => [((x - v.cx) * v.s) / (cw / 2), -((y - v.cy) * v.s) / (ch / 2)]
function quad(tex, x0, y0, x1, y1, a = 1) {
  const [ax, ay] = clip(x0, y0), [bx, by] = clip(x1, y1)
  gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform4f(uR, ax, ay, bx, by); gl.uniform1f(uA, a)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}
// Draws what it has of a pyramid for the view, coarse to fine, and lists the tiles it lacks.
function drawPyramid(P, frame, need) {
  const vx0 = v.cx - cw / 2 / v.s, vy0 = v.cy - ch / 2 / v.s, vx1 = v.cx + cw / 2 / v.s, vy1 = v.cy + ch / 2 / v.s
  const L = Math.max(0, Math.min(P.maxL, Math.ceil(P.maxL + Math.log2(v.s * P.k * dpr) - 0.1)))
  for (let l = Math.max(0, L - 4); l <= Math.min(P.maxL, L + 1); l++) {
    const f = 2 ** (P.maxL - l) * P.k, lw = Math.ceil(P.w / 2 ** (P.maxL - l)), lh = Math.ceil(P.h / 2 ** (P.maxL - l))
    const c0 = Math.max(0, Math.floor((vx0 - P.x0) / f / TILE)), c1 = Math.min(Math.ceil(lw / TILE) - 1, Math.floor((vx1 - P.x0) / f / TILE))
    const r0 = Math.max(0, Math.floor((vy0 - P.y0) / f / TILE)), r1 = Math.min(Math.ceil(lh / TILE) - 1, Math.floor((vy1 - P.y0) / f / TILE))
    const mx = (c0 + c1) / 2, my = (r0 + r1) / 2, list = []
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const key = `${P.id}${l}/${c}_${r}`, t = cache.get(key)
      if (t?.tex) {
        t.used = frame
        // tiles carry one pixel of overlap on inner edges; drawn in place, so neighbours overlap exactly
        const ax = c * TILE - (c > 0), bx = Math.min(lw, (c + 1) * TILE + 1), ay = r * TILE - (r > 0), by = Math.min(lh, (r + 1) * TILE + 1)
        quad(t.tex, P.x0 + ax * f, P.y0 + ay * f, P.x0 + bx * f, P.y0 + by * f)
      } else if (t === undefined && (l === L || l === Math.max(0, L - 4))) list.push([key, `${P.url}${l}/${c}_${r}.${fmt}`, P.smooth, (c - mx) ** 2 + (r - my) ** 2])
    }
    list.sort((a, b) => a[3] - b[3]); need.push(...list)
  }
}

// ---------------------------------------------------------------- traffic (in a worker)
let cars = null, carTex = null, trafficOn = true, lastSent = ''
const worker = new Worker('traffic-worker.js')
worker.onmessage = ({ data }) => {
  if (data.error) { console.warn('traffic:', data.error); $('#trafficBtn').hidden = true; return }
  if (data.empty) { cars = null; render(); return }
  if (!carTex) carTex = texture(data.bmp, false)
  else { gl.bindTexture(gl.TEXTURE_2D, carTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data.bmp) }
  data.bmp.close(); cars = data; render()
}
worker.postMessage({ origin: ORIGIN, base: TRAFFIC, phone })

// ---------------------------------------------------------------- frame
let frameNo = 0, pending = false, last = performance.now()
function render() { if (!pending) { pending = true; requestAnimationFrame(frame) } }
function frame(now) {
  pending = false
  const dt = Math.min(100, now - last); last = now
  if (anim) {
    const k = 1 - Math.exp(-dt / 90)
    v.s = Math.exp(Math.log(v.s) + (Math.log(anim.s) - Math.log(v.s)) * k)
    if (anim.ax !== undefined) { v.cx = anim.ax - (anim.sx - cw / 2) / v.s; v.cy = anim.ay - (anim.sy - ch / 2) / v.s }
    else { v.cx += (anim.cx - v.cx) * k; v.cy += (anim.cy - v.cy) * k }
    if (Math.abs(Math.log(v.s / anim.s)) < 1e-3 && (anim.ax !== undefined || Math.hypot(anim.cx - v.cx, anim.cy - v.cy) * v.s < 0.5)) anim = null
  }
  if (fling) {
    v.cx -= (fling.vx * dt) / v.s; v.cy -= (fling.vy * dt) / v.s
    const d = Math.exp(-dt / 250); fling.vx *= d; fling.vy *= d
    if (Math.hypot(fling.vx, fling.vy) < 0.01) fling = null
  }
  clampView()
  frameNo++
  for (let i = 0; i < 4 && uploads.length; i++) {   // a few uploads per frame keeps zooming smooth
    const [key, bmp, smooth] = uploads.shift(), c = cache.get(key)
    if (c) c.tex = texture(bmp, smooth); bmp.close()
  }
  gl.viewport(0, 0, canvas.width, canvas.height)
  gl.clear(gl.COLOR_BUFFER_BIT)
  const need = []
  // the drawing is opaque, so the basemap is skipped while the view lies inside it
  const inside = v.cx - cw / 2 / v.s >= 0 && v.cy - ch / 2 / v.s >= 0 && v.cx + cw / 2 / v.s <= W && v.cy + ch / 2 / v.s <= H
  if (!inside) { drawPyramid(basemap, frameNo, need); drawPyramid(ubc, frameNo, need) }
  drawPyramid(drawing, frameNo, need)
  wanted = need; request(); evict(frameNo)
  if (trafficOn && cars) {
    gl.enable(gl.BLEND)
    quad(carTex, cars.vx, cars.vy, cars.vx + cars.cw / cars.s, cars.vy + cars.ch / cars.s)
    gl.disable(gl.BLEND)
  }
  const key = `${v.cx},${v.cy},${v.s},${cw},${ch}`
  if (key !== lastSent) { lastSent = key; worker.postMessage({ view: { vx: v.cx - cw / 2 / v.s, vy: v.cy - ch / 2 / v.s, s: v.s, cw, ch, dpr } }) }
  if (anim || fling || uploads.length) render()
}

// ---------------------------------------------------------------- input
const pts = new Map()
let lastMove = null
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); anim = fling = null; lastMove = null
})
canvas.addEventListener('pointermove', (e) => {
  const p = pts.get(e.pointerId); if (!p) return
  if (pts.size === 1) {
    const dx = e.clientX - p[0], dy = e.clientY - p[1]
    v.cx -= dx / v.s; v.cy -= dy / v.s
    lastMove = { vx: dx / Math.max(1, e.timeStamp - (lastMove?.t ?? e.timeStamp - 16)), vy: dy / Math.max(1, e.timeStamp - (lastMove?.t ?? e.timeStamp - 16)), t: e.timeStamp }
  } else if (pts.size === 2) {   // pinch: zoom about the midpoint and follow it
    const [a, b] = [...pts.values()], o = a === p ? b : a
    const m0 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d0 = Math.hypot(a[0] - b[0], a[1] - b[1])
    const m1 = [(e.clientX + o[0]) / 2, (e.clientY + o[1]) / 2], d1 = Math.hypot(e.clientX - o[0], e.clientY - o[1])
    const ax = v.cx + (m0[0] - cw / 2) / v.s, ay = v.cy + (m0[1] - ch / 2) / v.s
    v.s = clampS(v.s * (d1 / Math.max(1, d0)))
    v.cx = ax - (m1[0] - cw / 2) / v.s; v.cy = ay - (m1[1] - ch / 2) / v.s
  }
  p[0] = e.clientX; p[1] = e.clientY
  render()
})
const up = (e) => {
  if (!pts.delete(e.pointerId)) return
  if (!pts.size && lastMove && e.timeStamp - lastMove.t < 60 && Math.hypot(lastMove.vx, lastMove.vy) > 0.2) { fling = lastMove; render() }
  lastMove = null
}
canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up)
// zoom follows how far the wheel or touchpad moved (a touchpad pinch arrives as ctrl + wheel)
canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
  zoomAt(Math.min(2, Math.max(0.5, Math.exp(-e.deltaY * px * (e.ctrlKey ? 0.01 : 0.0025)))), e.clientX, e.clientY)
}, { passive: false })
canvas.addEventListener('dblclick', (e) => zoomAt(2, e.clientX, e.clientY))

const toggle = (id, fn) => { const b = $(id); b.onclick = () => b.setAttribute('aria-pressed', String(fn())) }
toggle('#trafficBtn', () => { trafficOn = !trafficOn; worker.postMessage({ enabled: trafficOn }); render(); return trafficOn })
toggle('#about', () => !$('#info').classList.toggle('min'))
$('#fit').onclick = fitAll
$('#zoomIn').onclick = () => zoomAt(1.6)
$('#zoomOut').onclick = () => zoomAt(1 / 1.6)
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === '0') fitAll()
  else if (e.key === '+' || e.key === '=') zoomAt(1.6)
  else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.6)
  else if (e.key === 't' || e.key === 'T') $('#trafficBtn').click()
  else if (e.key === 'i' || e.key === 'I') $('#about').click()
})
addEventListener('resize', resize)
if (phone) $('#about').click()
resize(); fitDrawing(true)
