// A small kit for building flat-shaded low-poly models in code (the life plugin's cars and people, the drive
// plugin's van, bus, walker and street furniture, the sail plugin's boat and buoys): boxes, extruded side profiles with bevelled edges,
// cylinders, all merged into one non-indexed geometry with a colour, a part and a swing per vertex (see life's
// car and people shaders; the drive plugin's van uses the colour as vertex colours). Each shape is added in the
// current state (k.c(colour, part, swing)) and can be moved, turned or scaled afterwards (k.at() marks the start).
export function kit(THREE) {
  const P = [], C = [], A = [], S = [], col = new THREE.Color(), v = new THREE.Vector3()
  let cr = 1, cg = 1, cb = 1, part = 0, swing = 0
  const vert = (x, y, z) => { P.push(x, y, z); C.push(cr, cg, cb); A.push(part); S.push(swing) }
  const tri = (a, b, c) => { vert(...a); vert(...b); vert(...c) }
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d) }
  const k = {
    // colour: a hex number, or null for the instance's colour (part 0); part defaults to 1 (a fixed colour)
    c(colour, p = colour == null ? 0 : 1, s = 0) { col.setHex(colour ?? 0xffffff); cr = col.r; cg = col.g; cb = col.b; part = p; swing = s; return k },
    at: () => P.length / 3,
    tri, quad,
    // move / turn / scale what was added since `from` (a 4x4 matrix, or a function (Vector3) => void)
    xf(from, m) { for (let i = from * 3; i < P.length; i += 3) { v.set(P[i], P[i + 1], P[i + 2]); if (m.isMatrix4) v.applyMatrix4(m); else m(v); P[i] = v.x; P[i + 1] = v.y; P[i + 2] = v.z } return k },
    move(from, x, y, z) { return k.xf(from, (p) => p.set(p.x + x, p.y + y, p.z + z)) },
    rot(from, axis, a) { const m = new THREE.Matrix4(); if (axis === 'x') m.makeRotationX(a); else if (axis === 'y') m.makeRotationY(a); else m.makeRotationZ(a); return k.xf(from, m) },
    // a box between x0..x1, y0..y1, z0..z1 (x and z either way round); the top face shrunk to `taper` of the bottom (about its centre)
    box(x0, x1, y0, y1, z0, z1, taper = 1, taperZ = taper) {
      if (x0 > x1) [x0, x1] = [x1, x0]
      if (z0 > z1) [z0, z1] = [z1, z0]
      const xm = (x0 + x1) / 2, zm = (z0 + z1) / 2, tx = ((x1 - x0) / 2) * taper, tz = ((z1 - z0) / 2) * taperZ
      const b = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [xm - tx, y1, zm - tz], [xm + tx, y1, zm - tz], [xm + tx, y1, zm + tz], [xm - tx, y1, zm + tz]]
      for (const f of [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]) quad(b[f[0]], b[f[1]], b[f[2]], b[f[3]])
      return k
    },
    // a side profile (x, y pairs, either winding) extruded between z0 and z1. o.bevel: the edges all round are
    // chamfered by that much; o.narrow(y): how far each side moves in at height y (tumblehome); o.lean(y): how far
    // everything moves along z at height y (a panel on a leaning side); o.edge(i, nx, ny, y): called before the faces
    // off edge i (outward normal nx, ny; y its middle) to set their colour (k.c); o.cap(): before the two sides
    prism(pts, z0, z1, o = {}) {
      let p = []
      for (let i = 0; i < pts.length; i += 2) p.push([pts[i], pts[i + 1]])
      let area = 0
      for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; area += a[0] * b[1] - b[0] * a[1] }
      if (area < 0) p.reverse()
      const n = p.length, bev = o.bevel || 0, nar = o.narrow, lean = o.lean
      const inset = bev ? p.map((q, i) => { // each corner moved in along its bisector by bev
        const a = p[(i + n - 1) % n], b = p[(i + 1) % n]
        let ax = q[0] - a[0], ay = q[1] - a[1], bx = b[0] - q[0], by = b[1] - q[1]
        const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1
        const n1 = [-ay / la, ax / la], n2 = [-by / lb, bx / lb], m = [n1[0] + n2[0], n1[1] + n2[1]], lm = Math.hypot(...m) || 1
        const d = Math.min(bev * 3, bev / Math.max(0.2, (m[0] * n1[0] + m[1] * n1[1]) / lm))
        return [q[0] + (m[0] / lm) * d, q[1] + (m[1] / lm) * d]
      }) : p
      const zs = (q, z, s) => z + (nar ? s * nar(q[1]) : 0) + (lean ? lean(q[1]) : 0)
      const rings = bev ? [[inset, z0 + 0, 1], [p, z0 + bev, 1], [p, z1 - bev, -1], [inset, z1, -1]] : [[p, z0, 1], [p, z1, -1]]
      const R = rings.map(([q, z, s]) => q.map((r) => [r[0], r[1], zs(r, z, s)]))
      const keep = [cr, cg, cb, part, swing]
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        if (o.edge) { const dx = p[j][0] - p[i][0], dy = p[j][1] - p[i][1], l = Math.hypot(dx, dy) || 1; o.edge(i, dy / l, -dx / l, (p[i][1] + p[j][1]) / 2) }
        for (let r = 0; r < R.length - 1; r++) quad(R[r][i], R[r][j], R[r + 1][j], R[r + 1][i])
        if (o.edge) [cr, cg, cb, part, swing] = keep
      }
      o.cap?.()
      const tris = THREE.ShapeUtils.triangulateShape(inset.map((q) => new THREE.Vector2(q[0], q[1])), [])
      const f = R[R.length - 1], b = R[0]
      for (const [a, c, d] of tris) { tri(f[a], f[c], f[d]); tri(b[a], b[d], b[c]) }
      if (o.cap) [cr, cg, cb, part, swing] = keep
      return k
    },
    // a cylinder (or cone) standing on the origin along +y, r0 at the bottom, r1 at the top; caps: 0 none, 1 top, 3 both
    cyl(r0, r1, h, seg = 8, caps = 3, a0 = 0, a1 = Math.PI * 2) {
      const full = a1 - a0 >= Math.PI * 2 - 1e-6, m = full ? seg : seg + 1
      const ring = (r, y) => Array.from({ length: m }, (_, i) => { const a = a0 + ((a1 - a0) * i) / seg; return [Math.cos(a) * r, y, -Math.sin(a) * r] })
      const lo = ring(r0, 0), hi = ring(r1, h)
      for (let i = 0; i < seg; i++) { const j = (i + 1) % m; quad(lo[i], lo[j], hi[j], hi[i]) }
      if (caps & 1) for (let i = 0; i < seg; i++) tri([0, h, 0], hi[i], hi[(i + 1) % m])
      if (caps & 2) for (let i = 0; i < seg; i++) tri([0, 0, 0], lo[(i + 1) % m], lo[i])
      return k
    },
    // a cylinder lying along z (or x), centred on (x, y, z): a wheel, a hub, an axle
    wheel(x, y, z, r, w, seg = 10, axis = 'z') { const s = k.at(); k.cyl(r, r, w, seg, 3); return k.move(s, 0, -w / 2, 0).rot(s, axis === 'z' ? 'x' : 'z', Math.PI / 2).move(s, x, y, z) },
    // a rod (a tapered cylinder) from a to b ([x, y, z])
    rod(a, b, r0, r1 = r0, seg = 6) {
      const s = k.at(), d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), L = d.length()
      k.cyl(r0, r1, L, seg, 1)
      return k.xf(s, new THREE.Matrix4().compose(new THREE.Vector3(...a), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()), new THREE.Vector3(1, 1, 1)))
    },
    // plain: the colours as vertex colours (`color`, for a vertexColors material like kitMaterial), without the
    // life shader's aCol, aPart and aSwing
    geometry(plain = false) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
      g.setAttribute(plain ? 'color' : 'aCol', new THREE.Float32BufferAttribute(C, 3))
      if (!plain) { g.setAttribute('aPart', new THREE.Float32BufferAttribute(A, 1)); g.setAttribute('aSwing', new THREE.Float32BufferAttribute(S, 1)) }
      g.computeVertexNormals()
      return g
    },
  }
  return k
}

// a side profile's bottom edge for prism(), left to right at yb, up and over each wheel arch ([centre x, radius])
// around the axle at height cy
export function under(x0, x1, yb, arches, cy, seg = 6) {
  const out = [x0, yb]
  for (const [cx, r] of arches) {
    out.push(cx - r, yb)
    for (let i = 0; i <= seg; i++) { const t = Math.PI - (Math.PI * i) / seg; out.push(cx + r * Math.cos(t), Math.max(yb, cy + r * Math.sin(t))) }
    out.push(cx + r, yb)
  }
  out.push(x1, yb)
  return out
}

// The shared look of the low-poly models: a little darker towards the ground (vH: the model's own height; they
// stand in their own shadow) and a cool rim light where faces turn away from the eye, less at night (uNight)
export const SHADE = {
  vars: 'varying float vH;',
  vert: 'vH = position.y;',
  frag: 'diffuseColor.rgb *= mix(0.68, 1.0, smoothstep(0.0, 0.6, vH));',
  rim: 'totalEmissiveRadiance += vec3(0.05, 0.06, 0.08) * (1.0 - 0.8 * uNight) * pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 3.0);',
}
// a Lambert material with SHADE (night: a { value } uniform shared with whoever knows the time of day; ao false:
// no darkening by height, for parts hung from a pivot)
export function shaded(m, night = { value: 0 }, ao = true) {
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = night
    s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>\n${SHADE.vars}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${SHADE.vert}`)
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>\n${SHADE.vars} uniform float uNight;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${ao ? SHADE.frag : ''}`).replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${SHADE.rim}`)
  }
  m.customProgramCacheKey = () => (ao ? 'shaded' : 'shaded-flat')
  return m
}
// the material for a kit's plain geometry (geometry(true)): its vertex colours, flat-shaded, with SHADE
export const kitMaterial = (THREE, night, ao) => shaded(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), night, ao)
