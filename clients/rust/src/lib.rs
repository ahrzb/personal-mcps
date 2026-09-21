//! Keep an RMCP server reachable through a personal-mcps hub's reverse tunnel.

use std::{
    collections::BTreeMap,
    env,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use rmcp::{
    ServerHandler,
    model::RequestMetaObject,
    schemars::Schema,
    service::{RoleServer, RxJsonRpcMessage, TxJsonRpcMessage, serve_directly},
    transport::Transport,
};
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use tokio::{net::TcpStream, sync::Mutex as AsyncMutex, time::Instant};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderValue, header::AUTHORIZATION},
    },
};

/// MCP revision spoken by the reverse tunnel.
pub const PROTOCOL_VERSION: &str = "2026-07-28";

const REGISTER_METHOD: &str = "hub/register";
const REPLACED_METHOD: &str = "hub/replaced";
const REGISTER_ID: &str = "hub-register-1";
const CLIENT_VERSION: &str = "pmcp-rust/0";
const PING_EVERY: Duration = Duration::from_secs(25);
const MAX_ONLY_ATTEMPT: u32 = 6;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type SocketSink = SplitSink<Socket, Message>;
type SocketStream = SplitStream<Socket>;

/// A role's patterns grouped by MCP capability family.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Families {
    /// Tool-name patterns granted by this role.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    /// Prompt-name patterns granted by this role.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub prompts: Vec<String>,
    /// Resource-URI patterns granted by this role.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<String>,
}

/// One role declaration, either the tools-only shorthand or per-family patterns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Role {
    /// Tool-name patterns using the original shorthand.
    Tools(Vec<String>),
    /// Patterns separated by tools, prompts, and resources.
    Families(Families),
}

/// Role name to declaration, sent unchanged for hub-side validation.
pub type Roles = BTreeMap<String, Role>;

/// Optional hub-local TypeScript names; canonical MCP names remain unchanged.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeScriptAliases {
    /// Preferred TypeScript service namespace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    /// Canonical tool name to preferred TypeScript name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tools: BTreeMap<String, String>,
}

/// Connection settings for [`serve`] and [`HubTransport`].
#[derive(Clone, Debug, Default)]
pub struct Options {
    /// Bare HTTP(S) hub origin; [`serve`] falls back to `PMCP_URL`.
    pub url: Option<String>,
    /// App bearer token; [`serve`] falls back to `PMCP_APP_TOKEN`.
    pub token: Option<String>,
    /// Role declarations registered with the hub.
    pub roles: Roles,
    /// Optional hub-local TypeScript alias hints.
    pub typescript_aliases: Option<TypeScriptAliases>,
}

/// A failure that stops the SDK rather than triggering another reconnect.
#[derive(Debug, Error)]
pub enum Error {
    /// Neither `Options::url` nor `PMCP_URL` supplied a hub origin.
    #[error("pmcp: no hub URL; set Options::url or PMCP_URL")]
    MissingUrl,
    /// Neither `Options::token` nor `PMCP_APP_TOKEN` supplied an app token.
    #[error("pmcp: no app token; set Options::token or PMCP_APP_TOKEN")]
    MissingToken,
    /// The configured URL was not a bare HTTP(S) origin.
    #[error("pmcp: expected a bare HTTP(S) hub origin, got {0:?}")]
    InvalidOrigin(String),
    /// The token could not be represented as an HTTP Authorization header.
    #[error("pmcp: app token is not a valid HTTP header value")]
    InvalidToken,
    /// The hub rejected or revoked the app credential.
    #[error("pmcp: the hub rejected or revoked the app credential ({status})")]
    Credentials {
        /// HTTP status or WebSocket close code identifying the refusal.
        status: u16,
    },
    /// The hub rejected the role or alias declaration.
    #[error("pmcp: hub/register rejected: {message}")]
    Registration {
        /// Hub-provided cause with credential values excluded.
        message: String,
    },
    /// The RMCP service task failed internally.
    #[error("pmcp: RMCP service task failed: {0}")]
    ServiceTask(#[from] tokio::task::JoinError),
}

/// The hub-asserted caller identity forwarded in a request's `_meta`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CallerIdentity {
    /// Stable authorization principal, or empty for a non-hub request.
    pub principal: String,
    /// Granted role names exactly as asserted by the hub.
    pub roles: Vec<String>,
}

impl CallerIdentity {
    /// Report whether this caller has `role` or the built-in `all` role.
    pub fn has_role(&self, role: &str) -> bool {
        self.roles
            .iter()
            .any(|candidate| candidate == role || candidate == "all")
    }
}

/// Read hub caller identity from an RMCP request context's metadata.
pub fn caller(meta: &RequestMetaObject) -> CallerIdentity {
    let principal = meta
        .get("hub/principal")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let roles = meta
        .get("hub/roles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    CallerIdentity { principal, roles }
}

/// A sensitive-field path did not name a JSON Schema property.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("pmcp: sensitive path {path:?} names no property in this schema")]
pub struct SensitiveError {
    /// The rejected dot-separated property path.
    pub path: String,
}

/// Clone a JSON Schema and mark its root `writeOnly`.
pub fn secret(schema: &Schema) -> Schema {
    let mut marked = schema.clone();
    marked.insert("writeOnly".to_owned(), Value::Bool(true));
    marked
}

/// Clone a JSON Schema and mark each dot-separated property path `writeOnly`.
pub fn sensitive<I, P>(schema: &Schema, paths: I) -> Result<Schema, SensitiveError>
where
    I: IntoIterator<Item = P>,
    P: AsRef<str>,
{
    let mut value = schema.clone().to_value();
    for path in paths {
        let path = path.as_ref();
        let segments = path.split('.').collect::<Vec<_>>();
        mark_sensitive(&mut value, &segments, path)?;
    }
    Ok(Schema::try_from(value).expect("a cloned JSON Schema remains a schema"))
}

fn mark_sensitive(node: &mut Value, segments: &[&str], path: &str) -> Result<(), SensitiveError> {
    let Some((segment, rest)) = segments.split_first() else {
        return Err(SensitiveError {
            path: path.to_owned(),
        });
    };
    let child = node
        .as_object_mut()
        .and_then(|object| object.get_mut("properties"))
        .and_then(Value::as_object_mut)
        .and_then(|properties| properties.get_mut(*segment))
        .ok_or_else(|| SensitiveError {
            path: path.to_owned(),
        })?;
    if !rest.is_empty() {
        mark_sensitive(child, rest, path)
    } else {
        let object = child.as_object_mut().ok_or_else(|| SensitiveError {
            path: path.to_owned(),
        })?;
        object.insert("writeOnly".to_owned(), Value::Bool(true));
        Ok(())
    }
}

/// Derive `ws(s)://<host>/connect` from a bare HTTP(S) hub origin.
pub fn connect_address(origin: &str) -> Result<String, Error> {
    let mut url = url::Url::parse(origin).map_err(|_| Error::InvalidOrigin(origin.to_owned()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InvalidOrigin(origin.to_owned()));
    }
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme)
        .expect("ws schemes accept HTTP URL structure");
    url.set_path("/connect");
    Ok(url.into())
}

/// Return the full-jitter reconnect delay for a zero-based failure attempt.
pub fn backoff_delay(attempt: u32, draw: f64) -> Duration {
    let ceiling = (1_u64 << attempt.min(MAX_ONLY_ATTEMPT)).min(60);
    Duration::from_secs_f64(draw.clamp(0.0, 1.0) * ceiling as f64)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Schedule {
    Exponential,
    MaxOnly,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Ending {
    Quiet,
    Credentials(u16),
    Reconnect(Schedule),
}

fn ending_for_upgrade(status: u16) -> Ending {
    match status {
        401 => Ending::Credentials(status),
        403 => Ending::Reconnect(Schedule::MaxOnly),
        _ => Ending::Reconnect(Schedule::Exponential),
    }
}

fn ending_for_close(code: u16) -> Ending {
    match code {
        4000 => Ending::Quiet,
        4001 => Ending::Credentials(code),
        4002 => Ending::Reconnect(Schedule::MaxOnly),
        _ => Ending::Reconnect(Schedule::Exponential),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Terminal {
    Quiet,
    Credentials(u16),
    Registration(String),
}

#[derive(Default)]
struct Shared {
    sink: AsyncMutex<Option<SocketSink>>,
    terminal: Mutex<Option<Terminal>>,
    closed: AtomicBool,
}

/// RMCP transport backed by the hub's reconnecting reverse WebSocket.
pub struct HubTransport {
    address: String,
    authorization: HeaderValue,
    roles: Roles,
    aliases: Option<TypeScriptAliases>,
    shared: Arc<Shared>,
    stream: Option<SocketStream>,
    next_ping: Option<Instant>,
    awaiting_pong: bool,
    attempt: u32,
    next_schedule: Option<Schedule>,
}

impl HubTransport {
    /// Validate explicit connection options without performing network I/O.
    pub fn new(options: Options) -> Result<Self, Error> {
        let url = options
            .url
            .filter(|value| !value.is_empty())
            .ok_or(Error::MissingUrl)?;
        let token = options
            .token
            .filter(|value| !value.is_empty())
            .ok_or(Error::MissingToken)?;
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| Error::InvalidToken)?;
        authorization.set_sensitive(true);
        Ok(Self {
            address: connect_address(&url)?,
            authorization,
            roles: options.roles,
            aliases: options.typescript_aliases,
            shared: Arc::default(),
            stream: None,
            next_ping: None,
            awaiting_pong: false,
            attempt: 0,
            next_schedule: None,
        })
    }

    fn set_terminal(&self, terminal: Terminal) {
        *self.shared.terminal.lock().expect("terminal lock poisoned") = Some(terminal);
    }

    async fn detach(&mut self) {
        self.stream = None;
        self.next_ping = None;
        self.awaiting_pong = false;
        self.shared.sink.lock().await.take();
    }

    async fn establish(&mut self) -> bool {
        loop {
            if self.shared.closed.load(Ordering::Acquire) {
                return false;
            }
            if let Some(schedule) = self.next_schedule.take() {
                let attempt = match schedule {
                    Schedule::MaxOnly => MAX_ONLY_ATTEMPT,
                    Schedule::Exponential => {
                        let attempt = self.attempt;
                        self.attempt = self.attempt.saturating_add(1);
                        attempt
                    }
                };
                tokio::time::sleep(backoff_delay(attempt, rand::random())).await;
            }

            let mut request = match self.address.as_str().into_client_request() {
                Ok(request) => request,
                Err(_) => {
                    self.next_schedule = Some(Schedule::Exponential);
                    continue;
                }
            };
            request
                .headers_mut()
                .insert(AUTHORIZATION, self.authorization.clone());
            let socket = match connect_async(request).await {
                Ok((socket, _)) => socket,
                Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                    match ending_for_upgrade(response.status().as_u16()) {
                        Ending::Credentials(status) => {
                            self.set_terminal(Terminal::Credentials(status));
                            return false;
                        }
                        Ending::Reconnect(schedule) => self.next_schedule = Some(schedule),
                        Ending::Quiet => unreachable!(),
                    }
                    continue;
                }
                Err(_) => {
                    self.next_schedule = Some(Schedule::Exponential);
                    continue;
                }
            };

            match self.register(socket).await {
                Ok(socket) => {
                    self.attempt = 0;
                    let (sink, stream) = socket.split();
                    *self.shared.sink.lock().await = Some(sink);
                    self.stream = Some(stream);
                    self.next_ping = Some(Instant::now() + PING_EVERY);
                    self.awaiting_pong = false;
                    return true;
                }
                Err(RegisterFailure::Registration(message)) => {
                    self.set_terminal(Terminal::Registration(message));
                    return false;
                }
                Err(RegisterFailure::Ended(Ending::Quiet)) => {
                    self.set_terminal(Terminal::Quiet);
                    return false;
                }
                Err(RegisterFailure::Ended(Ending::Credentials(status))) => {
                    self.set_terminal(Terminal::Credentials(status));
                    return false;
                }
                Err(RegisterFailure::Ended(Ending::Reconnect(schedule))) => {
                    self.next_schedule = Some(schedule);
                }
            }
        }
    }

    async fn register(&self, mut socket: Socket) -> Result<Socket, RegisterFailure> {
        let request = RegisterRequest {
            jsonrpc: "2.0",
            id: REGISTER_ID,
            method: REGISTER_METHOD,
            params: RegisterParams {
                client_version: CLIENT_VERSION,
                protocol_version: PROTOCOL_VERSION,
                roles: &self.roles,
                typescript_aliases: self.aliases.as_ref(),
            },
        };
        let payload = match serde_json::to_string(&request) {
            Ok(payload) => payload,
            Err(error) => return Err(RegisterFailure::Registration(error.to_string())),
        };
        if socket.send(Message::text(payload)).await.is_err() {
            return Err(RegisterFailure::Ended(Ending::Reconnect(
                Schedule::Exponential,
            )));
        }
        while let Some(message) = socket.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    if frame.get("id") != Some(&Value::String(REGISTER_ID.to_owned())) {
                        continue;
                    }
                    if let Some(error) = frame.get("error") {
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("registration failed")
                            .to_owned();
                        return Err(RegisterFailure::Registration(message));
                    }
                    if frame.get("result").is_some() {
                        return Ok(socket);
                    }
                }
                Ok(Message::Close(frame)) => {
                    let code = frame.map_or(1006, |frame| frame.code.into());
                    return Err(RegisterFailure::Ended(ending_for_close(code)));
                }
                Ok(_) => {}
                Err(_) => {
                    return Err(RegisterFailure::Ended(Ending::Reconnect(
                        Schedule::Exponential,
                    )));
                }
            }
        }
        Err(RegisterFailure::Ended(Ending::Reconnect(
            Schedule::Exponential,
        )))
    }

    async fn receive_message(&mut self) -> Option<RxJsonRpcMessage<RoleServer>> {
        loop {
            if self.stream.is_none() && !self.establish().await {
                return None;
            }
            let next_ping = self
                .next_ping
                .expect("connected sockets have a ping deadline");
            let stream = self.stream.as_mut().expect("establish installs a stream");
            tokio::select! {
                _ = tokio::time::sleep_until(next_ping) => {
                    if self.awaiting_pong {
                        self.detach().await;
                        self.next_schedule = Some(Schedule::Exponential);
                        continue;
                    }
                    let sent = if let Some(sink) = self.shared.sink.lock().await.as_mut() {
                        sink.send(Message::Ping(Vec::new().into())).await.is_ok()
                    } else {
                        false
                    };
                    if sent {
                        self.awaiting_pong = true;
                        self.next_ping = Some(Instant::now() + PING_EVERY);
                    } else {
                        self.detach().await;
                        self.next_schedule = Some(Schedule::Exponential);
                    }
                }
                incoming = stream.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            let Ok(mut frame) = serde_json::from_str::<Value>(&text) else {
                                continue;
                            };
                            if frame.get("method").and_then(Value::as_str) == Some(REPLACED_METHOD) {
                                continue;
                            }
                            adapt_subscriptions(&mut frame);
                            if let Ok(message) = serde_json::from_value(frame) {
                                return Some(message);
                            }
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            if let Some(sink) = self.shared.sink.lock().await.as_mut() {
                                let _ = sink.send(Message::Pong(payload)).await;
                            }
                        }
                        Some(Ok(Message::Pong(_))) => {
                            self.awaiting_pong = false;
                        }
                        Some(Ok(Message::Close(frame))) => {
                            let code = frame.map_or(1006, |frame| frame.code.into());
                            self.detach().await;
                            match ending_for_close(code) {
                                Ending::Quiet => {
                                    self.set_terminal(Terminal::Quiet);
                                    return None;
                                }
                                Ending::Credentials(status) => {
                                    self.set_terminal(Terminal::Credentials(status));
                                    return None;
                                }
                                Ending::Reconnect(schedule) => self.next_schedule = Some(schedule),
                            }
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => {
                            self.detach().await;
                            self.next_schedule = Some(Schedule::Exponential);
                        }
                    }
                }
            }
        }
    }
}

impl Transport<RoleServer> for HubTransport {
    type Error = TransportError;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleServer>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let payload = serde_json::to_string(&item).map(Message::text);
        let shared = self.shared.clone();
        async move {
            let payload = payload?;
            let mut current = shared.sink.lock().await;
            let Some(sink) = current.as_mut() else {
                return Ok(());
            };
            let _ = sink.send(payload).await;
            Ok(())
        }
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleServer>> {
        self.receive_message().await
    }

    async fn close(&mut self) -> Result<(), Self::Error> {
        self.shared.closed.store(true, Ordering::Release);
        self.stream = None;
        if let Some(mut sink) = self.shared.sink.lock().await.take() {
            let _ = sink.close().await;
        }
        Ok(())
    }
}

/// Serialization failure while sending an RMCP message.
#[derive(Debug, Error)]
pub enum TransportError {
    /// An RMCP message could not be encoded as JSON.
    #[error("pmcp: could not encode RMCP message: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Serialize)]
struct RegisterRequest<'a> {
    jsonrpc: &'static str,
    id: &'static str,
    method: &'static str,
    params: RegisterParams<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterParams<'a> {
    client_version: &'static str,
    protocol_version: &'static str,
    roles: &'a Roles,
    #[serde(skip_serializing_if = "Option::is_none")]
    typescript_aliases: Option<&'a TypeScriptAliases>,
}

enum RegisterFailure {
    Registration(String),
    Ended(Ending),
}

fn adapt_subscriptions(frame: &mut Value) {
    let method = frame.get("method").and_then(Value::as_str);
    if !matches!(
        method,
        Some("resources/subscribe" | "resources/unsubscribe")
    ) {
        return;
    }
    if let Some(meta) = frame
        .get_mut("params")
        .and_then(Value::as_object_mut)
        .and_then(|params| params.get_mut("_meta"))
        .and_then(Value::as_object_mut)
    {
        meta.remove("io.modelcontextprotocol/protocolVersion");
    }
}

fn terminal_error(shared: &Shared) -> Option<Error> {
    match shared
        .terminal
        .lock()
        .expect("terminal lock poisoned")
        .clone()
    {
        Some(Terminal::Credentials(status)) => Some(Error::Credentials { status }),
        Some(Terminal::Registration(message)) => Some(Error::Registration { message }),
        Some(Terminal::Quiet) | None => None,
    }
}

/// Run an RMCP server through the hub until replacement, cancellation, or a terminal error.
pub async fn serve<S>(server: S, mut options: Options) -> Result<(), Error>
where
    S: ServerHandler,
{
    if options.url.as_deref().is_none_or(str::is_empty) {
        options.url = env::var("PMCP_URL").ok();
    }
    if options.token.as_deref().is_none_or(str::is_empty) {
        options.token = env::var("PMCP_APP_TOKEN").ok();
    }
    let transport = HubTransport::new(options)?;
    let shared = transport.shared.clone();
    let running = serve_directly::<RoleServer, _, _, _, _>(server, transport, None);
    running.waiting().await?;
    if let Some(error) = terminal_error(&shared) {
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::{
        ErrorData, ServerHandler,
        model::SubscribeRequestParams,
        service::{RequestContext, RoleServer},
    };
    use serde_json::json;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::{
            handshake::server::{Request, Response},
            protocol::CloseFrame,
        },
    };

    #[derive(Clone, Debug)]
    struct TestServer {
        subscribed: Arc<AtomicBool>,
    }

    impl ServerHandler for TestServer {
        #[allow(deprecated)]
        fn subscribe(
            &self,
            _request: SubscribeRequestParams,
            _context: RequestContext<RoleServer>,
        ) -> impl Future<Output = Result<(), ErrorData>> + Send + '_ {
            self.subscribed.store(true, Ordering::Release);
            std::future::ready(Ok(()))
        }
    }

    #[test]
    fn address_and_backoff_boundaries() {
        assert_eq!(
            connect_address("https://example.com").unwrap(),
            "wss://example.com/connect"
        );
        assert_eq!(
            connect_address("http://localhost:8787/").unwrap(),
            "ws://localhost:8787/connect"
        );
        assert!(connect_address("https://example.com/path").is_err());
        assert_eq!(backoff_delay(0, 0.5), Duration::from_millis(500));
        assert_eq!(backoff_delay(20, 1.0), Duration::from_secs(60));
    }

    #[test]
    fn caller_and_sensitive_schema() {
        let meta: RequestMetaObject = serde_json::from_value(json!({
            "hub/principal": "agent:claude",
            "hub/roles": ["reader"]
        }))
        .unwrap();
        let identity = caller(&meta);
        assert_eq!(identity.principal, "agent:claude");
        assert!(identity.has_role("reader"));

        let schema = Schema::try_from(json!({
            "type": "object",
            "properties": {"credentials": {"type": "object", "properties": {"token": {"type": "string"}}}}
        }))
        .unwrap();
        let marked = sensitive(&schema, ["credentials.token"]).unwrap();
        assert_eq!(
            marked.pointer("/properties/credentials/properties/token/writeOnly"),
            Some(&Value::Bool(true))
        );
        assert!(sensitive(&schema, ["credentials.missing"]).is_err());
    }

    #[test]
    fn matches_shared_wire_contracts() {
        let tunnel: Value =
            serde_json::from_str(include_str!("../../../contracts/tunnel-frames.json")).unwrap();
        assert_eq!(tunnel["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(tunnel["methods"]["register"], REGISTER_METHOD);
        assert_eq!(tunnel["methods"]["replaced"], REPLACED_METHOD);

        let close_codes: Value =
            serde_json::from_str(include_str!("../../../contracts/close-codes.json")).unwrap();
        for row in close_codes["entries"].as_object().unwrap().values() {
            let code = row["code"].as_u64().unwrap() as u16;
            let ending = if row["kind"] == "upgrade" {
                ending_for_upgrade(code)
            } else {
                ending_for_close(code)
            };
            let (behavior, schedule) = match ending {
                Ending::Quiet => ("stop_quiet", None),
                Ending::Credentials(_) => ("stop_fatal", None),
                Ending::Reconnect(Schedule::Exponential) => ("reconnect", Some("exponential")),
                Ending::Reconnect(Schedule::MaxOnly) => ("reconnect", Some("max_only")),
            };
            assert_eq!(row["behavior"], behavior);
            assert_eq!(row.get("schedule").and_then(Value::as_str), schedule);
        }
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn bridges_the_official_sdk_over_the_reverse_tunnel() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let hub = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(tcp, |request: &Request, response: Response| {
                assert_eq!(
                    request.headers().get(AUTHORIZATION).unwrap(),
                    "Bearer pmcp_app_test"
                );
                Ok(response)
            })
            .await
            .unwrap();

            let register = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let register: Value = serde_json::from_str(&register).unwrap();
            assert_eq!(register["method"], REGISTER_METHOD);
            assert_eq!(register["params"]["protocolVersion"], PROTOCOL_VERSION);
            assert_eq!(register["params"]["roles"]["reader"][0], "greet");
            assert_eq!(register["params"]["typescriptAliases"]["service"], "news");
            socket
                .send(Message::text(
                    json!({"jsonrpc": "2.0", "id": REGISTER_ID, "result": {"ok": true}})
                        .to_string(),
                ))
                .await
                .unwrap();

            socket
                .send(Message::text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": "discover",
                        "method": "server/discover",
                        "params": {
                            "_meta": {
                                "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
                                "io.modelcontextprotocol/clientInfo": {"name": "personal-mcps", "version": "0"},
                                "io.modelcontextprotocol/clientCapabilities": {}
                            }
                        }
                    })
                    .to_string(),
                ))
                .await
                .unwrap();
            let discover = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let discover: Value = serde_json::from_str(&discover).unwrap();
            assert!(discover.get("error").is_none(), "{discover}");
            assert_eq!(discover["result"]["resultType"], "complete");
            assert!(
                discover["result"]["supportedVersions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|version| version == PROTOCOL_VERSION)
            );

            socket
                .send(Message::text(
                    json!({
                        "jsonrpc": "2.0",
                        "id": "subscribe",
                        "method": "resources/subscribe",
                        "params": {
                            "uri": "news://today",
                            "_meta": {
                                "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
                                "io.modelcontextprotocol/clientInfo": {"name": "personal-mcps", "version": "0"},
                                "io.modelcontextprotocol/clientCapabilities": {},
                                "hub/principal": "agent:claude",
                                "hub/roles": ["reader"]
                            }
                        }
                    })
                    .to_string(),
                ))
                .await
                .unwrap();
            let subscribe = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let subscribe: Value = serde_json::from_str(&subscribe).unwrap();
            assert!(subscribe.get("error").is_none(), "{subscribe}");

            socket
                .send(Message::Close(Some(CloseFrame {
                    code: 4000.into(),
                    reason: "replaced".into(),
                })))
                .await
                .unwrap();
        });

        let subscribed = Arc::new(AtomicBool::new(false));

        let result = tokio::time::timeout(
            Duration::from_secs(5),
            serve(
                TestServer {
                    subscribed: subscribed.clone(),
                },
                Options {
                    url: Some(format!("http://{address}")),
                    token: Some("pmcp_app_test".to_owned()),
                    roles: BTreeMap::from([(
                        "reader".to_owned(),
                        Role::Tools(vec!["greet".to_owned()]),
                    )]),
                    typescript_aliases: Some(TypeScriptAliases {
                        service: Some("news".to_owned()),
                        tools: BTreeMap::new(),
                    }),
                },
            ),
        )
        .await
        .expect("serve timed out");
        assert!(result.is_ok(), "{result:?}");
        assert!(subscribed.load(Ordering::Acquire));
        hub.await.unwrap();
    }
}
