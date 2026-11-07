//! Everyone connected, what they may send and who sees what. No sockets here: each client is a
//! channel of `Out` messages, so the rules are tested without a network.
//!
//! Protocol (WebSocket, same origin, `/live/ws`). Positions are binary because they are nearly all
//! of the traffic (10 Hz per player, to every player nearby): a state is 18 bytes and a snapshot
//! entry 21, against ~90 bytes as JSON. Everything rare (hello, chat, blocks, roster) is small JSON.
//!
//! client → server
//!   text   {"t":"hello","token"?,"name","colour"}        first message, within 10 s
//!   text   {"t":"name","name","colour"}
//!   text   {"t":"chat","ch":"g"|"n","text"}              global, or players within 1.5 km
//!   text   {"t":"block","id"} / {"t":"unblock","id"}
//!   binary [1][mode u8: 0 stopped, 1 car, 2 foot][x f32][y f32][z f32][heading i16 ×1e4][speed i16 ×100]   ≤ 10 Hz while playing
//! server → client
//!   text   {"t":"welcome","s","id","token","name","colour","blocks":[id],"players":[{s,id,name,colour}],"chat":[…],"stats"}
//!   text   {"t":"join","s","id","name","colour"} / {"t":"leave","s"}   players starting / stopping (or renamed)
//!   text   {"t":"chat","ch","id","name","colour","text","ts"} / {"t":"you","name","colour"} / {"t":"stats",…} / {"t":"error","msg"}
//!   binary [1][n u16] n × [slot u32][x f32][y f32][z f32][heading i16][speed i16][mode u8]   10 Hz: players within 1.5 km, nearest 64
//!   binary [2][n u16] n × [slot u32][x f32][z f32][mode u8]                                  every 2 s: every player, for the map
//! All numbers little-endian; x east, z south, y up, metres (three.js world of the page).
use crate::db::{Db, Stats};
use crate::text::{clean_colour, clean_name, clean_text};
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
const MAX_NEAR: usize = 64; // at most this many in one snapshot (the nearest)
const COARSE_TICKS: u64 = 20; // the map list every 2 s
const STATS_TICKS: u64 = 300; // visitor counts every 30 s, or every 5 s while the number online changes
const STALE: Duration = Duration::from_secs(10); // a player silent this long has stopped
const HELLO_WITHIN: Duration = Duration::from_secs(10);
const HISTORY: usize = 30; // global lines a newcomer gets
pub const CHAT_MAX: usize = 200; // characters
const MAX_BLOCKS: usize = 1000;
const MAX_TOTAL: usize = 5000; // connections
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
    if b.len() != 18 || b[0] != 1 || b[1] > 2 {
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
    pub id: Option<String>, // set by hello
    pub name: String,
    colour: String,
    pub blocks: HashSet<String>,
    pub state: Option<State>,
    state_at: Instant,
    last_n: usize, // players in the last snapshot sent
    msgs: Bucket,
    states: Bucket,
    chats: Bucket,
    names: Bucket,
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
    Hello { token: Option<String>, name: String, colour: String },
    Name { name: String, colour: String },
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
        World { clients: HashMap::new(), next: 1, ticks: 0, history: VecDeque::new(), per_ip: HashMap::new(), max_per_ip, db, secret, stats: None, coarse_empty: true, sent_now: 0 }
    }

    // ------------------------------------------------------------------ identity tokens
    fn mac(&self, id: &str) -> Hmac<Sha256> {
        let mut m = Hmac::<Sha256>::new_from_slice(&self.secret).unwrap();
        m.update(id.as_bytes());
        m
    }
    /// `id.signature`: the id is 16 random hex digits, the signature HMAC-SHA256 of it (first 16 bytes).
    pub fn token(&self, id: &str) -> String {
        format!("{id}.{}", hex(&self.mac(id).finalize().into_bytes()[..16]))
    }
    /// The id a token carries, when it is ours.
    pub fn verify(&self, token: &str) -> Option<String> {
        let (id, sig) = token.split_once('.')?;
        if !valid_id(id) || sig.len() != 32 {
            return None;
        }
        let bytes: Vec<u8> = (0..16).map(|i| u8::from_str_radix(&sig[i * 2..i * 2 + 2], 16)).collect::<Result<_, _>>().ok()?;
        self.mac(id).verify_truncated_left(&bytes).ok().map(|_| id.to_string())
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
                colour: String::new(),
                blocks: HashSet::new(),
                state: None,
                state_at: now,
                last_n: 0,
                msgs: b(30.0, 60.0),
                states: b(12.0, 20.0),
                chats: b(0.5, 4.0),
                names: b(0.3, 3.0),
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
            In::Hello { token, name, colour } if !hello => self.hello(slot, token, &name, &colour),
            _ if !hello => return self.strike(slot, now),
            In::Hello { .. } => return self.strike(slot, now),
            In::Name { name, colour } => self.rename(slot, &name, &colour, now),
            In::Chat { ch, text } => self.chat(slot, &ch, &text, now),
            In::Block { id } => return self.block(slot, &id, true, now),
            In::Unblock { id } => return self.block(slot, &id, false, now),
        }
        Ok(())
    }

    fn hello(&mut self, slot: u32, token: Option<String>, name: &str, colour: &str) {
        let id = token.and_then(|t| self.verify(&t)).unwrap_or_else(|| hex(&rand::random::<[u8; 8]>()));
        let blocks: HashSet<String> = self.db.blocks(&id).unwrap_or_default().into_iter().collect();
        let token = self.token(&id);
        let stats = self.stats();
        let c = self.clients.get_mut(&slot).unwrap();
        c.name = clean_name(name).unwrap_or_else(|| format!("Guest {}", &id[..4]));
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
        c.json(&json!({ "t": "welcome", "s": slot, "id": id, "token": token, "name": c.name, "colour": c.colour, "blocks": blocks, "players": players, "chat": chat, "stats": stats }));
    }

    fn rename(&mut self, slot: u32, name: &str, colour: &str, now: Instant) {
        let c = self.clients.get_mut(&slot).unwrap();
        if !c.names.take(now) {
            return c.json(&json!({ "t": "error", "msg": "Wait a moment before changing your name again." }));
        }
        let Some(name) = clean_name(name) else {
            return c.json(&json!({ "t": "error", "msg": "That name is not allowed: use 2–20 letters or digits." }));
        };
        c.name = name;
        if let Some(col) = clean_colour(colour) {
            c.colour = col;
        }
        c.json(&json!({ "t": "you", "name": c.name, "colour": c.colour }));
        if c.state.is_some() {
            let c = &self.clients[&slot];
            self.broadcast_join(c);
        }
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
        let line = json!({ "t": "chat", "ch": ch, "id": c.id, "name": c.name, "colour": c.colour, "text": text, "ts": ts }).to_string();
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
            let vmax = if s.mode == 2 && p.mode == 2 { 15.0 } else { 70.0 }; // m/s on foot, else by van
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
        let players: Vec<&Client> = self.clients.values().filter(|c| c.state.is_some()).take(4000).collect();
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

fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn roster(c: &Client) -> Value {
    json!({ "s": c.slot, "id": c.id, "name": c.name, "colour": c.colour })
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
            self.w.text(slot, &json!({ "t": "hello", "name": name, "colour": "#112233" }).to_string(), self.now).unwrap();
            let mut c = C { slot, rx };
            assert_eq!(c.texts()[0]["t"], "welcome");
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
        let tok = t.w.token("0123456789abcdef");
        assert_eq!(t.w.verify(&tok).as_deref(), Some("0123456789abcdef"));
        let forged = format!("fedcba9876543210{}", &tok[16..]);
        assert_eq!(t.w.verify(&forged), None);
        assert_eq!(t.w.verify("nonsense"), None);
    }

    #[test]
    fn same_token_same_id() {
        let mut t = T::new();
        let a = t.join("Alice");
        let id = t.id(&a);
        let tok = t.w.token(&id);
        let (tx, mut rx) = mpsc::channel(64);
        let (slot, _) = t.w.connect(tx, 1, t.now);
        t.w.text(slot, &json!({ "t": "hello", "token": tok, "name": "Alice", "colour": "x" }).to_string(), t.now).unwrap();
        let Out::Text(w) = rx.try_recv().unwrap() else { panic!() };
        let w: Value = serde_json::from_str(&w).unwrap();
        assert_eq!(w["id"], id);
        assert_eq!(w["colour"], "#f2a07e"); // a bad colour falls back
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
        t.w.text(slot, &json!({ "t": "hello", "token": t.w.token(&aid), "name": "Ann", "colour": "#000000" }).to_string(), t.now).unwrap();
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
