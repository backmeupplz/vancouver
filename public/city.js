// The plugin host: one `city` object that every plugin gets. See PLUGINS.md.
// A plugin is an ES module whose default export is `(city) => ({ dispose() })` (dispose optional).
import { seaSurface } from './core/util.js'
import * as THREE from 'three'

export function createCity({ scene, overlay, camera, renderer, controls, zAt, ll, toLatLon, sun, hemi, setSun, post, requestRender, data, tiles, night, late, surface, suppressBuildings, ownCamera, quality }) {
  const handlers = new Map(), tracked = new Map()
  const own = () => ownCamera?.active
  let animators = 0
  const startCard = makeStart()
  const city = {
    version: 1,
    THREE,
    scene, // everything in here gets the ink outlines and shadows
    // graphics quality (core/quality.js): tier.name 'high' | 'low' and its knobs (life, weather: shares of the
    // particles / agents to draw, detail, …); city.on('quality', tier) when it changes
    quality,
    overlay, // drawn last, without outlines (particles, labels, effects)
    camera, renderer, controls,
    canvas: renderer.domElement,
    world: {
      // three.js frame: x east, y up, z south; 1 unit = 1 metre
      fromLatLon(lat, lon) { const [x, n] = ll(lat, lon); return new THREE.Vector3(x, zAt(x, n), -n) },
      toLatLon(x, z) { return toLatLon(x, -z) },
      heightAt(x, z) { return zAt(x, -z) },
      // the pier (float or fixed deck) as drawn at (x, z): { y, road, fixed } or null; isWater: open water, not a pier
      pierAt(x, z) { return tiles?.pierAt(x, -z) ?? null },
      isWater(x, z) { return tiles?.isWater(x, -z) ?? false },
      // street furniture's footing: the nearest point { x, z } at least `margin` m off the carriageways and cycle tracks
      // the map draws, within maxD m; null where (x, z) is clear already (or the detail tile isn't loaded)
      offRoad(x, z, margin = 0.6, maxD = 8) { const p = tiles?.offRoad(x, -z, margin, maxD); return p && { x: p.x, z: -p.y } },
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
      get late() { return late?.value ?? 0 }, // 0 evening .. 1 the small hours: fewer windows lit
      set late(v) { if (late) { late.value = Math.max(0, Math.min(1, v)); requestRender() } },
    },
    // weather on the ground: wet (0..1) darkens it and mirrors `sky` (a THREE.Color) in the wet paving, snow (0..1)
    // whitens flat ground, roofs and, less, the roads
    surface: {
      get wet() { return surface?.wet.value ?? 0 },
      set wet(v) { if (surface) { surface.wet.value = Math.max(0, Math.min(1, v)); requestRender() } },
      get snow() { return surface?.snow.value ?? 0 },
      set snow(v) { if (surface) { surface.snow.value = Math.max(0, Math.min(1, v)); requestRender() } },
      get sky() { return surface?.sky.value },
      get seaHole() { return surface?.seaHole.value }, // Vector4 (x, sea level, z, radius): no map sea in there (radius 0: off)
    },
    // the sea: `level`, metres the water stands above the lowest sea (0 to 0.7) (the tide, set by the weather plugin: the
    // map's water, docks and berthed boats rise with it, 'tide' is emitted), and `surfaceAt(x, z)`, a plugin's own
    // water surface (the sail plugin's waves while sailing), else null
    sea: {
      get level() { return surface?.tide.value ?? 0 },
      set level(v) { if (!surface || v === surface.tide.value) return; surface.tide.value = v; tiles?.setSea(v); requestRender(); city.emit('tide', v) },
      at(x, z) { return seaSurface(zAt(x, -z, true), surface?.tide.value ?? 0) }, // the still water's height at a point on the water
      surfaceAt: null,
    },
    post, // { uniforms: { gain (vec3), sat (float) } } colour grade of the final image
    data, // static data the core has loaded
    // the streamed map: loaded tiles (tiles.tiles), and 'tile:load' / 'tile:unload' events with each tile's
    // { level, i, j, ox, oy, size, graph: { pieces: [{ kind, lanes, oneway, drive, w, a, b, pts (world x,y pairs), z }] }, terrain, footprints, water }
    tiles,
    // streamed work in progress, for the loading chip: tiles (fetched, decoded, uploaded) plus what plugins track.
    // track(key, got, want): call as your work progresses; want 0 or got >= want clears the key (a key not renewed in 20 s lapses)
    loading: {
      track(key, got, want) { if (want > 0 && got < want) tracked.set(key, [got, want, performance.now()]); else tracked.delete(key) },
      state() {
        let [got, want] = tiles?.counts() || [0, 0]
        const now = performance.now()
        for (const [k, [g, w, at]] of tracked) if (now - at > 20000) tracked.delete(k); else { got += g; want += w }
        return { got, want, busy: got < want }
      },
    },
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
    ui: makeUI(startCard),
  }
  city.on('player', (p) => { if (p) startCard.done() })
  return city
}

// html.compact: the phone layout (index.html sets it); toolbar panels are bottom sheets there
const compact = () => document.documentElement.classList.contains('compact')
const CLOSE_ALL = 'ui:closesheets' // a panel, About or the chat opening: every other one closes

// A panel that is a bottom sheet on phones: a close button, and dragging its top edge down closes it.
// `close()` hides it (and whatever goes with that, e.g. a pressed toolbar button).
function sheet(el, close) {
  const x = () => {
    if (el.querySelector(':scope > .sheet-x')) return
    const g = document.createElement('div'), b = document.createElement('button')
    g.className = 'sheet-grip'; g.setAttribute('aria-hidden', 'true')
    g.addEventListener('pointerdown', drag)
    b.type = 'button'; b.className = 'sheet-x'; b.textContent = '×'; b.setAttribute('aria-label', 'Close')
    b.onclick = close
    el.prepend(g, b)
  }
  // the grip (touch-action: none, so the browser doesn't take the touch for scrolling) follows the finger down
  function drag(e) {
    if (!compact()) return
    const y0 = e.clientY, t0 = performance.now()
    let dy = 0
    try { e.target.setPointerCapture(e.pointerId) } catch {}
    document.body.classList.add('sheet-dragging')
    const move = (ev) => { dy = Math.max(0, ev.clientY - y0); el.style.transform = `translateY(${dy}px)` }
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up)
      document.body.classList.remove('sheet-dragging')
      const fast = dy / Math.max(1, performance.now() - t0) > 0.5
      el.style.transition = 'transform .18s ease-out'
      if (dy > 80 || (dy > 24 && fast)) { el.style.transform = 'translateY(100%)'; setTimeout(() => { close(); el.style.transform = el.style.transition = '' }, 170) }
      else { el.style.transform = ''; setTimeout(() => (el.style.transition = ''), 200) }
    }
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up)
  }
  x()
  return x // call again after replacing the element's contents
}

// The start card: what a first-time visitor can do, at the bottom of the map (it doesn't cover the map's middle, and the
// map pans around it). Not built at all for someone who has closed it, used it or played before.
const STARTED = 'vancouver.started'
function makeStart() {
  let seen = true
  try { seen = !!localStorage.getItem(STARTED) } catch {}
  if (seen) return { add() {}, done() {} }
  const el = document.createElement('div'), row = document.createElement('div'), x = document.createElement('button')
  el.id = 'start'; el.className = 'panel'; el.hidden = true
  el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Start playing')
  el.innerHTML = '<h2>Vancouver is yours to play</h2>'
  row.className = 'start-row'
  x.type = 'button'; x.className = 'start-x'; x.textContent = '×'; x.setAttribute('aria-label', 'Close')
  el.append(x, row)
  document.body.append(el)
  const done = () => { if (seen) return; seen = true; el.remove(); try { localStorage.setItem(STARTED, '1') } catch {} }
  x.onclick = done
  return {
    done,
    add({ icon, label, sub, onClick, order = 0 }) {
      if (seen) return
      const b = document.createElement('button')
      b.type = 'button'; b.style.order = order
      for (const [cls, t] of [['ic', icon], ['lb', label], ['sub', sub]]) if (t) { const s = document.createElement('span'); s.className = cls; s.textContent = t; if (cls === 'ic') s.setAttribute('aria-hidden', 'true'); b.append(s) }
      b.onclick = () => { done(); onClick() }
      row.append(b); el.hidden = false
    },
  }
}

function makeUI(startCard) {
  const bar = document.getElementById('tools')
  // About (index.html) is a sheet too
  const about = document.getElementById('about'), aboutBtn = document.getElementById('aboutBtn')
  if (about && aboutBtn) {
    const close = () => { about.hidden = true; aboutBtn.setAttribute('aria-expanded', 'false') }
    sheet(about, close)
    aboutBtn.addEventListener('click', () => { if (about.hidden) document.dispatchEvent(new Event(CLOSE_ALL)) }, true) // before its own toggle
    document.addEventListener(CLOSE_ALL, close)
  }
  // Phones: the dock keeps the buttons added with `dock: true` (the games) and a ⋯ button whose sheet holds the rest
  // of the toolbar, what plugins pass to inMenu() (music, a game's secondary toggles, its chat), the graphics
  // quality, the frame rate switch, the top bar (About, Open full, online) and the credits. In a game (body.dlv-on)
  // a floating ⋯ takes the dock's place. A wide screen puts everything back where it was.
  const menu = document.createElement('div')
  menu.id = 'menu'; menu.className = 'panel'; menu.hidden = true
  menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', 'More')
  menu.innerHTML = '<div class="menu-tools"></div><div class="menu-items"></div><div class="menu-set"><div class="menu-gfx"></div>'
    + '<label class="menu-fps"><input type="checkbox"> Frame rate</label></div><div class="menu-foot"></div>'
  document.body.append(menu)
  const grid = menu.querySelector('.menu-tools'), items = menu.querySelector('.menu-items'), foot = menu.querySelector('.menu-foot')
  const mores = []
  const closeMenu = () => { menu.hidden = true; for (const b of mores) b.setAttribute('aria-expanded', 'false') }
  sheet(menu, closeMenu)
  document.addEventListener(CLOSE_ALL, closeMenu)
  const moreButton = (cls) => {
    const b = document.createElement('button')
    b.type = 'button'; b.className = cls
    b.innerHTML = '<span class="ic" aria-hidden="true">⋯</span><span class="lb">More</span>'
    b.setAttribute('aria-label', 'More: music, chat, settings'); b.setAttribute('aria-controls', 'menu'); b.setAttribute('aria-expanded', 'false')
    b.onclick = () => {
      const open = menu.hidden
      document.dispatchEvent(new Event(CLOSE_ALL))
      if (!open) return
      for (const m of moved) m.el.classList.toggle('menu-off', !!m.home && !m.home.getClientRects().length) // its game is off
      menu.hidden = false; b.setAttribute('aria-expanded', 'true')
    }
    mores.push(b)
    return b
  }
  const more = moreButton('more')
  document.body.append(moreButton('panel more-fab'))
  const fps = menu.querySelector('.menu-fps input')
  try { fps.checked = localStorage.getItem('vancouver.fps') === '1' } catch {}
  const showFps = () => { document.documentElement.classList.toggle('fps-on', fps.checked); try { localStorage.setItem('vancouver.fps', fps.checked ? '1' : '0') } catch {} }
  fps.onchange = showFps; showFps()
  // what moves: a comment marks each element's place for the way back
  const hud = document.createElement('div'); hud.id = 'hud'; document.body.append(hud)
  const buttons = [], moved = []
  let phone = compact()
  const placeButton = (b) => (phone && !b.dock ? grid.append(b) : bar.insertBefore(b, more))
  const placeEl = (m) => (phone ? m.to.append(m.el) : m.mark.after(m.el))
  function move(el, to, home) { const m = { el, to, home, mark: document.createComment('menu') }; el.before(m.mark); moved.push(m); placeEl(m) }
  const unmove = (el) => { const i = moved.findIndex((m) => m.el === el); if (i >= 0) moved.splice(i, 1)[0].mark.remove() }
  bar.append(more)
  const gfx = document.getElementById('gfxBox'), top = document.getElementById('bar')
  if (gfx) move(gfx, menu.querySelector('.menu-gfx'))
  if (top) move(top, foot)
  addEventListener('resize', () => { // (index.html's listener has set html.compact by now)
    if (phone === compact()) return
    phone = compact()
    for (const b of buttons) placeButton(b)
    for (const m of moved) placeEl(m)
    if (!phone) closeMenu()
  })
  const toasts = [], stack = document.createElement('div')
  stack.id = 'toasts'; document.body.append(stack)
  let toastEl = null, toastT = 0, toastAt = 0, toastMs = 0, holds = 0
  function nextToast() {
    if (holds || !toasts.length) return
    if (toastEl) { // the one showing gives way after its reading time (about 25 characters a second)
      const left = Math.min(toastMs, 700 + 40 * toastEl.textContent.length) - (performance.now() - toastAt)
      clearTimeout(toastT); toastT = setTimeout(endToast, Math.max(0, left))
      return
    }
    const [text, ms] = toasts.shift()
    toastEl = document.createElement('div')
    toastEl.className = 'panel toast'
    toastEl.setAttribute('role', 'status')
    toastEl.textContent = text
    stack.prepend(toastEl)
    toastAt = performance.now(); toastMs = ms; toastT = setTimeout(endToast, ms)
    if (toasts.length) nextToast()
  }
  function endToast() { clearTimeout(toastT); toastEl?.remove(); toastEl = null; nextToast() }
  return {
    // a toolbar button at the top right (on phones: the dock at the bottom); with `panel: true` it opens a small
    // panel under it (on phones: a bottom sheet). `set({ icon, label })` changes what the button says.
    // `dock: true`: one of the few that stay on the phone dock (the games); the rest go in its ⋯ sheet
    addButton({ label, title, icon, onClick, panel, dock }) {
      const b = document.createElement('button')
      b.type = 'button'
      const ic = document.createElement('span'), lb = document.createElement('span')
      ic.className = 'ic'; lb.className = 'lb'
      ic.setAttribute('aria-hidden', 'true')
      const name = label // what the button is, kept when set() swaps the label for a reading (weather: '6°')
      const set = ({ icon: i = icon, label: l = label } = {}) => { icon = i; label = l; ic.textContent = i || ''; lb.textContent = l || ''; b.dataset.name = l !== name ? name || '' : '' }
      set()
      b.append(ic, lb)
      if (title) b.title = title
      b.setAttribute('aria-label', title || label)
      b.dock = !!dock
      buttons.push(b); placeButton(b)
      bar.hidden = false
      let el = null
      if (panel) {
        el = document.createElement('div')
        el.className = 'panel tool-panel'
        el.hidden = true
        el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', label || title)
        document.body.append(el)
        b.setAttribute('aria-expanded', 'false')
        const close = () => { el.hidden = true; b.setAttribute('aria-expanded', 'false') }
        const ensureX = sheet(el, close)
        document.addEventListener(CLOSE_ALL, close)
        b.addEventListener('click', () => {
          const open = el.hidden
          document.dispatchEvent(new Event(CLOSE_ALL))
          if (!open) return
          ensureX() // the plugin may have replaced the panel's contents since
          el.hidden = false; b.setAttribute('aria-expanded', 'true')
          if (compact()) { el.style.top = el.style.right = '' } else { const r = b.getBoundingClientRect(); el.style.top = `${r.bottom + 8}px`; el.style.right = `${Math.max(12, innerWidth - r.right)}px` }
        })
      }
      if (onClick) b.addEventListener('click', onClick)
      return { button: b, panel: el, set, remove() { b.remove(); el?.remove(); buttons.splice(buttons.indexOf(b), 1); bar.hidden = !buttons.length } }
    },
    // the bottom-sheet behaviour of toolbar panels, for a plugin's own panel: returns a function that puts the
    // close button back (call it after replacing the panel's contents)
    sheet,
    // ask every open panel (toolbar panels, About, a plugin's sheet listening for it) to close
    closeAll() { document.dispatchEvent(new Event(CLOSE_ALL)) },
    onCloseAll(fn) { document.addEventListener(CLOSE_ALL, fn); return () => document.removeEventListener(CLOSE_ALL, fn) },
    get compact() { return compact() },
    // one thing at a time: a toast waits for the one on screen (which makes way once it has been read) and while a
    // plugin holds them back (`release = hold()`: its how-to card is up); the same text isn't queued twice
    toast(text, ms = 3000) {
      if (toastEl?.textContent === text || toasts.some((q) => q[0] === text)) return
      toasts.push([text, ms]); nextToast()
    },
    toasts: stack, // the column toasts show in: a plugin's own pops go in it too, and so never land on a toast
    clearToasts() { toasts.length = 0; endToast() }, // a game ending: its hints, on screen or waiting, are stale
    hold() { holds++; let done = false; return () => { if (!done) { done = true; holds--; nextToast() } } },
    // the first visit's start card (index.html #start): a way in for a newcomer, e.g. { icon: '⛵', label: 'Sail',
    // sub: 'the real wind', onClick }; `order` sorts them. Gone for good once closed, used, or a game has started
    addStart: startCard.add,
    // on phones, `el` lives in the ⋯ sheet instead of where it is (its own CSS and `hidden` still apply there); it
    // is listed only while `home` (default: its parent) is on screen, so a game's toggles show only in that game
    // the row at the top right while a game is on (index.html #hud): the game's buttons, and to their left what
    // other plugins add (the chat button), side by side so nothing lands on the game's panels
    hud,
    inMenu(el, home = el.parentElement) { move(el, items, home === document.body ? null : home) },
    // a line in the credits strip at the bottom of the page (a link with href): { set(text, href), remove() }
    credit(text, href) {
      let el = document.getElementById('credits')
      if (!el) {
        el = document.createElement('div')
        el.id = 'credits'
        el.className = 'panel'
        Object.assign(el.style, { left: '50%', bottom: '12px', transform: 'translateX(-50%)', padding: '4px 10px', fontSize: '11px', color: 'var(--muted)', zIndex: 15, display: 'flex', gap: '10px', whiteSpace: 'nowrap', maxWidth: 'calc(100% - 24px)', overflow: 'hidden' })
        document.body.append(el)
        move(el, foot) // phones: in the ⋯ sheet (index.html keeps a short OpenStreetMap credit on screen)
      }
      const s = document.createElement('a')
      s.target = '_blank'; s.rel = 'noopener'; s.style.color = 'inherit'
      el.append(s)
      const set = (t, h) => { s.textContent = t; if (h) s.href = h }
      set(text, href)
      return { set, remove() { s.remove(); if (!el.children.length) { unmove(el); el.remove() } } }
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
