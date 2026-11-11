// node tools/bench.mjs [--dpr 2] [--tier high|low] [--cpu 4] [--secs 20] [--res 0.6] [--race 1] [--weather rain] [--hour 22] [--size 1700x1270] [--js 'expr'] [--vs 'name=expr;;name=expr'] [--psecs 4] [--park 1] map|drive|walk|bus|sail
// (--park: the van, walker or bus stays where it starts: the same view every run, so triangles and calls compare; --res pins the adaptive resolution; --race: sail in a regatta; --js: run in the page before measuring, e.g. hide something to see its cost)
// A weak GPU is mostly short of fill rate: `--size 1700x1270 --dpr 2 --res 1` (8.6 Mpx) loads this one like an integrated GPU at 1x; compare passes, not fps.
// One JSON line: {p50,p95,p99,over33,frames,tris,calls,gpu:{pass: ms, sum},vs?}. gpu: after the timed run, --psecs more with every pass drawn alone
// (the GPU waited for before and after it: its own CPU + GPU ms, nothing queued behind it; timer queries here measured the queue): shadows, scene, bloom, ink = outlines + grade +
// look, trees = billboards, overlay = weather and effects, fxaa, lights, warm = tile uploads. vs: the same after each --vs expression, run in turn (what a thing costs: hide it).. map = continuous pan at #13645,11243,0.1295;
// drive = autopilot in a van downtown (walk: on foot there, bus: the 99 from its first stop); sail = sailing in English Bay. Frame times are unlocked (no vsync).
import { args, server, open, settle } from './pw.mjs'
const [o, [mode = 'map']] = args(process.argv.slice(2), { dpr: 2, tier: 'high', cpu: 1, secs: 20, res: 0, race: '', weather: 'clear', hour: 13, size: '1400x900', js: '', psecs: 4, vs: '', park: '' })
const game = ['drive', 'walk', 'bus'].includes(mode)
const srv = await server(o.port)
const init = () => { // per-frame dt via rAF; and, while P.sync, each pass alone: the GPU waited for before and after every renderer.render (and the shadow pass inside the scene's)
  const P = (window.__b = { dts: [], last: 0, on: false, sync: false, frames: [] }), raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (fn) => raf((ts) => { if (ts !== P.last) { if (P.on && P.last) P.dts.push(ts - P.last); P.last = ts }; fn(ts) })
  const hook = setInterval(() => {
    const R = window.view?.renderer; if (!R) return; clearInterval(hook)
    const gl = R.getContext(), rr = R.render.bind(R), sr = R.shadowMap.render.bind(R.shadowMap)
    // wait for the GPU: Chrome's gl.finish() returns at once, reading a pixel back does not (from a 1 px target of our own: the scene's is multisampled)
    const fb = gl.createFramebuffer(), tx = gl.createTexture(), px = new Uint8Array(4)
    gl.bindTexture(gl.TEXTURE_2D, tx); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1); gl.bindTexture(gl.TEXTURE_2D, null); R.resetState()
    const wait = () => { const d = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), r = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb); if (!wait.ok) { gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx, 0); wait.ok = 1 }
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, d); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, r) }
    let F = {}
    // P.by: triangles per frame by what draws them (the first name up the object's parents, else its material's), over the timed run
    const rb = R.renderBufferDirect.bind(R), names = new Map()
    const matName = (m) => { if (!names.size && view.tiles.mats) for (const [p, o] of [['', view.tiles.mats], ['far.', view.tiles.farMats]]) for (const [k, v] of Object.entries(o)) if (v?.isMaterial && !names.has(v)) names.set(v, p + k); return names.get(m) || m.name || m.type }
    R.renderBufferDirect = (cam, sc, geo, mat, obj, grp) => {
      if (P.on) { let o = obj, n = ''; while (o && !(n = o.name)) o = o.parent
        if (o === sc) n = (obj.isInstancedMesh ? 'instanced ' : 'mesh ') + geo.attributes.position.count + ' v' // (no name of its own: its size tells)
        const c = grp ? grp.count : geo.drawRange.count < Infinity ? geo.drawRange.count : (geo.index || geo.attributes.position).count, k = `${names.has(mat) ? '' : (n || '?') + '/'}${matName(mat)}${sc ? '' : ' (shadow)'}` // (a tile's meshes by their material)
        P.by[k] = (P.by[k] || 0) + (c / 3) * (obj.isInstancedMesh ? obj.count : geo.isInstancedBufferGeometry ? Math.min(geo.instanceCount, 1e9) : 1) }
      return rb(cam, sc, geo, mat, obj, grp) }
    const timed = (l, fn) => { wait(); const t0 = performance.now(); fn(); wait(); F[l] = (F[l] || 0) + performance.now() - t0 }
    R.render = (s, c) => { if (P.on && s.name === 'lights') P.lights++; if (P.on && s.name === 'scene') P.draws++; if (!P.sync) return rr(s, c); if (s.name === 'scene') P.frames.push((F = {})); timed(s.name || 'other', () => rr(s, c)) }
    R.shadowMap.render = (...a) => { if (P.on && R.shadowMap.needsUpdate) P.shadows++; if (!P.sync) return sr(...a); timed('shadows', () => sr(...a)); F.scene = (F.scene || 0) - F.shadows }
  }, 5)
}
const { browser, ctx, page } = await open({ ...o, port: srv.port, query: game ? '?drivedebug' : '', hash: '#13645,11243,0.1295', init,
  gpuFlags: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] })
await settle(page, 1000)
if (game) { // downtown W Georgia, then pure-pursuit autopilot on drivable roads (keyboard events)
  await page.waitForFunction(() => window.driveDebug, null, { timeout: 30000 })
  await page.evaluate((mode) => { const p = city.world.fromLatLon(49.2838, -123.1185); mode === 'bus' ? driveDebug.startBus('99', 0) : driveDebug.start(mode === 'walk' ? 'foot' : 'car', p.x, -p.z); if (city.traffic) city.traffic.nearby = () => [] }, mode)
  await page.waitForFunction(() => driveDebug.state === 'play', null, { timeout: 120000 }) // (down from the map)
  if (!o.park) await page.evaluate(() => {
    const CELL = 32, key = (a, b) => a * 8192 + b, segs = new Map(), held = new Set()
    const grid = (t) => { let g = segs.get(t); if (g) return g; g = new Map(); segs.set(t, g)
      for (const p of t.graph.pieces) { if (!(p.drive && p.kind <= 4) || p.z) continue
        for (let i = 0; i < p.pts.length / 2 - 1; i++) { const s = [p.pts[i * 2], p.pts[i * 2 + 1], p.pts[i * 2 + 2], p.pts[i * 2 + 3], p.w], n = Math.ceil(Math.hypot(s[2] - s[0], s[3] - s[1]) / 16)
          for (let k = 0; k <= n; k++) { const f = k / n || 0, kk = key(Math.floor((s[0] + (s[2] - s[0]) * f) / CELL), Math.floor((s[1] + (s[3] - s[1]) * f) / CELL)); let a = g.get(kk); if (!a) g.set(kk, (a = [])); a.push(s) } } }
      return g }
    const press = (code, on) => { if (on === held.has(code)) return; on ? held.add(code) : held.delete(code); dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, key: code })) }
    let stuck = 0
    setInterval(() => {
      const P = city.player; if (!P) return
      const x = P.x, y = -P.z, fx = Math.sin(P.heading), fy = -Math.cos(P.heading), L = 10 + Math.abs(P.speed) * 0.9, ax = x + fx * L, ay = y + fy * L
      let best = null, bd = 30
      for (const t of city.tiles.tiles.values()) { if (t.level !== 0 || t.state !== 'ready' || ax < t.ox || ax > t.ox + 1024 || ay < t.oy || ay > t.oy + 1024) continue
        const g = grid(t)
        for (let cx = Math.floor((ax - 24) / CELL); cx <= Math.floor((ax + 24) / CELL); cx++) for (let cy = Math.floor((ay - 24) / CELL); cy <= Math.floor((ay + 24) / CELL); cy++) for (const s of g.get(key(cx, cy)) || []) {
          const dx = s[2] - s[0], dy = s[3] - s[1], l = Math.hypot(dx, dy) || 1, al = (dx * fx + dy * fy) / l; if (Math.abs(al) < 0.6) continue
          const u = Math.max(0, Math.min(1, ((ax - s[0]) * dx + (ay - s[1]) * dy) / (l * l))), px = s[0] + dx * u, py = s[1] + dy * u, sg = al > 0 ? 1 : -1, off = s[4] * 0.22
          const d = Math.hypot(ax - px, ay - py) + (1 - Math.abs(al)) * 20; if (d < bd) { bd = d; best = [px + (dy / l) * sg * off, py - (dx / l) * sg * off] } } }
      if (best) { const dx = best[0] - x, dy = best[1] - y, err = Math.atan2(fx * dy - fy * dx, fx * dx + fy * dy); press('KeyA', err > 0.04); press('KeyD', err < -0.04) } else { press('KeyA', false); press('KeyD', false) }
      const sp = Math.abs(P.speed); press('KeyW', sp < 15); stuck = sp < 1 ? stuck + 1 : 0
      if (stuck > 40) { dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' })); dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' })); stuck = 0 }
    }, 50)
  })
} else if (mode === 'sail') {
  const [la, lo] = [49.286, -123.16]
  await page.evaluate(([la, lo]) => { const c = city, d = c.world.fromLatLon(la, lo).sub(c.controls.target); c.camera.position.add(d); c.controls.target.add(d); c.camera.zoom = 0.12; c.camera.updateProjectionMatrix(); c.controls.update() }, [la, lo])
  await settle(page, 1500)
  await page.click('button[title^="Sail"]')
  const [x, y] = await page.evaluate(([la, lo]) => { const p = city.world.fromLatLon(la, lo).project(city.camera); return [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight] }, [la, lo])
  await page.mouse.click(x, y); await page.waitForTimeout(4500)
  await page.keyboard.down('KeyW'); await page.waitForTimeout(800); await page.keyboard.up('KeyW')
  if (o.race) { await page.keyboard.press('KeyG'); await page.click('[data-race]'); await page.waitForTimeout(30000) } // a regatta under way: 3 rivals
}
if (game) await settle(page, 500) // (the tiles around the start are in: the run measures driving on, not the first load)
if (o.js) await page.evaluate(o.js)
if (+o.res) await page.evaluate((r) => { view.res = r }, +o.res)
if (+o.cpu > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: +o.cpu })
await page.evaluate(({ mode, ms }) => {
  const P = window.__b; P.dts = []; P.by = {}; P.draws = P.shadows = P.lights = 0; P.far0 = view.farFaces?.() || 0; P.p0 = city.player ? [city.player.x, city.player.z] : null; P.on = true
  if (mode !== 'map') return
  const v = view, c0 = v.controls.target.clone(), p0 = v.cam.position.clone(), o = c0.clone(); let i = 0
  const f = () => { const a = (i++ / 120) * 2 * Math.PI; o.set(300 * Math.cos(a) - 300, 0, 200 * Math.sin(a)); v.controls.target.copy(c0).add(o); v.cam.position.copy(p0).add(o); city.requestRender(); if (P.on) requestAnimationFrame(f) }
  requestAnimationFrame(f)
}, { mode, ms: 0 })
await page.waitForTimeout(+o.secs * 1000)
const r = await page.evaluate(() => { const P = window.__b; P.on = false; const i = view.renderer.info.render, c = view.renderer.domElement; return { dts: P.dts, by: P.by, draws: P.draws, shadows: P.shadows, lights: P.lights, far: (view.farFaces?.() || 0) - P.far0, moved: P.p0 && city.player ? Math.round(Math.hypot(city.player.x - P.p0[0], city.player.z - P.p0[1])) : 0, tris: i.triangles, calls: i.calls, mpx: c.width * c.height / 1e6, res: view.res } })
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return +(s[Math.min(s.length - 1, Math.floor(q * s.length))] || 0).toFixed(1) }
const out = { mode, dpr: +o.dpr, tier: o.tier, cpu: +o.cpu, weather: o.weather, hour: +o.hour, mpx: +r.mpx.toFixed(2), res: r.res, p50: pct(r.dts, 0.5), p95: pct(r.dts, 0.95), p99: pct(r.dts, 0.99), over33: r.dts.filter((d) => d > 33).length, frames: r.dts.length, draws: r.draws, tris: r.tris, calls: r.calls, shadowDraws: r.shadows, lightDraws: r.lights, farFacesPerSec: +(r.far / +o.secs).toFixed(2), movedM: r.moved } // (shadowDraws, lightDraws: how often the shadow map and the night lights' texture were redrawn in the run: each a late frame on a weak GPU)
// the passes, each one alone as it is and after each --vs variant in turn
const passes = async (js) => {
  if (js) await page.evaluate(js)
  await page.evaluate(() => { __b.frames = []; __b.sync = true }); await page.waitForTimeout(+o.psecs * 1000)
  const [fr, tris, calls] = await page.evaluate(() => { __b.sync = false; const i = view.renderer.info.render; return [__b.frames.slice(0, -1), i.triangles, i.calls] }), g = { tris, calls }
  // a pass drawn every frame: its median; one drawn now and then (the shadow map, the night lights, tile uploads): its mean per frame, and in `now` how often and its worst
  for (const k of new Set(fr.flatMap(Object.keys))) if (!(k in g)) { const v = fr.map((f) => f[k] || 0), big = v.filter((x) => x > 1)
    if (big.length > fr.length / 2) g[k] = pct(v, 0.5); else { g[k] = +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2); if (big.length) (g.now ||= {})[k] = `${big.length}/${fr.length} frames, max ${Math.max(...big).toFixed(0)} ms` } }
  g.sum = +Object.entries(g).reduce((a, [k, b]) => a + (k === 'tris' || k === 'calls' ? 0 : +b || 0), 0).toFixed(1)
  return g
}
out.by = Object.fromEntries(Object.entries(r.by).map(([k, v]) => [k, Math.round(v / r.draws / 1e3)]).filter(([, v]) => v >= 20).sort((a, b) => b[1] - a[1])) // thousands of triangles per frame, the big ones
out.gpu = await passes()
for (const v of o.vs ? o.vs.split(';;') : []) { const [name, ...js] = v.split('='); (out.vs ||= {})[name] = await passes(js.join('=')) }
console.log(JSON.stringify(out))
await browser.close(); srv.stop()
