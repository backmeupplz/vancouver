// node tools/crosswalk_check.mjs: crosswalks (public/core/tile-worker.js) go one per leg, square across the road,
// kerb to kerb, outside the junction box, whichever way OpenStreetMap drew the crossings
import assert from 'node:assert/strict'
import { carEnds, crosswalks } from '../public/core/tile-worker.js'

// a + junction at the origin: a 13 m avenue east-west (split by a crossing node 7 m west), an 8 m street north-south
const road = (a, b, pts, w, kind = 3) => ({ kind, lanes: 2, w, a, b, pts: new Float32Array(pts), z: null, crossing: false })
const walk = (a, b, pts) => ({ kind: 9, lanes: 0, w: 2.2, a, b, pts: new Float32Array(pts), z: null, crossing: true })
const lines = [
  road(1, 2, [-200, 0, -7, 0], 13.2), road(2, 0, [-7, 0, 0, 0], 13.2), road(0, 3, [0, 0, 200, 0], 13.2),
  road(0, 4, [0, 0, 0, 200], 8, 5), road(5, 0, [0, -200, 0, 0], 8, 5),
  walk(10, 2, [-7.3, -9, -7, 0]), walk(2, 11, [-7, 0, -7.2, 10]), // the west leg, split at the road's node
  walk(12, 0, [-2, 12, 0, 0]), // a cycle crossing drawn diagonally into the middle of the junction (the west leg again)
  walk(13, 14, [7.5, -11, 8.4, 11]), // the east leg, past both kerbs, a little skewed
  walk(15, 16, [-90, -9, -90, 9]), // mid-block
]
const ps = [{ kind: 8, id: 2, x: -7, y: 0 }, { kind: 7, id: 17, x: 20, y: 60 }] // the west leg's node, painted two lines; one off the roads
const cw = crosswalks(lines, carEnds(lines), ps, 0, 0)
assert.equal(cw.length, 3, `three crosswalks: ${JSON.stringify(cw)}`)
for (const c of cw) {
  assert(Math.abs(c.ty) < 1e-6 && Math.abs(Math.abs(c.tx) - 1) < 1e-6, 'square across the avenue')
  assert.equal(c.w, 13.2, 'kerb to kerb')
  assert(Math.abs(c.y) < 1e-6, 'centred on the avenue')
}
const [west, east, mid] = [-1, 1, 0].map((s) => cw.find((c) => (s ? Math.sign(c.x) === s && Math.abs(c.x) < 20 : Math.abs(c.x) > 50)))
assert(west && east && mid, 'one per leg')
assert.equal(west.x, -6.5, 'west: just outside the box (the street\'s half width, 4 m, + 1 + half the 3 m width)')
assert.equal(east.x, 6.5, 'east: the same, wherever OSM drew it')
assert.equal(west.lines, 1, 'the node says two lines')
assert.equal(east.lines, 0, 'bars by default')
assert(Math.abs(mid.x + 90) < 1e-6, 'mid-block: where it is mapped')
console.log('crosswalks ok')
