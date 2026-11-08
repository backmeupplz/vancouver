// Landmarks: hand-modelled low-poly landmarks, port terminals and the big bridges of the Lower Mainland,
// placed on their exact OpenStreetMap footprints and bridge ways (data.json, made by tools/landmarks_data.py).
// Everything is merged into one vertex-coloured mesh per 2.5 km cell (plus one instanced mesh of containers
// per terminal), built once; nothing animates.
// Map data (c) OpenStreetMap contributors, ODbL. Ground under the bridges: MRDEM (NRCan), OGL-Canada.
import { mulberry32 as mulberry, inPoly, getJSON } from '../../core/util.js'
const data = await getJSON(new URL('./data.json', import.meta.url))
const pairs = (f) => { const o = []; for (let i = 0; i < f.length; i += 2) o.push([f[i], f[i + 1]]); return o }

// Deck height profiles of the modelled bridges, for the core to share: `line` is the centre line
// (lat, lon pairs, one every `step` metres from the southern end), `deck` the deck top there in metres above
// the water under the bridge (MRDEM sea level; `ground` is the MRDEM ground under each point, so a frame
// whose water sits at W puts the deck at W + deck[i]), `half` the half-width of the deck in metres.
// Footprints (rings of [lat, lon]) where generic OSM buildings should not be drawn: the landmarks stand there.
export const masks = [
  ...Object.entries(data.landmarks).filter(([k]) => k !== 'vancouverhouse').flatMap(([, l]) => l.rings.map(pairs)),
  ...data.landmarks.vancouverhouse.parts.map((p) => pairs(p.r)),
  ...Object.values(data.terminals).flatMap((t) => t.silos.map(pairs)),
]

export default function landmarks(city) {
  const { THREE } = city
  const V = (x, y, z) => new THREE.Vector3(x, y, z)
  const cols = new Map()
  const col = (h) => { if (!cols.has(h)) cols.set(h, new THREE.Color(h)); return cols.get(h) }
  const rnd = mulberry(7)
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _v = new THREE.Vector3(), _c = new THREE.Color()
  const Y = V(0, 1, 0)

  // ---------- one batch of triangles per 2.5 km cell ----------
  const cells = new Map()
  let B = null
  const at = (x, z) => { const k = `${Math.floor(x / 2500)},${Math.floor(z / 2500)}`; if (!cells.has(k)) cells.set(k, { p: [], c: [] }); B = cells.get(k) }
  const vert = (x, y, z, c) => { B.p.push(x, y, z); B.c.push(c.r, c.g, c.b) }
  const tri = (a, b, d, c) => { vert(a.x, a.y, a.z, c); vert(b.x, b.y, b.z, c); vert(d.x, d.y, d.z, c) }
  const quad = (a, b, d, e, c) => { tri(a, b, d, c); tri(a, d, e, c) }
  const unit = {}
  const prim = (k, make) => unit[k] ??= make().toNonIndexed()
  function geo(g, m, hex, vary = 0) { // add a three.js geometry, transformed; vary = per-face lightness jitter
    const a = g.attributes.position.array, base = col(hex)
    for (let i = 0; i < a.length; i += 9) {
      const c = vary ? _c.copy(base).offsetHSL(0, 0, (rnd() - 0.5) * vary) : base
      for (let j = 0; j < 9; j += 3) { _v.set(a[i + j], a[i + j + 1], a[i + j + 2]).applyMatrix4(m); vert(_v.x, _v.y, _v.z, c) }
    }
  }
  const piers = [] // bridge piers and towers standing in the water: x, z, half length, half width, rot (city.landmarks)
  let pierWater = null // the water level while a bridge is drawn
  const box = (x, y, z, sx, sy, sz, rot, hex) => { // y = bottom
    if (pierWater !== null && y <= pierWater + 0.5) piers.push(x, z, sx / 2, sz / 2, rot)
    geo(prim('box', () => new THREE.BoxGeometry(1, 1, 1)), _m.compose(_p.set(x, y + sy / 2, z), _q.setFromAxisAngle(Y, rot), _s.set(sx, sy, sz)), hex)
  }
  const cyl = (x, y, z, r, h, hex, n = 12, rTop = r) =>
    geo(prim(`c${n}${rTop / r}`, () => new THREE.CylinderGeometry(rTop / r, 1, 1, n)), _m.compose(_p.set(x, y + h / 2, z), _q.identity(), _s.set(r, h, r)), hex)
  function beam(a, b, w, hex, h = w) { // a square bar from a to b
    const d = _v.subVectors(b, a), len = d.length()
    if (len < 0.01) return
    _q.setFromUnitVectors(Y, d.divideScalar(len))
    geo(prim('box', () => new THREE.BoxGeometry(1, 1, 1)), _m.compose(_p.addVectors(a, b).multiplyScalar(0.5), _q, _s.set(w, len, h)), hex)
  }

  // ---------- footprints ----------
  const P = (lat, lon) => { const v = city.world.fromLatLon(lat, lon); return [v.x, v.z] }
  const ringXZ = (f) => pairs(f).map(([la, lo]) => P(la, lo)).filter((p, i, a) => i < a.length - 1 || p[0] !== a[0][0] || p[1] !== a[0][1])
  const centroid = (r) => r.reduce((s, p) => [s[0] + p[0] / r.length, s[1] + p[1] / r.length], [0, 0])
  const groundOf = (r) => Math.min(...r.map(([x, z]) => city.world.heightAt(x, z)))
  const inflate = (r, d) => { const [cx, cz] = centroid(r); return r.map(([x, z]) => { const l = Math.hypot(x - cx, z - cz) || 1; return [x + ((x - cx) / l) * d, z + ((z - cz) / l) * d] }) }
  const scaleRing = (r, k, c = centroid(r)) => r.map(([x, z]) => [c[0] + (x - c[0]) * k, c[1] + (z - c[1]) * k])
  function obb(r) { // oriented bounding box: centre, long axis unit (ux, uz), half length, half width
    let best = null
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / l, uz = (b[1] - a[1]) / l
      let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9
      for (const [x, z] of r) { const u = x * ux + z * uz, v = -x * uz + z * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v) }
      const ar = (u1 - u0) * (v1 - v0)
      if (!best || ar < best.ar) best = { ar, ux, uz, u0, u1, v0, v1 }
    }
    let { ux, uz, u0, u1, v0, v1 } = best
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2
    const o = { cx: uc * ux - vc * uz, cz: uc * uz + vc * ux, ux, uz, hl: (u1 - u0) / 2, hw: (v1 - v0) / 2 }
    if (o.hw > o.hl) Object.assign(o, { ux: -uz, uz: ux, hl: o.hw, hw: o.hl })
    return o
  }
  function walls(r, y0, y1, hex, bands) { // bands: [period, height of the second colour, its colour] (window strips)
    const ys = [y0]
    if (bands) for (let y = y0 + bands[0] - bands[1]; y < y1 - 0.5; y += bands[0]) ys.push(y, Math.min(y1, y + bands[1]))
    ys.push(y1)
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length]
      for (let k = 0; k < ys.length - 1; k++) {
        if (ys[k + 1] - ys[k] < 0.01) continue
        quad(V(a[0], ys[k], a[1]), V(b[0], ys[k], b[1]), V(b[0], ys[k + 1], b[1]), V(a[0], ys[k + 1], a[1]), col(bands && k % 2 ? bands[2] : hex))
      }
    }
  }
  function cap(r, y, hex) {
    const idx = THREE.ShapeUtils.triangulateShape(r.map(([x, z]) => new THREE.Vector2(x, z)), [])
    for (const [a, b, d] of idx) tri(V(r[a][0], y, r[a][1]), V(r[b][0], y, r[b][1]), V(r[d][0], y, r[d][1]), col(hex))
  }
  // a surface over a ring at height h(x, z), its triangles split until no edge is longer than maxLen; hex(x, z)
  // colours each triangle (at its middle)
  function drape(r, h, hex, maxLen) {
    const split = (a, b, c, d) => {
      const l = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(c[0] - a[0], c[1] - a[1]))
      if (l > maxLen && d < 7) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); split(a, ab, ca, d + 1); split(ab, b, bc, d + 1); split(ca, bc, c, d + 1); split(ab, bc, ca, d + 1); return }
      const v3 = ([x, z]) => V(x, h(x, z), z)
      tri(v3(a), v3(b), v3(c), col(hex((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3)))
    }
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(r.map(([x, z]) => new THREE.Vector2(x, z)), [])) split(r[a], r[b], r[c], 0)
  }
  function loft(r0, y0, r1, y1, hex, alt) { // band between two rings with the same number of points
    for (let i = 0; i < r0.length; i++) {
      const j = (i + 1) % r0.length
      quad(V(r0[i][0], y0, r0[i][1]), V(r0[j][0], y0, r0[j][1]), V(r1[j][0], y1, r1[j][1]), V(r1[i][0], y1, r1[i][1]), col(alt && i % 2 ? alt : hex))
    }
  }
  function prism(r, y0, y1, wall, top, bands) { walls(r, y0, y1, wall, bands); cap(r, y1, top) }
  function roof(r, y, shape, rh, hex) {
    const c = centroid(r)
    if (shape === 'pyramidal') { for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; tri(V(a[0], y, a[1]), V(b[0], y, b[1]), V(c[0], y + rh, c[1]), col(hex)) } return }
    if (shape === 'dome') {
      let prev = r, py = y
      for (let k = 1; k <= 5; k++) { const t = (k / 5) * Math.PI / 2, ring = scaleRing(r, Math.cos(t), c), ny = y + rh * Math.sin(t); loft(prev, py, ring, ny, hex); prev = ring; py = ny }
      return
    }
    if (['hipped', 'gabled', 'gambrel', 'half-hipped', 'mansard'].includes(shape)) {
      const o = obb(r), L = Math.max(0, o.hl - o.hw)
      const ridge = ([x, z]) => { const t = Math.max(-L, Math.min(L, (x - o.cx) * o.ux + (z - o.cz) * o.uz)); return V(o.cx + o.ux * t, y + rh, o.cz + o.uz * t) }
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length], ra = ridge(a), rb = ridge(b)
        if (ra.distanceTo(rb) < 0.01) tri(V(a[0], y, a[1]), V(b[0], y, b[1]), ra, col(hex))
        else quad(V(a[0], y, a[1]), V(b[0], y, b[1]), rb, ra, col(hex))
      }
      return
    }
    cap(r, y, hex)
  }
  // a building:part from OSM simple 3D buildings tags; pal(part) gives { wall, roof, bands }
  function part(p, g, pal) {
    const r = inflate(ringXZ(p.r), 0.3)
    if (r.length < 3) return
    const h = p.h ?? (p.lv ? p.lv * 3.4 : 10), mh = p.mh || 0, s = pal(p, h)
    if (h - mh < 0.3) return
    if (ringRadius(r) < 3 && h - mh > 8) { const [x, z] = centroid(r); beam(V(x, g + mh, z), V(x, g + h, z), 0.8, 0xe4e4e0); return } // a spire or flagpole
    const pitched = p.roof && p.roof !== 'flat' && p.roof !== 'skillion'
    const rh = pitched ? Math.min(p.rh ?? 12, (h - mh) * 0.7, 30) * (p.rh > h - mh ? 0.15 : 1) : 0
    walls(r, g + mh, g + h - rh + 0.05, s.wall, s.bands)
    roof(r, g + h - rh + 0.05, pitched ? p.roof : 'flat', rh, s.roof)
  }

  const L = data.landmarks
  // ---------- Science World: the geodesic sphere (Expo 86) on its low base, on False Creek ----------
  {
    const lm = L.scienceworld, root = ringXZ(lm.rings[0]), g = groundOf(root)
    at(...root[0])
    for (const p of lm.parts) {
      if (p.roof === 'dome') {
        const r = ringXZ(p.r), [cx, cz] = centroid(r), R = 23.5
        const y = g + (p.h || 48) - R
        geo(new THREE.IcosahedronGeometry(1, 3), _m.compose(_p.set(cx, y, cz), _q.identity(), _s.set(R, R, R)), 0xd4d9dd, 0.12)
        for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; beam(V(cx + Math.cos(a) * R * 0.72, g + 9, cz + Math.sin(a) * R * 0.72), V(cx + Math.cos(a) * R * 0.62, y - R * 0.78, cz + Math.sin(a) * R * 0.62), 1.2, 0x7d8388) }
      } else if (p.mh) prism(inflate(ringXZ(p.r), 0.3), g + p.mh, g + p.h, 0x5d6670, 0x8a9096)
      else part(p, g, (q) => q.h > 12 ? { wall: 0xe8e8e2, roof: 0xb8b9b4, bands: [4.6, 1.8, 0x6d8aa0] } : { wall: 0xf1efe8, roof: 0xa9aaa6, bands: [5, 2.2, 0x7d97aa] })
    }
  }
  // ---------- BC Place: the oval bowl, its white cable-net roof on a ring of 36 masts, the retractable centre ----------
  // Heights from the HRDEM LiDAR surface: the roof's rim about 50 m over the ground, its centre about 61 m
  {
    const root = ringXZ(L.bcplace.rings[0]), g = groundOf(root), c = centroid(root)
    at(...c)
    const ring = resample(root, 72)
    prism(ring, g, g + 40, 0xdcdedd, 0xdcdedd, [8, 2.4, 0x7f97a8])
    walls(scaleRing(ring, 1.012, c), g + 40, g + 47, 0xf4f4f0, [7, 2.2, 0x5f7488]) // the LED ribbon round the top
    const levels = [[1.012, 47], [0.97, 49.5], [0.8, 55], [0.6, 59], [0.42, 61]]
    for (let k = 0; k < levels.length - 1; k++) loft(scaleRing(ring, levels[k][0], c), g + levels[k][1], scaleRing(ring, levels[k + 1][0], c), g + levels[k + 1][1], 0xf7f7f3, 0xe6e9e6)
    const inner = scaleRing(ring, 0.42, c), net = scaleRing(ring, 0.72, c)
    loft(inner, g + 61, scaleRing(ring, 0.36, c), g + 62.4, 0xd2d8dc) // the ring beam and the closed centre panels
    cap(scaleRing(ring, 0.36, c), g + 62.4, 0xdfe5e8)
    const masts = resample(root, 36)
    for (let i = 0; i < 36; i++) {
      const [x, z] = masts[i], top = V(c[0] + (x - c[0]) * 1.05, g + 82, c[1] + (z - c[1]) * 1.05)
      beam(V(x, g + 30, z), V(c[0] + (x - c[0]) * 1.035, g + 66, c[1] + (z - c[1]) * 1.035), 2.6, 0xf6f6f2)
      beam(V(c[0] + (x - c[0]) * 1.035, g + 66, c[1] + (z - c[1]) * 1.035), top, 1.7, 0xf6f6f2)
      const j = Math.round((i / 36) * inner.length) % inner.length
      beam(top, V(inner[j][0], g + 61.2, inner[j][1]), 0.45, 0xe4e7e6) // the cables down to the centre ring
      beam(top, V(net[j][0], g + 56.6, net[j][1]), 0.4, 0xe4e7e6)
    }
  }
  // ---------- Rogers Arena: grey arena with a shallow dome ----------
  {
    const lm = L.rogers, root = ringXZ(lm.rings[0]), g = groundOf(root)
    at(...root[0])
    prism(inflate(root, 0.3), g, g + 15, 0xc6ccd1, 0x9aa1a7, [5, 2.4, 0x50677a])
    for (const p of lm.parts) {
      const r = inflate(ringXZ(p.r), 0.4)
      prism(r, g, g + 29, 0xd5d9dc, 0xd5d9dc, [6, 3, 0x5a7286])
      roof(r, g + 29, 'dome', 9, 0xd3d8db) // its top 38 m up (LiDAR)
    }
  }
  // ---------- Canada Place: the five white sails on the pier, the Pan Pacific, the convention centre ----------
  {
    const lm = L.canadaplace, root = ringXZ(lm.rings[0]), g = groundOf(root)
    at(...root[0])
    prism(inflate(root, 0.3), g, g + 11, 0xf0ece2, 0xb9b9b4, [4.5, 1.5, 0x8aa2b0])
    for (const p of lm.parts) {
      const sail = p.lv === 6 && (p.roof === 'gabled' || p.roof === 'gambrel') && p.r.length <= 12
      if (sail) sails(ringXZ(p.r), g + 22)
      else part(p, g, (q, h) => h > 28 ? { wall: 0xdfe3e2, roof: 0x9fa4a6, bands: [3.3, 1.9, 0x7d9cb2] } : { wall: 0xf3f0e8, roof: 0xb4b5b0, bands: [4.5, 1.6, 0x8ea6b4] })
    }
  }
  function sails(r, y) { // a tent of white fabric over a rectangle: two masts, the ridge dipping between them
    const o = obb(r), u = [o.ux, o.uz], v = [-o.uz, o.ux]
    const pt = (a, b, h) => V(o.cx + u[0] * a + v[0] * b, h, o.cz + u[1] * a + v[1] * b)
    walls(r, y - 9, y, 0xf0ede4, [4.5, 1.5, 0x88a0ae])
    const prof = [[-1, 4], [0.12, 19.5], [1, 4]] // along the long axis: height above the roof (peaks ~45 m over the water, LiDAR)
    const W = o.hw * 0.86
    for (let k = 0; k < prof.length - 1; k++) {
      const [a0, h0] = prof[k], [a1, h1] = prof[k + 1]
      const r0 = pt(a0 * o.hl, 0, y + h0), r1 = pt(a1 * o.hl, 0, y + h1)
      for (const s of [-1, 1]) {
        const e0 = pt(a0 * o.hl, s * W, y + 0.5), e1 = pt(a1 * o.hl, s * W, y + 0.5)
        const m0 = pt(a0 * o.hl, s * W * 0.5, y + h0 * 0.42 + 0.5), m1 = pt(a1 * o.hl, s * W * 0.5, y + h1 * 0.42 + 0.5) // the cloth sags
        quad(e0, e1, m1, m0, col(0xf2f2ee)); quad(m0, m1, r1, r0, col(0xfbfbf8))
      }
    }
    for (const [a, h] of [prof[1]]) beam(pt(a * o.hl, 0, y + h - 2), pt(a * o.hl, 0, y + h + 5), 0.6, 0xd8dadb)
  }
  // ---------- Vancouver Convention Centre West: glass walls under a tilted 2.4 ha living roof ----------
  // The roof is five planes (OSM's skillion parts), each tilted as the HRDEM LiDAR surface has it: [lat, lon of a
  // point inside the part, roof elevation there, rise per metre east, per metre north]. Two meadow wings rise away
  // from a flat valley between them; the west tip and the street side fall towards Jack Poole Plaza and the street.
  {
    const PLANES = [[49.289116, -123.115124, 37.9, 0.06, 0.061], [49.289359, -123.116015, 37.1, -0.021, -0.072],
      [49.28861, -123.116172, 32.5, 0.033, 0.177], [49.289158, -123.116969, 31.9, 0.144, -0.05], [49.289139, -123.11556, 33.1, -0.024, 0.014]]
      .map(([la, lo, y, e, n]) => { const [x, z] = P(la, lo); return { x, z, y, e, n } })
    const lm = L.vccwest
    at(...ringXZ(lm.rings[0])[0])
    for (const p of lm.parts) {
      const r = inflate(ringXZ(p.r), 0.3), pl = PLANES.find((q) => inPoly(q.x, q.z, r))
      const h = pl ? (x, z) => pl.y + (x - pl.x) * pl.e - (z - pl.z) * pl.n : () => groundOf(r) + 22
      const g = groundOf(r) - 0.5, flat = pl && Math.abs(pl.e) + Math.abs(pl.n) < 0.05
      for (let i = 0; i < r.length; i++) { // glass from the deck to the roof, thin mullions every storey
        const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length], ta = h(ax, az) - 1.4, tb = h(bx, bz) - 1.4
        for (let y = g; y < Math.max(ta, tb); y += 4.6) {
          const y1 = (t) => Math.min(t, y + 4.6), y0 = (t) => Math.min(t, y)
          quad(V(ax, y0(ta), az), V(bx, y0(tb), bz), V(bx, y1(tb), bz), V(ax, y1(ta), az), col(0x88aebb))
          quad(V(ax, y1(ta) - 0.35, az), V(bx, y1(tb) - 0.35, bz), V(bx, y1(tb), bz), V(ax, y1(ta), az), col(0x5f6f74))
        }
      }
      // the roof overhangs the glass: a timber soffit, a thin pale edge, then the meadow (or the valley's paving)
      const eave = inflate(r, flat ? 0.4 : 3)
      for (let i = 0; i < r.length; i++) {
        const j = (i + 1) % r.length, a = r[i], b = r[j], ea = eave[i], eb = eave[j]
        quad(V(a[0], h(...a) - 1.4, a[1]), V(b[0], h(...b) - 1.4, b[1]), V(eb[0], h(...eb) - 1.2, eb[1]), V(ea[0], h(...ea) - 1.2, ea[1]), col(0xe8cfa6))
        quad(V(ea[0], h(...ea) - 1.2, ea[1]), V(eb[0], h(...eb) - 1.2, eb[1]), V(eb[0], h(...eb) + 0.4, eb[1]), V(ea[0], h(...ea) + 0.4, ea[1]), col(0xdcdfdc))
      }
      drape(eave, (x, z) => h(x, z) + 0.4, flat ? () => 0xb9b5aa : meadow, 9)
    }
  }
  function meadow(x, z) { // grass with drifts of drier, golden patches, as the roof's native meadow grows
    const n = Math.sin(x * 0.045 + 1.7) * Math.sin(z * 0.06 - 0.4) + 0.6 * Math.sin((x - z) * 0.11) + 0.3 * Math.sin(x * 0.31 + z * 0.23)
    return n > 0.75 ? 0x9da259 : n > 0.2 ? 0x7f9e4b : n > -0.6 ? 0x729646 : 0x668c42
  }
  // ---------- Harbour Centre and its Lookout saucer ----------
  {
    const lm = L.harbourcentre, g = groundOf(ringXZ(lm.rings[0]))
    at(...ringXZ(lm.rings[0])[0])
    for (const p of lm.parts) {
      if (p.h > 150 && p.r.length > 4 && ringRadius(ringXZ(p.r)) < 3) { // the antenna on top
        if (p.roof === 'pyramidal') { const [x, z] = centroid(ringXZ(p.r)); beam(V(x, g + 155, z), V(x, g + 177, z), 0.9, 0xe9e9e6) }
        continue
      }
      part(p, g, (q, h) => q.mh >= 128 ? { wall: { 128: 0xf2f2ee, 136: 0x34495c, 144: 0xf2f2ee, 148: 0x5d656c }[q.mh] ?? 0xe8e8e4, roof: 0xd6d6d2 }
        : q.mh >= 116 || q.h === 139 ? { wall: 0xdad3c4, roof: 0xb8b2a6 }
          : h > 40 ? { wall: 0xdcd4c3, roof: 0xa9a49a, bands: [3.9, 1.6, 0x4f6272] } : { wall: 0xd8cfbd, roof: 0xa29d94, bands: [4.2, 1.8, 0x5d7284] })
    }
  }
  // ---------- Hotel Vancouver: grey stone château with the green copper roof ----------
  {
    const lm = L.hotelvancouver, g = groundOf(ringXZ(lm.rings[0]))
    at(...ringXZ(lm.rings[0])[0])
    for (const p of lm.parts) part(p, g, (q) => ({ wall: 0xbfb4a0, roof: q.roof && q.roof !== 'flat' ? 0x5e9c84 : 0x8d8b86, bands: [3.4, 0.9, 0x8c8478] }))
  }
  // ---------- Marine Building: terracotta art deco setbacks ----------
  {
    const lm = L.marine, g = groundOf(ringXZ(lm.rings[0]))
    at(...ringXZ(lm.rings[0])[0])
    for (const p of lm.parts) part(p, g, (q) => ({ wall: 0xc79470, roof: q.roof === 'hipped' ? 0x6e9f8e : 0x8f7e70, bands: [3.6, 1.3, 0x6e5a4c] }))
  }
  // ---------- Shangri-La: the slim glass tower ----------
  {
    const lm = L.shangrila, g = groundOf(ringXZ(lm.rings[0]))
    at(...ringXZ(lm.rings[0])[0])
    for (const p of lm.parts) part(p, g, (q, h) => ({ wall: h > 100 ? 0x9cb6c8 : 0xc9cdd0, roof: 0x8f9aa2, bands: h > 100 ? [3.3, 2.2, 0x6f8ea6] : [4, 2, 0x7d97aa] }))
  }
  // ---------- Vancouver House: a triangle at the street that twists out to a rectangle at the top ----------
  {
    const tp = L.vancouverhouse.parts[0], top = ringXZ(tp.r).slice(0, 4), g = groundOf(top), H = tp.h || 150
    at(...top[0])
    // the side facing the Granville Bridge ramps is pulled in to a point at the bottom
    const gb = ringXZ(data.bridges.granville.line), near = (p) => Math.min(...gb.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])))
    let k = 0
    for (let i = 1; i < 4; i++) if (near(mid(top[i], top[(i + 1) % 4])) < near(mid(top[k], top[(k + 1) % 4]))) k = i
    const m = mid(top[k], top[(k + 1) % 4])
    const fm = mid(top[(k + 2) % 4], top[(k + 3) % 4]), tip = [m[0] + (fm[0] - m[0]) * 0.15, m[1] + (fm[1] - m[1]) * 0.15]
    const base = top.map((p, i) => (i === k || i === (k + 1) % 4 ? tip : [p[0] + (fm[0] - p[0]) * 0.18, p[1] + (fm[1] - p[1]) * 0.18]))
    const shape = (t) => { const f = Math.min(1, Math.max(0, (t - 0.08) / 0.92)); return top.map((p, i) => [base[i][0] + (p[0] - base[i][0]) * f, base[i][1] + (p[1] - base[i][1]) * f]) }
    const F = 3.1, n = Math.floor((H - 6) / F)
    prism(scaleRing(shape(0), 1.01), g, g + 6, 0x8fa7b6, 0xcfd2d2)
    for (let i = 0; i < n; i++) {
      const y = g + 6 + i * F, r = shape((i + 0.5) / n), slab = scaleRing(r, 1.03)
      prism(slab, y, y + 0.7, 0xf2f3f1, 0xf2f3f1)
      walls(scaleRing(r, 0.97), y + 0.7, y + F, 0x7f9fb3)
    }
    cap(shape(1), g + 6 + n * F, 0xa8aeb0)
  }
  // ---------- the Olympic cauldron (Jack Poole Plaza) and the Gastown steam clock ----------
  {
    const [x, z] = P(...data.points.cauldron), g = city.world.heightAt(x, z)
    at(x, z)
    box(x, g, z, 16, 0.6, 16, 0.3, 0x9a9d9c)
    for (let i = 0; i < 4; i++) {
      const a = 0.3 + (i / 4) * Math.PI * 2 + Math.PI / 4, c = Math.cos(a), s = Math.sin(a)
      beam(V(x + c * 6.5, g, z + s * 6.5), V(x + c * 1.4, g + 10.5, z + s * 1.4), 1.5, 0xe9edef, 0.5)
    }
    cyl(x, g + 9.6, z, 1.8, 1, 0x6e7173, 10, 2.4)
    geo(prim('flame', () => new THREE.ConeGeometry(1, 1, 7)), _m.compose(_p.set(x, g + 12, z), _q.identity(), _s.set(1.5, 3.5, 1.5)), 0xf2a33a)
  }
  {
    const [x, z] = P(...data.points.steamclock), g = city.world.heightAt(x, z)
    at(x, z)
    box(x, g, z, 1.4, 0.6, 1.4, 0, 0x6c4a32); box(x, g + 0.6, z, 1.0, 3.4, 1.0, 0, 0x5b3d2a)
    box(x, g + 4, z, 1.3, 1.3, 1.3, 0, 0xc9a24a); box(x, g + 4.15, z, 1.34, 1.0, 1.34, 0, 0xf0ead8)
    geo(prim('cone4', () => new THREE.ConeGeometry(1, 1, 4)), _m.compose(_p.set(x, g + 5.9, z), _q.setFromAxisAngle(Y, Math.PI / 4), _s.set(1.1, 1.4, 1.1)), 0x5b3d2a)
  }
  // ---------- Granville Island: the Public Market shed and the Ocean Concrete silos painted as giants ----------
  {
    const r = ringXZ(L.gimarket.rings[0]), g = groundOf(r)
    at(...r[0])
    prism(inflate(r, 0.3), g, g + 7, 0xe2cf9c, 0x8b9196, [3.5, 1.5, 0x9a4436])
    roof(inflate(r, 0.3), g + 7, 'gabled', 5, 0x8b9196)
  }
  { // the six Ocean Concrete silos OSGEMEOS painted as giants, and the plant's two plain ones
    const PAL = [0xf2b134, 0xe2603a, 0x3f86c8, 0x6cbf5a, 0xe86fa4, 0xf4e04d, 0x7b5bc4, 0x2fb3a8]
    L.giants.rings.forEach((f, s) => {
      const r = ringXZ(f), [x, z] = centroid(r), R = ringRadius(r) + 0.4, g = groundOf(r), H = 33.6, n = 12
      at(x, z)
      for (let a = 0; a < n; a++) for (let b = 0; b < 4; b++) {
        const a0 = (a / n) * Math.PI * 2, a1 = ((a + 1) / n) * Math.PI * 2, y0 = g + (H * b) / 4, y1 = g + (H * (b + 1)) / 4
        quad(V(x + Math.cos(a0) * R, y0, z + Math.sin(a0) * R), V(x + Math.cos(a1) * R, y0, z + Math.sin(a1) * R), V(x + Math.cos(a1) * R, y1, z + Math.sin(a1) * R), V(x + Math.cos(a0) * R, y1, z + Math.sin(a0) * R),
          col(PAL[(s * 3 + ((a * 7 + b * 3) >> 2)) % PAL.length]))
      }
      cyl(x, g + H, z, R, 0.4, 0x9a9a96, 12)
    })
    for (const f of L.oceanconcrete.rings) { const r = ringXZ(f), [x, z] = centroid(r); at(x, z); cyl(x, groundOf(r), z, ringRadius(r) + 0.4, 34, 0xc9c6bd, 14) }
  }

  // ---------- the port ----------
  const containerSets = []
  for (const [name, t] of Object.entries(data.terminals)) port(name, t)
  function port(name, t) {
    const ring = ringXZ(t.ring), c = centroid(ring), g = city.world.heightAt(...c)
    at(...c)
    const rng = mulberry(name.length * 977 + ring.length)
    let q0, q1, u, v, Lq
    if (t.quay) {
      q0 = P(t.quay[0], t.quay[1]); q1 = P(t.quay[2], t.quay[3])
      Lq = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]); u = [(q1[0] - q0[0]) / Lq, (q1[1] - q0[1]) / Lq]
      const land = P(...t.land); v = [-u[1], u[0]]
      if ((land[0] - q0[0]) * v[0] + (land[1] - q0[1]) * v[1] < 0) v = [-v[0], -v[1]]
    } else {
      const o = obb(ring); u = [o.ux, o.uz]; v = [-o.uz, o.ux]; Lq = o.hl * 2
      q0 = [o.cx - u[0] * o.hl - v[0] * o.hw, o.cz - u[1] * o.hl - v[1] * o.hw]; q1 = [q0[0] + u[0] * Lq, q0[1] + u[1] * Lq]
    }
    const W = (a, b) => [q0[0] + u[0] * a + v[0] * b, q0[1] + u[1] * a + v[1] * b] // quay frame: a along, b inland
    const ins = (p) => inPoly(p[0], p[1], ring)
    let depth = 0
    for (const [x, z] of ring) depth = Math.max(depth, (x - q0[0]) * v[0] + (z - q0[1]) * v[1])
    const rot = Math.atan2(-u[1], u[0])
    if (t.kind === 'containers') {
      const inst = []
      const CRANE = name === 'centerm' ? [0x2f6fb0, 0xf2f2ee] : [0xd2402f, 0xf2f2ee]
      // ship-to-shore cranes every ~95 m along the berth (the terminal's edge facing the water), none on Ballantyne
      // Pier's cruise berth (the ships plugin berths cruise ships there)
      const cruise = P(49.289, -123.08983)
      for (let a = 40; a < Lq - 30; a += 95) {
        if (Math.hypot(W(a, 0)[0] - cruise[0], W(a, 0)[1] - cruise[1]) < 170) continue
        let b0 = -20
        while (b0 < 150 && !ins(W(a, b0))) b0 += 4
        if (b0 < 150 && ins(W(a, b0 + 40))) stsCrane(W(a + (rng() - 0.5) * 30, b0 + 4), u, v, g, CRANE, rng)
      }
      // the yard: blocks six containers wide and ten long, lanes between, stacks of 1-5 in shipping-line colours
      const COL = [0x5aa3c4, 0xcdb985, 0x34507f, 0x4a7f58, 0xc9773a, 0x9c4a74, 0x8a8f94, 0xdcdcd6, 0x8f4434, 0x6b5444, 0xb0443a, 0x9aa0a4, 0x5aa3c4, 0xdcdcd6]
      for (let b = 75; b < depth - 12; b += 26) {
        let run = 0, hex = 0
        for (let a = 10; a < Lq - 10; a += 12.8) {
          if (Math.floor(a / 12.8) % 11 === 10) continue // a lane every ten bays
          if (!ins(W(a - 14, b - 4)) || !ins(W(a + 14, b - 4)) || !ins(W(a - 14, b + 20)) || !ins(W(a + 14, b + 20))) continue
          for (let row = 0; row < 6; row++) {
            if (run-- <= 0) { run = 2 + Math.floor(rng() * 8); hex = COL[Math.floor(rng() * COL.length)] }
            const p = W(a, b + row * 2.6), tiers = rng() < 0.08 ? 0 : 2 + Math.floor(rng() * 3.3)
            if (tiers) inst.push([p[0], g, p[1], tiers, hex])
          }
        }
        if (rng() < 0.7) { const a = 30 + rng() * (Lq - 60), p = W(a, b + 6.5); if (ins(p)) rtg(p, u, v, g) }
      }
      containerSets.push({ inst, rot })
    } else if (t.kind === 'coal' || t.kind === 'sulphur' || t.kind === 'chips') {
      const hex = { coal: 0x2a2c30, sulphur: 0xf0d43a, chips: 0xa57c4c }[t.kind]
      const ht = { coal: 17, sulphur: 20, chips: 15 }[t.kind], w = { coal: 46, sulphur: 60, chips: 40 }[t.kind], rows = { coal: 6, sulphur: 2, chips: 2 }[t.kind]
      for (let b = 70, row = 0; b < depth - w / 2 && row < rows; b += w + 22, row++) {
        let run = null
        for (let a = 0; a <= Lq + 10; a += 10) {
          const ok = a <= Lq && ins(W(a, b - w / 2)) && ins(W(a, b + w / 2)) && ins(W(a, b))
          if (ok && run === null) run = a
          if ((!ok || a - run > (t.kind === 'sulphur' ? 180 : 320)) && run !== null) {
            if (a - run >= 60) {
              pile(W((run + a) / 2, b), u, v, a - run - 10, w, ht * (0.8 + rng() * 0.4), g, hex, rng)
              stacker(W(run + rng() * (a - run), b + w / 2 + 11), u, v, g, rng)
            }
            run = ok ? a : null
          }
        }
      }
      if (t.kind === 'sulphur') stsCrane(W(Lq * 0.5, 6), u, v, g, [0x5a6670, 0xe2d24a], rng, true)
    } else if (t.kind === 'grain') {
      let sc = [0, 0], n = 0, far = null
      for (const s of t.silos) {
        const r = ringXZ(s), cc = centroid(r), rr = ringRadius(r)
        const round = Math.min(...r.map((p) => Math.hypot(p[0] - cc[0], p[1] - cc[1]))) > rr * 0.8
        if (round) cyl(cc[0], g, cc[1], rr + 0.3, 38, 0xdcd6c6, 14)
        else prism(inflate(r, 0.3), g, g + 36, 0xd9d3c3, 0xb9b3a5, [4, 0.6, 0xc4beaf])
        sc = [sc[0] + cc[0], sc[1] + cc[1]]; n++
        const bb = (cc[0] - q0[0]) * v[0] + (cc[1] - q0[1]) * v[1]
        if (!far || bb > far.b) far = { b: bb, cc }
      }
      if (n) { // the headhouse and a gallery to the shiploader at the quay
        sc = [sc[0] / n, sc[1] / n]
        const hb = (sc[0] - q0[0]) * u[0] + (sc[1] - q0[1]) * u[1], hh = W(hb, (sc[0] - q0[0]) * v[0] + (sc[1] - q0[1]) * v[1])
        box(hh[0], g, hh[1], 18, 66, 14, rot, 0xd1cbbb)
        box(hh[0], g + 66, hh[1], 12, 6, 10, rot, 0x9c9a92)
        const qy = W(hb, 8)
        beam(V(hh[0], g + 40, hh[1]), V(qy[0], g + 26, qy[1]), 3.4, 0x9aa0a4, 3)
        box(qy[0], g, qy[1], 6, 26, 6, rot, 0x8e969c)
        beam(V(qy[0], g + 24, qy[1]), V(qy[0] - v[0] * 28, g + 18, qy[1] - v[1] * 28), 2.2, 0xd8b23a)
      }
    } else if (t.kind === 'shipyard') {
      const a = Lq * 0.5, p = W(a, 90)
      goliath(p, u, v, g)
      for (let i = 0; i < 3; i++) luffing(W(Lq * (0.2 + i * 0.3), 10), u, v, g, rng)
    } else if (t.kind === 'cement') {
      const o = obb(ring)
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) cyl(o.cx + o.ux * (i - 1.5) * 11 - o.uz * (j - 0.5) * 11, g, o.cz + o.uz * (i - 1.5) * 11 + o.ux * (j - 0.5) * 11, 5, 34, 0xd5d3cc, 12)
      box(o.cx + o.ux * 30, g, o.cz + o.uz * 30, 12, 46, 12, Math.atan2(-o.uz, o.ux), 0xbab7ae)
    }
  }
  function stsCrane([x, z], u, v, g, [main, trim], rng, small) { // ship-to-shore gantry crane, boom over the water (-v)
    const s = small ? 0.75 : 1, gauge = 30 * s, span = 16, hy = g + 44 * s
    const P3 = (a, b, h) => V(x + u[0] * a + v[0] * b, h, z + u[1] * a + v[1] * b)
    for (const a of [-span / 2, span / 2]) {
      for (const b of [0, gauge]) beam(P3(a, b, g), P3(a, b, hy), 1.8, main)
      beam(P3(a, 0, g + 12), P3(a, gauge, g + 12), 1.4, main)
      beam(P3(a, 0, hy), P3(a, gauge, hy), 1.6, main)
      beam(P3(a, -55 * s, hy + 2), P3(a, gauge + 22 * s, hy + 2), 1.5, main, 2.4) // boom and back reach
      beam(P3(a * 0.6, gauge * 0.25, hy), P3(a * 0.4, gauge * 0.45, hy + 30 * s), 1.4, trim) // A-frame
      beam(P3(a * 0.6, gauge * 0.7, hy), P3(a * 0.4, gauge * 0.45, hy + 30 * s), 1.4, trim)
      beam(P3(a * 0.4, gauge * 0.45, hy + 30 * s), P3(a * 0.5, -40 * s, hy + 3), 0.5, trim) // forestay
    }
    for (const b of [0, gauge]) beam(P3(-span / 2, b, g + 1), P3(span / 2, b, g + 1), 1.6, main)
    const mh = P3(0, gauge + 10 * s, hy + 3.5)
    box(mh.x, mh.y, mh.z, 12 * s, 6 * s, 12 * s, Math.atan2(-u[1], u[0]), trim)
    const tr = P3(0, -10 - rng() * 30 * s, hy - 1) // trolley and spreader
    box(tr.x, tr.y, tr.z, 6, 3, 6, Math.atan2(-u[1], u[0]), 0x3c4248)
  }
  function rtg([x, z], u, v, g) { // rubber-tyred gantry over a container block
    const P3 = (a, b, h) => V(x + u[0] * a + v[0] * b, h, z + u[1] * a + v[1] * b)
    for (const a of [-4, 4]) for (const b of [-10, 10]) beam(P3(a, b, g), P3(a, b, g + 19), 1, 0xe6c22c)
    for (const a of [-4, 4]) beam(P3(a, -10.5, g + 19), P3(a, 10.5, g + 19), 1.2, 0xe6c22c)
  }
  function pile([x, z], u, v, len, w, h, g, hex, rng) { // a long heap with sloped sides and ends, a little lumpy
    const n = Math.max(2, Math.round(len / 25)), P3 = (a, b, y) => V(x + u[0] * a + v[0] * b, y, z + u[1] * a + v[1] * b)
    const top = [], foot = []
    for (let i = 0; i <= n; i++) {
      const a = -len / 2 + (len * i) / n, end = i === 0 || i === n
      const hh = end ? 0 : h * (0.85 + rng() * 0.3), tw = end ? 0 : w * 0.1
      top.push([P3(a + (i === 0 ? h * 1.2 : i === n ? -h * 1.2 : 0), -tw, g + hh), P3(a + (i === 0 ? h * 1.2 : i === n ? -h * 1.2 : 0), tw, g + hh)])
      foot.push([P3(a, -w / 2, g + 0.2), P3(a, w / 2, g + 0.2)])
    }
    for (let i = 0; i < n; i++) {
      const c1 = _c.copy(col(hex)).offsetHSL(0, 0, (rng() - 0.5) * 0.04).clone()
      quad(foot[i][0], foot[i + 1][0], top[i + 1][0], top[i][0], c1)
      quad(top[i][1], top[i + 1][1], foot[i + 1][1], foot[i][1], c1)
      quad(top[i][0], top[i + 1][0], top[i + 1][1], top[i][1], c1)
    }
    for (const [i, e] of [[0, 1], [n, n - 1]]) { // ends
      const c1 = col(hex)
      tri(foot[i][0], foot[i][1], top[e][1], c1); tri(foot[i][0], top[e][1], top[e][0], c1)
      tri(foot[i][0], top[e][0], foot[e][0], c1); tri(foot[i][1], foot[e][1], top[e][1], c1)
    }
  }
  function stacker([x, z], u, v, g, rng) { // yellow stacker-reclaimer: body on the rails, long boom over a pile
    const P3 = (a, b, h) => V(x + u[0] * a + v[0] * b, h, z + u[1] * a + v[1] * b)
    const body = P3(0, 0, g)
    box(body.x, g, body.z, 12, 9, 10, Math.atan2(-u[1], u[0]), 0xe8c22e)
    beam(P3(0, 0, g + 6), P3(0, 0, g + 18), 2.5, 0xe8c22e)
    const side = rng() < 0.5 ? -1 : 1, tip = P3(rng() * 20 - 10, side * 42, g + 10)
    beam(P3(0, 0, g + 12), tip, 2.4, 0xe8c22e)
    beam(P3(0, 0, g + 18), tip, 0.4, 0x555a60)
    beam(P3(0, -side * 6, g + 9), P3(0, -side * 16, g + 6), 2.2, 0xd2ac24) // counterweight arm
    cyl(tip.x, tip.y - 3, tip.z, 3, 6, 0x6a6e72, 8)
  }
  function goliath([x, z], u, v, g) {
    const P3 = (a, b, h) => V(x + u[0] * a + v[0] * b, h, z + u[1] * a + v[1] * b), H = 70
    for (const b of [-70, 70]) { beam(P3(-8, b, g), P3(0, b, g + H), 3, 0xd04030); beam(P3(8, b, g), P3(0, b, g + H), 3, 0xd04030) }
    beam(P3(0, -76, g + H + 3), P3(0, 76, g + H + 3), 6, 0xf2f2ee, 8)
    box(P3(0, 20, 0).x, g + H + 7, P3(0, 20, 0).z, 14, 6, 12, Math.atan2(-u[1], u[0]), 0xd04030)
  }
  function luffing([x, z], u, v, g, rng) {
    const P3 = (a, b, h) => V(x + u[0] * a + v[0] * b, h, z + u[1] * a + v[1] * b)
    beam(P3(0, 0, g), P3(0, 0, g + 32), 2.6, 0xe0b830)
    box(x, g + 32, z, 7, 5, 7, Math.atan2(-u[1], u[0]), 0xe0b830)
    const a = rng() * 30 - 15
    beam(P3(0, 0, g + 35), P3(a, -38, g + 52), 1.4, 0xe0b830)
  }

  // ---------- bridges ----------
  // Each bridge is a mesh of its own, sat on the deck heights of the loaded map tiles' bridge pieces (the core draws
  // the road decks there, from LiDAR) and rebuilt when finer tiles bring better ones; where no tile with the deck is
  // loaded, the MRDEM profile carries the shape on from the nearest deck the tiles have
  const bridges = Object.entries(data.bridges).map(([name, b]) => {
    const pts = pairs(b.line).map(([la, lo]) => P(la, lo)), xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1])
    const minHalf = b.type === 'stayed' && name === 'skybridge' ? 6 : 10.6 // the core draws road decks about 21 m wide
    return { name, b, pts, minHalf, box: [Math.min(...xs) - 60, Math.max(...xs) + 60, Math.min(...zs) - 60, Math.max(...zs) + 60], samples: new Map(), cur: null, mesh: null, dirty: false }
  })
  let bT = 0
  // deck points of a tile's bridge road pieces near each bridge: world x, z and the deck top (the core lifts its
  // decks 0.35 m over their z)
  function tileDecks(t) {
    const sz = t.level ? 4096 : 1024
    for (const br of bridges) {
      const [x0, x1, z0, z1] = br.box
      if (t.ox > x1 || t.ox + sz < x0 || -(t.oy + sz) > z1 || -t.oy < z0) continue
      const a = []
      for (const p of t.graph?.pieces || []) {
        if (!p.z || p.kind > 7) continue
        for (let i = 0; i < p.pts.length / 2 - 1; i++) {
          const ax = p.pts[i * 2], az = -p.pts[i * 2 + 1], bx = p.pts[i * 2 + 2], bz = -p.pts[i * 2 + 3], k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 4))
          for (let j = 0; j <= k; j++) {
            const x = ax + ((bx - ax) * j) / k, z = az + ((bz - az) * j) / k
            if (x > x0 && x < x1 && z > z0 && z < z1) a.push(x, z, p.z[i] + ((p.z[i + 1] - p.z[i]) * j) / k + 0.35)
          }
        }
      }
      if (!a.length) continue
      br.samples.set(`${t.level}/${t.i}_${t.j}`, { level: t.level, a }); br.dirty = true
      if (!bT) bT = setTimeout(replace, 400)
    }
  }
  const offTiles = city.world.eachTile(tileDecks)
  // water level (the core's ground minus the DEM ground under the bridge) and deck top at each station
  function deckOf(br) {
    const { b, pts } = br, n = pts.length
    const off = pts.map(([x, z], i) => city.world.heightAt(x, z) - b.ground[i]).sort((p, q) => p - q)
    const Wl = off[n >> 1], prof = b.deck.map((h) => Wl + h)
    const snap = pts.map(([x, z], i) => {
      const r = Math.max(b.half[i], br.minHalf) + 2, hs = [[], []]
      for (const { level, a } of br.samples.values()) for (let k = 0; k < a.length; k += 3) {
        if (Math.abs(a[k] - x) < r && Math.abs(a[k + 1] - z) < r && Math.hypot(a[k] - x, a[k + 1] - z) < r) hs[level].push(a[k + 2])
      }
      const h = hs[0].length ? hs[0] : hs[1] // the detail tiles' decks, else the overview's: their median
      return h.length ? h.sort((p, q) => p - q)[h.length >> 1] : null
    })
    // decks far (25 m) off the profile are LiDAR gone wrong (stay cables, a bridge newer than the survey): left out,
    // and a bridge with many of them keeps its profile
    const known = snap.filter((h) => h !== null).length, wild = snap.filter((h, i) => h !== null && Math.abs(h - prof[i]) > 25).length
    if (!known || wild > 0.3 * known) return { Wl, deck: prof }
    const diff = fill(snap.map((h, i) => (h === null || Math.abs(h - prof[i]) > 25 ? null : h - prof[i])))
    return { Wl, deck: prof.map((h, i) => h + diff[i]) }
  }
  // better decks came in: rebuild the bridges that moved
  function replace() {
    bT = 0
    let changed = false
    for (const br of bridges) {
      if (!br.dirty || !br.mesh) continue
      br.dirty = false
      const d = deckOf(br), c = br.cur
      if (Math.abs(d.Wl - c.Wl) < 0.3 && d.deck.every((h, i) => Math.abs(h - c.deck[i]) < 0.3)) continue
      const g = geometry(bridge(br, d))
      br.mesh.geometry.dispose(); br.mesh.geometry = g; changed = true
    }
    if (changed) city.requestRender()
  }
  for (const br of bridges) br.batch = bridge(br, deckOf(br))
  function bridge(br, d) { // its triangles, on deck heights d
    const { name, b, pts, minHalf } = br, n = pts.length, { Wl, deck } = (br.cur = d)
    B = { p: [], c: [] }
    const S = (s) => { // position, direction, normal, half width and deck top at station s (metres)
      const f = Math.max(0, Math.min(n - 1.001, s / b.step)), i = Math.floor(f), t = f - i
      const a = pts[i], c = pts[i + 1], dx = c[0] - a[0], dz = c[1] - a[1], l = Math.hypot(dx, dz) || 1
      return { x: a[0] + dx * t, z: a[1] + dz * t, ux: dx / l, uz: dz / l, nx: -dz / l, nz: dx / l, half: Math.max(minHalf, b.half[i] + (b.half[i + 1] - b.half[i]) * t), y: deck[i] + (deck[i + 1] - deck[i]) * t }
    }
    const Q = (s, lat, h) => { const o = S(s); return V(o.x + o.nx * lat, h, o.z + o.nz * lat) } // lat: metres to the side, h: absolute
    const water = Wl, top = (h) => Wl + h
    const T = {
      suspension: () => {
        const G = 0x3f7d5c, [t1, t2] = b.towers, [a1, a2] = b.anchors, ht = top(b.top)
        const w = S((t1 + t2) / 2).half + 1.2
        for (const t of b.towers) {
          const d = S(t).y
          for (const s of [-1, 1]) { beam(Q(t, s * w, water - 2), Q(t, s * w, ht - 2), 4.6, G, 4); beam(Q(t, s * w * 0.98, ht - 6), Q(t, s * w * 0.95, ht + 1), 3.4, G, 3.4) }
          box(Q(t, 0, 0).x, water - 3, Q(t, 0, 0).z, 14, 8, 2 * w + 10, Math.atan2(-S(t).uz, S(t).ux), 0xbab7ae)
          const ys = [d + 6, d + (ht - d) * 0.45, ht - 4]
          for (const y of ys) beam(Q(t, -w, y), Q(t, w, y), 2.2, G, 2.6)
          for (let k = 0; k < 2; k++) { beam(Q(t, -w, ys[k]), Q(t, w, ys[k + 1]), 1.3, G); beam(Q(t, w, ys[k]), Q(t, -w, ys[k + 1]), 1.3, G) }
          beam(Q(t, -w, d - 3), Q(t, w, d - 3), 2.6, G, 3)
        }
        const cableY = (s) => {
          const tt1 = ht - 1, dm = S((t1 + t2) / 2).y + 2.5
          if (s >= t1 && s <= t2) { const f = (2 * (s - t1)) / (t2 - t1) - 1; return dm + (tt1 - dm) * f * f }
          const [ta, aa] = s < t1 ? [t1, a1] : [t2, a2], f = (s - aa) / (ta - aa), da = S(aa).y + 1
          return da + (tt1 - da) * f - 6 * f * (1 - f)
        }
        for (const s of [-1, 1]) {
          let prev = null
          for (let st = a1; st <= a2 + 0.1; st += 10) {
            const p = Q(st, s * (w - 0.6), cableY(st))
            if (prev) beam(prev, p, 0.9, G)
            prev = p
            if (Math.abs(st - t1) > 6 && Math.abs(st - t2) > 6 && st > a1 + 5 && st < a2 - 5) beam(Q(st, s * (w - 0.6), S(st).y + 1), p, 0.25, 0x2c4a3a)
          }
          // stiffening truss along the suspended deck
          for (let st = a1; st < a2 - 0.1; st += 8) {
            const d0 = S(st).y, d1 = S(st + 8).y
            beam(Q(st, s * w * 0.95, d0 + 1.3), Q(st + 8, s * w * 0.95, d1 + 1.3), 0.5, G)
            beam(Q(st, s * w * 0.95, d0 - 3.6), Q(st + 8, s * w * 0.95, d1 - 3.6), 0.6, G)
            beam(Q(st, s * w * 0.95, d0 - 3.6), Q(st + 4, s * w * 0.95, (d0 + d1) / 2 + 1.3), 0.4, G)
            beam(Q(st + 4, s * w * 0.95, (d0 + d1) / 2 + 1.3), Q(st + 8, s * w * 0.95, d1 - 3.6), 0.4, G)
          }
        }
        for (const a of b.anchors) { const o = S(a); box(o.x, Math.min(o.y - 6, city.world.heightAt(o.x, o.z)) - 2, o.z, 20, Math.max(6, o.y - city.world.heightAt(o.x, o.z) + 2), 2 * w + 6, Math.atan2(-o.uz, o.ux), 0xc4c0b5) }
      },
      cantilever: () => {
        const G = 0x8d9ba5, [s0, p1, p2, s1] = b.truss, mid = (p1 + p2) / 2
        const H = (s) => s < p1 ? 8 + 28 * (s - s0) / (p1 - s0) : s > p2 ? 8 + 28 * (s1 - s) / (s1 - p2) : 14 + 22 * Math.pow(Math.abs(s - mid) / (mid - p1), 1.6)
        const w = S(mid).half + 0.8, panel = (s1 - s0) / Math.round((s1 - s0) / 14)
        for (let st = s0; st < s1 - 0.1; st += panel) {
          const e = st + panel, d0 = S(st).y, d1 = S(e).y, h0 = d0 + H(st), h1 = d1 + H(e)
          for (const s of [-1, 1]) {
            beam(Q(st, s * w, d0 - 1.5), Q(e, s * w, d1 - 1.5), 1.2, G)
            beam(Q(st, s * w, h0), Q(e, s * w, h1), 1.4, G)
            beam(Q(st, s * w, d0 - 1.5), Q(st, s * w, h0), 0.8, G)
            const up = Math.round((st - s0) / panel) % 2
            beam(Q(up ? st : e, s * w, (up ? d0 : d1) - 1.5), Q(up ? e : st, s * w, up ? h1 : h0), 0.7, G)
          }
          if (H(st) > 7) beam(Q(st, -w, h0), Q(st, w, h0), 0.7, G)
        }
        for (const s of [-1, 1]) beam(Q(s1, s * w, S(s1).y - 1.5), Q(s1, s * w, S(s1).y + H(s1)), 0.8, G)
        for (const p of [s0, p1, p2, s1]) {
          const o = S(p), big = p === p1 || p === p2
          box(o.x, water - 2, o.z, big ? 14 : 8, o.y - 1.5 - water + 2, 2 * w + (big ? 6 : 2), Math.atan2(-o.uz, o.ux), 0xc2bfb6)
        }
      },
      burrard: () => {
        const C = 0xe7dfcd, ST = 0x6f8b80, [t1, t2] = b.towers, w = S((t1 + t2) / 2).half + 0.5
        for (const t of b.towers) {
          const o = S(t), gy = Math.min(water, city.world.heightAt(o.x, o.z)) - 1, rot = Math.atan2(-o.uz, o.ux)
          for (const s of [-1, 1]) {
            const p = Q(t, s * (w + 2.5), 0)
            box(p.x, gy, p.z, 7, o.y + 16 - gy, 5.5, rot, C)
            box(p.x, o.y + 16, p.z, 5, 4, 4, rot, C)
            box(p.x, o.y + 20, p.z, 2.6, 2.4, 2.6, rot, 0xd9cfb0)
            box(p.x, o.y + 22.4, p.z, 1.4, 1.6, 1.4, rot, 0x8d8a7c) // the lanterns
          }
          box(o.x, o.y + 11, o.z, 5, 4.5, 2 * w + 10, rot, C) // the portal over the road
        }
        const panel = (t2 - t1) / 8
        for (let st = t1; st < t2 - 0.1; st += panel) {
          const e = st + panel, d0 = S(st).y, d1 = S(e).y
          for (const s of [-1, 1]) {
            beam(Q(st, s * w, d0 + 9), Q(e, s * w, d1 + 9), 1, ST)
            beam(Q(e, s * w, d1 - 1), Q(e, s * w, d1 + 9), 0.6, ST)
            const k = (st - t1) < (t2 - t1) / 2
            beam(Q(k ? st : e, s * w, (k ? d0 : d1) + 9), Q(k ? e : st, s * w, (k ? d1 : d0) - 1), 0.6, ST)
          }
          beam(Q(st, -w, d0 + 9), Q(st, w, d0 + 9), 0.5, ST)
        }
        deckTruss(b.sidetruss[0], t1, w - 1.5, 6, ST, 0xd8d2c2)
        deckTruss(t2, b.sidetruss[1], w - 1.5, 6, ST, 0xd8d2c2)
      },
      decktruss: () => {
        const [s0, s1] = b.truss, w = S((s0 + s1) / 2).half - 1
        deckTruss(s0, s1, w, 8, 0x7f8f88, null)
        for (const p of b.piers) pier(p, w, 0xc9c6bd)
      },
      girder: () => {
        const [s0, s1] = b.girder, w = S((s0 + s1) / 2).half - 1.5, hex = b.steel === 'weathering' ? 0x7a4d36 : name === 'oakstreet' ? 0x6f8a78 : 0xc4c1b8
        for (let st = s0; st < s1 - 0.1; st += 10) {
          const dep = (s) => b.haunch ? 2.5 + 6 * Math.max(0, 1 - Math.min(...b.piers.map((p) => Math.abs(s - p))) / 70) : 2.6
          for (const s of [-1, 0.33, -0.33, 1].slice(0, w > 9 ? 4 : 2)) {
            const a = Q(st, s * w, S(st).y - 1.2), c = Q(st + 10, s * w, S(st + 10).y - 1.2)
            quad(a, c, V(c.x, c.y - dep(st + 10), c.z), V(a.x, a.y - dep(st), a.z), col(hex))
          }
        }
        for (const p of b.piers) pier(p, w, 0xc9c6bd)
      },
      stayed: () => {
        const C = 0xe9e7e0, CB = 0xf2f2ee, ht = top(b.top), w = S(b.towers[0]).half
        for (let k = 0; k < b.towers.length; k++) {
          const t = b.towers[k], o = S(t), rot = Math.atan2(-o.uz, o.ux)
          const reach = [ // the deck the tower carries, either side
            k === 0 ? b.back[0] : (b.towers[k - 1] + t) / 2 + 4,
            k === b.towers.length - 1 ? b.back[1] : (b.towers[k + 1] + t) / 2 - 4]
          box(o.x, water - 3, o.z, 18, 6, b.pylon === 'I' ? 26 : 2 * w + 14, rot, 0xbcb9b0)
          let anchorsAt
          if (b.pylon === 'I') {
            beam(Q(t, 0, water), Q(t, 0, ht - 8), 7, C, 9)
            beam(Q(t, 0, ht - 8), Q(t, 0, ht), 5, C, 6)
            beam(Q(t, -w, o.y - 2.5), Q(t, w, o.y - 2.5), 4, C, 4)
            anchorsAt = (f) => [Q(t, 0, ht - 4 - f * 40)]
            for (const end of reach) {
              const nc = 12
              for (let i = 0; i < nc; i++) {
                const f = (i + 1) / nc, s = t + (end - t) * f, top_ = anchorsAt(f)[0]
                for (const lat of [-w + 1, -w * 0.38, w * 0.38, w - 1]) beam(top_, Q(s, lat, S(s).y + 0.5), 0.35, CB)
              }
            }
          } else {
            const lw = w + 2.5
            for (const s of [-1, 1]) {
              beam(Q(t, s * lw, water), Q(t, s * lw * 0.9, o.y - 3), 4.2, C, 5)
              beam(Q(t, s * lw * 0.9, o.y - 3), Q(t, s * lw * 0.7, ht), 3.4, C, 4)
            }
            beam(Q(t, -lw * 0.9, o.y - 3), Q(t, lw * 0.9, o.y - 3), 3.5, C, 4)
            beam(Q(t, -lw * 0.72, ht - 6), Q(t, lw * 0.72, ht - 6), 3, C, 3)
            for (const end of reach) {
              const nc = Math.max(8, Math.round(Math.abs(end - t) / 14))
              for (let i = 0; i < nc; i++) {
                const f = (i + 1) / nc, s = t + (end - t) * f, ay = ht - 9 - f * Math.min(30, (ht - o.y) * 0.4)
                for (const sd of [-1, 1]) beam(Q(t, sd * lw * (0.72 + 0.18 * f * 0.4), ay), Q(s, sd * (w - 0.5), S(s).y + 0.5), 0.3, CB)
              }
            }
          }
        }
      },
    }
    function deckTruss(s0, s1, w, depth, hex, pierHex) {
      const panel = (s1 - s0) / Math.max(1, Math.round((s1 - s0) / 10))
      for (let st = s0; st < s1 - 0.1; st += panel) {
        const e = st + panel, d0 = S(st).y - 1.2, d1 = S(e).y - 1.2
        for (const s of [-1, 1]) {
          beam(Q(st, s * w, d0 - depth), Q(e, s * w, d1 - depth), 0.9, hex)
          beam(Q(st, s * w, d0), Q(e, s * w, d1), 0.7, hex)
          const k = Math.round((st - s0) / panel) % 2
          beam(Q(k ? st : e, s * w, (k ? d0 : d1) - depth), Q(k ? e : st, s * w, k ? d1 : d0), 0.5, hex)
        }
        beam(Q(st, -w, d0 - depth), Q(st, w, d0 - depth), 0.5, hex)
      }
      if (pierHex) for (let st = s0; st <= s1 + 0.1; st += 55) pier(st, w, pierHex, depth)
    }
    function pier(s, w, hex, below = 3) { // twin columns and a cap from the ground (or water) to under the deck
      const o = S(s), gy = Math.max(water - 1, city.world.heightAt(o.x, o.z)) - 1, rot = Math.atan2(-o.uz, o.ux), y = o.y - 1.2 - below
      if (y - gy < 3) return
      for (const sd of [-1, 1]) { const p = Q(s, sd * w * 0.62, 0); box(p.x, gy, p.z, 3.4, y - gy, 3.4, rot, hex) }
      box(o.x, y - 2, o.z, 3.6, 2.4, 2 * w + 2, rot, hex)
    }
    pierWater = br.mesh ? null : water // piers are listed on the first build only (rebuilds move decks, not piers)
    T[b.type]?.()
    pierWater = null
    return B
  }
  function fill(a) { // fill gaps (null) in an array by linear interpolation, ends by the nearest value
    const idx = a.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0)
    return a.map((v, i) => {
      if (v !== null) return v
      let lo = -1, hi = -1
      for (const j of idx) { if (j < i) lo = j; else { hi = j; break } }
      if (lo < 0) return a[hi]; if (hi < 0) return a[lo]
      return a[lo] + ((a[hi] - a[lo]) * (i - lo)) / (hi - lo)
    })
  }
  // ---------- North Shore: ski runs on Cypress, Grouse and Seymour, the Grouse Mountain Skyride ----------
  for (const p of data.pistes) {
    const r = pairs(p.r).map(([la, lo]) => P(la, lo))
    at(...r[0])
    const hex = 0xeef2f3
    if (!p.area) { // a ribbon draped over the slope
      const pts = []
      for (let i = 0; i < r.length - 1; i++) { const l = Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]), k = Math.max(1, Math.ceil(l / 12)); for (let t = 0; t < k; t++) pts.push([r[i][0] + ((r[i + 1][0] - r[i][0]) * t) / k, r[i][1] + ((r[i + 1][1] - r[i][1]) * t) / k]) }
      pts.push(r[r.length - 1])
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], l = Math.hypot(x1 - x0, z1 - z0) || 1, nx = (-(z1 - z0) / l) * 11, nz = ((x1 - x0) / l) * 11
        const h = (x, z) => city.world.heightAt(x, z) + 0.8
        quad(V(x0 - nx, h(x0 - nx, z0 - nz), z0 - nz), V(x1 - nx, h(x1 - nx, z1 - nz), z1 - nz), V(x1 + nx, h(x1 + nx, z1 + nz), z1 + nz), V(x0 + nx, h(x0 + nx, z0 + nz), z0 + nz), col(hex))
      }
    } else if (r.length > 3) drape(r.slice(0, -1), (x, z) => city.world.heightAt(x, z) + 0.8, () => hex, 24) // an area over the ground
  }
  for (const f of data.gondolas || []) { // the Skyride: towers, cables, two red cabins, the chalet at the top
    const r = pairs(f).map(([la, lo]) => P(la, lo)), a = r[0], z = r[r.length - 1]
    at(...a)
    const ga = city.world.heightAt(...a), gz = city.world.heightAt(...z), L2 = Math.hypot(z[0] - a[0], z[1] - a[1]), ux = (z[0] - a[0]) / L2, uz = (z[1] - a[1]) / L2
    const cy = (t) => ga + 12 + (gz + 14 - ga - 12) * t - 40 * t * (1 - t)
    for (const s of [-4, 4]) { let prev = null; for (let t = 0; t <= 1.001; t += 0.05) { const p = V(a[0] + ux * L2 * t - uz * s, cy(t), a[1] + uz * L2 * t + ux * s); if (prev) beam(prev, p, 0.3, 0x3a3f44); prev = p } }
    for (const t of [0.33, 0.67]) { const x = a[0] + ux * L2 * t, zz = a[1] + uz * L2 * t, g = city.world.heightAt(x, zz); beam(V(x, g, zz), V(x, cy(t) + 2, zz), 2, 0x9aa0a4); beam(V(x - uz * 5, cy(t) + 1.5, zz + ux * 5), V(x + uz * 5, cy(t) + 1.5, zz - ux * 5), 1.2, 0x9aa0a4) }
    for (const [t, s] of [[0.42, -4], [0.6, 4]]) { const x = a[0] + ux * L2 * t - uz * s, zz = a[1] + uz * L2 * t + ux * s; box(x, cy(t) - 7, zz, 5, 4.5, 3.4, Math.atan2(-uz, ux), 0xc8352b); beam(V(x, cy(t) - 2.5, zz), V(x, cy(t), zz), 0.3, 0x3a3f44) }
    for (const [p, g] of [[a, ga], [z, gz]]) { box(p[0], g, p[1], 22, 9, 14, Math.atan2(-uz, ux), 0x8a6a4a); roof([[p[0] - 12, p[1] - 8], [p[0] + 12, p[1] - 8], [p[0] + 12, p[1] + 8], [p[0] - 12, p[1] + 8]], g + 9, 'gabled', 4, 0x5a4a3e) }
  }

  // ---------- meshes ----------
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  const objs = []
  function geometry({ p, c }) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3))
    g.computeVertexNormals(); g.computeBoundingSphere()
    return g
  }
  for (const batch of [...cells.values(), ...bridges.map((br) => br.batch)]) {
    if (!batch.p.length) continue
    const m = new THREE.Mesh(geometry(batch), mat)
    m.castShadow = m.receiveShadow = true
    objs.push(m)
    const br = bridges.find((q) => q.batch === batch)
    if (br) { br.mesh = m; br.batch = null }
  }
  // containers: one instance per stack (12.2 x 2.44 m, 2.6 m a tier), no bottom face
  const cbox = new THREE.BoxGeometry(12.2, 1, 2.44).translate(0, 0.5, 0)
  cbox.setIndex(Array.from(cbox.index.array).filter((_, i) => Math.floor(i / 6) !== 3)) // drop the -y face
  const cmat = new THREE.MeshLambertMaterial()
  const yards = []
  for (const { inst, rot } of containerSets) {
    if (!inst.length) continue
    const im = new THREE.InstancedMesh(cbox, cmat, inst.length)
    _q.setFromAxisAngle(Y, rot)
    inst.forEach(([x, g, z, tiers, hex], k) => {
      im.setMatrixAt(k, _m.compose(_p.set(x, g, z), _q, _s.set(1, tiers * 2.6, 1)))
      im.setColorAt(k, _c.copy(col(hex)).offsetHSL(0, 0, (rnd() - 0.5) * 0.08))
    })
    im.computeBoundingSphere()
    im.castShadow = im.receiveShadow = true
    objs.push(im); yards.push(im)
  }
  // containers are under a pixel when zoomed far out: hide them there
  const showYards = () => { const on = city.view.zoom > 0.05; if (yards[0] && yards[0].visible !== on) { for (const y of yards) y.visible = on; city.requestRender() } }
  const offView = city.on('view', showYards)
  showYards()
  for (const o of objs) { o.userData.landmarks = true; city.scene.add(o) }
  for (const r of masks) city.world.suppressBuildings?.(r)
  city.landmarks = { piers }
  city.requestRender()
  return {
    dispose() {
      offView(); offTiles(); clearTimeout(bT)
      delete city.landmarks
      for (const o of objs) { city.scene.remove(o); o.geometry !== cbox && o.geometry.dispose() }
      cbox.dispose(); mat.dispose(); cmat.dispose()
      city.requestRender()
    },
  }
}

function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }
function ringRadius(r) { const c = r.reduce((s, p) => [s[0] + p[0] / r.length, s[1] + p[1] / r.length], [0, 0]); return r.reduce((s, p) => s + Math.hypot(p[0] - c[0], p[1] - c[1]), 0) / r.length }
function resample(r, n) { // n points evenly spaced along a closed ring
  const len = [], ring = [...r, r[0]]
  let tot = 0
  for (let i = 0; i < r.length; i++) { len.push(tot); tot += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]) }
  const out = []
  for (let k = 0, i = 0; k < n; k++) {
    const d = (k / n) * tot
    while (i < r.length - 1 && len[i + 1] <= d) i++
    const seg = Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]) || 1, t = (d - len[i]) / seg
    out.push([ring[i][0] + (ring[i + 1][0] - ring[i][0]) * t, ring[i][1] + (ring[i + 1][1] - ring[i][1]) * t])
  }
  return out
}
