//! Qwen 3.8 LiveTranslate: independent streaming translation sessions.
//!
//! Input is PCM16 / 16 kHz / mono. Audio output is PCM16 / 24 kHz / mono.
//! https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{ipc::Channel, State};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{timeout, Instant};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

const MODEL: &str = "qwen3.8-livetranslate-flash-realtime";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const READY_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
const AUDIO_QUEUE_SIZE: usize = 16;
const MAX_AUDIO_CHUNK_BYTES: usize = 32_000;
const MAX_CLOSE_REASON_CHARS: usize = 160;

#[derive(Deserialize)]
pub struct QwenRealtimeConfig {
    pub api_key: String,
    pub workspace_id: String,
    pub region: String,
    pub target_language: String,
    #[serde(default)]
    pub audio_output: bool,
    #[serde(default)]
    pub phrases: HashMap<String, String>,
    #[serde(default = "default_turn_detection")]
    pub turn_detection: String,
    #[serde(default)]
    pub finish_timeout_ms: Option<u64>,
}

fn default_turn_detection() -> String {
    "speaker_detection".into()
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QwenEvent {
    Status {
        state: String,
        message: Option<String>,
    },
    /// Preserve provider item IDs; the frontend assembles source/target pairs by ID.
    Protocol {
        event: Value,
    },
    Audio {
        audio: String,
        item_id: Option<String>,
        response_id: Option<String>,
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
    audio_tx: mpsc::Sender<Vec<u8>>,
    stop_tx: mpsc::Sender<()>,
    done_rx: oneshot::Receiver<()>,
}

#[derive(Default)]
pub struct QwenState {
    sessions: Arc<Mutex<HashMap<u64, Session>>>,
    next_id: AtomicU64,
}

fn validate_config(cfg: &QwenRealtimeConfig) -> Result<String, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("请填写 Qwen API Key".into());
    }
    if !matches!(
        cfg.turn_detection.as_str(),
        "speaker_detection" | "server_vad"
    ) {
        return Err("Qwen 语音检测方式无效".into());
    }
    if cfg
        .finish_timeout_ms
        .is_some_and(|value| !(1000..=30_000).contains(&value))
    {
        return Err("Qwen 收尾等待时间须在 1 至 30 秒之间".into());
    }
    let workspace = cfg.workspace_id.trim();
    // A workspace is one DNS label, never a user-supplied URL or credential host.
    if workspace.is_empty()
        || workspace.len() > 63
        || !workspace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || workspace.starts_with('-')
        || workspace.ends_with('-')
    {
        return Err("请填写有效的百炼业务空间 ID（字母、数字或连字符）".into());
    }
    if !matches!(cfg.region.as_str(), "cn-beijing" | "ap-southeast-1") {
        return Err("Qwen 地域须为北京或新加坡".into());
    }
    if cfg.target_language.is_empty()
        || cfg.target_language.len() > 16
        || !cfg
            .target_language
            .bytes()
            .all(|b| b.is_ascii_alphabetic() || b == b'-')
    {
        return Err("Qwen 目标语言无效".into());
    }
    if cfg.phrases.len() > 1000 {
        return Err("每个翻译方向的术语不能超过 1000 条".into());
    }
    if cfg
        .phrases
        .iter()
        .any(|(source, target)| source.trim().is_empty() || target.trim().is_empty())
    {
        return Err("术语的原词和译法均不能为空".into());
    }
    if serde_json::to_vec(&cfg.phrases)
        .map_err(|e| e.to_string())?
        .len()
        > 256_000
    {
        return Err("术语表过大，请缩减后重试".into());
    }
    Ok(format!(
        "wss://{}.{}.maas.aliyuncs.com/api-ws/v1/realtime?model={}",
        workspace, cfg.region, MODEL
    ))
}

fn build_session_update(cfg: &QwenRealtimeConfig) -> Value {
    let mut translation = json!({ "language": cfg.target_language });
    if !cfg.phrases.is_empty() {
        translation["corpus"] = json!({ "phrases": cfg.phrases });
    }
    let turn_detection = if cfg.turn_detection == "speaker_detection" {
        json!({ "type": "speaker_detection", "threshold": 0.5 })
    } else {
        json!({ "type": "server_vad" })
    };
    json!({
        "type": "session.update",
        "session": {
            "output_modalities": if cfg.audio_output { vec!["text", "audio"] } else { vec!["text"] },
            "translation": translation,
            "audio": { "input": { "turn_detection": turn_detection } }
        }
    })
}

#[tauri::command]
pub async fn qwen_realtime_start(
    config: QwenRealtimeConfig,
    on_event: Channel<QwenEvent>,
    state: State<'_, QwenState>,
) -> Result<u64, String> {
    let url = validate_config(&config)?;
    let session_id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (audio_tx, audio_rx) = mpsc::channel(AUDIO_QUEUE_SIZE);
    let (stop_tx, stop_rx) = mpsc::channel(1);
    let (done_tx, done_rx) = oneshot::channel();
    state
        .sessions
        .lock()
        .map_err(|_| "Qwen session lock poisoned")?
        .insert(
            session_id,
            Session {
                audio_tx,
                stop_tx,
                done_rx,
            },
        );
    let sessions = state.sessions.clone();

    tokio::spawn(async move {
        let _ = on_event.send(QwenEvent::Status {
            state: "connecting".into(),
            message: None,
        });
        let key = config.api_key.trim().to_owned();
        let result = run_session(config, url, audio_rx, stop_rx, &on_event).await;
        let reason = match result {
            Ok(reason) => reason,
            Err(message) => {
                // Do not expose a credential in transport errors, even if a dependency changes its formatting.
                let message = message.replace(key.as_str(), "[redacted]");
                let _ = on_event.send(QwenEvent::Error {
                    code: "session_failed".into(),
                    message,
                });
                "error".into()
            }
        };
        if let Ok(mut map) = sessions.lock() {
            map.remove(&session_id);
        }
        let _ = on_event.send(QwenEvent::Closed { reason });
        let _ = done_tx.send(());
    });
    Ok(session_id)
}

#[tauri::command]
pub async fn qwen_realtime_send_audio(
    session_id: u64,
    pcm: Vec<u8>,
    state: State<'_, QwenState>,
) -> Result<(), String> {
    if pcm.is_empty() {
        return Ok(());
    }
    if pcm.len() % 2 != 0 || pcm.len() > MAX_AUDIO_CHUNK_BYTES {
        return Err("Qwen 音频必须为 PCM16，且每次不超过 1 秒".into());
    }
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Qwen session lock poisoned")?;
    let session = sessions.get(&session_id).ok_or("Qwen 会话已结束")?;
    session.audio_tx.try_send(pcm).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => "Qwen 音频发送积压，请检查网络后重新开始".into(),
        mpsc::error::TrySendError::Closed(_) => "Qwen 会话已结束".into(),
    })
}

#[tauri::command]
pub async fn qwen_realtime_stop(
    session_id: u64,
    state: State<'_, QwenState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "Qwen session lock poisoned")?
        .remove(&session_id);
    if let Some(session) = session {
        let _ = session.stop_tx.try_send(());
        // run_session is cancellable while connecting and has a bounded final-output drain.
        let _ = timeout(
            MAX_DRAIN_TIMEOUT + WRITE_TIMEOUT * 2 + CLOSE_TIMEOUT + Duration::from_secs(1),
            session.done_rx,
        )
        .await;
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum ServerEvent {
    Created,
    Updated,
    Finished,
    Data(Value),
    Audio {
        audio: String,
        item_id: Option<String>,
        response_id: Option<String>,
    },
    Error(String),
    Ignore,
}

fn parse_server_event(text: &str) -> Result<ServerEvent, String> {
    let value: Value = serde_json::from_str(text).map_err(|_| "Qwen 返回了无效 JSON")?;
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let error = |v: &Value| {
        let code = v.get("code").and_then(Value::as_str).unwrap_or("unknown");
        let message = v
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Qwen 请求失败");
        format!("{}: {}", code, message)
    };
    Ok(match kind {
        "error" => ServerEvent::Error(error(value.get("error").unwrap_or(&value))),
        "session.created" => ServerEvent::Created,
        "session.updated" => ServerEvent::Updated,
        "session.finished" => ServerEvent::Finished,
        "response.done"
            if value
                .pointer("/response/status")
                .and_then(Value::as_str)
                .is_some_and(|status| status != "completed") =>
        {
            ServerEvent::Error(format!(
                "Qwen 翻译响应未完成：{}",
                value.pointer("/response/status").unwrap_or(&Value::Null)
            ))
        }
        "response.audio.delta" => {
            let audio = value
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            ServerEvent::Audio {
                audio,
                item_id: value
                    .get("item_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                response_id: value
                    .get("response_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            }
        }
        "conversation.item.input_audio_transcription.failed" => {
            ServerEvent::Error(error(value.get("error").unwrap_or(&value)))
        }
        "conversation.item.created"
        | "input_audio_buffer.speech_started"
        | "input_audio_buffer.speech_stopped"
        | "conversation.item.input_audio_transcription.delta"
        | "conversation.item.input_audio_transcription.completed"
        | "response.text.delta"
        | "response.audio_transcript.delta"
        | "response.text.done"
        | "response.audio_transcript.done"
        | "response.output_item.done"
        | "response.done" => ServerEvent::Data(value),
        _ if value.get("code").is_some() => ServerEvent::Error(error(&value)),
        _ => ServerEvent::Ignore,
    })
}

fn close_error(frame: Option<(u16, &str)>, finishing: bool, api_key: &str) -> String {
    let message = if finishing {
        "Qwen 在最终翻译确认前关闭了连接"
    } else {
        "Qwen 连接已断开"
    };
    let Some((code, reason)) = frame else {
        return message.into();
    };
    // Redact before truncating: truncation could otherwise expose a key prefix
    // that the outer full-key scrubber no longer recognizes.
    let key = api_key.trim();
    let reason = if key.is_empty() {
        reason.to_owned()
    } else {
        reason.replace(key, "[redacted]")
    };
    let normalized: String = reason
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.to_ascii_lowercase();
    let reason = if lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("ratequota")
        || lower.contains("throttling")
        || lower.contains("too many requests")
        || lower.contains("request rate increased too quickly")
    {
        // Qwen may signal request throttling as WebSocket 1007. Preserve a
        // stable classification without treating every 1007 as a rate limit.
        "Throttling: 请求限流，请稍后重试".into()
    } else {
        let mut bounded: String = normalized.chars().take(MAX_CLOSE_REASON_CHARS).collect();
        if normalized.chars().count() > MAX_CLOSE_REASON_CHARS {
            bounded.push('…');
        }
        bounded
    };
    if reason.is_empty() {
        format!("{message}（WebSocket {code}）")
    } else {
        format!("{message}（WebSocket {code}）：{reason}")
    }
}

async fn run_session(
    cfg: QwenRealtimeConfig,
    url: String,
    mut audio_rx: mpsc::Receiver<Vec<u8>>,
    mut stop_rx: mpsc::Receiver<()>,
    event_ch: &Channel<QwenEvent>,
) -> Result<String, String> {
    let drain_timeout = cfg
        .finish_timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DRAIN_TIMEOUT);
    let mut request = url.into_client_request().map_err(|_| "Qwen 连接地址无效")?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", cfg.api_key.trim())
            .parse()
            .map_err(|_| "Qwen API Key 格式无效")?,
    );
    let (mut socket, _) = tokio::select! {
        biased;
        _ = stop_rx.recv() => return Ok("stopped".into()),
        result = timeout(CONNECT_TIMEOUT, connect_async(request)) => {
            result.map_err(|_| "Qwen 连接超时，请检查地域与网络")?
                .map_err(|e| format!("Qwen 连接失败：{}", e))?
        }
    };
    let ready_deadline = Instant::now() + READY_TIMEOUT;
    let mut created = false;
    let mut ready = false;
    let mut finishing = false;
    let mut finish_deadline = Instant::now() + Duration::from_secs(365 * 24 * 60 * 60);

    loop {
        tokio::select! {
            biased;
            _ = stop_rx.recv(), if !finishing => {
                if !ready {
                    let _ = timeout(CLOSE_TIMEOUT, socket.close(None)).await;
                    return Ok("stopped".into());
                }
                // Stop admission, send accepted audio in order, then request final transcription/translation.
                audio_rx.close();
                timeout(WRITE_TIMEOUT, async {
                    while let Ok(pcm) = audio_rx.try_recv() {
                        let event = json!({ "type": "input_audio_buffer.append", "audio": B64.encode(pcm) });
                        socket.send(Message::Text(event.to_string().into())).await?;
                    }
                    socket.send(Message::Text(json!({"type":"session.finish"}).to_string().into())).await
                }).await.map_err(|_| "Qwen 结束请求超时")?
                    .map_err(|e| format!("Qwen 结束请求失败：{}", e))?;
                finishing = true;
                finish_deadline = Instant::now() + drain_timeout;
            }
            _ = tokio::time::sleep_until(ready_deadline), if !ready => return Err("Qwen 配置确认超时，请检查 API Key、业务空间与地域".into()),
            _ = tokio::time::sleep_until(finish_deadline), if finishing => {
                let _ = timeout(CLOSE_TIMEOUT, socket.close(None)).await;
                return Err("Qwen 结束等待超时，最后一段翻译可能未完成".into());
            }
            message = socket.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => match parse_server_event(&text)? {
                        ServerEvent::Created if !created => {
                            created = true;
                            timeout(WRITE_TIMEOUT, socket.send(Message::Text(build_session_update(&cfg).to_string().into()))).await
                                .map_err(|_| "Qwen 配置发送超时")?.map_err(|e| format!("Qwen 配置发送失败：{}", e))?;
                        }
                        ServerEvent::Updated if created && !ready => {
                            ready = true;
                            event_ch.send(QwenEvent::Status { state: "ready".into(), message: None }).map_err(|_| "Qwen 界面已关闭")?;
                        }
                        ServerEvent::Finished => {
                            let _ = timeout(CLOSE_TIMEOUT, socket.close(None)).await;
                            // Only this provider event confirms complete file translation.
                            return Ok("finished".into());
                        }
                        ServerEvent::Data(event) => { event_ch.send(QwenEvent::Protocol { event }).map_err(|_| "Qwen 界面已关闭")?; }
                        ServerEvent::Audio { audio, item_id, response_id } if cfg.audio_output && !audio.is_empty() => {
                            event_ch.send(QwenEvent::Audio { audio, item_id, response_id }).map_err(|_| "Qwen 界面已关闭")?;
                        }
                        ServerEvent::Error(error) => return Err(error),
                        _ => {}
                    },
                    Some(Ok(Message::Ping(data))) => {
                        timeout(WRITE_TIMEOUT, socket.send(Message::Pong(data))).await.map_err(|_| "Qwen 心跳发送超时")?
                            .map_err(|e| format!("Qwen 心跳失败：{}", e))?;
                    }
                    Some(Ok(Message::Close(frame))) => return Err(close_error(
                        frame.as_ref().map(|frame| (u16::from(frame.code), frame.reason.as_str())),
                        finishing,
                        &cfg.api_key,
                    )),
                    None => return Err(close_error(None, finishing, &cfg.api_key)),
                    Some(Err(error)) => return Err(format!("Qwen 连接错误：{}", error)),
                    Some(Ok(_)) => {}
                }
            }
            Some(pcm) = audio_rx.recv(), if ready && !finishing => {
                let event = json!({ "type": "input_audio_buffer.append", "audio": B64.encode(pcm) });
                timeout(WRITE_TIMEOUT, socket.send(Message::Text(event.to_string().into()))).await
                    .map_err(|_| "Qwen 音频发送超时")?.map_err(|e| format!("Qwen 音频发送失败：{}", e))?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> QwenRealtimeConfig {
        QwenRealtimeConfig {
            api_key: "test-key".into(),
            workspace_id: "workspace-123".into(),
            region: "cn-beijing".into(),
            target_language: "en".into(),
            audio_output: false,
            phrases: HashMap::new(),
            turn_detection: default_turn_detection(),
            finish_timeout_ms: None,
        }
    }

    #[test]
    fn config_uses_workspace_region_new_model_and_direction_specific_glossary() {
        let mut cfg = config();
        cfg.phrases
            .insert("灰度发布".into(), "canary release".into());
        assert_eq!(validate_config(&cfg).unwrap(), "wss://workspace-123.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime");
        let update = build_session_update(&cfg);
        assert_eq!(update["session"]["output_modalities"], json!(["text"]));
        assert_eq!(
            update["session"]["translation"]["corpus"]["phrases"]["灰度发布"],
            "canary release"
        );
        assert!(update["session"].get("modalities").is_none());
        assert!(update["session"].get("input_audio_transcription").is_none());
        cfg.audio_output = true;
        assert_eq!(
            build_session_update(&cfg)["session"]["output_modalities"],
            json!(["text", "audio"])
        );
    }

    #[test]
    fn config_rejects_credential_exfiltration_hosts_and_invalid_terms() {
        let mut cfg = config();
        cfg.workspace_id = "x.example.com/path".into();
        assert!(validate_config(&cfg).is_err());
        cfg = config();
        cfg.region = "evil.example".into();
        assert!(validate_config(&cfg).is_err());
        cfg = config();
        cfg.phrases.insert("name".into(), "  ".into());
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn file_turn_detection_and_finish_timeout_are_optional_and_bounded() {
        let mut cfg: QwenRealtimeConfig = serde_json::from_value(json!({
            "api_key": "test-key", "workspace_id": "workspace-123",
            "region": "cn-beijing", "target_language": "en"
        }))
        .unwrap();
        assert_eq!(cfg.turn_detection, "speaker_detection");
        assert_eq!(cfg.finish_timeout_ms, None);
        cfg.turn_detection = "server_vad".into();
        cfg.finish_timeout_ms = Some(30_000);
        assert!(validate_config(&cfg).is_ok());
        assert_eq!(
            build_session_update(&cfg)["session"]["audio"]["input"]["turn_detection"],
            json!({"type": "server_vad"})
        );
        cfg.finish_timeout_ms = Some(30_001);
        assert!(validate_config(&cfg).is_err());
        cfg.finish_timeout_ms = Some(0);
        assert!(validate_config(&cfg).is_err());
        cfg.finish_timeout_ms = None;
        cfg.turn_detection = "manual".into();
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn parser_preserves_source_audio_timeline_events() {
        for event in [
            json!({"type": "input_audio_buffer.speech_started", "item_id": "source", "audio_start_ms": 0}),
            json!({"type": "input_audio_buffer.speech_stopped", "item_id": "source", "audio_end_ms": 1200}),
        ] {
            assert_eq!(
                parse_server_event(&event.to_string()).unwrap(),
                ServerEvent::Data(event)
            );
        }
    }

    #[test]
    fn parser_preserves_ids_and_separates_audio_from_text() {
        let event = json!({"type":"response.text.delta", "item_id":"target-2", "response_id":"response-2", "delta":"Hello"});
        assert_eq!(
            parse_server_event(&event.to_string()).unwrap(),
            ServerEvent::Data(event)
        );
        assert_eq!(
            parse_server_event(
                r#"{"type":"response.audio.delta","item_id":"target-2","delta":"AAE="}"#
            )
            .unwrap(),
            ServerEvent::Audio {
                audio: "AAE=".into(),
                item_id: Some("target-2".into()),
                response_id: None
            }
        );
        assert_eq!(
            parse_server_event(r#"{"type":"session.updated"}"#).unwrap(),
            ServerEvent::Updated
        );
        assert_eq!(
            parse_server_event(r#"{"type":"session.finished"}"#).unwrap(),
            ServerEvent::Finished
        );
    }

    #[test]
    fn parser_does_not_silently_accept_failed_response_or_top_level_error() {
        assert!(matches!(
            parse_server_event(r#"{"type":"response.done","response":{"status":"failed"}}"#),
            Ok(ServerEvent::Error(_))
        ));
        assert!(matches!(
            parse_server_event(r#"{"code":"InvalidApiKey","message":"bad key"}"#),
            Ok(ServerEvent::Error(_))
        ));
        assert!(parse_server_event("not json").is_err());
    }

    #[test]
    fn close_errors_preserve_rate_limits_without_confusing_invalid_payloads() {
        let rate_limit = close_error(
            Some((
                1007,
                "Requests rate limit exceeded, please try again later.",
            )),
            false,
            "test-key",
        );
        assert!(rate_limit.contains("WebSocket 1007"));
        assert!(rate_limit.contains("Throttling"));
        let payload = close_error(
            Some((1007, "InvalidParameter: invalid PCM payload")),
            false,
            "test-key",
        );
        assert!(payload.contains("InvalidParameter"));
        assert!(!payload.contains("Throttling"));
        let auth = close_error(Some((1008, "InvalidApiKey")), false, "test-key");
        assert!(auth.contains("WebSocket 1008"));
        assert!(auth.contains("InvalidApiKey"));
    }

    #[test]
    fn close_errors_scrub_credentials_before_bounding_unicode_reasons() {
        let key = "sk-example-secret-key";
        let reason = format!("{}{}\n\0{}", "错".repeat(158), key, "误".repeat(200));
        let result = close_error(Some((1011, &reason)), false, key);
        assert!(!result.contains(key));
        assert!(!result.contains("sk-"));
        assert!(!result.chars().any(char::is_control));
        assert!(result.ends_with('…'));
        assert!(result.chars().count() < MAX_CLOSE_REASON_CHARS + 40);
    }

    #[test]
    fn normal_close_without_session_finished_is_still_an_incomplete_result() {
        let result = close_error(Some((1000, "normal closure")), true, "test-key");
        assert!(result.contains("最终翻译确认前"));
        assert!(result.contains("WebSocket 1000"));
        assert!(result.contains("normal closure"));
        assert_eq!(close_error(None, false, "test-key"), "Qwen 连接已断开");
        assert_eq!(
            close_error(Some((1000, "")), false, ""),
            "Qwen 连接已断开（WebSocket 1000）"
        );
    }
}
