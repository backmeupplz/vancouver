// node tools/sail_check.mjs: every race and docking mark of the sail plugin (goals.js COURSES) is on open water, in the
// baked tiles. Prints one line per course (length, dry points within 30 m of each mark); exits 1 on a dry mark.
import { server, open, settle } from './pw.mjs'
const srv = await server()
const { browser, page } = await open({ port: srv.port, query: '?drivedebug' })
let bad = 0
try {
  await settle(page, 800)
  const [la, lo] = [49.284, -123.155]
  await page.evaluate(([la, lo]) => { const c = city, d = c.world.fromLatLon(la, lo).sub(c.controls.target); c.camera.position.add(d); c.controls.target.add(d); c.camera.zoom = 0.12; c.camera.updateProjectionMatrix(); c.requestRender() }, [la, lo])
  await settle(page, 1500)
  await page.click('button[title^="Sail"]')
  const [x, y] = await page.evaluate(([la, lo]) => { const p = city.world.fromLatLon(la, lo).project(city.camera); return [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight] }, [la, lo])
  await page.mouse.click(x, y)
  await page.waitForFunction(() => window.sailDebug && sailDebug.B.speed > 0.2, null, { timeout: 30000 })
  for (const id of await page.evaluate(() => sailDebug.goals.courses.map((c) => c.id))) {
    await page.evaluate((id) => { const p = sailDebug.goals.startRace(id); sailDebug.teleport(p.x, p.z, p.h) }, id)
    await page.waitForTimeout(6000) // the tiles there
    const r = await page.evaluate(() => { const c = sailDebug.goals.S.race.c, w = sailDebug.wet; let L = 0
      for (let i = 1; i < c.pts.length; i++) L += Math.hypot(c.pts[i].x - c.pts[i - 1].x, c.pts[i].z - c.pts[i - 1].z)
      return { len: Math.round(L), dry: c.pts.map((p) => (w(p.x, p.z) ? 0 : 9) + [0, 1, 2, 3, 4, 5, 6, 7].filter((k) => !w(p.x + 30 * Math.cos(k * 0.785), p.z + 30 * Math.sin(k * 0.785))).length) } })
    if (r.dry.some((n) => n > 2)) bad++
    console.log(id, JSON.stringify(r))
  }
} finally { await browser.close(); srv.stop() }
process.exit(bad ? 1 : 0)
