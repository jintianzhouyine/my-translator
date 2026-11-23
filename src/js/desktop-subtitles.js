import { readDesktopSubtitleAppearance } from './desktop-subtitle-appearance.js';

export { readDesktopSubtitleAppearance } from './desktop-subtitle-appearance.js';

const CONTENT_MODES = new Set(['both', 'original', 'translation']);
const SPEAKERS = new Set(['self', 'peer', 'both']);

function text(value) { return typeof value === 'string' ? value : ''; }

function speakerOf(segment, audioSource) {
    if (segment.direction === 'outbound') return 'self';
    if (segment.direction === 'inbound') return 'peer';
    // Final segments retain the capture source they were recognized from even
    // after the next session switches its active input.
    const source = segment.audioSource || audioSource;
    if (source === 'microphone') return 'self';
    if (source === 'system') return 'peer';
    return null;
}

/** Project the current transcript into one lyric-sized sentence, without altering it. */
export function desktopSubtitlePayload(settings = {}, snapshot = {}) {
    const enabled = settings.desktop_subtitle_enabled === true;
    const content = CONTENT_MODES.has(settings.desktop_subtitle_content) ? settings.desktop_subtitle_content : 'both';
    const selectedSpeaker = SPEAKERS.has(settings.desktop_subtitle_speaker) ? settings.desktop_subtitle_speaker : 'self';
    const audioSource = snapshot.audioSource || settings.audio_source || 'system';
    const eligible = segment => selectedSpeaker === 'both' || speakerOf(segment, audioSource) === selectedSpeaker;
    const segments = Array.isArray(snapshot.segments) ? snapshot.segments : [];
    let candidate = null;
    // Qwen keeps IDs in recognition order, so a late source update to an older
    // sentence cannot displace the most recent sentence from the selected side.
    for (let index = segments.length - 1; index >= 0; index--) {
        const segment = segments[index];
        if (segment && eligible(segment) && (text(segment.original) || text(segment.translation))) {
            candidate = segment;
            break;
        }
    }

    const provisional = text(snapshot.provisionalText);
    const sourceProvisional = text(snapshot.sourceProvisionalText);
    if ((provisional || sourceProvisional) && eligible({})) {
        // Soniox's provisional stream contains source ASR. OpenAI has separate
        // source and target streams; never pair either with an older final.
        candidate = snapshot.provider === 'openai'
            ? { original: sourceProvisional, translation: provisional }
            : { original: provisional || sourceProvisional, translation: '' };
    }

    const speaker = candidate ? speakerOf(candidate, audioSource) : null;
    return {
        enabled,
        locked: settings.desktop_subtitle_locked === true,
        appearance: readDesktopSubtitleAppearance(settings),
        original: enabled && content !== 'translation' ? text(candidate?.original) : '',
        translation: enabled && content !== 'original' ? text(candidate?.translation) : '',
        speaker: enabled && candidate ? speaker === 'self' ? '我' : speaker === 'peer' ? '对方' : '混合音频' : '',
    };
}

/** Keeps the native window synchronized while coalescing streaming IPC writes. */
export class DesktopSubtitles {
    constructor({ invoke, onError = () => {} }) {
        Object.assign(this, { invoke, onError });
        this.settings = {};
        this.snapshot = {};
        this._pending = null;
        this._queuedKey = null;
        this._flushPromise = null;
        this._failureNotified = false;
    }

    configure(settings = {}) {
        this.settings = { ...settings };
        return this._publish();
    }

    update(snapshot = {}) {
        this.snapshot = {
            ...snapshot,
            segments: Array.isArray(snapshot.segments) ? snapshot.segments.map(segment => ({ ...segment })) : [],
        };
        return this._publish();
    }

    clear() {
        this.snapshot = {};
        return this._publish();
    }

    _publish() {
        const payload = desktopSubtitlePayload(this.settings, this.snapshot);
        const key = JSON.stringify(payload);
        if (key === this._queuedKey) return this._flushPromise || Promise.resolve();
        this._queuedKey = key;
        this._pending = payload;
        if (!this._flushPromise) {
            // Defer one microtask to collapse the source/translation updates made
            // during a single recognition callback into one native operation.
            this._flushPromise = Promise.resolve().then(async () => {
                try {
                    while (this._pending) {
                        const pending = this._pending;
                        this._pending = null;
                        try {
                            await this.invoke('set_desktop_subtitle', { payload: pending });
                            this._failureNotified = false;
                        } catch (error) {
                            if (!this._failureNotified) this.onError(`桌面字幕更新失败：${error.message || error}`);
                            this._failureNotified = true;
                            // An identical next update may retry a failed native write.
                            if (this._queuedKey === JSON.stringify(pending)) this._queuedKey = null;
                        }
                    }
                } finally {
                    // Clear synchronously with the empty-queue check; a separate
                    // Promise.finally leaves a microtask gap that can strand a push.
                    this._flushPromise = null;
                }
            });
        }
        return this._flushPromise;
    }
}
