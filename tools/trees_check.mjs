// node tools/trees_check.mjs: every trunk and limb of every tree form (treeforms.js; fine and coarse) ends inside a
// closed lump of its crown, as drawn: at any crown width and height (the instance's scale) and with the crown pruned up
// over a street (trees3d.js's iBase warp, the billboards' the same). Measures the gap from each end to the leaves in
// metres (0 inside) and fails over GAP: no branch ends in the air under a floating crown, no stump under a hollow one;
// and every form's wood starts at the ground
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
const GAP = 0.03 // metres
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
// from p to the triangle a b c (Ericson's closest point)
function away(p, [a, b, c]) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap)
  const len = (q) => Math.hypot(...sub(p, q)), on = (o, e, t, f = null, u = 0) => len([0, 1, 2].map((i) => o[i] + e[i] * t + (f ? f[i] * u : 0)))
  if (d1 <= 0 && d2 <= 0) return len(a)
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return len(b)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return on(a, ab, d1 / (d1 - d3))
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return len(c)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return on(a, ac, d2 / (d2 - d6))
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return on(b, sub(c, b), (d4 - d3) / (d4 - d3 + d5 - d6))
  return on(a, ab, vb / (va + vb + vc), ac, vc / (va + vb + vc))
}
let bad = 0, n = 0, worst = 0
for (let f = 0; f < FORMS; f++) for (const lo of [false, true]) {
  const g = treeForm(THREE, f, lo), P = g.attributes.position.array, Cr = g.attributes.crown.array, { limbs, lumps } = g.userData
  let b0 = 1, foot = 1
  for (let i = 0; i < Cr.length; i++) if (Cr[i] > 0.5) b0 = Math.min(b0, P[i * 3 + 1]); else foot = Math.min(foot, P[i * 3 + 1])
  b0 = Math.max(0.02, b0)
  const name = `form ${f}${lo ? ' coarse' : ''}`
  if (foot > 1e-6) { bad++; console.log(`${name}: no wood down to the ground (from ${foot.toFixed(3)} of its height)`) }
  if (!limbs.length) { bad++; console.log(`${name}: no trunk or limb ends recorded`) }
  let gap = 0
  for (const [sx, sy] of [[1, 1], [3, 12], [12, 8], [20, 30], [14, 6]]) for (const b of [b0, 0.35, 0.5, 0.7]) {
    const at = (x, y, z) => [x * sx, warp(y, b0, Math.max(b, b0)) * sy, z * sx]
    const T = lumps.map(([s, e]) => { const t = []; for (let i = s; i < e; i += 3) t.push([0, 1, 2].map((j) => at(P[(i + j) * 3], P[(i + j) * 3 + 1], P[(i + j) * 3 + 2]))); return t })
    for (const [x, y, z] of limbs) {
      const p = at(x, y, z)
      n++
      if (!T.some((t) => inside(p, t))) gap = Math.max(gap, Math.min(...T.flat().map((t) => away(p, t))))
    }
  }
  worst = Math.max(worst, gap)
  if (gap > GAP) { bad++; console.log(`${name}: a trunk or limb ends ${gap.toFixed(2)} m short of its leaves`) }
}
console.log(bad ? `FAIL ${bad} defects over ${n} trunk and limb ends` : `ok: ${n} trunk and limb ends inside their leaves, the worst gap ${worst.toFixed(3)} m (9 forms, fine and coarse, 5 sizes, 4 crown heights)`)
process.exit(bad ? 1 : 0)
