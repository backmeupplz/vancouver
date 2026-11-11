// node tools/foot_check.mjs [--out dir] [--at 49.2745,-123.153] [--size phone]: on foot in the real page, with the
// keys and the mouse: W walks away from the camera, A to its left, a drag looks round without moving the walker, the
// camera comes back behind a walk, the wheel zooms in to the eye and out again. A shot of each step into --out.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { args, server, open, settle } from './pw.mjs'
const [o] = args(process.argv.slice(2), { out: '', at: '49.2745,-123.153', size: '1400x900', embed: '' })
if (o.embed) o.size = '640x360'
if (o.out) mkdirSync(o.out, { recursive: true })
const srv = await server(o.port)
const { browser, page, errs } = await open({ ...o, port: srv.port, query: o.embed ? '?embed&drivedebug' : '?drivedebug', init: `localStorage.setItem('drive.foot', JSON.stringify({ reach: { grind: 1 }, stages: { grind: [215.5, 0, 0, 0] } }))` })
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
  // the beach below the Stanley Park seawall: walking straight out to sea stops at the knee (never more than 0.6 m below the sea)
  await page.evaluate(([la, lo]) => { const D = driveDebug, p = city.world.fromLatLon(la, lo); D.man.x = p.x; D.man.y = -p.z }, [49.2894, -123.1450])
  await settle(page, 2500)
  const sea = await page.evaluate(() => { // a dry point on the beach with the sea's deep water (seabed 0.8 m under the surface) 20 m out in some direction
    const D = driveDebug, m = D.man, lvl = city.sea.at(m.x, -m.y), h = (x, y) => city.world.heightAt(x, -y), x0 = m.x, y0 = m.y
    for (let r = 0; r <= 90; r += 6) for (let a = 0; a < 16; a++) {
      const px = x0 + Math.cos((a / 16) * 6.283) * r, py = y0 + Math.sin((a / 16) * 6.283) * r
      if (D.isWater(px, py) || !(h(px, py) > lvl + 0.05 && h(px, py) < lvl + 0.6)) continue
      for (let k = 0; k < 32; k++) { const yaw = (k / 32) * 6.283, x = px - Math.sin(yaw) * 20, y = py + Math.cos(yaw) * 20; if (h(x, y) < lvl - 0.8) { m.x = px; m.y = py; m.yaw = D.chase.yaw = yaw; return { yaw, r: 20 } } }
    }
    return null
  })
  await settle(page, 1500)
  // the rule itself: unmapped seabed more than WADE under the surface beside mapped water is a wall; the beach is not
  const rule = await page.evaluate(() => {
    const D = driveDebug, m = D.man, lvl = city.sea.at(m.x, -m.y), h = (x, y) => city.world.heightAt(x, -y)
    let pocket = null, dry = null
    for (let r = 0; r <= 120; r += 3) for (let a = 0; a < 32; a++) {
      const x = m.x + Math.cos((a / 32) * 6.283) * r, y = m.y + Math.sin((a / 32) * 6.283) * r
      if (!pocket && !D.isWater(x, y) && h(x, y) < lvl - 0.7 && D.deep(x, y)) pocket = true
      if (!dry && !D.isWater(x, y) && h(x, y) > lvl + 0.1 && !D.deep(x, y)) dry = true
    }
    return { pocket, dry }
  })
  assert(rule.dry, 'dry beach is not deep water')
  console.log(`ok: wading rule, deep seabed pocket found: ${!!rule.pocket}`)
  if (sea) {
    const x0 = (await S()).x, y0 = (await S()).y
    await hold('KeyW', 12000)
    const w = await page.evaluate(([x0, y0]) => { const D = driveDebug, m = D.man; return { moved: Math.hypot(m.x - x0, m.y - y0), depth: city.sea.at(m.x, -m.y) - city.world.heightAt(m.x, -m.y), x: m.x, y: m.y } }, [x0, y0])
    await shot('6-wade')
    assert(w.depth <= 0.6, `cannot walk deeper than 0.6 m below sea level: ${w.depth.toFixed(2)} m`)
    console.log(`ok: wading stopped at ${w.depth.toFixed(2)} m of water (deep water ${sea.r} m out, walked ${w.moved.toFixed(1)} m)`)
  } else console.log('skip: no deep water within 30 m of the beach')
  // hikes in stages: Explore, Hike a trail, Grouse Grind opens a picker (stage 1 reached, so stages 1-2 open and 3-4 locked); Stage 2
  // starts at the trail's quarter mark with the stage in the HUD; a short trail starts straight away
  const menu = async (id) => { await page.click('button[title^="Explore"]'); await page.click('[data-m="hike"]'); await page.click(`[data-h="${id}"]`) }
  await page.keyboard.press('Escape'); await settle(page, 2500)
  await menu('grind'); await page.waitForTimeout(400); await shot('7-stage-picker')
  const pick = await page.evaluate(() => [...document.querySelectorAll('.dlv-menu [data-s]')].map((b) => ({ s: b.dataset.s, off: b.disabled, text: b.textContent })))
  assert(pick.length === 5 && pick.filter((b) => b.off).map((b) => b.s).join() === '2,3', `stage picker: ${JSON.stringify(pick.map((b) => [b.s, b.off]))}`)
  assert(/3:35/.test(pick[1].text), `stage 1's best shows: ${pick[1].text}`)
  await page.click('.dlv-menu [data-s="1"]'); await settle(page, 5000); await shot('8-stage-2')
  const st = await page.evaluate(() => { const D = driveDebug, H = D.hike, a = city.world.fromLatLon(...H.from), b = city.world.fromLatLon(...H.to), f = [a.x + (b.x - a.x) * 0.25, -a.z + (-b.z + a.z) * 0.25]; return { stage: H.stage, d: Math.hypot(D.man.x - f[0], D.man.y - f[1]), title: document.querySelector('.dlv-job .what')?.textContent } })
  assert(st.stage === 1 && st.d < 100 && /stage 2 of 4/.test(st.title), `stage 2 starts at the quarter mark: ${JSON.stringify(st)}`)
  await page.keyboard.press('Escape'); await settle(page, 2500)
  await menu('lynn'); await settle(page, 4000)
  const lynn = await page.evaluate(() => ({ id: driveDebug.hike?.id, stage: driveDebug.hike?.stage ?? null, menu: !!document.querySelector('.dlv-menu [data-s]') }))
  assert(lynn.id === 'lynn' && lynn.stage === null && !lynn.menu, `a short trail starts directly: ${JSON.stringify(lynn)}`)
  console.log(`ok: hike stages: picker of ${pick.length}, stage 2 starts ${st.d.toFixed(0)} m from the quarter mark, short trail direct`)
  assert(!errs.some((m) => !/404|Failed to load/.test(m)), 'page errors: ' + errs.join(' | ').slice(0, 300))
  console.log(`ok: walked ${Math.hypot(b.x - a.x, b.y - a.y).toFixed(1)} m in 1.5 s, drag ${wrap(c.cy - b.cy).toFixed(2)} rad, recentred to ${wrap(e.cy - e.yaw).toFixed(2)} rad, eye ${f.cam[2].toFixed(2)} m, far ${g.dist.toFixed(1)} m`)
} finally { await browser.close(); srv.stop() }
