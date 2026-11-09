// The player's boat (and other players': city.models.boat): a 6.6 m sloop, flat-shaded like the map. Forward -z,
// origin on the waterline. userData: hull (heels and pitches), boom and jib (turn about y; the jib about its stay),
// main and jibSail (flap). The sails fill to leeward as they are eased: their belly follows the boom's and the
// jib's angle. update(dt) bobs it, for other players' boats.
import { kit, kitMaterial } from '../../core/kit.js'
import { sloop, sailTris, SLOOP } from '../../core/hull.js'

export const COLOUR = '#2f6f8f'

export function makeBoat(THREE, colour = COLOUR) {
  const boat = new THREE.Group(), hull = new THREE.Group()
  const mat = kitMaterial(THREE, undefined, false)
  const sailM = new THREE.MeshLambertMaterial({ color: 0xfbfaf2, flatShading: true, side: THREE.DoubleSide })
  const k = sloop(kit(THREE), new THREE.Color(colour).getHex())
  hull.add(new THREE.Mesh(k.rot(0, 'y', Math.PI / 2).geometry(true), mat))
  // a sail hung on a pivot; its belly (scale.x) follows the pivot's angle, flat when sheeted hard in
  const sail = (kind, pivot) => {
    const P = []
    sailTris(kind, 1, (a, b, c) => { for (const p of [a, b, c]) P.push(p[2], p[1], -p[0]) })
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.computeVertexNormals()
    const m = new THREE.Mesh(g, sailM)
    m.onBeforeRender = () => { const f = Math.max(-1, Math.min(1, pivot.rotation.y / 0.3)); m.scale.x = Math.abs(f) < 0.15 ? 0.15 : f }
    pivot.add(m)
    return m
  }
  const boom = new THREE.Group(); boom.position.set(0, SLOOP.boom[1], -SLOOP.boom[0]); hull.add(boom)
  boom.add(new THREE.Mesh(kit(THREE).c(0xd9d9d4).rod([0, 0, 0], [0, 0, 3], 0.05, 0.04).geometry(true), mat))
  const main = sail('main', boom)
  const jib = new THREE.Group(); jib.position.set(0, SLOOP.tack[1], -SLOOP.tack[0]); jib.rotation.x = SLOOP.stay; hull.add(jib)
  const jibSail = sail('jib', jib)
  boat.add(hull)
  boat.userData = { hull, boom, jib, main, jibSail }
  let t = Math.random() * 10
  boat.update = (dt) => { t += dt; hull.position.y = 0.06 * Math.sin(t * 1.4); hull.rotation.set(0.02 * Math.sin(t * 1.1), 0, 0.12 + 0.03 * Math.sin(t * 0.9)); boom.rotation.y = jib.rotation.y = -0.4 }
  return boat
}
