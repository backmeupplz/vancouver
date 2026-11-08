// node tools/bench.mjs [--dpr 2] [--tier high|low] [--cpu 4] [--secs 20] map|drive|sail
// One JSON line: {p50,p95,p99,over33,frames,tris,calls,gpuMs?}. map = continuous pan at #13645,11243,0.1295;
// drive = autopilot in a van downtown; sail = sailing in English Bay. Frame times are unlocked (no vsync).
import { args, server, open, settle } from './pw.mjs'
const [o, [mode = 'map']] = args(process.argv.slice(2), { dpr: 2, tier: 'high', cpu: 1, secs: 20 })
const srv = await server(o.port)
const init = () => { // per-frame dt via rAF, GPU time via timer query on renderer.render
  const P = (window.__b = { dts: [], last: 0, on: false, gpu: [], pend: [] }), raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (fn) => raf((ts) => { if (ts !== P.last) { if (P.on && P.last) P.dts.push(ts - P.last); P.last = ts }; P.poll?.(); fn(ts) })
  const hook = setInterval(() => {
    const R = window.view?.renderer; if (!R) return; clearInterval(hook)
    const gl = R.getContext(), tq = gl.getExtension('EXT_disjoint_timer_query_webgl2'), rr = R.render.bind(R); if (!tq) return
    P.poll = () => { while (P.pend.length && gl.getQueryParameter(P.pend[0], gl.QUERY_RESULT_AVAILABLE)) { const q = P.pend.shift(); if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) P.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q) } }
    R.render = (s, c) => { if (!P.on) return rr(s, c); const q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); rr(s, c); gl.endQuery(tq.TIME_ELAPSED_EXT); P.pend.push(q) }
  }, 5)
}
const { browser, ctx, page } = await open({ ...o, port: srv.port, query: mode === 'drive' ? '?drivedebug' : '', hash: '#13645,11243,0.1295', init,
  gpuFlags: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] })
await settle(page, 1000)
if (mode === 'drive') { // downtown W Georgia, then pure-pursuit autopilot on drivable roads (keyboard events)
  await page.evaluate(() => { const p = city.world.fromLatLon(49.2838, -123.1185); driveDebug.start('car', p.x, -p.z); if (city.traffic) city.traffic.nearby = () => [] })
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
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
}
if (+o.cpu > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: +o.cpu })
await page.evaluate(({ mode, ms }) => {
  const P = window.__b; P.dts = []; P.gpu = []; P.on = true
  if (mode !== 'map') return
  const v = view, c0 = v.controls.target.clone(), p0 = v.cam.position.clone(), o = c0.clone(); let i = 0
  const f = () => { const a = (i++ / 120) * 2 * Math.PI; o.set(300 * Math.cos(a) - 300, 0, 200 * Math.sin(a)); v.controls.target.copy(c0).add(o); v.cam.position.copy(p0).add(o); city.requestRender(); if (P.on) requestAnimationFrame(f) }
  requestAnimationFrame(f)
}, { mode, ms: 0 })
await page.waitForTimeout(+o.secs * 1000)
const r = await page.evaluate(() => { const P = window.__b; P.on = false; const i = view.renderer.info.render; return { dts: P.dts, gpu: P.gpu, tris: i.triangles, calls: i.calls } })
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return +(s[Math.min(s.length - 1, Math.floor(q * s.length))] || 0).toFixed(1) }
const out = { mode, dpr: +o.dpr, tier: o.tier, cpu: +o.cpu, p50: pct(r.dts, 0.5), p95: pct(r.dts, 0.95), p99: pct(r.dts, 0.99), over33: r.dts.filter((d) => d > 33).length, frames: r.dts.length, tris: r.tris, calls: r.calls }
if (r.gpu.length) out.gpuMs = +(r.gpu.reduce((a, b) => a + b, 0) / r.gpu.length).toFixed(2)
console.log(JSON.stringify(out))
await browser.close(); srv.stop()
