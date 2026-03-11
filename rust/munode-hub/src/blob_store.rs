//! Filesystem-based blob storage for the Hub server.
//!
//! Blobs are stored as individual files under a configurable base directory.
//! Each blob is identified by its SHA-256 hex digest and stored at:
//!
//! ```text
//! <base_dir>/<hash[0..2]>/<hash>
//! ```
//!
//! This two-character prefix sharding keeps directory sizes manageable.
//! Writes are atomic: data is written to a temporary file then renamed into place,
//! so a crash mid-write cannot leave a corrupt blob.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tracing::{debug, info};

/// Statistics reported by `BlobStore::stats`.
#[derive(Debug, Clone)]
pub struct BlobStoreStats {
    /// Total number of stored blobs.
    pub total_blobs: u64,
    /// Total size of all blobs on disk (bytes).
    pub total_size: u64,
}

/// Content-addressed, filesystem-backed blob storage.
///
/// Thread-safe: all methods take `&self`.
#[derive(Debug, Clone)]
pub struct BlobStore {
    base_dir: PathBuf,
}

impl BlobStore {
    /// Create (or open) a blob store rooted at `base_dir`.
    /// The directory is created if it does not already exist.
    pub fn open(base_dir: impl AsRef<Path>) -> Result<Self> {
        let base_dir = base_dir.as_ref().to_path_buf();
        fs::create_dir_all(&base_dir)
            .with_context(|| format!("Failed to create blob store directory: {}", base_dir.display()))?;
        info!("Blob store opened at {}", base_dir.display());
        Ok(Self { base_dir })
    }

    /// Return the file path for a given hash.
    fn blob_path(&self, hash: &str) -> PathBuf {
        // Guard against path-traversal (hashes are hex so this should never trigger,
        // but be defensive).
        let safe = hash.chars().filter(|c| c.is_ascii_hexdigit()).take(64).collect::<String>();
        let prefix = &safe[..2.min(safe.len())];
        self.base_dir.join(prefix).join(&safe)
    }

    /// Store `data` and return its SHA-256 hex hash.
    ///
    /// If a blob with the same hash already exists the write is skipped (idempotent).
    pub fn put(&self, data: &[u8]) -> Result<String> {
        let hash = sha256_hex(data);
        let path = self.blob_path(&hash);

        if path.exists() {
            debug!("Blob {} already exists, skipping write", hash);
            return Ok(hash);
        }

        // Ensure shard directory exists
        let shard_dir = path.parent().expect("blob path has a parent");
        fs::create_dir_all(shard_dir)
            .with_context(|| format!("Failed to create shard dir {}", shard_dir.display()))?;

        // Atomic write: write to temp file then rename
        let tmp_path = path.with_extension("tmp");
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&tmp_path)
                .with_context(|| format!("Failed to create temp file {}", tmp_path.display()))?;
            f.write_all(data)
                .with_context(|| format!("Failed to write blob data to {}", tmp_path.display()))?;
            f.flush()?;
        }
        fs::rename(&tmp_path, &path)
            .with_context(|| format!("Failed to rename {} → {}", tmp_path.display(), path.display()))?;

        debug!("Stored blob {} ({} bytes)", hash, data.len());
        Ok(hash)
    }

    /// Retrieve a blob by its SHA-256 hex hash.
    ///
    /// Returns `None` if the blob does not exist.
    pub fn get(&self, hash: &str) -> Result<Option<Vec<u8>>> {
        let path = self.blob_path(hash);
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)
            .with_context(|| format!("Failed to read blob {}", hash))?;
        Ok(Some(data))
    }

    /// Check whether a blob exists without reading its data.
    pub fn exists(&self, hash: &str) -> bool {
        self.blob_path(hash).exists()
    }

    /// Delete a blob.  Returns `Ok(())` even if the blob does not exist.
    pub fn delete(&self, hash: &str) -> Result<()> {
        let path = self.blob_path(hash);
        if path.exists() {
            fs::remove_file(&path)
                .with_context(|| format!("Failed to delete blob {}", hash))?;
        }
        Ok(())
    }

    /// Return aggregate statistics for the blob store.
    pub fn stats(&self) -> Result<BlobStoreStats> {
        let mut total_blobs: u64 = 0;
        let mut total_size: u64 = 0;

        if !self.base_dir.exists() {
            return Ok(BlobStoreStats { total_blobs, total_size });
        }

        // Walk one level of shard directories then count files
        for shard in fs::read_dir(&self.base_dir)? {
            let shard = shard?;
            if !shard.file_type()?.is_dir() {
                continue;
            }
            for entry in fs::read_dir(shard.path())? {
                let entry = entry?;
                let ft = entry.file_type()?;
                if ft.is_file() {
                    total_blobs += 1;
                    total_size += entry.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }

        Ok(BlobStoreStats { total_blobs, total_size })
    }
}

/// SHA-256 hex digest of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    use ring::digest;
    let digest = digest::digest(&digest::SHA256, data);
    digest.as_ref().iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_store() -> (TempDir, BlobStore) {
        let dir = TempDir::new().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        (dir, store)
    }

    #[test]
    fn test_put_and_get() {
        let (_dir, store) = temp_store();
        let data = b"hello world";
        let hash = store.put(data).unwrap();
        assert_eq!(hash.len(), 64); // SHA-256 hex = 64 chars
        let retrieved = store.get(&hash).unwrap().unwrap();
        assert_eq!(retrieved, data);
    }

    #[test]
    fn test_idempotent_put() {
        let (_dir, store) = temp_store();
        let data = b"duplicate content";
        let h1 = store.put(data).unwrap();
        let h2 = store.put(data).unwrap();
        assert_eq!(h1, h2);
        let stats = store.stats().unwrap();
        assert_eq!(stats.total_blobs, 1);
    }

    #[test]
    fn test_exists_and_delete() {
        let (_dir, store) = temp_store();
        let data = b"deleteme";
        let hash = store.put(data).unwrap();
        assert!(store.exists(&hash));
        store.delete(&hash).unwrap();
        assert!(!store.exists(&hash));
        // double-delete is safe
        store.delete(&hash).unwrap();
    }

    #[test]
    fn test_get_missing() {
        let (_dir, store) = temp_store();
        let result = store.get("aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_shard_structure() {
        let (_dir, store) = temp_store();
        let data = b"shard test";
        let hash = store.put(data).unwrap();
        let expected_path = store.base_dir.join(&hash[..2]).join(&hash);
        assert!(expected_path.exists());
    }

    #[test]
    fn test_stats() {
        let (_dir, store) = temp_store();
        let s0 = store.stats().unwrap();
        assert_eq!(s0.total_blobs, 0);
        store.put(b"one").unwrap();
        store.put(b"two").unwrap();
        store.put(b"one").unwrap(); // duplicate
        let s1 = store.stats().unwrap();
        assert_eq!(s1.total_blobs, 2);
        assert!(s1.total_size > 0);
    }
}
