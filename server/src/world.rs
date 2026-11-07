//! Everyone connected, what they may send and who sees what. No sockets here: each client is a
//! channel of `Out` messages, so the rules are tested without a network.
//!
//! Protocol (WebSocket, same origin, `/live/ws`). Positions are binary because they are nearly all
//! of the traffic (10 Hz per player, to every player nearby): a state is 18 bytes and a snapshot
//! entry 21, against ~90 bytes as JSON. Everything rare (hello, chat, blocks, roster) is small JSON.
//!
//! Identity: every browser is a UUID v4, kept as a signed token in its localStorage (`uuid.hmac`). Ids from
//! before UUIDs (16 hex digits) are still accepted and become a UUID derived from them (`legacy_uuid`), and
//! their blocks were moved over when the server started. A user has a placeholder name ("Heron 44", made from
//! the UUID, `chosen: false`, not unique) until they choose a username (unique, see text::name_key; kept in
//! SQLite; changeable once a minute, the old name is free again at once). Someone from before usernames gets
//! the name their browser had back when they reconnect (first come, first served; HOLD names only that way).
//!
//! client → server
//!   text   {"t":"hello","token"?,"colour","name"?}       first message, within 10 s; name only counts with a
//!                                                          token from before UUIDs: the name that browser had
//!   text   {"t":"name","name"?,"colour"?}                choose a username and/or a colour
//!   text   {"t":"check","name"}                          is this username free? (debounce it: ≤ 4/s)
//!   text   {"t":"chat","ch":"g"|"n","text"}              global, or players within 1.5 km
//!   text   {"t":"block","id"} / {"t":"unblock","id"}
//!   binary [1][mode u8: 0 stopped, 1 car, 2 foot, 3 boat][x f32][y f32][z f32][heading i16 ×1e4][speed i16 ×100]   ≤ 10 Hz while playing
//! server → client
//!   text   {"t":"welcome","s","id","token","name","chosen","colour","blocks":[id],"players":[{s,id,name,chosen,colour}],"chat":[…],"stats"}
//!   text   {"t":"join","s","id","name","chosen","colour"} / {"t":"leave","s"}   players starting / stopping (or renamed)
//!   text   {"t":"chat","ch","id","name","chosen","colour","text","ts"} / {"t":"you","name","chosen","colour"} / {"t":"stats",…}
//!   text   {"t":"check","name","why":"ok"|"yours"|"taken"|"invalid"|"short"|"long"|"reserved"}   the answer to a check
//!   text   {"t":"error","msg","about"?:"name","why"?,"wait"?}   (a refused username: why as above, or "wait" seconds)
//!   binary [1][n u16] n × [slot u32][x f32][y f32][z f32][heading i16][speed i16][mode u8]   10 Hz: players within 1.5 km, nearest 256
//!   binary [2][n u16] n × [slot u32][x f32][z f32][mode u8]                                  every 2 s: every player, for the map
//! All numbers little-endian; x east, z south, y up, metres (three.js world of the page).
use crate::db::{Claim, Db, Stats};
use crate::text::{clean_colour, clean_text, name_key, username};
use axum::body::Bytes;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{self, error::TrySendError};

pub const TICK: Duration = Duration::from_millis(100);
pub const NEAR: f32 = 1500.0; // metres: players this close get each other's positions 10 times a second
const MAX_NEAR: usize = 256; // live positions for the nearest this many; everyone else still shows on the map (2 s list)
const COARSE_TICKS: u64 = 20; // the map list every 2 s
const STATS_TICKS: u64 = 300; // visitor counts every 30 s, or every 5 s while the number online changes
const STALE: Duration = Duration::from_secs(10); // a player silent this long has stopped
const HELLO_WITHIN: Duration = Duration::from_secs(10);
const HISTORY: usize = 30; // global lines a newcomer gets
pub const CHAT_MAX: usize = 200; // characters
const MAX_BLOCKS: usize = 1000;
const MAX_TOTAL: usize = 60_000; // connections (abuse guard only; the map list counts in u16)
/// The map's extent with a few km to spare (the Lower Mainland: lat 48.99–49.48, lon -123.33 to -122.40)
pub const EXTENT: [f32; 6] = [-19_500.0, 55_000.0, -25_000.0, 36_000.0, -100.0, 2_500.0]; // x0 x1 z0 z1 y0 y1

/// A message for one client's socket.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Text(String),
    Bin(Bytes),
    Ping,
    Close(u16, &'static str),
}

/// Why a client is disconnected.
pub type Kick = &'static str;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct State {
    pub mode: u8,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub heading: f32,
    pub speed: f32,
}

/// Parses a binary state message; None when malformed.
pub fn parse_state(b: &[u8]) -> Option<State> {
    if b.len() != 18 || b[0] != 1 || b[1] > 3 {
        return None;
    }
    let f = |i: usize| f32::from_le_bytes(b[i..i + 4].try_into().unwrap());
    let h = |i: usize| i16::from_le_bytes([b[i], b[i + 1]]) as f32;
    let s = State { mode: b[1], x: f(2), y: f(6), z: f(10), heading: h(14) / 1e4, speed: h(16) / 100.0 };
    (s.x.is_finite() && s.y.is_finite() && s.z.is_finite()).then_some(s)
}

/// Encodes a state the way the client sends it (used by tests and the load script's twin).
pub fn encode_state(s: &State) -> Vec<u8> {
    let mut b = vec![1, s.mode];
    for v in [s.x, s.y, s.z] {
        b.extend(v.to_le_bytes());
    }
    b.extend(((s.heading * 1e4).round() as i16).to_le_bytes());
    b.extend(((s.speed * 100.0).round() as i16).to_le_bytes());
    b
}

/// A token bucket: `rate` per second, up to `burst` at once.
#[derive(Clone, Copy, Debug)]
pub struct Bucket {
    tokens: f32,
    rate: f32,
    burst: f32,
    at: Instant,
}

impl Bucket {
    pub fn new(rate: f32, burst: f32, now: Instant) -> Bucket {
        Bucket { tokens: burst, rate, burst, at: now }
    }
    pub fn take(&mut self, now: Instant) -> bool {
        self.tokens = (self.tokens + now.saturating_duration_since(self.at).as_secs_f32() * self.rate).min(self.burst);
        self.at = now;
        let ok = self.tokens >= 1.0;
        if ok {
            self.tokens -= 1.0;
        }
        ok
    }
}

pub struct Client {
    pub slot: u32,
    tx: mpsc::Sender<Out>,
    pub kill: Arc<AtomicBool>,
    ip: u64,
    since: Instant,
    pub id: Option<String>, // set by hello: a UUID
    pub name: String,
    pub chosen: bool, // the name is a username they chose (else a placeholder)
    colour: String,
    pub blocks: HashSet<String>,
    pub state: Option<State>,
    state_at: Instant,
    last_n: usize, // players in the last snapshot sent
    msgs: Bucket,
    states: Bucket,
    chats: Bucket,
    names: Bucket,
    checks: Bucket,
    blocking: Bucket,
    teleports: Bucket,
    strikes: u32,
    strikes_at: Instant,
    last_chat: Option<(String, Instant)>,
}

impl Client {
    fn send(&self, o: Out) {
        let lossy = matches!(o, Out::Bin(_));
        if let Err(TrySendError::Full(_)) = self.tx.try_send(o)
            && !lossy
        {
            self.kill.store(true, Ordering::Relaxed); // can't keep up even with the rare messages: let it reconnect
        }
    }
    fn json(&self, v: &Value) {
        self.send(Out::Text(v.to_string()));
    }
}

/// Whether a and b must not see each other (either blocked the other).
fn hidden(a: &Client, b: &Client) -> bool {
    match (&a.id, &b.id) {
        (Some(ai), Some(bi)) => a.blocks.contains(bi) || b.blocks.contains(ai),
        _ => false,
    }
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum In {
    Hello { token: Option<String>, #[serde(default)] colour: String, name: Option<String> },
    Name { name: Option<String>, colour: Option<String> },
    Check { name: String },
    Chat { ch: String, text: String },
    Block { id: String },
    Unblock { id: String },
}

struct Line {
    from: String,
    json: String,
}

pub struct World {
    pub clients: HashMap<u32, Client>,
    next: u32,
    ticks: u64,
    history: VecDeque<Line>,
    per_ip: HashMap<u64, usize>,
    pub max_per_ip: usize,
    /// name keys (text::name_key) that only someone from before usernames can take back, by coming back with
    /// their old token and that name (HOLD env): so a known name can't be grabbed while its owner is away
    pub hold: HashSet<String>,
    db: Db,
    secret: [u8; 32],
    stats: Option<(Stats, Instant)>,
    coarse_empty: bool,
    sent_now: usize,
}

fn unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

impl World {
    pub fn new(db: Db, max_per_ip: usize) -> World {
        let secret = db.secret().expect("reading the token secret");
        match db.migrate_ids(|old| legacy_uuid(&secret, old)) {
            Ok(0) => {}
            Ok(n) => eprintln!("moved {n} blocks to UUIDs"),
            Err(e) => eprintln!("moving blocks to UUIDs: {e}"),
        }
        World { clients: HashMap::new(), next: 1, ticks: 0, history: VecDeque::new(), per_ip: HashMap::new(), max_per_ip, hold: HashSet::new(), db, secret, stats: None, coarse_empty: true, sent_now: 0 }
    }

    // ------------------------------------------------------------------ identity tokens
    fn mac(&self, id: &str) -> Hmac<Sha256> {
        let mut m = Hmac::<Sha256>::new_from_slice(&self.secret).unwrap();
        m.update(id.as_bytes());
        m
    }
    /// `id.signature`: the id is a UUID v4, the signature HMAC-SHA256 of it (first 16 bytes).
    pub fn token(&self, id: &str) -> String {
        format!("{id}.{}", hex(&self.mac(id).finalize().into_bytes()[..16]))
    }
    /// The UUID a token carries, when it is ours (a token from before UUIDs gives its id's UUID).
    pub fn verify(&self, token: &str) -> Option<String> {
        let (id, sig) = token.split_once('.')?;
        if !(valid_id(id) || valid_legacy(id)) || sig.len() != 32 || !sig.is_ascii() {
            return None;
        }
        let bytes: Vec<u8> = (0..16).map(|i| u8::from_str_radix(&sig[i * 2..i * 2 + 2], 16)).collect::<Result<_, _>>().ok()?;
        self.mac(id).verify_truncated_left(&bytes).ok()?;
        Some(if valid_legacy(id) { legacy_uuid(&self.secret, id) } else { id.to_string() })
    }

    // ------------------------------------------------------------------ connections
    /// Room for one more connection from this address (a keyed hash of it)?
    pub fn admit(&self, ip: u64) -> bool {
        self.clients.len() < MAX_TOTAL && self.per_ip.get(&ip).copied().unwrap_or(0) < self.max_per_ip
    }

    pub fn visit(&mut self, ip: &str, ua: &str) {
        if let Err(e) = self.db.visit(ip, ua, unix()) {
            eprintln!("counting a visit: {e}");
        }
    }

    pub fn connect(&mut self, tx: mpsc::Sender<Out>, ip: u64, now: Instant) -> (u32, Arc<AtomicBool>) {
        let slot = self.next;
        self.next = self.next.wrapping_add(1).max(1);
        *self.per_ip.entry(ip).or_default() += 1;
        let kill = Arc::new(AtomicBool::new(false));
        let b = |rate, burst| Bucket::new(rate, burst, now);
        self.clients.insert(
            slot,
            Client {
                slot,
                tx,
                kill: kill.clone(),
                ip,
                since: now,
                id: None,
                name: String::new(),
                chosen: false,
                colour: String::new(),
                blocks: HashSet::new(),
                state: None,
                state_at: now,
                last_n: 0,
                msgs: b(30.0, 60.0),
                states: b(12.0, 20.0),
                chats: b(0.5, 4.0),
                names: b(0.5, 6.0),
                checks: b(4.0, 8.0),
                blocking: b(5.0, 60.0),
                teleports: b(0.1, 2.0),
                strikes: 0,
                strikes_at: now,
                last_chat: None,
            },
        );
        (slot, kill)
    }

    pub fn disconnect(&mut self, slot: u32) {
        let Some(c) = self.clients.remove(&slot) else { return };
        if let Some(n) = self.per_ip.get_mut(&c.ip) {
            *n -= 1;
            if *n == 0 {
                self.per_ip.remove(&c.ip);
            }
        }
        if c.state.is_some() {
            self.broadcast_leave(&c);
        }
    }

    /// Periodic check from the connection: kicked, or no hello in time?
    pub fn check(&self, slot: u32, now: Instant) -> Result<(), Kick> {
        let c = self.clients.get(&slot).ok_or("gone")?;
        if c.kill.load(Ordering::Relaxed) {
            return Err("too slow");
        }
        if c.id.is_none() && now.duration_since(c.since) > HELLO_WITHIN {
            return Err("no hello");
        }
        Ok(())
    }

    /// One bad or too fast message; too many within 10 s and the client is kicked.
    fn strike(&mut self, slot: u32, now: Instant) -> Result<(), Kick> {
        let c = self.clients.get_mut(&slot).ok_or("gone")?;
        if now.duration_since(c.strikes_at) > Duration::from_secs(10) {
            c.strikes = 0;
            c.strikes_at = now;
        }
        c.strikes += 1;
        if c.strikes > 20 { Err("too many bad or fast messages") } else { Ok(()) }
    }

    // ------------------------------------------------------------------ messages
    pub fn text(&mut self, slot: u32, raw: &str, now: Instant) -> Result<(), Kick> {
        let c = self.clients.get_mut(&slot).ok_or("gone")?;
        if !c.msgs.take(now) {
            return self.strike(slot, now);
        }
        let Ok(msg) = serde_json::from_str::<In>(raw) else { return self.strike(slot, now) };
        let hello = c.id.is_some();
        match msg {
            In::Hello { token, colour, name } if !hello => self.hello(slot, token, &colour, name.as_deref()),
            _ if !hello => return self.strike(slot, now),
            In::Hello { .. } => return self.strike(slot, now),
            In::Name { name, colour } => self.rename(slot, name.as_deref(), colour.as_deref(), now),
            In::Check { name } => return self.check_name(slot, &name, now),
            In::Chat { ch, text } => self.chat(slot, &ch, &text, now),
            In::Block { id } => return self.block(slot, &id, true, now),
            In::Unblock { id } => return self.block(slot, &id, false, now),
        }
        Ok(())
    }

    fn hello(&mut self, slot: u32, token: Option<String>, colour: &str, name: Option<&str>) {
        let legacy = token.as_deref().is_some_and(|t| t.split('.').next().is_some_and(valid_legacy));
        let id = token.and_then(|t| self.verify(&t)).unwrap_or_else(new_uuid);
        let blocks: HashSet<String> = self.db.blocks(&id).unwrap_or_default().into_iter().collect();
        let mut chosen = self.db.username(&id).unwrap_or_else(|e| {
            eprintln!("reading a username: {e}");
            None
        });
        // someone from before usernames comes back (a tab still running the old page reconnects at once after the
        // deploy, and the new page sends the name it kept): the name they had becomes theirs, first come first
        // served, held names included, unless it was only the old random placeholder
        if chosen.is_none()
            && legacy
            && let Some(n) = name.and_then(|n| username(n).ok()).filter(|n| !generated(n))
            && matches!(self.db.claim(&id, &n, &name_key(&n), unix()), Ok(Claim::Ok))
        {
            chosen = Some(n);
        }
        let token = self.token(&id);
        let stats = self.stats();
        let c = self.clients.get_mut(&slot).unwrap();
        c.chosen = chosen.is_some();
        c.name = chosen.unwrap_or_else(|| placeholder(&id));
        c.colour = clean_colour(colour).unwrap_or_else(|| "#f2a07e".into());
        c.id = Some(id.clone());
        c.blocks = blocks;
        let c = &self.clients[&slot];
        let players: Vec<Value> = self.clients.values().filter(|o| o.slot != slot && o.state.is_some() && !hidden(c, o)).map(roster).collect();
        let chat: Vec<Value> = self
            .history
            .iter()
            .filter(|l| !c.blocks.contains(&l.from) && !self.clients.values().any(|o| o.id.as_deref() == Some(&l.from) && o.blocks.contains(&id)))
            .filter_map(|l| serde_json::from_str(&l.json).ok())
            .collect();
        let mut blocks: Vec<&String> = c.blocks.iter().collect();
        blocks.sort();
        c.json(&json!({ "t": "welcome", "s": slot, "id": id, "token": token, "name": c.name, "chosen": c.chosen, "colour": c.colour, "blocks": blocks, "players": players, "chat": chat, "stats": stats }));
    }

    fn rename(&mut self, slot: u32, name: Option<&str>, colour: Option<&str>, now: Instant) {
        let c = self.clients.get_mut(&slot).unwrap();
        if !c.names.take(now) {
            return c.json(&json!({ "t": "error", "msg": "Wait a moment before changing that again." }));
        }
        let id = c.id.clone().unwrap();
        let mut changed = false;
        if let Some(col) = colour.and_then(clean_colour) {
            changed |= c.colour != col;
            c.colour = col;
        }
        if let Some(raw) = name.filter(|n| *n != c.name || !c.chosen) {
            let refuse = |c: &Client, why: &str, wait: i64| {
                let msg = match why {
                    "taken" => "Someone already has that name (or one that looks just like it).".to_string(),
                    "reserved" => "That name is reserved.".to_string(),
                    "short" | "long" => "Use 3 to 20 characters.".to_string(),
                    "wait" => format!("You can change your name again in {wait} s."),
                    _ => "Use letters, digits, spaces and - _ . ' only.".to_string(),
                };
                c.json(&json!({ "t": "error", "about": "name", "why": why, "wait": wait, "msg": msg }));
            };
            let name = match username(raw) {
                Ok(n) => n,
                Err(why) => return refuse(c, why, 0),
            };
            if self.held(&name_key(&name)) {
                return refuse(&self.clients[&slot], "reserved", 0);
            }
            match self.db.claim(&id, &name, &name_key(&name), unix()) {
                Ok(Claim::Ok) => {}
                Ok(Claim::Taken) => return refuse(&self.clients[&slot], "taken", 0),
                Ok(Claim::Wait(s)) => return refuse(&self.clients[&slot], "wait", s),
                Err(e) => {
                    eprintln!("saving a username: {e}");
                    return self.clients[&slot].json(&json!({ "t": "error", "msg": "Couldn't save that, try again." }));
                }
            }
            // every tab of this browser takes the new name
            let col = self.clients[&slot].colour.clone();
            for o in self.clients.values_mut().filter(|o| o.id.as_deref() == Some(id.as_str())) {
                o.name = name.clone();
                o.chosen = true;
                if o.slot == slot {
                    o.colour = col.clone();
                }
            }
            changed = true;
        }
        let me: Vec<u32> = self.clients.values().filter(|o| o.id.as_deref() == Some(id.as_str())).map(|o| o.slot).collect();
        for s in me {
            let o = &self.clients[&s];
            if s == slot || changed {
                o.json(&json!({ "t": "you", "name": o.name, "chosen": o.chosen, "colour": o.colour }));
            }
            if changed && o.state.is_some() {
                self.broadcast_join(o);
            }
        }
    }

    /// A held name nobody has taken back yet: not for anyone to choose (once its owner has it, it's simply taken).
    fn held(&self, key: &str) -> bool {
        self.hold.contains(key) && matches!(self.db.name_owner(key), Ok(None))
    }

    /// Is this username free for this client? Answers {"t":"check","name","why"}.
    fn check_name(&mut self, slot: u32, raw: &str, now: Instant) -> Result<(), Kick> {
        let c = self.clients.get_mut(&slot).ok_or("gone")?;
        if !c.checks.take(now) || raw.len() > 200 {
            return self.strike(slot, now);
        }
        let c = &self.clients[&slot];
        let why = match username(raw) {
            Err(why) => why,
            Ok(name) => match self.db.name_owner(&name_key(&name)) {
                Ok(Some(o)) if c.id.as_deref() == Some(o.as_str()) => "yours",
                Ok(Some(_)) => "taken",
                Ok(None) if self.hold.contains(&name_key(&name)) => "reserved",
                Ok(None) => "ok",
                Err(e) => {
                    eprintln!("checking a username: {e}");
                    "ok" // the claim decides
                }
            },
        };
        c.json(&json!({ "t": "check", "name": raw, "why": why }));
        Ok(())
    }

    fn chat(&mut self, slot: u32, ch: &str, text: &str, now: Instant) {
        let c = self.clients.get_mut(&slot).unwrap();
        let near = match ch {
            "g" => false,
            "n" if c.state.is_some() => true,
            "n" => return c.json(&json!({ "t": "error", "msg": "Start exploring to talk to people near you." })),
            _ => return,
        };
        let Some(text) = clean_text(text, CHAT_MAX) else { return };
        if !c.chats.take(now) {
            return c.json(&json!({ "t": "error", "msg": "Slow down a little." }));
        }
        if c.last_chat.as_ref().is_some_and(|(t, at)| *t == text && now.duration_since(*at) < Duration::from_secs(30)) {
            return c.json(&json!({ "t": "error", "msg": "You just said that." }));
        }
        c.last_chat = Some((text.clone(), now));
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let c = &self.clients[&slot];
        let line = json!({ "t": "chat", "ch": ch, "id": c.id, "name": c.name, "chosen": c.chosen, "colour": c.colour, "text": text, "ts": ts }).to_string();
        let me = c.state;
        for o in self.clients.values() {
            if o.id.is_none() || hidden(c, o) {
                continue;
            }
            if near && o.slot != slot && !matches!((o.state, me), (Some(a), Some(b)) if (a.x - b.x).hypot(a.z - b.z) < NEAR) {
                continue;
            }
            o.send(Out::Text(line.clone()));
        }
        if !near {
            let from = c.id.clone().unwrap();
            self.history.push_back(Line { from, json: line });
            if self.history.len() > HISTORY {
                self.history.pop_front();
            }
        }
    }

    fn block(&mut self, slot: u32, target: &str, on: bool, now: Instant) -> Result<(), Kick> {
        let c = self.clients.get_mut(&slot).ok_or("gone")?;
        if !c.blocking.take(now) || !valid_id(target) || c.id.as_deref() == Some(target) || (on && c.blocks.len() >= MAX_BLOCKS) {
            return self.strike(slot, now);
        }
        // who could see whom before, so the change can be told as joins / leaves
        let others: Vec<u32> = self.clients.values().filter(|o| o.id.as_deref() == Some(target)).map(|o| o.slot).collect();
        let before: Vec<bool> = others.iter().map(|o| hidden(&self.clients[&slot], &self.clients[o])).collect();
        let c = self.clients.get_mut(&slot).unwrap();
        let changed = if on { c.blocks.insert(target.to_string()) } else { c.blocks.remove(target) };
        if changed && let Err(e) = self.db.set_block(c.id.as_ref().unwrap(), target, on) {
            eprintln!("saving a block: {e}");
        }
        let me = &self.clients[&slot];
        for (o, was) in others.iter().zip(before) {
            let o = &self.clients[o];
            let is = hidden(me, o);
            if was == is {
                continue;
            }
            for (a, b) in [(me, o), (o, me)] {
                // tell a about b
                if b.state.is_none() {
                    continue;
                }
                a.send(Out::Text(if is { json!({ "t": "leave", "s": b.slot }) } else { roster_msg(b) }.to_string()));
            }
        }
        Ok(())
    }

    pub fn binary(&mut self, slot: u32, b: &[u8], now: Instant) -> Result<(), Kick> {
        let c = self.clients.get_mut(&slot).ok_or("gone")?;
        if !c.msgs.take(now) || !c.states.take(now) || c.id.is_none() {
            return self.strike(slot, now);
        }
        let Some(s) = parse_state(b) else { return self.strike(slot, now) };
        if s.mode == 0 {
            if c.state.take().is_some() {
                let c = &self.clients[&slot];
                self.broadcast_leave(c);
            }
            return Ok(());
        }
        let [x0, x1, z0, z1, y0, y1] = EXTENT;
        if !(x0..=x1).contains(&s.x) || !(z0..=z1).contains(&s.z) || !(y0..=y1).contains(&s.y) {
            return self.strike(slot, now);
        }
        let s = State { heading: s.heading.clamp(-std::f32::consts::PI, std::f32::consts::PI), speed: s.speed.clamp(-80.0, 80.0), ..s };
        let joined = c.state.is_none();
        if let Some(p) = c.state {
            // faster than a car (or a runner) can go: a respawn now and then is fine, else ignore it
            let dt = now.duration_since(c.state_at).as_secs_f32().max(0.05);
            let vmax = match (p.mode, s.mode) {
                (2, 2) => 15.0, // on foot
                (3, 3) => 12.0, // sailing
                _ => 70.0,      // by van, or getting in or out
            };
            if (s.x - p.x).hypot(s.z - p.z) > vmax * 1.5 * dt + 5.0 && !c.teleports.take(now) {
                return Ok(());
            }
        }
        c.state = Some(s);
        c.state_at = now;
        if joined {
            let c = &self.clients[&slot];
            self.broadcast_join(c);
        }
        Ok(())
    }

    fn broadcast_join(&self, c: &Client) {
        let msg = roster_msg(c).to_string();
        for o in self.clients.values() {
            if o.slot != c.slot && o.id.is_some() && !hidden(c, o) {
                o.send(Out::Text(msg.clone()));
            }
        }
    }

    fn broadcast_leave(&self, c: &Client) {
        let msg = json!({ "t": "leave", "s": c.slot }).to_string();
        for o in self.clients.values() {
            if o.slot != c.slot && o.id.is_some() && !hidden(c, o) {
                o.send(Out::Text(msg.clone()));
            }
        }
    }

    // ------------------------------------------------------------------ the 10 Hz tick
    pub fn tick(&mut self, now: Instant) {
        self.ticks += 1;
        let stale: Vec<u32> = self.clients.values().filter(|c| c.state.is_some() && now.duration_since(c.state_at) > STALE).map(|c| c.slot).collect();
        for s in stale {
            self.clients.get_mut(&s).unwrap().state = None;
            self.broadcast_leave(&self.clients[&s]);
        }

        // interest: players within NEAR of each player, from a grid of NEAR-sized cells
        let cell = |s: &State| ((s.x / NEAR).floor() as i32, (s.z / NEAR).floor() as i32);
        let mut grid: HashMap<(i32, i32), Vec<&Client>> = HashMap::new();
        for c in self.clients.values() {
            if let Some(s) = &c.state {
                grid.entry(cell(s)).or_default().push(c);
            }
        }
        let mut sent = vec![];
        for a in self.clients.values() {
            let Some(sa) = &a.state else { continue };
            let (ci, cj) = cell(sa);
            let mut near: Vec<(f32, &Client)> = vec![];
            for i in ci - 1..=ci + 1 {
                for j in cj - 1..=cj + 1 {
                    for &b in grid.get(&(i, j)).into_iter().flatten() {
                        let sb = b.state.as_ref().unwrap();
                        let d = (sb.x - sa.x).hypot(sb.z - sa.z);
                        if b.slot != a.slot && d < NEAR && !hidden(a, b) {
                            near.push((d, b));
                        }
                    }
                }
            }
            if near.is_empty() && a.last_n == 0 {
                continue;
            }
            near.sort_by(|x, y| x.0.total_cmp(&y.0));
            near.truncate(MAX_NEAR);
            let mut buf = Vec::with_capacity(3 + near.len() * 21);
            buf.push(1);
            buf.extend((near.len() as u16).to_le_bytes());
            for (_, b) in &near {
                let s = b.state.as_ref().unwrap();
                buf.extend(b.slot.to_le_bytes());
                for v in [s.x, s.y, s.z] {
                    buf.extend(v.to_le_bytes());
                }
                buf.extend(((s.heading * 1e4).round() as i16).to_le_bytes());
                buf.extend(((s.speed * 100.0).round() as i16).to_le_bytes());
                buf.push(s.mode);
            }
            a.send(Out::Bin(buf.into()));
            sent.push((a.slot, near.len()));
        }
        for (s, n) in sent {
            self.clients.get_mut(&s).unwrap().last_n = n;
        }

        if self.ticks.is_multiple_of(COARSE_TICKS) {
            self.coarse();
        }
        if self.ticks.is_multiple_of(STATS_TICKS) || (self.ticks.is_multiple_of(50) && self.clients.len() != self.sent_now) {
            self.sent_now = self.clients.len();
            let msg = json!({ "t": "stats", "stats": self.stats() }).to_string();
            for c in self.clients.values().filter(|c| c.id.is_some()) {
                c.send(Out::Text(msg.clone()));
            }
        }
    }

    /// Every player's rough position, for the map: one shared message, filtered only for people
    /// with blocks involved.
    // ponytail: O(clients × players) block check every 2 s; index blocks by id if it ever shows up in a profile
    fn coarse(&mut self) {
        let players: Vec<&Client> = self.clients.values().filter(|c| c.state.is_some()).collect();
        if players.is_empty() && self.coarse_empty {
            return;
        }
        let encode = |list: &mut dyn Iterator<Item = &&Client>| {
            let mut buf = vec![2, 0, 0];
            let mut n: u16 = 0;
            for c in list {
                let s = c.state.as_ref().unwrap();
                buf.extend(c.slot.to_le_bytes());
                buf.extend(s.x.to_le_bytes());
                buf.extend(s.z.to_le_bytes());
                buf.push(s.mode);
                n += 1;
            }
            buf[1..3].copy_from_slice(&n.to_le_bytes());
            Bytes::from(buf)
        };
        let shared = encode(&mut players.iter());
        for r in self.clients.values().filter(|c| c.id.is_some()) {
            if players.iter().any(|p| hidden(r, p)) {
                r.send(Out::Bin(encode(&mut players.iter().filter(|p| !hidden(r, p)))));
            } else {
                r.send(Out::Bin(shared.clone()));
            }
        }
        self.coarse_empty = players.is_empty();
    }

    /// Visitor counts, refreshed at most every 10 s.
    pub fn stats(&mut self) -> Stats {
        let now = self.clients.len();
        if let Some((s, at)) = self.stats
            && at.elapsed() < Duration::from_secs(10)
        {
            return Stats { now, ..s };
        }
        let (day, week) = self.db.counts(unix()).unwrap_or_else(|e| {
            eprintln!("counting visitors: {e}");
            (0, 0)
        });
        let s = Stats { now, day, week };
        self.stats = Some((s, Instant::now()));
        s
    }
}

/// A UUID v4 in its usual lowercase form.
fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| if matches!(i, 8 | 13 | 18 | 23) { c == b'-' } else { matches!(c, b'0'..=b'9' | b'a'..=b'f') })
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
}

/// An id from before UUIDs: 16 hex digits.
fn valid_legacy(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// 16 random-looking bytes as a UUID v4 (version and variant bits set).
fn uuid(mut b: [u8; 16]) -> String {
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

pub fn new_uuid() -> String {
    uuid(rand::random())
}

/// The UUID an id from before UUIDs became: HMAC of it, so it is the same on every replica and restart and
/// can't be guessed from the old id without the server's secret.
pub fn legacy_uuid(secret: &[u8; 32], old: &str) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(secret).unwrap();
    m.update(b"legacy id:");
    m.update(old.as_bytes());
    uuid(m.finalize().into_bytes()[..16].try_into().unwrap())
}

const ANIMALS: [&str; 16] = ["Otter", "Heron", "Orca", "Raven", "Seal", "Salmon", "Eagle", "Beaver", "Cedar", "Crab", "Puffin", "Fern", "Moose", "Loon", "Marmot", "Hummingbird"];

/// A name the server or the old page made up ("Heron 44", "Guest 3f2a"), not one someone chose.
fn generated(name: &str) -> bool {
    let Some((a, b)) = name.rsplit_once(' ') else { return false };
    (ANIMALS.contains(&a) && b.len() == 2 && b.bytes().all(|c| c.is_ascii_digit())) || (a == "Guest" && b.len() == 4 && b.bytes().all(|c| c.is_ascii_hexdigit()))
}

/// The name someone has until they choose one: an animal and a number from their UUID ("Heron 44").
pub fn placeholder(id: &str) -> String {
    let b = id.as_bytes();
    let n = |i: usize| u8::from_str_radix(&id[i..i + 2], 16).unwrap_or(b[i % b.len()]) as usize;
    format!("{} {}", ANIMALS[n(0) % ANIMALS.len()], 10 + n(2) % 90)
}

fn roster(c: &Client) -> Value {
    json!({ "s": c.slot, "id": c.id, "name": c.name, "chosen": c.chosen, "colour": c.colour })
}

fn roster_msg(c: &Client) -> Value {
    let mut v = roster(c);
    v["t"] = "join".into();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    struct T {
        w: World,
        now: Instant,
    }
    struct C {
        slot: u32,
        rx: mpsc::Receiver<Out>,
    }
    impl C {
        fn drain(&mut self) -> Vec<Out> {
            let mut v = vec![];
            while let Ok(o) = self.rx.try_recv() {
                v.push(o);
            }
            v
        }
        fn texts(&mut self) -> Vec<Value> {
            self.drain().into_iter().filter_map(|o| if let Out::Text(t) = o { serde_json::from_str(&t).ok() } else { None }).collect()
        }
        fn bins(&mut self) -> Vec<Bytes> {
            self.drain().into_iter().filter_map(|o| if let Out::Bin(b) = o { Some(b) } else { None }).collect()
        }
    }
    impl T {
        fn new() -> T {
            T { w: World::new(Db::open(":memory:").unwrap(), 4), now: Instant::now() }
        }
        fn join(&mut self, name: &str) -> C {
            let (tx, rx) = mpsc::channel(512);
            let (slot, _) = self.w.connect(tx, 7, self.now);
            self.w.text(slot, &json!({ "t": "hello", "colour": "#112233" }).to_string(), self.now).unwrap();
            self.w.text(slot, &json!({ "t": "name", "name": name }).to_string(), self.now).unwrap();
            let mut c = C { slot, rx };
            let m = c.texts();
            assert_eq!(m[0]["t"], "welcome");
            assert_eq!((&m[1]["t"], &m[1]["name"], &m[1]["chosen"]), (&json!("you"), &json!(name), &json!(true)));
            c
        }
        fn at(&mut self, c: &C, x: f32, z: f32) {
            self.w.binary(c.slot, &encode_state(&State { mode: 1, x, y: 10.0, z, heading: 0.5, speed: 3.0 }), self.now).unwrap();
        }
        fn later(&mut self, ms: u64) {
            self.now += Duration::from_millis(ms);
        }
        fn id(&self, c: &C) -> String {
            self.w.clients[&c.slot].id.clone().unwrap()
        }
    }
    /// slots in a binary snapshot or map list
    fn slots(b: &[u8]) -> Vec<u32> {
        let n = u16::from_le_bytes([b[1], b[2]]) as usize;
        let size = if b[0] == 1 { 21 } else { 13 };
        (0..n).map(|i| u32::from_le_bytes(b[3 + i * size..7 + i * size].try_into().unwrap())).collect()
    }

    #[test]
    fn state_round_trip_and_garbage() {
        let s = State { mode: 2, x: -1234.5, y: 88.25, z: 30000.0, heading: -3.1, speed: 1.5 };
        let p = parse_state(&encode_state(&s)).unwrap();
        assert_eq!((p.mode, p.x, p.y, p.z), (2, -1234.5, 88.25, 30000.0));
        assert!((p.heading + 3.1).abs() < 1e-3 && (p.speed - 1.5).abs() < 1e-3);
        assert!(parse_state(&[1, 1, 0]).is_none());
        let mut bad = encode_state(&s);
        bad[1] = 9;
        assert!(parse_state(&bad).is_none());
        let mut nan = encode_state(&s);
        nan[2..6].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(parse_state(&nan).is_none());
    }

    #[test]
    fn tokens() {
        let t = T::new();
        let id = new_uuid();
        assert!(valid_id(&id), "{id}");
        assert_ne!(id, new_uuid());
        let tok = t.w.token(&id);
        assert_eq!(t.w.verify(&tok).as_deref(), Some(id.as_str()));
        let other = new_uuid();
        assert_eq!(t.w.verify(&format!("{other}{}", &tok[36..])), None, "a signature is for one id only");
        assert_eq!(t.w.verify("nonsense"), None);
        assert_eq!(t.w.verify(&format!("{id}.{}", "é".repeat(16))), None);
        // a token from before UUIDs still works, as the same UUID every time
        let old = t.w.token("0123456789abcdef");
        let u = t.w.verify(&old).unwrap();
        assert!(valid_id(&u) && u == legacy_uuid(&t.w.secret, "0123456789abcdef"), "{u}");
        assert_eq!(t.w.verify(&format!("fedcba9876543210{}", &old[16..])), None);
        assert!(!valid_id("0123456789abcdef") && !valid_id(&id.to_uppercase()));
    }

    #[test]
    fn names_from_before_usernames_carry_over() {
        let mut t = T::new();
        t.w.hold = ["borodutch", "Kitsilano"].iter().map(|n| name_key(n)).collect();
        let legacy = |t: &T, old: &str| {
            let mut m = t.w.mac(old);
            m.update(b"");
            format!("{old}.{}", hex(&m.finalize().into_bytes()[..16]))
        };
        let hello = |t: &mut T, m: Value| {
            let (tx, mut rx) = mpsc::channel(64);
            let (slot, _) = t.w.connect(tx, 1, t.now);
            t.w.text(slot, &m.to_string(), t.now).unwrap();
            let Out::Text(w) = rx.try_recv().unwrap() else { panic!() };
            (C { slot, rx }, serde_json::from_str::<Value>(&w).unwrap())
        };
        // a newcomer can't take a held name, nor send a name in hello
        let (mut x, w) = hello(&mut t, json!({ "t": "hello", "name": "borodutch" }));
        assert_eq!(w["chosen"], false);
        t.w.text(x.slot, r#"{"t":"check","name":"BoroDutch"}"#, t.now).unwrap();
        assert_eq!(x.texts()[0]["why"], "reserved");
        t.w.text(x.slot, r#"{"t":"name","name":"borodutch"}"#, t.now).unwrap();
        assert_eq!(x.texts()[0]["why"], "reserved");
        // its owner from before comes back with the old token (an old tab reconnecting after the deploy): it's theirs
        let tok = legacy(&t, "00000000000000aa");
        let (_, w) = hello(&mut t, json!({ "t": "hello", "token": tok, "name": "borodutch", "colour": "#000000" }));
        let owner = legacy_uuid(&t.w.secret, "00000000000000aa");
        assert_eq!((&w["id"], &w["name"], &w["chosen"]), (&json!(owner), &json!("borodutch"), &json!(true)));
        // and kept: the next visit (new token, no name sent) has it, nobody else can have it
        let (_, w) = hello(&mut t, json!({ "t": "hello", "token": w["token"] }));
        assert_eq!(w["name"], "borodutch");
        t.later(1000);
        t.w.text(x.slot, r#"{"t":"name","name":"B0rodutch"}"#, t.now).unwrap();
        assert_eq!(x.texts()[0]["why"], "taken");
        let tok = legacy(&t, "00000000000000bb");
        let (_, w) = hello(&mut t, json!({ "t": "hello", "token": tok, "name": "borodutch" }));
        assert_eq!(w["chosen"], false, "another old user with the same old name: first come, first served");
        // an old random name is not carried over; an ordinary chosen one is
        let tok = legacy(&t, "00000000000000cc");
        let (_, w) = hello(&mut t, json!({ "t": "hello", "token": tok, "name": "Otter 23" }));
        assert_eq!(w["chosen"], false);
        let tok = legacy(&t, "00000000000000dd");
        let (_, w) = hello(&mut t, json!({ "t": "hello", "token": tok, "name": "Guest 3f2a" }));
        assert_eq!(w["chosen"], false);
        let tok = legacy(&t, "00000000000000ee");
        let (_, w) = hello(&mut t, json!({ "t": "hello", "token": tok, "name": "  Sea   Wall " }));
        assert_eq!((&w["name"], &w["chosen"]), (&json!("Sea Wall"), &json!(true)));
    }

    #[test]
    fn placeholders_until_chosen() {
        let mut t = T::new();
        let (tx, mut rx) = mpsc::channel(64);
        let (slot, _) = t.w.connect(tx, 1, t.now);
        t.w.text(slot, r##"{"t":"hello","name":"Sneaky","colour":"#123456"}"##, t.now).unwrap();
        let Out::Text(w) = rx.try_recv().unwrap() else { panic!() };
        let w: Value = serde_json::from_str(&w).unwrap();
        let id = w["id"].as_str().unwrap();
        assert!(valid_id(id));
        assert_eq!(w["chosen"], false);
        assert_eq!(w["name"], placeholder(id), "the name in hello is not taken: it would skip the uniqueness check");
        assert!(ANIMALS.iter().any(|a| w["name"].as_str().unwrap().starts_with(a)));
    }

    #[test]
    fn unique_usernames() {
        let mut t = T::new();
        let mut a = t.join("Heron");
        let (tx, mut rx) = mpsc::channel(64);
        let (slot, _) = t.w.connect(tx, 1, t.now);
        t.w.text(slot, r#"{"t":"hello"}"#, t.now).unwrap();
        rx.try_recv().unwrap();
        let mut b = C { slot, rx };
        let ask = |t: &mut T, c: &mut C, m: Value| {
            t.later(300);
            t.w.text(c.slot, &m.to_string(), t.now).unwrap();
            c.texts().pop().unwrap()
        };
        // checks: taken (look-alikes too), yours, free, invalid
        for (name, why) in [("heron", "taken"), ("НEron", "taken"), ("H3r0n", "taken"), ("Heron!", "invalid"), ("Ok", "short"), ("Admin", "reserved"), ("Egret", "ok")] {
            assert_eq!(ask(&mut t, &mut b, json!({ "t": "check", "name": name }))["why"], why, "{name}");
        }
        assert_eq!(ask(&mut t, &mut a, json!({ "t": "check", "name": "HERON" }))["why"], "yours");
        // claims
        let e = ask(&mut t, &mut b, json!({ "t": "name", "name": "Ηeron" })); // Greek Eta
        assert_eq!((&e["t"], &e["about"], &e["why"]), (&json!("error"), &json!("name"), &json!("taken")));
        let e = ask(&mut t, &mut b, json!({ "t": "name", "name": "Zo\u{200B}e" }));
        assert_eq!(e["why"], "invalid");
        let y = ask(&mut t, &mut b, json!({ "t": "name", "name": "  Egret   Two " }));
        assert_eq!((&y["t"], &y["name"], &y["chosen"]), (&json!("you"), &json!("Egret Two"), &json!(true)));
        // once a minute: right away again is refused with the wait
        let e = ask(&mut t, &mut b, json!({ "t": "name", "name": "Egret Three" }));
        assert_eq!(e["why"], "wait");
        assert!(e["wait"].as_i64().unwrap() > 50);
        // a colour on its own is fine any time
        let y = ask(&mut t, &mut b, json!({ "t": "name", "colour": "#ABCDEF" }));
        assert_eq!((&y["name"], &y["colour"]), (&json!("Egret Two"), &json!("#abcdef")));
        // the name is kept: a new connection with the same token gets it back
        let bid = t.w.clients[&b.slot].id.clone().unwrap();
        let (tx, mut rx) = mpsc::channel(64);
        let (slot, _) = t.w.connect(tx, 1, t.now);
        t.w.text(slot, &json!({ "t": "hello", "token": t.w.token(&bid) }).to_string(), t.now).unwrap();
        let Out::Text(w) = rx.try_recv().unwrap() else { panic!() };
        let w: Value = serde_json::from_str(&w).unwrap();
        assert_eq!((&w["id"], &w["name"], &w["chosen"]), (&json!(bid), &json!("Egret Two"), &json!(true)));
        // other people see it in rosters and chat, with chosen: true
        t.w.text(b.slot, r#"{"t":"chat","ch":"g","text":"hi"}"#, t.now).unwrap();
        let l = a.texts().into_iter().find(|m| m["t"] == "chat").unwrap();
        assert_eq!((&l["name"], &l["chosen"], &l["id"]), (&json!("Egret Two"), &json!(true), &json!(bid)));
    }

    #[test]
    fn rename_reaches_everyone() {
        let mut t = T::new();
        let (a, mut b) = (t.join("Ann"), t.join("Ben"));
        t.at(&a, 0.0, 0.0);
        b.drain();
        t.later(61_000); // T::join already chose a name, so this is a rename
        let r = t.w.db.claim(&t.id(&a), "Annie", "annie", unix() + 61);
        assert_eq!(r.unwrap(), Claim::Ok, "the database rule (once a minute) is tested in db.rs; here only the broadcast");
        t.w.text(a.slot, r#"{"t":"name","name":"Annie"}"#, t.now).unwrap();
        let j = b.texts().into_iter().find(|m| m["t"] == "join").unwrap();
        assert_eq!((&j["s"], &j["name"]), (&json!(a.slot), &json!("Annie")));
    }

    #[test]
    fn blocks_take_uuids() {
        let mut t = T::new();
        let mut a = t.join("Ann");
        for bad in ["0123456789abcdef", "nonsense", "6D9F1F25-09DE-421E-9955-EFA233BE98C1"] {
            t.w.text(a.slot, &json!({ "t": "block", "id": bad }).to_string(), t.now).unwrap();
        }
        assert!(t.w.clients[&a.slot].blocks.is_empty());
        let someone = new_uuid();
        t.w.text(a.slot, &json!({ "t": "block", "id": someone }).to_string(), t.now).unwrap();
        assert!(t.w.clients[&a.slot].blocks.contains(&someone));
        assert_eq!(t.w.db.blocks(&t.id(&a)).unwrap(), vec![someone]);
        a.drain();
    }

    #[test]
    fn legacy_blocks_follow_the_token() {
        // a database from before UUIDs: Ann (old id) blocked Troll (old id)
        let db = Db::open(":memory:").unwrap();
        db.set_block("00000000000000aa", "00000000000000bb", true).unwrap();
        let mut t = T { w: World::new(db, 4), now: Instant::now() };
        let old_token = {
            let mut m = t.w.mac("00000000000000aa");
            m.update(b"");
            format!("00000000000000aa.{}", hex(&m.finalize().into_bytes()[..16]))
        };
        let (tx, mut rx) = mpsc::channel(64);
        let (slot, _) = t.w.connect(tx, 1, t.now);
        t.w.text(slot, &json!({ "t": "hello", "token": old_token }).to_string(), t.now).unwrap();
        let Out::Text(w) = rx.try_recv().unwrap() else { panic!() };
        let w: Value = serde_json::from_str(&w).unwrap();
        let (ann, troll) = (legacy_uuid(&t.w.secret, "00000000000000aa"), legacy_uuid(&t.w.secret, "00000000000000bb"));
        assert_eq!(w["id"], ann);
        assert_eq!(w["blocks"], json!([troll]));
        assert!(valid_id(w["token"].as_str().unwrap().split('.').next().unwrap()), "a new-style token from now on");
        assert_eq!(t.w.verify(w["token"].as_str().unwrap()).as_deref(), Some(ann.as_str()));
    }

    #[test]
    fn same_token_same_id() {
        let mut t = T::new();
        let a = t.join("Alice");
        let id = t.id(&a);
        let tok = t.w.token(&id);
        let (tx, mut rx) = mpsc::channel(64);
        let (slot, _) = t.w.connect(tx, 1, t.now);
        t.w.text(slot, &json!({ "t": "hello", "token": tok, "colour": "x" }).to_string(), t.now).unwrap();
        let Out::Text(w) = rx.try_recv().unwrap() else { panic!() };
        let w: Value = serde_json::from_str(&w).unwrap();
        assert_eq!(w["id"], id);
        assert_eq!(w["colour"], "#f2a07e"); // a bad colour falls back
        assert_eq!((&w["name"], &w["chosen"]), (&json!("Alice"), &json!(true)));
    }

    #[test]
    fn interest_and_map_list() {
        let mut t = T::new();
        let (mut a, mut b, mut c, mut idle) = (t.join("Ann"), t.join("Ben"), t.join("Cat"), t.join("Idle"));
        t.at(&a, 0.0, 0.0);
        t.at(&b, 900.0, 900.0); // 1.27 km away: near
        t.at(&c, 3000.0, 0.0); // 3 km: far
        assert_eq!(idle.texts().iter().filter(|m| m["t"] == "join").count(), 3);
        for _ in 0..COARSE_TICKS {
            t.later(100);
            t.w.tick(t.now);
            t.at(&a, 0.0, 0.0);
            t.at(&b, 900.0, 900.0);
            t.at(&c, 3000.0, 0.0);
        }
        let snaps = |x: &mut C| x.bins().into_iter().filter(|b| b[0] == 1).collect::<Vec<_>>();
        let (sa, sb, sc) = (snaps(&mut a), snaps(&mut b), snaps(&mut c));
        assert_eq!(sa.len(), COARSE_TICKS as usize);
        assert_eq!(slots(&sa[0]), vec![b.slot]);
        assert_eq!(slots(&sb[0]), vec![a.slot]);
        assert!(sc.is_empty(), "nobody near c, nothing sent");
        // everyone (playing or not) got the map list with all three
        let map = idle.bins();
        assert_eq!(map.len(), 1);
        let mut s = slots(&map[0]);
        s.sort();
        assert_eq!(s, vec![a.slot, b.slot, c.slot]);
    }

    #[test]
    fn sanity_checks() {
        let mut t = T::new();
        let a = t.join("Ann");
        // outside the map: refused (and a strike)
        t.w.binary(a.slot, &encode_state(&State { mode: 1, x: 1e6, y: 0.0, z: 0.0, heading: 0.0, speed: 0.0 }), t.now).unwrap();
        assert!(t.w.clients[&a.slot].state.is_none());
        t.at(&a, 0.0, 0.0);
        // 100 ms later 500 m on: the first jumps count as respawns, then they are ignored
        for i in 1..=4 {
            t.later(100);
            t.at(&a, 500.0 * i as f32, 0.0);
        }
        let x = t.w.clients[&a.slot].state.unwrap().x;
        assert_eq!(x, 1000.0, "two teleports allowed, then ignored");
        // driving at a plausible speed is fine
        t.later(1000);
        t.at(&a, 1030.0, 0.0);
        assert_eq!(t.w.clients[&a.slot].state.unwrap().x, 1030.0);
    }

    #[test]
    fn boats() {
        let mut t = T::new();
        let a = t.join("Ann");
        let sail = |t: &mut T, x: f32| t.w.binary(a.slot, &encode_state(&State { mode: 3, x, y: 1.0, z: 0.0, heading: 0.0, speed: 5.0 }), t.now).unwrap();
        sail(&mut t, 0.0);
        assert_eq!(t.w.clients[&a.slot].state.unwrap().mode, 3);
        // a brisk 10 m/s sail is fine
        t.later(1000);
        sail(&mut t, 10.0);
        assert_eq!(t.w.clients[&a.slot].state.unwrap().x, 10.0);
        // 40 m/s is no boat: after the respawns allowed, ignored
        for i in 1..=4 {
            t.later(1000);
            sail(&mut t, 10.0 + 40.0 * i as f32);
        }
        assert_eq!(t.w.clients[&a.slot].state.unwrap().x, 90.0, "two teleports allowed, then ignored");
        // modes past 3 are refused
        t.later(1000);
        t.w.binary(a.slot, &encode_state(&State { mode: 4, x: 91.0, y: 1.0, z: 0.0, heading: 0.0, speed: 0.0 }), t.now).unwrap();
        assert_eq!(t.w.clients[&a.slot].state.unwrap().mode, 3);
    }

    #[test]
    fn rate_limits_and_kick() {
        let mut t = T::new();
        let mut a = t.join("Ann");
        // chat: a burst of 4, then "slow down"
        for i in 0..6 {
            t.w.text(a.slot, &json!({ "t": "chat", "ch": "g", "text": format!("hi {i}") }).to_string(), t.now).unwrap();
        }
        let got = a.texts();
        assert_eq!(got.iter().filter(|m| m["t"] == "chat").count(), 4);
        assert_eq!(got.iter().filter(|m| m["t"] == "error").count(), 2);
        // duplicates are dropped
        t.later(10_000);
        t.w.text(a.slot, r#"{"t":"chat","ch":"g","text":"same"}"#, t.now).unwrap();
        t.later(3000);
        t.w.text(a.slot, r#"{"t":"chat","ch":"g","text":"same"}"#, t.now).unwrap();
        assert_eq!(a.texts().iter().filter(|m| m["t"] == "chat").count(), 1);
        // states faster than 12/s (burst 20) and garbage earn strikes; 20 strikes in 10 s kick
        let mut kicked = None;
        for i in 0..200 {
            if let Err(e) = t.w.binary(a.slot, &[1, 1, 2, 3], t.now) {
                kicked = Some(i);
                assert_eq!(e, "too many bad or fast messages");
                break;
            }
        }
        assert_eq!(kicked, Some(20));
    }

    #[test]
    fn hello_first_and_in_time() {
        let mut t = T::new();
        let (tx, _rx) = mpsc::channel(8);
        let (slot, _) = t.w.connect(tx, 9, t.now);
        assert!(t.w.text(slot, r#"{"t":"chat","ch":"g","text":"x"}"#, t.now).is_ok()); // a strike, not yet a kick
        assert!(t.w.clients[&slot].id.is_none());
        assert!(t.w.check(slot, t.now).is_ok());
        assert_eq!(t.w.check(slot, t.now + Duration::from_secs(11)), Err("no hello"));
    }

    #[test]
    fn connections_per_address() {
        let mut t = T::new();
        for _ in 0..4 {
            assert!(t.w.admit(42));
            t.w.connect(mpsc::channel(1).0, 42, t.now);
        }
        assert!(!t.w.admit(42));
        assert!(t.w.admit(43));
        t.w.disconnect(*t.w.clients.keys().next().unwrap());
        assert!(t.w.admit(42));
    }

    #[test]
    fn nearby_and_global_chat() {
        let mut t = T::new();
        let (mut a, mut b, mut c, mut idle) = (t.join("Ann"), t.join("Ben"), t.join("Cat"), t.join("Idle"));
        t.at(&a, 0.0, 0.0);
        t.at(&b, 100.0, 0.0);
        t.at(&c, 5000.0, 0.0);
        for x in [&mut a, &mut b, &mut c, &mut idle] {
            x.drain();
        }
        t.w.text(a.slot, r#"{"t":"chat","ch":"n","text":"anyone near?"}"#, t.now).unwrap();
        assert_eq!(a.texts()[0]["text"], "anyone near?");
        assert_eq!(b.texts()[0]["ch"], "n");
        assert!(c.texts().is_empty() && idle.texts().is_empty());
        t.w.text(idle.slot, r#"{"t":"chat","ch":"g","text":"hello <b>all</b>"}"#, t.now).unwrap();
        for x in [&mut a, &mut b, &mut c, &mut idle] {
            let m = x.texts();
            assert_eq!(m[0]["text"], "hello <b>all</b>");
            assert_eq!(m[0]["name"], "Idle");
        }
        // a newcomer gets the global history, not the nearby line
        let mut d = {
            let (tx, rx) = mpsc::channel(64);
            let (slot, _) = t.w.connect(tx, 1, t.now);
            t.w.text(slot, r##"{"t":"hello","name":"Dee","colour":"#000000"}"##, t.now).unwrap();
            C { slot, rx }
        };
        let w = &d.texts()[0];
        assert_eq!(w["chat"].as_array().unwrap().len(), 1);
        assert_eq!(w["players"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn blocking_hides_both_ways() {
        let mut t = T::new();
        let (mut a, mut b) = (t.join("Ann"), t.join("Troll"));
        t.at(&a, 0.0, 0.0);
        t.at(&b, 10.0, 0.0);
        let bid = t.id(&b);
        a.drain();
        b.drain();
        t.w.text(a.slot, &json!({ "t": "block", "id": bid }).to_string(), t.now).unwrap();
        assert_eq!(a.texts(), vec![json!({ "t": "leave", "s": b.slot })]);
        assert_eq!(b.texts(), vec![json!({ "t": "leave", "s": a.slot })]);
        // no chat either way, no positions, no map entries
        t.w.text(b.slot, r#"{"t":"chat","ch":"g","text":"you can't hide"}"#, t.now).unwrap();
        t.w.text(a.slot, r#"{"t":"chat","ch":"n","text":"peace"}"#, t.now).unwrap();
        assert!(a.texts().iter().all(|m| m["name"] != "Troll"));
        assert!(b.texts().iter().all(|m| m["name"] != "Ann"));
        for _ in 0..COARSE_TICKS {
            t.later(100);
            t.at(&a, 0.0, 0.0);
            t.at(&b, 10.0, 0.0);
            t.w.tick(t.now);
        }
        for bin in a.bins() {
            assert!(!slots(&bin).contains(&b.slot));
        }
        for bin in b.bins() {
            assert!(!slots(&bin).contains(&a.slot));
        }
        // the block is kept for the next visit (same token), and the troll's old lines stay hidden
        let aid = t.id(&a);
        let (tx, mut rx) = mpsc::channel(64);
        let (slot, _) = t.w.connect(tx, 1, t.now);
        t.w.text(slot, &json!({ "t": "hello", "token": t.w.token(&aid), "colour": "#000000" }).to_string(), t.now).unwrap();
        let Out::Text(w) = rx.try_recv().unwrap() else { panic!() };
        let w: Value = serde_json::from_str(&w).unwrap();
        assert_eq!(w["blocks"], json!([bid]));
        assert!(w["chat"].as_array().unwrap().iter().all(|l| l["id"] != bid.as_str()));
        assert!(w["players"].as_array().unwrap().iter().all(|p| p["id"] != bid.as_str()));
        // unblocking shows them again
        t.w.text(a.slot, &json!({ "t": "unblock", "id": bid }).to_string(), t.now).unwrap();
        assert!(a.texts().iter().any(|m| m["t"] == "join" && m["s"] == b.slot));
    }

    #[test]
    fn stale_players_leave() {
        let mut t = T::new();
        let (a, mut b) = (t.join("Ann"), t.join("Ben"));
        t.at(&a, 0.0, 0.0);
        b.drain();
        t.later(11_000);
        t.w.tick(t.now);
        assert!(b.texts().iter().any(|m| m["t"] == "leave" && m["s"] == a.slot));
        assert!(t.w.clients[&a.slot].state.is_none());
    }
}
