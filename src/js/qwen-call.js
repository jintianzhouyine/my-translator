// Owns the two independent Qwen directions and their native audio resources.
// Dependency injection keeps lifecycle and routing testable without microphones or API keys.
import { validateQwenSettings } from './qwen-settings.js';

let nextRunId = 0;

export function validateQwenCall(settings) {
    if (!settings.qwen_api_key?.trim()) throw new Error('请填写 Qwen（百炼）API 密钥。');
    validateQwenSettings(settings);
}

export class QwenCallController {
    constructor({ invoke, Channel, createClient, onSegment = () => {}, onProvisional = () => {},
        onStateChange = () => {}, onError = () => {}, captureDrainTimeoutMs = 1000 }) {
        Object.assign(this, { invoke, Channel, createClient, onSegment, onProvisional, onStateChange, onError });
        this.captureDrainTimeoutMs = captureDrainTimeoutMs;
        this.run = null;
        this.state = 'idle';
        this._startPromise = null;
        this._stopPromise = null;
    }

    async start(settings) {
        if (this.run || this._stopPromise) throw new Error('上一通翻译仍在结束，请稍后再开始。');
        validateQwenCall(settings);
        const run = {
            id: ++nextRunId, clients: {}, outputId: null, closing: false, failed: false,
            outputTail: Promise.resolve(), queuedAudioBytes: 0, settings: { ...settings },
        };
        this.run = run;
        this.state = 'connecting';
        this.onStateChange('connecting');
        const starting = this._start(run);
        this._startPromise = starting;
        try {
            await starting;
        } finally {
            if (this._startPromise === starting) this._startPromise = null;
        }
    }

    _checkActive(run) {
        if (this.run !== run || run.closing) throw new Error('翻译启动已取消。');
        if (run.failure) throw new Error(run.failure);
    }

    async _start(run) {
        const settings = run.settings;
        const duplex = settings.qwen_duplex_enabled !== false;
        try {
            if (duplex) {
                const onError = new this.Channel();
                onError.onmessage = (message) => this._fail(run, 'outbound', `译音输出失败：${message}`);
                run.outputId = await this.invoke('start_translation_output', {
                    deviceId: settings.qwen_output_device, onError,
                });
                this._checkActive(run);
            }

            const common = {
                apiKey: settings.qwen_api_key,
                workspaceId: settings.qwen_workspace_id,
                region: settings.qwen_region,
            };
            const incoming = this._client(run, 'inbound');
            const connecting = [incoming.connect({ ...common, targetLanguage: settings.qwen_my_language,
                audioOutput: false, phrases: settings.qwen_glossary_inbound || {} })];
            if (duplex) {
                const outgoing = this._client(run, 'outbound');
                connecting.push(outgoing.connect({ ...common, targetLanguage: settings.qwen_peer_language,
                    audioOutput: true, phrases: settings.qwen_glossary_outbound || {} }));
            }
            await Promise.all(connecting);
            this._checkActive(run);

            const onAudio = new this.Channel();
            run.captureStopped = false;
            run.captureStoppedPromise = new Promise(resolve => { run.resolveCaptureStopped = resolve; });
            onAudio.onmessage = (event) => {
                if (this.run !== run) return;
                if (event.type === 'stopped') {
                    run.captureStopped = true;
                    run.resolveCaptureStopped();
                    if (!run.closing) this._fail(run, 'inbound', '音频采集已停止，请重新开始。');
                    return;
                }
                // Stop cuts playback immediately, but captured tail PCM must precede session.finish.
                if (run.captureStopped || run.failed) return;
                const direction = event.source === 'microphone' ? 'outbound' : 'inbound';
                if (event.type === 'error') {
                    this._fail(run, direction, `音频采集失败：${event.message}`);
                } else if (event.type === 'audio' && ['microphone', 'system'].includes(event.source)) {
                    const client = run.clients[direction];
                    if (client) {
                        Promise.resolve(client.sendAudio(new Uint8Array(event.pcm).buffer))
                            .catch((error) => this._fail(run, direction, String(error)));
                    }
                }
            };
            try {
                await this.invoke('start_duplex_capture', {
                    microphoneDevice: settings.qwen_microphone_device || '',
                    systemDevice: settings.qwen_system_device || '',
                    captureMicrophone: duplex, onAudio,
                });
            } catch (error) {
                run.captureStopped = true;
                run.resolveCaptureStopped();
                throw error;
            }
            this._checkActive(run);
            this.state = 'running';
            this.onStateChange('connected');
        } catch (error) {
            run.closing = true;
            await this._cleanup(run);
            if (this.run === run && !this._stopPromise) {
                this.run = null;
                this.state = 'idle';
                this.onStateChange('disconnected');
            }
            throw error;
        }
    }

    _client(run, direction) {
        const client = this.createClient();
        run.clients[direction] = client;
        // Keep final text while draining session.finish, but never play further audio after Stop.
        client.onSegment = (source, target, meta = {}) => {
            if (this.run === run) this.onSegment(direction, source, target, this._meta(run, direction, meta));
        };
        client.onProvisional = (text, meta = {}) => {
            if (this.run === run && !run.closing) this.onProvisional(direction, text, this._meta(run, direction, meta));
        };
        client.onAudioChunk = (base64) => {
            if (direction === 'outbound' && this.run === run && !run.closing) this._enqueueAudio(run, base64);
        };
        client.onError = (code, message) => this._fail(run, direction, `${message || code}`);
        client.onClosed = (reason) => {
            if (!run.closing) this._fail(run, direction, `翻译连接已断开：${reason || '请重新开始'}`);
        };
        return client;
    }

    _meta(run, direction, meta) {
        // IDs from different connections (or successive calls) can collide.
        const settings = run.settings;
        return { ...meta, id: `${run.id}:${direction}:${meta.itemId}`, direction,
            sourceLanguage: direction === 'outbound' ? settings.qwen_my_language : settings.qwen_peer_language,
            targetLanguage: direction === 'outbound' ? settings.qwen_peer_language : settings.qwen_my_language };
    }

    _enqueueAudio(run, base64) {
        try {
            const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
            if (bytes.length % 2) throw new Error('收到不完整的语音数据。');
            run.queuedAudioBytes += bytes.length;
            // Bound the IPC backlog independently of the native playback buffer (24 kHz PCM16).
            if (run.queuedAudioBytes > 24000 * 2 * 5) throw new Error('译音发送积压，请检查输出设备后重新开始。');
            run.outputTail = run.outputTail.then(async () => {
                try {
                    if (this.run === run && !run.closing && run.outputId != null) {
                        await this.invoke('write_translation_audio', { outputId: run.outputId, pcm: Array.from(bytes) });
                    }
                } finally {
                    run.queuedAudioBytes -= bytes.length;
                }
            }).catch((error) => this._fail(run, 'outbound', `译音输出失败：${error}`));
        } catch (error) {
            this._fail(run, 'outbound', String(error));
        }
    }

    _fail(run, direction, message) {
        if (this.run !== run || run.closing || run.failed) return;
        run.failed = true;
        run.failure = message;
        // Startup errors are returned by start(); reporting here would show two notifications.
        const wasRunning = this.state === 'running';
        if (wasRunning) {
            void this.stop();
            this.onError(direction, message);
        }
    }

    async _cleanup(run) {
        // Also called after late startup results, so cancellation cannot strand a native resource.
        // Clear the native playback queue immediately; capture may still deliver its final PCM.
        const outputId = run.outputId;
        run.outputId = null;
        const outputStopped = outputId != null
            ? this.invoke('stop_translation_output', { outputId }).catch(() => {})
            : Promise.resolve();
        await this.invoke('stop_duplex_capture').catch(() => {});
        if (run.captureStoppedPromise && !run.captureStopped && !run.failed) {
            // A command response can arrive before queued Channel events. The ordered end marker
            // confirms the native tail packets reached sendAudio before disconnect drains its queue.
            let timer;
            try {
                await Promise.race([run.captureStoppedPromise,
                    new Promise(resolve => { timer = setTimeout(resolve, this.captureDrainTimeoutMs); })]);
            } finally { clearTimeout(timer); }
        }
        run.captureStopped = true;
        const stopping = Object.values(run.clients).map((client) => client.disconnect());
        stopping.push(outputStopped);
        await Promise.allSettled(stopping);
        await run.outputTail;
    }

    stop() {
        if (this._stopPromise) return this._stopPromise;
        const run = this.run;
        if (!run) return Promise.resolve();
        run.closing = true;
        this.state = 'stopping';
        const starting = this._startPromise;
        const stopping = (async () => {
            await this._cleanup(run);
            if (starting) await starting.catch(() => {});
            await this._cleanup(run);
            if (this.run === run) this.run = null;
            this.state = 'idle';
            this.onStateChange('disconnected');
        })();
        this._stopPromise = stopping;
        return stopping.finally(() => {
            if (this._stopPromise === stopping) this._stopPromise = null;
        });
    }
}
