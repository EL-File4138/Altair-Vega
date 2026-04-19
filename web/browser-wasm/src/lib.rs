use altair_vega::ShortCode;
use anyhow::{Context, Result};
use async_channel::Sender;
use iroh::{
    Endpoint, EndpointId,
    endpoint::Connection,
    protocol::{AcceptError, ProtocolHandler, Router},
};
use n0_future::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tracing::level_filters::LevelFilter;
use tracing_subscriber_wasm::MakeConsoleWriter;
use wasm_bindgen::{JsError, prelude::wasm_bindgen};
use wasm_streams::{ReadableStream, readable::sys::ReadableStream as JsReadableStream};

const WEB_MESSAGE_ALPN: &[u8] = b"altair-vega/browser-message/1";
const MAX_MESSAGE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone)]
pub struct BrowserNode {
    router: Router,
    event_sender: Sender<BrowserEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BrowserEvent {
    Ready { endpoint_id: String },
    ReceivedMessage { endpoint_id: String, body: String },
    SentMessage { endpoint_id: String, body: String },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BrowserPacket {
    body: String,
}

#[derive(Debug, Clone)]
struct BrowserProtocol {
    event_sender: Sender<BrowserEvent>,
}

impl BrowserNode {
    async fn spawn_inner() -> Result<(Self, async_channel::Receiver<BrowserEvent>)> {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .alpns(vec![WEB_MESSAGE_ALPN.to_vec()])
            .bind()
            .await
            .context("bind browser endpoint")?;
        let (event_sender, event_receiver) = async_channel::unbounded();
        let node_event_sender = event_sender.clone();
        event_sender
            .send(BrowserEvent::Ready {
                endpoint_id: endpoint.id().to_string(),
            })
            .await
            .ok();
        let protocol = BrowserProtocol { event_sender };
        let router = Router::builder(endpoint)
            .accept(WEB_MESSAGE_ALPN, protocol)
            .spawn();
        Ok((Self { router, event_sender: node_event_sender }, event_receiver))
    }

    async fn send_message_inner(&self, endpoint_id: EndpointId, body: String) -> Result<()> {
        let connection = self
            .router
            .endpoint()
            .connect(endpoint_id, WEB_MESSAGE_ALPN)
            .await
            .context("dial remote browser endpoint")?;

        let (mut send, mut recv) = connection.open_bi().await.context("open message stream")?;
        let payload = serde_json::to_vec(&BrowserPacket { body: body.clone() })
            .context("serialize browser packet")?;
        send.write_all(&payload)
            .await
            .context("write browser packet")?;
        send.finish().context("finish browser send stream")?;
        let _ = recv
            .read_to_end(MAX_MESSAGE_BYTES)
            .await
            .context("read browser ack")?;
        connection.close(0u8.into(), b"done");
        self.event_sender
            .send(BrowserEvent::SentMessage {
                endpoint_id: endpoint_id.to_string(),
                body,
            })
            .await
            .ok();
        Ok(())
    }

    fn endpoint_id_string(&self) -> String {
        self.router.endpoint().id().to_string()
    }
}

impl BrowserProtocol {
    async fn handle_connection(self, connection: Connection) -> std::result::Result<(), AcceptError> {
        let endpoint_id = connection.remote_id().to_string();
        let res = self.handle_connection_0(&connection).await;
        if let Err(error) = &res {
            self.event_sender
                .send(BrowserEvent::Error {
                    message: format!("browser connection error from {endpoint_id}: {error}"),
                })
                .await
                .ok();
        }
        res
    }

    async fn handle_connection_0(&self, connection: &Connection) -> std::result::Result<(), AcceptError> {
        let endpoint_id = connection.remote_id().to_string();
        let (mut send, mut recv) = connection.accept_bi().await?;
        let bytes = recv
            .read_to_end(MAX_MESSAGE_BYTES)
            .await
            .map_err(map_accept_error)?;
        let packet: BrowserPacket = serde_json::from_slice(&bytes).map_err(map_accept_error)?;
        self.event_sender
            .send(BrowserEvent::ReceivedMessage {
                endpoint_id,
                body: packet.body,
            })
            .await
            .ok();
        send.write_all(b"ok").await.map_err(map_accept_error)?;
        send.finish()?;
        connection.closed().await;
        Ok(())
    }
}

impl ProtocolHandler for BrowserProtocol {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        self.clone().handle_connection(connection).await
    }
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();

    tracing_subscriber::fmt()
        .with_max_level(LevelFilter::INFO)
        .with_writer(MakeConsoleWriter::default().map_trace_level_to(tracing::Level::DEBUG))
        .without_time()
        .with_ansi(false)
        .init();
}

#[wasm_bindgen]
pub struct WasmBrowserNode {
    inner: BrowserNode,
    events: async_channel::Receiver<BrowserEvent>,
}

#[wasm_bindgen]
impl WasmBrowserNode {
    pub async fn spawn() -> Result<WasmBrowserNode, JsError> {
        let (inner, events) = BrowserNode::spawn_inner().await.map_err(to_js_err)?;
        Ok(Self { inner, events })
    }

    pub fn endpoint_id(&self) -> String {
        self.inner.endpoint_id_string()
    }

    pub fn events(&self) -> JsReadableStream {
        into_js_readable_stream(self.events.clone())
    }

    pub async fn send_message(&self, endpoint_id: String, body: String) -> Result<(), JsError> {
        let endpoint_id = endpoint_id
            .parse()
            .context("parse endpoint id")
            .map_err(to_js_err)?;
        self.inner
            .send_message_inner(endpoint_id, body.clone())
            .await
            .map_err(to_js_err)?;
        Ok(())
    }

    pub async fn shutdown(self) -> Result<(), JsError> {
        self.inner.router.shutdown().await.map_err(to_js_err)?;
        Ok(())
    }
}

#[wasm_bindgen]
pub fn generate_short_code() -> String {
    ShortCode::generate().to_string()
}

#[wasm_bindgen]
pub fn normalize_short_code(value: String) -> Result<String, JsError> {
    let code = value.parse::<ShortCode>().map_err(to_js_err)?;
    Ok(code.normalized())
}

fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    let err: anyhow::Error = err.into();
    JsError::new(&err.to_string())
}

fn map_accept_error(err: impl std::fmt::Display) -> AcceptError {
    std::io::Error::other(err.to_string()).into()
}

fn into_js_readable_stream<T>(stream: impl Stream<Item = T> + 'static) -> JsReadableStream
where
    T: Serialize,
{
    let stream = stream.map(|event| Ok(serde_wasm_bindgen::to_value(&event).unwrap()));
    ReadableStream::from_stream(stream).into_raw()
}
