// node tide_check.mjs <tiles dir> <i_j> [...]: the tide's shore field (tile-worker.js ground(): the `tidal`
// byte) of detail tiles, built by the page's own code. Per tile: water vertices near a beach, the worst jump of the
// field along a triangle's edge beyond the edge's own length (0: the waterline cannot follow the triangles), the
// waterline's place at the lowest, middle and highest tide (mean metres out from the beach's edge), time to build.
// Exits 1 if the field jumps (> 1.5 m), or a tile named with a trailing '!' (no sea: a lake's or a river's sand) has any.
import fs from 'node:fs'
import zlib from 'node:zlib'
const [DIR, ...CELLS] = process.argv.slice(2)
const W = await import('../public/core/tile-worker.js')
const U = await import('../public/core/util.js')
let bad = 0
for (const cell of CELLS) {
  const none = cell.endsWith('!'), k = cell.replace('!', ''), r = fs.readFileSync(`${DIR}/0/${k}.bin`), b = r[0] === 0x1f ? zlib.gunzipSync(r) : r
  const t = W.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), terr = W.terrain(t)
  const t0 = performance.now(), g = W.ground(t, terr, 0), ms = performance.now() - t0
  const P = g.position, C = g.cls, T = g.tidal, I = g.index, d = (i) => (255 - T[i]) / 2 // metres out from a beach's edge (127.5: none near)
  let water = 0, near = 0, jump = 0, flood = 0
  for (let i = 0; i < C.length; i++) { if (C[i] === 19) { water++; if (T[i]) near++ } else if (T[i]) flood++ }
  for (let q = 0; q < I.length; q += 3) for (let e = 0; e < 3; e++) {
    const a = I[q + e], c = I[q + (e + 1) % 3]
    if (C[a] !== 19 || C[c] !== 19) continue
    jump = Math.max(jump, Math.abs(d(a) - d(c)) - Math.hypot(P[a * 3] - P[c * 3], P[a * 3 + 2] - P[c * 3 + 2]))
  }
  const ok = jump <= 1.5 && (!none || !near)
  if (!ok) bad++
  console.log(JSON.stringify({ cell: k, verts: C.length, water, nearBeach: near, floodable: flood, jump: +jump.toFixed(2), ms: +ms.toFixed(0), tidalMs: globalThis.TIDAL_MS && +globalThis.TIDAL_MS.toFixed(1), SEA0: U.SEA0, SEA_RISE: U.SEA_RISE, ok }))
}
process.exit(bad ? 1 : 0)
