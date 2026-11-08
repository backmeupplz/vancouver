// node tools/shoot.mjs --out DIR [--port P] [--dpr 1|2] [--size 1400x900|phone|phone-land] [--tier auto|high|low]
//   [--weather clear|rain|snow|fog|storm|cloudy] [--hour H] [--season spring] [--turn AZ,POLAR] [--cycles N] [--res R] SPEC...
// SPEC: name=#X,Y,zoom (map) | name=drive:lat,lon[,yaw rad, 0 north, + west] (on the deck there, if any) | walk:lat,lon[,yaw] | taxi:lat,lon | sail:lat,lon | bus:ROUTE:DIR
// Map shots: --turn turns and tilts the view as a right-drag does (degrees: azimuth from north, polar from straight
// down; the default view is 0,60), --cycles wheel-zooms out to 0.05 and in to 0.3 N times and back, as a viewer does,
// then shoots 1.5 s later (tiles still arriving), --res pins the adaptive resolution (main.js) for the shot.
// Prints one line per shot: path + console error count.
import { mkdirSync } from 'node:fs'
import { args, server, open, settle } from './pw.mjs'
const [o, specs] = args(process.argv.slice(2), { out: '.', dpr: 1, size: '1400x900', tier: 'auto', weather: 'clear', hour: 13, cycles: 0, res: 0 })
if (!specs.length) { console.error('usage: see header of tools/shoot.mjs'); process.exit(1) }
mkdirSync(o.out, { recursive: true })
const srv = await server(o.port)
try {
  for (const spec of specs) { // fresh page per shot so modes never leak into each other
    const [name, v] = [spec.slice(0, spec.indexOf('=')), spec.slice(spec.indexOf('=') + 1)]
    const map = v.startsWith('#'), [kind, a, b, c] = v.split(/[:,]/), game = !map
    const { browser, page, errs } = await open({ ...o, port: srv.port, query: game ? '?drivedebug' : '', hash: map ? v : '' })
    await settle(page, 800)
    if (game && kind !== 'sail') await page.waitForFunction(() => window.driveDebug, null, { timeout: 30000 })
    if (kind === 'sail') {
      await page.evaluate(([la, lo]) => { const c = city, d = c.world.fromLatLon(la, lo).sub(c.controls.target); c.camera.position.add(d); c.controls.target.add(d); c.camera.zoom = 0.12; c.camera.updateProjectionMatrix(); c.controls.update(); c.requestRender() }, [+a, +b])
      await settle(page, 1500)
      await page.click('button[title^="Sail"]')
      const [x, y] = await page.evaluate(([la, lo]) => { const p = city.world.fromLatLon(la, lo).project(city.camera); return [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight] }, [+a, +b])
      await page.mouse.click(x, y)
      await page.waitForTimeout(4500)
    } else if (kind === 'bus') {
      await page.evaluate(([r, d]) => driveDebug.startBus(r, +d || 0), [a, b])
    } else if (game) {
      await page.evaluate(([k, la, lo, yaw]) => { const p = city.world.fromLatLon(la, lo), y = -p.z; k === 'taxi' ? driveDebug.startTaxi(p.x, y) : driveDebug.start(k === 'walk' ? 'foot' : 'car', p.x, y, yaw) }, [kind, +a, +b, +c || 0])
      if (kind === 'drive') { // on the deck there if there is one (a bridge, not the water under it), once its tile is in
        const on = () => page.evaluate(([la, lo]) => { const p = city.world.fromLatLon(la, lo), c = driveDebug.car, r = driveDebug.nearestRoad(p.x, -p.z, 3, true); if (r && r.d < 1.2) Object.assign(c, { x: p.x, y: -p.z, h: r.z + 0.58 }); return !!r }, [+a, +b])
        for (let i = 0; i < 40 && !(await on()); i++) await page.waitForTimeout(250)
      }
    }
    if (map && o.turn) {
      await page.evaluate(([az, po]) => {
        const c = view.controls, d = view.cam.position.distanceTo(c.target), a = az * Math.PI / 180, p = po * Math.PI / 180
        view.cam.position.set(c.target.x + d * Math.sin(p) * Math.sin(a), c.target.y + d * Math.cos(p), c.target.z + d * Math.sin(p) * Math.cos(a)); c.update(); city.requestRender()
      }, o.turn.split(',').map(Number))
      await settle(page, 800)
    }
    if (map && +o.cycles) {
      const z0 = +v.split(',')[2], [w, h] = (o.size.includes('x') ? o.size : '390x844').split('x').map(Number)
      await page.mouse.move(w / 2, h / 2)
      const zoomTo = async (z) => { for (let i = 0; i < 400; i++) { const c = await page.evaluate(() => view.cam.zoom); if (Math.abs(Math.log(c / z)) < 0.03) return; await page.mouse.wheel(0, c > z ? 40 : -40); await page.waitForTimeout(16) } }
      for (let k = 0; k < +o.cycles; k++) { await zoomTo(0.05); await zoomTo(0.3) }
      await zoomTo(z0)
    }
    if (+o.res) await page.evaluate((r) => { view.res = r }, +o.res)
    if (map && +o.cycles) await page.waitForTimeout(1500)
    else await settle(page, game ? 2500 : 1000)
    const file = `${o.out}/${name}.png`
    await page.screenshot({ path: file })
    console.log(`${file} errors=${errs.length}${errs.length ? ' ' + errs[0].slice(0, 120) : ''}`)
    await browser.close()
  }
} finally { srv.stop() }
