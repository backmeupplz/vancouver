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
//!   text   {"t":"run","board"}                           a scored run starts: answered {"t":"ticket","board","n"} (see RULES)
//!   text   {"t":"score","board","v","n"?}                 a finished run's score, with the ticket's n (kept if it is their best; per-day boards
//!                                                        (daily, d-*) also keep each day's best); read them at GET /live/boards
//!   binary [1][mode u8: 0 stopped, 1 car, 2 foot, 3 boat, 4 bus][x f32][y f32][z f32][heading i16 ×1e4][speed i16 ×100]   ≤ 10 Hz while playing
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

/// Parses a binary state message: None when malformed or, while playing (mode > 0), off the map; heading and
/// speed clamped to what they can be.
pub fn parse_state(b: &[u8]) -> Option<State> {
    if b.len() != 18 || b[0] != 1 || b[1] > 4 {
        return None;
    }
    let f = |i: usize| f32::from_le_bytes(b[i..i + 4].try_into().unwrap());
    let h = |i: usize| i16::from_le_bytes([b[i], b[i + 1]]) as f32;
    let s = State { mode: b[1], x: f(2), y: f(6), z: f(10), heading: h(14) / 1e4, speed: h(16) / 100.0 };
    if !(s.x.is_finite() && s.y.is_finite() && s.z.is_finite()) {
        return None;
    }
    let [x0, x1, z0, z1, y0, y1] = EXTENT;
    if s.mode > 0 && !((x0..=x1).contains(&s.x) && (z0..=z1).contains(&s.z) && (y0..=y1).contains(&s.y)) {
        return None;
    }
    Some(State { heading: s.heading.clamp(-std::f32::consts::PI, std::f32::consts::PI), speed: s.speed.clamp(-80.0, 80.0), ..s })
}

/// x, y, z, heading and speed as the wire has them (the client's state message, the server's snapshots)
fn put_state(b: &mut Vec<u8>, s: &State) {
    for v in [s.x, s.y, s.z] {
        b.extend(v.to_le_bytes());
    }
    b.extend(((s.heading * 1e4).round() as i16).to_le_bytes());
    b.extend(((s.speed * 100.0).round() as i16).to_le_bytes());
}

/// Encodes a state the way the client sends it (used by tests and the load script's twin).
pub fn encode_state(s: &State) -> Vec<u8> {
    let mut b = vec![1, s.mode];
    put_state(&mut b, s);
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
    scores: Bucket,
    run_rl: Bucket,
    runs: HashMap<String, (Instant, String)>, // run tickets by board: (server clock at the start, nonce); single use
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
    fn error(&self, msg: &str) {
        self.json(&json!({ "t": "error", "msg": msg }));
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
    Score { board: String, v: i64, n: Option<String> },
    Run { board: String },
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
    boards: Option<(String, Instant)>,
    /// seconds added to the clock (tests turn the day over with it)
    pub skew: i64,
    /// scored runs without a valid ticket are dropped (off while old pages are around; env REQUIRE_TICKETS)
    pub require_tickets: bool,
    ip_rl: HashMap<(u64, u8), Bucket>, // per (hashed address, kind) limits for tickets, scores and ghosts; memory only
}

/// What a scored board accepts. `per_sec` bounds v by `per_sec * elapsed + base`; `timed` boards (v falls with the
/// seconds, v = 600000 - ms) bound it by 600000 - 1000 * elapsed + 2000; `low` caps v % 1_000_000.
#[derive(Clone, Copy)]
pub struct Rule {
    pub min_secs: u64,
    pub max: i64,
    pub per_sec: f32,
    pub base: i64,
    pub timed: bool,
    pub ticket: bool,
    pub low: i64,
}
const R0: Rule = Rule { min_secs: 0, max: 0, per_sec: 0.0, base: 0, timed: false, ticket: true, low: 0 };
pub const RULES: &[(&str, Rule)] = &[
    ("delivery", Rule { min_secs: 120, max: 1_500, per_sec: 8.0, ..R0 }),
    ("taxi", Rule { min_secs: 45, max: 5_000, per_sec: 6.0, base: 50, ..R0 }),
    ("bus", Rule { min_secs: 120, max: 1_000, ..R0 }),
    ("sail", Rule { min_secs: 60, max: 2_000, ..R0 }),
    ("dock", Rule { min_secs: 20, max: 2_000, ..R0 }),
    ("hike", Rule { min_secs: 60, max: 1_200, per_sec: 1.2, ..R0 }),
    ("fish", Rule { max: 4_000, ticket: false, ..R0 }),
    ("daily", Rule { max: 3_999_999, ticket: false, low: 20_000, ..R0 }),
    ("d-dash", Rule { min_secs: 40, max: 600_000, timed: true, ..R0 }),
];
pub fn rule(board: &str) -> Option<&'static Rule> {
    RULES.iter().find(|(b, _)| *b == board).map(|(_, r)| r)
}
/// Boards that turn over at midnight (the day's best, plus an all-time best for the d-* ones).
pub fn per_day(board: &str) -> bool {
    board == "daily" || board.starts_with("d-")
}
const MAX_AGE: f32 = 3.0 * 3600.0; // a ticket older than this is stale
const MAX_TICKETS: usize = 8;

pub const MAX_SCORE: i64 = 10_000_000;

fn named(board: &str) -> bool {
    !board.is_empty() && board.len() <= 16 && board.bytes().enumerate().all(|(i, b)| b.is_ascii_lowercase() || (i > 0 && (b.is_ascii_digit() || b == b'-')))
}

/// A ghost blob (little endian): `[v i32][n u16][x0 f32][z0 f32]` then n × `[dx i16][dz i16][heading i8]` (decimetres from
/// the previous sample, one a second; the heading is radians × 127 / π). The shape, the length for the score's time
/// (a timed board's v = 600000 - ms: n within 40 %..100 % of that many seconds, plus 3), every step at most 45 m and
/// every point inside EXTENT. Returns its score.
pub fn ghost_ok(b: &[u8]) -> Option<i64> {
    if b.len() < 14 || b.len() > 2048 {
        return None;
    }
    let v = i32::from_le_bytes(b[0..4].try_into().ok()?) as i64;
    let n = u16::from_le_bytes(b[4..6].try_into().ok()?) as usize;
    if !(1..=240).contains(&n) || b.len() != 14 + 5 * n || !(0..=600_000).contains(&v) {
        return None;
    }
    let secs = (600_000 - v) as f32 / 1000.0;
    if n as f32 > secs + 3.0 || (n as f32) < 0.4 * secs {
        return None;
    }
    let f = |i: usize| f32::from_le_bytes(b[i..i + 4].try_into().unwrap());
    let (mut x, mut z) = (f(6), f(10));
    let [x0, x1, z0, z1, ..] = EXTENT;
    for i in 0..n {
        let o = 14 + 5 * i;
        let (dx, dz) = (i16::from_le_bytes([b[o], b[o + 1]]) as f32, i16::from_le_bytes([b[o + 2], b[o + 3]]) as f32);
        if dx.hypot(dz) > 450.0 {
            return None;
        }
        x += dx / 10.0;
        z += dz / 10.0;
        if !x.is_finite() || !z.is_finite() || !(x0..=x1).contains(&x) || !(z0..=z1).contains(&z) {
            return None;
        }
    }
    if !(x0..=x1).contains(&f(6)) || !(z0..=z1).contains(&f(10)) {
        return None;
    }
    Some(v)
}
/// The day of the daily challenges and their board, the same sum in the page (plugins/progress):
// ponytail: days turn at midnight Pacific Standard Time all year (1 am in summer); a tz database if that matters
pub fn day_of(unix: i64) -> i64 {
    (unix - 8 * 3600).div_euclid(86_400)
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}
fn unix() -> i64 {
    (unix_ms() / 1000) as i64
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
        World { clients: HashMap::new(), next: 1, ticks: 0, history: VecDeque::new(), per_ip: HashMap::new(), max_per_ip, hold: HashSet::new(), db, secret, stats: None, coarse_empty: true, sent_now: 0, boards: None, skew: 0, require_tickets: false, ip_rl: HashMap::new() }
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
                scores: b(0.2, 6.0),
                run_rl: b(0.2, 6.0),
                runs: HashMap::new(),
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
            In::Score { board, v, n } => return self.score(slot, &board, v, n.as_deref(), now),
            In::Run { board } => return self.run(slot, &board, now),
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
            return c.error("Wait a moment before changing that again.");
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
                    return self.clients[&slot].error("Couldn't save that, try again.");
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
            "n" => return c.error("Start exploring to talk to people near you."),
            _ => return,
        };
        let Some(text) = clean_text(text, CHAT_MAX) else { return };
        if !c.chats.take(now) {
            return c.error("Slow down a little.");
        }
        if c.last_chat.as_ref().is_some_and(|(t, at)| *t == text && now.duration_since(*at) < Duration::from_secs(30)) {
            return c.error("You just said that.");
        }
        c.last_chat = Some((text.clone(), now));
        let ts = unix_ms();
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

    fn day(&self) -> i64 {
        day_of(unix() + self.skew)
    }

    /// One more of `kind` for this address (a keyed hash)? Kept in memory only, bounded.
    fn ip_take(&mut self, ip: u64, kind: u8, rate: f32, burst: f32, now: Instant) -> bool {
        if self.ip_rl.len() > 4096 {
            self.ip_rl.clear();
        }
        self.ip_rl.entry((ip, kind)).or_insert_with(|| Bucket::new(rate, burst, now)).take(now)
    }

    /// A run starts: the server's clock starts a ticket for the board (one per board per connection, a new one
    /// replaces the old). Boards without a rule, or that need no ticket, answer nothing; too many are ignored.
    fn run(&mut self, slot: u32, board: &str, now: Instant) -> Result<(), Kick> {
        if !named(board) {
            return self.strike(slot, now);
        }
        let c = self.clients.get_mut(&slot).unwrap();
        let ip = c.ip;
        if !rule(board).is_some_and(|r| r.ticket) || !c.run_rl.take(now) {
            return Ok(());
        }
        if !self.ip_take(ip, 0, 1.0, 30.0, now) {
            return Ok(());
        }
        let c = self.clients.get_mut(&slot).unwrap();
        if c.runs.len() >= MAX_TICKETS && !c.runs.contains_key(board) {
            let old = c.runs.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone());
            if let Some(k) = old {
                c.runs.remove(&k);
            }
        }
        let n = format!("{:08x}", rand::random::<u32>());
        c.runs.insert(board.to_string(), (now, n.clone()));
        c.json(&json!({ "t": "ticket", "board": board, "n": n }));
        Ok(())
    }

    /// A run's score from the page, kept if it is the player's best on that board (per-day boards: that day's best
    /// and the all-time one). A board with a rule is checked against it, in silence (an honest old page is never
    /// kicked): too big; no ticket when one is needed (or one that was already used or is for another run); the
    /// server clock says it came too fast or too late; more than the board can pay for that long. Without a
    /// ticket (old pages, until `require_tickets`) a score under `max` is kept but not verified.
    fn score(&mut self, slot: u32, board: &str, v: i64, n: Option<&str>, now: Instant) -> Result<(), Kick> {
        if !named(board) || !(0..=MAX_SCORE).contains(&v) {
            return self.strike(slot, now);
        }
        let c = self.clients.get_mut(&slot).unwrap();
        let ip = c.ip;
        if !c.scores.take(now) {
            return Ok(()); // one every 5 s (6 at once): the page sends a best only when it is beaten
        }
        let ticket = c.runs.remove(board);
        let id = c.id.clone().unwrap();
        if !self.ip_take(ip, 1, 1.0, 30.0, now) {
            return Ok(());
        }
        let rule = rule(board);
        if v > rule.map_or(100_000, |r| r.max) || rule.is_some_and(|r| r.low > 0 && v % 1_000_000 > r.low) {
            return Ok(());
        }
        let mut ok = rule.is_some();
        if let Some(r) = rule.filter(|r| r.ticket) {
            ok = false;
            match ticket {
                Some((at, nonce)) => {
                    let e = now.saturating_duration_since(at).as_secs_f32();
                    let bound = if r.timed { 602_000.0 - 1000.0 * e } else if r.per_sec > 0.0 { r.per_sec * e + r.base as f32 } else { f32::MAX };
                    if n.is_some_and(|n| n != nonce) || e < r.min_secs as f32 || e > MAX_AGE || v as f32 > bound {
                        return Ok(());
                    }
                    ok = true;
                }
                None if self.require_tickets || n.is_some() => return Ok(()), // (a ticket named but already spent: a replay)
                None => {}
            }
        }
        let day = self.day();
        let now = unix() + self.skew;
        let mut days = vec![if per_day(board) { day } else { 0 }];
        if per_day(board) && board != "daily" {
            days.push(0); // the all-time best of a per-day board
        }
        for d in days {
            if let Err(e) = self.db.score(board, d, &id, v, ok, now) {
                eprintln!("score: {e}");
            }
        }
        self.boards = None;
        Ok(())
    }

    /// POST /live/ghost: the day's best run of a timed board, as a small path. 204, or 400 (shape), 401 (token),
    /// 403 (not today's top, verified score of that value), 429.
    pub fn ghost_put(&mut self, token: &str, board: &str, body: &[u8], ip: u64, now: Instant) -> u16 {
        let Some(id) = self.verify(token) else { return 401 };
        if !named(board) || !per_day(board) || !rule(board).is_some_and(|r| r.timed) {
            return 400;
        }
        let day = self.day();
        let Some(v) = ghost_ok(body) else { return 400 };
        match self.db.top(board, day) {
            Ok(Some((tid, tv, true))) if tid == id && tv == v => {}
            _ => return 403,
        }
        if !self.ip_take(ip, 2, 1.0 / 30.0, 1.0, now) {
            return 429; // (only a valid ghost costs the address its one per 30 s)
        }
        match self.db.put_ghost(board, day, &id, v, body) {
            Ok(()) => 204,
            Err(e) => {
                eprintln!("ghost: {e}");
                400
            }
        }
    }

    /// GET /live/ghost: (name, score, blob) of today's ghost.
    pub fn ghost_get(&self, board: &str) -> Option<(String, i64, Vec<u8>)> {
        let (id, name, v, data) = self.db.ghost(board, self.day()).ok()??;
        Some((name.unwrap_or_else(|| placeholder(&id)), v, data))
    }

    /// GET /live/boards: {"day", "boards": {board: [{"name","chosen","v"}]}}, the top 10 of each (names only, no ids),
    /// worked out at most every 5 s.
    pub fn boards(&mut self, now: Instant) -> String {
        if let Some((json, at)) = &self.boards
            && now.duration_since(*at) < Duration::from_secs(5)
        {
            return json.clone();
        }
        let day = self.day();
        // boards: the all-time ones, and today's for the per-day ones; all: every all-time one (the Top tab's second view)
        let (mut boards, mut all) = (serde_json::Map::new(), serde_json::Map::new());
        for (board, d, id, name, v, ok) in self.db.boards(day, 10).unwrap_or_default() {
            let row = json!({ "chosen": name.is_some(), "name": name.unwrap_or_else(|| placeholder(&id)), "v": v, "ok": ok });
            let put = |m: &mut serde_json::Map<String, Value>| m.entry(board.clone()).or_insert_with(|| json!([])).as_array_mut().unwrap().push(row.clone());
            if d == 0 {
                put(&mut all);
            }
            if d == day || (d == 0 && !per_day(&board)) {
                put(&mut boards);
            }
        }
        let json = json!({ "day": day, "boards": boards, "all": all }).to_string();
        self.boards = Some((json.clone(), now));
        json
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
                a.send(Out::Text(if is { leave_msg(b) } else { roster_msg(b) }.to_string()));
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
        let joined = c.state.is_none();
        if let Some(p) = c.state {
            // faster than a car (or a runner) can go: a respawn now and then is fine, else ignore it
            let dt = now.duration_since(c.state_at).as_secs_f32().max(0.05);
            let vmax = match (p.mode, s.mode) {
                (2, 2) => 15.0, // on foot
                (3, 3) => 12.0, // sailing
                (4, 4) => 25.0, // a bus (about 70 km/h flat out)
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

    /// msg to everyone else who has said hello and isn't blocked either way
    fn broadcast(&self, c: &Client, msg: &Value) {
        let msg = msg.to_string();
        for o in self.clients.values() {
            if o.slot != c.slot && o.id.is_some() && !hidden(c, o) {
                o.send(Out::Text(msg.clone()));
            }
        }
    }
    fn broadcast_join(&self, c: &Client) {
        self.broadcast(c, &roster_msg(c));
    }
    fn broadcast_leave(&self, c: &Client) {
        self.broadcast(c, &leave_msg(c));
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
                put_state(&mut buf, s);
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

fn leave_msg(c: &Client) -> Value {
    json!({ "t": "leave", "s": c.slot })
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
    #[test]
    fn scores_and_boards() {
        let mut t = T::new();
        let (a, b) = (t.join("Ada"), t.join("Ben"));
        let send = |t: &mut T, c: &C, board: &str, v: i64| t.w.text(c.slot, &json!({ "t": "score", "board": board, "v": v }).to_string(), t.now);
        send(&mut t, &a, "taxi", 300).unwrap();
        send(&mut t, &b, "taxi", 900).unwrap();
        send(&mut t, &a, "taxi", 100).unwrap(); // not their best
        send(&mut t, &a, "daily", 2_000_150).unwrap();
        let v: Value = serde_json::from_str(&t.w.boards(t.now)).unwrap();
        assert_eq!(v["boards"]["taxi"], json!([{ "name": "Ben", "chosen": true, "v": 900, "ok": false }, { "name": "Ada", "chosen": true, "v": 300, "ok": false }]));
        assert_eq!(v["boards"]["daily"][0]["v"], 2_000_150);
        assert_eq!(v["day"], day_of(unix()));
        assert!(!v.to_string().contains(&t.id(&a)), "no ids in the boards");
        // out of bounds or a bad board name: strikes, nothing stored; a flood is dropped quietly
        send(&mut t, &a, "taxi", MAX_SCORE + 1).unwrap();
        send(&mut t, &a, "taxi", -1).unwrap();
        send(&mut t, &a, "Taxi; DROP", 5).unwrap();
        for i in 0..20 {
            send(&mut t, &b, "bus", i).unwrap();
        }
        t.later(6000);
        let v: Value = serde_json::from_str(&t.w.boards(t.now)).unwrap();
        assert_eq!(v["boards"]["taxi"][1]["v"], 300);
        assert_eq!(v["boards"]["bus"][0]["v"], 4, "the bucket let 5 more through (0..=4)");
        assert_eq!(day_of(8 * 3600), 0);
        assert_eq!(day_of(8 * 3600 - 1), -1);
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
        // modes past 4 are refused
        t.later(1000);
        t.w.binary(a.slot, &encode_state(&State { mode: 5, x: 91.0, y: 1.0, z: 0.0, heading: 0.0, speed: 0.0 }), t.now).unwrap();
        assert_eq!(t.w.clients[&a.slot].state.unwrap().mode, 3);
    }

    #[test]
    fn buses() {
        let mut t = T::new();
        let a = t.join("Ann");
        let drive = |t: &mut T, x: f32| t.w.binary(a.slot, &encode_state(&State { mode: 4, x, y: 20.0, z: 0.0, heading: 0.0, speed: 15.0 }), t.now).unwrap();
        drive(&mut t, 0.0);
        assert_eq!(t.w.clients[&a.slot].state.unwrap().mode, 4);
        // 20 m/s down Broadway is fine
        t.later(1000);
        drive(&mut t, 20.0);
        assert_eq!(t.w.clients[&a.slot].state.unwrap().x, 20.0);
        // 60 m/s is no bus: after the respawns allowed, ignored
        for i in 1..=4 {
            t.later(1000);
            drive(&mut t, 20.0 + 60.0 * i as f32);
        }
        assert_eq!(t.w.clients[&a.slot].state.unwrap().x, 140.0, "two teleports allowed, then ignored");
        // and others see it as a bus
        let mut b = t.join("Bob");
        t.at(&b, 30.0, 0.0);
        t.w.tick(t.now);
        let near = b.bins().into_iter().find(|m| m[0] == 1).expect("a near list");
        assert_eq!(near[3 + 4 + 12 + 4], 4, "mode on the wire");
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

    // ---- run tickets, bounds, per-day boards, ghosts
    fn ticket(t: &mut T, c: &mut C, board: &str) -> String {
        t.w.text(c.slot, &json!({ "t": "run", "board": board }).to_string(), t.now).unwrap();
        let m = c.texts();
        assert_eq!((&m[0]["t"], &m[0]["board"]), (&json!("ticket"), &json!(board)));
        m[0]["n"].as_str().unwrap().to_string()
    }
    fn post(t: &mut T, c: &C, board: &str, v: i64, n: Option<&str>) {
        t.w.text(c.slot, &json!({ "t": "score", "board": board, "v": v, "n": n }).to_string(), t.now).unwrap();
    }
    fn rows(t: &mut T, key: &str, board: &str) -> Vec<(String, i64, bool)> {
        let v: Value = serde_json::from_str(&t.w.boards(t.now)).unwrap();
        v[key][board].as_array().cloned().unwrap_or_default().iter().map(|r| (r["name"].as_str().unwrap().to_string(), r["v"].as_i64().unwrap(), r["ok"].as_bool().unwrap())).collect()
    }

    #[test]
    fn tickets_accept_an_honest_run_and_reject_the_rest() {
        let mut t = T::new();
        let (mut a, mut b) = (t.join("Ada"), t.join("Ben"));
        // honest: a taxi run of 60 s worth 300 (bound 6 * 60 + 50)
        let n = ticket(&mut t, &mut a, "taxi");
        t.later(60_000);
        post(&mut t, &a, "taxi", 300, Some(&n));
        assert_eq!(rows(&mut t, "boards", "taxi"), vec![("Ada".into(), 300, true)]);
        // the same ticket again (a replay), with or without its n: nothing
        t.later(6000);
        post(&mut t, &a, "taxi", 400, Some(&n));
        post(&mut t, &a, "taxi", 400, None); // no n: an old page's message, kept but unverified, and below the verified best
        assert_eq!(rows(&mut t, "boards", "taxi"), vec![("Ada".into(), 300, true)]);
        // too fast: a 45 s minimum
        t.later(6000);
        let n = ticket(&mut t, &mut b, "taxi");
        t.later(10_000);
        post(&mut t, &b, "taxi", 100, Some(&n));
        assert_eq!(rows(&mut t, "boards", "taxi").len(), 1, "too fast");
        // over the bound for the time (6 * 50 + 50 = 350) and over the board's max
        let n = ticket(&mut t, &mut b, "taxi");
        t.later(50_000);
        post(&mut t, &b, "taxi", 351, Some(&n));
        t.later(6000);
        let n = ticket(&mut t, &mut b, "taxi");
        t.later(3600_000);
        post(&mut t, &b, "taxi", 5001, Some(&n));
        assert_eq!(rows(&mut t, "boards", "taxi").len(), 1, "bound and max");
        // a stale ticket (3 h) and a ticket for another run (wrong n)
        t.later(6000);
        let n = ticket(&mut t, &mut b, "delivery");
        t.later(4 * 3600_000);
        post(&mut t, &b, "delivery", 100, Some(&n));
        t.later(6000);
        let n = ticket(&mut t, &mut b, "delivery");
        t.later(130_000);
        post(&mut t, &b, "delivery", 100, Some("deadbeef"));
        assert!(rows(&mut t, "boards", "delivery").is_empty(), "stale and wrong n");
        // the wrong-n attempt spent the ticket: the right n now has none
        t.later(6000);
        post(&mut t, &b, "delivery", 100, Some(&n));
        assert!(rows(&mut t, "boards", "delivery").is_empty());
        // a fresh honest delivery, then a ticket for one board is no ticket for another
        t.later(6000);
        let n = ticket(&mut t, &mut b, "delivery");
        t.later(130_000);
        post(&mut t, &b, "bus", 100, Some(&n));
        post(&mut t, &b, "delivery", 100, Some(&n));
        assert_eq!(rows(&mut t, "boards", "delivery"), vec![("Ben".into(), 100, true)]);
        assert!(rows(&mut t, "boards", "bus").is_empty());
        // none of this kicked anyone
        assert!(t.w.clients.contains_key(&a.slot) && t.w.clients.contains_key(&b.slot));
    }

    #[test]
    fn unverified_scores_rank_below_verified_and_tickets_can_be_required() {
        let mut t = T::new();
        let (mut a, b) = (t.join("Ada"), t.join("Ben"));
        post(&mut t, &b, "taxi", 900, None); // an old page
        t.later(6000);
        let n = ticket(&mut t, &mut a, "taxi");
        t.later(60_000);
        post(&mut t, &a, "taxi", 100, Some(&n));
        assert_eq!(rows(&mut t, "boards", "taxi"), vec![("Ada".into(), 100, true), ("Ben".into(), 900, false)]);
        // unverified over the board's max: dropped even without a ticket; unknown boards cap at 100,000
        t.later(6000);
        post(&mut t, &b, "taxi", 5001, None);
        post(&mut t, &b, "zoo", 100_001, None);
        post(&mut t, &b, "zoo", 100_000, None);
        assert_eq!(rows(&mut t, "boards", "taxi").len(), 2);
        assert_eq!(rows(&mut t, "boards", "zoo"), vec![("Ben".into(), 100_000, false)]);
        t.w.require_tickets = true;
        t.later(6000);
        post(&mut t, &b, "taxi", 1000, None);
        assert_eq!(rows(&mut t, "boards", "taxi")[1].1, 900, "a missing ticket is dropped once required");
        post(&mut t, &b, "fish", 300, None); // fish and daily need no ticket
        assert_eq!(rows(&mut t, "boards", "fish"), vec![("Ben".into(), 300, true)]);
        post(&mut t, &b, "daily", 2_030_000, None); // %1e6 over 20,000
        assert!(rows(&mut t, "boards", "daily").is_empty());
    }

    #[test]
    fn tickets_are_rate_limited_and_capped() {
        let mut t = T::new();
        let mut a = t.join("Ada");
        for board in ["delivery", "taxi", "bus", "sail", "dock", "hike"] {
            ticket(&mut t, &mut a, board);
        }
        // the burst of 6 is spent: a 7th is ignored (no strike); boards without a rule or a ticket answer nothing
        t.w.text(a.slot, &json!({ "t": "run", "board": "d-dash" }).to_string(), t.now).unwrap();
        t.w.text(a.slot, &json!({ "t": "run", "board": "fish" }).to_string(), t.now).unwrap();
        assert!(a.texts().iter().all(|m| m["t"] != "ticket"));
        assert!(t.w.clients[&a.slot].runs.len() <= MAX_TICKETS);
        assert!(t.w.text(a.slot, &json!({ "t": "run", "board": "Taxi;" }).to_string(), t.now).is_ok(), "a bad name is a strike, not a kick (the first)");
        // per address: 30 at once across connections, then dropped
        let mut t = T::new();
        let mut got = 0;
        for name in ["Aaron", "Beth", "Cora", "Dale", "Edna", "Finn", "Gwen", "Hugo"] {
            let mut c = t.join(name);
            for _ in 0..6 {
                t.w.text(c.slot, &json!({ "t": "run", "board": "taxi" }).to_string(), t.now).unwrap();
            }
            got += c.texts().iter().filter(|m| m["t"] == "ticket").count();
            t.w.disconnect(c.slot);
        }
        assert!(got <= 31, "{got}");
    }

    #[test]
    fn per_day_boards_turn_over_with_the_day_and_keep_all_time() {
        let mut t = T::new();
        let mut a = t.join("Ada");
        let n = ticket(&mut t, &mut a, "d-dash");
        t.later(60_000);
        post(&mut t, &a, "d-dash", 540_000, Some(&n));
        assert_eq!(rows(&mut t, "boards", "d-dash"), vec![("Ada".into(), 540_000, true)]);
        assert_eq!(rows(&mut t, "all", "d-dash"), vec![("Ada".into(), 540_000, true)]);
        assert_eq!(rows(&mut t, "all", "taxi"), vec![], "taxi has no rows yet");
        // too good for the elapsed time on a timed board (v <= 600000 - 1000 * 60 + 2000 = 542000)
        t.later(6000);
        let n = ticket(&mut t, &mut a, "d-dash");
        t.later(60_000);
        post(&mut t, &a, "d-dash", 545_000, Some(&n));
        assert_eq!(rows(&mut t, "boards", "d-dash")[0].1, 540_000);
        // midnight: today's board is empty, the all-time one remembers; daily has no all-time rows
        t.w.skew += 86_400;
        t.later(6000);
        assert_eq!(rows(&mut t, "boards", "d-dash"), vec![]);
        assert_eq!(rows(&mut t, "all", "d-dash"), vec![("Ada".into(), 540_000, true)]);
        post(&mut t, &a, "daily", 1_000_100, None);
        assert_eq!(rows(&mut t, "boards", "daily").len(), 1);
        assert!(rows(&mut t, "all", "daily").is_empty());
        t.w.skew += 86_400;
        t.later(6000);
        assert!(rows(&mut t, "boards", "daily").is_empty());
    }

    fn blob(v: i64, steps: &[(i16, i16)], x0: f32, z0: f32) -> Vec<u8> {
        let mut b = (v as i32).to_le_bytes().to_vec();
        b.extend((steps.len() as u16).to_le_bytes());
        b.extend(x0.to_le_bytes());
        b.extend(z0.to_le_bytes());
        for (dx, dz) in steps {
            b.extend(dx.to_le_bytes());
            b.extend(dz.to_le_bytes());
            b.push(10);
        }
        b
    }

    #[test]
    fn ghosts_only_from_the_days_top_run_and_only_sane_paths() {
        let mut t = T::new();
        let (mut a, mut b) = (t.join("Ada"), t.join("Ben"));
        let (ta, tb) = (t.w.token(&t.id(&a)), t.w.token(&t.id(&b)));
        let n = ticket(&mut t, &mut a, "d-dash");
        t.later(60_000);
        post(&mut t, &a, "d-dash", 540_000, Some(&n)); // 60 s
        let good = blob(540_000, &vec![(100, 0); 60], 0.0, 0.0); // 10 m a second
        let now = t.now;
        assert_eq!(t.w.ghost_put("junk", "d-dash", &good, 1, now), 401);
        assert_eq!(t.w.ghost_put(&tb, "d-dash", &good, 2, now), 403, "Ben is not on the board");
        assert_eq!(t.w.ghost_put(&ta, "taxi", &good, 1, now), 400, "not a timed per-day board");
        assert_eq!(t.w.ghost_put(&ta, "d-dash", &blob(540_000, &vec![(600, 0); 60], 0.0, 0.0), 1, now), 400, "a 60 m step");
        t.later(31_000);
        let now = t.now;
        assert_eq!(t.w.ghost_put(&ta, "d-dash", &blob(540_000, &vec![(100, 0); 20], 0.0, 0.0), 1, now), 400, "20 samples for a 60 s run");
        t.later(31_000);
        let now = t.now;
        assert_eq!(t.w.ghost_put(&ta, "d-dash", &blob(540_000, &vec![(100, 0); 60], 1e9, 0.0), 1, now), 400, "outside the map");
        t.later(31_000);
        let now = t.now;
        assert_eq!(t.w.ghost_put(&ta, "d-dash", &blob(539_000, &vec![(100, 0); 60], 0.0, 0.0), 1, now), 403, "not the stored score");
        assert_eq!(t.w.ghost_put(&ta, "d-dash", &good, 1, now), 204);
        assert_eq!(t.w.ghost_put(&ta, "d-dash", &good, 1, now), 429, "one every 30 s per address");
        assert_eq!(t.w.ghost_get("d-dash"), Some(("Ada".to_string(), 540_000, good.clone())));
        assert_eq!(t.w.ghost_get("d-other"), None);
        // Ben beats Ada: only he may replace the ghost; the next day there is none
        t.later(6000);
        let n = ticket(&mut t, &mut b, "d-dash");
        t.later(60_000);
        post(&mut t, &b, "d-dash", 541_000, Some(&n));
        let now = t.now;
        assert_eq!(t.w.ghost_put(&ta, "d-dash", &good, 3, now), 403);
        let better = blob(541_000, &vec![(100, 0); 59], 0.0, 0.0);
        assert_eq!(t.w.ghost_put(&tb, "d-dash", &better, 4, now), 204);
        assert_eq!(t.w.ghost_get("d-dash").unwrap().0, "Ben");
        t.w.skew += 86_400;
        assert_eq!(t.w.ghost_get("d-dash"), None);
    }
}
