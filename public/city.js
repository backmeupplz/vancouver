// The plugin host: one `city` object that every plugin gets. See PLUGINS.md.
// A plugin is an ES module whose default export is `(city) => ({ dispose() })` (dispose optional).
import * as THREE from 'three'

export function createCity({ scene, overlay, camera, renderer, controls, zAt, ll, toLatLon, sun, hemi, setSun, post, requestRender, data }) {
  const handlers = new Map()
  let animators = 0
  const city = {
    version: 1,
    THREE,
    scene, // everything in here gets the ink outlines and shadows
    overlay, // drawn last, without outlines (particles, labels, effects)
    camera, renderer, controls,
    canvas: renderer.domElement,
    world: {
      // three.js frame: x east, y up, z south; 1 unit = 1 metre
      fromLatLon(lat, lon) { const [x, n] = ll(lat, lon); return new THREE.Vector3(x, zAt(x, n), -n) },
      toLatLon(x, z) { return toLatLon(x, -z) },
      heightAt(x, z) { return zAt(x, -z) },
    },
    view: {
      get zoom() { return camera.zoom },
      get center() { return controls.target.clone() },
      get metresPerPixel() { return 1 / (6 * camera.zoom) }, // CSS px
      // ground rectangle on screen (x0, z0, x1, z1), generous for the 30° tilt
      get bounds() {
        const t = controls.target, hw = innerWidth / 2 / (6 * camera.zoom), hh = innerHeight / (6 * camera.zoom)
        return { x0: t.x - hw, x1: t.x + hw, z0: t.z - hh, z1: t.z + hh }
      },
    },
    light: { sun, hemi, setSunDirection: setSun },
    post, // { uniforms: { gain (vec3), sat (float) } } colour grade of the final image
    data, // static data the core has loaded (e.g. data.roads)
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(fn)
      return () => handlers.get(event)?.delete(fn)
    },
    emit(event, ...args) {
      for (const fn of handlers.get(event) || []) { try { fn(...args) } catch (e) { console.error(`[${event}]`, e) } }
    },
    requestRender, // draw one more frame (the page renders on demand)
    animate(on = true) { // keep drawing every frame while any plugin animates; returns a stop function
      animators += on ? 1 : 0
      requestRender()
      let stopped = !on
      return () => { if (!stopped) { stopped = true; animators--; requestRender() } }
    },
    get animating() { return animators > 0 },
    ui: makeUI(),
  }
  return city
}

function makeUI() {
  const bar = document.getElementById('tools')
  return {
    // a toolbar button at the top right; with `panel: true` it opens a small panel under it
    addButton({ label, title, icon, onClick, panel }) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = icon ? `${icon} ${label || ''}`.trim() : label
      if (title) b.title = title
      b.setAttribute('aria-label', title || label)
      bar.append(b)
      bar.hidden = false
      let el = null
      if (panel) {
        el = document.createElement('div')
        el.className = 'panel tool-panel'
        el.hidden = true
        document.body.append(el)
        b.setAttribute('aria-expanded', 'false')
        b.addEventListener('click', () => {
          const open = el.hidden
          for (const p of document.querySelectorAll('.tool-panel')) p.hidden = true
          for (const x of bar.querySelectorAll('button[aria-expanded]')) x.setAttribute('aria-expanded', 'false')
          el.hidden = !open; b.setAttribute('aria-expanded', String(open))
          if (open) { const r = b.getBoundingClientRect(); el.style.top = `${r.bottom + 8}px`; el.style.right = `${Math.max(12, innerWidth - r.right)}px` }
        })
      }
      if (onClick) b.addEventListener('click', onClick)
      return { button: b, panel: el, remove() { b.remove(); el?.remove(); bar.hidden = !bar.children.length } }
    },
    toast(text, ms = 3000) {
      const t = document.createElement('div')
      t.className = 'panel toast'
      t.textContent = text
      document.body.append(t)
      setTimeout(() => t.remove(), ms)
    },
  }
}

// Plugins listed in plugins/index.json, plus ?plugin=<path> for local development (same origin only).
export async function loadPlugins(city) {
  const list = await fetch('plugins/index.json').then((r) => r.json()).catch(() => [])
  for (const p of new URLSearchParams(location.search).getAll('plugin')) {
    const u = new URL(p, location.href)
    if (u.origin === location.origin) list.push(u.pathname)
    else console.warn('plugin from another origin ignored:', p)
  }
  const loaded = []
  for (const path of list) {
    try {
      const m = await import(new URL(path, location.href).href)
      loaded.push({ path, instance: (await m.default(city)) || {} })
    } catch (e) { console.error('plugin', path, e) }
  }
  return loaded
}
