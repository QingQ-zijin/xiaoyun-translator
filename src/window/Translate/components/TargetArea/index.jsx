import {
    Card,
    CardBody,
    CardHeader,
    CardFooter,
    Button,
    ButtonGroup,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Tooltip,
    Skeleton,
    Spinner,
} from '@nextui-org/react';
import { BaseDirectory, readTextFile } from '@tauri-apps/plugin-fs';
import { sendNotification } from '@tauri-apps/plugin-notification';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { TbTransformFilled } from 'react-icons/tb';
import { HiChevronDown, HiChevronUp, HiOutlineVolumeUp } from 'react-icons/hi';
import toast from 'react-hot-toast';
import { MdContentCopy, MdStop } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import Database from '@tauri-apps/plugin-sql';
import { GiCycle } from 'react-icons/gi';
import { useAtomValue } from 'jotai';
import { nanoid } from 'nanoid';
import { useSpring, animated } from '@react-spring/web';
import useMeasure from 'react-use-measure';

import * as builtinCollectionServices from '../../../../services/collection';
import { sourceLanguageAtom, targetLanguageAtom } from '../LanguageArea';
import { useConfig, useSpeechRequest, useToastStyle, useVoice } from '../../../../hooks';
import { sourceTextAtom, detectLanguageAtom } from '../SourceArea';
import { invoke_plugin } from '../../../../utils/invoke_plugin';
import * as builtinServices from '../../../../services/translate';
import * as builtinTtsServices from '../../../../services/tts';
import { getPublicTtsErrorMessage } from '../../../../services/tts/lingva/core';
import FormattedTranslation from '../FormattedTranslation';
import { TRANSLATION_WINDOW_HIDE_EVENT } from '../../../../utils/translation_flow';

import { info, error as logError } from 'tauri-plugin-log-api';
import {
    INSTANCE_NAME_CONFIG_KEY,
    ServiceSourceType,
    getDisplayInstanceName,
    getServiceName,
    getServiceSouceType,
    whetherPluginService,
} from '../../../../utils/service_instance';

let translateID = [];

export default function TargetArea(props) {
    const { index, name, translateServiceInstanceList, pluginList, serviceInstanceConfigMap, ...drag } = props;

    const [currentTranslateServiceInstanceKey, setCurrentTranslateServiceInstanceKey] = useState(name);
    function getInstanceName(instanceKey, serviceNameSupplier) {
        const instanceConfig = serviceInstanceConfigMap[instanceKey] ?? {};
        return getDisplayInstanceName(instanceConfig[INSTANCE_NAME_CONFIG_KEY], serviceNameSupplier);
    }

    const [appFontSize] = useConfig('app_font_size', 16);
    const [collectionServiceList] = useConfig('collection_service_list', []);
    const [ttsServiceList] = useConfig('tts_service_list', ['lingva_tts']);
    const [translateSecondLanguage] = useConfig('translate_second_language', 'en');
    const [historyDisable] = useConfig('history_disable', false);
    const [isLoading, setIsLoading] = useState(false);
    const [hide, setHide] = useState(true);

    const [result, setResult] = useState('');
    const [error, setError] = useState('');

    const sourceText = useAtomValue(sourceTextAtom);
    const sourceLanguage = useAtomValue(sourceLanguageAtom);
    const targetLanguage = useAtomValue(targetLanguageAtom);
    const [autoCopy] = useConfig('translate_auto_copy', 'disable');
    const [hideWindow] = useConfig('translate_hide_window', false);
    const [clipboardMonitor] = useConfig('clipboard_monitor', false);

    const detectLanguage = useAtomValue(detectLanguageAtom);
    const [ttsPluginInfo, setTtsPluginInfo] = useState();
    const { t } = useTranslation();
    const toastStyle = useToastStyle();
    const speak = useVoice();
    const runSpeechRequest = useSpeechRequest();
    const cancelTranslationRef = useRef(null);

    const cancelActiveTranslation = useCallback(() => {
        cancelTranslationRef.current?.();
        cancelTranslationRef.current = null;
    }, []);

    const stopActiveTranslation = useCallback(() => {
        translateID[index] = nanoid();
        cancelActiveTranslation();
        setIsLoading(false);
    }, [index, cancelActiveTranslation]);

    useEffect(() => {
        if (error) {
            logError(`[${currentTranslateServiceInstanceKey}]happened error: ` + error);
        }
    }, [error]);

    useEffect(() => {
        const cancelPendingTranslation = () => {
            stopActiveTranslation();
        };
        window.addEventListener(TRANSLATION_WINDOW_HIDE_EVENT, cancelPendingTranslation);
        return () => {
            window.removeEventListener(TRANSLATION_WINDOW_HIDE_EVENT, cancelPendingTranslation);
            cancelActiveTranslation();
        };
    }, [stopActiveTranslation]);

    // listen to translation
    useEffect(() => {
        // 源文或语言变化时立即废弃旧请求，空源文也不能保留旧回调的写入权限。
        translateID[index] = nanoid();
        cancelActiveTranslation();
        setIsLoading(false);
        setResult('');
        setError('');
        if (
            sourceText.trim() !== '' &&
            sourceLanguage &&
            targetLanguage &&
            autoCopy !== null &&
            hideWindow !== null &&
            clipboardMonitor !== null
        ) {
            if (autoCopy === 'source' && !clipboardMonitor) {
                writeText(sourceText).then(() => {
                    if (hideWindow) {
                        sendNotification({ title: t('common.write_clipboard'), body: sourceText });
                    }
                });
            }
            translate();
        }
    }, [
        sourceText,
        sourceLanguage,
        detectLanguage,
        targetLanguage,
        autoCopy,
        hideWindow,
        currentTranslateServiceInstanceKey,
        clipboardMonitor,
        cancelActiveTranslation,
    ]);

    // todo: history panel use service instance key
    const addToHistory = async (text, source, target, serviceInstanceKey, result) => {
        const db = await Database.load('sqlite:history.db');

        await db
            .execute(
                'INSERT into history (text, source, target, service, result, timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
                [text, source, target, serviceInstanceKey, result, Date.now()]
            )
            .then(
                (v) => {
                    db.close();
                },
                (e) => {
                    db.execute(
                        'CREATE TABLE history(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,service TEXT NOT NULL, result TEXT NOT NULL,timestamp INTEGER NOT NULL)'
                    ).then(() => {
                        db.close();
                        addToHistory(text, source, target, serviceInstanceKey, result);
                    });
                }
            );
    };

    function invokeOnce(fn) {
        let isInvoke = false;

        return (...args) => {
            if (isInvoke) {
                return;
            } else {
                fn(...args);
                isInvoke = true;
            }
        };
    }

    const translate = async () => {
        let id = nanoid();
        translateID[index] = id;
        const registerCancel = (cancel) => {
            if (translateID[index] !== id) {
                cancel?.();
                return;
            }
            cancelTranslationRef.current = cancel;
        };

        const translateServiceName = getServiceName(currentTranslateServiceInstanceKey);

        if (whetherPluginService(currentTranslateServiceInstanceKey)) {
            const pluginInfo = pluginList['translate'][translateServiceName];
            if (sourceLanguage in pluginInfo.language && targetLanguage in pluginInfo.language) {
                let newTargetLanguage = targetLanguage;
                if (sourceLanguage === 'auto' && targetLanguage === detectLanguage) {
                    newTargetLanguage = translateSecondLanguage;
                }
                setIsLoading(true);
                setHide(false);
                const instanceConfig = serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                instanceConfig['enable'] = 'true';
                const setHideOnce = invokeOnce(setHide);
                let [func, utils] = await invoke_plugin('translate', translateServiceName);
                func(sourceText.trim(), pluginInfo.language[sourceLanguage], pluginInfo.language[newTargetLanguage], {
                    config: instanceConfig,
                    detect: detectLanguage,
                    setResult: (v) => {
                        if (translateID[index] !== id) return;
                        setResult(v);
                        setHideOnce(false);
                    },
                    registerCancel,
                    utils,
                }).then(
                    (v) => {
                        info(`[${currentTranslateServiceInstanceKey}]resolve:` + v);
                        if (translateID[index] !== id) return;
                        setResult(typeof v === 'string' ? v.trim() : v);
                        setIsLoading(false);
                        if (v !== '') {
                            setHideOnce(false);
                        }
                        if (!historyDisable) {
                            addToHistory(
                                sourceText.trim(),
                                detectLanguage,
                                newTargetLanguage,
                                translateServiceName,
                                typeof v === 'string' ? v.trim() : v
                            );
                        }
                        if (index === 0 && !clipboardMonitor) {
                            switch (autoCopy) {
                                case 'target':
                                    writeText(v).then(() => {
                                        if (hideWindow) {
                                            sendNotification({ title: t('common.write_clipboard'), body: v });
                                        }
                                    });
                                    break;
                                case 'source_target':
                                    writeText(sourceText.trim() + '\n\n' + v).then(() => {
                                        if (hideWindow) {
                                            sendNotification({
                                                title: t('common.write_clipboard'),
                                                body: sourceText.trim() + '\n\n' + v,
                                            });
                                        }
                                    });
                                    break;
                                default:
                                    break;
                            }
                        }
                    },
                    (e) => {
                        info(`[${currentTranslateServiceInstanceKey}]reject:` + e);
                        if (translateID[index] !== id) return;
                        setError(e.toString());
                        setIsLoading(false);
                    }
                );
            } else {
                setError('Language not supported');
            }
        } else {
            const LanguageEnum = builtinServices[translateServiceName].Language;
            if (sourceLanguage in LanguageEnum && targetLanguage in LanguageEnum) {
                let newTargetLanguage = targetLanguage;
                if (sourceLanguage === 'auto' && targetLanguage === detectLanguage) {
                    newTargetLanguage = translateSecondLanguage;
                }
                setIsLoading(true);
                setHide(false);
                const instanceConfig = serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                const setHideOnce = invokeOnce(setHide);
                builtinServices[translateServiceName]
                    .translate(sourceText.trim(), LanguageEnum[sourceLanguage], LanguageEnum[newTargetLanguage], {
                        config: instanceConfig,
                        detect: detectLanguage,
                        setResult: (v) => {
                            if (translateID[index] !== id) return;
                            setResult(v);
                            setHideOnce(false);
                        },
                        registerCancel,
                    })
                    .then(
                        (v) => {
                            info(`[${currentTranslateServiceInstanceKey}]resolve:` + v);
                            if (translateID[index] !== id) return;
                            setResult(typeof v === 'string' ? v.trim() : v);
                            setIsLoading(false);
                            if (v !== '') {
                                setHideOnce(false);
                            }
                            if (!historyDisable) {
                                addToHistory(
                                    sourceText.trim(),
                                    detectLanguage,
                                    newTargetLanguage,
                                    translateServiceName,
                                    typeof v === 'string' ? v.trim() : v
                                );
                            }
                            if (index === 0 && !clipboardMonitor) {
                                switch (autoCopy) {
                                    case 'target':
                                        writeText(v).then(() => {
                                            if (hideWindow) {
                                                sendNotification({ title: t('common.write_clipboard'), body: v });
                                            }
                                        });
                                        break;
                                    case 'source_target':
                                        writeText(sourceText.trim() + '\n\n' + v).then(() => {
                                            if (hideWindow) {
                                                sendNotification({
                                                    title: t('common.write_clipboard'),
                                                    body: sourceText.trim() + '\n\n' + v,
                                                });
                                            }
                                        });
                                        break;
                                    default:
                                        break;
                                }
                            }
                        },
                        (e) => {
                            info(`[${currentTranslateServiceInstanceKey}]reject:` + e);
                            if (translateID[index] !== id) return;
                            setError(e.toString());
                            setIsLoading(false);
                        }
                    );
            } else {
                setError('Language not supported');
            }
        }
    };

    // refresh tts config
    useEffect(() => {
        if (ttsServiceList && getServiceSouceType(ttsServiceList[0]) === ServiceSourceType.PLUGIN) {
            readTextFile(`plugins/tts/${getServiceName(ttsServiceList[0])}/info.json`, {
                dir: BaseDirectory.AppConfig,
            }).then((infoStr) => {
                setTtsPluginInfo(JSON.parse(infoStr));
            });
        }
    }, [ttsServiceList]);

    // handle tts speak
    const handleSpeak = () =>
        runSpeechRequest(async () => {
            const instanceKey = ttsServiceList[0];
            if (getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN) {
                const pluginConfig = serviceInstanceConfigMap[instanceKey];
                if (!(targetLanguage in ttsPluginInfo.language)) throw new Error('Language not supported');
                const [func, utils] = await invoke_plugin('tts', getServiceName(instanceKey));
                return func(result, ttsPluginInfo.language[targetLanguage], {
                    config: pluginConfig,
                    utils,
                });
            }

            if (!(targetLanguage in builtinTtsServices[getServiceName(instanceKey)].Language)) {
                throw new Error('Language not supported');
            }
            const instanceConfig = serviceInstanceConfigMap[instanceKey];
            return builtinTtsServices[getServiceName(instanceKey)].tts(
                result,
                builtinTtsServices[getServiceName(instanceKey)].Language[targetLanguage],
                { config: instanceConfig }
            );
        });

    const [boundRef, bounds] = useMeasure({ scroll: true });
    const springs = useSpring({
        from: { height: 0 },
        to: { height: hide ? 0 : bounds.height },
    });

    return (
        <Card
            shadow='none'
            aria-busy={isLoading}
            className='translate-card translate-target-card'
        >
            <CardHeader
                className='translate-target-header flex justify-between'
                {...drag}
            >
                {/* current service instance and available service instance to change */}
                <div className='flex min-w-0 items-center'>
                    <Dropdown>
                        <DropdownTrigger>
                            <Button
                                size='sm'
                                variant='solid'
                                aria-label='选择翻译服务'
                                className='translate-service-button bg-transparent'
                                startContent={
                                    whetherPluginService(currentTranslateServiceInstanceKey) ? (
                                        <img
                                            src={
                                                pluginList['translate'][
                                                    getServiceName(currentTranslateServiceInstanceKey)
                                                ].icon
                                            }
                                            alt=''
                                            aria-hidden='true'
                                            className='h-[20px] my-auto'
                                        />
                                    ) : (
                                        <img
                                            src={
                                                builtinServices[getServiceName(currentTranslateServiceInstanceKey)].info
                                                    .icon
                                            }
                                            alt=''
                                            aria-hidden='true'
                                            className='h-[20px] my-auto'
                                        />
                                    )
                                }
                            >
                                {whetherPluginService(currentTranslateServiceInstanceKey) ? (
                                    <div className='translate-service-name my-auto'>{`${getInstanceName(currentTranslateServiceInstanceKey, () => pluginList['translate'][getServiceName(currentTranslateServiceInstanceKey)].display)} `}</div>
                                ) : (
                                    <div className='translate-service-name my-auto'>
                                        {getInstanceName(currentTranslateServiceInstanceKey, () =>
                                            t(
                                                `services.translate.${getServiceName(currentTranslateServiceInstanceKey)}.title`
                                            )
                                        )}
                                    </div>
                                )}
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label='app language'
                            className='max-h-[40vh] overflow-y-auto'
                            onAction={(key) => {
                                setCurrentTranslateServiceInstanceKey(key);
                            }}
                        >
                            {translateServiceInstanceList.map((instanceKey) => {
                                return (
                                    <DropdownItem
                                        key={instanceKey}
                                        startContent={
                                            whetherPluginService(instanceKey) ? (
                                                <img
                                                    src={pluginList['translate'][getServiceName(instanceKey)].icon}
                                                    alt=''
                                                    aria-hidden='true'
                                                    className='h-[20px] my-auto'
                                                />
                                            ) : (
                                                <img
                                                    src={builtinServices[getServiceName(instanceKey)].info.icon}
                                                    alt=''
                                                    aria-hidden='true'
                                                    className='h-[20px] my-auto'
                                                />
                                            )
                                        }
                                    >
                                        {whetherPluginService(instanceKey) ? (
                                            <div className='my-auto'>{`${getInstanceName(instanceKey, () => pluginList['translate'][getServiceName(instanceKey)].display)} `}</div>
                                        ) : (
                                            <div className='my-auto'>
                                                {getInstanceName(instanceKey, () =>
                                                    t(`services.translate.${getServiceName(instanceKey)}.title`)
                                                )}
                                            </div>
                                        )}
                                    </DropdownItem>
                                );
                            })}
                        </DropdownMenu>
                    </Dropdown>
                    {isLoading && (
                        <div
                            className='translate-status ml-2'
                            aria-live='polite'
                        >
                            <Spinner
                                size='sm'
                                color='primary'
                                aria-label={t('translate.translating')}
                            />
                            <span>{t('translate.translating')}</span>
                        </div>
                    )}
                </div>
                {/* content collapse */}
                <div className='flex items-center gap-1'>
                    {isLoading && (
                        <Tooltip
                            content={t('translate.stop')}
                            delay={450}
                        >
                            <Button
                                size='sm'
                                isIconOnly
                                variant='light'
                                aria-label={t('translate.stop')}
                                className='translate-tool-button'
                                onPress={stopActiveTranslation}
                            >
                                <MdStop className='text-[17px]' />
                            </Button>
                        </Tooltip>
                    )}
                    <Button
                        size='sm'
                        isIconOnly
                        variant='light'
                        aria-label={hide ? t('translate.expand_result') : t('translate.collapse_result')}
                        aria-expanded={!hide}
                        className='translate-tool-button'
                        onPress={() => setHide(!hide)}
                    >
                        {hide ? (
                            <HiChevronDown className='text-[18px]' />
                        ) : (
                            <HiChevronUp className='text-[18px]' />
                        )}
                    </Button>
                </div>
            </CardHeader>
            <animated.div
                className='translate-target-collapse'
                style={{ ...springs }}
            >
                <div ref={boundRef}>
                    {/* result content */}
                    <CardBody
                        className={`translate-result-body ${hide && 'h-0 p-0'}`}
                        aria-live='polite'
                    >
                        {isLoading && result === '' && error === '' ? (
                            <div className='translate-result-skeleton'>
                                <Skeleton className='h-4 w-[92%] rounded-lg' />
                                <Skeleton className='h-4 w-[78%] rounded-lg' />
                                <Skeleton className='h-4 w-[58%] rounded-lg' />
                            </div>
                        ) : typeof result === 'string' ? (
                            <FormattedTranslation
                                value={result}
                                fontSize={appFontSize}
                            />
                        ) : (
                            <div>
                                {result['pronunciations'] &&
                                    result['pronunciations'].map((pronunciation) => {
                                        return (
                                            <div key={nanoid()}>
                                                {pronunciation['region'] && (
                                                    <span
                                                        className='mr-[12px] text-default-500'
                                                        style={{ fontSize: `${appFontSize}px` }}
                                                    >
                                                        {pronunciation['region']}
                                                    </span>
                                                )}
                                                {pronunciation['symbol'] && (
                                                    <span
                                                        className='mr-[12px] text-default-500'
                                                        style={{ fontSize: `${appFontSize}px` }}
                                                    >
                                                        {pronunciation['symbol']}
                                                    </span>
                                                )}
                                                {pronunciation['voice'] && pronunciation['voice'] !== '' && (
                                                    <HiOutlineVolumeUp
                                                         className='inline-block my-auto cursor-pointer'
                                                         style={{ fontSize: `${appFontSize}px` }}
                                                         onClick={() => {
                                                             void speak(pronunciation['voice']).catch((error) => {
                                                                 toast.error(getPublicTtsErrorMessage(error), {
                                                                     style: toastStyle,
                                                                 });
                                                             });
                                                         }}
                                                    />
                                                )}
                                            </div>
                                        );
                                    })}
                                {result['explanations'] &&
                                    result['explanations'].map((explanations) => {
                                        return (
                                            <div key={nanoid()}>
                                                {explanations['explains'] &&
                                                    explanations['explains'].map((explain, index) => {
                                                        return (
                                                            <span key={nanoid()}>
                                                                {index === 0 ? (
                                                                    <>
                                                                        <span
                                                                            className='text-default-500 mr-[12px]'
                                                                            style={{ fontSize: `${appFontSize - 2}px` }}
                                                                        >
                                                                            {explanations['trait']}
                                                                        </span>
                                                                        <span
                                                                            className='font-bold select-text'
                                                                            style={{ fontSize: `${appFontSize}px` }}
                                                                        >
                                                                            {explain}
                                                                        </span>
                                                                        <br />
                                                                    </>
                                                                ) : (
                                                                    <span
                                                                        className='text-default-500 select-text mr-1'
                                                                        style={{ fontSize: `${appFontSize - 2}px` }}
                                                                        key={nanoid()}
                                                                    >
                                                                        {explain}
                                                                    </span>
                                                                )}
                                                            </span>
                                                        );
                                                    })}
                                            </div>
                                        );
                                    })}
                                <br />
                                {result['associations'] &&
                                    result['associations'].map((association) => {
                                        return (
                                            <div key={nanoid()}>
                                                <span
                                                    className='text-default-500'
                                                    style={{ fontSize: `${appFontSize}px` }}
                                                >
                                                    {association}
                                                </span>
                                            </div>
                                        );
                                    })}
                                {result['sentence'] &&
                                    result['sentence'].map((sentence, index) => {
                                        return (
                                            <div key={nanoid()}>
                                                <span
                                                    className='mr-[12px]'
                                                    style={{ fontSize: `${appFontSize - 2}px` }}
                                                >
                                                    {index + 1}.
                                                </span>
                                                <>
                                                    {sentence['source'] && (
                                                        <span
                                                            className='select-text'
                                                            style={{ fontSize: `${appFontSize}px` }}
                                                            dangerouslySetInnerHTML={{
                                                                __html: sentence['source'],
                                                            }}
                                                        />
                                                    )}
                                                </>
                                                <>
                                                    {sentence['target'] && (
                                                        <div
                                                            className='select-text text-default-500'
                                                            style={{ fontSize: `${appFontSize}px` }}
                                                            dangerouslySetInnerHTML={{
                                                                __html: sentence['target'],
                                                            }}
                                                        />
                                                    )}
                                                </>
                                            </div>
                                        );
                                    })}
                            </div>
                        )}
                        {error !== '' && (
                            <div role='alert'>
                                {error.split('\n').map((v) => (
                                    <p
                                        key={v}
                                        className='text-red-500'
                                        style={{ fontSize: `${appFontSize}px` }}
                                    >
                                        {v}
                                    </p>
                                ))}
                            </div>
                        )}
                    </CardBody>
                    <CardFooter
                        className={`translate-card-footer flex ${hide && 'hidden'}`}
                    >
                        <ButtonGroup>
                            {/* speak button */}
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
                                    isDisabled={typeof result !== 'string' || result === ''}
                                    onPress={() => {
                                        handleSpeak().catch((e) => {
                                            toast.error(getPublicTtsErrorMessage(e), { style: toastStyle });
                                        });
                                    }}
                                >
                                    <HiOutlineVolumeUp className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            {/* copy button */}
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
                                    isDisabled={typeof result !== 'string' || result === ''}
                                    onPress={() => {
                                        void writeText(result).then(() => {
                                            toast.success(t('translate.copied'), { style: toastStyle });
                                        });
                                    }}
                                >
                                    <MdContentCopy className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            {/* translate back button */}
                            <Tooltip
                                content={t('translate.translate_back')}
                                delay={450}
                            >
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    aria-label={t('translate.translate_back')}
                                    className='translate-tool-button'
                                    isDisabled={typeof result !== 'string' || result === ''}
                                    onPress={async () => {
                                        // 回译复用当前取消生命周期，避免与仍在流式输出的正向翻译并发。
                                        cancelActiveTranslation();
                                        const id = nanoid();
                                        translateID[index] = id;
                                        const registerBackCancel = (cancel) => {
                                            if (translateID[index] !== id) {
                                                cancel?.();
                                                return;
                                            }
                                            cancelTranslationRef.current = cancel;
                                        };
                                        setError('');
                                        let newTargetLanguage = sourceLanguage;
                                        if (sourceLanguage === 'auto') {
                                            newTargetLanguage = detectLanguage;
                                        }
                                        let newSourceLanguage = targetLanguage;
                                        if (sourceLanguage === 'auto') {
                                            newSourceLanguage = 'auto';
                                        }
                                        if (whetherPluginService(currentTranslateServiceInstanceKey)) {
                                            const pluginInfo =
                                                pluginList['translate'][
                                                    getServiceName(currentTranslateServiceInstanceKey)
                                                ];
                                            if (
                                                newSourceLanguage in pluginInfo.language &&
                                                newTargetLanguage in pluginInfo.language
                                            ) {
                                                setIsLoading(true);
                                                setHide(false);
                                                const instanceConfig =
                                                    serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                                                instanceConfig['enable'] = 'true';
                                                const setHideOnce = invokeOnce(setHide);
                                                let [func, utils] = await invoke_plugin(
                                                    'translate',
                                                    getServiceName(currentTranslateServiceInstanceKey)
                                                );
                                                func(
                                                    result.trim(),
                                                    pluginInfo.language[newSourceLanguage],
                                                    pluginInfo.language[newTargetLanguage],
                                                    {
                                                        config: instanceConfig,
                                                        detect: detectLanguage,
                                                        setResult: (v) => {
                                                            if (translateID[index] !== id) return;
                                                            setResult(v);
                                                            setHideOnce(false);
                                                        },
                                                        registerCancel: registerBackCancel,
                                                        utils,
                                                    }
                                                ).then(
                                                    (v) => {
                                                        if (translateID[index] !== id) return;
                                                        registerBackCancel(null);
                                                        if (v === result) {
                                                            setResult(v + ' ');
                                                        } else {
                                                            setResult(v.trim());
                                                        }
                                                        setIsLoading(false);
                                                        if (v !== '') {
                                                            setHideOnce(false);
                                                        }
                                                    },
                                                    (e) => {
                                                        if (translateID[index] !== id) return;
                                                        registerBackCancel(null);
                                                        setError(e.toString());
                                                        setIsLoading(false);
                                                    }
                                                );
                                            } else {
                                                setError('Language not supported');
                                            }
                                        } else {
                                            const LanguageEnum =
                                                builtinServices[getServiceName(currentTranslateServiceInstanceKey)]
                                                    .Language;
                                            if (
                                                newSourceLanguage in LanguageEnum &&
                                                newTargetLanguage in LanguageEnum
                                            ) {
                                                setIsLoading(true);
                                                setHide(false);
                                                const instanceConfig =
                                                    serviceInstanceConfigMap[currentTranslateServiceInstanceKey];
                                                const setHideOnce = invokeOnce(setHide);
                                                builtinServices[getServiceName(currentTranslateServiceInstanceKey)]
                                                    .translate(
                                                        result.trim(),
                                                        LanguageEnum[newSourceLanguage],
                                                        LanguageEnum[newTargetLanguage],
                                                        {
                                                            config: instanceConfig,
                                                            detect: newSourceLanguage,
                                                            setResult: (v) => {
                                                                if (translateID[index] !== id) return;
                                                                setResult(v);
                                                                setHideOnce(false);
                                                            },
                                                            registerCancel: registerBackCancel,
                                                        }
                                                    )
                                                    .then(
                                                        (v) => {
                                                            if (translateID[index] !== id) return;
                                                            registerBackCancel(null);
                                                            if (v === result) {
                                                                setResult(v + ' ');
                                                            } else {
                                                                setResult(v.trim());
                                                            }
                                                            setIsLoading(false);
                                                            if (v !== '') {
                                                                setHideOnce(false);
                                                            }
                                                        },
                                                        (e) => {
                                                            if (translateID[index] !== id) return;
                                                            registerBackCancel(null);
                                                            setError(e.toString());
                                                            setIsLoading(false);
                                                        }
                                                    );
                                            } else {
                                                setError('Language not supported');
                                            }
                                        }
                                    }}
                                >
                                    <TbTransformFilled className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            {/* error retry button */}
                            <Tooltip
                                content={t('translate.retry')}
                                delay={450}
                            >
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    aria-label={t('translate.retry')}
                                    className={`translate-tool-button ${error === '' && 'hidden'}`}
                                    onPress={() => {
                                        setError('');
                                        setResult('');
                                        translate();
                                    }}
                                >
                                    <GiCycle className='text-[16px]' />
                                </Button>
                            </Tooltip>
                            {/* available collection service instance */}
                            {collectionServiceList &&
                                collectionServiceList.map((collectionServiceInstanceName) => {
                                    return (
                                        <Button
                                            key={collectionServiceInstanceName}
                                            isIconOnly
                                            variant='light'
                                            size='sm'
                                            aria-label='添加到收藏'
                                            className='translate-tool-button'
                                            onPress={async () => {
                                                if (
                                                    getServiceSouceType(collectionServiceInstanceName) ===
                                                    ServiceSourceType.PLUGIN
                                                ) {
                                                    const pluginConfig =
                                                        serviceInstanceConfigMap[collectionServiceInstanceName];
                                                    let [func, utils] = await invoke_plugin(
                                                        'collection',
                                                        getServiceName(collectionServiceInstanceName)
                                                    );
                                                    func(sourceText.trim(), result.toString(), {
                                                        config: pluginConfig,
                                                        utils,
                                                    }).then(
                                                        (_) => {
                                                            toast.success(t('translate.add_collection_success'), {
                                                                style: toastStyle,
                                                            });
                                                        },
                                                        (e) => {
                                                            toast.error(e.toString(), { style: toastStyle });
                                                        }
                                                    );
                                                } else {
                                                    const instanceConfig =
                                                        serviceInstanceConfigMap[collectionServiceInstanceName];
                                                    builtinCollectionServices[
                                                        getServiceName(collectionServiceInstanceName)
                                                    ]
                                                        .collection(sourceText, result, {
                                                            config: instanceConfig,
                                                        })
                                                        .then(
                                                            (_) => {
                                                                toast.success(t('translate.add_collection_success'), {
                                                                    style: toastStyle,
                                                                });
                                                            },
                                                            (e) => {
                                                                toast.error(e.toString(), { style: toastStyle });
                                                            }
                                                        );
                                                }
                                            }}
                                        >
                                            <img
                                                src={
                                                    getServiceSouceType(collectionServiceInstanceName) ===
                                                    ServiceSourceType.PLUGIN
                                                        ? pluginList['collection'][
                                                              getServiceName(collectionServiceInstanceName)
                                                          ].icon
                                                        : builtinCollectionServices[
                                                              getServiceName(collectionServiceInstanceName)
                                                          ].info.icon
                                                }
                                                alt=''
                                                aria-hidden='true'
                                                className='h-[16px] w-[16px]'
                                            />
                                        </Button>
                                    );
                                })}
                        </ButtonGroup>
                    </CardFooter>
                </div>
            </animated.div>
        </Card>
    );
}
