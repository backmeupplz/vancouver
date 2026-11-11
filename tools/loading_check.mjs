// node tools/loading_check.mjs [--size phone] [--embed 1] [--shots dir]: the loading chip (#perf) on a slow network
// (every tile request held 400 ms). The map, then a van drive, then a walk, each somewhere new: the chip must show
// within 1 s of loading starting, its percentage never go backwards within an episode and reach 100, and it must
// be hidden within 1 s of everything being drawn.
import { mkdirSync } from 'node:fs'
import { args, server, open } from './pw.mjs'
const [o] = args(process.argv.slice(2), { size: '', embed: '', shots: '', delay: '400' })
o.size ||= o.embed ? '360x700' : '1400x900'
if (o.shots) mkdirSync(o.shots, { recursive: true })
const srv = await server(o.port)
const { browser, page, errs } = await open({ ...o, port: srv.port, query: o.embed ? '?embed&drivedebug' : '?drivedebug', hash: '#13645,11243,0.1295' })
await page.route(/\/tiles\/\d\/.*\.bin/, async (r) => { await new Promise((k) => setTimeout(k, +o.delay)); r.continue().catch(() => {}) })
let bad = 0
const tag = o.embed ? 'embed' : o.size
const sample = () => {
  window.__s = []; const c = document.querySelector('#perf'), t0 = performance.now()
  setInterval(() => window.__s.push([performance.now() - t0, city.loading.state().busy, c.classList.contains('busy') && getComputedStyle(c).display !== 'none' && c.checkVisibility(), +(/(\d+)%/.exec(c.querySelector('.n').textContent)?.[1] ?? -1)]), 50)
}
const phases = [
  ['map', () => {}],
  ['van', (p) => p.evaluate(() => { const p = city.world.fromLatLon(49.2838, -123.1185); driveDebug.start('car', p.x, -p.z) })],
  ['walk', (p) => p.evaluate(() => { const p = city.world.fromLatLon(49.2745, -123.153); driveDebug.start('foot', p.x, -p.z) })],
]
try {
  await page.waitForFunction(() => window.driveDebug && !!window.city?.loading, null, { timeout: 240000 })
  await page.evaluate(sample)
  for (const [name, go] of phases) {
    const from = await page.evaluate(() => window.__s.length)
    if (name !== 'map') await go(page)
    else await page.reload().then(() => page.waitForFunction(() => window.driveDebug && !!window.city?.loading)).then(() => page.evaluate(sample))
    if (o.shots) { // a shot while the chip is up
      await page.waitForFunction(() => document.querySelector('#perf').classList.contains('busy'), null, { timeout: 8000, polling: 100 }).catch(() => {})
      await page.waitForTimeout(500); await page.screenshot({ path: `${o.shots}/${tag}-${name}-loading.png` })
    }
    // wait for a busy spell, then 3 s of calm
    await page.waitForFunction(() => { const s = window.__s, n = s.length; return n > 80 && s.some((x) => x[1]) && s.slice(-60).every((x) => !x[1] && !x[2]) }, null, { timeout: 240000, polling: 500 }).catch(() => {})
        const s = await page.evaluate((f) => window.__s.slice(f), name === 'map' ? 0 : from).catch(() => [])
    const fails = []
    const b0 = s.findIndex((x) => x[1])
    if (b0 < 0) fails.push('never busy')
    else {
      const t0 = s[b0][0], bEnd = s.findLastIndex((x) => x[1]), te = s[bEnd][0]
      if (te - t0 > 1000 && !s.some((x) => x[2] && x[0] <= t0 + 1000)) fails.push(`chip not visible within 1 s of loading (busy ${Math.round(te - t0)} ms)`)
      let prev = -1, max = -1
      for (const x of s) { if (!x[2]) { prev = -1; continue } if (x[3] < prev) fails.push(`percent went back ${prev} -> ${x[3]}`); prev = x[3] === 100 ? -1 : x[3]; max = Math.max(max, x[3]) }
      if (te - t0 > 1000 && max < 100) fails.push(`never reached 100 (max ${max})`)
      const hide = te - t0 < 300 ? s[bEnd] : s.find((x, i) => i > bEnd && !x[2])
      if (!hide || hide[0] - te > 1000) fails.push(`still visible ${hide ? Math.round(hide[0] - te) : '>'} ms after done`)
      console.log(`${fails.length ? 'FAIL' : 'ok'} ${tag} ${name}: busy ${Math.round(te - t0)} ms, shown ${s.filter((x) => x[2]).length * 50} ms, max ${max}%${fails.length ? ' ' + [...new Set(fails)].join(' | ') : ''}`)
    }
    if (b0 < 0) console.log(`FAIL ${tag} ${name}: never busy`)
    bad += fails.length + (b0 < 0)
  }
  const e = errs.filter((x) => !/404|Failed to load/.test(x))
  if (e.length) { bad++; console.log('page errors: ' + e.join(' | ').slice(0, 400)) }
} finally { await browser.close(); srv.stop() }
process.exit(bad ? 1 : 0)
