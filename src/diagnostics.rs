//! Deliberately closed diagnostics vocabulary: no strings from peers or errors.
use iroh::{
    TransportAddr,
    endpoint::{Connection, PathEvent, WeakConnectionHandle},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub at_ms: u64,
    pub stage: Stage,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<Path>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lost_packets: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_datagrams: Option<u64>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Startup,
    Endpoint,
    Rendezvous,
    Dial,
    Handshake,
    Path,
    Transfer,
    Close,
    Session,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Start,
    Ok,
    Failed,
    Timeout,
    Retry,
    Normal,
    Transport,
    Application,
    Unknown,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Path {
    Direct,
    Relay,
    Unknown,
}
impl Event {
    pub fn new(stage: Stage, outcome: Outcome) -> Self {
        Self {
            at_ms: 0,
            stage,
            outcome,
            path: None,
            rtt_ms: None,
            lost_packets: None,
            sent_datagrams: None,
        }
    }
    pub fn connection(connection: &Connection) -> Self {
        let mut event = Self::new(Stage::Path, Outcome::Ok);
        if let Some(path) = connection.paths().iter().find(|path| path.is_selected()) {
            event.path = Some(Path::from_transport(path.remote_addr()));
            event.set_path_stats(&path.stats());
        }
        event
    }

    pub fn path_change(change: PathEvent, weak: &WeakConnectionHandle) -> Option<Self> {
        match change {
            PathEvent::Selected {
                id, remote_addr, ..
            } => {
                let mut event = Self::new(Stage::Path, Outcome::Ok);
                // Classify the event itself: selection can change again before we read stats.
                event.path = Some(Path::from_transport(&remote_addr));
                if let Some(connection) = weak.upgrade()
                    && let Some(path) = connection.paths().iter().find(|path| path.id() == id)
                {
                    event.set_path_stats(&path.stats());
                }
                Some(event)
            }
            PathEvent::Lagged { .. } => weak
                .upgrade()
                .map(|connection| Self::connection(&connection)),
            _ => None,
        }
    }

    fn set_path_stats(&mut self, stats: &iroh::endpoint::PathStats) {
        const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
        self.rtt_ms = Some(stats.rtt.as_millis().min(u128::from(MAX_SAFE_INTEGER)) as u64);
        self.lost_packets = Some(stats.lost_packets.min(MAX_SAFE_INTEGER));
        self.sent_datagrams = Some(stats.udp_tx.datagrams.min(MAX_SAFE_INTEGER));
    }

    pub fn closed(error: &iroh::endpoint::ConnectionError) -> Self {
        use iroh::endpoint::ConnectionError;
        let outcome = match error {
            ConnectionError::TimedOut => Outcome::Timeout,
            ConnectionError::LocallyClosed => Outcome::Normal,
            ConnectionError::ApplicationClosed(_) => Outcome::Application,
            ConnectionError::TransportError(_)
            | ConnectionError::ConnectionClosed(_)
            | ConnectionError::Reset => Outcome::Transport,
            _ => Outcome::Unknown,
        };
        Self::new(Stage::Close, outcome)
    }
}

impl Path {
    fn from_transport(address: &TransportAddr) -> Self {
        match address {
            TransportAddr::Ip(_) => Self::Direct,
            TransportAddr::Relay(_) => Self::Relay,
            _ => Self::Unknown,
        }
    }
}

/// Keep normal third-party builds free of the collector and its HTTP client.
#[cfg(not(target_arch = "wasm32"))]
pub fn attach(builder: iroh::endpoint::Builder) -> iroh::endpoint::Builder {
    #[cfg(feature = "telemetry")]
    {
        crate::telemetry::record(Event::new(Stage::Endpoint, Outcome::Start));
        builder.hooks(crate::telemetry::Hooks)
    }
    #[cfg(not(feature = "telemetry"))]
    {
        builder
    }
}
