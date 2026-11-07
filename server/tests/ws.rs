//! End to end over real sockets: two players see each other, chat, block; stats count the visits.
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use vancouver_live::world::{State, encode_state};

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn start() -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap().to_string();
    let cfg = vancouver_live::Config { db: ":memory:".into(), max_per_ip: 3, origins: vec!["https://vancouver.borodutch.com".into()] };
    tokio::spawn(vancouver_live::serve(l, cfg));
    addr
}

async fn open(addr: &str, path: &str, ua: &str) -> Result<Ws, String> {
    let mut req = format!("ws://{addr}{path}").into_client_request().unwrap();
    req.headers_mut().insert("user-agent", ua.parse().unwrap());
    req.headers_mut().insert("origin", "https://vancouver.borodutch.com".parse().unwrap());
    tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws).map_err(|e| e.to_string())
}

async fn hello(ws: &mut Ws, name: &str) -> Value {
    ws.send(Message::text(json!({ "t": "hello", "name": name, "colour": "#3366cc" }).to_string())).await.unwrap();
    next_json(ws, |m| m["t"] == "welcome").await
}

async fn next_json(ws: &mut Ws, want: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Ok(Message::Text(t))) = ws.next().await {
                let v: Value = serde_json::from_str(&t).unwrap();
                if want(&v) {
                    return v;
                }
            }
        }
    })
    .await
    .expect("message in time")
}

/// The slots in the next snapshot (binary type 1).
async fn next_snapshot(ws: &mut Ws) -> Vec<u32> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(Ok(Message::Binary(b))) = ws.next().await
                && b[0] == 1
            {
                let n = u16::from_le_bytes([b[1], b[2]]) as usize;
                return (0..n).map(|i| u32::from_le_bytes(b[3 + i * 21..7 + i * 21].try_into().unwrap())).collect();
            }
        }
    })
    .await
    .expect("snapshot in time")
}

async fn get(addr: &str, path: &str) -> String {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.0\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    out.split("\r\n\r\n").nth(1).unwrap_or("").to_string()
}

fn state(x: f32) -> Message {
    Message::binary(encode_state(&State { mode: 1, x, y: 5.0, z: 100.0, heading: 1.0, speed: 8.0 }))
}

#[tokio::test]
async fn two_players() {
    let addr = start().await;
    let mut a = open(&addr, "/live/ws", "browser A").await.unwrap();
    let mut b = open(&addr, "/ws", "browser B").await.unwrap(); // with the prefix stripped too
    let wa = hello(&mut a, "Ann").await;
    let wb = hello(&mut b, "Ben").await;
    assert_eq!(wb["stats"]["now"], 2);
    let (sa, sb) = (wa["s"].as_u64().unwrap() as u32, wb["s"].as_u64().unwrap() as u32);

    a.send(state(0.0)).await.unwrap();
    b.send(state(50.0)).await.unwrap();
    assert_eq!(next_json(&mut a, |m| m["t"] == "join").await["name"], "Ben");
    assert_eq!(next_snapshot(&mut a).await, vec![sb]);
    assert_eq!(next_snapshot(&mut b).await, vec![sa]);

    a.send(Message::text(r#"{"t":"chat","ch":"n","text":"hi Ben"}"#)).await.unwrap();
    assert_eq!(next_json(&mut b, |m| m["t"] == "chat").await["text"], "hi Ben");
    b.send(Message::text(r#"{"t":"chat","ch":"g","text":"hi Ann"}"#)).await.unwrap();
    assert_eq!(next_json(&mut a, |m| m["t"] == "chat" && m["text"] == "hi Ann").await["name"], "Ben");

    // Ann blocks Ben: he leaves her world and his chat no longer reaches her
    a.send(Message::text(json!({ "t": "block", "id": wb["id"] }).to_string())).await.unwrap();
    assert_eq!(next_json(&mut a, |m| m["t"] == "leave").await["s"], sb);
    b.send(Message::text(r#"{"t":"chat","ch":"g","text":"hello??"}"#)).await.unwrap();
    a.send(Message::text(r#"{"t":"chat","ch":"g","text":"quiet now"}"#)).await.unwrap();
    let got = next_json(&mut a, |m| m["t"] == "chat").await;
    assert_eq!(got["text"], "quiet now", "Ben's line was never sent to Ann");
    a.send(state(1.0)).await.unwrap();
    assert!(next_snapshot(&mut a).await.is_empty(), "no more of Ben's positions");

    // stats on both paths, two visitors (different browsers) today
    let s: Value = serde_json::from_str(&get(&addr, "/live/stats").await).unwrap();
    assert_eq!((s["now"].as_u64(), s["day"].as_u64(), s["week"].as_u64()), (Some(2), Some(2), Some(2)));
    assert_eq!(get(&addr, "/stats").await, get(&addr, "/live/stats").await);
    assert_eq!(get(&addr, "/live/health").await, "ok");
}

#[tokio::test]
async fn limits() {
    let addr = start().await;
    // three sockets per address, the fourth is refused
    let mut keep = vec![];
    for _ in 0..3 {
        keep.push(open(&addr, "/live/ws", "x").await.unwrap());
    }
    assert!(open(&addr, "/live/ws", "x").await.unwrap_err().contains("429"));
    drop(keep);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // a foreign page may not open it
    let mut req = format!("ws://{addr}/live/ws").into_client_request().unwrap();
    req.headers_mut().insert("origin", "https://evil.example".parse().unwrap());
    assert!(tokio_tungstenite::connect_async(req).await.unwrap_err().to_string().contains("403"));

    // oversized frames close the socket
    let mut a = open(&addr, "/live/ws", "y").await.unwrap();
    hello(&mut a, "Ann").await;
    a.send(Message::text("x".repeat(5000))).await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match a.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return true,
                _ => {}
            }
        }
    })
    .await;
    assert_eq!(closed, Ok(true));

    // a flood of junk gets kicked with a policy close
    let mut b = open(&addr, "/live/ws", "z").await.unwrap();
    hello(&mut b, "Bob").await;
    for _ in 0..40 {
        let _ = b.send(Message::text("{not json")).await;
    }
    let code = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match b.next().await {
                Some(Ok(Message::Close(Some(f)))) => return u16::from(f.code),
                None | Some(Err(_)) => return 0,
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(code, 1008);
}
