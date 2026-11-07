//! The small SQLite file on /data: the token secret, visitor counts, usernames and block lists.
//!
//! Privacy: raw addresses are never stored. A visitor is SHA-256(today's salt, address, user agent),
//! cut to 16 bytes. The salt is random and only today's is kept, so once a day is over its hashes
//! can no longer be linked to anyone, not even by us. Visits older than 8 days are deleted.
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

pub const DAY: i64 = 86_400;
/// A username can change once a minute (the old one is free again at once).
pub const RENAME_EVERY: i64 = 60;

/// What became of a username claim.
#[derive(Debug, PartialEq)]
pub enum Claim {
    Ok,
    /// someone else has it (or one that looks the same)
    Taken,
    /// changed too recently: seconds to wait
    Wait(i64),
}

pub struct Db {
    conn: Connection,
    salt: Option<(i64, [u8; 32])>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
pub struct Stats {
    /// open WebSocket connections
    pub now: usize,
    /// unique visitors seen in the last 24 hours
    pub day: i64,
    /// visitors seen in the last 7 days (unique per day: salts rotate daily, so a visitor who came on
    /// three days counts three times)
    pub week: i64,
}

impl Db {
    pub fn open(path: &str) -> rusqlite::Result<Db> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS salts (day INTEGER PRIMARY KEY, salt BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS visits (day INTEGER NOT NULL, hash BLOB NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY (day, hash));
             CREATE INDEX IF NOT EXISTS visits_seen ON visits (seen);
             CREATE TABLE IF NOT EXISTS blocks (owner TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (owner, target));
             CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE, at INTEGER NOT NULL);",
        )?;
        Ok(Db { conn, salt: None })
    }

    /// The key that signs identity tokens: made once, kept in the file.
    pub fn secret(&self) -> rusqlite::Result<[u8; 32]> {
        let old: Option<Vec<u8>> = self.conn.query_row("SELECT v FROM meta WHERE k = 'secret'", [], |r| r.get(0)).optional()?;
        if let Some(v) = old.filter(|v| v.len() == 32) {
            return Ok(v.try_into().unwrap());
        }
        let s: [u8; 32] = rand::random();
        self.conn.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('secret', ?1)", [&s[..]])?;
        Ok(s)
    }

    /// Today's salt; a new day makes a new one and forgets the old ones (and visits past 8 days).
    fn salt(&mut self, day: i64) -> rusqlite::Result<[u8; 32]> {
        if let Some((d, s)) = self.salt
            && d == day
        {
            return Ok(s);
        }
        let old: Option<Vec<u8>> = self.conn.query_row("SELECT salt FROM salts WHERE day = ?1", [day], |r| r.get(0)).optional()?;
        let s: [u8; 32] = match old.filter(|v| v.len() == 32) {
            Some(v) => v.try_into().unwrap(),
            None => {
                let s: [u8; 32] = rand::random();
                // another replica (a rolling deploy) may have made today's salt a moment ago: keep the first
                self.conn.execute("INSERT OR IGNORE INTO salts (day, salt) VALUES (?1, ?2)", params![day, &s[..]])?;
                self.conn.query_row("SELECT salt FROM salts WHERE day = ?1", [day], |r| r.get::<_, Vec<u8>>(0))?.try_into().unwrap_or(s)
            }
        };
        self.conn.execute("DELETE FROM salts WHERE day <> ?1", [day])?;
        self.conn.execute("DELETE FROM visits WHERE day < ?1", [day - 7])?;
        self.salt = Some((day, s));
        Ok(s)
    }

    /// Counts a visit from this address and browser at unix time `now`.
    pub fn visit(&mut self, ip: &str, ua: &str, now: i64) -> rusqlite::Result<()> {
        let day = now.div_euclid(DAY);
        let salt = self.salt(day)?;
        let mut h = Sha256::new();
        h.update(salt);
        h.update(ip.as_bytes());
        h.update([0]);
        h.update(ua.as_bytes());
        let hash = &h.finalize()[..16];
        self.conn.execute(
            "INSERT INTO visits (day, hash, seen) VALUES (?1, ?2, ?3) ON CONFLICT (day, hash) DO UPDATE SET seen = excluded.seen",
            params![day, hash, now],
        )?;
        Ok(())
    }

    /// (last 24 hours, last 7 days). A visitor whose visits span midnight UTC counts once per day.
    pub fn counts(&self, now: i64) -> rusqlite::Result<(i64, i64)> {
        let q = |since: i64| self.conn.query_row("SELECT COUNT(*) FROM visits WHERE seen > ?1", [since], |r| r.get::<_, i64>(0));
        Ok((q(now - DAY)?, q(now - 7 * DAY)?))
    }

    /// A user's chosen name, if they have one.
    pub fn username(&self, id: &str) -> rusqlite::Result<Option<String>> {
        self.conn.query_row("SELECT name FROM users WHERE id = ?1", [id], |r| r.get(0)).optional()
    }

    /// Who has the name with this key (see text::name_key).
    pub fn name_owner(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn.query_row("SELECT id FROM users WHERE key = ?1", [key], |r| r.get(0)).optional()
    }

    /// Gives `id` the name `name` (already checked with text::username; `key` its name_key) at unix time
    /// `now`. Unique by key: the UNIQUE index settles a race between two replicas too.
    pub fn claim(&mut self, id: &str, name: &str, key: &str, now: i64) -> rusqlite::Result<Claim> {
        let tx = self.conn.transaction()?;
        let mine: Option<(String, i64)> = tx.query_row("SELECT name, at FROM users WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some((old, at)) = &mine {
            if old == name {
                return Ok(Claim::Ok); // no change
            }
            if now - at < RENAME_EVERY {
                return Ok(Claim::Wait(RENAME_EVERY - (now - at)));
            }
        }
        let owner: Option<String> = tx.query_row("SELECT id FROM users WHERE key = ?1", [key], |r| r.get(0)).optional()?;
        if owner.is_some_and(|o| o != id) {
            return Ok(Claim::Taken);
        }
        let r = tx.execute(
            "INSERT INTO users (id, name, key, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, at = excluded.at",
            params![id, name, key, now],
        );
        match r {
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => return Ok(Claim::Taken),
            r => r?,
        };
        tx.commit()?;
        Ok(Claim::Ok)
    }

    /// Ids from before usernames (16 hex digits) to their UUIDs, in the block lists. Idempotent.
    pub fn migrate_ids(&self, to_uuid: impl Fn(&str) -> String) -> rusqlite::Result<usize> {
        let old: Vec<(String, String)> = {
            let mut st = self.conn.prepare("SELECT owner, target FROM blocks WHERE length(owner) = 16 OR length(target) = 16")?;
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?
        };
        let map = |id: &str| if id.len() == 16 { to_uuid(id) } else { id.to_string() };
        for (o, t) in &old {
            self.conn.execute("INSERT OR IGNORE INTO blocks (owner, target) VALUES (?1, ?2)", [map(o), map(t)])?;
            self.conn.execute("DELETE FROM blocks WHERE owner = ?1 AND target = ?2", [o, t])?;
        }
        Ok(old.len())
    }

    pub fn blocks(&self, owner: &str) -> rusqlite::Result<Vec<String>> {
        let mut st = self.conn.prepare_cached("SELECT target FROM blocks WHERE owner = ?1 LIMIT 1000")?;
        st.query_map([owner], |r| r.get(0))?.collect()
    }

    pub fn set_block(&self, owner: &str, target: &str, on: bool) -> rusqlite::Result<()> {
        if on {
            self.conn.execute("INSERT OR IGNORE INTO blocks (owner, target) VALUES (?1, ?2)", [owner, target])?;
        } else {
            self.conn.execute("DELETE FROM blocks WHERE owner = ?1 AND target = ?2", [owner, target])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counting() {
        let mut db = Db::open(":memory:").unwrap();
        let t0 = 1_800_000_000 - 1_800_000_000 % DAY + 3600; // 01:00 UTC on some day
        db.visit("1.2.3.4", "Firefox", t0).unwrap();
        db.visit("1.2.3.4", "Firefox", t0 + 60).unwrap(); // same person, same day: once
        db.visit("1.2.3.4", "Chrome", t0 + 60).unwrap(); // another browser: another visitor
        db.visit("5.6.7.8", "Firefox", t0 + 120).unwrap();
        assert_eq!(db.counts(t0 + 200).unwrap(), (3, 3));
        // two days later: the 24 h window is empty, the week still has them; then a returning visitor
        let t2 = t0 + 2 * DAY;
        assert_eq!(db.counts(t2).unwrap(), (0, 3));
        db.visit("1.2.3.4", "Firefox", t2).unwrap();
        assert_eq!(db.counts(t2 + 1).unwrap(), (1, 4));
        // nothing raw is stored, and only today's salt is kept
        let n: i64 = db.conn.query_row("SELECT COUNT(*) FROM salts", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let ips: i64 = db.conn.query_row("SELECT COUNT(*) FROM visits WHERE instr(hash, CAST('1.2.3.4' AS BLOB)) > 0", [], |r| r.get(0)).unwrap();
        assert_eq!(ips, 0);
        // nine days on, the first day's visits are gone
        db.visit("9.9.9.9", "x", t0 + 9 * DAY).unwrap();
        let days: i64 = db.conn.query_row("SELECT COUNT(DISTINCT day) FROM visits", [], |r| r.get(0)).unwrap();
        assert_eq!(days, 2);
        assert_eq!(db.counts(t0 + 9 * DAY).unwrap(), (1, 1)); // the visit two days in is exactly 7 days old
    }

    #[test]
    fn blocks_and_secret() {
        let db = Db::open(":memory:").unwrap();
        assert_eq!(db.secret().unwrap(), db.secret().unwrap());
        db.set_block("a", "b", true).unwrap();
        db.set_block("a", "b", true).unwrap();
        db.set_block("a", "c", true).unwrap();
        db.set_block("a", "c", false).unwrap();
        assert_eq!(db.blocks("a").unwrap(), vec!["b".to_string()]);
        assert!(db.blocks("b").unwrap().is_empty());
    }

    #[test]
    fn usernames_persist_and_wait() {
        let path = std::env::temp_dir().join(format!("live-test-{}.db", std::process::id()));
        let path = path.to_str().unwrap();
        let _ = std::fs::remove_file(path);
        let t = 1_800_000_000;
        {
            let mut db = Db::open(path).unwrap();
            assert_eq!(db.claim("u1", "Heron", "heron", t).unwrap(), Claim::Ok);
            assert_eq!(db.claim("u2", "HERON", "heron", t).unwrap(), Claim::Taken);
            assert_eq!(db.claim("u1", "heron", "heron", t + 1).unwrap(), Claim::Wait(59)); // a minute between changes
            assert_eq!(db.claim("u1", "Heron", "heron", t + 1).unwrap(), Claim::Ok); // the same name again is no change
            assert_eq!(db.claim("u1", "Osprey", "osprey", t + 60).unwrap(), Claim::Ok);
            assert_eq!(db.claim("u2", "Heron", "heron", t + 61).unwrap(), Claim::Ok); // the old one is free at once
        }
        // a restart keeps them
        let db = Db::open(path).unwrap();
        assert_eq!(db.username("u1").unwrap().as_deref(), Some("Osprey"));
        assert_eq!(db.username("u2").unwrap().as_deref(), Some("Heron"));
        assert_eq!(db.name_owner("osprey").unwrap().as_deref(), Some("u1"));
        assert_eq!(db.username("nobody").unwrap(), None);
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn legacy_ids_move_to_uuids() {
        let db = Db::open(":memory:").unwrap();
        db.set_block("0123456789abcdef", "fedcba9876543210", true).unwrap();
        db.set_block("0123456789abcdef", "00000000-0000-4000-8000-000000000000", true).unwrap();
        let to = |id: &str| format!("uuid-of-{id}");
        assert_eq!(db.migrate_ids(to).unwrap(), 2);
        let mut b = db.blocks("uuid-of-0123456789abcdef").unwrap();
        b.sort();
        assert_eq!(b, vec!["00000000-0000-4000-8000-000000000000".to_string(), "uuid-of-fedcba9876543210".to_string()]);
        assert!(db.blocks("0123456789abcdef").unwrap().is_empty());
        assert_eq!(db.migrate_ids(to).unwrap(), 0);
    }
}
