// The fishing models, built with core/kit.js: fish by body shape and colour, the junk, crab, rod, traps, float,
// bucket, bobber and the seal. Metres; one shared plain kit material.
import { kit, kitMaterial } from '../../core/kit.js'

// body shapes: h height (× the salmon's), th thickness, tail: 1 forked, 0 pointed, fin: dorsal fin height
const SHAPES = { salmon: { h: 1, th: 0.09, tail: 1, fin: 0.05 }, rock: { h: 1.7, th: 0.1, tail: 0.7, fin: 0.1 }, flat: { h: 2.3, th: 0.03, tail: 0.5, fin: 0 }, eel: { h: 0.5, th: 0.06, tail: 0, fin: 0.03 },
  shark: { h: 0.75, th: 0.1, tail: 1.3, fin: 0.13 }, sturgeon: { h: 0.62, th: 0.09, tail: 1.2, fin: 0.04 } }

export function makeModels(THREE) {
  const mat = kitMaterial(THREE, undefined, false)
  const mesh = (k) => new THREE.Mesh(k.geometry(true), mat)
  return {
    mat,
    // a fish `len` metres long, its mouth at the origin and its body along +x (hang it with rotation.z = -π/2)
    fish(sp, len) {
      const k = kit(THREE)
      if (sp.shape === 'boot') { k.c(0x5a4634).box(-0.07, 0.07, -0.34, 0, -0.06, 0.06).c(0x3f3024).box(-0.07, 0.2, -0.42, -0.3, -0.07, 0.07); return mesh(k) }
      if (sp.shape === 'cart') {
        k.c(0x9aa3a8)
        const a = 0.28, b = 0.2, y0 = -0.75, y1 = -0.3
        for (const [x, z] of [[-a, -b], [a, -b], [a, b], [-a, b]]) k.rod([x, y0, z], [x, y1, z], 0.014)
        for (const y of [y0, y1, (y0 + y1) / 2]) { k.rod([-a, y, -b], [a, y, -b], 0.012).rod([-a, y, b], [a, y, b], 0.012).rod([-a, y, -b], [-a, y, b], 0.012).rod([a, y, -b], [a, y, b], 0.012) }
        k.rod([-a, y1, 0], [-a - 0.16, y1 + 0.14, 0], 0.014).c(0xc0392b).rod([-a - 0.16, y1 + 0.14, -b], [-a - 0.16, y1 + 0.14, b], 0.018)
        k.c(0x22252a); for (const [x, z] of [[-a, -b], [a, -b], [a, b], [-a, b]]) k.wheel(x, y0 - 0.06, z, 0.05, 0.03, 8)
        return mesh(k)
      }
      if (sp.shape === 'bike') {
        const y = -0.55
        k.c(0x22252a).wheel(-0.36, y, 0, 0.26, 0.035, 12).wheel(0.36, y, 0, 0.26, 0.035, 12)
        k.c(0x1c8fd6).rod([-0.36, y, 0], [-0.08, y + 0.02, 0], 0.022).rod([-0.08, y + 0.02, 0], [0.22, y + 0.34, 0], 0.024).rod([-0.08, y + 0.02, 0], [-0.14, y + 0.4, 0], 0.022)
          .rod([0.36, y, 0], [0.24, y + 0.44, 0], 0.022).rod([-0.14, y + 0.36, 0], [0.22, y + 0.34, 0], 0.02)
        k.c(0x22252a).box(-0.24, -0.06, y + 0.4, y + 0.44, -0.05, 0.05).rod([0.24, y + 0.44, -0.2], [0.24, y + 0.44, 0.2], 0.014)
        return mesh(k)
      }
      const s = SHAPES[sp.shape] || SHAPES.salmon, h = 0.115 * s.h, t = 0.12 * s.tail
      const pts = [0, 0, 0.07, h * 0.6, 0.3, h, 0.6, h * 0.85, 0.84, 0.03]
      if (s.tail) pts.push(1, t, 0.95, 0, 1, -t); else pts.push(1, 0)
      pts.push(0.84, -0.03, 0.6, -h * 0.85, 0.3, -h, 0.07, -h * 0.6)
      k.c(sp.col).prism(pts, -s.th / 2, s.th / 2, { bevel: Math.min(0.03, s.th * 0.3), edge: (i, nx, ny) => k.c(ny < -0.3 ? sp.belly : sp.col), cap: () => k.c(sp.col) })
      if (s.fin) k.c(sp.col).prism([0.34, h * 0.9, 0.5, h + s.fin, 0.58, h * 0.8], -0.008, 0.008)
      k.c(sp.belly).prism([0.25, -h * 0.5, 0.38, -h * 0.55, 0.3, -h * 1.25], s.th / 2 - 0.01, s.th / 2 + 0.006).prism([0.25, -h * 0.5, 0.38, -h * 0.55, 0.3, -h * 1.25], -s.th / 2 - 0.006, -s.th / 2 + 0.01)
      k.c(0x14171a).box(0.075, 0.1, h * 0.2, h * 0.2 + 0.025, -s.th / 2 - 0.004, s.th / 2 + 0.004)
      if (sp.shape === 'sturgeon') { k.c(0xd7d5cc); for (let x = 0.2; x < 0.8; x += 0.1) k.box(x, x + 0.04, h * 0.9, h * 0.9 + 0.02, -0.012, 0.012) }
      const m = mesh(k); m.scale.setScalar(len)
      return m
    },
    // a crab `mm` across, flat on the ground, facing -z
    crab(kind, mm) {
      const k = kit(THREE), c = kind === 'redrock' ? 0xa8392b : 0x9b7286, w = 0.5
      k.c(c).box(-w, w, 0.06, 0.26, -0.3, 0.32, 0.7, 0.6).c(kind === 'redrock' ? 0xd9b9a0 : 0xe6d9c4).box(-w * 0.8, w * 0.8, 0.02, 0.06, -0.26, 0.28)
      k.c(c); for (const s of [-1, 1]) {
        for (let i = 0; i < 4; i++) k.rod([s * w * 0.8, 0.14, 0.26 - i * 0.14], [s * (w + 0.34), 0.02, 0.4 - i * 0.2], 0.035, 0.015)
        k.rod([s * w * 0.6, 0.14, -0.28], [s * (w + 0.1), 0.12, -0.56], 0.05).box(s * (w + 0.02), s * (w + 0.22), 0.06, 0.2, -0.76, -0.5)
      }
      k.c(0x14171a).box(-0.14, -0.08, 0.2, 0.3, -0.34, -0.3).box(0.08, 0.14, 0.2, 0.3, -0.34, -0.3)
      const m = mesh(k); m.scale.setScalar(mm / 1000)
      return m
    },
    // the rod in two parts (both along +y from their origin), so the tip can bend to the line: butt 1.5 m, tip 1.1 m
    rod() {
      const a = kit(THREE), b = kit(THREE)
      a.c(0xb98a5a).rod([0, -0.3, 0], [0, 0.12, 0], 0.022).c(0x2b3440).rod([0, 0.12, 0], [0, 1.5, 0], 0.016, 0.011).c(0xd9a520).wheel(0, 0.2, 0.05, 0.05, 0.04, 8, 'x').c(0x14171a).box(-0.04, -0.03, 0.18, 0.22, 0.05, 0.12)
      b.c(0x2b3440).rod([0, 0, 0], [0, 1.1, 0], 0.011, 0.004).c(0xe8703a).rod([0, 1.02, 0], [0, 1.1, 0], 0.007, 0.005)
      return [mesh(a), mesh(b)]
    },
    bobber() { const k = kit(THREE); k.c(0xf2f2ee).cyl(0.02, 0.055, 0.07, 8, 2).move(0, 0, -0.07, 0); const s = k.at(); k.c(0xd9352b).cyl(0.055, 0.02, 0.07, 8, 1).c(0x14171a).rod([0, 0.07, 0], [0, 0.2, 0], 0.006); k.move(s, 0, 0, 0); return mesh(k) },
    // a ring (two hoops and their netting), or a box trap (fold, pot); the origin on the ground
    trap(id) {
      const k = kit(THREE)
      if (id === 'ring') {
        k.c(0x59636b)
        for (const [r, y] of [[0.42, 0.02], [0.26, 0.3]]) for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2, b = ((i + 1) / 12) * Math.PI * 2; k.rod([Math.cos(a) * r, y, Math.sin(a) * r], [Math.cos(b) * r, y, Math.sin(b) * r], 0.014) }
        k.c(0x8a6f4a); for (let i = 0; i < 12; i += 2) { const a = (i / 12) * Math.PI * 2; k.rod([Math.cos(a) * 0.42, 0.02, Math.sin(a) * 0.42], [Math.cos(a) * 0.26, 0.3, Math.sin(a) * 0.26], 0.008) }
      } else {
        const a = id === 'pot' ? 0.4 : 0.32, h = id === 'pot' ? 0.34 : 0.26
        k.c(id === 'pot' ? 0xd9a520 : 0x59636b)
        for (const y of [0.01, h]) k.rod([-a, y, -a], [a, y, -a], 0.014).rod([a, y, -a], [a, y, a], 0.014).rod([a, y, a], [-a, y, a], 0.014).rod([-a, y, a], [-a, y, -a], 0.014)
        for (const [x, z] of [[-a, -a], [a, -a], [a, a], [-a, a]]) k.rod([x, 0, z], [x, h, z], 0.014)
        k.c(0x3d464d); for (let i = -2; i <= 2; i++) k.rod([i * a * 0.4, h, -a], [i * a * 0.4, h, a], 0.006).rod([-a, h, i * a * 0.4], [a, h, i * a * 0.4], 0.006)
      }
      k.c(0xc0392b).box(-0.06, 0.06, 0.03, 0.12, -0.06, 0.06) // the bait
      return mesh(k)
    },
    float() { const k = kit(THREE); k.c(0xf2f2ee).cyl(0.1, 0.12, 0.14, 8, 3).move(0, 0, -0.08, 0); const s = k.at(); k.c(0xe8703a).cyl(0.12, 0.05, 0.16, 8, 1).move(s, 0, 0.06, 0); return mesh(k) },
    bucket() { const k = kit(THREE); k.c(0xf2f2ee).cyl(0.13, 0.17, 0.3, 10, 2).c(0x2f6f8f).cyl(0.172, 0.176, 0.04, 10, 0).move(k.at() - 60, 0, 0.26, 0); return mesh(k) },
    seal() { const k = kit(THREE); k.c(0x4a4f55).cyl(0.2, 0.16, 0.26, 8, 1).c(0x5a6066).box(-0.08, 0.08, 0.1, 0.2, -0.26, -0.12).c(0x0c0d0f).box(-0.13, -0.08, 0.17, 0.22, -0.17, -0.13).box(0.08, 0.13, 0.17, 0.22, -0.17, -0.13); return mesh(k) },
  }
}
