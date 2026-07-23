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

    return async function playOrStop(data) {
        const requestGeneration = ++generation;
        if (source || decoding) {
            decoding = false;
            stopCurrent();
            return false;
        }

        decoding = true;
        try {
            audioContext ??= createAudioContext();
            if (audioContext.state === 'suspended') await audioContext.resume();
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
}

export function createSpeechRequestGate(playAudio) {
    let generation = 0;

    return {
        async run(loadAudio) {
            const requestGeneration = ++generation;
            let audio;
            try {
                audio = await loadAudio();
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
        },
    };
}
