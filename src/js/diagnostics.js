// Never forward raw errors, settings, transcripts or audio to persistent logs.
// Provider messages are used only to select one of these diagnostic categories.
export function classifyDiagnosticReason(message) {
    const text = String(message?.message || message || '');
    if (/\b(?:401|403)\b|InvalidApiKey|invalid[_ -]?api[_ -]?key|unauthori[sz]ed|forbidden|鉴权|密钥.*(?:无效|错误)/i.test(text)) return 'auth';
    if (/\b402\b|insufficient[_ -]?(?:quota|balance)|quota.?exhaust|余额|欠费/i.test(text)) return 'quota';
    if (/\b429\b|throttl|rate.?limit|限流|过于频繁/i.test(text)) return 'rate_limit';
    if (/\b(?:400|422)\b|InvalidParam|invalid[_ -]?(?:parameter|argument|workspace|payload)|配置错误|参数.*无效/i.test(text)) return 'configuration';
    if (/backpressure|积压/i.test(text)) return 'backpressure';
    if (/音频采集|capture|microphone|麦克风/i.test(text)) return 'capture';
    if (/译音输出|输出设备|恢复系统.*设备|playback/i.test(text)) return 'output';
    if (/timeout|timed.?out|超时/i.test(text)) return 'timeout';
    if (/\b5\d\d\b|ServiceUnavailable|ModelServiceFailed/i.test(text)) return 'provider';
    if (/连接|断开|network|socket|ECONN|connection|\b1006\b/i.test(text)) return 'network';
    return 'unknown';
}

const EVENTS = new Set(['app_started', 'live_started', 'live_paused', 'live_failed', 'state_changed', 'retry_scheduled', 'warning', 'error']);
const FIELDS = {
    engine: ['app', 'soniox', 'openai', 'qwen', 'local'],
    source: ['system', 'microphone', 'both'],
    direction: ['inbound', 'outbound', 'none'],
    state: ['connecting', 'connected', 'disconnected', 'error', 'stopping'],
    reason: ['auth', 'quota', 'rate_limit', 'configuration', 'backpressure', 'capture', 'output', 'timeout', 'network', 'provider', 'unknown', 'requested', 'auto_failure', 'app_exit'],
    mode: ['caption', 'duplex'],
};

export class DiagnosticLogger {
    constructor({ invoke, context = () => ({}), maxPending = 64, timeoutMs = 2000 }) {
        Object.assign(this, { invoke, context, maxPending, timeoutMs });
        this._tail = Promise.resolve();
        this._pending = 0;
    }

    record(event, details = {}) {
        if (!EVENTS.has(event) || this._pending >= this.maxPending) return Promise.resolve();
        const entry = { event };
        try {
            const input = { ...this.context(), ...details };
            for (const [field, allowed] of Object.entries(FIELDS)) {
                if (allowed.includes(input[field])) entry[field] = input[field];
            }
            for (const [field, maximum] of [['attempt', 3], ['generation', Number.MAX_SAFE_INTEGER]]) {
                if (Number.isSafeInteger(input[field]) && input[field] >= 0 && input[field] <= maximum) entry[field] = input[field];
            }
        } catch { return Promise.resolve(); }
        this._pending++;
        this._tail = this._tail.then(async () => {
            let timer;
            try {
                await Promise.race([
                    Promise.resolve().then(() => this.invoke('write_diagnostic_event', { entry })),
                    new Promise(resolve => { timer = setTimeout(resolve, this.timeoutMs); }),
                ]);
            } catch { /* A full disk or unavailable log directory must not stop translation. */ }
            finally { clearTimeout(timer); this._pending--; }
        });
        return this._tail;
    }

    notice(message, details = {}) {
        try {
            const text = String(message?.message || message || '');
            const retry = /正在.*重连|reconnecting/i.test(text);
            const attempt = retry ? Number(text.match(/[（(]([1-3])\s*\/\s*3[）)]/)?.[1]) : undefined;
            return this.record(retry ? 'retry_scheduled' : 'warning', {
                ...details, reason: classifyDiagnosticReason(text), attempt,
            });
        } catch { return Promise.resolve(); }
    }

    flush() { return this._tail; }
}
