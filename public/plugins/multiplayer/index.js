// Live: visitor counts, other people exploring the streets with you, and a chat.
// Talks to the Rust service in /server over one WebSocket (same origin, /live/ws; for local development
// ?live=ws://127.0.0.1:48501/live/ws). Every visitor opens it, which is how "online now" is counted; it idles
// cheaply and closes after 5 minutes in a hidden tab. While you drive or walk (city.player, from the drive plugin),
// your position goes out 10 times a second and people within 1.5 km come back the same way; everyone playing
// shows on the map as a small marker. Blocking someone hides their van, marker and chat lines everywhere, and the
// server stops sending them to you (and you to them). Chat is plain text, always set with textContent.
// Identity: the server gives this browser a UUID (kept as a signed token in localStorage) and a placeholder name
// ("Heron 44") until you choose a username, which is unique (look-alike letters count as the same) and can change
// once a minute. Chosen names are unique, so they show without a tag; placeholders can repeat, so they keep a
// short #tag from the UUID. Protocol: see server/src/world.rs. No third-party data; positions are what players send.

const PALETTE = ['#f2a07e', '#7fc4e8', '#9ad77a', '#f5d06f', '#c59af0', '#f08fb0', '#6fd6c8', '#ff8c5a']
const ANIMALS = ['Otter', 'Heron', 'Orca', 'Raven', 'Seal', 'Salmon', 'Eagle', 'Beaver', 'Cedar', 'Crab', 'Puffin', 'Fern', 'Moose', 'Loon', 'Marmot', 'Hummingbird']
const SEND_MS = 100 // 10 Hz while playing
const BEHIND = 130 // ms: remote players are drawn this far in the past, between two snapshots
const COARSE_MS = 2000 // the map list comes every 2 s
const SHOW_3D = 32 // at most this many remote vans/people drawn
const TAG_RANGE = 260 // metres: name tags beyond this are hidden
const HIDDEN_CLOSE_MS = 5 * 60e3
const LINES = 150 // kept per chat channel
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PLACEHOLDER = new RegExp(`^(${ANIMALS.join('|')}) \\d\\d$`)
const WHY = { // the server's answer to a username check
  ok: 'Available', yours: 'That’s your name', taken: 'Taken: someone has that name (or one that looks just like it)',
  invalid: 'Letters, digits, spaces and - _ . ’ only', short: 'At least 3 characters', long: 'At most 20 characters', reserved: 'That name is reserved',
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('live.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { if (v === undefined) localStorage.removeItem('live.' + k); else localStorage.setItem('live.' + k, JSON.stringify(v)) } catch {} },
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const fmt = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const tagOf = (id) => `#${String(id || '').slice(0, 4)}`

export default function multiplayer(city) {
  const { THREE } = city
  const qs = new URLSearchParams(location.search)
  const dev = qs.get('live')
  const URL_WS = dev && /^wss?:\/\//.test(dev) ? dev : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live/ws`
  const compact = () => document.documentElement.classList.contains('compact')

  // ================================================================ who I am (the server says; the colour is kept here)
  const me = { slot: 0, id: null, name: '', chosen: false, colour: store.get('colour', '') || pick(PALETTE) }
  // a name typed before usernames existed: offered when choosing one
  const oldName = (() => { const n = store.get('name', ''); return typeof n === 'string' && !PLACEHOLDER.test(n) ? n : '' })()
  // ids from before UUIDs were moved to UUIDs on the server, which sends the list back in its welcome
  const blocked = new Map(store.get('blocked', []).filter((b) => UUID.test(b.id)).map((b) => [b.id, b.name])) // id → name
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
    .live-chat { right: 12px; top: 58px; z-index: 26; width: min(340px, calc(100% - 24px)); height: min(500px, calc(100% - 150px)); display: flex; flex-direction: column; box-sizing: border-box; padding: 10px 12px 12px; }
    body.dlv-on .live-chat { top: 104px; height: min(440px, calc(100% - 300px)); }
    .live-chat[hidden], .live-view[hidden] { display: none }
    .live-chat > .sheet-x { display: grid; place-items: center; position: absolute; right: 4px; top: 4px; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 7px; background: none; color: var(--muted); font: 20px/1 system-ui, sans-serif; cursor: pointer; }
    .live-chat > .sheet-x:hover { background: rgba(255, 255, 255, .1) }
    .live-view { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
    .live-head { display: flex; align-items: center; gap: 4px; margin: 0 36px 8px 0; }
    .live-chat button { font: inherit; color: var(--text); background: none; border: 0; border-radius: 7px; padding: 4px 9px; cursor: pointer; }
    .live-chat button:hover, .live-head button[aria-selected="true"] { background: rgba(255, 255, 255, .1) }
    .live-head button[data-new]::after { content: ''; display: inline-block; width: 6px; height: 6px; margin-left: 5px; border-radius: 50%; background: #e8735a; vertical-align: 2px; }
    .live-chip { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; max-width: 46%; min-width: 0; }
    .live-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .live-chip.guest span { color: var(--muted); font-style: italic }
    .live-chip i { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px rgba(255, 255, 255, .25); }
    .live-lines { flex: 1 1 auto; min-height: 90px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; padding-right: 2px; overscroll-behavior: contain; }
    .live-line { overflow-wrap: anywhere; color: var(--text); line-height: 1.4; user-select: text; -webkit-user-select: text; }
    .live-chat .live-who { font: inherit; font-weight: 650; padding: 0; margin-right: 6px; border-radius: 3px; position: relative; }
    .compact .live-chat .live-who::after { content: ''; position: absolute; inset: -11px -6px; } /* a 44 px tall touch target */
    .live-chat .live-who:hover { background: none; text-decoration: underline; }
    .live-who.me { cursor: default }
    .live-who small, .live-mark small, .live-menu small { font-weight: 400; color: var(--muted); margin-left: 3px; font-size: 10.5px; }
    .live-empty { color: var(--muted); margin: auto 0; text-align: center; padding: 14px 4px; }
    .live-form { display: flex; gap: 6px; margin-top: 8px; }
    .live-chat input[type=text] { flex: 1; min-width: 0; font: inherit; color: var(--text); background: rgba(255, 255, 255, .07); border: 1px solid var(--line); border-radius: 8px; padding: 6px 9px; outline: none; }
    .live-chat input[type=text]:focus { border-color: var(--accent) }
    .live-chat .live-send { color: #0b1016; background: var(--accent); border-radius: 8px; padding: 0 12px; font-weight: 600; }
    .live-chat .live-send:hover { background: #a3d6f0 }
    .live-chat .live-send:disabled { opacity: .45; cursor: default; background: var(--accent) }
    .live-status { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .live-status.err { color: #f0b37e }
    .live-status:empty { display: none }
    /* the profile: username, colour, id, blocked people */
    .live-profile { overflow-y: auto; overscroll-behavior: contain; padding-right: 2px; }
    .live-profile h3 { margin: 4px 36px 4px 0; font-size: 16px; font-weight: 650; }
    .live-profile h4 { margin: 14px 0 6px; font-size: 10.5px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
    .live-profile p { margin: 0 0 8px; color: var(--muted); }
    .live-profile .back { align-self: flex-start; margin: -2px 0 4px -6px; color: var(--muted); }
    .live-check { min-height: 18px; margin-top: 5px; font-size: 12px; color: var(--muted); }
    .live-check.ok { color: #8fd8a0 } .live-check.bad { color: #f0b37e }
    .live-swatches { display: flex; flex-wrap: wrap; gap: 2px; }
    .live-chat .live-swatches button { width: 36px; height: 36px; padding: 0; display: grid; place-items: center; border-radius: 50%; }
    .live-swatches i { width: 24px; height: 24px; border-radius: 50%; box-sizing: border-box; border: 2px solid transparent; }
    .live-swatches button[aria-checked="true"] i { border-color: #fff; box-shadow: 0 0 0 2px rgba(0, 0, 0, .4) inset; }
    .live-id { display: flex; align-items: center; gap: 6px; }
    .live-id code { flex: 1; min-width: 0; font: 11.5px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); overflow-wrap: anywhere; user-select: all; -webkit-user-select: all; }
    .live-chat .live-ghost { border: 1px solid var(--line); background: rgba(255, 255, 255, .05); }
    .live-blocked .row { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--text); }
    .live-blocked .row span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .live-actions { display: flex; gap: 8px; margin-top: 14px; }
    .live-actions button { flex: 1; }
    .live-actions[hidden] { display: none }
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
    /* phones: the chat is a full-height sheet that stays above the on-screen keyboard (--vv-*, index.html) */
    .compact .live-stats { margin: 0 2px } .compact .live-stats .more { display: none }
    .compact .live-chat { left: 0; right: 0; width: auto; top: calc(var(--vv-top) + var(--st) + 4px); height: calc(var(--vv-h) - var(--st) - 4px); max-height: none; z-index: 28;
      border-radius: 16px 16px 0 0; border-width: 1px 0 0; background: rgba(13, 19, 26, .94); font-size: 14px;
      padding: 26px max(14px, env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); animation: sheet-in .22s ease-out; }
    .compact.kb .live-chat { padding-top: 6px; padding-bottom: 8px; border-radius: 0; } /* typing: every pixel above the keyboard counts */
    .compact.kb .live-chat > .sheet-grip { display: none } .compact.kb .live-lines { min-height: 0 } .compact.kb .live-head { margin-bottom: 4px }
    /* (beats body.dlv-on .live-chat) */ .compact body.dlv-on .live-chat { top: calc(var(--vv-top) + var(--st) + 4px); height: calc(var(--vv-h) - var(--st) - 4px); }
    .compact .live-chat > .sheet-x { right: max(4px, env(safe-area-inset-right)); top: 2px; width: 44px; height: 44px; font-size: 22px; }
    .compact .live-head { margin-right: 44px; }
    .compact .live-chat button { min-height: 44px; padding: 0 12px; }
    .compact .live-chat .live-who { min-height: 0; padding: 2px 0; }
    .compact .live-swatches { display: grid; grid-template-columns: repeat(4, 52px); gap: 2px; }
    .compact .live-chat .live-swatches button { width: 52px; height: 44px; padding: 0; }
    .compact .live-chat .live-swatches i { width: 28px; height: 28px; }
    .compact .live-chat input[type=text] { min-height: 44px; padding: 0 12px; }
    .compact .live-chip { max-width: 40%; padding: 0 10px; }
    .compact .live-lines { gap: 5px; }
    .compact .live-menu { left: 8px !important; right: 8px; top: auto !important; bottom: calc(var(--sb)); padding: 8px; border-radius: 14px; z-index: 41; }
    .compact .live-menu button { min-height: 48px; font-size: 15px; padding: 0 12px; }
    .compact .live-menu .t { font-size: 13px; padding: 4px 12px 6px; }
    .compact .live-fab { top: var(--st); right: calc(var(--sr) + 84px); width: 44px; height: 44px; padding: 0; font-size: 19px; border-radius: 12px; }
    .compact .live-fab .lb { display: none; }
    .compact .live-fab .live-badge { position: absolute; top: -4px; right: -4px; margin: 0; }`
  document.head.append(css)
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  const btn = (cls, text, title) => { const b = h('button', cls, text); b.type = 'button'; if (title) { b.title = title; b.setAttribute('aria-label', title) } return b }

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
  const fab = btn('panel live-fab', null, 'Chat (Enter)')
  fab.append(h('span', null, '💬'), h('span', 'lb', ' Chat'))
  const fabBadge = h('span', 'live-badge'); fabBadge.hidden = true; fab.append(fabBadge)
  fab.onclick = () => toggleChat()
  document.body.append(fab)

  const panel = h('div', 'panel live-chat'); panel.hidden = true
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Chat')
  // view 1: the chat
  const chatView = h('div', 'live-view')
  const head = h('div', 'live-head'); head.setAttribute('role', 'tablist')
  const tabs = { g: btn(null, 'Everyone', 'Everyone on the map'), n: btn(null, 'Nearby', 'People within 1.5 km of you') }
  for (const t of Object.values(tabs)) t.setAttribute('role', 'tab')
  const chip = btn('live-chip', null, 'Your name, colour and blocked people')
  const chipDot = h('i'), chipName = h('span')
  chip.append(chipDot, chipName)
  head.append(tabs.g, tabs.n, chip)
  const linesEl = h('div', 'live-lines'); linesEl.setAttribute('aria-live', 'polite')
  const form = h('form', 'live-form')
  const input = h('input'); input.type = 'text'; input.maxLength = 200; input.placeholder = 'Say something…'; input.autocomplete = 'off'; input.enterKeyHint = 'send'; input.setAttribute('aria-label', 'Message')
  const send = h('button', 'live-send', 'Send'); send.type = 'submit'
  form.append(input, send)
  const status = h('div', 'live-status'); status.setAttribute('role', 'status')
  chatView.append(head, linesEl, form, status)
  // view 2: the profile (also the "choose your username" prompt)
  const prof = h('div', 'live-view live-profile'); prof.hidden = true
  const back = btn('back', '‹ Chat', 'Back to the chat')
  const pTitle = h('h3'), pIntro = h('p')
  const nameForm = h('form', 'live-form')
  const nameIn = h('input'); nameIn.type = 'text'; nameIn.maxLength = 20; nameIn.autocomplete = 'off'; nameIn.spellcheck = false; nameIn.setAttribute('autocapitalize', 'words'); nameIn.enterKeyHint = 'done'
  // not a login form: no password-manager popups (1Password, LastPass, Bitwarden, Dashlane)
  const noManagers = (el, name) => { el.name = name; for (const a of ['data-1p-ignore', 'data-lpignore', 'data-bwignore']) el.setAttribute(a, 'true'); el.setAttribute('data-form-type', 'other') }
  noManagers(nameIn, 'chat-display-name'); noManagers(input, 'chat-message')
  nameIn.placeholder = 'Your username'; nameIn.setAttribute('aria-label', 'Username'); nameIn.setAttribute('aria-describedby', 'live-check')
  const save = h('button', 'live-send', 'Save'); save.type = 'submit'
  nameForm.append(nameIn, save)
  const checkEl = h('div', 'live-check'); checkEl.id = 'live-check'; checkEl.setAttribute('aria-live', 'polite')
  const swatches = h('div', 'live-swatches'); swatches.setAttribute('role', 'radiogroup'); swatches.setAttribute('aria-label', 'Your colour')
  for (const c of PALETTE) {
    const b = btn(null, null, `Colour ${c}`); b.setAttribute('role', 'radio'); b.dataset.c = c
    const dot = h('i'); dot.style.background = c; b.append(dot)
    b.onclick = () => { if (c !== me.colour) out({ t: 'name', colour: c }) }
    swatches.append(b)
  }
  const idRow = h('div', 'live-id'), idCode = h('code'), copy = btn('live-ghost', 'Copy', 'Copy your ID')
  idRow.append(idCode, copy)
  const blockedEl = h('div', 'live-blocked')
  const actions = h('div', 'live-actions'), later = btn('live-ghost', 'Later', 'Choose a name later')
  actions.append(later)
  prof.append(back, pTitle, pIntro, nameForm, checkEl, h('h4', null, 'Colour'), swatches, h('h4', null, 'Your ID'), idRow,
    h('p', null, 'This browser’s ID on the server (a random UUID). Your name and blocks are kept under it.'), blockedEl, actions)
  panel.append(chatView, prof)
  document.body.append(panel)
  city.ui.sheet?.(panel, () => toggleChat(false))
  city.ui.onCloseAll?.(() => { if (!panel.hidden) toggleChat(false) })

  let tab = 'g', unread = 0, statusT = 0, prompt = null // prompt: why the username prompt is open ('chat' | 'play')
  const lines = { g: [], n: [] }
  const tell = (t) => (panel.hidden ? city.ui.toast(t) : setStatus(t)) // a toast would cover the open sheet
  function setStatus(t, err) { status.textContent = t; status.classList.toggle('err', !!err); clearTimeout(statusT); if (t) statusT = setTimeout(() => (status.textContent = ''), 4500) }
  function setUnread(n) { unread = n; for (const b of [badge, fabBadge]) { b.textContent = n > 9 ? '9+' : String(n); b.hidden = !n } }
  const asked = () => store.get('asked', false)
  function toggleChat(open = panel.hidden, view) {
    if (open && panel.hidden) city.ui.closeAll?.() // one panel at a time, like the other toolbar panels
    panel.hidden = !open
    tool.button.setAttribute('aria-pressed', String(open))
    menu.hidden = true
    if (!open) { input.blur(); nameIn.blur(); prompt = null; return }
    // the first time: choose a username first (or later)
    if (!view && !me.chosen && !asked() && me.id) { view = 'profile'; prompt = 'chat' }
    showView(view || 'chat')
  }
  function showView(v) {
    const p = v === 'profile'
    chatView.hidden = p; prof.hidden = !p
    panel.setAttribute('aria-label', p ? 'Your profile' : 'Chat')
    if (p) {
      if (prompt) store.set('asked', true)
      pTitle.textContent = me.chosen ? 'Your profile' : 'Choose your username'
      pIntro.textContent = me.chosen ? 'Your name shows in the chat and above your van. You can change it once a minute.'
        : `People see you as “${me.name}” for now. Pick a name of your own: it shows in the chat and above your van, and no one else can use it.`
      back.hidden = !!prompt; actions.hidden = !prompt
      nameIn.value = me.chosen ? me.name : nameIn.value || oldName
      onNameInput()
      paintMe(); renderBlocked()
      if (!matchMedia('(pointer: coarse)').matches) nameIn.focus()
    } else {
      setUnread(0); render()
      if (!matchMedia('(pointer: coarse)').matches) input.focus()
    }
  }
  function endPrompt() { const why = prompt; prompt = null; if (why === 'play') toggleChat(false); else showView('chat') }
  document.getElementById('tools')?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b !== tool.button) toggleChat(false) })
  chip.onclick = () => showView('profile')
  back.onclick = () => showView('chat')
  later.onclick = endPrompt
  for (const k of ['g', 'n']) tabs[k].onclick = () => { tab = k; delete tabs[k].dataset.new; render(); if (!matchMedia('(pointer: coarse)').matches) input.focus() }
  // keys typed here are for the chat, not for the van
  for (const el of [input, nameIn]) el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { el === input ? toggleChat(false) : prompt ? endPrompt() : showView('chat') } })
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

  // ---------------------------------------------------------------- choosing a username, checked as you type
  let checkT = 0, checked = null, saving = false // checked: { name, why } of the current input
  function setCheck(text, kind) { checkEl.textContent = text; checkEl.className = `live-check ${kind || ''}` }
  function onNameInput() {
    clearTimeout(checkT)
    const v = nameIn.value.trim().replace(/\s+/g, ' ')
    checked = null; save.disabled = true
    if (!v) return setCheck(me.chosen ? '' : '3 to 20 letters or digits; spaces and - _ . ’ are fine too.')
    if (me.chosen && v === me.name) return setCheck('That’s your name', 'ok')
    if ([...v].length < 3) return setCheck(WHY.short, 'bad')
    if ([...v].length > 20) return setCheck(WHY.long, 'bad')
    if (/[^\p{L}\p{N}\p{M} '._-]/u.test(v)) return setCheck(WHY.invalid, 'bad')
    setCheck('Checking…')
    checkT = setTimeout(() => out({ t: 'check', name: v }), 300)
  }
  nameIn.addEventListener('input', onNameInput)
  function onCheck(m) {
    const v = nameIn.value.trim().replace(/\s+/g, ' ')
    if (m.name !== v) return // an answer for an older value
    checked = m
    const ok = m.why === 'ok' || (m.why === 'yours' && v !== me.name)
    save.disabled = !ok
    setCheck(ok ? `✓ ${WHY.ok}` : WHY[m.why] || 'Not allowed', ok ? 'ok' : m.why === 'yours' ? 'ok' : 'bad')
  }
  nameForm.onsubmit = (e) => {
    e.preventDefault()
    const v = nameIn.value.trim().replace(/\s+/g, ' ')
    if (!v || save.disabled || (me.chosen && v === me.name)) return
    saving = true; save.disabled = true; setCheck('Saving…')
    out({ t: 'name', name: v })
  }
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(me.id); copy.textContent = 'Copied' } catch { getSelection()?.selectAllChildren(idCode); copy.textContent = 'Selected' }
    setTimeout(() => (copy.textContent = 'Copy'), 1600)
  }
  function paintMe() {
    chipDot.style.background = me.colour
    chipName.textContent = me.chosen ? me.name : 'Choose a name'
    chip.classList.toggle('guest', !me.chosen)
    for (const b of swatches.children) b.setAttribute('aria-checked', String(b.dataset.c === me.colour))
    idCode.textContent = me.id || ''
  }
  // the prompt also comes up the first time someone starts driving or walking (once the dive is over)
  let askT = 0
  function askOnPlay() {
    clearTimeout(askT)
    if (!city.player || me.chosen || asked()) return
    askT = setTimeout(() => { if (city.player && connected && !me.chosen && !asked() && panel.hidden) { prompt = 'play'; toggleChat(true, 'profile') } }, 3000)
  }

  // a small menu for a person: block / unblock (a sheet at the bottom on phones)
  const menu = h('div', 'panel live-menu'); menu.hidden = true; menu.setAttribute('role', 'menu')
  document.body.append(menu)
  const label = (name, id, chosen) => { const s = h('span', null, name); if (!chosen) s.append(h('small', null, tagOf(id))); return s }
  function personMenu(id, name, chosen, x, y) {
    if (!id || id === me.id) return
    const t = h('div', 't'); t.append(label(name, id, chosen))
    menu.replaceChildren(t)
    const isB = blocked.has(id)
    const b = btn(null, isB ? `Unblock ${name}` : `Block ${name}`)
    b.onclick = () => { menu.hidden = true; isB ? unblock(id) : block(id, name) }
    const c = btn(null, 'Cancel'); c.onclick = () => (menu.hidden = true)
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
    const who = btn('live-who' + (l.id === me.id ? ' me' : ''))
    who.append(label(l.name, l.id, l.chosen)); who.style.color = l.colour
    if (l.id !== me.id) { who.title = `${l.name}: block or unblock`; who.onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); personMenu(l.id, l.name, l.chosen, r.left, r.bottom + 4) } }
    d.append(who, h('span', null, l.text))
    return d
  }
  function render() {
    for (const k of ['g', 'n']) tabs[k].setAttribute('aria-selected', String(tab === k))
    if (panel.hidden || chatView.hidden) return
    const shown = lines[tab].filter((l) => !blocked.has(l.id))
    linesEl.replaceChildren(...shown.map(lineEl))
    if (!shown.length) linesEl.append(h('div', 'live-empty', tab === 'n' ? (city.player ? 'Nobody nearby has said anything yet.' : 'Drive or walk around to talk to people near you.') : 'No messages yet. Say hi!'))
    linesEl.scrollTop = linesEl.scrollHeight
  }
  function renderBlocked() {
    blockedEl.hidden = !blocked.size
    blockedEl.replaceChildren(h('h4', null, `Blocked people (${blocked.size})`))
    for (const [id, name] of blocked) {
      const row = h('div', 'row'), b = btn('live-ghost', 'Unblock', `Unblock ${name || 'them'}`)
      b.onclick = () => unblock(id)
      row.append(h('span', null, name || `Someone ${tagOf(id)}`), b)
      blockedEl.append(row)
    }
  }
  function addLine(l) {
    const list = lines[l.ch === 'n' ? 'n' : 'g']
    list.push(l); if (list.length > LINES) list.shift()
    if (blocked.has(l.id)) return
    const p = [...roster.values()].find((r) => r.id === l.id)
    if (p) say(p, l.text)
    if (!panel.hidden && !chatView.hidden && tab === (l.ch === 'n' ? 'n' : 'g')) {
      linesEl.querySelector('.live-empty')?.remove()
      const atEnd = linesEl.scrollHeight - linesEl.scrollTop - linesEl.clientHeight < 40
      linesEl.append(lineEl(l))
      while (linesEl.children.length > LINES) linesEl.firstChild.remove()
      if (atEnd || l.id === me.id) linesEl.scrollTop = linesEl.scrollHeight
    } else if (l.id !== me.id) {
      if (panel.hidden || chatView.hidden) setUnread(unread + 1)
      else tabs[l.ch === 'n' ? 'n' : 'g'].dataset.new = '1' // open on the other tab: a dot on this one
    }
  }

  // ================================================================ blocking (here and on the server)
  function block(id, name) {
    blocked.set(id, name); saveBlocked()
    out({ t: 'block', id })
    for (const p of roster.values()) if (p.id === id) { drop3d(p); dropMark(p) }
    render(); renderBlocked()
    tell(`${name} is blocked: you won't see them or their messages.`)
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
    try { ws = new WebSocket(URL_WS) } catch { return later_() }
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => { // a token from before usernames brings the name this browser had, which the server gives back
      const token = store.get('token', undefined), legacy = /^[0-9a-f]{16}\./.test(token || '')
      out({ t: 'hello', token, colour: me.colour, name: legacy && oldName ? oldName : undefined })
    }
    ws.onmessage = (e) => { try { typeof e.data === 'string' ? onText(JSON.parse(e.data)) : onBinary(new DataView(e.data)) } catch (err) { console.warn('live: bad message', err) } }
    ws.onclose = () => { ws = null; setConnected(false); later_() }
  }
  function later_() { // back off: 2, 4, 8 … 60 s; not while the tab is hidden
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

  function you(m) {
    const was = me.chosen ? me.name : null
    Object.assign(me, { name: m.name, chosen: !!m.chosen, colour: m.colour })
    store.set('colour', m.colour)
    if (me.chosen) store.set('name', undefined) // the old free-form name is not needed any more
    paintMe()
    if (saving) {
      saving = false
      const msg = was === me.name ? '' : was ? `You’re ${me.name} now.` : `Hi ${me.name}! That name is yours.`
      if (prompt) { endPrompt(); if (msg) tell(msg) } else { pTitle.textContent = 'Your profile'; onNameInput(); if (msg) setCheck(`✓ ${msg}`, 'ok') }
    }
  }
  function onText(m) {
    switch (m.t) {
      case 'welcome': {
        Object.assign(me, { slot: m.s, id: m.id })
        store.set('token', m.token)
        you(m)
        retry = 0
        // blocks: the server's and this browser's, together
        for (const id of m.blocks) if (!blocked.has(id)) blocked.set(id, '')
        for (const id of blocked.keys()) if (!m.blocks.includes(id)) out({ t: 'block', id })
        saveBlocked()
        for (const p of m.players) join(p)
        lines.g = m.chat.map((l) => ({ ...l, ch: 'g' }))
        for (const l of m.chat) if (blocked.get(l.id) === '') blocked.set(l.id, l.name)
        setConnected(true); showStats(m.stats); render()
        if (city.player) { sendState(true); askOnPlay() }
        break
      }
      case 'join': join(m); break
      case 'leave': { const p = roster.get(m.s); if (p) { drop3d(p); dropMark(p); roster.delete(m.s) } break }
      case 'chat': addLine(m); break
      case 'you': you(m); break
      case 'check': onCheck(m); break
      case 'stats': showStats(m.stats); break
      case 'error':
        if (m.about === 'name') { saving = false; save.disabled = m.why !== 'wait'; setCheck(m.msg, 'bad'); if (prof.hidden) setStatus(m.msg, true) }
        else setStatus(m.msg, true)
        paintMe(); break
    }
  }


  // ================================================================ other players
  const roster = new Map() // slot → { slot, id, name, colour, buf: [{t, x, y, z, h, s, mode}], obj, tag, mark, … }
  function join(m) {
    if (m.s === me.slot) return
    let p = roster.get(m.s)
    if (!p) roster.set(m.s, (p = { slot: m.s, buf: [], seen: 0 }))
    if (p.colour && p.colour !== m.colour) drop3d(p)
    Object.assign(p, { id: m.id, name: m.name, chosen: !!m.chosen, colour: m.colour })
    if (p.tag) p.tag.lastChild.replaceWith(tagName(p))
    if (p.mark) p.mark.lastChild.replaceWith(label(p.name, p.id, p.chosen))
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
    if (city.player) { sendState(true); sendT = setInterval(sendState, SEND_MS); askOnPlay() }
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
  const tagName = (p) => { const s = label(p.name, p.id, p.chosen); s.style.color = p.colour; return s }
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
        p.tag.append(h('span', 'say', p.saidUntil > now ? p.said : ''), tagName(p))
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
        p.mark.append(dot, label(p.name, p.id, p.chosen))
        p.mark.title = p.name
        p.mark.onclick = (e) => personMenu(p.id, p.name, p.chosen, e.clientX, e.clientY + 8)
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
      clearTimeout(retryT); clearTimeout(hiddenT); clearInterval(sendT); clearTimeout(checkT); clearTimeout(askT); cancelAnimationFrame(raf)
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
