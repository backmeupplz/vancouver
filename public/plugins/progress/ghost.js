// The ghost of a day's best run, as the live server stores it (server/src/world.rs ghost_ok): little endian
// [v i32][n u16][x0 f32][z0 f32] then n × [dx i16][dz i16][heading i8], steps in decimetres, one sample a second,
// heading = radians × 127 / π. Points are [x, z, heading] (the multiplayer plugin's world x, z and heading).
export const GHOST_MAX = 240
export function encodeGhost(v, pts) {
  pts = pts.slice(0, GHOST_MAX + 1); const n = pts.length - 1
  if (n < 1) return null
  const b = new DataView(new ArrayBuffer(14 + 5 * n))
  b.setInt32(0, v, true); b.setUint16(4, n, true); b.setFloat32(6, pts[0][0], true); b.setFloat32(10, pts[0][1], true)
  let qx = b.getFloat32(6, true), qz = b.getFloat32(10, true) // steps are taken from the rounded position: no drift
  for (let i = 1; i <= n; i++) {
    const [x, z, h] = pts[i], dx = Math.round((x - qx) * 10), dz = Math.round((z - qz) * 10), o = 14 + 5 * (i - 1)
    if (Math.abs(dx) > 32767 || Math.abs(dz) > 32767) return null
    b.setInt16(o, dx, true); b.setInt16(o + 2, dz, true)
    b.setInt8(o + 4, Math.max(-127, Math.min(127, Math.round(((((h || 0) + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) * 127 / Math.PI))))
    qx += dx / 10; qz += dz / 10
  }
  return b.buffer
}
export function decodeGhost(buf) {
  const b = new DataView(buf); if (buf.byteLength < 14) return null
  const v = b.getInt32(0, true), n = b.getUint16(4, true)
  if (n < 1 || n > GHOST_MAX || buf.byteLength !== 14 + 5 * n) return null
  let x = b.getFloat32(6, true), z = b.getFloat32(10, true); const pts = [[x, z, b.getInt8(18) * Math.PI / 127]]
  for (let i = 0; i < n; i++) { const o = 14 + 5 * i; x += b.getInt16(o, true) / 10; z += b.getInt16(o + 2, true) / 10; pts.push([x, z, b.getInt8(o + 4) * Math.PI / 127]) }
  return { v, pts }
}
