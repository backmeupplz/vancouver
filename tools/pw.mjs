// Shared by shoot.mjs / bench.mjs: args, static server, Chrome launch, page setup, tile settling.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
const { chromium } = createRequire('/Users/borodutch/code/agentboard/')('playwright')
export const SIZES = { phone: [390, 844, 3], 'phone-land': [844, 390, 3] }

export function args(argv, flags) { // --k v pairs (flags = known keys with defaults) + positionals
  const o = { ...flags }, rest = []
  for (let i = 0; i < argv.length; i++) argv[i].startsWith('--') ? (o[argv[i].slice(2)] = argv[++i]) : rest.push(argv[i])
  return [o, rest]
}

export async function server(port) { // own python static server on public/ unless --port is given
  if (port) return { port, stop() {} }
  port = 20000 + Math.floor(Math.random() * 20000)
  const pub = fileURLToPath(new URL('../public', import.meta.url))
  const p = spawn('python3', ['-m', 'http.server', port, '-b', '127.0.0.1'], { cwd: pub, stdio: 'ignore' })
  for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${port}/index.html`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 200)) // (up: a loaded machine takes its time)
  return { port, stop: () => p.kill() }
}

export async function open({ port, dpr = 1, size = '1400x900', tier = 'auto', weather = 'clear', hour = 13, tide = 0, season, query = '', hash = '', init, gpuFlags = [], tiles = '' }) {
  const [w, h, pd] = SIZES[size] || [...size.split('x').map(Number), +dpr]
  const phone = !!SIZES[size]
  const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', ...gpuFlags] })
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? pd : +dpr, isMobile: phone, hasTouch: phone })
  await ctx.addInitScript(([wx, hr, t, td]) => { // (a fixed tide, metres above chart datum: nothing live decides the sea level)
    localStorage.setItem('vancouver.weather', JSON.stringify({ mode: wx, hour: hr, tide: td }))
    localStorage.setItem('vancouver.graphics', t)
  }, [weather, +hour, tier, +tide])
  if (init) await ctx.addInitScript(init)
  if (tiles) { // --tiles https://vancouver.borodutch.com/tiles: the published tiles instead of public/tiles (kept in a folder in the temp dir)
    const dir = `${os.tmpdir()}/vancouver-tiles-${tiles.replace(/\W+/g, '_')}`
    await ctx.route('**/tiles/**', async (route) => {
      const rel = new URL(route.request().url()).pathname.split('/tiles/')[1], f = `${dir}/${rel}`
      if (!fs.existsSync(f)) {
        const r = await fetch(`${tiles}/${rel}`).catch(() => null)
        if (!r?.ok) return route.fulfill({ status: r?.status || 504 })
        fs.mkdirSync(f.slice(0, f.lastIndexOf('/')), { recursive: true }); fs.writeFileSync(f + '.part' + process.pid, Buffer.from(await r.arrayBuffer())); fs.renameSync(f + '.part' + process.pid, f)
      }
      route.fulfill({ path: f })
    })
  }
  const page = await ctx.newPage(), errs = []
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  page.on('pageerror', (e) => errs.push(e.message + (e.stack?.split('\n')[1] || '').replace(/^\s*at/, ' at').replace(/http:\/\/[^/]+/, '')))
  if (season) query += (query ? '&' : '?') + 'season=' + season // core/tiles.js reads ?season=
  await page.goto(`http://127.0.0.1:${port}/${query}${hash}`)
  await page.waitForFunction(() => window.city && window.view?.tiles && !document.querySelector('#loading'), null, { timeout: 240000 })
  return { browser, ctx, page, errs }
}

export const settle = async (page, ms = 1500) => { // tiles asked for, built + warmed, then a beat for fades
  const idle = (timeout) => page.waitForFunction(() => { const t = view.tiles; return !t.queue.length && !t.made.length && !t.warming.length && ![...t.tiles.values()].some((x) => x.state === 'loading') }, null, { timeout }).catch(() => {})
  await idle(90000); await page.waitForTimeout(500); await idle(30000) // a camera just moved asks for its tiles a frame or two later
  await page.waitForTimeout(ms)
}
