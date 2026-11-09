// node tools/boats_check.mjs: the boats build (core/hull.js, ships/models.js, sail/boat.js): hulls wound outwards,
// every vessel at its stated length, afloat and cheap, the player's sloop with the parts the sail plugin drives
import * as THREE from '../public/vendor/three.module.min.js'
import { kit, repaint } from '../public/core/kit.js'
import { loft, slab, sym, block } from '../public/core/hull.js'
import { shipModels, seabusGeo } from '../public/plugins/ships/models.js'
import { makeBoat, COLOUR } from '../public/plugins/sail/boat.js'
import assert from 'node:assert/strict'

const inward = (build) => { // faces of a convex shape pointing towards its centre
  const k = kit(THREE); build(k); const P = k.geometry().attributes.position.array, c = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3()
  for (let i = 0; i < P.length; i += 3) c.add(a.fromArray(P, i)); c.divideScalar(P.length / 3)
  let bad = 0
  for (let i = 0; i < P.length; i += 9) {
    a.fromArray(P, i); b.fromArray(P, i + 3); d.fromArray(P, i + 6)
    if (Math.abs(a.z) + Math.abs(b.z) + Math.abs(d.z) < 1e-9) continue // a stem's plate on the centre line: one face each way
    if (b.clone().sub(a).cross(d.clone().sub(a)).dot(a.clone().add(b).add(d).divideScalar(3).sub(c)) < 0) bad++
  }
  return bad
}
const hull = [[-3, [[0, -1], [0.8, -0.4], [1, 1]]], [0, [[0, -1.2], [1, -0.5], [1.3, 1]]], [3, [[0, -1.1], [0, -0.5], [0, 1]]]]
for (const [name, f] of Object.entries({
  loft: (k) => loft(k, hull, { deck: 0xffffff }), slab: (k) => slab(k, sym([[-2, 1], [0, 1.5], [2, 0.5]]), 0, 1, { bevel: 0.1 }), 'slab, shrunk': (k) => slab(k, sym([[-2, 1], [2, 1]], -0.2), 0, 1),
  block: (k) => block(k, 1, -1, 0, 1, 0.5, -0.5),
})) assert.equal(inward(f), 0, `${name}: faces wound inwards`)
{ // a cockpit's faces look into it
  const k = kit(THREE); loft(k, [[-2, [[0, -1], [1, 1]]], [0, [[0, -1], [1, 1]]], [2, [[0, -1], [1, 1]]]], { deck: 0xffffff, well: { from: 0, to: 1, w: 0.5, y: 0, c: 0 } })
  const g = k.geometry(true), P = g.attributes.position.array, N = g.attributes.normal.array
  for (let i = 0; i < P.length; i += 9) if (Math.abs(P[i + 1] + P[i + 4] + P[i + 7]) < 1e-6) assert(N[i + 1] > 0.99, 'the cockpit floor faces up')
}

const size = (g) => { g.computeBoundingBox(); return g.boundingBox }
const fleet = Object.values(shipModels(THREE)).flat()
assert(fleet.length > 30, 'the fleet')
for (const m of [...fleet, { kind: 'seabus', L: 34, B: 11.5, geo: seabusGeo(THREE) }]) {
  const b = size(m.geo), tris = m.geo.attributes.position.count / 3, at = `${m.kind}: `
  assert(Math.abs(b.max.x - b.min.x - m.L) < 0.12 * m.L && Math.abs(b.max.x + b.min.x) < 0.12 * m.L, at + `length ${b.min.x} .. ${b.max.x} for L ${m.L}`)
  assert(b.max.z - b.min.z > m.B * 0.9 && (m.small || Math.abs(b.max.z + b.min.z) < 0.05 * m.B), at + `beam ${b.min.z} .. ${b.max.z}`)
  assert(b.min.y > -4 && b.min.y < 0.01, at + `afloat (lowest ${b.min.y})`)
  assert(tris < 900 && m.geo.attributes.color && m.geo.attributes.normal, at + `${tris} triangles`)
}

const boat = makeBoat(THREE), { hull: h, boom, jib, main, jibSail } = boat.userData
assert(h && boom && jib && main && jibSail && boat.update, 'the sloop has what the sail plugin drives')
const col = h.children[0].geometry.attributes.color, c0 = new THREE.Color(COLOUR), c1 = new THREE.Color('#c0392b')
const count = (c) => { let n = 0; for (let i = 0; i < col.count; i++) if (Math.abs(col.getX(i) - c.r) + Math.abs(col.getY(i) - c.g) + Math.abs(col.getZ(i) - c.b) < 1e-3) n++; return n }
const n0 = count(c0)
assert(n0 > 60, 'the hull is in the hull colour')
repaint(THREE, boat, COLOUR, '#c0392b')
assert(count(c0) === 0 && count(c1) === n0, 'the hull repaints')
boom.rotation.y = 0.5; main.onBeforeRender(); assert.equal(main.scale.x, 1, 'the mainsail fills to leeward')
boom.rotation.y = -0.5; main.onBeforeRender(); assert.equal(main.scale.x, -1, 'and on the other tack')
jib.rotation.y = 0.03; jibSail.onBeforeRender(); assert(jibSail.scale.x < 0.2, 'sheeted hard in, a sail is flat')
const sb = new THREE.Box3().setFromObject(boat)
assert(sb.min.z > -3.6 && sb.max.z < 3.3 && sb.max.x - sb.min.x < 4.2 && sb.max.y > 9 && sb.max.y < 9.5, `the sloop's size ${sb.min.toArray()} ${sb.max.toArray()}`)
console.log(`boats ok: ${fleet.length} models, ${Math.round(fleet.reduce((n, m) => n + m.geo.attributes.position.count / 3, 0) / fleet.length)} triangles each on average`)
