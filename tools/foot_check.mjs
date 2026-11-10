// node tools/foot_check.mjs [--out dir] [--at 49.2745,-123.153] [--size phone]: on foot in the real page, with the
// keys and the mouse: W walks away from the camera, A to its left, a drag looks round without moving the walker, the
// camera comes back behind a walk, the wheel zooms in to the eye and out again. A shot of each step into --out.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { args, server, open, settle } from './pw.mjs'
const [o] = args(process.argv.slice(2), { out: '', at: '49.2745,-123.153', size: '1400x900' })
if (o.out) mkdirSync(o.out, { recursive: true })
const srv = await server(o.port)
const { browser, page, errs } = await open({ ...o, port: srv.port, query: '?drivedebug' })
try {
  await settle(page, 800)
  await page.waitForFunction(() => window.driveDebug, null, { timeout: 30000 })
  await page.evaluate(([la, lo]) => { const p = city.world.fromLatLon(la, lo); driveDebug.start('foot', p.x, -p.z, 0) }, o.at.split(',').map(Number))
  await settle(page, 2500)
  const S = () => page.evaluate(() => { const D = driveDebug, m = D.man, c = D.chase; return { x: m.x, y: m.y, yaw: m.yaw, cy: c.yaw, cp: c.pitch, dist: c.dist, shown: D.walker.visible, cam: [c.pos.x, -c.pos.z, c.pos.y - m.h] } })
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a)), shot = async (n) => { if (o.out) await page.screenshot({ path: `${o.out}/${n}.png` }) }
  const hold = async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); await page.waitForTimeout(300) }
  const [w, h] = await page.evaluate(() => [innerWidth, innerHeight])
  let a = await S(); await shot('0-start')
  const chaseDist = a.dist
  // W: away from the camera
  await hold('KeyW', 1500)
  let b = await S(); await shot('1-walked')
  const away = (p, q) => (q.x - p.x) * (p.x - p.cam[0]) + (q.y - p.y) * (p.y - p.cam[1])
  assert(Math.hypot(b.x - a.x, b.y - a.y) > 0.5 && away(a, b) > 0, `W walks away from the camera: moved ${Math.hypot(b.x - a.x, b.y - a.y).toFixed(2)} m`)
  // a drag looks round: the camera turns, the walker stays
  await page.mouse.move(w / 2, h / 2); await page.mouse.down(); await page.mouse.move(w / 2 + 300, h / 2 - 60, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(400)
  let c = await S(); await shot('2-dragged')
  assert(Math.abs(wrap(c.cy - b.cy)) > 0.8 && Math.abs(wrap(c.yaw - b.yaw)) < 0.01 && Math.hypot(c.x - b.x, c.y - b.y) < 0.05, `a drag turns the camera only: ${wrap(c.cy - b.cy).toFixed(2)} rad`)
  assert(c.cp < b.cp, 'a drag up looks up')
  // A: across the view, to the camera's left; then the camera comes round behind
  await hold('KeyA', 400)
  let d = await S()
  assert(wrap(d.yaw - d.cy) > 0.4 && wrap(d.yaw - d.cy) < 1.9, `A faces the camera's left: ${wrap(d.yaw - d.cy).toFixed(2)} rad`)
  await hold('KeyW', 3500)
  let e = await S(); await shot('3-recentred')
  assert(Math.abs(wrap(e.cy - e.yaw)) < 0.35, `the camera comes round behind: ${wrap(e.cy - e.yaw).toFixed(2)} rad off`)
  // the wheel: in to the eye (the walker hidden), out again (a phone pinches: not driven here)
  let f = { cam: [0, 0, 1.62] }, g = { dist: chaseDist }
  if (!o.size.startsWith('phone')) {
  for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40) }
  await page.waitForTimeout(500)
  f = await S(); await shot('4-eye')
  assert(!f.shown && f.cam[2] > 1.3 && f.cam[2] < 1.9, `zoomed in: at the eye (${f.cam[2].toFixed(2)} m up), walker hidden`)
  for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(40) }
  await page.waitForTimeout(600)
  g = await S(); await shot('5-far')
  assert(g.shown && g.dist > 4.3, 'zoomed out again')
  }
  assert(!errs.some((m) => !/404|Failed to load/.test(m)), 'page errors: ' + errs.join(' | ').slice(0, 300))
  console.log(`ok: walked ${Math.hypot(b.x - a.x, b.y - a.y).toFixed(1)} m in 1.5 s, drag ${wrap(c.cy - b.cy).toFixed(2)} rad, recentred to ${wrap(e.cy - e.yaw).toFixed(2)} rad, eye ${f.cam[2].toFixed(2)} m, far ${g.dist.toFixed(1)} m`)
} finally { await browser.close(); srv.stop() }
