// Shop signs: the real names of the shops, cafes, restaurants and offices (OpenStreetMap, ODbL; baked per detail tile
// as `signs` by tools/tiles.py + core/tile-worker.js, each already on a street-facing storefront wall) drawn as boards
// on the walls at street level, only within ~120 m of a third-person camera. Boxes, striped awning lettering, dark
// boards, and cafes' blade signs, one look per business (a hash of its name), painted into one atlas (core/atlas.js).
import { labelAtlas } from '../../core/atlas.js'

const COLS = ['#b3282d', '#1d5fa8', '#20784a', '#e0a21b', '#6b2f86', '#d0561f', '#17808c', '#3a3a40', '#9a1f5a', '#2c4f2f']
const CREAM = '#f3ecdc', INK = '#1d1b18', FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif'
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h }
const dark = (c) => { const n = parseInt(c.slice(1), 16); return ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) < 150 }

// key: style|name (style 0 box, 1 awning, 2 dark, 3 blade)
function paint(ctx, x, y, W, H, key) {
  const bar = key.indexOf('|'), style = +key.slice(0, bar), name = key.slice(bar + 1), h = hash(name), c = COLS[h % COLS.length]
  let bg = c, fg = dark(c) ? CREAM : INK, edge = CREAM, text = name.toUpperCase()
  if (style === 2) { bg = '#1b1a1f'; fg = ['#f0c24b', '#e8e8e0', '#7fd6c8'][(h >> 4) % 3]; edge = fg }
  if (style === 3) { bg = CREAM; fg = INK; edge = c; text = name }
  ctx.fillStyle = bg; ctx.fillRect(x, y, W, H)
  if (style === 1) { // awning stripes under the lettering
    ctx.fillStyle = CREAM
    for (let i = 0; i < 16; i += 2) ctx.fillRect(x + (i * W) / 16, y, W / 16, H)
  }
  const b = H * 0.07
  ctx.strokeStyle = edge; ctx.lineWidth = b; ctx.strokeRect(x + b / 2, y + b / 2, W - b, H - b)
  const px = Math.round(H * (style === 3 ? 0.5 : 0.6))
  ctx.font = `${style === 3 ? 600 : 800} ${px}px ${FONT}`
  const sx = Math.min(1, (W - H * 0.6) / ctx.measureText(text).width) // long names squeezed
  ctx.save(); ctx.translate(x + W / 2, y + H / 2 + px * 0.04); ctx.scale(sx, 1)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  if (style === 1) { ctx.lineJoin = 'round'; ctx.lineWidth = px * 0.3; ctx.strokeStyle = bg; ctx.strokeText(text, 0, 0); ctx.fillStyle = CREAM } else ctx.fillStyle = fg
  ctx.fillText(text, 0, 0)
  ctx.restore()
}

export default function signs(city) {
  const { THREE } = city
  const tiles = new Map() // level 0 tiles with signs: key -> tile
  const off = [city.world.eachTile((t) => t.level === 0 && t.signs && tiles.set(`${t.i}_${t.j}`, t)), city.on('tile:unload', (t) => tiles.delete(`${t.i}_${t.j}`))]
  let atlas = null, mesh = null, low = null, quads = null, cap = 0, R = 120
  let ax = NaN, az = NaN, seen = 0
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0)
  const cand = []

  function make() {
    const lowTier = city.quality?.tier.name === 'low'
    if (mesh) { mesh.removeFromParent(); mesh.geometry.dispose(); atlas.dispose() }
    low = lowTier; cap = lowTier ? 100 : 300; R = 120 * (city.quality?.tier.near ?? 1)
    const SW = lowTier ? 256 : 512
    atlas = labelAtlas(THREE, city.renderer, SW, SW / 4, 4, paint)
    quads = atlas.quads(cap)
    atlas.mat.side = THREE.DoubleSide
    atlas.mat.customProgramCacheKey = () => 'shop-signs'
    mesh = new THREE.InstancedMesh(quads.geo, atlas.mat, cap)
    Object.assign(mesh, { count: 0, frustumCulled: false, receiveShadow: true, visible: false })
    city.scene.add(mesh)
    ax = NaN
  }

  function pick(cx, cz) {
    ax = cx; az = cz; seen = tiles.size
    cand.length = 0
    for (const t of tiles.values()) {
      const d = t.signs.d, R2 = R * R
      for (let i = 0; i < d.length / 8; i++) {
        const dx = t.ox + d[i * 8] - cx, dz = -(t.oy + d[i * 8 + 1]) - cz, q = dx * dx + dz * dz
        if (q < R2) cand.push({ q, t, i })
      }
    }
    cand.sort((a, b) => a.q - b.q)
    atlas.begin()
    let n = 0
    for (const { t, i } of cand) {
      if (n >= cap) break
      const d = t.signs.d, o = i * 8, kind = d[o + 6] & 7, style = d[o + 6] >> 3, name = t.signs.names[d[o + 7]]
      const slot = atlas.slot(`${style}|${name}`)
      if (slot < 0) continue
      const w = d[o + 5], nx = d[o + 3], ny = d[o + 4]
      const blade = style === 3
      const sw = blade ? 2 : w, sh = sw / 4, out = blade ? 0.9 : 0.07
      const yaw = Math.atan2(nx, -ny) + (blade ? Math.PI / 2 : 0)
      V.set(t.ox + d[o] + nx * out, d[o + 2] + (blade ? 0.5 : 0), -(t.oy + d[o + 1]) - ny * out)
      mesh.setMatrixAt(n, M.compose(V, Q.setFromAxisAngle(Y, yaw), S.set(sw, sh, 1)))
      quads.set(n++, slot)
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = quads.rect.needsUpdate = true
    atlas.flush()
    city.requestRender()
  }

  const offs = city.on('frame', () => {
    const C = city.view.camera, persp = !!C.isPerspectiveCamera
    if (!persp) { if (mesh?.visible) { mesh.visible = false; city.requestRender() } return }
    if (!mesh || low !== (city.quality?.tier.name === 'low')) make()
    if (!mesh.visible) { mesh.visible = true; ax = NaN }
    atlas.mat.emissiveIntensity = 0.05 + 0.3 * city.light.night
    if (tiles.size !== seen || !(Math.hypot(C.position.x - ax, C.position.z - az) <= R * 0.15)) pick(C.position.x, C.position.z)
  })
  return { dispose() { offs(); off.forEach((f) => typeof f === 'function' && f()); if (mesh) { mesh.removeFromParent(); mesh.geometry.dispose(); atlas.dispose() } city.requestRender() } }
}
