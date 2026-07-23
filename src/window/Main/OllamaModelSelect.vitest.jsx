import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import OllamaModelSelect from './OllamaModelSelect';

afterEach(cleanup);

const INSTALLED_MODELS = [
    { name: 'translategemma:4b', size: 3_300_000_000, details: { parameter_size: '4B' } },
    { model: 'qwen3.5:4b', size: 3_400_000_000, details: { quantization_level: 'Q4_K_M' } },
];

describe('Ollama 模型选择器', () => {
    it('只列出已安装模型，并显示所选模型的推荐说明', () => {
        render(
            <OllamaModelSelect
                value='qwen3.5:4b'
                installedModels={INSTALLED_MODELS}
                modelRole='research'
                ariaLabel='论文分析模型'
            />
        );

        const select = screen.getByRole('combobox', { name: '论文分析模型' });
        expect(select.options).toHaveLength(2);
        expect(select.value).toBe('qwen3.5:4b');
        expect(select.options[0].textContent).toContain('推荐');
        expect(screen.getByText('已安装').className).toContain('is-installed');
        expect(screen.getByText(/论文概要、术语解释/)).not.toBeNull();
        expect(screen.getByText('适合 8GB 显存')).not.toBeNull();
    });

    it('当前配置未安装时仍保留选项并明确提示', () => {
        render(
            <OllamaModelSelect
                value='gemma4:e4b-it-qat'
                installedModels={INSTALLED_MODELS}
                ariaLabel='深度阅读模型'
            />
        );

        const select = screen.getByRole('combobox', { name: '深度阅读模型' });
        expect(select.value).toBe('gemma4:e4b-it-qat');
        expect(select.options[0].textContent).toContain('未安装');
        expect(screen.getByText('未安装').className).toContain('is-missing');
        expect(screen.getByText('8GB 可用，建议限制上下文')).not.toBeNull();
    });

    it('选择已安装模型时仅向上游返回模型名', () => {
        const onChange = vi.fn();
        render(
            <OllamaModelSelect
                value='translategemma:4b'
                installedModels={INSTALLED_MODELS}
                onChange={onChange}
                ariaLabel='翻译模型'
            />
        );

        fireEvent.change(screen.getByRole('combobox', { name: '翻译模型' }), {
            target: { value: 'qwen3.5:4b' },
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith('qwen3.5:4b');
    });

    it('当前值大小写不一致时仍选中后端返回的真实标签', () => {
        render(
            <OllamaModelSelect
                value='QWEN3.5:4B'
                installedModels={INSTALLED_MODELS}
                ariaLabel='大小写兼容模型'
            />
        );

        expect(screen.getByRole('combobox', { name: '大小写兼容模型' }).value).toBe('qwen3.5:4b');
        expect(screen.getByText('已安装')).not.toBeNull();
    });

    it('没有已安装模型和当前值时显示空状态', () => {
        render(<OllamaModelSelect ariaLabel='空模型列表' />);

        expect(screen.getByRole('combobox', { name: '空模型列表' }).textContent).toContain('未检测到已安装模型');
        expect(screen.getByText('请先在 Ollama 中安装模型，再从列表中选择。')).not.toBeNull();
    });
});
