/**
 * Ollama 模型列表的展示元数据与后端返回值归一化工具。
 *
 * 推荐项仅用于设置页说明和排序，不代表已经安装，也不会触发下载。
 */

export const OLLAMA_MODEL_ROLES = Object.freeze({
    translation: '翻译',
    research: '论文分析',
    vision: '视觉理解',
    embedding: '语义检索',
});

const freezeMetadata = (metadata) =>
    Object.freeze({
        ...metadata,
        roles: Object.freeze([...metadata.roles]),
    });

export const RECOMMENDED_OLLAMA_MODELS = Object.freeze([
    freezeMetadata({
        id: 'translategemma:4b',
        label: 'TranslateGemma 4B',
        purpose: '专注中英及多语言翻译，适合作为划词和短段落学术翻译的常驻模型。',
        roles: ['translation'],
        recommendedRole: 'translation',
        packageSize: '约 3.3 GB',
        suitableFor8Gb: true,
        suitability8Gb: 'comfortable',
        suitabilityLabel: '适合 8GB 显存',
    }),
    freezeMetadata({
        id: 'qwen3.5:4b',
        label: 'Qwen3.5 4B',
        purpose: '适合论文概要、术语解释、词典和文档视觉理解，也可作为通用翻译备选。',
        roles: ['research', 'vision', 'translation'],
        recommendedRole: 'research',
        packageSize: '约 3.4 GB',
        suitableFor8Gb: true,
        suitability8Gb: 'comfortable',
        suitabilityLabel: '适合 8GB 显存',
    }),
    freezeMetadata({
        id: 'gemma4:e4b-it-qat',
        label: 'Gemma 4 E4B QAT',
        purpose: '通用多模态论文分析模型，适合深度解释、术语注释和图文理解。',
        roles: ['research', 'vision', 'translation'],
        recommendedRole: 'research',
        packageSize: '约 6.1 GB',
        suitableFor8Gb: true,
        suitability8Gb: 'tight',
        suitabilityLabel: '8GB 可用，建议限制上下文',
    }),
    freezeMetadata({
        id: 'qwen3.5:9b',
        label: 'Qwen3.5 9B',
        purpose: '更偏质量的论文分析和多语言翻译模型，适合按需加载的深度阅读模式。',
        roles: ['research', 'vision', 'translation'],
        recommendedRole: 'research',
        packageSize: '约 6.6 GB',
        suitableFor8Gb: true,
        suitability8Gb: 'tight',
        suitabilityLabel: '8GB 较紧，建议单模型运行',
    }),
]);

const RECOMMENDED_MODEL_INDEX = new Map(
    RECOMMENDED_OLLAMA_MODELS.map((metadata, index) => [metadata.id.toLocaleLowerCase(), { metadata, index }])
);

const MODEL_VARIANT_PATTERNS = [
    ['translategemma:4b', /^translategemma:4b(?:-|$)/u],
    ['qwen3.5:4b', /^qwen3\.5:4b(?:-|$)/u],
    ['gemma4:e4b-it-qat', /^gemma4:e4b-it-qat(?:-|$)/u],
    ['qwen3.5:9b', /^qwen3\.5:9b(?:-|$)/u],
];

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');

function recommendedEntryFor(modelName) {
    const normalizedName = normalizeText(modelName).toLocaleLowerCase();
    if (!normalizedName) return null;

    const exact = RECOMMENDED_MODEL_INDEX.get(normalizedName);
    if (exact) return exact;

    const variant = MODEL_VARIANT_PATTERNS.find(([, pattern]) => pattern.test(normalizedName));
    return variant ? RECOMMENDED_MODEL_INDEX.get(variant[0]) ?? null : null;
}

export function getRecommendedModelMetadata(modelName) {
    return recommendedEntryFor(modelName)?.metadata ?? null;
}

export function inferModelRoles(modelName) {
    const recommended = getRecommendedModelMetadata(modelName);
    if (recommended) return [...recommended.roles];

    const normalizedName = normalizeText(modelName).toLocaleLowerCase();
    if (!normalizedName) return [];
    if (/embed|bge|nomic/u.test(normalizedName)) return ['embedding'];
    if (/vision|\bvl\b|ocr/u.test(normalizedName)) return ['vision'];
    if (/translate|translat/u.test(normalizedName)) return ['translation'];
    return ['research'];
}

export function formatModelSize(size) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
    if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
    if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
    return `${Math.round(bytes)} B`;
}

function normalizeDetails(value) {
    const details = value && typeof value === 'object' ? value : {};
    const families = Array.isArray(details.families) ? details.families.map(normalizeText).filter(Boolean) : [];

    return {
        family: normalizeText(details.family),
        families,
        format: normalizeText(details.format),
        parameterSize: normalizeText(details.parameter_size ?? details.parameterSize),
        quantizationLevel: normalizeText(details.quantization_level ?? details.quantizationLevel),
    };
}

function normalizeSize(value) {
    if (value === null || value === undefined || value === '') return null;
    const size = Number(value);
    return Number.isFinite(size) && size >= 0 ? Math.round(size) : null;
}

/**
 * 兼容 Ollama `/api/tags` 的 `name` 与部分封装返回的 `model` 字段。
 */
export function normalizeInstalledModels(value) {
    if (!Array.isArray(value)) return [];

    const seen = new Set();
    const models = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const name = normalizeText(item.name) || normalizeText(item.model);
        const dedupeKey = name.toLocaleLowerCase();
        if (!name || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const size = normalizeSize(item.size);
        models.push({
            name,
            model: name,
            size,
            sizeLabel: formatModelSize(size),
            details: normalizeDetails(item.details),
            roles: inferModelRoles(name),
            metadata: getRecommendedModelMetadata(name),
            installed: true,
        });
    }

    return models.sort((left, right) => {
        const leftIndex = recommendedEntryFor(left.name)?.index ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = recommendedEntryFor(right.name)?.index ?? Number.MAX_SAFE_INTEGER;
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
}

export function modelRoleLabel(roles) {
    return (Array.isArray(roles) ? roles : [])
        .map((role) => OLLAMA_MODEL_ROLES[role])
        .filter(Boolean)
        .join('、');
}
