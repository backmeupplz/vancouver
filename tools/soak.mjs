// node tools/soak.mjs --out DIR [--mins 6] [--dpr 2] [--size 1700x1270] [--tier auto] [--seed 1] [--all 1]
// A long map session, to catch what drifts with use (#548): shoots a few fixed views, does --mins of wheel zooms
// (0.03 to 0.6), drags, right-drag turns and tilts and flights across the region (tiles evict and reload), then
// returns to the same camera poses and shoots again. Moving plugins (life, ships, planes, transit, multiplayer, weather: drifting cloud shadows) are left
// out unless --all 1, so only real drift differs. Logs DIR/log.jsonl every 10 s (quality, adaptive res, tiles, each visible
// tile's detail sets, GPU memory, live GL buffers, JS heap) and prints one line per view: changed pixels start vs end,
// with a second start shot as the noise floor, and the tile sets that differ.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { args, server, open, settle } from './pw.mjs'
const [o] = args(process.argv.slice(2), { out: '/tmp/soak', mins: 6, dpr: 2, size: '1700x1270', tier: 'auto', seed: 1 })
mkdirSync(o.out, { recursive: true }); writeFileSync(`${o.out}/log.jsonl`, '')
const [W, H] = o.size.split('x').map(Number)
let seed = +o.seed
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
const VIEWS = { // name: hash, [azimuth°, polar°] (shoot.mjs --turn; default 0,60)
  downtown: ['#13645,11243,0.1295'],
  close: ['#13560,11150,0.55'],
  beach: ['#10400,12130,0.4'],
  turned: ['#13700,11000,0.25', [70, 45]],
  region: ['#13312,10752,0.04'],
}
const FLY = [[13645, 11243], [12400, 11600], [14800, 10900], [13300, 10300], [15600, 12000], [12000, 10800], [14200, 11900]]

// in the page before anything runs: count live GL buffers/textures (renderer.info misses instanced buffers)
const init = () => {
  const g = (window.__gl = { buffers: 0, textures: 0 })
  for (const P of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
    const wrap = (k, f) => { const o = P[k]; P[k] = function (...a) { f(a); return o.apply(this, a) } }
    wrap('createBuffer', () => g.buffers++); wrap('deleteBuffer', (a) => a[0] && g.buffers--)
    wrap('createTexture', () => g.textures++); wrap('deleteTexture', (a) => a[0] && g.textures--)
  }
}
const srv = await server(o.port)
const { browser, page, errs } = await open({ ...o, port: srv.port, hash: VIEWS.downtown[0], init })
if (!o.all) await page.route('**/plugins/index.json', async (r) => {
  const list = await (await r.fetch()).json()
  r.fulfill({ json: list.filter((p) => !/life|ships|planes|transit|multiplayer|weather/.test(p)) })
})
await page.reload(); await page.waitForFunction(() => window.city && window.view?.tiles && !document.querySelector('#loading'), null, { timeout: 240000 })

// quality decisions, as they happen
await page.evaluate(() => {
  const q = view.quality, d = q.demote.bind(q), T = view.tiles, drop = T.drop.bind(T)
  window.__log = { demotes: [], evicted: 0, tierAt: [] }
  q.demote = () => { const r = d(); window.__log.demotes.push([Math.round(performance.now() / 1000), view.res, r ? 'demoted' : 'kept']); return r }
  T.drop = (t) => { window.__log.evicted++; return drop(t) }
  city.on('quality', (t) => window.__log.tierAt.push([Math.round(performance.now() / 1000), t.name]))
})
const probe = () => page.evaluate(() => {
  const T = view.tiles, r = view.renderer, st = {}, sets = {}
  for (const t of T.tiles.values()) st[t.state] = (st[t.state] || 0) + 1
  for (const t of T.tiles.values()) {
    if (!t.visible || t.state !== 'ready') continue
    const on = (m) => (m ? (m.visible ? 1 : 0) : '-') // '-' none in the tile, 0 hidden, 1 shown
    let meshes = 0, buildings = 0, nulls = 0
    t.group.traverse((m) => { if (m.isMesh) { meshes++; if (m.material === T.mats.building || m.material === T.farMats.building) buildings++; const p = m.geometry.attributes.position; if (p && !p.array && !r.properties.get(m.geometry)) nulls++ } })
    sets[T.key(t.level, t.i, t.j)] = { ground: on(t.ground), coarse: on(t.coarse), balcony: on(t.balcony), poles: on(t.poles), beach: t.beach ? on(t.beach[0]) : '-', lot: on(t.lot), kerb: on(t.kerb), trees: on(t.trees), treesN: t.trees?.geometry.instanceCount, treesIn: !!t.trees?.parent, meshes, buildings, nulls }
  }
  const m = performance.memory || {}
  return {
    t: Math.round(performance.now() / 1000), zoom: +view.cam.zoom.toFixed(3),
    quality: { setting: view.quality.setting, tier: view.quality.tier.name, res: view.res, pixelRatio: r.getPixelRatio() },
    log: { ...window.__log },
    tiles: { states: st, visible: Object.keys(sets).length, made: T.made.length, warming: T.warming.length, cached: [0, 1].map((l) => [...T.tiles.values()].filter((t) => t.level === l && t.state === 'ready').length), detail: { balconies: T.balconies, fine: T.fine, cars: T.cars } },
    gpu: { ...r.info.memory, programs: r.info.programs?.length, ...window.__gl },
    heapMB: Math.round((m.usedJSHeapSize || 0) / 1e6), sets,
  }
})
const log = (p, tag) => appendFileSync(`${o.out}/log.jsonl`, JSON.stringify({ tag, ...p }) + '\n')

// a view's camera pose (to come back to exactly) and moving there
const goto = async (name) => {
  const [hash, turn] = VIEWS[name]
  await page.evaluate(([h, turn]) => {
    location.hash = h; dispatchEvent(new HashChangeEvent('hashchange'))
    if (turn) { const c = view.controls, d = view.cam.position.distanceTo(c.target), a = turn[0] * Math.PI / 180, p = turn[1] * Math.PI / 180; view.cam.position.set(c.target.x + d * Math.sin(p) * Math.sin(a), c.target.y + d * Math.cos(p), c.target.z + d * Math.sin(p) * Math.cos(a)) }
    view.controls.update(); city.requestRender()
  }, [hash, turn])
  await page.waitForTimeout(300)
  return page.evaluate(() => ({ p: view.cam.position.toArray(), t: view.controls.target.toArray(), z: view.cam.zoom }))
}
const pose = async (P) => {
  await page.evaluate((P) => { view.cam.position.fromArray(P.p); view.controls.target.fromArray(P.t); view.cam.zoom = P.z; view.cam.updateProjectionMatrix(); view.controls.update(); city.requestRender() }, P)
}
const shoot = async (file) => { await settle(page, 1500); await page.screenshot({ path: file }) }

await settle(page, 1000)
const poses = {}
for (const v of Object.keys(VIEWS)) { poses[v] = await goto(v); await shoot(`${o.out}/${v}-start.png`); const p = await probe(); log(p, `start ${v}`); poses[v].sets = p.sets }
for (const v of Object.keys(VIEWS)) { await pose(poses[v]); await shoot(`${o.out}/${v}-again.png`) } // the noise floor

// ---------- the session ----------
const zoom = () => page.evaluate(() => view.cam.zoom)
const zoomTo = async (z, x, y) => { await page.mouse.move(x, y); for (let i = 0; i < 300; i++) { const c = await zoom(); if (Math.abs(Math.log(c / z)) < 0.05) return; await page.mouse.wheel(0, c > z ? 60 + rnd() * 60 : -(60 + rnd() * 60)); await page.waitForTimeout(16 + rnd() * 30) } }
const drag = async (button, dx, dy, steps = 25) => {
  const x = W * (0.3 + rnd() * 0.4), y = H * (0.3 + rnd() * 0.4)
  await page.mouse.move(x, y); await page.mouse.down({ button })
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps); await page.waitForTimeout(16) }
  await page.mouse.up({ button })
}
const end = Date.now() + o.mins * 60000
let next = Date.now(), n = 0
while (Date.now() < end) {
  const a = rnd()
  if (a < 0.35) await zoomTo(Math.exp(Math.log(0.03) + rnd() * Math.log(0.6 / 0.03)), W * (0.2 + rnd() * 0.6), H * (0.2 + rnd() * 0.6))
  else if (a < 0.6) await drag('left', (rnd() - 0.5) * W, (rnd() - 0.5) * H)
  else if (a < 0.75) await drag('right', (rnd() - 0.5) * W * 0.5, (rnd() - 0.5) * H * 0.4)
  else if (a < 0.85) { // fly across the region: out, pan far, in
    await zoomTo(0.03 + rnd() * 0.02, W / 2, H / 2)
    const f = FLY[Math.floor(rnd() * FLY.length)]
    await page.evaluate(([x, y, z]) => { location.hash = `#${x},${y},${z}`; dispatchEvent(new HashChangeEvent('hashchange')) }, [f[0], f[1], (await zoom()).toFixed(3)])
    await zoomTo(0.15 + rnd() * 0.4, W / 2, H / 2)
  } else await page.waitForTimeout(500 + rnd() * 2000) // a look
  n++
  if (Date.now() >= next) { next += 10000; const p = await probe(); delete p.sets; log(p, `soak ${n}`); console.log(JSON.stringify({ t: p.t, q: p.quality, demotes: p.log.demotes.length, tierAt: p.log.tierAt, ev: p.log.evicted, tiles: p.tiles.cached, gpu: p.gpu, heap: p.heapMB })) }
}

// ---------- back to the views ----------
const out = []
for (const v of Object.keys(VIEWS)) {
  await pose(poses[v]); await shoot(`${o.out}/${v}-end.png`)
  const p = await probe(); log(p, `end ${v}`)
  const a = poses[v].sets, b = p.sets, diff = []
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diff.push(`${k}: ${JSON.stringify(a[k] || 'absent')} -> ${JSON.stringify(b[k] || 'absent')}`)
  out.push({ v, diff })
}
// changed pixels (any channel off by more than 24 of 255), compared in the page
const px = async (f1, f2) => page.evaluate(async ([a, b]) => {
  const img = async (u) => { const i = new Image(); i.src = u; await i.decode(); return i }
  const [A, B] = await Promise.all([img(a), img(b)]), c = new OffscreenCanvas(A.width, A.height), x = c.getContext('2d')
  x.drawImage(A, 0, 0); const da = x.getImageData(0, 0, A.width, A.height).data
  x.drawImage(B, 0, 0); const id = x.getImageData(0, 0, A.width, A.height), db = id.data
  let n = 0
  for (let i = 0; i < da.length; i += 4) { const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2])); if (d > 24) { n++; db[i] = 255; db[i + 1] = 0; db[i + 2] = 255 } }
  x.putImageData(id, 0, 0)
  const blob = await c.convertToBlob({ type: 'image/png' })
  const png = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result.split(',')[1]); f.readAsDataURL(blob) })
  return { pct: +(100 * n / (da.length / 4)).toFixed(3), png }
}, [f1, f2])
const url = (f) => 'data:image/png;base64,' + readFileSync(f).toString('base64')
for (const r of out) {
  const noise = (await px(url(`${o.out}/${r.v}-start.png`), url(`${o.out}/${r.v}-again.png`))).pct
  const d = await px(url(`${o.out}/${r.v}-start.png`), url(`${o.out}/${r.v}-end.png`)), drift = d.pct
  writeFileSync(`${o.out}/${r.v}-diff.png`, Buffer.from(d.png, 'base64'))
  console.log(`${r.v}: changed ${drift}% (noise ${noise}%) sets differ: ${r.diff.length}${r.diff.length ? '\n  ' + r.diff.slice(0, 8).join('\n  ') : ''}`)
}
const fin = await probe(); delete fin.sets
console.log('final', JSON.stringify({ q: fin.quality, log: fin.log, gpu: fin.gpu, heap: fin.heapMB, tiles: fin.tiles }), 'errors', errs.length, errs[0]?.slice(0, 160) || '')
await browser.close(); srv.stop()
