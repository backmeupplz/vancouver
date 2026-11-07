// Street furniture the map has as points but doesn't draw: street lamps, stop and give-way signs, bus stop signs
// (map tiles' points, OpenStreetMap) and bollards (data/*.json). Drawn near the player only, while driving or
// walking, so the van and the walker have something to see when they bump into one. Low-poly like the life
// plugin's models (its kit): cobra-head lamps on davit arms (lit at night), signs with their borders, one
// instanced mesh per kind. update(list, n, night): list is [x, north, ground, kind, angle] * n (kinds below;
// angle: the road's direction).
import { kit, shaded } from '../life/kit.js'

export const LAMP = 1, STOP = 2, YIELD = 3, BUS = 4, BOLLARD = 5, BENCH = 6 // benches: the life plugin draws them
const MAX = 700
const POLE = 0x7d838a, WHITE = 0xf3f0e8

// each kind in its own frame: on the ground at the origin, a lamp's arm reaching over the road towards -z, a sign
// facing +z (along the road)
function models(THREE) {
  const g = (build) => { const k = kit(THREE); build(k); const geo = k.geometry(); geo.setAttribute('color', geo.attributes.aCol); return geo }
  const post = (k, h) => k.c(POLE).cyl(0.045, 0.04, h, 6, 1)
  const plate = (k, r, seg, y, z, turn) => { const s = k.at(); k.cyl(r, r, 0.025, seg, 3); k.rot(s, 'x', Math.PI / 2).rot(s, 'z', turn).move(s, 0, y, z) }
  return {
    [LAMP]: g((k) => {
      k.c(POLE).cyl(0.16, 0.14, 0.45, 8).cyl(0.1, 0.065, 8.4, 8, 1)
      k.rod([0, 8.3, 0], [0, 8.75, -0.5], 0.05).rod([0, 8.75, -0.5], [0, 8.85, -1.7], 0.045)
      const s = k.at() // the cobra head, along the arm
      k.c(0xa4aab0).prism([0, 0, 0.78, -0.04, 0.88, -0.12, 0.74, -0.21, 0.1, -0.18, -0.05, -0.08], -0.19, 0.19, { bevel: 0.04 })
      k.rot(s, 'y', Math.PI / 2).move(s, 0, 8.88, -1.62)
    }),
    lens: g((k) => k.c(0xffffff).box(-0.15, 0.15, 8.66, 8.69, -2.36, -1.82)),
    [STOP]: g((k) => { post(k, 2.6); k.c(WHITE); plate(k, 0.4, 8, 2.25, 0.07, Math.PI / 8); k.c(0xc8261e); plate(k, 0.365, 8, 2.25, 0.085, Math.PI / 8); k.c(WHITE).box(-0.2, 0.2, 2.21, 2.29, 0.095, 0.1) }),
    [YIELD]: g((k) => { post(k, 2.6); k.c(0xc8261e); plate(k, 0.52, 3, 2.25, 0.07, -Math.PI / 2); k.c(WHITE); plate(k, 0.3, 3, 2.22, 0.085, -Math.PI / 2) }),
    [BUS]: g((k) => { post(k, 2.9); k.c(0x2f62b8).box(-0.24, 0.24, 2.2, 2.85, 0.05, 0.08).c(WHITE).box(-0.2, 0.2, 2.62, 2.78, 0.075, 0.085).box(-0.12, 0.12, 2.3, 2.5, 0.075, 0.085) }),
    [BOLLARD]: g((k) => { k.c(0xd9b23a).cyl(0.11, 0.12, 0.95, 8); const s = k.at(); k.c(0x2b2e33).cyl(0.122, 0.122, 0.08, 8, 0); k.move(s, 0, 0.7, 0) }),
  }
}

export function makeProps(THREE) {
  const group = new THREE.Group()
  const mat = shaded(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }))
  const lampM = new THREE.MeshLambertMaterial({ color: 0xfff1c8, emissive: 0xffe2a0, emissiveIntensity: 0.3 })
  const geos = models(THREE)
  const meshes = {}
  for (const [kind, geo] of Object.entries(geos)) {
    const m = new THREE.InstancedMesh(geo, kind === 'lens' ? lampM : mat, MAX)
    m.count = 0; m.frustumCulled = false; m.receiveShadow = true; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    group.add(m); meshes[kind] = m
  }
  const all = Object.values(meshes)
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1)
  function update(list, n, night) {
    for (const m of all) m.count = 0
    const put = (m) => { if (m.count < MAX) m.setMatrixAt(m.count++, m4) }
    for (let i = 0; i < n; i++) {
      const o = i * 5, kind = list[o + 3], m = meshes[kind]
      if (!m) continue
      // lamps reach over the road (angle: its direction; the arm points across it), signs face along it
      m4.compose(p.set(list[o], list[o + 2] - 0.05, -list[o + 1]), q.setFromAxisAngle(up, list[o + 4]), one)
      put(m)
      if (kind === LAMP) put(meshes.lens)
    }
    for (const m of all) { m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, m.count * 16); m.instanceMatrix.needsUpdate = true }
    lampM.emissiveIntensity = 0.3 + 1.6 * night
  }
  return { group, update }
}
