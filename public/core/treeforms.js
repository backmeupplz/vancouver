// Low-poly tree forms, shared by the 3D trees near a street-level camera (trees3d.js) and the billboard atlas
// (materials.js renders these same forms into it, so the swap from one to the other is invisible). Each is a unit
// tree: 1 tall, its crown 1 wide, the foot at the origin. Vertex attributes: `color`, the face's shade on the crown
// (the instance colour multiplies it: chunky facets, lit on top, darker underneath and low in the crown) or the bark;
// `crown`, 1 on leaves and 0 on wood. `lo`: the fewer-triangle version (beyond ~60 m, and on Low graphics).
import { kit } from './kit.js'
import { mulberry32, smooth, clamp } from './util.js'

// shapes (tools/tiles.py tree_look): 0 round (maple, linden, plum), 1 columnar (hornbeam, poplar), 2 spreading (oak,
// plane, chestnut), 3 weeping (willow, birch), 4 fir (Douglas fir, spruce), 5 cedar (western red cedar: drooping
// layers), 6 pine, 7 palm, 8 vase (elm, zelkova, Kwanzan cherry)
export const FORMS = 9
// the usual height / width of each form (the atlas draws them so; tiles.js sizes old tiles' crowns by it)
export const ASPECT = [1.25, 3, 0.95, 1.2, 2.8, 2.2, 1.5, 1.8, 1.05]
const BARK = 0x4a3a2e, PALM_BARK = 0x6e5a44
const ICO = new Map()
const hash = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s) }

export function treeForm(THREE, shape, lo = false) {
  const k = kit(THREE), rnd = mulberry32(shape * 7919 + 17), col = new THREE.Color(), T = Math.PI * 2
  const grey = (l) => col.setRGB(l, l, l).getHex() // a linear shade as the (sRGB) hex k.c takes
  const leaf = (l) => k.c(grey(clamp(l, 0, 1)), 0)
  const bark = (hex = BARK) => k.c(hex, 1)
  const ico = (d) => { if (!ICO.has(d)) ICO.set(d, new THREE.IcosahedronGeometry(1, d).attributes.position.array); return ICO.get(d) }
  // a lump of leaves: a jittered icosahedron (corners pushed in or out alike, so no cracks), each face shaded by
  // which way it faces (the underside darker) and `s` (lower lumps darker: the crown shades itself)
  const blob = (x, y, z, rx, ry = rx, rz = rx, d = 0, s = 1) => {
    const P = ico(lo ? 0 : d), a = rnd() * T, ca = Math.cos(a), sa = Math.sin(a), v = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (let i = 0; i < P.length; i += 9) {
      let ny = 0
      for (let j = 0; j < 3; j++) {
        const px = P[i + j * 3], py = P[i + j * 3 + 1], pz = P[i + j * 3 + 2], m = 0.86 + 0.28 * hash(px + a, py, pz)
        v[j][0] = x + (px * ca - pz * sa) * rx * m; v[j][1] = y + py * ry * m; v[j][2] = z + (px * sa + pz * ca) * rz * m
        ny += py / 3
      }
      leaf(s * (0.58 + 0.42 * smooth(-0.75, 0.75, ny)))
      k.tri(v[0], v[1], v[2])
    }
  }
  // a cone of a conifer's tier: rim at y0 radius r, tip h above; `droop` bends the outer part of the layer down
  // (a shoulder at 70% of the radius), the rim ragged; the underside dark
  const tier = (y0, h, r, seg, s, droop = 0) => {
    const from = k.at(), a0 = rnd() * T
    leaf(s)
    if (droop) { k.cyl(r * 0.7, 0, h * (1 - droop), seg, 0, a0, a0 + T).move(from, 0, y0 + h * droop, 0); const m = k.at(); leaf(s * 0.86); k.cyl(r, r * 0.7, h * droop, seg, 0, a0, a0 + T).move(m, 0, y0, 0) }
    else k.cyl(r, 0, h, seg, 0, a0, a0 + T).move(from, 0, y0, 0)
    leaf(s * 0.42)
    for (let i = 0; i < seg; i++) { const a = a0 + (i * T) / seg, b = a0 + ((i + 1) * T) / seg; k.tri([0, y0, 0], [Math.cos(b) * r, y0, -Math.sin(b) * r], [Math.cos(a) * r, y0, -Math.sin(a) * r]) }
    k.xf(from, (p) => { if (p.y < y0 + 1e-6 && p.x * p.x + p.z * p.z > r * r * 0.9) p.y -= h * 0.22 * hash(p.x, 0, p.z) })
  }
  const trunk = (top, r0, r1 = r0 * 0.7, hex) => { bark(hex); k.cyl(r0, r1, top, lo ? 5 : 6, 0) }
  const limb = (a, b, r0, r1 = r0 * 0.6) => { bark(); k.rod(a, b, r0, r1, lo ? 4 : 5) }
  // limbs fanning out of the trunk at y0 to radius rr at y1 (angles from a0): branch stubs under a crown, a vase's arms
  const limbs = (n, y0, y1, rr, r0, a0 = rnd() * T) => { for (let i = 0; i < n; i++) { const a = a0 + (i * T) / n + (rnd() - 0.5) * 0.6; limb([0, y0, 0], [Math.cos(a) * rr, y1, Math.sin(a) * rr], r0) } }
  // lumps on a ring: n of radius r at distance d, heights y ± dy
  const ring = (n, d, y, dy, r, ry, s, a0 = rnd() * T) => { for (let i = 0; i < n; i++) { const a = a0 + (i * T) / n + (rnd() - 0.5) * 0.5; blob(Math.cos(a) * d, y + (rnd() - 0.5) * dy, Math.sin(a) * d, r * (0.85 + rnd() * 0.3), ry, r, 0, s * (0.9 + rnd() * 0.12)) } }

  switch (shape) {
    case 1: // columnar: a tall spindle of leaves from low down
      trunk(0.3, 0.035)
      if (!lo) limbs(2, 0.12, 0.3, 0.18, 0.016)
      blob(0, 0.36, 0, 0.36, 0.22, 0.36, 0, 0.78)
      blob(0, 0.55, 0, 0.5, 0.27, 0.5, 1, 0.9)
      blob(0, 0.75, 0, 0.42, 0.22, 0.42, 0, 1)
      if (!lo) blob(0.05, 0.9, 0, 0.26, 0.14, 0.26, 0, 1.06)
      break
    case 2: // spreading: a broad low dome on a stout trunk forking into limbs
      trunk(0.42, 0.032, 0.026)
      limbs(lo ? 2 : 4, 0.3, 0.55, 0.3, 0.018)
      blob(0, 0.72, 0, 0.36, 0.24, 0.36, 1, 1)
      ring(lo ? 4 : 6, 0.32, 0.62, 0.12, 0.2, 0.17, 0.92)
      if (!lo) ring(3, 0.16, 0.86, 0.06, 0.2, 0.14, 1.06)
      break
    case 3: // weeping: a dome with curtains of leaves hanging to near the ground
      trunk(0.62, 0.028)
      if (!lo) limbs(3, 0.45, 0.7, 0.25, 0.014)
      blob(0, 0.78, 0, 0.36, 0.2, 0.36, 1, 1.02)
      for (let i = 0, n = lo ? 5 : 8; i < n; i++) {
        const a = (i * T) / n + (rnd() - 0.5) * 0.4, d = 0.36 + rnd() * 0.06
        blob(Math.cos(a) * d, 0.5 - rnd() * 0.06, Math.sin(a) * d, 0.13, 0.36, 0.13, 0, 0.82 + rnd() * 0.12)
      }
      break
    case 4: { // fir: tiers of ragged cones narrowing to a spire, a bare foot
      trunk(0.22, 0.03)
      const n = lo ? 5 : 7
      for (let i = 0; i < n; i++) { const f = i / n; tier(0.2 + f * 0.66, 0.2 - f * 0.05, (0.5 * (1 - f) ** 0.9 + 0.03) * (0.9 + rnd() * 0.2), lo ? 6 : 7, 0.84 + 0.18 * f) }
      tier(0.84, 0.16, 0.05, 5, 1.04)
      break
    }
    case 5: { // cedar: broad drooping layers from near the ground, a nodding leader
      trunk(0.15, 0.035)
      const n = lo ? 5 : 7
      for (let i = 0; i < n; i++) { const f = i / n; tier(0.05 + f * 0.78, 0.18 - f * 0.05, (0.5 * (1 - f) ** 0.7 + 0.05) * (0.88 + rnd() * 0.24), lo ? 6 : 8, 0.8 + 0.22 * f, 0.55) }
      leaf(1.05); const s = k.at(); k.cyl(0.03, 0, 0.1, 4, 0); k.rot(s, 'z', -0.35).move(s, 0, 0.8, 0)
      break
    }
    case 6: { // pine: a bare crooked trunk, flat clouds of needles on its branches
      bark(); k.rod([0, 0, 0], [0.04, 0.5, 0], 0.032, 0.026, lo ? 5 : 6); k.rod([0.04, 0.5, 0], [-0.03, 0.88, 0.02], 0.026, 0.016, lo ? 5 : 6)
      const clumps = lo ? [[0, 0.88, 0, 0.3], [0.26, 0.66, 0.1, 0.24], [-0.24, 0.6, -0.14, 0.22]]
        : [[0, 0.9, 0, 0.3], [0.28, 0.7, 0.08, 0.24], [-0.26, 0.62, -0.12, 0.23], [0.06, 0.74, -0.3, 0.2], [-0.14, 0.8, 0.26, 0.2]]
      for (const [x, y, z, r] of clumps) { if (x || z) limb([0.02, y - 0.12, 0], [x * 0.8, y - 0.02, z * 0.8], 0.013); blob(x, y, z, r, r * 0.45, r, x || z ? 0 : 1, 0.82 + y * 0.2) }
      break
    }
    case 7: { // palm: a ringed trunk, arching fronds
      bark(PALM_BARK); k.rod([0, 0, 0], [0.03, 0.45, 0], 0.035, 0.03, 6); k.rod([0.03, 0.45, 0], [0, 0.86, 0], 0.03, 0.026, 6)
      const n = lo ? 7 : 11
      for (let i = 0; i < n; i++) {
        const a = (i * T) / n + rnd() * 0.3, up = i % 2 ? 0.08 : 0.14, len = 0.5 + rnd() * 0.06, ca = Math.cos(a), sa = Math.sin(a)
        const P = (d, y) => [ca * d, 0.88 + y, sa * d], W = (d, y, w) => [ca * d - sa * w, 0.88 + y, sa * d + ca * w]
        const pts = [P(0, 0), P(len * 0.45, up), P(len, up - 0.2)], wd = 0.1
        for (let j = 0; j < 2; j++) {
          const p0 = pts[j], p1 = pts[j + 1], m = (len * (j ? 0.72 : 0.22)), ym = (p0[1] + p1[1]) / 2 - 0.88
          const L = W(m, ym, wd), R = W(m, ym, -wd)
          leaf(0.98); k.quad(p0, L, p1, R)
          leaf(0.55); k.quad(R, p1, L, p0)
        }
      }
      blob(0, 0.87, 0, 0.06, 0.06, 0.06, 0, 0.6)
      break
    }
    case 8: // vase: limbs fanning up and out from a short trunk to a broad flat-topped crown
      trunk(0.3, 0.03, 0.026)
      limbs(lo ? 3 : 5, 0.26, 0.66, 0.3, 0.018)
      ring(lo ? 4 : 7, 0.3, 0.74, 0.08, 0.22, 0.16, 0.92)
      blob(0, 0.84, 0, 0.32, 0.17, 0.32, 1, 1.05)
      break
    default: // round: a full head of lumps on a single trunk
      trunk(0.5, 0.03)
      if (!lo) limbs(3, 0.32, 0.52, 0.2, 0.015)
      blob(0, 0.66, 0, 0.42, 0.3, 0.42, 1, 0.98)
      ring(lo ? 3 : 5, 0.3, 0.58, 0.14, 0.22, 0.2, 0.86)
      if (!lo) blob(0.04, 0.86, -0.06, 0.24, 0.16, 0.24, 0, 1.08)
  }
  // to unit size: 1 tall, the crown 1 wide (the instance scales it to the tree's height and crown width)
  const g = k.geometry(), P = g.attributes.position.array, part = g.attributes.aPart.array
  let top = 0, wide = 0
  for (let i = 0; i < part.length; i++) { top = Math.max(top, P[i * 3 + 1]); if (!part[i]) wide = Math.max(wide, Math.hypot(P[i * 3], P[i * 3 + 2])) }
  g.scale(0.5 / wide, 1 / top, 0.5 / wide)
  g.setAttribute('color', g.attributes.aCol)
  g.setAttribute('crown', new THREE.Float32BufferAttribute(part.map((p) => 1 - p), 1))
  for (const a of ['aCol', 'aPart', 'aSwing']) g.deleteAttribute(a)
  g.computeVertexNormals()
  return g
}
