// OpenAI Realtime translate provider — backend WebSocket bridge.
//
// Browsers can't set Authorization headers on WebSockets, so we run the WS
// in Rust. Frontend sends 16kHz s16le PCM via Tauri commands; we resample
// to 24kHz, base64-encode, and forward to OpenAI. Server events are parsed
// and emitted to the frontend via a Tauri Channel.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use http::Request;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{timeout, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::audio::resampler::UpsamplerTo24k;

const OPENAI_REALTIME_URL: &str =
    "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
pub struct OpenAiRealtimeConfig {
    pub api_key: String,
    pub source_language: String,
    pub target_language: String,
    pub voice: Option<String>,
    /// When true (default), server generates translated audio output.
    /// When false, requests text-only modality so no TTS audio is generated
    /// (saves cost and bandwidth — for read-only use cases).
    #[serde(default = "default_true")]
    pub audio_output: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OpenAiEvent {
    Status {
        state: String,
        message: Option<String>,
    },
    Transcript {
        text: String,
        is_final: bool,
    },
    SourceTranscript {
        text: String,
        is_final: bool,
    },
    AudioChunk {
        pcm_base64: String,
    },
    Error {
        code: String,
        message: String,
    },
    Closed {
        reason: String,
    },
}

struct Session {
    audio_tx: mpsc::UnboundedSender<Vec<u8>>,
    stop_tx: mpsc::UnboundedSender<()>,
    upsampler: Mutex<UpsamplerTo24k>,
    done_rx: oneshot::Receiver<()>,
}

#[derive(Default)]
pub struct OpenAiState {
    sessions: Arc<Mutex<HashMap<u64, Session>>>,
    next_id: Mutex<u64>,
}

#[tauri::command]
pub async fn openai_realtime_start(
    config: OpenAiRealtimeConfig,
    on_event: Channel<OpenAiEvent>,
    state: State<'_, OpenAiState>,
) -> Result<u64, String> {
    if config.api_key.trim().is_empty() {
        return Err("OpenAI API key is empty".into());
    }

    let session_id = {
        let mut id = state.next_id.lock().unwrap();
        *id += 1;
        *id
    };

    let upsampler = UpsamplerTo24k::new()?;

    let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = mpsc::unbounded_channel::<()>();
    let (done_tx, done_rx) = oneshot::channel();

    let session = Session {
        audio_tx,
        stop_tx,
        upsampler: Mutex::new(upsampler),
        done_rx,
    };
    state.sessions.lock().unwrap().insert(session_id, session);

    let event_ch = on_event.clone();
    let sessions = state.sessions.clone();
    let cfg = OpenAiRealtimeConfig {
        api_key: config.api_key,
        source_language: config.source_language,
        target_language: config.target_language,
        voice: config.voice,
        audio_output: config.audio_output,
    };

    tokio::spawn(async move {
        crate::diagnostics::record_native_event("openai", "session_started", None);
        let _ = event_ch.send(OpenAiEvent::Status {
            state: "connecting".into(),
            message: None,
        });

        let key = cfg.api_key.trim().to_owned();
        let result = run_session(
            cfg,
            OPENAI_REALTIME_URL,
            audio_rx,
            stop_rx,
            event_ch.clone(),
        )
        .await;
        if let Err(message) = &result {
            crate::diagnostics::record_native_failure("openai", message);
        }
        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(&session_id);
        }
        // The owner emits the only terminal notification, including protocol
        // session.closed and WebSocket Close. Duplicate Closed events used to
        // start competing frontend reconnects/capture streams.
        emit_session_end(result, &key, &event_ch);
        crate::diagnostics::record_native_event("openai", "session_closed", None);
        let _ = done_tx.send(());
    });

    Ok(session_id)
}

#[tauri::command]
pub async fn openai_realtime_send_audio(
    session_id: u64,
    pcm: Vec<u8>,
    state: State<'_, OpenAiState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    let upsampled = session.upsampler.lock().unwrap().push(&pcm)?;
    if !upsampled.is_empty() {
        session
            .audio_tx
            .send(upsampled)
            .map_err(|e| format!("send audio failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn openai_realtime_stop(
    session_id: u64,
    state: State<'_, OpenAiState>,
) -> Result<(), String> {
    let session = state.sessions.lock().unwrap().remove(&session_id);
    if let Some(session) = session {
        let _ = session.stop_tx.send(());
        let _ = timeout(
            WRITE_TIMEOUT + CLOSE_TIMEOUT + Duration::from_secs(1),
            session.done_rx,
        )
        .await;
    }
    Ok(())
}

fn emit_session_end(result: Result<String, String>, key: &str, event_ch: &Channel<OpenAiEvent>) {
    let scrub = |message: String| {
        if key.is_empty() {
            message
        } else {
            message.replace(key, "[redacted]")
        }
    };
    let reason = match result {
        Ok(reason) => scrub(reason),
        Err(message) => {
            let _ = event_ch.send(OpenAiEvent::Error {
                code: "session_failed".into(),
                message: scrub(message),
            });
            "error".into()
        }
    };
    let _ = event_ch.send(OpenAiEvent::Closed { reason });
}

async fn run_session(
    cfg: OpenAiRealtimeConfig,
    url: &str,
    mut audio_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    mut stop_rx: mpsc::UnboundedReceiver<()>,
    event_ch: Channel<OpenAiEvent>,
) -> Result<String, String> {
    // Build WebSocket request with auth headers
    let request = Request::builder()
        .uri(url)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .header("Host", "api.openai.com")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        )
        .body(())
        .map_err(|e| format!("build request: {}", e))?;

    let (ws_stream, _) = tokio::select! {
        biased;
        _ = stop_rx.recv() => return Ok("stopped".into()),
        result = timeout(CONNECT_TIMEOUT, connect_async(request)) => {
            result.map_err(|_| "OpenAI 连接超时，请检查网络")?
                .map_err(|e| format!("websocket connect: {}", e))?
        }
    };

    let (mut ws_sink, mut ws_stream) = ws_stream.split();

    // Send session.update once connected
    let session_update = build_session_update(&cfg);
    timeout(
        WRITE_TIMEOUT,
        ws_sink.send(Message::Text(session_update.into())),
    )
    .await
    .map_err(|_| "OpenAI 配置发送超时")?
    .map_err(|e| format!("send session.update: {}", e))?;

    let _ = event_ch.send(OpenAiEvent::Status {
        state: "ready".into(),
        message: None,
    });
    let mut heartbeat = Heartbeat::new(Instant::now());

    loop {
        tokio::select! {
            biased;

            _ = stop_rx.recv() => {
                let _ = timeout(CLOSE_TIMEOUT, ws_sink.send(Message::Close(None))).await;
                return Ok("stopped".into());
            }
            _ = tokio::time::sleep_until(heartbeat.deadline) => {
                heartbeat.probe(Instant::now())?;
                timeout(WRITE_TIMEOUT, ws_sink.send(Message::Ping(Vec::new().into()))).await
                    .map_err(|_| "OpenAI 心跳发送超时")?
                    .map_err(|e| format!("OpenAI 心跳发送失败：{e}"))?;
            }
            msg = ws_stream.next() => {
                if matches!(&msg, Some(Ok(_))) {
                    heartbeat.received(Instant::now());
                }
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(reason) = handle_server_event(&text, &event_ch, cfg.audio_output) {
                            let _ = timeout(CLOSE_TIMEOUT, ws_sink.send(Message::Close(None))).await;
                            return Ok(reason.into());
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Ping(data))) => {
                        timeout(WRITE_TIMEOUT, ws_sink.send(Message::Pong(data))).await
                            .map_err(|_| "OpenAI 心跳回复超时")?
                            .map_err(|e| format!("OpenAI 心跳回复失败：{e}"))?;
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let reason = frame
                            .map(|f| format!("{}: {}", f.code, f.reason))
                            .unwrap_or_else(|| "remote_close".into());
                        return Ok(reason);
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(format!("ws error: {}", e)),
                    None => return Ok("remote_close".into()),
                }
            }
            Some(audio_chunk) = audio_rx.recv() => {
                let evt = serde_json::json!({
                    "type": "session.input_audio_buffer.append",
                    "audio": B64.encode(&audio_chunk),
                });
                timeout(WRITE_TIMEOUT, ws_sink.send(Message::Text(evt.to_string().into()))).await
                    .map_err(|_| "OpenAI 音频发送超时")?
                    .map_err(|e| format!("send audio: {}", e))?;
            }
        }
    }
}

// Audio or transcript silence is normal. Only missing transport responses to
// a probe count as a dead connection; outgoing audio does not reset this clock.
struct Heartbeat {
    deadline: Instant,
    awaiting_response: bool,
}

impl Heartbeat {
    fn new(now: Instant) -> Self {
        Self {
            deadline: now + HEARTBEAT_INTERVAL,
            awaiting_response: false,
        }
    }

    fn received(&mut self, now: Instant) {
        *self = Self::new(now);
    }

    fn probe(&mut self, now: Instant) -> Result<(), String> {
        if self.awaiting_response {
            return Err("OpenAI 连接心跳超时，请检查网络".into());
        }
        self.awaiting_response = true;
        self.deadline = now + HEARTBEAT_TIMEOUT;
        Ok(())
    }
}

fn build_session_update(cfg: &OpenAiRealtimeConfig) -> String {
    // GA Realtime Translation schema (May 2026):
    // - WebSocket URL is /v1/realtime/translations?model=gpt-realtime-translate
    // - No voice / turn_detection at session level
    // - Input transcription uses gpt-realtime-whisper
    // - Output language goes under audio.output.language
    // The translation endpoint does NOT support text-only modality config —
    // both `session.modalities` and `session.output_modalities` are rejected.
    // For "mute", we drop output_audio events client-side instead (see
    // run_session — audio_output flag suppresses AudioChunk forwarding).
    let session = serde_json::json!({
        "audio": {
            "input": {
                "transcription": {"model": "gpt-realtime-whisper"},
                "noise_reduction": {"type": "near_field"}
            },
            "output": {"language": cfg.target_language}
        }
    });
    serde_json::json!({
        "type": "session.update",
        "session": session,
    })
    .to_string()
}

fn handle_server_event(
    text: &str,
    event_ch: &Channel<OpenAiEvent>,
    audio_output: bool,
) -> Option<&'static str> {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return None,
    };

    let evt_type = match value.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return None,
    };

    // Dev trace: log every event type (not the full payload — that's noisy)
    // so we can see the lifecycle around speech pauses and turn boundaries.
    eprintln!("[openai-realtime] event: {}", evt_type);

    match evt_type {
        "session.created" | "session.updated" => {
            // ack only
        }
        "session.input_transcript.delta" => {
            if let Some(delta) = value.get("delta").and_then(|v| v.as_str()) {
                let _ = event_ch.send(OpenAiEvent::SourceTranscript {
                    text: delta.into(),
                    is_final: false,
                });
            }
        }
        "session.input_transcript.done" | "session.input_audio_transcription.completed" => {
            // Whisper-side final for the input chunk. The `transcript` field
            // carries the full source text — use it as the authoritative source
            // (deltas can arrive at a different cadence than output translation
            // deltas, so accumulating deltas alone misaligns source/target pairs).
            let final_text = value
                .get("transcript")
                .and_then(|v| v.as_str())
                .or_else(|| value.get("text").and_then(|v| v.as_str()));
            if let Some(t) = final_text {
                let _ = event_ch.send(OpenAiEvent::SourceTranscript {
                    text: t.into(),
                    is_final: true,
                });
            }
        }
        "session.output_transcript.delta" => {
            if let Some(delta) = value.get("delta").and_then(|v| v.as_str()) {
                let _ = event_ch.send(OpenAiEvent::Transcript {
                    text: delta.into(),
                    is_final: false,
                });
            }
        }
        "session.output_transcript.done" => {
            if let Some(t) = value.get("transcript").and_then(|v| v.as_str()) {
                let _ = event_ch.send(OpenAiEvent::Transcript {
                    text: t.into(),
                    is_final: true,
                });
            }
        }
        "session.output_audio.delta" => {
            // Always forward; JS client gates playback via setMuted() so the
            // user can toggle mute live without restarting the session.
            let _ = audio_output; // unused — kept on signature for future server-side hint.
            if let Some(b64) = value.get("delta").and_then(|v| v.as_str()) {
                let _ = event_ch.send(OpenAiEvent::AudioChunk {
                    pcm_base64: b64.into(),
                });
            }
        }
        "session.closed" => {
            return Some("session.closed");
        }
        "error" => {
            let code = value
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let msg = value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let _ = event_ch.send(OpenAiEvent::Error { code, message: msg });
        }
        other => {
            // Log unknown event types so we can discover server-side names we
            // haven't mapped yet (e.g. turn lifecycle around speech pauses).
            eprintln!(
                "[openai-realtime] unhandled event type: {} | payload: {}",
                other, text
            );
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::InvokeResponseBody;

    fn config() -> OpenAiRealtimeConfig {
        OpenAiRealtimeConfig {
            api_key: "test-key".into(),
            source_language: "auto".into(),
            target_language: "zh".into(),
            voice: None,
            audio_output: false,
        }
    }

    fn capture_events() -> (Channel<OpenAiEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, events)
    }

    #[test]
    fn protocol_close_emits_exactly_one_terminal_event_from_session_owner() {
        let (channel, events) = capture_events();
        let reason = handle_server_event(r#"{"type":"session.closed"}"#, &channel, false);
        assert!(events.lock().unwrap().is_empty());
        emit_session_end(Ok(reason.unwrap().into()), "test-key", &channel);
        assert_eq!(
            *events.lock().unwrap(),
            vec![serde_json::json!({
                "type": "closed", "reason": "session.closed"
            })]
        );
    }

    #[test]
    fn session_failure_reports_error_once_then_one_close_and_redacts_key() {
        let (channel, events) = capture_events();
        emit_session_end(
            Err("connection failed test-key".into()),
            "test-key",
            &channel,
        );
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "error");
        assert_eq!(events[0]["message"], "connection failed [redacted]");
        assert_eq!(
            events[1],
            serde_json::json!({"type": "closed", "reason": "error"})
        );
    }

    #[test]
    fn quiet_connection_survives_heartbeats_but_missing_transport_reply_fails() {
        let mut now = Instant::now();
        let mut heartbeat = Heartbeat::new(now);
        // No audio or transcript activity for minutes, only transport replies.
        for _ in 0..20 {
            now = heartbeat.deadline;
            assert!(heartbeat.probe(now).is_ok());
            assert_eq!(heartbeat.deadline, now + HEARTBEAT_TIMEOUT);
            now += Duration::from_secs(1);
            heartbeat.received(now);
            assert!(!heartbeat.awaiting_response);
        }
        assert!(heartbeat.probe(heartbeat.deadline).is_ok());
        assert!(heartbeat
            .probe(heartbeat.deadline)
            .unwrap_err()
            .contains("心跳超时"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stopped_connect_never_opens_a_network_session() {
        let (_audio_tx, audio_rx) = mpsc::unbounded_channel();
        let (stop_tx, stop_rx) = mpsc::unbounded_channel();
        stop_tx.send(()).unwrap();
        let (channel, events) = capture_events();
        let result = timeout(
            Duration::from_millis(100),
            run_session(config(), OPENAI_REALTIME_URL, audio_rx, stop_rx, channel),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, "stopped");
        assert!(events.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn remote_websocket_close_notifies_the_frontend_once() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            assert!(matches!(socket.next().await, Some(Ok(Message::Text(_)))));
            socket.send(Message::Close(None)).await.unwrap();
        });
        let (_audio_tx, audio_rx) = mpsc::unbounded_channel();
        let (_stop_tx, stop_rx) = mpsc::unbounded_channel();
        let (channel, events) = capture_events();
        let result = timeout(
            Duration::from_secs(2),
            run_session(config(), &url, audio_rx, stop_rx, channel.clone()),
        )
        .await
        .unwrap();
        emit_session_end(result, "test-key", &channel);
        server.await.unwrap();
        let events = events.lock().unwrap();
        let closed: Vec<_> = events
            .iter()
            .filter(|event| event["type"] == "closed")
            .collect();
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0]["reason"], "remote_close");
    }
}
