use altair_vega::{
    SyncAction, SyncEntry, SyncEntryState, SyncManifest, SyncMergePlan, merge_manifests,
    scan_directory, unix_time_now_ms, with_tombstones,
};
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use iroh::{Endpoint, endpoint::presets, protocol::Router};
use iroh_blobs::{
    ALPN as BLOBS_ALPN, BlobFormat, BlobsProtocol, HashAndFormat,
    api::Store as BlobsStore,
    api::blobs::{AddPathOptions, ImportMode},
    store::fs::FsStore,
};
use iroh_docs::{
    ALPN as DOCS_ALPN, DocTicket,
    api::{
        Doc,
        protocol::{AddrInfoOptions, ShareMode},
    },
    protocol::Docs,
    store::Query,
};
use iroh_gossip::{ALPN as GOSSIP_ALPN, net::Gossip};
use std::{fs, path::Path, str::FromStr, time::Duration};
use tokio::io::AsyncWriteExt;

pub struct DocsSyncNode {
    router: Router,
    docs: Docs,
    blobs: BlobsStore,
}

#[derive(Clone, Debug)]
pub struct DocsExportResult {
    pub doc_id: String,
    pub ticket: String,
    pub manifest: SyncManifest,
    pub content_blobs: usize,
}

pub struct DocsImportState {
    pub doc: Doc,
    pub peer: iroh::EndpointAddr,
}

impl DocsSyncNode {
    pub async fn spawn_persistent(state_dir: &Path) -> Result<Self> {
        fs::create_dir_all(state_dir)
            .with_context(|| format!("create docs state dir {}", state_dir.display()))?;
        fs::create_dir_all(state_dir.join("docs-state")).with_context(|| {
            format!(
                "create nested docs state dir {}",
                state_dir.join("docs-state").display()
            )
        })?;
        let endpoint = Endpoint::bind(presets::N0)
            .await
            .context("bind docs endpoint")?;
        let blobs = FsStore::load(state_dir.join("docs-blobs"))
            .await
            .context("load docs blobs store")?;
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let docs = Docs::persistent(state_dir.join("docs-state"))
            .spawn(
                endpoint.clone(),
                BlobsStore::from(blobs.clone()),
                gossip.clone(),
            )
            .await
            .context("spawn docs protocol")?;
        let router = Router::builder(endpoint)
            .accept(BLOBS_ALPN, BlobsProtocol::new(&blobs, None))
            .accept(GOSSIP_ALPN, gossip)
            .accept(DOCS_ALPN, docs.clone())
            .spawn();
        Ok(Self {
            router,
            docs,
            blobs: BlobsStore::from(blobs),
        })
    }

    pub async fn export_directory(
        &self,
        root: &Path,
        chunk_size_bytes: u32,
    ) -> Result<DocsExportResult> {
        let manifest = scan_directory(root, chunk_size_bytes)
            .with_context(|| format!("scan export root {}", root.display()))?;
        self.export_manifest(root, &SyncManifest::default(), manifest)
            .await
    }

    pub async fn export_manifest(
        &self,
        root: &Path,
        previous_manifest: &SyncManifest,
        manifest: SyncManifest,
    ) -> Result<DocsExportResult> {
        let doc = self.docs.create().await.context("create docs document")?;
        let (content_blobs, manifest) = self
            .publish_manifest(&doc, root, previous_manifest, &manifest)
            .await?;
        let ticket = doc
            .share(ShareMode::Write, AddrInfoOptions::RelayAndAddresses)
            .await
            .context("share docs document")?;
        Ok(DocsExportResult {
            doc_id: doc.id().to_string(),
            ticket: ticket.to_string(),
            manifest,
            content_blobs,
        })
    }

    pub async fn publish_manifest(
        &self,
        doc: &Doc,
        root: &Path,
        previous_manifest: &SyncManifest,
        current_manifest: &SyncManifest,
    ) -> Result<(usize, SyncManifest)> {
        let manifest = with_tombstones(previous_manifest, current_manifest, unix_time_now_ms());
        let content_blobs = preload_manifest_blobs(&self.blobs, root, &manifest).await?;
        let author = self.docs.author_default().await?;
        write_manifest(doc, author, &manifest).await?;
        Ok((content_blobs, manifest))
    }

    pub async fn import_manifest(&self, ticket: &str, wait_ms: u64) -> Result<SyncManifest> {
        let DocsImportState { doc, .. } = self.import_doc(ticket).await?;
        tokio::time::sleep(Duration::from_millis(wait_ms)).await;
        read_manifest(&self.blobs, &doc).await
    }

    pub async fn import_doc(&self, ticket: &str) -> Result<DocsImportState> {
        let ticket = DocTicket::from_str(ticket).context("parse doc ticket")?;
        let peer = ticket
            .nodes
            .first()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("doc ticket did not include any peers"))?;
        let doc = self
            .docs
            .import(ticket)
            .await
            .context("import doc ticket")?;
        Ok(DocsImportState { doc, peer })
    }

    pub async fn read_doc_manifest(&self, doc: &Doc) -> Result<SyncManifest> {
        read_manifest(&self.blobs, doc).await
    }

    pub async fn open_doc(&self, doc_id: &str) -> Result<Doc> {
        let doc_id = doc_id.parse().context("parse docs namespace id")?;
        self.docs
            .open(doc_id)
            .await?
            .context("open docs document by id")
    }

    pub async fn fetch_path_from_ticket(
        &self,
        ticket: &str,
        relative_path: &str,
        output_root: &Path,
        wait_ms: u64,
    ) -> Result<SyncManifest> {
        let DocsImportState { doc, peer } = self.import_doc(ticket).await?;
        tokio::time::sleep(Duration::from_millis(wait_ms)).await;
        let manifest = read_manifest(&self.blobs, &doc).await?;
        let entry = manifest.get(relative_path).cloned().ok_or_else(|| {
            anyhow::anyhow!("path {relative_path} not found in imported manifest")
        })?;
        let descriptor = match entry.state {
            SyncEntryState::File(descriptor) => descriptor,
            SyncEntryState::Tombstone => bail!("path {relative_path} is a tombstone"),
        };
        let target = output_root.join(relative_path);
        self.fetch_descriptor_to_path(peer, &descriptor, &target)
            .await?;
        Ok(manifest)
    }

    pub async fn apply_ticket_merge(
        &self,
        ticket: &str,
        base_root: &Path,
        local_root: &Path,
        wait_ms: u64,
    ) -> Result<SyncMergePlan> {
        let DocsImportState { doc, peer } = self.import_doc(ticket).await?;
        tokio::time::sleep(Duration::from_millis(wait_ms)).await;

        let base_manifest =
            scan_directory(base_root, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                .with_context(|| format!("scan base sync root {}", base_root.display()))?;
        let remote_manifest = read_manifest(&self.blobs, &doc).await?;
        self.apply_remote_manifest(peer, &base_manifest, local_root, &remote_manifest)
            .await
    }

    pub async fn shutdown(self) -> Result<()> {
        self.router
            .shutdown()
            .await
            .context("shutdown docs router")?;
        Ok(())
    }

    async fn fetch_descriptor_to_path(
        &self,
        peer: iroh::EndpointAddr,
        descriptor: &altair_vega::FileDescriptor,
        target: &Path,
    ) -> Result<()> {
        let local = self
            .blobs
            .remote()
            .local(HashAndFormat {
                hash: descriptor.hash.into(),
                format: BlobFormat::Raw,
            })
            .await
            .context("inspect local blob availability")?;
        if !local.is_complete() {
            let connection = self
                .router
                .endpoint()
                .connect(peer, BLOBS_ALPN)
                .await
                .context("connect to blob peer from doc ticket")?;
            let request = local.missing();
            self.blobs
                .remote()
                .execute_get(connection, request)
                .await
                .context("fetch blob content for manifest path")?;
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create fetched file parent {}", parent.display()))?;
        }
        let bytes = self
            .blobs
            .get_bytes(descriptor.hash)
            .await
            .context("read fetched blob bytes")?;
        let mut file = tokio::fs::File::create(target)
            .await
            .with_context(|| format!("create fetched file {}", target.display()))?;
        file.write_all(&bytes)
            .await
            .with_context(|| format!("write fetched file {}", target.display()))?;
        file.flush().await?;
        Ok(())
    }

    pub async fn apply_remote_manifest(
        &self,
        peer: iroh::EndpointAddr,
        base_manifest: &SyncManifest,
        local_root: &Path,
        remote_manifest: &SyncManifest,
    ) -> Result<SyncMergePlan> {
        let local_manifest = scan_directory(local_root, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
            .with_context(|| format!("scan local sync root {}", local_root.display()))?;
        let plan = merge_manifests(base_manifest, &local_manifest, remote_manifest);

        for action in &plan.actions {
            match action {
                SyncAction::UpsertFile { path, entry } => {
                    let SyncEntryState::File(descriptor) = &entry.state else {
                        continue;
                    };
                    self.fetch_descriptor_to_path(peer.clone(), descriptor, &local_root.join(path))
                        .await?;
                }
                SyncAction::DeletePath { path } => {
                    let target = local_root.join(path);
                    if target.exists() {
                        fs::remove_file(&target).with_context(|| {
                            format!("remove synced local file {}", target.display())
                        })?;
                        prune_empty_parent_dirs(local_root, &target)?;
                    }
                }
                SyncAction::CreateConflictCopy {
                    conflict_path,
                    entry,
                    ..
                } => {
                    let SyncEntryState::File(descriptor) = &entry.state else {
                        continue;
                    };
                    self.fetch_descriptor_to_path(
                        peer.clone(),
                        descriptor,
                        &local_root.join(conflict_path),
                    )
                    .await?;
                }
            }
        }

        Ok(plan)
    }

    pub async fn seed_local_from_manifest(
        &self,
        peer: iroh::EndpointAddr,
        local_root: &Path,
        remote_manifest: &SyncManifest,
    ) -> Result<usize> {
        let mut applied = 0usize;
        for entry in remote_manifest.entries.values() {
            match &entry.state {
                SyncEntryState::File(descriptor) => {
                    self.fetch_descriptor_to_path(
                        peer.clone(),
                        descriptor,
                        &local_root.join(&entry.path),
                    )
                    .await?;
                    applied += 1;
                }
                SyncEntryState::Tombstone => {}
            }
        }
        Ok(applied)
    }
}

pub async fn write_manifest(
    doc: &Doc,
    author: iroh_docs::AuthorId,
    manifest: &SyncManifest,
) -> Result<()> {
    for entry in manifest.entries.values() {
        let key = manifest_key(&entry.path);
        let value = serde_json::to_vec(entry).context("serialize sync manifest entry")?;
        doc.set_bytes(author, key, value)
            .await
            .with_context(|| format!("set docs entry for {}", entry.path))?;
    }
    Ok(())
}

pub async fn read_manifest(blobs: &BlobsStore, doc: &Doc) -> Result<SyncManifest> {
    let query = Query::single_latest_per_key()
        .key_prefix(MANIFEST_PREFIX)
        .include_empty()
        .build();
    let stream = doc
        .get_many(query)
        .await
        .context("query docs manifest entries")?;
    tokio::pin!(stream);
    let mut entries = Vec::new();
    while let Some(item) = stream.next().await {
        let entry = item.context("read docs manifest entry")?;
        if entry.content_len() == 0 {
            continue;
        }
        let key = std::str::from_utf8(entry.key()).context("decode docs key as utf8")?;
        let _path = key
            .strip_prefix(MANIFEST_PREFIX)
            .ok_or_else(|| anyhow::anyhow!("docs entry outside manifest namespace"))?;
        let bytes = blobs
            .get_bytes(entry.content_hash())
            .await
            .context("load docs metadata blob")?;
        let sync_entry: SyncEntry =
            serde_json::from_slice(&bytes).context("deserialize docs sync manifest entry")?;
        entries.push(sync_entry);
    }
    Ok(SyncManifest::new(entries))
}

const MANIFEST_PREFIX: &str = "manifest/";

fn manifest_key(path: &str) -> String {
    format!("{MANIFEST_PREFIX}{path}")
}

pub fn summarize_manifest(manifest: &SyncManifest) -> Vec<String> {
    manifest
        .entries
        .values()
        .map(|entry| match &entry.state {
            SyncEntryState::File(descriptor) => format!(
                "file {} {} {:02x?}",
                entry.path,
                descriptor.size_bytes,
                &descriptor.hash[..4]
            ),
            SyncEntryState::Tombstone => format!("tombstone {}", entry.path),
        })
        .collect()
}

async fn preload_manifest_blobs(
    blobs: &BlobsStore,
    root: &Path,
    manifest: &SyncManifest,
) -> Result<usize> {
    let mut count = 0usize;
    for entry in manifest.entries.values() {
        let SyncEntryState::File(descriptor) = &entry.state else {
            continue;
        };
        let path = root
            .join(&entry.path)
            .canonicalize()
            .with_context(|| format!("canonicalize sync content file {}", entry.path))?;
        let display_path = path.display().to_string();
        let tag = blobs
            .add_path_with_opts(AddPathOptions {
                path,
                format: BlobFormat::Raw,
                mode: ImportMode::Copy,
            })
            .await
            .with_context(|| format!("add sync content blob {display_path}"))?;
        if tag.hash != descriptor.hash.into() {
            bail!(
                "blob hash for {} does not match sync descriptor",
                entry.path
            );
        }
        count += 1;
    }
    Ok(count)
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

#[cfg(test)]
mod tests {
    use super::DocsSyncNode;
    use altair_vega::{DEFAULT_SYNC_CHUNK_SIZE_BYTES, SyncAction, scan_directory};
    use anyhow::Result;
    use tempfile::TempDir;
    use tokio::time::{Duration, sleep};

    #[tokio::test]
    async fn docs_export_import_and_fetch_round_trip() -> Result<()> {
        let temp = TempDir::new()?;
        let remote_root = temp.path().join("remote");
        let output_root = temp.path().join("output");
        std::fs::create_dir_all(&remote_root)?;
        std::fs::create_dir_all(&output_root)?;
        std::fs::write(remote_root.join("readme.txt"), b"hello docs bridge\n")?;

        let server = DocsSyncNode::spawn_persistent(&temp.path().join("server-state")).await?;
        let export = server
            .export_directory(&remote_root, DEFAULT_SYNC_CHUNK_SIZE_BYTES)
            .await?;

        let client = DocsSyncNode::spawn_persistent(&temp.path().join("client-state")).await?;
        let manifest = client.import_manifest(&export.ticket, 1500).await?;
        assert_eq!(manifest.len(), 1);
        assert!(manifest.get("readme.txt").is_some());

        client
            .fetch_path_from_ticket(&export.ticket, "readme.txt", &output_root, 1500)
            .await?;
        assert_eq!(
            std::fs::read(output_root.join("readme.txt"))?,
            b"hello docs bridge\n"
        );

        client.shutdown().await?;
        server.shutdown().await?;
        Ok(())
    }

    #[tokio::test]
    async fn docs_apply_propagates_add_and_delete() -> Result<()> {
        let temp = TempDir::new()?;
        let base_root = temp.path().join("base");
        let local_root = temp.path().join("local");
        let remote_root = temp.path().join("remote");
        std::fs::create_dir_all(&base_root)?;
        std::fs::create_dir_all(&local_root)?;
        std::fs::create_dir_all(&remote_root)?;
        std::fs::write(base_root.join("keep.txt"), b"keep\n")?;
        std::fs::write(base_root.join("drop.txt"), b"drop\n")?;
        std::fs::copy(base_root.join("keep.txt"), local_root.join("keep.txt"))?;
        std::fs::copy(base_root.join("drop.txt"), local_root.join("drop.txt"))?;
        std::fs::copy(base_root.join("keep.txt"), remote_root.join("keep.txt"))?;
        std::fs::write(remote_root.join("add.txt"), b"added\n")?;

        let server = DocsSyncNode::spawn_persistent(&temp.path().join("server-state")).await?;
        let export = server
            .export_directory(&remote_root, DEFAULT_SYNC_CHUNK_SIZE_BYTES)
            .await?;
        let client = DocsSyncNode::spawn_persistent(&temp.path().join("client-state")).await?;
        let plan = client
            .apply_ticket_merge(&export.ticket, &base_root, &local_root, 1500)
            .await?;

        assert_eq!(plan.actions.len(), 2);
        assert_eq!(std::fs::read(local_root.join("add.txt"))?, b"added\n");
        assert!(!local_root.join("drop.txt").exists());

        client.shutdown().await?;
        server.shutdown().await?;
        Ok(())
    }

    #[tokio::test]
    async fn docs_remote_conflict_creates_conflict_copy() -> Result<()> {
        let temp = TempDir::new()?;
        let remote_root = temp.path().join("remote");
        let local_root = temp.path().join("local");
        std::fs::create_dir_all(&remote_root)?;
        std::fs::create_dir_all(&local_root)?;
        std::fs::write(remote_root.join("readme.txt"), b"base\n")?;

        let server = DocsSyncNode::spawn_persistent(&temp.path().join("server-state")).await?;
        let export = server
            .export_directory(&remote_root, DEFAULT_SYNC_CHUNK_SIZE_BYTES)
            .await?;
        let doc = server.open_doc(&export.doc_id).await?;

        let client = DocsSyncNode::spawn_persistent(&temp.path().join("client-state")).await?;
        let imported = client.import_doc(&export.ticket).await?;
        let initial_remote = wait_for_manifest(&client, &imported.doc, 1).await?;
        let seeded = client
            .seed_local_from_manifest(imported.peer.clone(), &local_root, &initial_remote)
            .await?;
        assert_eq!(seeded, 1);
        std::fs::write(local_root.join("readme.txt"), b"local change\n")?;
        std::fs::write(remote_root.join("readme.txt"), b"remote change\n")?;

        let remote_manifest = scan_directory(&remote_root, DEFAULT_SYNC_CHUNK_SIZE_BYTES)?;
        let (_, published_manifest) = server
            .publish_manifest(&doc, &remote_root, &export.manifest, &remote_manifest)
            .await?;

        let synced_remote =
            wait_for_specific_manifest(&client, &imported.doc, &published_manifest).await?;
        let plan = client
            .apply_remote_manifest(
                imported.peer.clone(),
                &initial_remote,
                &local_root,
                &synced_remote,
            )
            .await?;

        assert_eq!(plan.actions.len(), 1);
        assert_eq!(plan.conflicts.len(), 1);
        let conflict_action = &plan.actions[0];
        let conflict_path = match conflict_action {
            SyncAction::CreateConflictCopy { conflict_path, .. } => conflict_path,
            other => panic!("expected conflict copy action, got {other:?}"),
        };
        assert_eq!(
            std::fs::read(local_root.join("readme.txt"))?,
            b"local change\n"
        );
        assert_eq!(
            std::fs::read(local_root.join(conflict_path))?,
            b"remote change\n"
        );

        client.shutdown().await?;
        server.shutdown().await?;
        Ok(())
    }

    async fn wait_for_manifest(
        client: &DocsSyncNode,
        doc: &iroh_docs::api::Doc,
        expected_entries: usize,
    ) -> Result<altair_vega::SyncManifest> {
        for _ in 0..20 {
            match client.read_doc_manifest(doc).await {
                Ok(manifest) if manifest.len() >= expected_entries => return Ok(manifest),
                Ok(_) | Err(_) => {
                    sleep(Duration::from_millis(250)).await;
                }
            }
        }
        anyhow::bail!("timed out waiting for manifest entries")
    }

    async fn wait_for_specific_manifest(
        client: &DocsSyncNode,
        doc: &iroh_docs::api::Doc,
        expected: &altair_vega::SyncManifest,
    ) -> Result<altair_vega::SyncManifest> {
        for _ in 0..20 {
            match client.read_doc_manifest(doc).await {
                Ok(manifest) if altair_vega::manifests_state_eq(&manifest, expected) => {
                    return Ok(manifest);
                }
                Ok(_) | Err(_) => {
                    sleep(Duration::from_millis(250)).await;
                }
            }
        }
        anyhow::bail!("timed out waiting for specific manifest state")
    }
}
