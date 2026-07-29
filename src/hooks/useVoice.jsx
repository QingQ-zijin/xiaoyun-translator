import { useCallback } from 'react';
import { createSpeechRequestGate, createVoicePlayer } from './voicePlayerCore';

const playOrStop = createVoicePlayer(() => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('当前系统不支持音频播放');
    return new AudioContext();
});
const sharedSpeechRequestGate = createSpeechRequestGate(playOrStop);

export const useVoice = () => {
    return useCallback((data) => sharedSpeechRequestGate.play(data), []);
};

export const useSpeechRequest = () => {
    return useCallback((loadAudio) => sharedSpeechRequestGate.run(loadAudio), []);
};

export const cancelSpeechRequest = () => {
    sharedSpeechRequestGate.cancel();
};
