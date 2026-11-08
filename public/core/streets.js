// Street names, named places and bollards from OpenStreetMap (© OpenStreetMap contributors, ODbL), per 4 km cell:
// plugins/drive/data/<I>_<J>.json, made by tools/delivery_places.py. Loaded lazily and shared by the plugins that
// use them (the drive plugin's addresses and street readout, the life plugin's street-name blades).
import { clamp } from './util.js'

const DATA = new URL('../plugins/drive/data/', import.meta.url)
const ckey = (cx, cy) => cx * 8192 + cy
const NONE = []
const cells = new Map() // "I_J" -> null while loading, then { segs, name, grid, names, places, bollards }
let cellList = null
const waiting = new Set() // callbacks for when a cell (or the list of them) comes in
const notify = () => { for (const f of waiting) f(); waiting.clear() }
fetch(new URL('index.json', DATA)).then((r) => r.json()).then((l) => { cellList = new Set(l); notify() }).catch(() => { cellList = new Set() })

// the loaded cells within r of (x, north); starts loading the missing ones (onLoad: called once one comes in)
export function cellsNear(x, y, r, onLoad) {
  const out = []
  if (!cellList) { if (onLoad) waiting.add(onLoad); return out }
  for (let I = Math.floor((x - r) / 4096); I <= Math.floor((x + r) / 4096); I++) for (let J = Math.floor((y - r) / 4096); J <= Math.floor((y + r) / 4096); J++) {
    const k = `${I}_${J}`
    if (!cellList.has(k)) continue
    if (!cells.has(k)) {
      cells.set(k, null)
      const done = (c) => { cells.set(k, c); notify() }
      fetch(new URL(`${k}.json`, DATA)).then((r) => r.json()).then((d) => done(prepCell(d))).catch((e) => { console.warn('no street names for', k, e); done({ segs: [], name: [], grid: new Map(), names: [], places: [], bollards: new Map() }) })
    }
    const c = cells.get(k)
    if (c) out.push(c)
    else if (onLoad) waiting.add(onLoad)
  }
  return out
}
function prepCell(d) {
  const [ox, oy] = d.o, segs = [], name = [], grid = new Map()
  for (const row of d.s) for (let i = 1; i + 3 < row.length; i += 2) {
    const x0 = row[i] + ox, y0 = row[i + 1] + oy, x1 = row[i + 2] + ox, y1 = row[i + 3] + oy, id = name.push(row[0]) - 1
    segs.push(x0, y0, x1, y1)
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 24)
    for (let k = 0; k <= n; k++) {
      const f = k / n || 0, key = ckey(Math.floor((x0 + (x1 - x0) * f) / 48), Math.floor((y0 + (y1 - y0) * f) / 48))
      let a = grid.get(key); if (!a) grid.set(key, (a = [])); if (a[a.length - 1] !== id) a.push(id)
    }
  }
  const places = d.p.map(([x, y, nm, k, addr]) => ({ x: x + ox, y: y + oy, name: nm, kind: d.k[k], addr }))
  const bollards = new Map()
  for (let i = 0; i + 1 < (d.b || NONE).length; i += 2) {
    const x = ox + d.b[i] / 10, y = oy + d.b[i + 1] / 10, key = ckey(Math.floor(x / 32), Math.floor(y / 32))
    let a = bollards.get(key); if (!a) bollards.set(key, (a = [])); a.push(x, y)
  }
  return { segs, name, grid, names: d.n, places, bollards }
}
// the nearest named street within r metres: { name, x0, y0, x1, y1, px, py, d }; ok(dx, dy): only segments running
// that way (e.g. across a given direction)
export function nearestStreet(x, y, r, ok, onLoad) {
  let best = null, bd = r
  for (const c of cellsNear(x, y, r, onLoad)) {
    const seen = new Set()
    for (let gx = Math.floor((x - r) / 48); gx <= Math.floor((x + r) / 48); gx++) for (let gy = Math.floor((y - r) / 48); gy <= Math.floor((y + r) / 48); gy++) {
      for (const id of c.grid.get(ckey(gx, gy)) || NONE) {
        if (seen.has(id)) continue
        seen.add(id)
        const x0 = c.segs[id * 4], y0 = c.segs[id * 4 + 1], dx = c.segs[id * 4 + 2] - x0, dy = c.segs[id * 4 + 3] - y0
        if (ok && !ok(dx, dy)) continue
        const u = clamp(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1), 0, 1), px = x0 + dx * u, py = y0 + dy * u, d = Math.hypot(x - px, y - py)
        if (d < bd) { bd = d; best = { name: c.names[c.name[id]], x0, y0, x1: x0 + dx, y1: y0 + dy, px, py, d } }
      }
    }
  }
  return best
}

// OpenStreetMap spells street names out; addresses and street signs abbreviate them
const ABBR = { Avenue: 'Ave', Street: 'St', Drive: 'Dr', Road: 'Rd', Boulevard: 'Blvd', Place: 'Pl', Crescent: 'Cres', Court: 'Ct', Highway: 'Hwy', Lane: 'Ln', Way: 'Way', Mall: 'Mall', Square: 'Sq', Terrace: 'Terr', Parkway: 'Pkwy' }
const DIRS = { East: 'E', West: 'W', North: 'N', South: 'S' }
export function abbr(name) {
  const w = name.split(' ')
  if (w.length >= 3 && DIRS[w[0]]) w[0] = DIRS[w[0]]
  if (w.length >= 2 && ABBR[w[w.length - 1]]) w[w.length - 1] = ABBR[w[w.length - 1]]
  return w.join(' ')
}
