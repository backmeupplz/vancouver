// node tools/models_check.mjs: the low-poly kit (public/plugins/life/kit.js) winds every face outwards (else the
// near faces are culled and a model shows its insides), and the street-level models build at sane sizes
import * as THREE from '../public/vendor/three.module.min.js'
import { kit } from '../public/plugins/life/kit.js'
import { carModels, peopleModels, signalModels } from '../public/plugins/life/models.js'
import assert from 'node:assert/strict'

const inward = (build) => { // faces of a convex shape pointing towards its centre
  const k = kit(THREE); build(k); const P = k.geometry().attributes.position.array, c = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3()
  for (let i = 0; i < P.length; i += 3) c.add(a.fromArray(P, i)); c.divideScalar(P.length / 3)
  let bad = 0
  for (let i = 0; i < P.length; i += 9) {
    a.fromArray(P, i); b.fromArray(P, i + 3); d.fromArray(P, i + 6)
    const n = b.clone().sub(a).cross(d.clone().sub(a)), m = a.clone().add(b).add(d).divideScalar(3).sub(c)
    if (n.lengthSq() > 1e-12 && n.dot(m) < 0) bad++
  }
  return bad
}
for (const [name, f] of Object.entries({
  box: (k) => k.box(-1, 1, 0, 1, -0.5, 0.5, 0.8), 'box either way': (k) => k.box(1, -1, 0, 1, 0.5, -0.5),
  prism: (k) => k.prism([0, 0, 2, 0, 2, 1, 0, 1], -0.5, 0.5), 'prism clockwise, bevelled, leaning': (k) => k.prism([0, 0, 0, 1, 2, 1.2, 2, 0], -0.5, 0.5, { bevel: 0.1, narrow: (y) => 0.05 * y }),
  cylinder: (k) => k.cyl(1, 0.8, 2, 8, 3), wheel: (k) => k.wheel(0, 0, 0, 0.4, 0.3), 'wheel along x': (k) => k.wheel(0, 0, 0, 0.4, 0.3, 8, 'x'), rod: (k) => k.rod([0, 0, 0], [1, 2, 3], 0.2),
})) assert.equal(inward(f), 0, `${name}: faces wound inwards`)

const size = (g) => { g.computeBoundingBox(); return g.boundingBox.getSize(new THREE.Vector3()) }
for (const g of carModels(THREE)) { const s = size(g); assert(s.x > 4 && s.x < 9 && s.z > 1.6 && s.z < 2.7 && s.y > 1.3 && s.y < 3.8, `car ${s.toArray()}`); assert(g.attributes.position.count / 3 < 1000, 'a car under 1000 triangles') }
for (const g of peopleModels(THREE)) { const s = size(g); assert(s.y > 1.7 && s.y < 2.3, `person ${s.y}`) }
const sig = signalModels(THREE)
assert(size(sig.head).y > 1.0 && size(sig.head).y < 1.4, 'a signal head (with its backplate) about a metre tall')
console.log('models ok')
