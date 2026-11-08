// What the plugins that take over the view to play (drive, sail) share: picking a start on the map, the dive from
// the map's camera into a chase camera and back, the street-level sky and fog, touch buttons, keys and sound.
import * as THREE from 'three'
import { EASE, clamp, smooth } from './util.js'

export const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable
export const buzz = (p) => { try { navigator.vibrate?.(p) } catch {} } // haptics where the phone has them (not iOS)
export const MOVE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space']

// ---------------------------------------------------------------- picking a spot on the map
// on() listens for a click or tap on the map (not the end of a drag or a pinch) and calls onPick(x, z, e) with the
// ground under it (world x, z); off() stops. bodyClass is on <body> meanwhile (a crosshair cursor, say).
export function mapPicker(city, bodyClass, onPick) {
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), pointers = new Set()
  let down = null
  function groundAt(cx, cy) { // march down the map camera's ray until it is below the terrain
    const r = city.canvas.getBoundingClientRect()
    ray.setFromCamera(ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), city.camera)
    const o = ray.ray.origin, d = ray.ray.direction
    if (d.y > -0.05) return null
    const below = (t) => o.y + d.y * t < city.world.heightAt(o.x + d.x * t, o.z + d.z * t)
    let a = (o.y - 2200) / -d.y, b = a
    for (let k = 0; k < 1000 && !below(b); k++) { a = b; b += 12 }
    if (!below(b)) return null
    for (let k = 0; k < 14; k++) { const m = (a + b) / 2; if (below(m)) b = m; else a = m }
    return { x: o.x + d.x * b, z: o.z + d.z * b }
  }
  const onDown = (e) => { pointers.add(e.pointerId); down = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null }
  const onUp = (e) => {
    pointers.delete(e.pointerId)
    const d = down; down = null
    if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 600) return
    const g = groundAt(e.clientX, e.clientY)
    if (g) onPick(g.x, g.z, e)
  }
  return {
    on() { document.body.classList.add(bodyClass); city.canvas.addEventListener('pointerdown', onDown); city.canvas.addEventListener('pointerup', onUp) },
    off() { down = null; document.body.classList.remove(bodyClass); city.canvas.removeEventListener('pointerdown', onDown); city.canvas.removeEventListener('pointerup', onUp) },
  }
}

// ---------------------------------------------------------------- the dive
// A pose to dive between: the point looked at, the unit direction from it to the camera, the height of the view
// there (metres) and the fov. The map's camera is a nearly orthographic long lens (fov 2).
export function mapCameraPose(city) {
  const C = city.camera, T = city.controls.target
  return { look: T.clone(), dir: C.position.clone().sub(T).normalize(), H: (C.top - C.bottom) / C.zoom, fov: 2 }
}
export function poseOf(pos, look, fov, out = { look: new THREE.Vector3(), dir: new THREE.Vector3(), H: 0, fov: 0 }) {
  out.look.copy(look); out.dir.copy(pos).sub(look).normalize()
  out.H = 2 * pos.distanceTo(look) * Math.tan((fov * Math.PI) / 360); out.fov = fov
  return out
}
// the camera k (0 .. 1) of the way from pose S to pose E, eased; sets pcam and the map's streaming opts (focus,
// radius, shadowRadius). atmosphere(k) puts up the fog for k (0 map .. 1 street) and returns how far it reaches;
// nearMin: the nearest the near plane comes. Returns the eased k.
const LOOK = new THREE.Vector3(), DIR = new THREE.Vector3()
export function dive(pcam, opts, S, E, k, nearMin, atmosphere) {
  const ek = EASE(k)
  const look = LOOK.copy(S.look).lerp(E.look, ek), dir = DIR.copy(S.dir).lerp(E.dir, ek).normalize()
  const H = Math.exp(Math.log(S.H) + (Math.log(E.H) - Math.log(S.H)) * ek)
  const fov = S.fov + (E.fov - S.fov) * smooth(0.3, 1, ek), dist = H / 2 / Math.tan((fov * Math.PI) / 360)
  pcam.fov = fov
  const far = atmosphere(smooth(0.55, 1, ek))
  pcam.near = Math.max(nearMin, dist * 0.04); pcam.far = dist + 4000 + (far + 60 - 4000) * smooth(0.6, 1, ek)
  pcam.updateProjectionMatrix()
  pcam.position.copy(look).addScaledVector(dir, dist)
  pcam.up.set(0, 1, 0); pcam.lookAt(look)
  opts.focus.copy(look)
  const half = (H / 2) * Math.max(1, pcam.aspect)
  opts.radius = clamp(half * 1.5, 900, 8000)
  opts.shadowRadius = clamp(half * 1.9, 300, 6000)
  return ek
}

// ---------------------------------------------------------------- sky and fog at street level
// The weather plugin publishes the street-level look (city.weather.atmosphere); without it, a fair day.
const FAIR = { horizon: 0xcfe2ec, zenith: 0x84b7dc, fogNear: 140, fogFar: 850 }
export function streetSky() {
  const cv = document.createElement('canvas'); cv.width = 2; cv.height = 128
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
  const fog = new THREE.Fog(0xcfe0ea, 120, 850), ca = new THREE.Color(), cb = new THREE.Color(), cc = new THREE.Color()
  let key = ''
  return {
    far: FAIR.fogFar, // how far the view reaches now (the fog's end)
    // k: 0 the map's look (no fog) .. 1 the street's; D: the camera's distance to its focus (the fog blends in from
    // far away as it comes down); bg: the scene's own background; vista 0 .. 1 pushes the haze out for a long view.
    // Sets city.scene.fog and .background; returns the atmosphere used.
    apply(city, D, k, bg, vista = 0) {
      const A = city.weather?.atmosphere || FAIR
      ca.setHex(A.horizon); cb.setHex(A.zenith)
      this.far = A.fogFar + 13000 * vista
      fog.color.copy(ca)
      fog.near = A.fogNear + 3500 * vista + (D * 4 + 2000) * (1 - k); fog.far = this.far + (D * 8 + 4000) * (1 - k)
      city.scene.fog = fog // from the start of the dive (far away at first), so materials switch to fog only once
      const kk = `${A.horizon} ${A.zenith} ${k.toFixed(2)}`
      if (kk !== key) {
        key = kk
        const g = cv.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 128)
        gr.addColorStop(0, cb.getStyle()); gr.addColorStop(0.55, ca.getStyle()); gr.addColorStop(1, ca.getStyle())
        g.globalAlpha = 1; g.fillStyle = (bg?.isColor ? bg : cc.set(0x0e1620)).getStyle(); g.fillRect(0, 0, 2, 128)
        g.globalAlpha = k; g.fillStyle = gr; g.fillRect(0, 0, 2, 128)
        tex.needsUpdate = true
      }
      city.scene.background = tex
      return A
    },
    dispose() { tex.dispose() },
  }
}

// ---------------------------------------------------------------- touch buttons
// hold-to-press buttons ([data-k] in root) kept in state[k]; onPress(k) on each press (to wake the sound up),
// onRelease(k) when one is let go
export function touchButtons(root, state, onPress, onRelease) {
  for (const b of root.querySelectorAll('[data-k]')) {
    const k = b.dataset.k, set = (on) => (e) => {
      e.preventDefault()
      const was = state[k]; state[k] = on; b.classList.toggle('on', on)
      if (on) { if (!was) buzz(6); onPress?.(k) } else if (was) onRelease?.(k)
    }
    b.addEventListener('pointerdown', (e) => { try { b.setPointerCapture(e.pointerId) } catch {} set(true)(e) })
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, set(false))
    b.addEventListener('contextmenu', (e) => e.preventDefault())
  }
}

// ---------------------------------------------------------------- sound
// One AudioContext for the games (a page gets only a few, and each costs a thread): each plugin hangs its own gain
// off it and disconnects that when done. Resumed whenever asked for while the page shows.
let ac = null
export function audioContext() {
  if (!ac) { try { ac = new AudioContext() } catch { return null } }
  if (ac.state === 'suspended' && !document.hidden) ac.resume()
  return ac
}
// a tone with a quick attack and an exponential fade, into dest
export function tone(dest, freq, t0, dur, vol, type = 'sine', attack = 0.012) {
  const c = dest.context, o = c.createOscillator(), g = c.createGain()
  o.type = type; o.frequency.value = freq
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  o.connect(g); g.connect(dest); o.start(t0); o.stop(t0 + dur + 0.05)
}
// white noise, secs long
export function noise(c, secs = 1) {
  const b = c.createBuffer(1, Math.round(c.sampleRate * secs), c.sampleRate), d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  return b
}
