function copyAudioBytes(data) {
    if (data instanceof ArrayBuffer) return data.slice(0);
    if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (Array.isArray(data) && data.length > 0) return Uint8Array.from(data).buffer;
    throw new Error('音频数据无效');
}

function decodeAudio(context, bytes) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => (value) => {
            if (settled) return;
            settled = true;
            callback(value);
        };
        const succeed = finish(resolve);
        const fail = finish(reject);

        try {
            const result = context.decodeAudioData(bytes, succeed, fail);
            if (result?.then) result.then(succeed, fail);
        } catch (error) {
            fail(error);
        }
    });
}

export function createVoicePlayer(createAudioContext) {
    let audioContext = null;
    let source = null;
    let decoding = false;
    let generation = 0;
    let preparation = null;

    const prepare = () => {
        audioContext ??= createAudioContext();
        if (audioContext.state !== 'suspended') return null;
        preparation ??= Promise.resolve(audioContext.resume()).finally(() => {
            preparation = null;
        });
        return preparation;
    };

    const stopCurrent = () => {
        if (!source) return;
        const current = source;
        source = null;
        try {
            current.stop();
        } catch {
            // 音频可能已自然结束，停止失败不影响清理。
        }
        try {
            current.disconnect();
        } catch {
            // 已断开的节点无需重复处理。
        }
    };

    const playOrStop = async function playOrStop(data) {
        const requestGeneration = ++generation;
        if (source || decoding) {
            decoding = false;
            stopCurrent();
            return false;
        }

        decoding = true;
        try {
            const playbackReady = prepare();
            if (playbackReady) await playbackReady;
            const buffer = await decodeAudio(audioContext, copyAudioBytes(data));

            if (!decoding || generation !== requestGeneration) return false;
            decoding = false;

            const nextSource = audioContext.createBufferSource();
            nextSource.buffer = buffer;
            nextSource.connect(audioContext.destination);
            nextSource.onended = () => {
                if (source !== nextSource) return;
                try {
                    nextSource.disconnect();
                } finally {
                    source = null;
                }
            };
            source = nextSource;
            nextSource.start();
            return true;
        } catch (error) {
            if (generation !== requestGeneration) return false;
            decoding = false;
            throw error;
        }
    };

    playOrStop.stop = () => {
        const wasActive = Boolean(source || decoding);
        generation++;
        decoding = false;
        stopCurrent();
        return wasActive;
    };
    // 必须在点击处理器的同步阶段调用 resume；等 TTS 异步合成结束后再创建
    // AudioContext 会失去 WebView2 的用户手势授权，表现为有音频数据但无声。
    playOrStop.prepare = prepare;

    return playOrStop;
}

export function createSpeechRequestGate(playAudio) {
    let generation = 0;

    return {
        async run(loadAudio) {
            const requestGeneration = ++generation;
            playAudio.stop?.();
            let playbackReady;
            try {
                playbackReady = Promise.resolve(playAudio.prepare?.());
                // 音频合成可能较慢，先处理潜在拒绝以免产生未处理 Promise。
                playbackReady.catch(() => {});
            } catch (error) {
                playbackReady = Promise.reject(error);
                playbackReady.catch(() => {});
            }
            let audio;
            try {
                audio = await loadAudio();
                await playbackReady;
            } catch (error) {
                if (generation !== requestGeneration) return false;
                throw error;
            }
            if (generation !== requestGeneration) return false;
            await playAudio(audio);
            return true;
        },
        play(audio) {
            generation++;
            return playAudio(audio);
        },
        cancel() {
            generation++;
            playAudio.stop?.();
        },
    };
}
