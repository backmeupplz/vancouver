// Live: visitor counts, other people exploring the streets with you, and a chat.
// Talks to the Rust service in /server over one WebSocket (same origin, /live/ws; for local development
// ?live=ws://127.0.0.1:48501/live/ws). Every visitor opens it, which is how "online now" is counted; it idles
// cheaply and closes after 5 minutes in a hidden tab. While you drive or walk (city.player, from the drive plugin),
// your position goes out 10 times a second and people within 1.5 km come back the same way; everyone playing
// shows on the map as a small marker. Blocking someone hides their van, marker and chat lines everywhere, and the
// server stops sending them to you (and you to them). Chat is plain text, always set with textContent.
// Protocol: see server/src/world.rs. No third-party data; positions are what players send.

const PALETTE = ['#f2a07e', '#7fc4e8', '#9ad77a', '#f5d06f', '#c59af0', '#f08fb0', '#6fd6c8', '#ff8c5a']
const ANIMALS = ['Otter', 'Heron', 'Orca', 'Raven', 'Seal', 'Salmon', 'Eagle', 'Beaver', 'Cedar', 'Crab', 'Puffin', 'Fern', 'Moose', 'Loon', 'Marmot', 'Hummingbird']
const SEND_MS = 100 // 10 Hz while playing
const BEHIND = 130 // ms: remote players are drawn this far in the past, between two snapshots
const COARSE_MS = 2000 // the map list comes every 2 s
const SHOW_3D = 32 // at most this many remote vans/people drawn
const TAG_RANGE = 260 // metres: name tags beyond this are hidden
const HIDDEN_CLOSE_MS = 5 * 60e3
const LINES = 150 // kept per chat channel

const store = {
  get(k, d) { try { const v = localStorage.getItem('live.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('live.' + k, JSON.stringify(v)) } catch {} },
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const fmt = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export default function multiplayer(city) {
  const { THREE } = city
  const qs = new URLSearchParams(location.search)
  const dev = qs.get('live')
  const URL_WS = dev && /^wss?:\/\//.test(dev) ? dev : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live/ws`

  // ================================================================ who I am (kept in this browser)
  const me = { slot: 0, id: null, name: store.get('name', '') || `${pick(ANIMALS)} ${10 + Math.floor(Math.random() * 90)}`, colour: store.get('colour', '') || pick(PALETTE) }
  const blocked = new Map(store.get('blocked', []).map((b) => [b.id, b.name])) // id → name
  const saveBlocked = () => store.set('blocked', [...blocked].map(([id, name]) => ({ id, name })))

  // ================================================================ UI
  const css = document.createElement('style')
  css.textContent = `
    .live-stats { display: inline-flex; align-items: center; gap: 6px; margin: 0 6px 0 2px; color: var(--muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; cursor: default; }
    .live-stats[hidden] { display: none }
    .live-dot { width: 7px; height: 7px; border-radius: 50%; background: #6fd08c; box-shadow: 0 0 0 3px rgba(111, 208, 140, .18); flex: none; }
    .live-stats b { color: var(--text); font-weight: 600 }
    .live-badge { display: inline-block; min-width: 16px; height: 16px; padding: 0 4px; margin-left: 5px; border-radius: 8px; background: #e8735a; color: #fff; font-size: 10.5px; font-weight: 700; line-height: 16px; text-align: center; box-sizing: border-box; vertical-align: 1px; }
    .live-badge[hidden] { display: none }
    .live-fab { right: 12px; top: 60px; z-index: 26; padding: 6px 12px; font: inherit; color: var(--text); cursor: pointer; display: none; }
    body.dlv-on .live-fab.on { display: block }
    .live-chat { right: 12px; top: 58px; z-index: 26; width: min(320px, calc(100% - 24px)); max-height: min(480px, calc(100% - 150px)); display: flex; flex-direction: column; box-sizing: border-box; padding: 10px 12px 12px; }
    body.dlv-on .live-chat { top: 104px; max-height: min(420px, calc(100% - 300px)); }
    .live-chat[hidden] { display: none }
    .live-head { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
    .live-head button, .live-chat .live-btn { font: inherit; color: var(--text); background: none; border: 0; border-radius: 7px; padding: 4px 9px; cursor: pointer; }
    .live-head button:hover, .live-chat .live-btn:hover, .live-head button[aria-selected="true"] { background: rgba(255, 255, 255, .1) }
    .live-head button[data-new]::after { content: ''; display: inline-block; width: 6px; height: 6px; margin-left: 5px; border-radius: 50%; background: #e8735a; vertical-align: 2px; }
    .live-head .x { margin-left: auto; color: var(--muted); font-size: 15px; line-height: 1; padding: 4px 8px; }
    .live-lines { flex: 1 1 auto; min-height: 90px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; padding-right: 2px; overscroll-behavior: contain; }
    .live-line { overflow-wrap: anywhere; color: var(--text); line-height: 1.4; }
    .live-who { font: inherit; font-weight: 650; background: none; border: 0; padding: 0; margin-right: 6px; cursor: pointer; }
    .live-who.me { cursor: default }
    .live-who small { font-weight: 400; color: var(--muted); margin-left: 3px; font-size: 10.5px; }
    .live-empty { color: var(--muted); margin: auto 0; text-align: center; padding: 14px 4px; }
    .live-form { display: flex; gap: 6px; margin-top: 8px; }
    .live-chat input[type=text] { flex: 1; min-width: 0; font: inherit; font-size: 16px; color: var(--text); background: rgba(255, 255, 255, .07); border: 1px solid var(--line); border-radius: 8px; padding: 6px 9px; outline: none; }
    @media (min-width: 601px) { .live-chat input[type=text] { font-size: 13px } }
    .live-chat input[type=text]:focus { border-color: var(--accent) }
    .live-send { font: inherit; color: #0b1016; background: var(--accent); border: 0; border-radius: 8px; padding: 0 12px; cursor: pointer; font-weight: 600; }
    .live-status { color: #f0b37e; font-size: 12px; min-height: 0; margin-top: 4px; }
    .live-status:empty { display: none }
    .live-me { display: flex; align-items: center; gap: 6px; margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line); color: var(--muted); }
    .live-swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, .5); cursor: pointer; flex: none; padding: 0; }
    .live-blocked { margin-top: 8px; color: var(--muted); }
    .live-blocked summary { cursor: pointer; }
    .live-blocked .row { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--text); }
    .live-blocked .row span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .live-menu { position: fixed; z-index: 40; padding: 6px; display: flex; flex-direction: column; gap: 2px; min-width: 150px; }
    .live-menu .t { padding: 2px 8px 4px; color: var(--muted); font-size: 12px; }
    .live-menu button { font: inherit; color: var(--text); background: none; border: 0; border-radius: 6px; padding: 6px 8px; text-align: left; cursor: pointer; }
    .live-menu button:hover { background: rgba(255, 255, 255, .1) }
    .live-layer { position: fixed; inset: 0; pointer-events: none; z-index: 12; overflow: hidden; }
    .live-tag, .live-mark { position: absolute; left: 0; top: 0; will-change: transform; white-space: nowrap; font: 600 11.5px/1.2 system-ui, -apple-system, sans-serif; color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, .7), 0 0 6px rgba(0, 0, 0, .35); }
    .live-tag { text-align: center; }
    .live-tag .say { display: block; max-width: 220px; margin: 0 auto 3px; padding: 4px 8px; border-radius: 9px; background: rgba(255, 255, 255, .94); color: #1b2530; text-shadow: none; font-weight: 500; white-space: normal; overflow-wrap: anywhere; width: max-content; }
    .live-tag .say:empty { display: none }
    .live-mark { display: flex; align-items: center; gap: 4px; pointer-events: auto; cursor: pointer; text-shadow: none; }
    .live-mark span { padding: 1px 6px 2px; border-radius: 6px; background: rgba(11, 16, 22, .72); border: 1px solid rgba(255, 255, 255, .14); }
    .live-mark i { width: 10px; height: 10px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .5); flex: none; }
    .live-mark.foot i { width: 8px; height: 8px; }
    .live-mark[hidden], .live-tag[hidden], .live-menu[hidden] { display: none }
    /* phones: the toolbar no longer fits beside the title bar (it covered About), so it moves under it */
    @media (max-width: 600px) {
      .live-stats .more { display: none } .live-stats { margin-right: 2px }
      #tools { top: 58px !important; max-width: calc(100% - 24px); overflow-x: auto; scrollbar-width: none; }
      #about { top: 104px !important; max-height: calc(100% - 230px) !important; }
      .live-chat { top: 104px; max-height: min(420px, calc(100% - 240px)); }
    }`
  document.head.append(css)
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }

  // stats: a line in the top bar, and a sentence in About
  const bar = document.getElementById('bar'), about = document.getElementById('about')
  const statsEl = h('span', 'live-stats'); statsEl.hidden = true
  const nowEl = h('b'), dayEl = h('b'), weekEl = h('b'), more = h('span', 'more')
  statsEl.append(h('i', 'live-dot'), nowEl, h('span', null, ' online'), more)
  more.append(h('span', null, ' · '), dayEl, h('span', null, ' today · '), weekEl, h('span', null, ' this week'))
  bar?.append(statsEl)
  const aboutEl = h('p', 'live-about'); aboutEl.hidden = true
  about?.insertBefore(aboutEl, about.querySelector('h2'))
  function showStats(s) {
    if (!s) return
    nowEl.textContent = fmt(s.now); dayEl.textContent = fmt(s.day); weekEl.textContent = fmt(s.week)
    const t = `${s.now} ${s.now === 1 ? 'person is' : 'people are'} on the map right now; ${s.day} visited in the last 24 hours and ${s.week} in the last 7 days.`
    statsEl.title = t
    aboutEl.textContent = `${t} Visitors are counted without storing addresses: a daily-salted hash that can't be traced back after the day ends.`
    statsEl.hidden = aboutEl.hidden = false
  }

  // the chat panel, opened from the toolbar on the map or from a floating button while driving
  const tool = city.ui.addButton({ label: 'Chat', icon: '💬', title: 'Chat with people on the map (Enter)', onClick: () => toggleChat() })
  tool.button.hidden = true
  const badge = h('span', 'live-badge'); badge.hidden = true
  tool.button.append(badge)
  const fab = h('button', 'panel live-fab', '💬 Chat'); fab.type = 'button'; fab.title = 'Chat (Enter)'
  const fabBadge = h('span', 'live-badge'); fabBadge.hidden = true; fab.append(fabBadge)
  fab.onclick = () => toggleChat()
  document.body.append(fab)

  const panel = h('div', 'panel live-chat'); panel.hidden = true
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Chat')
  const head = h('div', 'live-head')
  const tabs = { g: h('button', null, 'Everyone'), n: h('button', null, 'Nearby') }
  tabs.g.title = 'Everyone on the map'; tabs.n.title = 'People within 1.5 km of you'
  const closeBtn = h('button', 'x', '×'); closeBtn.title = 'Close'; closeBtn.setAttribute('aria-label', 'Close chat')
  head.append(tabs.g, tabs.n, closeBtn)
  const linesEl = h('div', 'live-lines'); linesEl.setAttribute('aria-live', 'polite')
  const form = h('form', 'live-form')
  const input = h('input'); input.type = 'text'; input.maxLength = 200; input.placeholder = 'Say something…'; input.autocomplete = 'off'; input.enterKeyHint = 'send'
  const send = h('button', 'live-send', 'Send'); send.type = 'submit'
  form.append(input, send)
  const status = h('div', 'live-status')
  const meRow = h('div', 'live-me')
  const nameIn = h('input'); nameIn.type = 'text'; nameIn.maxLength = 20; nameIn.setAttribute('aria-label', 'Your name'); nameIn.value = me.name; nameIn.autocomplete = 'off'; nameIn.name = 'chat-display-name'; for (const a of ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type']) nameIn.setAttribute(a, a === 'data-form-type' ? 'other' : 'true') // not a login: no password-manager popups
  const swatch = h('button', 'live-swatch'); swatch.type = 'button'; swatch.title = 'Your colour'; swatch.setAttribute('aria-label', 'Change your colour')
  meRow.append(h('span', null, 'You'), nameIn, swatch)
  const blockedEl = h('details', 'live-blocked')
  panel.append(head, linesEl, form, status, meRow, blockedEl)
  document.body.append(panel)

  let tab = 'g', unread = 0, statusT = 0
  const lines = { g: [], n: [] }
  function setStatus(t) { status.textContent = t; clearTimeout(statusT); if (t) statusT = setTimeout(() => (status.textContent = ''), 4500) }
  function setUnread(n) { unread = n; for (const b of [badge, fabBadge]) { b.textContent = n > 9 ? '9+' : String(n); b.hidden = !n } }
  function toggleChat(open = panel.hidden) {
    if (open) { // one panel at a time, like the other toolbar panels
      for (const p of document.querySelectorAll('.tool-panel')) p.hidden = true
      for (const x of document.querySelectorAll('#tools button[aria-expanded]')) x.setAttribute('aria-expanded', 'false')
    }
    panel.hidden = !open
    tool.button.setAttribute('aria-pressed', String(open))
    menu.hidden = true
    if (open) { setUnread(0); render(); if (!matchMedia('(pointer: coarse)').matches) input.focus() } else input.blur()
  }
  document.getElementById('tools')?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b !== tool.button) toggleChat(false) })
  closeBtn.onclick = () => toggleChat(false)
  for (const k of ['g', 'n']) tabs[k].onclick = () => { tab = k; delete tabs[k].dataset.new; render(); input.focus() }
  // keys typed here are for the chat, not for the van
  for (const el of [input, nameIn]) el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { el === input ? toggleChat(false) : el.blur() } })
  const onKey = (e) => {
    if (e.key !== 'Enter' || e.repeat || !connected || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target?.tagName) || e.target?.isContentEditable) return
    e.preventDefault(); if (panel.hidden) toggleChat(true); else input.focus()
  }
  addEventListener('keydown', onKey)
  form.onsubmit = (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    if (tab === 'n' && !city.player) return setStatus('Start exploring (Drive) to talk to people near you.')
    out({ t: 'chat', ch: tab, text }); input.value = ''
  }
  nameIn.onchange = () => { const n = nameIn.value.trim(); if (n && n !== me.name) out({ t: 'name', name: n, colour: me.colour }) }
  swatch.onclick = () => { const c = PALETTE[(PALETTE.indexOf(me.colour) + 1) % PALETTE.length]; out({ t: 'name', name: me.name, colour: c }) }
  function paintMe() { nameIn.value = me.name; swatch.style.background = me.colour }

  // a small menu for a person: block / unblock
  const menu = h('div', 'panel live-menu'); menu.hidden = true
  document.body.append(menu)
  function personMenu(id, name, x, y) {
    if (!id || id === me.id) return
    menu.replaceChildren(h('div', 't', `${name} #${id.slice(0, 4)}`))
    const isB = blocked.has(id)
    const b = h('button', null, isB ? `Unblock ${name}` : `Block ${name}`)
    b.onclick = () => { menu.hidden = true; isB ? unblock(id) : block(id, name) }
    const c = h('button', null, 'Cancel'); c.onclick = () => (menu.hidden = true)
    menu.append(b, c)
    menu.hidden = false
    const r = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, x))}px`
    menu.style.top = `${Math.max(8, Math.min(innerHeight - r.height - 8, y))}px`
  }
  const offMenu = (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true }
  addEventListener('pointerdown', offMenu, true)

  function lineEl(l) {
    const d = h('div', 'live-line')
    const who = h('button', 'live-who' + (l.id === me.id ? ' me' : ''), l.name)
    who.type = 'button'; who.style.color = l.colour
    who.append(h('small', null, `#${l.id.slice(0, 4)}`))
    if (l.id !== me.id) { who.title = `${l.name}: block or unblock`; who.onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); personMenu(l.id, l.name, r.left, r.bottom + 4) } }
    d.append(who, h('span', null, l.text))
    return d
  }
  function render() {
    for (const k of ['g', 'n']) tabs[k].setAttribute('aria-selected', String(tab === k))
    if (panel.hidden) return
    const shown = lines[tab].filter((l) => !blocked.has(l.id))
    linesEl.replaceChildren(...shown.map(lineEl))
    if (!shown.length) linesEl.append(h('div', 'live-empty', tab === 'n' ? (city.player ? 'Nobody nearby has said anything yet.' : 'Drive or walk around to talk to people near you.') : 'No messages yet. Say hi!'))
    linesEl.scrollTop = linesEl.scrollHeight
    renderBlocked()
  }
  function renderBlocked() {
    blockedEl.hidden = !blocked.size
    const open = blockedEl.open
    blockedEl.replaceChildren(h('summary', null, `Blocked people (${blocked.size})`))
    for (const [id, name] of blocked) {
      const row = h('div', 'row'), b = h('button', 'live-btn', 'Unblock')
      b.onclick = () => unblock(id)
      row.append(h('span', null, `${name || 'Someone'} #${id.slice(0, 4)}`), b)
      blockedEl.append(row)
    }
    blockedEl.open = open
  }
  function addLine(l) {
    const list = lines[l.ch === 'n' ? 'n' : 'g']
    list.push(l); if (list.length > LINES) list.shift()
    if (blocked.has(l.id)) return
    const p = [...roster.values()].find((r) => r.id === l.id)
    if (p) say(p, l.text)
    if (!panel.hidden && tab === (l.ch === 'n' ? 'n' : 'g')) {
      linesEl.querySelector('.live-empty')?.remove()
      const atEnd = linesEl.scrollHeight - linesEl.scrollTop - linesEl.clientHeight < 40
      linesEl.append(lineEl(l))
      while (linesEl.children.length > LINES) linesEl.firstChild.remove()
      if (atEnd || l.id === me.id) linesEl.scrollTop = linesEl.scrollHeight
    } else if (l.id !== me.id) {
      if (panel.hidden) setUnread(unread + 1)
      else tabs[l.ch === 'n' ? 'n' : 'g'].dataset.new = '1' // open on the other tab: a dot on this one
    }
  }

  // ================================================================ blocking (here and on the server)
  function block(id, name) {
    blocked.set(id, name); saveBlocked()
    out({ t: 'block', id })
    for (const p of roster.values()) if (p.id === id) { drop3d(p); dropMark(p) }
    render(); renderBlocked()
    city.ui.toast(`${name} is blocked: you won't see them or their messages.`)
  }
  function unblock(id) {
    blocked.delete(id); saveBlocked()
    out({ t: 'unblock', id })
    render(); renderBlocked()
  }

  // ================================================================ the connection
  let ws = null, connected = false, retry = 0, retryT = 0, hiddenT = 0, disposed = false
  function out(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)) }
  function connect() {
    clearTimeout(retryT)
    if (disposed || ws) return
    try { ws = new WebSocket(URL_WS) } catch { return later() }
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => out({ t: 'hello', token: store.get('token', undefined), name: me.name, colour: me.colour })
    ws.onmessage = (e) => { try { typeof e.data === 'string' ? onText(JSON.parse(e.data)) : onBinary(new DataView(e.data)) } catch (err) { console.warn('live: bad message', err) } }
    ws.onclose = () => { ws = null; setConnected(false); later() }
  }
  function later() { // back off: 2, 4, 8 … 60 s; not while the tab is hidden
    if (disposed || document.hidden) return
    retryT = setTimeout(connect, Math.min(60, 2 ** ++retry) * 1000)
  }
  function setConnected(on) {
    connected = on
    tool.button.hidden = !on
    fab.classList.toggle('on', on)
    if (!on) {
      statsEl.hidden = aboutEl.hidden = true
      toggleChat(false)
      for (const p of roster.values()) { drop3d(p); dropMark(p) }
      roster.clear()
    }
  }
  const onVisibility = () => {
    clearTimeout(hiddenT)
    if (document.hidden) hiddenT = setTimeout(() => ws?.close(), HIDDEN_CLOSE_MS) // an idle tab stops counting as online
    else if (!ws) { retry = 0; connect() }
  }
  document.addEventListener('visibilitychange', onVisibility)

  function onText(m) {
    switch (m.t) {
      case 'welcome': {
        Object.assign(me, { slot: m.s, id: m.id, name: m.name, colour: m.colour })
        store.set('token', m.token); store.set('name', m.name); store.set('colour', m.colour)
        retry = 0
        // blocks: the server's and this browser's, together
        for (const id of m.blocks) if (!blocked.has(id)) blocked.set(id, '')
        for (const id of blocked.keys()) if (!m.blocks.includes(id)) out({ t: 'block', id })
        saveBlocked()
        for (const p of m.players) join(p)
        lines.g = m.chat.map((l) => ({ ...l, ch: 'g' }))
        for (const l of m.chat) if (blocked.get(l.id) === '') blocked.set(l.id, l.name)
        setConnected(true); paintMe(); showStats(m.stats); render()
        if (city.player) sendState(true)
        break
      }
      case 'join': join(m); break
      case 'leave': { const p = roster.get(m.s); if (p) { drop3d(p); dropMark(p); roster.delete(m.s) } break }
      case 'chat': addLine(m); break
      case 'you': Object.assign(me, { name: m.name, colour: m.colour }); store.set('name', m.name); store.set('colour', m.colour); paintMe(); setStatus(''); break
      case 'stats': showStats(m.stats); break
      case 'error': setStatus(m.msg); paintMe(); break
    }
  }

  // ================================================================ other players
  const roster = new Map() // slot → { slot, id, name, colour, buf: [{t, x, y, z, h, s, mode}], obj, tag, mark, … }
  function join(m) {
    if (m.s === me.slot) return
    let p = roster.get(m.s)
    if (!p) roster.set(m.s, (p = { slot: m.s, buf: [], seen: 0 }))
    if (p.colour && p.colour !== m.colour) drop3d(p)
    Object.assign(p, { id: m.id, name: m.name, colour: m.colour })
    if (p.tag) p.tag.firstChild.nextSibling.textContent = m.name
    if (p.mark) p.mark.lastChild.textContent = m.name
  }
  const visible = (p) => p.id && !blocked.has(p.id)

  function onBinary(v) {
    const type = v.getUint8(0), n = v.getUint16(1, true), now = performance.now()
    if (type === 1) { // players near me, 10 Hz
      if (!city.player) return
      for (let i = 0, o = 3; i < n; i++, o += 21) {
        const p = roster.get(v.getUint32(o, true))
        if (!p || !visible(p)) continue
        const st = { t: now, x: v.getFloat32(o + 4, true), y: v.getFloat32(o + 8, true), z: v.getFloat32(o + 12, true), h: v.getInt16(o + 16, true) / 1e4, s: v.getInt16(o + 18, true) / 100, mode: v.getUint8(o + 20) }
        p.buf.push(st); if (p.buf.length > 12) p.buf.shift()
        p.seen = now
        obstacle(p, st)
      }
      wake3d()
    } else if (type === 2) { // everyone, every 2 s, for the map
      const seen = new Set()
      for (let i = 0, o = 3; i < n; i++, o += 13) {
        const p = roster.get(v.getUint32(o, true))
        if (!p) continue
        seen.add(p)
        const x = v.getFloat32(o + 4, true), z = v.getFloat32(o + 8, true)
        const cur = coarseAt(p, now)
        p.c = { x0: cur ? cur.x : x, z0: cur ? cur.z : z, x1: x, z1: z, t: now, mode: v.getUint8(o + 12) }
      }
      for (const p of roster.values()) if (!seen.has(p)) { p.c = null; dropMark(p) }
      wakeMarks()
    }
  }

  // ---------------------------------------------------------------- my own state, ≤ 10 Hz while playing
  let sendT = 0, lastSent = null, lastSentAt = 0
  const sbuf = new ArrayBuffer(18), sv = new DataView(sbuf)
  function sendState(force) {
    const P = city.player
    if (!ws || ws.readyState !== 1 || !me.id || ws.bufferedAmount > 32e3) return
    const mode = P ? (P.mode === 'foot' ? 2 : 1) : 0
    const now = performance.now()
    const cur = P ? [mode, P.x, P.y, P.z, P.heading, P.speed] : [0, 0, 0, 0, 0, 0]
    const same = lastSent && cur.every((v, i) => Math.abs(v - lastSent[i]) < (i === 4 ? 0.01 : 0.05))
    if (!force && same && now - lastSentAt < 1000) return // standing still: once a second keeps me there
    sv.setUint8(0, 1); sv.setUint8(1, mode)
    sv.setFloat32(2, cur[1], true); sv.setFloat32(6, cur[2], true); sv.setFloat32(10, cur[3], true)
    sv.setInt16(14, Math.round(wrap(cur[4] || 0) * 1e4), true)
    sv.setInt16(16, Math.round(Math.max(-320, Math.min(320, cur[5] || 0)) * 100), true)
    ws.send(sbuf)
    lastSent = cur; lastSentAt = now
  }
  function onPlayer() {
    clearInterval(sendT)
    if (city.player) { sendState(true); sendT = setInterval(sendState, SEND_MS) }
    else { sendState(true); lastSent = null; for (const p of roster.values()) drop3d(p); render() }
    wakeMarks() // markers off while playing, back on after
  }
  const offPlayer = city.on('player', onPlayer)

  // ---------------------------------------------------------------- 3D: vans and people near me while I play
  const fallback = {
    van(colour) { // a simple low-poly van (forward -z), when the drive plugin's models aren't there
      const g = new THREE.Group(), M = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true })
      const box = (w, hh, l, m, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, l), m); b.position.set(0, y, z); g.add(b) }
      box(1.8, 1.5, 2.6, M(new THREE.Color(colour)), 1.35, 0.7); box(1.76, 1.25, 1.5, M(new THREE.Color(colour)), 1.2, -1.3)
      box(1.5, 0.6, 0.05, M(0x5d7f96), 1.55, -2.06); box(1.7, 0.4, 4.1, M(0xf6ead2), 0.62, 0)
      for (const [x, z] of [[-0.82, -1.35], [0.82, -1.35], [-0.82, 1.35], [0.82, 1.35]]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 8).rotateZ(Math.PI / 2), M(0x2b2e33)); w.position.set(x, 0.36, z); g.add(w) }
      return g
    },
    person(colour) {
      const g = new THREE.Group(), M = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true })
      const box = (w, hh, l, m, y) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, l), m); b.position.y = y; g.add(b) }
      box(0.36, 0.85, 0.22, M(0x3b4a5e), 0.45); box(0.44, 0.6, 0.26, M(new THREE.Color(colour)), 1.18); box(0.25, 0.27, 0.25, M(0xe2b48c), 1.64)
      g.update = () => {}
      return g
    },
  }
  function make(mode, colour) {
    const f = mode === 2 ? (city.models?.person || fallback.person) : (city.models?.van || fallback.van)
    let o
    try { o = f(colour) } catch (e) { console.warn('live: model', e); o = (mode === 2 ? fallback.person : fallback.van)(colour) }
    o.userData.mode = mode
    o.traverse((m) => { if (m.isMesh) m.castShadow = false })
    return o
  }
  function drop3d(p) {
    if (p.obj) { city.scene.remove(p.obj); p.obj.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); for (const mt of [].concat(m.material)) mt.dispose() } }); p.obj = null }
    p.tag?.remove(); p.tag = null; p.cur = null
    if (p.obstacle) { try { city.traffic?.setObstacle?.('mp:' + p.slot, null) } catch {} p.obstacle = false }
    city.requestRender()
  }
  function obstacle(p, st) {
    const T = city.traffic
    if (!T?.setObstacle) return
    try { T.setObstacle('mp:' + p.slot, { x: st.x, z: st.z, heading: st.h, length: st.mode === 2 ? 0.6 : 4.3, width: st.mode === 2 ? 0.6 : 1.8, speed: Math.abs(st.s) }); p.obstacle = true } catch (e) { console.warn('live: setObstacle', e) }
  }
  // where p is at time t (ms), between snapshots, a little extrapolated past the last one
  function sample(p, t) {
    const b = p.buf
    if (!b.length) return null
    let i = b.length - 1
    while (i > 0 && b[i].t > t) i--
    const a = b[i], c = b[i + 1]
    if (c && t >= a.t) {
      const f = (t - a.t) / (c.t - a.t || 1)
      return { x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f, z: a.z + (c.z - a.z) * f, h: a.h + wrap(c.h - a.h) * f, s: a.s + (c.s - a.s) * f, mode: c.mode }
    }
    const dt = Math.min(0.25, Math.max(0, (t - a.t) / 1000))
    return { x: a.x + Math.sin(a.h) * a.s * dt, y: a.y, z: a.z + Math.cos(a.h) * a.s * dt, h: a.h, s: a.s, mode: a.mode }
  }
  const layer = h('div', 'live-layer'); document.body.append(layer)
  const v3 = new THREE.Vector3()
  function project(x, y, z) { // CSS px, or null when behind the camera / off screen
    const cam = city.view.camera
    v3.set(x, y, z).project(cam)
    if (v3.z > 1 || v3.z < -1 || Math.abs(v3.x) > 1.2 || Math.abs(v3.y) > 1.2) return null
    return [(v3.x + 1) / 2 * innerWidth, (1 - v3.y) / 2 * innerHeight]
  }
  function say(p, text) {
    p.said = text; p.saidUntil = performance.now() + 6000
    if (p.tag) p.tag.firstChild.textContent = text
    if (p.mark) p.mark.title = `${p.name}: ${text}`
  }
  let anim = null, lastFrame = 0
  function wake3d() { if (!anim && city.player) { anim = city.animate(); lastFrame = performance.now() } }
  const offFrame = city.on('frame', () => {
    if (!anim) return
    const now = performance.now(), dt = Math.min(0.1, (now - lastFrame) / 1000), t = now - BEHIND
    lastFrame = now
    const P = city.player
    if (!P) { anim(); anim = null; return }
    // the nearest SHOW_3D players heard from in the last second
    const live = [...roster.values()].filter((p) => visible(p) && now - p.seen < 1000 && p.buf.length)
    for (const p of live) { p.cur = sample(p, t); p.d = Math.hypot(p.cur.x - P.x, p.cur.z - P.z) }
    live.sort((a, b) => a.d - b.d)
    const keep = new Set(live.slice(0, SHOW_3D))
    for (const p of roster.values()) if ((p.obj || p.tag) && !keep.has(p)) drop3d(p)
    for (const p of keep) {
      const c = p.cur
      if (p.obj && p.obj.userData.mode !== c.mode) { drop3d(p); p.cur = c }
      if (!p.obj) { p.obj = make(c.mode, p.colour); city.scene.add(p.obj) }
      p.obj.position.set(c.x, c.y, c.z)
      p.obj.rotation.set(0, c.h + Math.PI, 0) // the models face -z; heading 0 faces +z
      if (c.mode === 2) p.obj.update?.(dt, c.s)
      else for (const w of p.obj.userData.wheels || []) w.spin.rotation.x -= (c.s * dt) / 0.36
      // name tag (and what they last said) above them
      if (!p.tag) {
        p.tag = h('div', 'live-tag')
        const name = h('span', null, p.name); name.style.color = p.colour
        p.tag.append(h('span', 'say', p.saidUntil > now ? p.said : ''), name)
        layer.append(p.tag)
      }
      if (p.saidUntil && p.saidUntil < now) { p.saidUntil = 0; p.tag.firstChild.textContent = '' }
      const xy = p.d < TAG_RANGE && project(c.x, c.y + (c.mode === 2 ? 2.25 : 3.4), c.z)
      p.tag.hidden = !xy
      if (xy) p.tag.style.transform = `translate(${xy[0]}px, ${xy[1]}px) translate(-50%, -100%)`
    }
    if (!keep.size) { anim(); anim = null }
  })

  // ---------------------------------------------------------------- the map: a marker for everyone playing
  function coarseAt(p, now) {
    const c = p.c
    if (!c) return null
    const f = Math.min(1, (now - c.t) / COARSE_MS)
    return { x: c.x0 + (c.x1 - c.x0) * f, z: c.z0 + (c.z1 - c.z0) * f }
  }
  function dropMark(p) { p.mark?.remove(); p.mark = null }
  let raf = 0
  function wakeMarks() { if (!raf && !document.hidden) raf = requestAnimationFrame(marks) }
  function marks() {
    raf = 0
    const now = performance.now(), playing = !!city.player
    let any = false
    for (const p of roster.values()) {
      if (playing || !p.c || !visible(p)) { dropMark(p); continue }
      any = true
      const c = coarseAt(p, now), xy = project(c.x, city.world.heightAt(c.x, c.z) + 2, c.z)
      if (!xy) { if (p.mark) p.mark.hidden = true; continue }
      if (!p.mark) {
        p.mark = h('div', 'live-mark')
        const dot = h('i'); dot.style.background = p.colour
        p.mark.append(dot, h('span', null, p.name))
        p.mark.title = p.name
        p.mark.onclick = (e) => personMenu(p.id, p.name, e.clientX, e.clientY + 8)
        layer.append(p.mark)
      }
      p.mark.hidden = false
      p.mark.classList.toggle('foot', p.c.mode === 2)
      p.mark.style.transform = `translate(${xy[0] - 7}px, ${xy[1] - 7}px)`
    }
    if (any && !playing) raf = requestAnimationFrame(marks)
  }
  const offView = city.on('view', wakeMarks)

  // for the drive plugin: other players to collide with, like city.traffic.nearby
  city.multiplayer = {
    nearby(x, z, r) {
      const out = []
      for (const p of roster.values()) {
        const c = p.obj && p.cur
        if (c && Math.hypot(c.x - x, c.z - z) <= r) out.push({ id: 'mp:' + p.slot, x: c.x, y: c.y, z: c.z, heading: c.h, length: c.mode === 2 ? 0.6 : 4.3, width: c.mode === 2 ? 0.6 : 1.8, speed: c.s, name: p.name })
      }
      return out
    },
    get connected() { return connected },
  }

  connect()
  if (city.player) onPlayer()

  return {
    dispose() {
      disposed = true
      clearTimeout(retryT); clearTimeout(hiddenT); clearInterval(sendT); cancelAnimationFrame(raf)
      if (ws) { ws.onclose = null; ws.close() }
      for (const p of roster.values()) drop3d(p)
      anim?.()
      offPlayer(); offFrame(); offView()
      removeEventListener('keydown', onKey); removeEventListener('pointerdown', offMenu, true)
      document.removeEventListener('visibilitychange', onVisibility)
      for (const el of [css, statsEl, aboutEl, fab, panel, menu, layer]) el.remove()
      tool.remove()
      delete city.multiplayer
    },
  }
}
