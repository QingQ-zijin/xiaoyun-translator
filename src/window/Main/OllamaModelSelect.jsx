import { useId, useMemo } from 'react';

import { getRecommendedModelMetadata, inferModelRoles, modelRoleLabel, normalizeInstalledModels } from './ollamaModels';

const EMPTY_MODELS = Object.freeze([]);

function optionLabel(model, modelRole) {
    const metadata = model.metadata;
    const recommended = metadata?.recommendedRole === modelRole ? ' · 推荐' : '';
    const size = model.sizeLabel ? ` · ${model.sizeLabel}` : '';
    return `${metadata?.label ?? model.name}${recommended}${size}`;
}

/**
 * 仅选择本机已安装模型；当前配置缺失时保留原值并明确标记为未安装。
 */
export default function OllamaModelSelect({
    value = '',
    onChange,
    installedModels = EMPTY_MODELS,
    modelRole = 'research',
    ariaLabel = '选择 Ollama 模型',
    id,
    disabled = false,
    className = '',
}) {
    const generatedId = useId();
    const controlId = id || `ollama-model-${generatedId.replaceAll(':', '')}`;
    const descriptionId = `${controlId}-description`;
    const normalizedValue = String(value ?? '').trim();
    const models = useMemo(() => normalizeInstalledModels(installedModels), [installedModels]);
    const displayedModels = useMemo(
        () =>
            [...models].sort((left, right) => {
                const leftRecommended = left.metadata?.recommendedRole === modelRole ? 1 : 0;
                const rightRecommended = right.metadata?.recommendedRole === modelRole ? 1 : 0;
                return rightRecommended - leftRecommended;
            }),
        [modelRole, models]
    );
    const installedModel = models.find(
        (model) => model.name.toLocaleLowerCase() === normalizedValue.toLocaleLowerCase()
    );
    const metadata = installedModel?.metadata ?? getRecommendedModelMetadata(normalizedValue);
    const roles = installedModel?.roles ?? inferModelRoles(normalizedValue);
    const isInstalled = Boolean(installedModel);
    const selectValue = installedModel?.name ?? normalizedValue;
    const rootClassName = ['ollama-model-select', className].filter(Boolean).join(' ');

    return (
        <div className={rootClassName}>
            <label
                className='visually-hidden'
                htmlFor={controlId}
            >
                {ariaLabel}
            </label>
            <select
                id={controlId}
                aria-describedby={descriptionId}
                value={selectValue}
                disabled={disabled}
                onChange={(event) => onChange?.(event.target.value)}
            >
                {!normalizedValue ? (
                    <option value=''>{models.length === 0 ? '未检测到已安装模型' : '请选择已安装模型'}</option>
                ) : null}
                {normalizedValue && !isInstalled ? (
                    <option value={normalizedValue}>{metadata?.label ?? normalizedValue}（未安装）</option>
                ) : null}
                {displayedModels.map((model) => (
                    <option
                        key={model.name.toLocaleLowerCase()}
                        value={model.name}
                    >
                        {optionLabel(model, modelRole)}
                    </option>
                ))}
            </select>

            <div
                className='ollama-model-select__description'
                id={descriptionId}
                aria-live='polite'
            >
                {normalizedValue ? (
                    <>
                        <div className='ollama-model-select__heading'>
                            <strong>{metadata?.label ?? normalizedValue}</strong>
                            <span
                                className={`ollama-model-select__status ${isInstalled ? 'is-installed' : 'is-missing'}`}
                            >
                                {isInstalled ? '已安装' : '未安装'}
                            </span>
                        </div>
                        <p>
                            {metadata?.purpose ??
                                (isInstalled ? '本机已安装的 Ollama 模型。' : '当前配置引用此模型，但本机尚未安装。')}
                        </p>
                        <dl className='ollama-model-select__facts'>
                            <div>
                                <dt>用途</dt>
                                <dd>{modelRoleLabel(roles) || '通用'}</dd>
                            </div>
                            {metadata?.packageSize ? (
                                <div>
                                    <dt>模型大小</dt>
                                    <dd>{installedModel?.sizeLabel || metadata.packageSize}</dd>
                                </div>
                            ) : null}
                            {metadata?.suitabilityLabel ? (
                                <div>
                                    <dt>显存建议</dt>
                                    <dd>{metadata.suitabilityLabel}</dd>
                                </div>
                            ) : null}
                        </dl>
                    </>
                ) : (
                    <p>请先在 Ollama 中安装模型，再从列表中选择。</p>
                )}
            </div>
        </div>
    );
}
