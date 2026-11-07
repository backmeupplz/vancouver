//! HTTP and WebSocket front of the live service. Routes answer both with and without the `/live`
//! prefix, so it works whether or not the proxy strips it:
//!   GET /live/stats   {now, day, week}
//!   GET /live/ws      WebSocket: presence (counts as a visit), multiplayer and chat (see world.rs)
//!   GET /live/health  ok
pub mod db;
pub mod text;
pub mod world;

use axum::Router;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use world::{Out, World};

/// Page origins allowed to open the socket by default (any port on the local ones, for development).
pub const ORIGINS: &str = "https://vancouver.borodutch.com http://127.0.0.1 http://localhost";

pub struct Config {
    pub db: String,
    pub max_per_ip: usize,
    pub origins: Vec<String>,
}

#[derive(Clone)]
struct App {
    // ponytail: one lock for the whole world (and its SQLite file); shard by area if hundreds of players ever make it hot
    world: Arc<Mutex<World>>,
    origins: Arc<Vec<String>>,
    ip_key: [u8; 16],
}

impl App {
    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.world.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn router(cfg: Config) -> Router {
    let db = db::Db::open(&cfg.db).expect("opening the database");
    let app = App { world: Arc::new(Mutex::new(World::new(db, cfg.max_per_ip))), origins: Arc::new(cfg.origins), ip_key: rand::random() };
    let w = app.world.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(world::TICK);
        t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            t.tick().await;
            w.lock().unwrap_or_else(|e| e.into_inner()).tick(Instant::now());
        }
    });
    let routes = Router::new().route("/stats", get(stats)).route("/ws", get(ws)).route("/health", get(|| async { "ok" }));
    Router::new().nest("/live", routes.clone()).merge(routes).with_state(app)
}

pub async fn serve(listener: tokio::net::TcpListener, cfg: Config) {
    let app = router(cfg).into_make_service_with_connect_info::<SocketAddr>();
    let stop = async {
        #[cfg(unix)]
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        #[cfg(unix)]
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
    };
    axum::serve(listener, app).with_graceful_shutdown(stop).await.expect("serving");
}

async fn stats(State(app): State<App>) -> Response {
    let s = app.world().stats();
    ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"), (header::CACHE_CONTROL, "no-store")], axum::Json(s)).into_response()
}

/// The visitor's address as the proxy saw it (Tugport sets X-Real-IP), else the socket's.
fn real_ip(h: &HeaderMap, peer: SocketAddr) -> String {
    let header = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).map(|v| v.split(',').next().unwrap_or("").trim().to_string()).filter(|v| !v.is_empty());
    header("x-real-ip").or_else(|| header("x-forwarded-for")).unwrap_or_else(|| peer.ip().to_string())
}

fn origin_ok(h: &HeaderMap, allowed: &[String]) -> bool {
    match h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        None => true, // not a browser; nothing to protect against there
        Some(o) => allowed.iter().any(|a| o == a || o.strip_prefix(a.as_str()).is_some_and(|rest| rest.starts_with(':') && a.starts_with("http://"))),
    }
}

async fn ws(State(app): State<App>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, up: WebSocketUpgrade) -> Response {
    if !origin_ok(&headers, &app.origins) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let ip = real_ip(&headers, peer);
    let ua = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("");
    // connections are limited per address; the limiter only keeps a keyed hash of it, in memory
    let key = u64::from_le_bytes(Sha256::new().chain_update(app.ip_key).chain_update(ip.as_bytes()).finalize()[..8].try_into().unwrap());
    {
        let mut w = app.world();
        if !w.admit(key) {
            return (StatusCode::TOO_MANY_REQUESTS, "too many connections").into_response();
        }
        w.visit(&ip, ua);
    }
    up.max_message_size(1024).max_frame_size(1024).on_upgrade(move |s| conn(s, app, key))
}

async fn conn(sock: WebSocket, app: App, key: u64) {
    let (mut sink, mut stream) = sock.split();
    let (tx, mut rx) = mpsc::channel::<Out>(256);
    let (slot, kill) = app.world().connect(tx.clone(), key, Instant::now());
    let writer = tokio::spawn(async move {
        while let Some(o) = rx.recv().await {
            let (m, last) = match o {
                Out::Text(t) => (Message::Text(t.into()), false),
                Out::Bin(b) => (Message::Binary(b), false),
                Out::Ping => (Message::Ping(Default::default()), false),
                Out::Close(code, why) => (Message::Close(Some(CloseFrame { code, reason: why.into() })), true),
            };
            if sink.send(m).await.is_err() || last {
                break;
            }
        }
    });
    let mut timer = tokio::time::interval(Duration::from_secs(15));
    timer.tick().await;
    let mut last_rx = Instant::now();
    let why: Option<world::Kick> = loop {
        tokio::select! {
            m = stream.next() => {
                let m = match m { Some(Ok(m)) => m, _ => break None };
                last_rx = Instant::now();
                let r = match m {
                    Message::Text(t) => app.world().text(slot, t.as_str(), last_rx),
                    Message::Binary(b) => app.world().binary(slot, &b, last_rx),
                    Message::Close(_) => break None,
                    _ => Ok(()),
                };
                if let Err(e) = r { break Some(e) }
                if kill.load(Ordering::Relaxed) { break Some("too slow") }
            }
            _ = timer.tick() => {
                if last_rx.elapsed() > Duration::from_secs(70) { break None } // pings go unanswered: gone
                if let Err(e) = app.world().check(slot, Instant::now()) { break Some(e) }
                let _ = tx.try_send(Out::Ping);
            }
        }
    };
    app.world().disconnect(slot);
    if let Some(why) = why {
        let _ = tx.try_send(Out::Close(1008, why));
    }
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(3), writer).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_and_origins() {
        let peer: SocketAddr = "10.0.0.2:5000".parse().unwrap();
        let mut h = HeaderMap::new();
        assert_eq!(real_ip(&h, peer), "10.0.0.2");
        h.insert("x-forwarded-for", "203.0.113.9, 10.0.0.1".parse().unwrap());
        assert_eq!(real_ip(&h, peer), "203.0.113.9");
        h.insert("x-real-ip", "198.51.100.7".parse().unwrap());
        assert_eq!(real_ip(&h, peer), "198.51.100.7");

        let allowed: Vec<String> = ORIGINS.split_whitespace().map(String::from).collect();
        let with = |o: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::ORIGIN, o.parse().unwrap());
            origin_ok(&h, &allowed)
        };
        assert!(with("https://vancouver.borodutch.com"));
        assert!(with("http://127.0.0.1:48500"));
        assert!(!with("https://vancouver.borodutch.com.evil.example"));
        assert!(!with("https://vancouver.borodutch.com:8443"));
        assert!(!with("http://127.0.0.1.evil.example"));
        assert!(origin_ok(&HeaderMap::new(), &allowed));
    }
}
