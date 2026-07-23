import { Button, Card, CardBody, Input, Link, Select, SelectItem, Switch } from '@nextui-org/react';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import React, { useState } from 'react';

import { useConfig } from '../../../hooks/useConfig';
import { useToastStyle } from '../../../hooks';
import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { DEFAULT_OLLAMA_OCR_HOST, DEFAULT_OLLAMA_OCR_MODE, DEFAULT_OLLAMA_OCR_MODEL } from './core';
import { checkOllamaOcrModel } from './client';

export function Config(props) {
    const { instanceKey, updateServiceList, onClose } = props;
    const { t } = useTranslation();
    const [config, setConfig] = useConfig(
        instanceKey,
        {
            [INSTANCE_NAME_CONFIG_KEY]: t('services.recognize.ollama_ocr.title'),
            requestPath: DEFAULT_OLLAMA_OCR_HOST,
            model: DEFAULT_OLLAMA_OCR_MODEL,
            mode: DEFAULT_OLLAMA_OCR_MODE,
            fallbackToSystem: true,
        },
        { sync: false }
    );
    const [isLoading, setIsLoading] = useState(false);
    const toastStyle = useToastStyle();

    return (
        config !== null && (
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    setIsLoading(true);
                    checkOllamaOcrModel(config).then(
                        () => {
                            setIsLoading(false);
                            setConfig(config, true);
                            updateServiceList(instanceKey);
                            onClose();
                        },
                        (error) => {
                            setIsLoading(false);
                            toast.error(t('config.service.test_failed') + error.toString(), { style: toastStyle });
                        }
                    );
                }}
            >
                <Toaster />
                <div className='config-item'>
                    <Input
                        label={t('services.instance_name')}
                        labelPlacement='outside-left'
                        value={config[INSTANCE_NAME_CONFIG_KEY]}
                        variant='bordered'
                        classNames={{
                            base: 'justify-between',
                            label: 'text-[length:--nextui-font-size-medium]',
                            mainWrapper: 'max-w-[50%]',
                        }}
                        onValueChange={(value) => {
                            setConfig({ ...config, [INSTANCE_NAME_CONFIG_KEY]: value });
                        }}
                    />
                </div>
                <div className='config-item'>
                    <Input
                        label={t('services.recognize.ollama_ocr.request_path')}
                        labelPlacement='outside-left'
                        value={config.requestPath}
                        variant='bordered'
                        classNames={{
                            base: 'justify-between',
                            label: 'text-[length:--nextui-font-size-medium]',
                            mainWrapper: 'max-w-[50%]',
                        }}
                        onValueChange={(value) => {
                            setConfig({ ...config, requestPath: value });
                        }}
                    />
                </div>
                <div className='config-item'>
                    <Input
                        label={t('services.recognize.ollama_ocr.model')}
                        labelPlacement='outside-left'
                        value={config.model}
                        variant='bordered'
                        classNames={{
                            base: 'justify-between',
                            label: 'text-[length:--nextui-font-size-medium]',
                            mainWrapper: 'max-w-[50%]',
                        }}
                        onValueChange={(value) => {
                            setConfig({ ...config, model: value });
                        }}
                    />
                </div>
                <div className='config-item'>
                    <Select
                        label={t('services.recognize.ollama_ocr.mode')}
                        labelPlacement='outside-left'
                        selectedKeys={[config.mode ?? DEFAULT_OLLAMA_OCR_MODE]}
                        variant='bordered'
                        classNames={{
                            base: 'justify-between',
                            label: 'text-[length:--nextui-font-size-medium]',
                            mainWrapper: 'max-w-[50%]',
                        }}
                        onSelectionChange={(keys) => {
                            const [mode] = Array.from(keys);
                            if (mode) setConfig({ ...config, mode });
                        }}
                    >
                        <SelectItem key='auto'>{t('services.recognize.ollama_ocr.mode_auto')}</SelectItem>
                        <SelectItem key='formula'>{t('services.recognize.ollama_ocr.mode_formula')}</SelectItem>
                        <SelectItem key='table'>{t('services.recognize.ollama_ocr.mode_table')}</SelectItem>
                    </Select>
                </div>
                <div className='config-item'>
                    <Switch
                        isSelected={config.fallbackToSystem}
                        onValueChange={(value) => {
                            setConfig({ ...config, fallbackToSystem: value });
                        }}
                        classNames={{
                            base: 'flex flex-row-reverse justify-between w-full max-w-full',
                        }}
                    >
                        {t('services.recognize.ollama_ocr.fallback_to_system')}
                    </Switch>
                </div>
                <Card
                    shadow='sm'
                    className='border-none bg-content2'
                >
                    <CardBody className='text-small gap-1'>
                        <span>{t('services.recognize.ollama_ocr.model_hint')}</span>
                        <code>ollama pull gemma4:e4b-it-qat</code>
                        <Link
                            isExternal
                            href='https://ollama.com/library/gemma4'
                            color='primary'
                        >
                            {t('services.recognize.ollama_ocr.model_link')}
                        </Link>
                    </CardBody>
                </Card>
                <br />
                <Button
                    type='submit'
                    isLoading={isLoading}
                    color='primary'
                    fullWidth
                >
                    {t('common.save')}
                </Button>
            </form>
        )
    );
}
