const aborted = () => new DOMException('已取消', 'AbortError');

/** Native file handles are opaque; only the selected source is exposed to the player. */
export function createNativeAudioSource({ invoke, convertFileSrc }) {
    return async function openSource({ signal } = {}) {
        const info = await invoke('audio_file_open_source');
        if (!info) return null;
        let closed = false;
        const dispose = async () => {
            if (closed) return;
            closed = true;
            await invoke('audio_file_close_source', { id: info.id });
        };
        if (signal?.aborted) { await dispose(); throw aborted(); }
        return {
            ...info, audioUrl: convertFileSrc(info.id, 'audio-source'),
            async preparePart(part, { signal } = {}) {
                if (closed || signal?.aborted) throw aborted();
                const cancel = () => { void invoke('audio_file_cancel_prepare', { id: info.id }).catch(() => {}); };
                signal?.addEventListener('abort', cancel, { once: true });
                let prepared;
                try {
                    prepared = await invoke('audio_file_prepare_part', { id: info.id, startMs: part.startMs, endMs: part.endMs });
                    if (closed || signal?.aborted) {
                        await invoke('audio_file_release_part', { id: info.id, partId: prepared.id });
                        throw aborted();
                    }
                } finally { signal?.removeEventListener('abort', cancel); }
                let released = false;
                return {
                    sampleRate: prepared.sampleRate, totalSamples: prepared.totalSamples,
                    async pcmChunk(startSample, count) {
                        if (released || closed || signal?.aborted) throw aborted();
                        const bytes = await invoke('audio_file_read_part', { id: info.id, partId: prepared.id, startSample, count });
                        if (signal?.aborted) throw aborted();
                        return new Uint8Array(bytes);
                    },
                    async dispose() {
                        if (released) return;
                        released = true;
                        await invoke('audio_file_release_part', { id: info.id, partId: prepared.id });
                    },
                };
            },
            dispose,
        };
    };
}
