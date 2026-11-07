//! vancouver-live: visitor counts, multiplayer presence and chat for vancouver.borodutch.com.
//! Env: PORT (8080), DATA (/data/live.db), MAX_PER_IP (8), ORIGINS (space-separated allowed page origins).
#[tokio::main]
async fn main() {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    let cfg = vancouver_live::Config {
        db: env("DATA", "/data/live.db"),
        max_per_ip: env("MAX_PER_IP", "8").parse().expect("MAX_PER_IP"),
        origins: env("ORIGINS", vancouver_live::ORIGINS).split_whitespace().map(String::from).collect(),
    };
    let addr = format!("0.0.0.0:{}", env("PORT", "8080"));
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("binding the port");
    eprintln!("vancouver-live on {addr}, data in {}", cfg.db);
    vancouver_live::serve(listener, cfg).await;
}
