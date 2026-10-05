//! Signed-in browsers (DECISIONS D55): a random token in an HttpOnly cookie,
//! kept in sessions.json only as its SHA-256, so the file does not sign
//! anyone in. A session lasts 30 days from sign-in; signing out, a new
//! password or a removed account ends it.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::users::{random_hex, write_private};

pub const LIFETIME: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    user: String,
    /// Seconds since 1970.
    expires: u64,
}

pub struct SessionStore {
    file: PathBuf,
    sessions: Mutex<HashMap<String, Session>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn digest(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl SessionStore {
    pub async fn open(data: &Path) -> Result<SessionStore, String> {
        let file = data.join("sessions.json");
        let sessions = match tokio::fs::read_to_string(&file).await {
            // A broken file signs everyone out, which is safe.
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => return Err(format!("{}: {error}", file.display())),
        };
        Ok(SessionStore {
            file,
            sessions: Mutex::new(sessions),
        })
    }

    async fn save(&self, sessions: &mut HashMap<String, Session>) -> Result<(), String> {
        let now = now();
        sessions.retain(|_, session| session.expires > now);
        let text = serde_json::to_string(sessions).map_err(|error| error.to_string())?;
        write_private(&self.file, &text).await
    }

    /// Signs `user` in; returns the token for the cookie.
    pub async fn create(&self, user: &str) -> Result<String, String> {
        let token = random_hex(32);
        let mut sessions = self.sessions.lock().await;
        sessions.insert(
            digest(&token),
            Session {
                user: user.to_string(),
                expires: now() + LIFETIME.as_secs(),
            },
        );
        self.save(&mut sessions).await?;
        Ok(token)
    }

    /// The user signed in with `token`, while the session lasts.
    pub async fn user(&self, token: &str) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(&digest(token))
            .filter(|session| session.expires > now())
            .map(|session| session.user.clone())
    }

    pub async fn remove(&self, token: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        if sessions.remove(&digest(token)).is_some() {
            self.save(&mut sessions).await?;
        }
        Ok(())
    }

    /// Signs `user` out everywhere.
    pub async fn remove_user(&self, user: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, session| session.user != user);
        self.save(&mut sessions).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn signs_in_and_out_and_keeps_only_digests() {
        let data = tempfile::tempdir().unwrap();
        let store = SessionStore::open(data.path()).await.unwrap();
        let token = store.create("u1").await.unwrap();
        let other = store.create("u1").await.unwrap();
        assert_eq!(store.user(&token).await.as_deref(), Some("u1"));
        assert!(store.user("not a token").await.is_none());

        let saved = std::fs::read_to_string(data.path().join("sessions.json")).unwrap();
        assert!(!saved.contains(&token));

        let reopened = SessionStore::open(data.path()).await.unwrap();
        assert_eq!(reopened.user(&token).await.as_deref(), Some("u1"));
        reopened.remove(&token).await.unwrap();
        assert!(reopened.user(&token).await.is_none());
        assert!(reopened.user(&other).await.is_some());
        reopened.remove_user("u1").await.unwrap();
        assert!(reopened.user(&other).await.is_none());
    }
}
