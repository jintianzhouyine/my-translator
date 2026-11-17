// Owns the two independent Qwen directions and their native audio resources.
// Dependency injection keeps lifecycle and routing testable without microphones or API keys.
import { validateQwenSettings } from './qwen-settings.js';
import { readQwenMix, mixSettings } from './qwen-audio-controls.js';
import { isRecoverableRealtimeError } from './realtime-recovery.js';

let nextRunId = 0;
// Cloud speech may arrive faster than playback, especially for a long sentence.
// This is a burst buffer, not a limit on the duration of a translated sentence.
const MAX_OUTPUT_QUEUE_BYTES = 24000 * 2 * 30;

export function validateQwenCall(settings) {
    if (!settings.qwen_api_key?.trim()) throw new Error('请填写 Qwen（百炼）API 密钥。');
    validateQwenSettings(settings);
}

export class QwenCallController {
    constructor({ invoke, Channel, createClient, onSegment = () => {}, onProvisional = () => {},
        onStateChange = () => {}, onError = () => {}, onWarning = () => {}, captureDrainTimeoutMs = 1000,
        reconnectDelayMs = 1000, maxReconnectAttempts = 3 }) {
        Object.assign(this, { invoke, Channel, createClient, onSegment, onProvisional, onStateChange, onError, onWarning });
        this.captureDrainTimeoutMs = captureDrainTimeoutMs;
        this.reconnectDelayMs = reconnectDelayMs;
        this.maxReconnectAttempts = maxReconnectAttempts;
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
            mix: readQwenMix(settings), mixTail: Promise.resolve(), audioGeneration: 0, routeId: null,
            recoveries: {}, clientConfigs: {}, connectionIds: {}, retryCounts: {}, connectedAt: {}, started: false,
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
                if (settings.qwen_manage_system_devices !== false) {
                    const route = await this.invoke('begin_system_audio_route', {
                        microphoneDevice: settings.qwen_microphone_device || '',
                        systemDevice: settings.qwen_system_device || '',
                        outputDevice: settings.qwen_output_device,
                    });
                    run.routeId = route.routeId;
                    // Never re-resolve "default input" after it has become the virtual microphone.
                    settings.qwen_microphone_device = route.microphoneDevice;
                    settings.qwen_system_device = route.systemDevice;
                    this._checkActive(run);
                }
                const onError = new this.Channel();
                onError.onmessage = (message) => this._fail(run, 'outbound', `译音输出失败：${message}`);
                run.outputId = await this.invoke('start_translation_output', {
                    deviceId: settings.qwen_output_device, onError, mix: { ...run.mix },
                });
                this._checkActive(run);
                await this.setMix(run.mix);
                this._checkActive(run);
            }

            const common = {
                apiKey: settings.qwen_api_key,
                workspaceId: settings.qwen_workspace_id,
                region: settings.qwen_region,
            };
            const incoming = this._client(run, 'inbound');
            run.clientConfigs.inbound = { ...common, targetLanguage: settings.qwen_my_language,
                audioOutput: false, phrases: settings.qwen_glossary_inbound || {} };
            const connecting = [incoming.connect(run.clientConfigs.inbound)];
            if (duplex) {
                const outgoing = this._client(run, 'outbound');
                run.clientConfigs.outbound = { ...common, targetLanguage: settings.qwen_peer_language,
                    audioOutput: true, phrases: settings.qwen_glossary_outbound || {} };
                connecting.push(outgoing.connect(run.clientConfigs.outbound));
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
                    if (client && !run.recoveries[direction]) {
                        Promise.resolve(client.sendAudio(new Uint8Array(event.pcm).buffer))
                            .catch((error) => this._connectionFailed(run, direction, client, 'audio_send_failed', String(error)));
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
            run.started = true;
            for (const direction of Object.keys(run.clients)) run.connectedAt[direction] = Date.now();
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
        const connectionId = run.connectionIds[direction] = (run.connectionIds[direction] || 0) + 1;
        const current = () => this.run === run && run.clients[direction] === client;
        // Keep final text while draining session.finish, but never play further audio after Stop.
        client.onSegment = (source, target, meta = {}) => {
            if (current()) this.onSegment(direction, source, target, this._meta(run, direction, meta, connectionId));
        };
        client.onProvisional = (text, meta = {}) => {
            if (current() && !run.closing) this.onProvisional(direction, text, this._meta(run, direction, meta, connectionId));
        };
        client.onAudioChunk = (base64) => {
            if (direction === 'outbound' && current() && !run.closing && !run.recoveries[direction]) this._enqueueAudio(run, base64);
        };
        client.onError = (code, message) => this._connectionFailed(run, direction, client, code, message);
        client.onClosed = (reason) => {
            this._connectionFailed(run, direction, client, 'closed', `翻译连接已断开：${reason || ''}`);
        };
        return client;
    }

    _connectionFailed(run, direction, client, code, message) {
        if (this.run !== run || run.clients[direction] !== client || run.closing || run.failed) return;
        const failure = message || code || '翻译连接已断开';
        if (!run.started || !isRecoverableRealtimeError(code, failure)) {
            this._fail(run, direction, failure);
            return;
        }
        const existing = run.recoveries[direction];
        if (existing) {
            // Error + closed are often delivered together; only one retry owns this direction.
            existing.error ||= failure;
            return;
        }
        if (Date.now() - run.connectedAt[direction] >= 30000) run.retryCounts[direction] = 0;
        const recovery = { error: failure, cancelWait: null, promise: null };
        run.recoveries[direction] = recovery;
        if (direction === 'outbound') run.audioGeneration++;
        this.onStateChange('connecting');
        recovery.promise = this._reconnect(run, direction, recovery);
    }

    async _reconnect(run, direction, recovery) {
        const active = () => this.run === run && !run.closing && !run.failed;
        try {
            while (active()) {
                const previous = run.clients[direction];
                await previous.disconnect().catch(() => {});
                if (!active()) return;
                const attempt = (run.retryCounts[direction] || 0) + 1;
                run.retryCounts[direction] = attempt;
                if (attempt > this.maxReconnectAttempts) {
                    this._fail(run, direction, `自动重连失败：${recovery.error}。请检查网络后重新开始。`);
                    return;
                }
                const label = direction === 'outbound' ? '我的译音' : '对方字幕';
                this.onWarning(`${label}连接中断，正在自动重连（${attempt}/${this.maxReconnectAttempts}）…`);
                await new Promise(resolve => {
                    const timer = setTimeout(resolve, this.reconnectDelayMs * attempt);
                    recovery.cancelWait = () => { clearTimeout(timer); resolve(); };
                });
                recovery.cancelWait = null;
                if (!active()) return;
                const client = this._client(run, direction);
                recovery.error = null;
                try {
                    await client.connect(run.clientConfigs[direction]);
                    if (!active()) return;
                    if (recovery.error) throw new Error(recovery.error);
                    run.connectedAt[direction] = Date.now();
                    delete run.recoveries[direction];
                    if (Object.keys(run.recoveries).length === 0) this.onStateChange('connected');
                    return;
                } catch (error) {
                    recovery.error = String(error.message || error);
                    if (active() && !isRecoverableRealtimeError('', recovery.error)) {
                        this._fail(run, direction, recovery.error);
                        return;
                    }
                }
            }
        } catch (error) {
            if (active()) this._fail(run, direction, String(error.message || error));
        }
    }

    _meta(run, direction, meta, connectionId) {
        // IDs from different connections (or successive calls) can collide.
        const settings = run.settings;
        return { ...meta, id: `${run.id}:${direction}:${connectionId}:${meta.itemId}`, direction,
            sourceLanguage: direction === 'outbound' ? settings.qwen_my_language : settings.qwen_peer_language,
            targetLanguage: direction === 'outbound' ? settings.qwen_peer_language : settings.qwen_my_language };
    }

    _enqueueAudio(run, base64) {
        // Muting also discards chunks already waiting in the JS/native queues.
        if (!run.mix.translatedEnabled || run.mix.translatedVolume === 0) return;
        const generation = run.audioGeneration;
        try {
            const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
            if (bytes.length % 2) throw new Error('收到不完整的语音数据。');
            // Skip an excessive burst rather than ending both translation directions.
            // Invalidate queued work so old speech cannot be replayed much later.
            if (run.queuedAudioBytes + bytes.length > MAX_OUTPUT_QUEUE_BYTES) {
                run.audioGeneration++;
                this._warnOutputBacklog(run);
                return;
            }
            run.queuedAudioBytes += bytes.length;
            run.outputTail = run.outputTail.then(async () => {
                try {
                    if (this.run === run && !run.closing && run.outputId != null && generation === run.audioGeneration) {
                        const dropped = await this.invoke('write_translation_audio', { outputId: run.outputId, pcm: Array.from(bytes) });
                        if (dropped === true) this._warnOutputBacklog(run);
                    }
                } finally {
                    run.queuedAudioBytes -= bytes.length;
                }
            }).catch((error) => this._fail(run, 'outbound', `译音输出失败：${error}`));
        } catch (error) {
            this._fail(run, 'outbound', String(error));
        }
    }

    _warnOutputBacklog(run) {
        if (this.run !== run || run.closing) return;
        const now = Date.now();
        if (run.lastBacklogWarning != null && now - run.lastBacklogWarning < 30000) return;
        run.lastBacklogWarning = now;
        this.onWarning('译音播放积压，已跳过部分过期译音；字幕和通话继续。请检查输出设备。');
    }

    setMix(mix) {
        const run = this.run;
        if (!run || run.closing) return Promise.resolve();
        const normalized = readQwenMix(mixSettings(mix));
        if (!normalized.translatedEnabled || normalized.translatedVolume === 0) run.audioGeneration++;
        run.mix = normalized;
        const outputId = run.outputId;
        if (outputId == null) return Promise.resolve();
        const updating = run.mixTail.then(async () => {
            if (this.run !== run || run.closing || run.outputId !== outputId) return;
            await this.invoke('set_translation_mix', { outputId, ...normalized });
        });
        run.mixTail = updating.catch(error => this._fail(run, 'outbound', `声音调整失败：${error}`));
        return updating;
    }

    async _restoreDevices(run) {
        if (run.restorePromise) return run.restorePromise;
        if (run.routeId == null) return;
        const routeId = run.routeId;
        run.restorePromise = this.invoke('end_system_audio_route', { routeId }).then(() => {
            if (run.routeId === routeId) run.routeId = null;
        }).catch(error => {
            // The native recovery record is retained for another attempt or next launch.
            if (!run.restoreWarning) {
                run.restoreWarning = true;
                this.onWarning(`恢复系统音频设备失败：${error}。请检查系统声音设置，重新连接原设备后重试。`);
            }
        });
        try { await run.restorePromise; }
        finally { run.restorePromise = null; }
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
        for (const recovery of Object.values(run.recoveries)) recovery.cancelWait?.();
        // Also called after late startup results, so cancellation cannot strand a native resource.
        // Clear the native playback queue immediately; capture may still deliver its final PCM.
        const outputId = run.outputId;
        run.outputId = null;
        const outputStopped = outputId != null
            ? this.invoke('stop_translation_output', { outputId }).catch(() => {})
            : Promise.resolve();
        await this.invoke('stop_duplex_capture').catch(() => {});
        await outputStopped;
        // Do not wait for cloud session.finish before returning the computer's devices.
        await this._restoreDevices(run);
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
        await Promise.allSettled(Object.values(run.recoveries).map(recovery => recovery.promise));
        await run.outputTail;
        await run.mixTail;
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
