// node tools/trees_check.mjs: every limb of every tree form (treeforms.js; fine and coarse) ends inside the crown lump
// it was built to reach, as drawn: at any crown width and height (the instance's scale) and with the crown pruned up
// over a street (trees3d.js's iBase warp, the billboards' the same), so no branch hangs in the air or pokes out
import * as THREE from '../public/vendor/three.module.min.js'
import { treeForm, FORMS } from '../public/core/treeforms.js'

// trees3d.js's vertex warp: the crown starts at b (share of the height) instead of the model's b0
const warp = (y, b0, b) => (y < b0 ? (y * b) / b0 : b + ((y - b0) * (1 - b)) / (1 - b0))
// a point inside a closed lump (its triangles): a ray along +x crosses it an odd number of times
function inside(p, T) {
  let n = 0
  for (const [a, b, c] of T) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const h = [0, -e2[2], e2[1]], det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2] // dir (1, 0, 0) x e2
    if (Math.abs(det) < 1e-12) continue
    const s = [p[0] - a[0], p[1] - a[1], p[2] - a[2]], u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det
    if (u < 0 || u > 1) continue
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]], v = q[0] / det
    if (v < 0 || u + v > 1) continue
    if ((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det > 0) n++
  }
  return n % 2 === 1
}
let bad = 0, n = 0
for (let f = 0; f < FORMS; f++) for (const lo of [false, true]) {
  const g = treeForm(THREE, f, lo), P = g.attributes.position.array, Cr = g.attributes.crown.array, { limbs, lumps } = g.userData
  let b0 = 1
  for (let i = 0; i < Cr.length; i++) if (Cr[i] > 0.5) b0 = Math.min(b0, P[i * 3 + 1])
  b0 = Math.max(0.02, b0)
  for (const [sx, sy] of [[1, 1], [3, 12], [12, 8], [20, 30]]) for (const b of [b0, 0.35, 0.5, 0.7]) {
    const at = (x, y, z) => [x * sx, warp(y, b0, Math.max(b, b0)) * sy, z * sx]
    for (const [x, y, z, k] of limbs) {
      const [s, e] = lumps[k], T = []
      for (let i = s; i < e; i += 3) T.push([0, 1, 2].map((j) => at(P[(i + j) * 3], P[(i + j) * 3 + 1], P[(i + j) * 3 + 2])))
      n++
      if (!inside(at(x, y, z), T)) { bad++; if (bad < 10) console.log(`form ${f}${lo ? ' coarse' : ''}: a limb ends outside its lump (scale ${sx}x${sy}, crown from ${b.toFixed(2)})`) }
    }
  }
  if (!limbs.length && [0, 1, 2, 3, 6, 8].includes(f) && !lo) { bad++; console.log(`form ${f}: no limbs recorded`) }
}
console.log(bad ? `FAIL ${bad} of ${n} limb ends outside their crown` : `ok: ${n} limb ends inside their crown (9 forms, fine and coarse, 4 sizes, 4 crown heights)`)
process.exit(bad ? 1 : 0)
