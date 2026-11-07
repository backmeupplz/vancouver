// Sanity check of public/plugins/transit/data against the plugin's own decoder: `node tools/transit_check.mjs`
// Prints how many vehicles run at a few times and fails if the files no longer decode into a plausible timetable.
import fs from 'fs'
import { decode, eachActive, patternOf } from '../public/plugins/transit/index.js'

const D = new URL('../public/plugins/transit/data/', import.meta.url)
const man = JSON.parse(fs.readFileSync(new URL('manifest.json', D)))
const chunks = man.chunks.map((c) => decode(fs.readFileSync(new URL(c.file, D)).buffer.slice(0)))
for (const ch of chunks) {
  for (const p of ch.pats) for (let i = 1; i < p.dist.length; i++) console.assert(p.dist[i] >= p.dist[i - 1], 'stop distances go backwards')
  for (let i = 1; i < ch.n; i++) console.assert(ch.starts[i] >= ch.starts[i - 1], 'trips not sorted')
}
const at = (ymd, prev, h) => {
  const by = {}
  for (const ch of chunks) eachActive(ch, h * 3600, patternOf(man, ymd), patternOf(man, prev), (i) => {
    const k = man.routes[ch.pats[ch.profs[ch.prof[i]].pat].route].kind
    by[k] = (by[k] || 0) + 1
  })
  return by
}
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0)
const am = at('20261109', '20261108', 8), night = at('20261109', '20261108', 1)
console.log('Mon 08:00', sum(am), am)
console.log('Mon 01:00', sum(night), night)
if (sum(am) < 800 || am.expo < 20 || am.canada < 10 || !am.seabus || sum(night) >= sum(am)) { console.error('implausible timetable'); process.exit(1) }
