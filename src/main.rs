use altair_vega::{
    FileProbeConfig, FileProbeMode, MessagingPeerKind, ShortCode, apply_merge_plan,
    diff_manifests, manifests_state_eq, merge_manifests, run_local_file_probe,
    run_local_file_probe_with_config, run_local_message_probe, run_local_native_resume_probe,
    run_local_pairing_probe, scan_directory,
};
use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use futures_util::StreamExt;
use notify::{EventKind, RecursiveMode, Watcher};
use std::{path::PathBuf, str::FromStr};

mod browser_peer;
mod sync_docs;

#[derive(Debug, Parser)]
#[command(name = "altair-vega")]
#[command(about = "Early Altair Vega pairing and bootstrap tools")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Code {
        #[command(subcommand)]
        command: CodeCommand,
    },
    Pairing {
        #[command(subcommand)]
        command: PairingCommand,
    },
    Message {
        #[command(subcommand)]
        command: MessageCommand,
    },
    File {
        #[command(subcommand)]
        command: FileCommand,
    },
    BrowserPeer {
        #[command(subcommand)]
        command: BrowserPeerCommand,
    },
    Sync {
        #[command(subcommand)]
        command: SyncCommand,
    },
}

#[derive(Debug, Subcommand)]
enum CodeCommand {
    Generate,
    Inspect { code: String },
}

#[derive(Debug, Subcommand)]
enum PairingCommand {
    Demo { code: Option<String> },
}

#[derive(Debug, Subcommand)]
enum MessageCommand {
    Demo {
        code: Option<String>,
        #[arg(long, value_enum, default_value_t = PeerKindArg::Cli)]
        left: PeerKindArg,
        #[arg(long, value_enum, default_value_t = PeerKindArg::Cli)]
        right: PeerKindArg,
        #[arg(long, default_value = "hello from left")]
        left_text: String,
        #[arg(long, default_value = "hello from right")]
        right_text: String,
    },
}

#[derive(Debug, Subcommand)]
enum FileCommand {
    Demo {
        code: Option<String>,
        #[arg(long, value_enum, default_value_t = PeerKindArg::Cli)]
        left: PeerKindArg,
        #[arg(long, value_enum, default_value_t = PeerKindArg::Cli)]
        right: PeerKindArg,
        #[arg(long, default_value = "demo.txt")]
        name: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long, default_value = "hello from file demo")]
        text: String,
        #[arg(long)]
        receiver_state_root: Option<PathBuf>,
        #[arg(long)]
        interrupt_after_chunks: Option<u64>,
    },
    NativeResumeDemo {
        code: Option<String>,
        #[arg(long, default_value = "resume.bin")]
        name: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long, default_value = "hello from native resume demo")]
        text: String,
        #[arg(long, default_value_t = 2)]
        seeded_chunks: u64,
        #[arg(long)]
        receiver_state_root: Option<PathBuf>,
    },
}

#[derive(Debug, Subcommand)]
enum BrowserPeerCommand {
    Serve {
        code: String,
        #[arg(long, default_value = "ws://127.0.0.1:5173/__altair_vega_rendezvous")]
        room_url: String,
        #[arg(long, default_value = "browser-peer-downloads")]
        output_dir: PathBuf,
    },
}

#[derive(Debug, Subcommand)]
enum SyncCommand {
    Snapshot {
        root: PathBuf,
    },
    MergeApply {
        base: PathBuf,
        local: PathBuf,
        remote: PathBuf,
    },
    Watch {
        root: PathBuf,
        #[arg(long, default_value_t = 1000)]
        interval_ms: u64,
    },
    DocsExport {
        root: PathBuf,
        #[arg(long, default_value = ".altair-sync-docs")]
        state_dir: PathBuf,
    },
    DocsServe {
        root: PathBuf,
        #[arg(long, default_value = ".altair-sync-docs-serve")]
        state_dir: PathBuf,
        #[arg(long, default_value_t = 1000)]
        interval_ms: u64,
    },
    DocsImport {
        ticket: String,
        #[arg(long, default_value = ".altair-sync-docs-import")]
        state_dir: PathBuf,
        #[arg(long, default_value_t = 1500)]
        wait_ms: u64,
    },
    DocsFetch {
        ticket: String,
        path: String,
        #[arg(long, default_value = ".altair-sync-docs-fetch")]
        state_dir: PathBuf,
        #[arg(long, default_value = "sync-fetch-output")]
        output_dir: PathBuf,
        #[arg(long, default_value_t = 1500)]
        wait_ms: u64,
    },
    DocsApply {
        ticket: String,
        base: PathBuf,
        local: PathBuf,
        #[arg(long, default_value = ".altair-sync-docs-apply")]
        state_dir: PathBuf,
        #[arg(long, default_value_t = 1500)]
        wait_ms: u64,
    },
    DocsFollow {
        ticket: String,
        local: PathBuf,
        #[arg(long, default_value = ".altair-sync-docs-follow")]
        state_dir: PathBuf,
        #[arg(long, default_value_t = 1500)]
        wait_ms: u64,
        #[arg(long, default_value_t = 1000)]
        interval_ms: u64,
    },
    DocsJoin {
        ticket: String,
        local: PathBuf,
        #[arg(long, default_value = ".altair-sync-docs-join")]
        state_dir: PathBuf,
        #[arg(long, default_value_t = 1500)]
        wait_ms: u64,
        #[arg(long, default_value_t = 1000)]
        interval_ms: u64,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum PeerKindArg {
    Cli,
    Web,
}

impl From<PeerKindArg> for MessagingPeerKind {
    fn from(value: PeerKindArg) -> Self {
        match value {
            PeerKindArg::Cli => MessagingPeerKind::Cli,
            PeerKindArg::Web => MessagingPeerKind::Web,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Code { command } => match command {
            CodeCommand::Generate => {
                let code = ShortCode::generate();
                println!("{code}");
            }
            CodeCommand::Inspect { code } => {
                let code = ShortCode::from_str(&code).context("parse short code")?;
                let [first, second, third] = code.words();
                println!("normalized: {}", code.normalized());
                println!("slot: {}", code.slot());
                println!("words: {first}, {second}, {third}");
                println!("pairing identity: {}", code.pairing_identity());
            }
        },
        Command::Pairing { command } => match command {
            PairingCommand::Demo { code } => {
                let code = match code {
                    Some(code) => ShortCode::from_str(&code).context("parse short code")?,
                    None => ShortCode::generate(),
                };

                println!("using code: {code}");
                let outcome = run_local_pairing_probe(code.clone()).await?;
                println!("pairing bootstrap succeeded");
                println!("left ticket: {}", outcome.left_ticket);
                println!("right ticket: {}", outcome.right_ticket);
            }
        },
        Command::Message { command } => match command {
            MessageCommand::Demo {
                code,
                left,
                right,
                left_text,
                right_text,
            } => {
                let code = match code {
                    Some(code) => ShortCode::from_str(&code).context("parse short code")?,
                    None => ShortCode::generate(),
                };
                let outcome = run_local_message_probe(
                    code.clone(),
                    left.into(),
                    right.into(),
                    left_text,
                    right_text,
                )
                .await?;

                println!("using code: {}", outcome.code);
                println!("left peer kind: {:?}", outcome.left_kind);
                println!("right peer kind: {:?}", outcome.right_kind);
                println!("left sent: {}", outcome.left_sent);
                println!("right received: {}", outcome.right_received);
                println!("right sent: {}", outcome.right_sent);
                println!("left received: {}", outcome.left_received);
            }
        },
        Command::File { command } => match command {
            FileCommand::Demo {
                code,
                left,
                right,
                name,
                path,
                text,
                receiver_state_root,
                interrupt_after_chunks,
            } => {
                let code = match code {
                    Some(code) => ShortCode::from_str(&code).context("parse short code")?,
                    None => ShortCode::generate(),
                };
                let payload = match path {
                    Some(path) => std::fs::read(&path)
                        .with_context(|| format!("read demo file at {}", path.display()))?,
                    None => text.into_bytes(),
                };
                let outcome = if receiver_state_root.is_some() || interrupt_after_chunks.is_some() {
                    run_local_file_probe_with_config(
                        code.clone(),
                        left.into(),
                        right.into(),
                        name,
                        &payload,
                        FileProbeMode::Accept,
                        FileProbeConfig {
                            receiver_state_root,
                            interrupt_after_chunks,
                        },
                    )
                    .await?
                } else {
                    run_local_file_probe(
                        code.clone(),
                        left.into(),
                        right.into(),
                        name,
                        &payload,
                        FileProbeMode::Accept,
                    )
                    .await?
                };

                println!("using code: {}", outcome.code);
                println!("left peer kind: {:?}", outcome.left_kind);
                println!("right peer kind: {:?}", outcome.right_kind);
                println!("file: {}", outcome.file_name);
                println!("transport: {:?}", outcome.transport);
                println!("resumed local bytes: {}", outcome.resumed_local_bytes);
                println!("bytes sent: {}", outcome.bytes_sent);
                println!("bytes received: {}", outcome.bytes_received);
                println!("accepted: {}", outcome.accepted);
                println!("cancelled: {}", outcome.cancelled);
            }
            FileCommand::NativeResumeDemo {
                code,
                name,
                path,
                text,
                seeded_chunks,
                receiver_state_root,
            } => {
                let code = match code {
                    Some(code) => ShortCode::from_str(&code).context("parse short code")?,
                    None => ShortCode::generate(),
                };
                let payload = match path {
                    Some(path) => std::fs::read(&path).with_context(|| {
                        format!("read native resume demo file at {}", path.display())
                    })?,
                    None => text.into_bytes(),
                };
                let outcome = run_local_native_resume_probe(
                    code.clone(),
                    name,
                    &payload,
                    seeded_chunks,
                    receiver_state_root,
                )
                .await?;

                println!("using code: {}", outcome.code);
                println!("file: {}", outcome.file_name);
                println!("seeded chunks: {}", outcome.seeded_chunks);
                println!("initial local bytes: {}", outcome.initial_local_bytes);
                println!("final bytes: {}", outcome.final_bytes);
                println!("expected hash: {:02x?}", outcome.expected_hash);
                println!("received hash: {:02x?}", outcome.received_hash);
            }
        },
        Command::BrowserPeer { command } => match command {
            BrowserPeerCommand::Serve {
                code,
                room_url,
                output_dir,
            } => {
                let code = ShortCode::from_str(&code).context("parse short code")?;
                browser_peer::run_browser_peer(code.normalized(), room_url, output_dir).await?;
            }
        },
        Command::Sync { command } => match command {
            SyncCommand::Snapshot { root } => {
                let manifest = scan_directory(&root, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                    .with_context(|| format!("scan sync root {}", root.display()))?;
                println!("root: {}", root.display());
                println!("entries: {}", manifest.len());
                for entry in manifest.entries.values() {
                    match &entry.state {
                        altair_vega::SyncEntryState::File(descriptor) => {
                            println!(
                                "file {} {} {:02x?}",
                                entry.path,
                                descriptor.size_bytes,
                                &descriptor.hash[..4]
                            );
                        }
                        altair_vega::SyncEntryState::Tombstone => {
                            println!("tombstone {}", entry.path);
                        }
                    }
                }
            }
            SyncCommand::MergeApply {
                base,
                local,
                remote,
            } => {
                let base_manifest = scan_directory(&base, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                    .with_context(|| format!("scan base sync root {}", base.display()))?;
                let local_manifest = scan_directory(&local, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                    .with_context(|| format!("scan local sync root {}", local.display()))?;
                let remote_manifest = scan_directory(&remote, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                    .with_context(|| format!("scan remote sync root {}", remote.display()))?;
                let plan = merge_manifests(&base_manifest, &local_manifest, &remote_manifest);
                println!("base: {}", base.display());
                println!("local: {}", local.display());
                println!("remote: {}", remote.display());
                println!("actions: {}", plan.actions.len());
                println!("conflicts: {}", plan.conflicts.len());
                apply_merge_plan(&local, &remote, &plan)
                    .with_context(|| format!("apply merge plan into {}", local.display()))?;
            }
            SyncCommand::Watch { root, interval_ms } => {
                let mut previous = scan_directory(&root, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                    .with_context(|| format!("scan sync watch root {}", root.display()))?;
                println!("watching: {}", root.display());
                println!("interval ms: {interval_ms}");
                println!("press Ctrl+C to stop");
                let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
                let mut watcher = notify::recommended_watcher(move |event| {
                    let _ = event_tx.send(event);
                })
                .context("create filesystem watcher")?;
                watcher
                    .watch(&root, RecursiveMode::Recursive)
                    .with_context(|| format!("watch sync root {}", root.display()))?;
                let mut interval = tokio::time::interval(std::time::Duration::from_millis(interval_ms));
                loop {
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => break,
                        maybe_event = event_rx.recv() => {
                            if let Some(event) = maybe_event {
                                match event {
                                    Ok(event) => {
                                        if matches!(event.kind, EventKind::Access(_)) {
                                            continue;
                                        }
                                        println!("watch event: {:?}", event.kind);
                                    }
                                    Err(error) => {
                                        println!("watch error: {error}");
                                    }
                                }
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                            let current = scan_directory(&root, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                                .with_context(|| format!("rescan sync watch root {}", root.display()))?;
                            for change in diff_manifests(&previous, &current) {
                                println!("{:?} {}", change.kind, change.path);
                            }
                            previous = current;
                        }
                        _ = interval.tick() => {
                            let current = scan_directory(&root, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                                .with_context(|| format!("rescan sync watch root {}", root.display()))?;
                            for change in diff_manifests(&previous, &current) {
                                println!("{:?} {}", change.kind, change.path);
                            }
                            previous = current;
                        }
                    }
                }
            }
            SyncCommand::DocsExport { root, state_dir } => {
                let node = sync_docs::DocsSyncNode::spawn_persistent(&state_dir).await?;
                let result = node
                    .export_directory(&root, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                    .await?;
                println!("root: {}", root.display());
                println!("state dir: {}", state_dir.display());
                println!("doc id: {}", result.doc_id);
                println!("ticket: {}", result.ticket);
                println!("entries: {}", result.manifest.len());
                println!("content blobs: {}", result.content_blobs);
                for line in sync_docs::summarize_manifest(&result.manifest) {
                    println!("{line}");
                }
                println!("press Ctrl+C to stop serving this doc");
                tokio::signal::ctrl_c().await?;
                node.shutdown().await?;
            }
            SyncCommand::DocsServe {
                root,
                state_dir,
                interval_ms,
            } => {
                let node = sync_docs::DocsSyncNode::spawn_persistent(&state_dir).await?;
                let current_manifest = scan_directory(&root, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                    .with_context(|| format!("scan sync serve root {}", root.display()))?;
                let manifest_state_path = state_dir.join("last-published-manifest.json");
                let previous_manifest = if manifest_state_path.exists() {
                    serde_json::from_slice::<altair_vega::SyncManifest>(
                        &std::fs::read(&manifest_state_path)
                            .with_context(|| format!("read manifest state {}", manifest_state_path.display()))?,
                    )
                    .with_context(|| format!("deserialize manifest state {}", manifest_state_path.display()))?
                } else {
                    current_manifest.clone()
                };
                let result = node
                    .export_manifest(&root, &previous_manifest, current_manifest.clone())
                    .await?;
                println!("root: {}", root.display());
                println!("state dir: {}", state_dir.display());
                println!("doc id: {}", result.doc_id);
                println!("ticket: {}", result.ticket);
                println!("entries: {}", result.manifest.len());
                println!("content blobs: {}", result.content_blobs);
                println!("watch interval ms: {interval_ms}");
                println!("press Ctrl+C to stop");

                let doc = node.open_doc(&result.doc_id).await?;
                persist_manifest_state(&manifest_state_path, &current_manifest)?;
                let mut published_manifest = current_manifest;
                let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
                let mut watcher = notify::recommended_watcher(move |event| {
                    let _ = event_tx.send(event);
                })
                .context("create docs serve watcher")?;
                watcher
                    .watch(&root, RecursiveMode::Recursive)
                    .with_context(|| format!("watch docs serve root {}", root.display()))?;
                let mut interval = tokio::time::interval(std::time::Duration::from_millis(interval_ms));
                loop {
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => break,
                        maybe_event = event_rx.recv() => {
                            if let Some(Ok(event)) = maybe_event
                                && matches!(event.kind, EventKind::Access(_)) {
                                continue;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                            let current = scan_directory(&root, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                                .with_context(|| format!("rescan docs serve root {}", root.display()))?;
                            let changes = diff_manifests(&published_manifest, &current);
                            if changes.is_empty() {
                                continue;
                            }
                            match node.publish_manifest(&doc, &root, &published_manifest, &current).await {
                                Ok((content_blobs, next_manifest)) => {
                                    println!("published changes: {} content blobs: {}", changes.len(), content_blobs);
                                    for change in &changes {
                                        println!("{:?} {}", change.kind, change.path);
                                    }
                                    persist_manifest_state(&manifest_state_path, &next_manifest)?;
                                    published_manifest = next_manifest;
                                }
                                Err(error) => {
                                    println!("publish error: {error}");
                                }
                            }
                        }
                        _ = interval.tick() => {
                            let current = scan_directory(&root, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                                .with_context(|| format!("rescan docs serve root {}", root.display()))?;
                            let changes = diff_manifests(&published_manifest, &current);
                            if changes.is_empty() {
                                continue;
                            }
                            match node.publish_manifest(&doc, &root, &published_manifest, &current).await {
                                Ok((content_blobs, next_manifest)) => {
                                    println!("published changes: {} content blobs: {}", changes.len(), content_blobs);
                                    for change in &changes {
                                        println!("{:?} {}", change.kind, change.path);
                                    }
                                    persist_manifest_state(&manifest_state_path, &next_manifest)?;
                                    published_manifest = next_manifest;
                                }
                                Err(error) => {
                                    println!("publish error: {error}");
                                }
                            }
                        }
                    }
                }
                node.shutdown().await?;
            }
            SyncCommand::DocsImport {
                ticket,
                state_dir,
                wait_ms,
            } => {
                let node = sync_docs::DocsSyncNode::spawn_persistent(&state_dir).await?;
                let manifest = node.import_manifest(&ticket, wait_ms).await?;
                println!("state dir: {}", state_dir.display());
                println!("entries: {}", manifest.len());
                for line in sync_docs::summarize_manifest(&manifest) {
                    println!("{line}");
                }
                node.shutdown().await?;
            }
            SyncCommand::DocsFetch {
                ticket,
                path,
                state_dir,
                output_dir,
                wait_ms,
            } => {
                let node = sync_docs::DocsSyncNode::spawn_persistent(&state_dir).await?;
                let manifest = node
                    .fetch_path_from_ticket(&ticket, &path, &output_dir, wait_ms)
                    .await?;
                println!("state dir: {}", state_dir.display());
                println!("output dir: {}", output_dir.display());
                println!("fetched path: {path}");
                println!("entries: {}", manifest.len());
                node.shutdown().await?;
            }
            SyncCommand::DocsApply {
                ticket,
                base,
                local,
                state_dir,
                wait_ms,
            } => {
                let node = sync_docs::DocsSyncNode::spawn_persistent(&state_dir).await?;
                let plan = node
                    .apply_ticket_merge(&ticket, &base, &local, wait_ms)
                    .await?;
                println!("base: {}", base.display());
                println!("local: {}", local.display());
                println!("state dir: {}", state_dir.display());
                println!("actions: {}", plan.actions.len());
                println!("conflicts: {}", plan.conflicts.len());
                node.shutdown().await?;
            }
            SyncCommand::DocsFollow {
                ticket,
                local,
                state_dir,
                wait_ms,
                interval_ms,
            } => {
                std::fs::create_dir_all(&local)
                    .with_context(|| format!("create follow local root {}", local.display()))?;
                let node = sync_docs::DocsSyncNode::spawn_persistent(&state_dir).await?;
                let sync_state_path = state_dir.join("follow-base-manifest.json");
                let had_sync_state = sync_state_path.exists();
                let mut base_manifest = if had_sync_state {
                    serde_json::from_slice::<altair_vega::SyncManifest>(
                        &std::fs::read(&sync_state_path)
                            .with_context(|| format!("read follow state {}", sync_state_path.display()))?,
                    )
                    .with_context(|| format!("deserialize follow state {}", sync_state_path.display()))?
                } else {
                    scan_directory(&local, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                        .with_context(|| format!("scan follow local root {}", local.display()))?
                };
                let imported = node.import_doc(&ticket).await?;
                tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
                let initial_local = scan_directory(&local, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                    .with_context(|| format!("scan initial follow local root {}", local.display()))?;
                let remote_manifest = wait_for_remote_manifest(
                    &node,
                    &imported.doc,
                    wait_ms,
                    initial_local.is_empty() && !had_sync_state,
                )
                .await?;
                if !had_sync_state && initial_local.is_empty() {
                    let applied = node
                        .seed_local_from_manifest(imported.peer.clone(), &local, &remote_manifest)
                        .await?;
                    println!("seeded files: {}", applied);
                    persist_manifest_state(&sync_state_path, &remote_manifest)?;
                    base_manifest = remote_manifest;
                }
                println!("following docs ticket into {}", local.display());
                println!("state dir: {}", state_dir.display());
                println!("interval ms: {interval_ms}");
                println!("press Ctrl+C to stop");
                let mut interval = tokio::time::interval(std::time::Duration::from_millis(interval_ms));
                let mut remote_events = Box::pin(imported.doc.subscribe().await?);
                loop {
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => break,
                        maybe_remote = remote_events.next() => {
                            if maybe_remote.is_none() {
                                continue;
                            }
                            let remote_manifest = node.read_doc_manifest(&imported.doc).await?;
                            let plan = node
                                .apply_remote_manifest(imported.peer.clone(), &base_manifest, &local, &remote_manifest)
                                .await?;
                            if plan.actions.is_empty() && plan.conflicts.is_empty() {
                                if !manifests_state_eq(&base_manifest, &remote_manifest) {
                                    persist_manifest_state(&sync_state_path, &remote_manifest)?;
                                    base_manifest = remote_manifest;
                                }
                                continue;
                            }
                            println!("applied actions: {} conflicts: {}", plan.actions.len(), plan.conflicts.len());
                            for action in &plan.actions {
                                println!("action: {:?}", action);
                            }
                            for conflict in &plan.conflicts {
                                println!("conflict: {:?}", conflict);
                            }
                            persist_manifest_state(&sync_state_path, &remote_manifest)?;
                            base_manifest = remote_manifest;
                        }
                        _ = interval.tick() => {
                            let remote_manifest = node.read_doc_manifest(&imported.doc).await?;
                            let plan = node
                                .apply_remote_manifest(imported.peer.clone(), &base_manifest, &local, &remote_manifest)
                                .await?;
                            if plan.actions.is_empty() && plan.conflicts.is_empty() {
                                continue;
                            }
                            println!("applied actions: {} conflicts: {}", plan.actions.len(), plan.conflicts.len());
                            for action in &plan.actions {
                                println!("action: {:?}", action);
                            }
                            for conflict in &plan.conflicts {
                                println!("conflict: {:?}", conflict);
                            }
                            persist_manifest_state(&sync_state_path, &remote_manifest)?;
                            base_manifest = remote_manifest;
                        }
                    }
                }
                node.shutdown().await?;
            }
            SyncCommand::DocsJoin {
                ticket,
                local,
                state_dir,
                wait_ms,
                interval_ms,
            } => {
                std::fs::create_dir_all(&local)
                    .with_context(|| format!("create join local root {}", local.display()))?;
                let node = sync_docs::DocsSyncNode::spawn_persistent(&state_dir).await?;
                let sync_state_path = state_dir.join("join-base-manifest.json");
                let had_sync_state = sync_state_path.exists();
                let mut base_manifest = if had_sync_state {
                    serde_json::from_slice::<altair_vega::SyncManifest>(
                        &std::fs::read(&sync_state_path)
                            .with_context(|| format!("read join state {}", sync_state_path.display()))?,
                    )
                    .with_context(|| format!("deserialize join state {}", sync_state_path.display()))?
                } else {
                    altair_vega::SyncManifest::default()
                };
                let imported = node.import_doc(&ticket).await?;
                tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
                let initial_local = scan_directory(&local, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                    .with_context(|| format!("scan initial join local root {}", local.display()))?;
                let initial_remote = wait_for_remote_manifest(
                    &node,
                    &imported.doc,
                    wait_ms,
                    initial_local.is_empty() && !had_sync_state,
                )
                .await?;
                let initial_plan = if !had_sync_state && initial_local.is_empty() {
                    let applied = node
                        .seed_local_from_manifest(imported.peer.clone(), &local, &initial_remote)
                        .await?;
                    println!("initial seeded files: {}", applied);
                    altair_vega::SyncMergePlan::default()
                } else {
                    node
                        .apply_remote_manifest(imported.peer.clone(), &base_manifest, &local, &initial_remote)
                        .await?
                };
                println!("joined docs ticket into {}", local.display());
                println!("state dir: {}", state_dir.display());
                println!("interval ms: {interval_ms}");
                println!("initial actions: {} conflicts: {}", initial_plan.actions.len(), initial_plan.conflicts.len());
                persist_manifest_state(&sync_state_path, &initial_remote)?;
                base_manifest = initial_remote;
                let mut last_published_manifest: Option<altair_vega::SyncManifest> = None;
                println!("press Ctrl+C to stop");

                let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
                let mut watcher = notify::recommended_watcher(move |event| {
                    let _ = event_tx.send(event);
                })
                .context("create docs join watcher")?;
                watcher
                    .watch(&local, RecursiveMode::Recursive)
                    .with_context(|| format!("watch docs join local root {}", local.display()))?;
                let mut interval = tokio::time::interval(std::time::Duration::from_millis(interval_ms));
                let mut remote_events = Box::pin(imported.doc.subscribe().await?);

                loop {
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => break,
                        maybe_remote = remote_events.next() => {
                            if maybe_remote.is_none() {
                                continue;
                            }
                            let remote_manifest = node.read_doc_manifest(&imported.doc).await?;
                            if !manifests_state_eq(&base_manifest, &remote_manifest) {
                                let plan = node
                                    .apply_remote_manifest(imported.peer.clone(), &base_manifest, &local, &remote_manifest)
                                    .await?;
                                if !plan.actions.is_empty() || !plan.conflicts.is_empty() {
                                    println!("applied remote actions: {} conflicts: {}", plan.actions.len(), plan.conflicts.len());
                                    for action in &plan.actions {
                                        println!("remote action: {:?}", action);
                                    }
                                    for conflict in &plan.conflicts {
                                        println!("remote conflict: {:?}", conflict);
                                    }
                                }
                                persist_manifest_state(&sync_state_path, &remote_manifest)?;
                                base_manifest = remote_manifest;
                                if let Some(last) = &last_published_manifest
                                    && manifests_state_eq(last, &base_manifest) {
                                    last_published_manifest = None;
                                }
                            }
                        }
                        maybe_event = event_rx.recv() => {
                            if let Some(Ok(event)) = maybe_event && matches!(event.kind, EventKind::Access(_)) {
                                continue;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                            let current_local = scan_directory(&local, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                                .with_context(|| format!("scan docs join local root {}", local.display()))?;
                            let local_changes = diff_manifests(&base_manifest, &current_local);
                            if !local_changes.is_empty() {
                                let proposed_manifest = altair_vega::with_tombstones(
                                    &base_manifest,
                                    &current_local,
                                    altair_vega::unix_time_now_ms(),
                                );
                                let skip_publish = last_published_manifest
                                    .as_ref()
                                    .is_some_and(|last| manifests_state_eq(last, &proposed_manifest));
                                if !skip_publish {
                                    match node.publish_manifest(&imported.doc, &local, &base_manifest, &current_local).await {
                                        Ok((content_blobs, published_manifest)) => {
                                            println!("published local changes: {} content blobs: {}", local_changes.len(), content_blobs);
                                            for change in &local_changes {
                                                println!("local {:?} {}", change.kind, change.path);
                                            }
                                            last_published_manifest = Some(published_manifest);
                                        }
                                        Err(error) => {
                                            println!("local publish error: {error}");
                                        }
                                    }
                                }
                            }
                            let remote_manifest = node.read_doc_manifest(&imported.doc).await?;
                            if !manifests_state_eq(&base_manifest, &remote_manifest) {
                                let plan = node
                                    .apply_remote_manifest(imported.peer.clone(), &base_manifest, &local, &remote_manifest)
                                    .await?;
                                if !plan.actions.is_empty() || !plan.conflicts.is_empty() {
                                    println!("applied remote actions: {} conflicts: {}", plan.actions.len(), plan.conflicts.len());
                                    for action in &plan.actions {
                                        println!("remote action: {:?}", action);
                                    }
                                    for conflict in &plan.conflicts {
                                        println!("remote conflict: {:?}", conflict);
                                    }
                                }
                                persist_manifest_state(&sync_state_path, &remote_manifest)?;
                                base_manifest = remote_manifest;
                                if let Some(last) = &last_published_manifest
                                    && manifests_state_eq(last, &base_manifest) {
                                    last_published_manifest = None;
                                }
                            }
                        }
                        _ = interval.tick() => {
                            let current_local = scan_directory(&local, altair_vega::DEFAULT_SYNC_CHUNK_SIZE_BYTES)
                                .with_context(|| format!("scan docs join local root {}", local.display()))?;
                            let local_changes = diff_manifests(&base_manifest, &current_local);
                            if !local_changes.is_empty() {
                                let proposed_manifest = altair_vega::with_tombstones(
                                    &base_manifest,
                                    &current_local,
                                    altair_vega::unix_time_now_ms(),
                                );
                                let skip_publish = last_published_manifest
                                    .as_ref()
                                    .is_some_and(|last| manifests_state_eq(last, &proposed_manifest));
                                if !skip_publish {
                                    match node.publish_manifest(&imported.doc, &local, &base_manifest, &current_local).await {
                                        Ok((content_blobs, published_manifest)) => {
                                            println!("published local changes: {} content blobs: {}", local_changes.len(), content_blobs);
                                            for change in &local_changes {
                                                println!("local {:?} {}", change.kind, change.path);
                                            }
                                            last_published_manifest = Some(published_manifest);
                                        }
                                        Err(error) => {
                                            println!("local publish error: {error}");
                                        }
                                    }
                                }
                            }
                            let remote_manifest = node.read_doc_manifest(&imported.doc).await?;
                            if !manifests_state_eq(&base_manifest, &remote_manifest) {
                                let plan = node
                                    .apply_remote_manifest(imported.peer.clone(), &base_manifest, &local, &remote_manifest)
                                    .await?;
                                if !plan.actions.is_empty() || !plan.conflicts.is_empty() {
                                    println!("applied remote actions: {} conflicts: {}", plan.actions.len(), plan.conflicts.len());
                                    for action in &plan.actions {
                                        println!("remote action: {:?}", action);
                                    }
                                    for conflict in &plan.conflicts {
                                        println!("remote conflict: {:?}", conflict);
                                    }
                                }
                                persist_manifest_state(&sync_state_path, &remote_manifest)?;
                                base_manifest = remote_manifest;
                                if let Some(last) = &last_published_manifest
                                    && manifests_state_eq(last, &base_manifest) {
                                    last_published_manifest = None;
                                }
                            }
                        }
                    }
                }
                node.shutdown().await?;
            }
        },
    }

    Ok(())
}

fn persist_manifest_state(path: &std::path::Path, manifest: &altair_vega::SyncManifest) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create manifest state parent {}", parent.display()))?;
    }
    std::fs::write(
        path,
        serde_json::to_vec_pretty(manifest).context("serialize published manifest state")?,
    )
    .with_context(|| format!("write manifest state {}", path.display()))?;
    Ok(())
}

async fn wait_for_remote_manifest(
    node: &sync_docs::DocsSyncNode,
    doc: &iroh_docs::api::Doc,
    wait_ms: u64,
    require_non_empty: bool,
) -> Result<altair_vega::SyncManifest> {
    let attempts = if require_non_empty { 10 } else { 1 };
    let delay = std::time::Duration::from_millis(wait_ms.max(250));
    let mut last = altair_vega::SyncManifest::default();
    for attempt in 0..attempts {
        let manifest = node.read_doc_manifest(doc).await?;
        if !require_non_empty || !manifest.is_empty() {
            return Ok(manifest);
        }
        last = manifest;
        if attempt + 1 < attempts {
            tokio::time::sleep(delay).await;
        }
    }
    Ok(last)
}
