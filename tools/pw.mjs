// Shared by shoot.mjs / bench.mjs: args, static server, Chrome launch, page setup, tile settling.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
  await new Promise((r) => setTimeout(r, 800))
  return { port, stop: () => p.kill() }
}

export async function open({ port, dpr = 1, size = '1400x900', tier = 'auto', weather = 'clear', hour = 13, season, query = '', hash = '', init, gpuFlags = [] }) {
  const [w, h, pd] = SIZES[size] || [...size.split('x').map(Number), +dpr]
  const phone = !!SIZES[size]
  const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', ...gpuFlags] })
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? pd : +dpr, isMobile: phone, hasTouch: phone })
  await ctx.addInitScript(([wx, hr, t]) => {
    localStorage.setItem('vancouver.weather', JSON.stringify({ mode: wx, hour: hr }))
    localStorage.setItem('vancouver.graphics', t)
  }, [weather, +hour, tier])
  if (init) await ctx.addInitScript(init)
  const page = await ctx.newPage(), errs = []
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  page.on('pageerror', (e) => errs.push(e.message))
  if (season) query += (query ? '&' : '?') + 'season=' + season // core/tiles.js reads ?season=
  await page.goto(`http://127.0.0.1:${port}/${query}${hash}`)
  await page.waitForFunction(() => window.city && window.view?.tiles && !document.querySelector('#loading'), null, { timeout: 240000 })
  return { browser, ctx, page, errs }
}

export const settle = async (page, ms = 1500) => { // tiles built + warmed, then a beat for fades
  await page.waitForFunction(() => !view.tiles.made.length && !view.tiles.warming.length, null, { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(ms)
}
