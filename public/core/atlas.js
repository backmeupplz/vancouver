// A canvas atlas of painted labels (street blades, shop signs): fixed slots of SW x SH px in COLS columns, a key painted
// once into a slot by paint(ctx, x, y, SW, SH, key), the least recently used key given up for a new one. Drawn on
// instanced quads that carry their slot's uv rectangle (aRect: u0, v0, du, dv); `lit` is the emissive material for them.
export function labelAtlas(THREE, renderer, SW, SH, COLS, paint) {
  const ROWS = Math.floor((SW * COLS) / SH)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SW * COLS
  const ctx = canvas.getContext('2d')
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  const slots = new Map() // key -> { i, used }; Map order is the LRU order
  let pass = 0, dirty = false
  const mat = new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0 })
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aRect;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = aRect.xy + uv * aRect.zw;\nvEmissiveMapUv = vMapUv;')
  }
  return {
    mat, SH, canvas,
    begin() { pass++ },
    // the slot for a key this pass, or -1 when every slot holds a key already shown this pass
    slot(key) {
      let s = slots.get(key)
      if (s) slots.delete(key)
      else if (slots.size < COLS * ROWS) { s = { i: slots.size }; paint(ctx, (s.i % COLS) * SW, Math.floor(s.i / COLS) * SH, SW, SH, key); dirty = true }
      else {
        const [old, o] = slots.entries().next().value
        if (o.used === pass) return -1
        slots.delete(old); s = o; paint(ctx, (s.i % COLS) * SW, Math.floor(s.i / COLS) * SH, SW, SH, key); dirty = true
      }
      s.used = pass
      slots.set(key, s)
      return s.i
    },
    // a quad geometry (unit plane facing +z) with a per instance uv rectangle: set(n, slot) fills instance n
    quads(count) {
      const geo = new THREE.PlaneGeometry(1, 1), rect = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4)
      geo.setAttribute('aRect', rect)
      return { geo, rect, set: (n, i) => rect.setXYZW(n, (i % COLS) / COLS, 1 - (Math.floor(i / COLS) + 1) * SH / canvas.height, 1 / COLS, SH / canvas.height) }
    },
    flush() { if (dirty) { tex.needsUpdate = true; dirty = false } },
    dispose() { tex.dispose(); mat.dispose() },
  }
}
