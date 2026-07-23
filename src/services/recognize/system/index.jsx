import detect from '../../../utils/lang_detect';
import { osType } from '../../../utils/env';
import { invoke } from '@tauri-apps/api';
import { recognizeSystemImage, recognizeSystemScreenshot } from './core';

function getDependencies() {
    return {
        osType,
        invokeCommand: invoke,
        detectLanguage: detect,
    };
}

export async function recognize(_, lang) {
    return recognizeSystemScreenshot(lang, getDependencies());
}

export async function recognizeBase64(base64, lang) {
    return recognizeSystemImage(base64, lang, getDependencies());
}

export * from './Config';
export * from './info';
