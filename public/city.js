// The plugin host: one `city` object that every plugin gets. See PLUGINS.md.
// A plugin is an ES module whose default export is `(city) => ({ dispose() })` (dispose optional).
import * as THREE from 'three'

export function createCity({ scene, overlay, camera, renderer, controls, zAt, ll, toLatLon, sun, hemi, setSun, post, requestRender, data, tiles, night, suppressBuildings, ownCamera }) {
  const handlers = new Map()
  const own = () => ownCamera?.active
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
      // a [[lat, lon], …] ring where your plugin draws its own building: the generic one there is removed
      suppressBuildings(ring) { suppressBuildings?.(ring) },
      // call fn(tile) for every loaded tile now, and on every tile that loads later; returns an unsubscribe
      eachTile(fn) { tiles?.forEach((t) => fn(t)); return city.on('tile:load', fn) },
    },
    view: {
      // while a plugin has its own camera (useCamera): the map zoom that shows its focus at the same scale
      get zoom() { return own() ? ownCamera.zoom : camera.zoom },
      get center() { return own() ? own().opts.focus.clone() : controls.target.clone() },
      get metresPerPixel() { return 1 / (6 * city.view.zoom) }, // CSS px
      // ground rectangle on screen (x0, z0, x1, z1), generous for the 30° tilt
      get bounds() {
        if (own()) { const f = own().opts.focus, r = own().opts.radius ?? 900; return { x0: f.x - r, x1: f.x + r, z0: f.z - r, z1: f.z + r } }
        const t = controls.target, hw = innerWidth / 2 / (6 * camera.zoom), hh = innerHeight / (6 * camera.zoom)
        return { x0: t.x - hw, x1: t.x + hw, z0: t.z - hh, z1: t.z + hh }
      },
      // the camera the map is drawn with: city.camera, or the one a plugin passed to useCamera
      get camera() { return own()?.camera || camera },
      // draw the map through your own camera (e.g. a PerspectiveCamera for a game): MapControls stop, and tiles
      // stream, shadows fit and fog-aware ink work around opts.focus (a Vector3 on the ground you keep moving):
      // tiles within opts.radius metres (default 900; ≤ 1100 loads detail tiles), shadows within
      // opts.shadowRadius (default 300). Keep the camera's aspect right on resize.
      useCamera(cam, opts) { ownCamera?.use(cam, opts) },
      // back to the map camera, exactly where it was
      release() { ownCamera?.release() },
    },
    light: {
      sun, hemi, setSunDirection: setSun,
      get night() { return night?.value ?? 0 }, // 0 day .. 1 night: lights windows
      set night(v) { if (night) { night.value = Math.max(0, Math.min(1, v)); requestRender() } },
    },
    post, // { uniforms: { gain (vec3), sat (float) } } colour grade of the final image
    data, // static data the core has loaded
    // the streamed map: loaded tiles (tiles.tiles), and 'tile:load' / 'tile:unload' events with each tile's
    // { level, i, j, ox, oy, size, graph: { pieces: [{ kind, lanes, oneway, drive, w, a, b, pts (world x,y pairs), z }] }, terrain, footprints, water }
    tiles,
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
