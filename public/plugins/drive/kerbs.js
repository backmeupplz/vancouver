// Kerbs at street level: the map paints sidewalks flat beside the carriageway, so up close there is no edge where
// the road ends. Here a low concrete lip (13 cm, 25 cm wide) runs along both edges of every street that has
// sidewalks drawn (graph piece `band`), or along a side where a sidewalk is mapped as a footway of its own (as
// downtown), cut where it would cross another carriageway (junctions, side streets). Built per road piece (a few
// a call, cached) from the drive plugin's road index and gathered around the player; one merged mesh.
const H = 0.13, W = 0.25, STEP = 2, BUDGET = 1.5 // ms of building a call (a slow phone or a jump to a new street spreads it over frames)

// segs(x, y, r, fn): fn(seg) for the indexed road segments near (x, north) ({ p, x0, y0, x1, y1, drv, wlk, z0 })
export function makeKerbs(THREE, segs) {
  const geo = new THREE.BufferGeometry()
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xd9d7d0 }))
  mesh.receiveShadow = true; mesh.frustumCulled = false
  const cache = new Map() // piece -> { pos, nor } (Float32Arrays, triangles)
  let cap = 0, shown = ''

  const dist = (s, x, y) => { const dx = s.x1 - s.x0, dy = s.y1 - s.y0, L2 = dx * dx + dy * dy || 1, u = Math.max(0, Math.min(1, ((x - s.x0) * dx + (y - s.y0) * dy) / L2)); return Math.hypot(x - s.x0 - dx * u, y - s.y0 - dy * u) }
  // inside another street's carriageway (not alongside it, as the next piece of the same street is)?
  function onStreet(p, x, y) {
    let hit = false
    segs(x, y, 12, (s) => { if (!hit && s.drv && s.p !== p && s.z0 == null && dist(s, x, y) < s.p.w / 2 - 0.3) hit = true })
    return hit
  }
  // a footway running alongside this side of p, within 8 m of its edge, along most of it?
  function footwayAlong(p, side) {
    const P = p.pts
    let hits = 0, tries = 0
    for (let i = 0; i < P.length / 2 - 1; i++) {
      const x0 = P[i * 2], y0 = P[i * 2 + 1], dx = P[i * 2 + 2] - x0, dy = P[i * 2 + 3] - y0, L = Math.hypot(dx, dy)
      if (L < 4) continue
      const ux = dx / L, uy = dy / L, x = x0 + dx / 2 - uy * side * (p.w / 2 + 3.5), y = y0 + dy / 2 + ux * side * (p.w / 2 + 3.5)
      let hit = false
      tries++
      segs(x, y, 5, (s) => {
        if (hit || !s.wlk || (s.p.kind !== 8 && s.p.kind !== 9) || s.p.crossing) return
        const ex = s.x1 - s.x0, ey = s.y1 - s.y0, l = Math.hypot(ex, ey) || 1
        if (Math.abs((ex * ux + ey * uy) / l) > 0.85 && dist(s, x, y) < 4.5) hit = true
      })
      if (hit) hits++
    }
    return tries > 0 && hits / tries >= 0.5
  }
  // the kerbs of one piece: offset lines w/2 out each side, sampled every STEP m, kept where not on another street
  function build(p, heightAt) {
    const pos = [], nor = [], hw = p.w / 2, P = p.pts
    const tri = (a, b, c, n) => { pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); nor.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]) }
    const quad = (a, b, c, d, n) => { // wound to face n
      const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2]
      if ((ey * fz - ez * fy) * n[0] + (ez * fx - ex * fz) * n[1] + (ex * fy - ey * fx) * n[2] >= 0) { tri(a, b, c, n); tri(a, c, d, n) } else { tri(a, c, b, n); tri(a, d, c, n) }
    }
    const UP = [0, 1, 0]
    for (const side of [1, -1]) {
      if (!p.band && !footwayAlong(p, side)) continue
      let prev = null
      for (let i = 0; i < P.length / 2 - 1; i++) {
        const x0 = P[i * 2], y0 = P[i * 2 + 1], dx = P[i * 2 + 2] - x0, dy = P[i * 2 + 3] - y0, L = Math.hypot(dx, dy)
        if (L < 0.01) continue
        const ux = dx / L, uy = dy / L, nx = -uy * side, ny = ux * side, n = Math.max(1, Math.ceil(L / STEP))
        for (let k = i ? 1 : 0; k <= n; k++) {
          const t = (L * k) / n, x = x0 + ux * t + nx * hw, y = y0 + uy * t + ny * hw
          if (onStreet(p, x, y)) { prev = null; continue }
          const h = heightAt(x, -y), q = { foot: [x, h - 0.06, -y], top: [x, h + H, -y], out: [x + nx * W, h + H, -(y + ny * W)] }
          if (prev) { quad(prev.foot, q.foot, q.top, prev.top, [-nx, 0, ny]); quad(prev.top, q.top, q.out, prev.out, UP) } // the face to the road, the top
          prev = q
        }
      }
    }
    return { pos: new Float32Array(pos), nor: new Float32Array(nor) }
  }

  // the kerbs within r of (x, north) from these detail tiles' graphs, building new pieces for at most BUDGET ms;
  // returns true while some are still to build (call it again next frame)
  function update(tiles, x, y, r, heightAt) {
    const want = [], until = performance.now() + BUDGET
    let pending = false, n = 0, key = ''
    for (const t of tiles) {
      if (t.ox > x + r || t.ox + 1024 < x - r || t.oy > y + r || t.oy + 1024 < y - r || !t.graph) continue
      for (const p of t.graph.pieces) {
        if (!p.drive || p.kind < 2 || p.kind > 7 || p.kind === 6 || p.z) continue // streets, not motorways or service roads
        const P = p.pts
        let near = false
        for (let i = 0; i < P.length && !near; i += 2) near = Math.abs(P[i] - x) < r && Math.abs(P[i + 1] - y) < r
        if (!near) continue
        let a = cache.get(p)
        if (!a) { if (performance.now() < until) cache.set(p, (a = build(p, heightAt))); else pending = true }
        if (a) { want.push(a); n += a.pos.length; key += a.pos.length + ',' }
      }
    }
    if (key === shown) return pending // nothing new
    shown = key
    if (n > cap || !geo.attributes.position) { // (also when the first kerbs found are all empty)
      cap = Math.ceil(n * 1.5)
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap), 3)); geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(cap), 3))
    }
    let o = 0
    for (const a of want) { geo.attributes.position.array.set(a.pos, o); geo.attributes.normal.array.set(a.nor, o); o += a.pos.length }
    geo.attributes.position.needsUpdate = geo.attributes.normal.needsUpdate = true
    geo.setDrawRange(0, n / 3)
    if (cache.size > 6000) cache.clear() // ponytail: crude bound on the cache; per-tile eviction if it ever matters
    return pending
  }
  return { mesh, update }
}
