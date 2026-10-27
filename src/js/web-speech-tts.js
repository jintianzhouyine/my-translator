/**
 * Web Speech TTS — Browser built-in SpeechSynthesis API
 * Completely local, free, no API key needed.
 * Uses system voices installed on macOS/Windows.
 */

class WebSpeechTTS {
    constructor() {
        this.voice = null;
        this.voiceName = null;
        this.rate = 1.2;
        this.pitch = 1.0;
        this.volume = 1.0;
        this.lang = 'vi-VN';
        this.isConnected = false;

        // Same callback interface as ElevenLabsTTS
        this.onAudioChunk = null;   // Not used — Web Speech plays directly
        this.onError = null;
        this.onStatusChange = null;

        this._queue = [];
        this._isSpeaking = false;
        this._voicesLoaded = false;
    }

    /**
     * Configure voice
     */
    configure({ voice, lang, rate }) {
        if (voice) this.voiceName = voice;
        if (lang) this.lang = lang;
        if (rate) this.rate = rate;
        this._loadVoice();
    }

    /**
     * Load the selected voice from available system voices
     */
    _loadVoice() {
        const voices = speechSynthesis.getVoices();
        if (voices.length === 0) {
            // Voices not loaded yet — wait for event
            speechSynthesis.addEventListener('voiceschanged', () => this._loadVoice(), { once: true });
            return;
        }

        this._voicesLoaded = true;

        // Try to find exact match
        if (this.voiceName) {
            this.voice = voices.find(v => v.name === this.voiceName);
        }

        // Fallback: find Vietnamese voice
        if (!this.voice) {
            this.voice = voices.find(v => v.lang.startsWith('vi'));
        }

        // List available Vietnamese voices
        const viVoices = voices.filter(v => v.lang.startsWith('vi'));
        console.log('[WebSpeech] Vietnamese voices:', viVoices.map(v => `${v.name} (${v.lang})`));
        if (this.voice) {
            console.log('[WebSpeech] Using voice:', this.voice.name);
        } else {
            console.warn('[WebSpeech] No Vietnamese voice found. Available:', voices.map(v => v.name).slice(0, 10));
        }
    }

    /**
     * "Connect" — just mark as ready
     */
    connect() {
        this._loadVoice();
        this.isConnected = true;
        this._setStatus('connected');
        console.log('[WebSpeech] Ready');
    }

    /**
     * Speak text using SpeechSynthesis
     */
    speak(text) {
        if (!text?.trim()) return;

        const utterance = new SpeechSynthesisUtterance(text.trim());
        utterance.lang = this.lang;
        utterance.rate = this.rate;
        utterance.pitch = this.pitch;
        utterance.volume = this.volume;

        if (this.voice) {
            utterance.voice = this.voice;
        }

        utterance.onstart = () => {
            this._isSpeaking = true;
        };

        utterance.onend = () => {
            this._isSpeaking = false;
        };

        utterance.onerror = (event) => {
            this._isSpeaking = false;
            if (event.error !== 'canceled') {
                console.error('[WebSpeech] Error:', event.error);
                this.onError?.(`语音朗读错误：${event.error}`);
            }
        };

        speechSynthesis.speak(utterance);
    }

    /**
     * Disconnect — cancel speech
     */
    disconnect() {
        speechSynthesis.cancel();
        this._isSpeaking = false;
        this.isConnected = false;
        this._setStatus('disconnected');
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }

    /**
     * Get list of available Vietnamese voices (for settings UI)
     */
    static getVietnameseVoices() {
        const voices = speechSynthesis.getVoices();
        return voices.filter(v => v.lang.startsWith('vi'));
    }

    /**
     * Get all available voices
     */
    static getAllVoices() {
        return speechSynthesis.getVoices();
    }
}

export const webSpeechTTS = new WebSpeechTTS();
