// Street-name blades (sizes in models.js): each name drawn once, white on Vancouver blue with a white border, into
// one canvas atlas (fixed slots, the least recently used name given up for a new one), shown on instanced quads on
// both faces of a thin box. Only blades near the camera whose name is known are drawn (life/index.js picks them).
import { abbr } from '../../core/streets.js'
import { labelAtlas } from '../../core/atlas.js'

const BLUE = '#1f4f9a', WHITE = '#f0f0ea'

// low: a smaller atlas (fewer, coarser names) for the Low graphics tier
export function blades(THREE, renderer, cap, low) {
  const SW = low ? 256 : 512, SH = Math.round(SW / 4.8)
  const atlas = labelAtlas(THREE, renderer, SW, SH, 2, (ctx, x, y, SW, SH, name) => {
    const b = SH * 0.09, r = SH * 0.14
    ctx.clearRect(x, y, SW, SH)
    ctx.fillStyle = WHITE; ctx.beginPath(); ctx.roundRect(x + 1, y + 1, SW - 2, SH - 2, r); ctx.fill()
    ctx.fillStyle = BLUE; ctx.beginPath(); ctx.roundRect(x + 1 + b, y + 1 + b, SW - 2 - 2 * b, SH - 2 - 2 * b, r * 0.6); ctx.fill()
    const text = abbr(name), px = Math.round(SH * 0.64)
    ctx.font = `600 ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    const w = ctx.measureText(text).width, room = SW - 2 * b - SH * 0.4, sx = Math.min(1, room / w) // long names squeezed
    ctx.save(); ctx.translate(x + SW / 2, y + SH / 2 + px * 0.04); ctx.scale(sx, 1)
    ctx.fillStyle = WHITE; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 0, 0)
    ctx.restore()
  })
  const q = atlas.quads(cap * 2), mat = atlas.mat // emissive: retroreflective at night
  mat.customProgramCacheKey = () => 'blade-words'
  const mesh = new THREE.InstancedMesh(q.geo, mat, cap * 2)
  const boxGeo = new THREE.BoxGeometry(1, 1, 0.044), boxMat = new THREE.MeshLambertMaterial({ color: WHITE }), box = new THREE.InstancedMesh(boxGeo, boxMat, cap)
  for (const m of [mesh, box]) { m.count = 0; m.frustumCulled = false; m.receiveShadow = true }
  mesh.add(box)
  const M = new THREE.Matrix4(), T = new THREE.Matrix4(), F = new THREE.Matrix4().makeRotationY(Math.PI)
  return {
    mesh,
    begin() { atlas.begin(); mesh.count = box.count = 0 },
    // words on the blade whose centre frame is m (along its x, faces along ±z), w by h metres
    add(m, w, h, name) {
      if (mesh.count + 2 > cap * 2) return
      const i = atlas.slot(name)
      if (i < 0) return
      box.setMatrixAt(box.count++, M.multiplyMatrices(m, T.makeScale(w, h, 1)))
      for (const side of [1, -1]) { // the back face, then the front (facing -z, the traffic on a mast arm)
        M.multiplyMatrices(m, T.makeTranslation(0, 0, side * 0.026))
        if (side < 0) M.multiply(F)
        M.multiply(T.makeScale(w, h, 1))
        mesh.setMatrixAt(mesh.count, M)
        q.set(mesh.count, i)
        mesh.count++
      }
    },
    end() {
      mesh.instanceMatrix.needsUpdate = box.instanceMatrix.needsUpdate = q.rect.needsUpdate = true
      atlas.flush()
    },
    night(n) { mat.emissiveIntensity = 0.12 + 0.5 * n },
    dispose() { for (const o of [q.geo, boxGeo, boxMat, box]) o.dispose(); atlas.dispose() },
  }
}
