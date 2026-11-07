// Street furniture the map has as points but doesn't draw: street lamps, stop and give-way signs, bus stop signs
// (map tiles' points, OpenStreetMap) and bollards (data/*.json). Drawn near the player only, while driving or
// walking, so the van and the walker have something to see when they bump into one. Flat-shaded Lambert like the map.
// update(list, n, night): list is [x, north, ground, kind, angle] * n (kinds below; angle: the road's direction).
export const LAMP = 1, STOP = 2, YIELD = 3, BUS = 4, BOLLARD = 5, BENCH = 6 // benches: the life plugin draws them
const MAX = 700

export function makeProps(THREE) {
  const group = new THREE.Group()
  const M = (color, extra) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra })
  const grey = M(0x6b7178), lampM = M(0xfff1c8, { emissive: 0xffe2a0, emissiveIntensity: 0.3 })
  const mesh = (geo, mat) => { const m = new THREE.InstancedMesh(geo, mat, MAX); m.count = 0; m.frustumCulled = false; m.receiveShadow = true; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); group.add(m); return m }
  // a unit pole (scaled to each height), a lamp's arm and head, the sign plates, a bollard
  const pole = mesh(new THREE.CylinderGeometry(0.07, 0.09, 1, 6).translate(0, 0.5, 0), grey)
  const arm = mesh(new THREE.BoxGeometry(0.08, 0.08, 1.5).translate(0, 7.35, -0.7), grey)
  const head = mesh(new THREE.BoxGeometry(0.34, 0.14, 0.6).translate(0, 7.3, -1.45), lampM)
  const plate = (shape, color, y) => mesh(shape.translate(0, y, -0.06), M(color))
  const stop = plate(new THREE.CylinderGeometry(0.38, 0.38, 0.04, 8).rotateX(Math.PI / 2).rotateZ(Math.PI / 8), 0xc8261e, 2.25)
  const yieldS = plate(new THREE.CylinderGeometry(0.45, 0.45, 0.04, 3).rotateX(Math.PI / 2).rotateZ(Math.PI), 0xf3f0e8, 2.2)
  const bus = plate(new THREE.BoxGeometry(0.46, 0.62, 0.04), 0x2f62b8, 2.45)
  const bollard = mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.95, 8).translate(0, 0.475, 0), M(0xd9b23a))
  const all = [pole, arm, head, stop, yieldS, bus, bollard]
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1)
  const POLE_H = [0, 7.4, 2.6, 2.6, 2.9, 0]
  function update(list, n, night) {
    for (const m of all) m.count = 0
    const put = (m, scaleY) => { if (m.count < MAX) m.setMatrixAt(m.count++, m4.compose(p, q, scaleY ? s.set(1, scaleY, 1) : one)) }
    for (let i = 0; i < n; i++) {
      const o = i * 5, kind = list[o + 3]
      p.set(list[o], list[o + 2] - 0.05, -list[o + 1])
      // lamps reach over the road (angle: its direction; the arm points across it), signs face along it
      q.setFromAxisAngle(up, list[o + 4])
      if (kind === BENCH) continue
      if (kind === BOLLARD) { put(bollard); continue }
      put(pole, POLE_H[kind])
      if (kind === LAMP) { put(arm); put(head) } else put(kind === STOP ? stop : kind === YIELD ? yieldS : bus)
    }
    for (const m of all) { m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, m.count * 16); m.instanceMatrix.needsUpdate = true }
    lampM.emissiveIntensity = 0.3 + 1.6 * night
  }
  return { group, update }
}
