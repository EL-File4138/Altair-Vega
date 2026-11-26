//! Native bounded diagnostics. Never record formatted errors, addresses, or identifiers.
use crate::diagnostics::{Event, Outcome, Stage};
use iroh::endpoint::{AfterHandshakeOutcome, BeforeConnectOutcome, Connection, EndpointHooks};
use serde::Serialize;
use std::{
    collections::VecDeque,
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

struct State {
    start: Instant,
    events: Mutex<VecDeque<Event>>,
    output: Option<PathBuf>,
    uploader: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
static STATE: OnceLock<State> = OnceLock::new();
static UPLOAD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ATTEMPTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub fn init(disabled: bool, output: Option<PathBuf>) {
    if disabled
        || matches!(
            std::env::var("ALTAIR_VEGA_TELEMETRY").as_deref(),
            Ok("0" | "off" | "false")
        )
    {
        return;
    }
    init_enabled(output);
}

fn init_enabled(output: Option<PathBuf>) {
    let _ = STATE.set(State {
        start: Instant::now(),
        events: Mutex::new(VecDeque::new()),
        output,
        uploader: Mutex::new(None),
    });
    eprintln!(
        "Connectivity diagnostics enabled (no payloads or peer IDs). Disable with --no-telemetry or ALTAIR_VEGA_TELEMETRY=0."
    );
    record(Event::new(Stage::Startup, Outcome::Start));
    let uploader = tokio::spawn(async {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.tick().await;
        loop {
            interval.tick().await;
            submit(false).await;
        }
    });
    *STATE
        .get()
        .expect("initialized diagnostics")
        .uploader
        .lock()
        .expect("diagnostics uploader lock") = Some(uploader);
}

pub fn record(mut event: Event) {
    let Some(state) = STATE.get() else {
        return;
    };
    event.at_ms = state.start.elapsed().as_millis().min(9_007_199_254_740_991) as u64;
    let mut events = state.events.lock().expect("diagnostics lock");
    if events.len() == 96 {
        events.remove(16);
    }
    events.push_back(event);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema: u8,
    report_id: String,
    version: &'static str,
    runtime: &'static str,
    platform: &'static str,
    events: Vec<Event>,
}
fn snapshot() -> Option<Vec<u8>> {
    let state = STATE.get()?;
    let report = Report {
        schema: 1,
        report_id: rand::random::<[u8; 16]>()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        version: env!("CARGO_PKG_VERSION"),
        runtime: "native",
        platform: match std::env::consts::OS {
            "linux" => "linux",
            "macos" => "macos",
            "windows" => "windows",
            _ => "other",
        },
        events: state
            .events
            .lock()
            .expect("diagnostics lock")
            .iter()
            .copied()
            .collect(),
    };
    serde_json::to_vec(&report)
        .ok()
        .filter(|bytes| bytes.len() <= 32 * 1024)
}
fn export(bytes: &[u8], path: Option<&PathBuf>) {
    let fallback = std::env::temp_dir().join(format!(
        "altair-vega-diagnostics-{:032x}.json",
        rand::random::<u128>()
    ));
    let path = path.unwrap_or(&fallback);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options
        .open(path)
        .and_then(|mut file| file.write_all(bytes))
    {
        Ok(()) => eprintln!("Diagnostics exported: {}", path.display()),
        Err(_) => eprintln!("Diagnostics export failed (existing files are never overwritten)."),
    }
}
async fn submit(final_report: bool) {
    let Ok(_guard) = UPLOAD.try_lock() else {
        return;
    };
    use std::sync::atomic::Ordering;
    // Reserve one request for the terminal snapshot. Serialization under UPLOAD
    // makes the separate load/increment safe and avoids counting skipped ticks.
    if ATTEMPTS.load(Ordering::Relaxed) >= if final_report { 8 } else { 7 } {
        return;
    }
    ATTEMPTS.fetch_add(1, Ordering::Relaxed);
    let Some(bytes) = snapshot() else {
        return;
    };
    let url = option_env!("ALTAIR_VEGA_TELEMETRY_URL").unwrap_or("");
    let sent = async {
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(4))
            .build()
            .ok()?;
        let response = client
            .post(url)
            .header("Content-Type", "application/json")
            .body(bytes.clone())
            .send()
            .await
            .ok()?;
        (response.status().as_u16() == 201).then_some(())
    }
    .await
    .is_some();
    if !sent {
        export(&bytes, None);
    }
}
pub async fn finish(error: Option<&anyhow::Error>) {
    if STATE.get().is_none() {
        return;
    }
    let uploader = STATE
        .get()
        .and_then(|state| state.uploader.lock().ok()?.take());
    if let Some(uploader) = uploader {
        uploader.abort();
        let _ = uploader.await;
    }
    if let Some(error) = error {
        let outcome = if error.chain().any(|cause| {
            cause
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::TimedOut)
        }) {
            Outcome::Timeout
        } else {
            Outcome::Failed
        };
        let stage = STATE
            .get()
            .and_then(|state| {
                state.events.lock().ok().and_then(|events| {
                    events
                        .iter()
                        .rev()
                        .find(|event| matches!(event.outcome, Outcome::Start | Outcome::Retry))
                        .map(|event| event.stage)
                })
            })
            .unwrap_or(Stage::Session);
        record(Event::new(stage, outcome));
        for cause in error.chain() {
            if let Some(error) = cause.downcast_ref::<iroh::endpoint::ConnectionError>() {
                record(Event::closed(error));
                break;
            }
        }
    }
    record(Event::new(
        Stage::Session,
        if error.is_some() {
            Outcome::Failed
        } else {
            Outcome::Ok
        },
    ));
    if let Some(path) = STATE.get().and_then(|state| state.output.as_ref())
        && let Some(bytes) = snapshot()
    {
        export(&bytes, Some(path));
    }
    submit(true).await;
}

#[derive(Debug)]
pub struct Hooks;
impl EndpointHooks for Hooks {
    async fn before_connect<'a>(
        &'a self,
        _: &'a iroh::EndpointAddr,
        _: &'a [u8],
    ) -> BeforeConnectOutcome {
        record(Event::new(Stage::Dial, Outcome::Start));
        BeforeConnectOutcome::Accept
    }
    async fn after_handshake<'a>(&'a self, connection: &'a Connection) -> AfterHandshakeOutcome {
        if STATE.get().is_some() {
            record(Event::new(Stage::Handshake, Outcome::Ok));
            let mut changes = connection.path_events();
            record(Event::connection(connection));
            let weak = connection.weak_handle();
            // Register before returning from the hook: closed() preserves the
            // close event without retaining a strong connection reference.
            let closed = weak.closed();
            tokio::spawn(async move {
                if let Some(closed) = closed.await {
                    record(Event::closed(&closed.reason));
                }
            });
            tokio::spawn(async move {
                use futures_util::StreamExt;

                while let Some(change) = changes.next().await {
                    if let Some(event) = Event::path_change(change, &weak) {
                        record(event);
                    }
                }
            });
        }
        AfterHandshakeOutcome::accept()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shutdown_cancels_inflight_uploader_and_preserves_terminal_snapshot() {
        let temp = tempfile::tempdir().expect("diagnostics export directory");
        let output = temp.path().join("report.json");
        // Test the uploader independently of the operator's runtime opt-out.
        init_enabled(Some(output.clone()));
        let state = STATE.get().expect("initialized diagnostics");
        if let Some(task) = state.uploader.lock().expect("uploader lock").take() {
            task.abort();
        }
        for _ in 0..110 {
            record(Event::new(Stage::Dial, Outcome::Retry));
        }
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _guard = UPLOAD.lock().await;
            let _ = started.send(());
            std::future::pending::<()>().await;
        });
        *state.uploader.lock().expect("uploader lock") = Some(task);
        ready.await.expect("inflight uploader holds lock");
        tokio::time::timeout(Duration::from_secs(6), finish(None))
            .await
            .expect("bounded final flush");
        let report: serde_json::Value =
            serde_json::from_slice(&std::fs::read(output).expect("final export"))
                .expect("valid JSON");
        let events = report["events"].as_array().expect("events");
        assert_eq!(events.len(), 96);
        assert_eq!(events[0]["stage"], "startup");
        assert_eq!(events.last().expect("terminal event")["stage"], "session");
        assert_eq!(events.last().expect("terminal event")["outcome"], "ok");
        assert!(state.uploader.lock().expect("uploader lock").is_none());
    }
}
