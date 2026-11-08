// Street-name blades (sizes in models.js): each name drawn once, white on Vancouver blue with a white border, into
// one canvas atlas (fixed slots, the least recently used name given up for a new one), shown on instanced quads on
// both faces of a thin box. Only blades near the camera whose name is known are drawn (life/index.js picks them).
import { abbr } from '../../core/streets.js'

const BLUE = '#1f4f9a', WHITE = '#f0f0ea'

// low: a smaller atlas (fewer, coarser names) for the Low graphics tier
export function blades(THREE, renderer, cap, low) {
  const SW = low ? 256 : 512, SH = Math.round(SW / 4.8), COLS = 2, ROWS = Math.floor(SW * 2 / SH) // slots in the blades' shape, a square atlas
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SW * COLS
  const ctx = canvas.getContext('2d')
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  const slots = new Map() // name -> { i, used }; Map order is the LRU order
  let pass = 0, dirty = false
  function draw(name, i) {
    const x = (i % COLS) * SW, y = Math.floor(i / COLS) * SH, b = SH * 0.09, r = SH * 0.14
    ctx.clearRect(x, y, SW, SH)
    ctx.fillStyle = WHITE; ctx.beginPath(); ctx.roundRect(x + 1, y + 1, SW - 2, SH - 2, r); ctx.fill()
    ctx.fillStyle = BLUE; ctx.beginPath(); ctx.roundRect(x + 1 + b, y + 1 + b, SW - 2 - 2 * b, SH - 2 - 2 * b, r * 0.6); ctx.fill()
    const text = abbr(name), px = Math.round(SH * 0.64)
    ctx.font = `600 ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    const w = ctx.measureText(text).width, room = SW - 2 * b - SH * 0.4, sx = Math.min(1, room / w) // long names squeezed
    ctx.save(); ctx.translate(x + SW / 2, y + SH / 2 + px * 0.04); ctx.scale(sx, 1)
    ctx.fillStyle = WHITE; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 0, 0)
    ctx.restore()
    dirty = true
  }
  // the slot for a name this pass, or -1 when every slot holds a name already shown this pass
  function slot(name) {
    let s = slots.get(name)
    if (s) slots.delete(name)
    else if (slots.size < COLS * ROWS) { s = { i: slots.size }; draw(name, s.i) }
    else {
      const [old, o] = slots.entries().next().value
      if (o.used === pass) return -1
      slots.delete(old); s = o; draw(name, s.i)
    }
    s.used = pass
    slots.set(name, s)
    return s.i
  }

  // the quads: a unit plane facing +z, its uv rectangle in the atlas per instance (aRect: u0, v0, du, dv)
  const geo = new THREE.PlaneGeometry(1, 1)
  const rect = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2 * 4), 4)
  geo.setAttribute('aRect', rect)
  const mat = new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0 }) // emissive: retroreflective at night
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aRect;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = aRect.xy + uv * aRect.zw;\nvEmissiveMapUv = vMapUv;')
  }
  mat.customProgramCacheKey = () => 'blade-words'
  const mesh = new THREE.InstancedMesh(geo, mat, cap * 2)
  const boxGeo = new THREE.BoxGeometry(1, 1, 0.044), boxMat = new THREE.MeshLambertMaterial({ color: WHITE }), box = new THREE.InstancedMesh(boxGeo, boxMat, cap)
  for (const m of [mesh, box]) { m.count = 0; m.frustumCulled = false; m.receiveShadow = true }
  mesh.add(box)
  const M = new THREE.Matrix4(), T = new THREE.Matrix4(), F = new THREE.Matrix4().makeRotationY(Math.PI)
  return {
    mesh,
    begin() { pass++; mesh.count = box.count = 0 },
    // words on the blade whose centre frame is m (along its x, faces along ±z), w by h metres
    add(m, w, h, name) {
      if (mesh.count + 2 > cap * 2) return
      const i = slot(name)
      if (i < 0) return
      box.setMatrixAt(box.count++, M.multiplyMatrices(m, T.makeScale(w, h, 1)))
      const u = (i % COLS) / COLS, v = 1 - (Math.floor(i / COLS) + 1) * SH / canvas.height
      for (const side of [1, -1]) { // the back face, then the front (facing -z, the traffic on a mast arm)
        M.multiplyMatrices(m, T.makeTranslation(0, 0, side * 0.026))
        if (side < 0) M.multiply(F)
        M.multiply(T.makeScale(w, h, 1))
        mesh.setMatrixAt(mesh.count, M)
        rect.setXYZW(mesh.count, u, v, 1 / COLS, SH / canvas.height)
        mesh.count++
      }
    },
    end() {
      mesh.instanceMatrix.needsUpdate = box.instanceMatrix.needsUpdate = rect.needsUpdate = true
      if (dirty) { tex.needsUpdate = true; dirty = false }
    },
    night(n) { mat.emissiveIntensity = 0.12 + 0.5 * n },
    dispose() { for (const o of [geo, mat, tex, mesh, boxGeo, boxMat, box]) o.dispose() },
  }
}
