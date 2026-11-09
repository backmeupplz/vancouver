// A race's other boats: three sloops sailed by the computer round the same marks in the same wind (they beat upwind in
// tacks, as the player must), and the ghost of the player's best run of the course. goals.js owns the race; this file
// the boats. want() (where a boat should point to get to a mark) also steers the player in tests (sailDebug.auto).
import { clamp, wrap } from '../../core/util.js'
const RAD = Math.PI / 180, BEAT = 47 * RAD // how close to the wind they sail
export const GHOST_DT = 0.5 // seconds between a ghost's samples (x, z, heading)

// the heading towards (px, pz) from boat b { x, z, h, tack, tackT } in this wind: straight there, or close-hauled on
// one tack and then the other when it lies upwind; away from the shore ahead
export function want(b, px, pz, wind, wet, dt) {
  const eye = Math.atan2(-wind.x, -wind.z), brg = Math.atan2(px - b.x, pz - b.z), off = wrap(brg - eye) // the mark, from the wind's eye
  let w = brg
  b.tackT = (b.tackT || 0) - dt
  if (Math.abs(off) < BEAT) {
    if (!b.tack) b.tack = Math.sign(off) || 1
    if (b.tack * off < -0.3 && b.tackT <= 0) { b.tack = -b.tack; b.tackT = 8 }
    w = eye + b.tack * BEAT
  } else b.tack = 0
  const dry = (a) => !wet(b.x + Math.sin(a) * 35, b.z + Math.cos(a) * 35)
  if (dry(w)) {
    if (b.tack && b.tackT < 5 && !dry(eye - b.tack * BEAT)) { b.tack = -b.tack; b.tackT = 8; w = eye + b.tack * BEAT }
    else for (const d of [0.5, -0.5, 1, -1, 1.6, -1.6]) if (!dry(w + d)) { w += d; break }
  }
  return w
}

// env: { makeBoat(colour), wind { x, z }, polar(deg) 0..1, top(windSpeed) m/s at the best angle, wet(x, z), markR }
export function makeFleet(THREE, env) {
  const group = new THREE.Group()
  const boats = [['#c8553d', 0.76, 'Rosa'], ['#d9a02b', 0.86, 'Finn'], ['#4a8f5a', 0.95, 'Mae']].map(([colour, skill, name]) => {
    const m = env.makeBoat(colour); m.visible = false; group.add(m)
    return { m, skill, name, x: 0, z: 0, h: 0, speed: 0, next: 0, tack: 0, tackT: 0, heading: 0, length: 5, width: 1.5 } // (a slim box: a brush past a rival isn't a crash)
  })
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0xcfeaff, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide })
  const ghost = env.makeBoat('#ffffff'); ghost.visible = false; group.add(ghost)
  ghost.traverse((o) => { if (o.isMesh) { o.material.dispose?.(); o.material = ghostMat } })
  let on = false, track = null

  function pose(m, x, y, z, h, speed) { // on the water, heeled and sheeted for the wind
    const fx = Math.sin(h), fz = Math.cos(h), lee = Math.sign(-env.wind.x * fz + env.wind.z * fx) || 1
    const twa = Math.abs(wrap(Math.atan2(-env.wind.x, -env.wind.z) - h))
    m.position.set(x, y, z); m.rotation.set(0, h + Math.PI, 0)
    const U = m.userData
    U.hull.rotation.set(0, 0, -lee * clamp(speed * 0.045, 0, 0.3) * Math.sin(Math.min(twa, Math.PI / 2)))
    U.boom.rotation.y = lee * clamp(twa * 0.55 - 0.25, 0.1, 1.45); U.jib.rotation.y = U.boom.rotation.y * 0.85
  }
  return {
    group, boats,
    // line them up beside the start pose (x, z, h), a little behind it; ghostTrack: flat [x, z, h, ...] or null
    reset(start, ghostTrack) {
      on = true; track = ghostTrack?.length >= 6 ? ghostTrack : null
      const fx = Math.sin(start.h), fz = Math.cos(start.h)
      boats.forEach((b, i) => {
        const side = (i % 2 ? -1 : 1) * (9 + 7 * (i >> 1)) + (i === 2 ? 4 : 0)
        Object.assign(b, { x: start.x + fz * side - fx * 12 * i, z: start.z - fx * side - fz * 12 * i, h: start.h, speed: 0, next: 0, tack: 0, tackT: 0, time: 0 })
        b.m.visible = true
      })
      ghost.visible = false
    },
    stop() { on = false; ghost.visible = false; for (const b of boats) b.m.visible = false },
    // going: the race has started; t: its clock; pts: the marks
    step(dt, going, t, pts, sea) {
      if (!on) return
      const ws = Math.hypot(env.wind.x, env.wind.z), eye = Math.atan2(-env.wind.x, -env.wind.z)
      for (const b of boats) {
        const p = pts[Math.min(b.next, pts.length - 1)], done = b.next >= pts.length
        if (going && !done) {
          if (!b.speed) b.speed = 1.5 // off the line
          const w = want(b, p.x, p.z, env.wind, env.wet, dt)
          b.h = wrap(b.h + clamp(wrap(w - b.h), -0.7 * dt, 0.7 * dt))
          const target = b.skill * env.polar(Math.abs(wrap(eye - b.h)) / RAD) * env.top(ws)
          b.speed += (target - b.speed) * (1 - Math.exp(-(target > b.speed ? 0.45 : 0.25) * dt))
          if (Math.hypot(p.x - b.x, p.z - b.z) < env.markR) { b.next++; if (b.next >= pts.length) b.time = t }
        } else if (!going) b.speed *= Math.exp(-0.4 * dt) // (finished: sails on, clear of the line)
        const nx = b.x + Math.sin(b.h) * b.speed * dt, nz = b.z + Math.cos(b.h) * b.speed * dt
        if (env.wet(nx, nz)) { b.x = nx; b.z = nz } else { b.speed *= 0.5; b.h += 0.8 * dt }
        b.heading = b.h
        pose(b.m, b.x, sea(b.x, b.z), b.z, b.h, b.speed)
      }
      if (track && going) {
        const f = t / GHOST_DT, i = Math.min(Math.floor(f), track.length / 3 - 2), k = clamp(f - i, 0, 1), a = i * 3
        ghost.visible = f < track.length / 3 - 1
        if (ghost.visible) {
          const x = track[a] + (track[a + 3] - track[a]) * k, z = track[a + 1] + (track[a + 4] - track[a + 1]) * k
          pose(ghost, x, sea(x, z), z, track[a + 2] + wrap(track[a + 5] - track[a + 2]) * k, 4)
        }
      }
    },
    // the player's place: 1 + the boats further round (next: the player's next mark, d: metres to it)
    place(next, d, pts) {
      let n = 1
      for (const b of boats) if (b.next > next || (b.next === next && b.next < pts.length && Math.hypot(pts[b.next].x - b.x, pts[b.next].z - b.z) < d)) n++
      return n
    },
    dispose() { ghostMat.dispose(); for (const o of [...boats.map((b) => b.m), ghost]) o.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); if (m.material !== ghostMat) m.material.dispose() } }) },
  }
}
