import { Button, Card, CardBody, CardFooter, ButtonGroup, Chip, Tooltip, Spacer } from '@nextui-org/react';
import { BaseDirectory, readTextFile } from '@tauri-apps/plugin-fs';
import React, { useEffect, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { HiOutlineVolumeUp } from 'react-icons/hi';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import toast from 'react-hot-toast';
import { listen } from '@tauri-apps/api/event';
import { MdContentCopy } from 'react-icons/md';
import { MdSmartButton } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { HiTranslate } from 'react-icons/hi';
import { LuDelete } from 'react-icons/lu';
import { invoke } from '@tauri-apps/api';
import { atom, useAtom } from 'jotai';
import { getServiceName, getServiceSouceType, ServiceSourceType } from '../../../../utils/service_instance';
import { useConfig, useSpeechRequest, useSyncAtom, useToastStyle } from '../../../../hooks';
import { invoke_plugin } from '../../../../utils/invoke_plugin';
import * as recognizeServices from '../../../../services/recognize';
import * as builtinTtsServices from '../../../../services/tts';
import { getPublicTtsErrorMessage } from '../../../../services/tts/lingva/core';
import detect, { detectByScript, detectFast } from '../../../../utils/lang_detect';
import { store } from '../../../../utils/store';
import { info } from 'tauri-plugin-log-api';
import { debug } from 'tauri-plugin-log-api';
import {
    TRANSLATION_WINDOW_HIDE_EVENT,
    commitIfCurrentRequest,
    hideTranslationWindow,
    shouldPresentTranslationWindow,
    syncAndDetect,
} from '../../../../utils/translation_flow';
const appWindow = getCurrentWebviewWindow()

export const sourceTextAtom = atom('');
export const detectLanguageAtom = atom('');

let unlisten = null;
let timer = null;

export default function SourceArea(props) {
    const { pluginList, serviceInstanceConfigMap } = props;
    const [appFontSize] = useConfig('app_font_size', 16);
    const [sourceText, setSourceText, syncSourceText] = useSyncAtom(sourceTextAtom);
    const [detectLanguage, setDetectLanguage] = useAtom(detectLanguageAtom);
    const [dynamicTranslate] = useConfig('dynamic_translate', false);
    const [deleteNewline] = useConfig('translate_delete_newline', false);
    const [recognizeLanguage] = useConfig('recognize_language', 'auto');
    const [recognizeServiceList] = useConfig('recognize_service_list', ['system', 'tesseract']);
    const [ttsServiceList] = useConfig('tts_service_list', ['lingva_tts']);
    const [hideWindow] = useConfig('translate_hide_window', false);
    const [hideSource] = useConfig('hide_source', false);
    const [ttsPluginInfo, setTtsPluginInfo] = useState();
    const [windowType, setWindowType] = useState('[SELECTION_TRANSLATE]');
    const toastStyle = useToastStyle();
    const { t } = useTranslation();
    const textAreaRef = useRef();
    const detectRequestRef = useRef(0);
    const preserveStructureRequestRef = useRef(false);
    const handleNewTextRef = useRef();
    const runSpeechRequest = useSpeechRequest();

    // 统一提交本次源文，并返回用于显式同步的相同文本。
    const commitSourceText = (newText) => {
        setSourceText(newText);
        return newText;
    };

    // OCR 异步结果仅允许写入仍为当前请求的状态。
    const commitSourceTextIfCurrent = (newText, requestId) => {
        return commitIfCurrentRequest({
            requestId,
            currentRequestId: detectRequestRef.current,
            commit: () => commitSourceText(newText),
        });
    };

    // 插件与内置 OCR 共用同一成功出口，完整检测后再同步译文。
    const handleRecognizedText = (recognizedText, requestId) => {
        if (detectRequestRef.current !== requestId) {
            return;
        }
        let newText = recognizedText.trim();
        const preserveStructure = preserveStructureRequestRef.current;
        if (deleteNewline && !preserveStructure) {
            newText = recognizedText.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
        }
        if (!commitSourceTextIfCurrent(newText, requestId)) {
            return;
        }
        const nextSourceText = newText;
        void syncAndDetect({
            text: nextSourceText,
            sync: () => syncSourceText(nextSourceText),
            detect,
            detectFallback: detectByScript,
            setDetected: setDetectLanguage,
            isCurrent: () => detectRequestRef.current === requestId,
        });
    };

    // 过期 OCR 的错误同样不得覆盖较新的划词或识别结果。
    const handleRecognizeError = (error, requestId) => {
        commitSourceTextIfCurrent(error.toString(), requestId);
    };

    const handleNewText = async (text) => {
        const requestId = ++detectRequestRef.current;
        preserveStructureRequestRef.current = false;
        text = text.trim();
        if (!shouldPresentTranslationWindow(hideWindow)) {
            appWindow.hide();
        } else {
            appWindow.show();
            if (text !== '') {
                appWindow.setFocus();
            }
        }
        // 检测期间先清空已同步的旧源文，避免语言状态变化重启旧目标翻译。
        syncSourceText('');
        // 清空检测语言
        setDetectLanguage('');
        if (text === '[INPUT_TRANSLATE]') {
            setWindowType('[INPUT_TRANSLATE]');
            appWindow.show();
            appWindow.setFocus();
            setSourceText('', true);
        } else if (text === '[IMAGE_TRANSLATE]') {
            setWindowType('[IMAGE_TRANSLATE]');
            commitSourceText('');
            try {
                const base64 = await invoke('get_base64');
                if (detectRequestRef.current !== requestId) {
                    return;
                }
                const serviceInstanceKey = recognizeServiceList[0];
                if (getServiceSouceType(serviceInstanceKey) === ServiceSourceType.PLUGIN) {
                    if (recognizeLanguage in pluginList['recognize'][getServiceName(serviceInstanceKey)].language) {
                        const pluginConfig = serviceInstanceConfigMap[serviceInstanceKey];
                        let [func, utils] = await invoke_plugin('recognize', getServiceName(serviceInstanceKey));
                        if (detectRequestRef.current !== requestId) {
                            return;
                        }
                        func(
                            base64,
                            pluginList['recognize'][getServiceName(serviceInstanceKey)].language[recognizeLanguage],
                            {
                                config: pluginConfig,
                                utils,
                            }
                        ).then(
                            (value) => handleRecognizedText(value, requestId),
                            (error) => handleRecognizeError(error, requestId)
                        );
                    } else {
                        handleRecognizeError('Language not supported', requestId);
                    }
                } else {
                    preserveStructureRequestRef.current =
                        recognizeServices[getServiceName(serviceInstanceKey)]?.info?.structuredOutput === true;
                    if (recognizeLanguage in recognizeServices[getServiceName(serviceInstanceKey)].Language) {
                        const instanceConfig = serviceInstanceConfigMap[serviceInstanceKey];
                        recognizeServices[getServiceName(serviceInstanceKey)]
                            .recognize(
                                base64,
                                recognizeServices[getServiceName(serviceInstanceKey)].Language[recognizeLanguage],
                                {
                                    config: instanceConfig,
                                    onResultMetadata: (metadata) => {
                                        if (detectRequestRef.current === requestId) {
                                            preserveStructureRequestRef.current = metadata.structured === true;
                                            if (metadata.source === 'system') {
                                                toast(t('services.recognize.ollama_ocr.fallback_notice'), {
                                                    icon: '⚠️',
                                                    style: toastStyle,
                                                });
                                            }
                                        }
                                    },
                                }
                            )
                            .then(
                                (value) => handleRecognizedText(value, requestId),
                                (error) => handleRecognizeError(error, requestId)
                            );
                    } else {
                        handleRecognizeError('Language not supported', requestId);
                    }
                }
            } catch (error) {
                handleRecognizeError(error, requestId);
            }
        } else {
            setWindowType('[SELECTION_TRANSLATE]');
            let newText = text.trim();
            if (deleteNewline) {
                newText = text.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
            }
            if (newText === '') {
                commitSourceText('');
                return;
            }
            const nextSourceText = commitSourceText(newText);
            void syncAndDetect({
                text: nextSourceText,
                sync: () => syncSourceText(nextSourceText),
                detect,
                detectFast,
                detectFallback: detectByScript,
                setDetected: setDetectLanguage,
                isCurrent: () => detectRequestRef.current === requestId,
            });
        }
    };
    handleNewTextRef.current = handleNewText;

    // 用户主动隐藏时同步废弃检测请求；配置驱动的自动隐藏不派发此事件，继续后台翻译。
    useEffect(() => {
        const cancelPendingDetection = () => {
            detectRequestRef.current++;
        };
        window.addEventListener(TRANSLATION_WINDOW_HIDE_EVENT, cancelPendingDetection);
        return () => {
            window.removeEventListener(TRANSLATION_WINDOW_HIDE_EVENT, cancelPendingDetection);
        };
    }, []);

    const keyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            detect_language(sourceText).then(() => {
                syncSourceText();
            });
        }
        if (event.key === 'Escape') {
            void hideTranslationWindow(appWindow);
        }
    };

    const handleSpeak = () =>
        runSpeechRequest(async () => {
            const instanceKey = ttsServiceList[0];
            let detected = detectLanguage;
            if (detected === '') {
                detected = await detect(sourceText);
                setDetectLanguage(detected);
            }
            if (getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN) {
                if (!(detected in ttsPluginInfo.language)) throw new Error('Language not supported');
                const pluginConfig = serviceInstanceConfigMap[instanceKey];
                const [func, utils] = await invoke_plugin('tts', getServiceName(instanceKey));
                return func(sourceText, ttsPluginInfo.language[detected], {
                    config: pluginConfig,
                    utils,
                });
            }

            if (!(detected in builtinTtsServices[getServiceName(instanceKey)].Language)) {
                throw new Error('Language not supported');
            }
            const instanceConfig = serviceInstanceConfigMap[instanceKey];
            return builtinTtsServices[getServiceName(instanceKey)].tts(
                sourceText,
                builtinTtsServices[getServiceName(instanceKey)].Language[detected],
                { config: instanceConfig }
            );
        });

    useEffect(() => {
        if (hideWindow !== null) {
            if (unlisten) {
                unlisten.then((f) => {
                    f();
                });
            }
            unlisten = listen('new_text', (event) => {
                handleNewTextRef.current(event.payload?.text ?? event.payload);
            });
        }
    }, [hideWindow]);

    useEffect(() => {
        if (ttsServiceList && getServiceSouceType(ttsServiceList[0]) === ServiceSourceType.PLUGIN) {
            readTextFile(`plugins/tts/${getServiceName(ttsServiceList[0])}/info.json`, {
                dir: BaseDirectory.AppConfig,
            }).then((infoStr) => {
                setTtsPluginInfo(JSON.parse(infoStr));
            });
        }
    }, [ttsServiceList]);

    useEffect(() => {
        if (
            deleteNewline !== null &&
            recognizeLanguage !== null &&
            recognizeServiceList !== null &&
            hideWindow !== null
        ) {
                invoke('get_text').then((v) => {
                    // 后台划词尚未完成时 Rust 状态为空；此时不能抢走原应用焦点。
                    if (v === '') return;
                    handleNewText(v);
                });
        }
    }, [deleteNewline, recognizeLanguage, recognizeServiceList, hideWindow]);

    useEffect(() => {
        textAreaRef.current.style.height = '50px';
        textAreaRef.current.style.height = textAreaRef.current.scrollHeight + 'px';
    }, [sourceText]);

    const detect_language = async (text) => {
        setDetectLanguage(await detect(text));
    };

    let sourceTextChangeTimer = null;
    const changeSourceText = async (text) => {
        setDetectLanguage('');
        await setSourceText(text);
        if (dynamicTranslate) {
            if (sourceTextChangeTimer) {
                clearTimeout(sourceTextChangeTimer);
            }
            sourceTextChangeTimer = setTimeout(() => {
                detect_language(text).then(() => {
                    syncSourceText();
                });
            }, 1000);
        }
    }

    const transformVarName = function (str) {
        let str2 = str;

        // snake_case to SNAKE_CASE
        if (/_[a-z]/.test(str2)) {
            str2 = str2.split('_').map(it => it.toLocaleUpperCase()).join('_');
        }
        if (str2 !== str) {
            return str2;
        }

        // SNAKE_CASE to kebab-case
        if (/^[A-Z]+(_[A-Z]+)*$/.test(str2)) {
            str2 = str2.split('_').map(it => it.toLocaleLowerCase()).join('-');
        }
        if (str2 !== str) {
            return str2;
        }

        // kebab-case to dot.notation
        if (/-/.test(str2)) {
            str2 = str2.split('-').map(it => it.toLocaleLowerCase()).join('.');
        }
        if (str2 !== str) {
            return str2;
        }

        // dot.notation to space separated
        if (/\.[a-z]/.test(str2)) {
            str2 = str2.replaceAll(/(\.)([a-z])/g, (_, _2, it) => ' ' + it);
        }
        if (str2 !== str) {
            return str2;
        }

        // space separated to Title Case
        if (/\s[a-z]/.test(str2)) {
            str2 = str2.replaceAll(/\s([a-z])/g, (_, it) => ' ' + it.toLocaleUpperCase());
            str2 = str2.substring(0, 1).toLocaleUpperCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // Title Case to CamelCase
        if (/\s[A-Z]/.test(str2)) {
            str2 = str2.replaceAll(/\s([A-Z])/g, (_, it) => it);
            str2 = str2.substring(0, 1).toLocaleLowerCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // CamelCase to PascalCase
        if (/^[a-z]+[A-Z]+/.test(str2)) {
            str2 = str2.substring(0, 1).toLocaleUpperCase() + str2.substring(1);
        }
        if (str2 !== str) {
            return str2;
        }

        // PascalCase to snake_case
        if (/[^\s][A-Z]/.test(str2)) {
            str2 = str2.replaceAll(/[A-Z]/g, (it, offset) => {
                return (offset == 0 ? '' : '_') + it.toLocaleLowerCase();
            });
        }

        return str2;
    }
    useEffect(() => {
        textAreaRef.current.addEventListener("keydown", async (event) => {
            if (event.altKey && event.shiftKey && event.code === 'KeyU') {
                const originText = textAreaRef.current.value;
                const selectionStart = textAreaRef.current.selectionStart;
                const selectionEnd = textAreaRef.current.selectionEnd;
                const selectionText = originText.substring(selectionStart, selectionEnd);

                const convertedText = transformVarName(selectionText);
                const targetText = originText.substring(0, selectionStart) + convertedText + originText.substring(selectionEnd);

                await changeSourceText(targetText);
                textAreaRef.current.selectionStart = selectionStart;
                textAreaRef.current.selectionEnd = selectionStart + convertedText.length;
            }
        });
    }, [textAreaRef]);


    return (
        <div className={hideSource && windowType !== '[INPUT_TRANSLATE]' && 'hidden'}>
            <Card
                shadow='none'
                className='translate-card mt-[1px] pb-0'
            >
                <CardBody className='translate-source-body'>
                    <textarea
                        autoFocus
                        ref={textAreaRef}
                        aria-label='待翻译原文'
                        className='translate-source-input h-full resize-none outline-none'
                        style={{ fontSize: `${appFontSize}px` }}
                        value={sourceText}
                        onKeyDown={keyDown}
                        onChange={(e) => {
                            const v = e.target.value;
                            changeSourceText(v);
                        }}
                    />
                </CardBody>

                <CardFooter className='translate-card-footer flex justify-between'>
                    <div className='flex min-w-0 items-center justify-start gap-1'>
                        <ButtonGroup className='mr-[5px]'>
                            <Tooltip
                                content={t('translate.speak')}
                                delay={450}
                            >
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    aria-label={t('translate.speak')}
                                    className='translate-tool-button'
                                    onPress={() => {
                                        handleSpeak().catch((e) => {
                                            toast.error(getPublicTtsErrorMessage(e), { style: toastStyle });
                                        });
                                    }}
                                >
                                    <HiOutlineVolumeUp className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            <Tooltip
                                content={t('translate.copy')}
                                delay={450}
                            >
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    aria-label={t('translate.copy')}
                                    className='translate-tool-button'
                                    onPress={() => {
                                        void writeText(sourceText).then(() => {
                                            toast.success(t('translate.copied'), { style: toastStyle });
                                        });
                                    }}
                                >
                                    <MdContentCopy className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            <Tooltip
                                content={t('translate.delete_newline')}
                                delay={450}
                            >
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    aria-label={t('translate.delete_newline')}
                                    className='translate-tool-button'
                                    onPress={() => {
                                        const newText = sourceText.replace(/\-\s+/g, '').replace(/\s+/g, ' ');
                                        setSourceText(newText);
                                        detect_language(newText).then(() => {
                                            syncSourceText();
                                        });
                                    }}
                                >
                                    <MdSmartButton className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            <Tooltip
                                content={t('common.clear')}
                                delay={450}
                                placement='top-end'
                            >
                                <Button
                                    variant='light'
                                    size='sm'
                                    isIconOnly
                                    aria-label={t('common.clear')}
                                    className='translate-tool-button'
                                    isDisabled={sourceText === ''}
                                    onPress={() => {
                                        setSourceText('');
                                    }}
                                >
                                    <LuDelete className='text-[16px]' />
                                </Button>
                            </Tooltip>
                        </ButtonGroup>
                        {detectLanguage !== '' && (
                            <Chip
                                size='sm'
                                color='primary'
                                variant='flat'
                                className='translate-detected-chip my-auto'
                            >
                                {t('translate.detected_as', { language: t(`languages.${detectLanguage}`) })}
                            </Chip>
                        )}
                    </div>
                    <Tooltip
                        content={t('translate.translate')}
                        delay={450}
                    >
                        <Button
                            size='sm'
                            color='primary'
                            variant='light'
                            isIconOnly
                            aria-label={t('translate.translate')}
                            className='translate-tool-button text-[14px] font-bold'
                            startContent={<HiTranslate className='text-[16px]' />}
                            onPress={() => {
                                detect_language(sourceText).then(() => {
                                    syncSourceText();
                                });
                            }}
                        />
                    </Tooltip>
                </CardFooter>
            </Card>
            <Spacer y={2} />
        </div>
    );
}
