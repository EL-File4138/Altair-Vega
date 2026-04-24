use crate::FileDescriptor;
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_SYNC_CHUNK_SIZE_BYTES: u32 = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncEntryState {
    File(FileDescriptor),
    Tombstone,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncEntry {
    pub path: String,
    pub modified_unix_ms: u64,
    pub state: SyncEntryState,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncManifest {
    pub entries: BTreeMap<String, SyncEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncAction {
    UpsertFile {
        path: String,
        entry: SyncEntry,
    },
    DeletePath {
        path: String,
    },
    CreateConflictCopy {
        original_path: String,
        conflict_path: String,
        entry: SyncEntry,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncConflictResolution {
    KeepLocal,
    CreateRemoteConflictCopy { conflict_path: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncConflict {
    pub path: String,
    pub resolution: SyncConflictResolution,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncMergePlan {
    pub actions: Vec<SyncAction>,
    pub conflicts: Vec<SyncConflict>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncChangeKind {
    Added,
    Updated,
    Deleted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncChange {
    pub path: String,
    pub kind: SyncChangeKind,
}

pub fn with_tombstones(
    previous: &SyncManifest,
    current: &SyncManifest,
    tombstone_unix_ms: u64,
) -> SyncManifest {
    let mut merged = current.clone();
    for (path, previous_entry) in &previous.entries {
        if previous_entry.is_tombstone() {
            continue;
        }
        if merged.entries.contains_key(path) {
            continue;
        }
        merged.insert(SyncEntry::tombstone(path.clone(), tombstone_unix_ms));
    }
    merged
}

pub fn manifests_state_eq(left: &SyncManifest, right: &SyncManifest) -> bool {
    let mut keys = BTreeSet::new();
    keys.extend(left.entries.keys().cloned());
    keys.extend(right.entries.keys().cloned());
    keys.into_iter()
        .all(|path| entry_state_eq(left.get(&path), right.get(&path)))
}

pub fn unix_time_now_ms() -> u64 {
    system_time_to_unix_ms(SystemTime::now()).unwrap_or_default()
}

pub fn apply_merge_plan(local_root: &Path, remote_root: &Path, plan: &SyncMergePlan) -> Result<()> {
    for action in &plan.actions {
        match action {
            SyncAction::UpsertFile { path, entry } => {
                let SyncEntryState::File(descriptor) = &entry.state else {
                    continue;
                };
                copy_verified_file(&remote_root.join(path), &local_root.join(path), descriptor)?;
            }
            SyncAction::DeletePath { path } => {
                let target = local_root.join(path);
                if target.exists() {
                    fs::remove_file(&target)
                        .with_context(|| format!("remove synced file {}", target.display()))?;
                    prune_empty_parent_dirs(local_root, &target)?;
                }
            }
            SyncAction::CreateConflictCopy {
                original_path,
                conflict_path,
                entry,
            } => {
                let SyncEntryState::File(descriptor) = &entry.state else {
                    continue;
                };
                copy_verified_file(
                    &remote_root.join(original_path),
                    &local_root.join(conflict_path),
                    descriptor,
                )?;
            }
        }
    }
    Ok(())
}

pub fn diff_manifests(previous: &SyncManifest, current: &SyncManifest) -> Vec<SyncChange> {
    let mut keys = BTreeSet::new();
    keys.extend(previous.entries.keys().cloned());
    keys.extend(current.entries.keys().cloned());

    let mut changes = Vec::new();
    for path in keys {
        let before = previous.get(&path);
        let after = current.get(&path);
        let kind = match (before, after) {
            (None, Some(after)) if !after.is_tombstone() => Some(SyncChangeKind::Added),
            (Some(_), None) => Some(SyncChangeKind::Deleted),
            (Some(before), Some(after)) if !entry_state_eq(Some(before), Some(after)) => {
                Some(if after.is_tombstone() {
                    SyncChangeKind::Deleted
                } else {
                    SyncChangeKind::Updated
                })
            }
            _ => None,
        };

        if let Some(kind) = kind {
            changes.push(SyncChange { path, kind });
        }
    }
    changes
}

impl SyncEntry {
    pub fn file(
        path: impl Into<String>,
        descriptor: FileDescriptor,
        modified_unix_ms: u64,
    ) -> Self {
        Self {
            path: path.into(),
            modified_unix_ms,
            state: SyncEntryState::File(descriptor),
        }
    }

    pub fn tombstone(path: impl Into<String>, modified_unix_ms: u64) -> Self {
        Self {
            path: path.into(),
            modified_unix_ms,
            state: SyncEntryState::Tombstone,
        }
    }

    pub fn is_tombstone(&self) -> bool {
        matches!(self.state, SyncEntryState::Tombstone)
    }
}

impl SyncManifest {
    pub fn new(entries: impl IntoIterator<Item = SyncEntry>) -> Self {
        let mut manifest = Self::default();
        for entry in entries {
            manifest.insert(entry);
        }
        manifest
    }

    pub fn insert(&mut self, entry: SyncEntry) {
        self.entries.insert(entry.path.clone(), entry);
    }

    pub fn get(&self, path: &str) -> Option<&SyncEntry> {
        self.entries.get(path)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

pub fn scan_directory(root: &Path, chunk_size_bytes: u32) -> Result<SyncManifest> {
    let mut entries = Vec::new();
    collect_entries(root, root, chunk_size_bytes, &mut entries)?;
    Ok(SyncManifest::new(entries))
}

pub fn merge_manifests(
    base: &SyncManifest,
    local: &SyncManifest,
    remote: &SyncManifest,
) -> SyncMergePlan {
    let mut keys = BTreeSet::new();
    keys.extend(base.entries.keys().cloned());
    keys.extend(local.entries.keys().cloned());
    keys.extend(remote.entries.keys().cloned());

    let mut plan = SyncMergePlan::default();
    for path in keys {
        let base_entry = base.get(&path);
        let local_entry = local.get(&path);
        let remote_entry = remote.get(&path);

        if entry_state_eq(local_entry, remote_entry) {
            continue;
        }

        let local_changed = !entry_state_eq(local_entry, base_entry);
        let remote_changed = !entry_state_eq(remote_entry, base_entry);

        match (local_changed, remote_changed) {
            (false, false) => {}
            (false, true) => apply_remote_change(&path, remote_entry, &mut plan),
            (true, false) => {}
            (true, true) => resolve_conflict(&path, local_entry, remote_entry, &mut plan),
        }
    }

    plan
}

fn apply_remote_change(path: &str, remote_entry: Option<&SyncEntry>, plan: &mut SyncMergePlan) {
    match remote_entry {
        Some(entry) if !entry.is_tombstone() => plan.actions.push(SyncAction::UpsertFile {
            path: path.to_string(),
            entry: entry.clone(),
        }),
        Some(_) | None => plan.actions.push(SyncAction::DeletePath {
            path: path.to_string(),
        }),
    }
}

fn resolve_conflict(
    path: &str,
    local_entry: Option<&SyncEntry>,
    remote_entry: Option<&SyncEntry>,
    plan: &mut SyncMergePlan,
) {
    match (local_entry, remote_entry) {
        (Some(local), Some(remote)) if local.is_tombstone() && remote.is_tombstone() => {}
        (Some(local), Some(remote)) if local == remote => {}
        (Some(local), Some(remote)) if local.is_tombstone() && !remote.is_tombstone() => {
            let conflict_path = conflict_copy_path(path, remote);
            plan.conflicts.push(SyncConflict {
                path: path.to_string(),
                resolution: SyncConflictResolution::CreateRemoteConflictCopy {
                    conflict_path: conflict_path.clone(),
                },
            });
            plan.actions.push(SyncAction::CreateConflictCopy {
                original_path: path.to_string(),
                conflict_path,
                entry: remote.clone(),
            });
        }
        (Some(local), Some(remote)) if !local.is_tombstone() && remote.is_tombstone() => {
            plan.conflicts.push(SyncConflict {
                path: path.to_string(),
                resolution: SyncConflictResolution::KeepLocal,
            });
        }
        (Some(_), Some(remote)) if !remote.is_tombstone() => {
            let conflict_path = conflict_copy_path(path, remote);
            plan.conflicts.push(SyncConflict {
                path: path.to_string(),
                resolution: SyncConflictResolution::CreateRemoteConflictCopy {
                    conflict_path: conflict_path.clone(),
                },
            });
            plan.actions.push(SyncAction::CreateConflictCopy {
                original_path: path.to_string(),
                conflict_path,
                entry: remote.clone(),
            });
        }
        (Some(_), None) => {
            plan.conflicts.push(SyncConflict {
                path: path.to_string(),
                resolution: SyncConflictResolution::KeepLocal,
            });
        }
        (None, Some(remote)) if !remote.is_tombstone() => {
            let conflict_path = conflict_copy_path(path, remote);
            plan.conflicts.push(SyncConflict {
                path: path.to_string(),
                resolution: SyncConflictResolution::CreateRemoteConflictCopy {
                    conflict_path: conflict_path.clone(),
                },
            });
            plan.actions.push(SyncAction::CreateConflictCopy {
                original_path: path.to_string(),
                conflict_path,
                entry: remote.clone(),
            });
        }
        _ => {}
    }
}

fn collect_entries(
    root: &Path,
    current: &Path,
    chunk_size_bytes: u32,
    entries: &mut Vec<SyncEntry>,
) -> Result<()> {
    let mut paths = fs::read_dir(current)
        .with_context(|| format!("read sync directory {}", current.display()))?
        .map(|entry| {
            entry
                .map(|item| item.path())
                .with_context(|| format!("read sync entry under {}", current.display()))
        })
        .collect::<Result<Vec<_>>>()?;
    paths.sort();

    for path in paths {
        let metadata =
            fs::metadata(&path).with_context(|| format!("stat sync path {}", path.display()))?;
        if should_ignore_sync_path(&path, metadata.is_dir()) {
            continue;
        }
        if metadata.is_dir() {
            collect_entries(root, &path, chunk_size_bytes, entries)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }

        let relative = normalize_relative_path(root, &path)?;
        let descriptor = build_file_descriptor(&path, &relative, chunk_size_bytes)?;
        let modified_unix_ms = metadata
            .modified()
            .ok()
            .and_then(system_time_to_unix_ms)
            .unwrap_or_default();
        entries.push(SyncEntry::file(relative, descriptor, modified_unix_ms));
    }
    Ok(())
}

fn build_file_descriptor(
    path: &Path,
    relative_path: &str,
    chunk_size_bytes: u32,
) -> Result<FileDescriptor> {
    let mut file =
        fs::File::open(path).with_context(|| format!("open sync file {}", path.display()))?;
    let mut hasher = blake3::Hasher::new();
    let mut size_bytes = 0u64;
    let mut buf = vec![0u8; 64 * 1024];

    loop {
        let read = file
            .read(&mut buf)
            .with_context(|| format!("read sync file {}", path.display()))?;
        if read == 0 {
            break;
        }
        size_bytes += read as u64;
        hasher.update(&buf[..read]);
    }

    Ok(FileDescriptor {
        name: relative_path.to_string(),
        size_bytes,
        hash: *hasher.finalize().as_bytes(),
        chunk_size_bytes,
    })
}

fn copy_verified_file(source: &Path, target: &Path, descriptor: &FileDescriptor) -> Result<()> {
    let actual = build_file_descriptor(source, &descriptor.name, descriptor.chunk_size_bytes)
        .with_context(|| format!("hash source file {}", source.display()))?;
    ensure!(
        actual.size_bytes == descriptor.size_bytes && actual.hash == descriptor.hash,
        "source file {} does not match expected descriptor",
        source.display()
    );

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create sync target parent {}", parent.display()))?;
    }

    let tmp = target.with_extension("altair-tmp");
    fs::copy(source, &tmp).with_context(|| {
        format!(
            "copy synced file from {} to {}",
            source.display(),
            tmp.display()
        )
    })?;
    fs::rename(&tmp, target)
        .with_context(|| format!("finalize synced file {}", target.display()))?;
    Ok(())
}

fn prune_empty_parent_dirs(root: &Path, path: &Path) -> Result<()> {
    let mut current = path.parent();
    while let Some(dir) = current {
        if dir == root {
            break;
        }
        if fs::read_dir(dir)
            .with_context(|| format!("read parent dir {}", dir.display()))?
            .next()
            .is_some()
        {
            break;
        }
        fs::remove_dir(dir).with_context(|| format!("remove empty dir {}", dir.display()))?;
        current = dir.parent();
    }
    Ok(())
}

fn normalize_relative_path(root: &Path, path: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(root)
        .with_context(|| format!("compute sync relative path for {}", path.display()))?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let value = component
            .as_os_str()
            .to_str()
            .ok_or_else(|| anyhow!("sync path contains non-utf8 component"))?;
        if value == "." || value.is_empty() {
            continue;
        }
        if value == ".." {
            bail!("sync path escapes root");
        }
        parts.push(value);
    }
    Ok(parts.join("/"))
}

fn should_ignore_sync_path(path: &Path, is_dir: bool) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if is_dir {
        return name == ".git" || name.starts_with(".altair-sync-");
    }
    name.contains(".altair-conflict-")
}

fn system_time_to_unix_ms(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn conflict_copy_path(path: &str, remote: &SyncEntry) -> String {
    let suffix = match &remote.state {
        SyncEntryState::File(descriptor) => descriptor.hash[..4]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
        SyncEntryState::Tombstone => "delete".to_string(),
    };
    let path = PathBuf::from(path);
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let ext = path.extension().and_then(|value| value.to_str());
    let conflict_name = match ext {
        Some(ext) if !ext.is_empty() => format!("{stem}.altair-conflict-{suffix}.{ext}"),
        _ => format!("{stem}.altair-conflict-{suffix}"),
    };
    let conflict_path = if parent.as_os_str().is_empty() {
        PathBuf::from(conflict_name)
    } else {
        parent.join(conflict_name)
    };
    conflict_path.to_string_lossy().replace('\\', "/")
}

fn entry_state_eq(left: Option<&SyncEntry>, right: Option<&SyncEntry>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left.state == right.state,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_SYNC_CHUNK_SIZE_BYTES, SyncAction, SyncChange, SyncChangeKind,
        SyncConflictResolution, SyncEntry, SyncManifest, apply_merge_plan, diff_manifests,
        merge_manifests, scan_directory, unix_time_now_ms, with_tombstones,
    };
    use crate::FileDescriptor;
    use std::{fs, path::Path};
    use tempfile::TempDir;

    #[test]
    fn scans_nested_directories_into_manifest() {
        let temp = TempDir::new().unwrap();
        let nested = temp.path().join("docs");
        fs::create_dir_all(&nested).unwrap();
        fs::write(temp.path().join("alpha.txt"), b"alpha").unwrap();
        fs::write(nested.join("beta.txt"), b"beta").unwrap();

        let manifest = scan_directory(temp.path(), DEFAULT_SYNC_CHUNK_SIZE_BYTES).unwrap();
        assert_eq!(manifest.len(), 2);
        assert!(manifest.get("alpha.txt").is_some());
        assert!(manifest.get("docs/beta.txt").is_some());
    }

    #[test]
    fn applies_remote_add_when_local_is_unchanged() {
        let base = SyncManifest::default();
        let local = SyncManifest::default();
        let remote_entry = file_entry("docs/readme.txt", 1);
        let remote = SyncManifest::new([remote_entry.clone()]);

        let plan = merge_manifests(&base, &local, &remote);
        assert_eq!(
            plan.actions,
            vec![SyncAction::UpsertFile {
                path: "docs/readme.txt".to_string(),
                entry: remote_entry,
            }]
        );
        assert!(plan.conflicts.is_empty());
    }

    #[test]
    fn applies_remote_delete_when_local_is_unchanged() {
        let base_entry = file_entry("docs/readme.txt", 1);
        let base = SyncManifest::new([base_entry.clone()]);
        let local = SyncManifest::new([base_entry]);
        let remote = SyncManifest::new([SyncEntry::tombstone("docs/readme.txt", 2)]);

        let plan = merge_manifests(&base, &local, &remote);
        assert_eq!(
            plan.actions,
            vec![SyncAction::DeletePath {
                path: "docs/readme.txt".to_string(),
            }]
        );
        assert!(plan.conflicts.is_empty());
    }

    #[test]
    fn keeps_local_changes_when_remote_is_unchanged() {
        let base_entry = file_entry("docs/readme.txt", 1);
        let base = SyncManifest::new([base_entry.clone()]);
        let local = SyncManifest::new([file_entry("docs/readme.txt", 2)]);
        let remote = SyncManifest::new([base_entry]);

        let plan = merge_manifests(&base, &local, &remote);
        assert!(plan.actions.is_empty());
        assert!(plan.conflicts.is_empty());
    }

    #[test]
    fn creates_conflict_copy_for_divergent_updates() {
        let base_entry = file_entry("docs/readme.txt", 1);
        let base = SyncManifest::new([base_entry.clone()]);
        let local = SyncManifest::new([file_entry("docs/readme.txt", 2)]);
        let remote_entry = file_entry("docs/readme.txt", 3);
        let remote = SyncManifest::new([remote_entry.clone()]);

        let plan = merge_manifests(&base, &local, &remote);
        assert_eq!(plan.actions.len(), 1);
        assert!(matches!(
            &plan.actions[0],
            SyncAction::CreateConflictCopy {
                original_path,
                conflict_path,
                entry
            } if original_path == "docs/readme.txt"
                && conflict_path.contains("altair-conflict")
                && entry == &remote_entry
        ));
        assert_eq!(plan.conflicts.len(), 1);
        assert!(matches!(
            &plan.conflicts[0].resolution,
            SyncConflictResolution::CreateRemoteConflictCopy { conflict_path }
                if conflict_path.contains("altair-conflict")
        ));
    }

    #[test]
    fn records_keep_local_conflict_when_remote_deleted() {
        let base_entry = file_entry("docs/readme.txt", 1);
        let base = SyncManifest::new([base_entry.clone()]);
        let local = SyncManifest::new([file_entry("docs/readme.txt", 2)]);
        let remote = SyncManifest::new([SyncEntry::tombstone("docs/readme.txt", 3)]);

        let plan = merge_manifests(&base, &local, &remote);
        assert!(plan.actions.is_empty());
        assert_eq!(plan.conflicts.len(), 1);
        assert!(matches!(
            plan.conflicts[0].resolution,
            SyncConflictResolution::KeepLocal
        ));
    }

    #[test]
    fn treats_remote_change_after_reconnect_as_upsert() {
        let base_entry = file_entry("nested/file.txt", 1);
        let base = SyncManifest::new([base_entry.clone()]);
        let local = SyncManifest::new([base_entry]);
        let remote_entry = file_entry("nested/file.txt", 4);
        let remote = SyncManifest::new([remote_entry.clone()]);

        let plan = merge_manifests(&base, &local, &remote);
        assert_eq!(
            plan.actions,
            vec![SyncAction::UpsertFile {
                path: "nested/file.txt".to_string(),
                entry: remote_entry,
            }]
        );
    }

    #[test]
    fn applies_upsert_and_delete_actions_to_local_tree() {
        let local = TempDir::new().unwrap();
        let remote = TempDir::new().unwrap();
        fs::write(remote.path().join("docs.txt"), b"remote docs").unwrap();
        fs::write(local.path().join("stale.txt"), b"stale").unwrap();

        let remote_manifest = scan_directory(remote.path(), DEFAULT_SYNC_CHUNK_SIZE_BYTES).unwrap();
        let docs_entry = remote_manifest.get("docs.txt").unwrap().clone();
        let plan = super::SyncMergePlan {
            actions: vec![
                SyncAction::UpsertFile {
                    path: "docs.txt".to_string(),
                    entry: docs_entry,
                },
                SyncAction::DeletePath {
                    path: "stale.txt".to_string(),
                },
            ],
            conflicts: Vec::new(),
        };

        apply_merge_plan(local.path(), remote.path(), &plan).unwrap();
        assert_eq!(
            fs::read(local.path().join("docs.txt")).unwrap(),
            b"remote docs"
        );
        assert!(!local.path().join("stale.txt").exists());
    }

    #[test]
    fn creates_conflict_copy_file_on_apply() {
        let local = TempDir::new().unwrap();
        let remote = TempDir::new().unwrap();
        let nested = remote.path().join("docs");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("readme.txt"), b"remote version").unwrap();

        let remote_manifest = scan_directory(remote.path(), DEFAULT_SYNC_CHUNK_SIZE_BYTES).unwrap();
        let remote_entry = remote_manifest.get("docs/readme.txt").unwrap().clone();
        let conflict_path = "docs/readme.altair-conflict-test.txt".to_string();
        let plan = super::SyncMergePlan {
            actions: vec![SyncAction::CreateConflictCopy {
                original_path: "docs/readme.txt".to_string(),
                conflict_path: conflict_path.clone(),
                entry: remote_entry,
            }],
            conflicts: Vec::new(),
        };

        apply_merge_plan(local.path(), remote.path(), &plan).unwrap();
        assert_eq!(
            fs::read(local.path().join(conflict_path)).unwrap(),
            b"remote version"
        );
    }

    #[test]
    fn diffs_added_updated_and_deleted_entries() {
        let previous = SyncManifest::new([
            file_entry("same.txt", 1),
            file_entry("updated.txt", 2),
            file_entry("deleted.txt", 3),
        ]);
        let current = SyncManifest::new([
            file_entry("same.txt", 1),
            file_entry("updated.txt", 9),
            file_entry("added.txt", 4),
        ]);

        let changes = diff_manifests(&previous, &current);
        assert_eq!(
            changes,
            vec![
                SyncChange {
                    path: "added.txt".to_string(),
                    kind: SyncChangeKind::Added,
                },
                SyncChange {
                    path: "deleted.txt".to_string(),
                    kind: SyncChangeKind::Deleted,
                },
                SyncChange {
                    path: "updated.txt".to_string(),
                    kind: SyncChangeKind::Updated,
                },
            ]
        );
    }

    #[test]
    fn scan_ignores_conflict_and_state_paths() {
        let temp = TempDir::new().unwrap();
        let state_dir = temp.path().join(".altair-sync-state");
        let nested = temp.path().join("docs");
        fs::create_dir_all(&state_dir).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::write(temp.path().join("keep.txt"), b"keep").unwrap();
        fs::write(
            temp.path().join("readme.altair-conflict-deadbeef.txt"),
            b"conflict",
        )
        .unwrap();
        fs::write(state_dir.join("meta.json"), b"{}").unwrap();

        let manifest = scan_directory(temp.path(), DEFAULT_SYNC_CHUNK_SIZE_BYTES).unwrap();
        assert_eq!(manifest.len(), 1);
        assert!(manifest.get("keep.txt").is_some());
        assert!(
            manifest
                .get("readme.altair-conflict-deadbeef.txt")
                .is_none()
        );
    }

    #[test]
    fn adds_tombstones_for_missing_previous_entries() {
        let previous = SyncManifest::new([file_entry("gone.txt", 1), file_entry("keep.txt", 2)]);
        let current = SyncManifest::new([file_entry("keep.txt", 2)]);

        let merged = with_tombstones(&previous, &current, unix_time_now_ms());
        let gone = merged.get("gone.txt").unwrap();
        assert!(gone.is_tombstone());
        assert!(merged.get("keep.txt").is_some());
    }

    fn file_entry(path: &str, salt: u8) -> SyncEntry {
        let hash = blake3::hash(&[salt]).as_bytes().to_owned();
        SyncEntry::file(
            path,
            FileDescriptor {
                name: Path::new(path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or(path)
                    .to_string(),
                size_bytes: 1,
                hash,
                chunk_size_bytes: DEFAULT_SYNC_CHUNK_SIZE_BYTES,
            },
            u64::from(salt),
        )
    }
}
