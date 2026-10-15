//! The accounts (DECISIONS D55): users.json in the data directory, a name,
//! an id that names the user's directory, and an Argon2 hash of the password.
//! A user's directory holds `scores/`, all the page may touch, and `studio/`,
//! the settings, playback setups and recent list of the app's userData.
use std::path::{Path, PathBuf};

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

pub const MIN_PASSWORD: usize = 8;
const MAX_PASSWORD: usize = 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct User {
    pub name: String,
    pub id: String,
    hash: String,
    /// Milliseconds since 1970.
    pub created: u64,
}

/// The accounts, read again whenever users.json changes: `user add` and
/// `user remove` change it while the server runs.
pub struct UserStore {
    file: PathBuf,
    users: Mutex<Loaded>,
}

struct Loaded {
    users: Vec<User>,
    modified: Option<std::time::SystemTime>,
}

async fn modified(file: &Path) -> Option<std::time::SystemTime> {
    tokio::fs::metadata(file).await.ok()?.modified().ok()
}

async fn read_users(file: &Path) -> Result<Vec<User>, String> {
    match tokio::fs::read_to_string(file).await {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("{} is broken: {error}", file.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("{}: {error}", file.display())),
    }
}

pub fn user_dir(data: &Path, id: &str) -> PathBuf {
    data.join("users").join(id)
}

pub fn scores_dir(data: &Path, id: &str) -> PathBuf {
    user_dir(data, id).join("scores")
}

/// Lower-case letters, digits, `.`, `_` and `-`, 2 to 32 of them, starting with a letter or digit.
pub fn check_name(name: &str) -> Result<(), String> {
    let valid = (2..=32).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c));
    if valid {
        Ok(())
    } else {
        Err("A name is 2 to 32 lower-case letters, digits, dots, dashes or underscores.".into())
    }
}

pub fn check_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD {
        return Err(format!(
            "A password has at least {MIN_PASSWORD} characters."
        ));
    }
    if password.len() > MAX_PASSWORD {
        return Err("That password is too long.".into());
    }
    Ok(())
}

fn hash(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| error.to_string())
}

fn verify(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|parsed| {
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
}

/// 16 random bytes as hex: a user's id, or a session's token.
pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buffer);
    buffer.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Writes `text` beside `file` and renames it over, so a crash never leaves half a file;
/// readable by the server's user only.
pub async fn write_private(file: &Path, text: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let partial = file.with_extension("partial");
    tokio::fs::write(&partial, text)
        .await
        .map_err(|error| format!("{}: {error}", partial.display()))?;
    tokio::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o600))
        .await
        .map_err(|error| format!("{}: {error}", partial.display()))?;
    tokio::fs::rename(&partial, file)
        .await
        .map_err(|error| format!("{}: {error}", file.display()))
}

impl UserStore {
    /// Reads users.json; a missing one is no users, a broken one an error.
    pub async fn open(data: &Path) -> Result<UserStore, String> {
        let file = data.join("users.json");
        let modified = modified(&file).await;
        let users = read_users(&file).await?;
        Ok(UserStore {
            file,
            users: Mutex::new(Loaded { users, modified }),
        })
    }

    /// The accounts as users.json has them now; a file broken since keeps the last good ones.
    async fn current(&self) -> tokio::sync::MutexGuard<'_, Loaded> {
        let mut loaded = self.users.lock().await;
        let now = modified(&self.file).await;
        if now != loaded.modified {
            match read_users(&self.file).await {
                Ok(users) => {
                    *loaded = Loaded {
                        users,
                        modified: now,
                    }
                }
                Err(error) => eprintln!("{error}"),
            }
        }
        loaded
    }

    async fn save(&self, loaded: &mut Loaded, users: Vec<User>) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&users).map_err(|error| error.to_string())?;
        write_private(&self.file, &text).await?;
        *loaded = Loaded {
            users,
            modified: modified(&self.file).await,
        };
        Ok(())
    }

    pub async fn add(&self, name: &str, password: &str) -> Result<User, String> {
        check_name(name)?;
        check_password(password)?;
        let password = password.to_string();
        let hash = tokio::task::spawn_blocking(move || hash(&password))
            .await
            .map_err(|error| error.to_string())??;
        let mut loaded = self.current().await;
        if loaded.users.iter().any(|user| user.name == name) {
            return Err(format!("There is an account called {name} already."));
        }
        let user = User {
            name: name.to_string(),
            id: random_hex(16),
            hash,
            created: now_ms(),
        };
        let mut changed = loaded.users.clone();
        changed.push(user.clone());
        self.save(&mut loaded, changed).await?;
        Ok(user)
    }

    pub async fn set_password(&self, name: &str, password: &str) -> Result<User, String> {
        check_password(password)?;
        let password = password.to_string();
        let hash = tokio::task::spawn_blocking(move || hash(&password))
            .await
            .map_err(|error| error.to_string())??;
        let mut loaded = self.current().await;
        let mut changed = loaded.users.clone();
        let user = changed
            .iter_mut()
            .find(|user| user.name == name)
            .ok_or_else(|| format!("There is no account called {name}."))?;
        user.hash = hash;
        let user = user.clone();
        self.save(&mut loaded, changed).await?;
        Ok(user)
    }

    pub async fn remove(&self, name: &str) -> Result<User, String> {
        let mut loaded = self.current().await;
        let mut changed = loaded.users.clone();
        let index = changed
            .iter()
            .position(|user| user.name == name)
            .ok_or_else(|| format!("There is no account called {name}."))?;
        let user = changed.remove(index);
        self.save(&mut loaded, changed).await?;
        Ok(user)
    }

    pub async fn list(&self) -> Vec<User> {
        self.current().await.users.clone()
    }

    pub async fn by_id(&self, id: &str) -> Option<User> {
        self.current()
            .await
            .users
            .iter()
            .find(|user| user.id == id)
            .cloned()
    }

    /// The user whose name and password these are. An unknown name costs a
    /// hash too, so the time taken does not tell which names exist.
    pub async fn verify(&self, name: &str, password: &str) -> Option<User> {
        let user = self
            .current()
            .await
            .users
            .iter()
            .find(|user| user.name == name)
            .cloned();
        let password = password.to_string();
        let hash = user.as_ref().map(|user| user.hash.clone());
        let matched = tokio::task::spawn_blocking(move || match hash {
            Some(hash) => verify(&password, &hash),
            None => {
                let _ = self::hash(&password);
                false
            }
        })
        .await
        .unwrap_or(false);
        user.filter(|_| matched)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn adds_verifies_and_keeps_accounts_across_opens() {
        let data = tempfile::tempdir().unwrap();
        let store = UserStore::open(data.path()).await.unwrap();
        let ada = store.add("ada", "correct horse").await.unwrap();
        assert_eq!(ada.id.len(), 32);
        assert!(store.add("ada", "another one").await.is_err());
        assert!(store.add("Bad Name", "long enough").await.is_err());
        assert!(store.add("bo", "short").await.is_err());

        let again = UserStore::open(data.path()).await.unwrap();
        assert_eq!(
            again.verify("ada", "correct horse").await.map(|u| u.id),
            Some(ada.id.clone())
        );
        assert!(again.verify("ada", "wrong horse").await.is_none());
        assert!(again.verify("nobody", "correct horse").await.is_none());

        again.set_password("ada", "battery staple").await.unwrap();
        assert!(again.verify("ada", "correct horse").await.is_none());
        assert!(again.verify("ada", "battery staple").await.is_some());

        again.remove("ada").await.unwrap();
        assert!(again.by_id(&ada.id).await.is_none());

        // Another process (`user add`) adds an account: the running store sees it.
        let other = UserStore::open(data.path()).await.unwrap();
        let bo = other.add("bo", "long enough").await.unwrap();
        assert_eq!(again.by_id(&bo.id).await.map(|u| u.name), Some("bo".into()));

        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(data.path().join("users.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn names_are_plain() {
        assert!(check_name("ada").is_ok());
        assert!(check_name("j.s.bach-1685").is_ok());
        for bad in ["a", "-ada", "Ada", "ad a", "../x", "ada/b", &"a".repeat(33)] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
    }
}
