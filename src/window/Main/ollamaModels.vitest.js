import { describe, expect, it } from 'vitest';

import {
    formatModelSize,
    getRecommendedModelMetadata,
    inferModelRoles,
    normalizeInstalledModels,
} from './ollamaModels';

describe('Ollama 模型元数据', () => {
    it('兼容 name/model 字段并归一化详情、大小与重复项', () => {
        const models = normalizeInstalledModels([
            {
                name: ' qwen3.5:4b ',
                size: 3_400_000_000,
                details: {
                    family: 'qwen3.5',
                    families: ['qwen3.5', 'clip'],
                    parameter_size: '4.0B',
                    quantization_level: 'Q4_K_M',
                },
            },
            { name: '', model: 'embeddinggemma:latest', size: '620000000', details: { parameterSize: '300M' } },
            { name: 'QWEN3.5:4B', size: 1 },
            null,
            { name: '   ' },
        ]);

        expect(models).toHaveLength(2);
        expect(models[0]).toMatchObject({
            name: 'qwen3.5:4b',
            model: 'qwen3.5:4b',
            size: 3_400_000_000,
            sizeLabel: '3.4 GB',
            installed: true,
            roles: ['research', 'vision', 'translation'],
        });
        expect(models[0].details).toEqual({
            family: 'qwen3.5',
            families: ['qwen3.5', 'clip'],
            format: '',
            parameterSize: '4.0B',
            quantizationLevel: 'Q4_K_M',
        });
        expect(models[1].roles).toEqual(['embedding']);
    });

    it('将官方量化变体映射到对应推荐说明', () => {
        expect(getRecommendedModelMetadata('qwen3.5:9b-q4_K_M')?.id).toBe('qwen3.5:9b');
        expect(getRecommendedModelMetadata('translategemma:4b-it-q8_0')?.recommendedRole).toBe('translation');
        expect(getRecommendedModelMetadata('custom:latest')).toBeNull();
    });

    it('为未收录模型推断保守用途，并格式化后端字节数', () => {
        expect(inferModelRoles('qwen3-vl:4b')).toEqual(['vision']);
        expect(inferModelRoles('custom-research:latest')).toEqual(['research']);
        expect(formatModelSize(620_000_000)).toBe('620 MB');
        expect(formatModelSize('invalid')).toBe('');
    });
});
