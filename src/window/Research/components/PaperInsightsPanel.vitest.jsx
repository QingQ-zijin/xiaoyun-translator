import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PaperInsightsPanel, { normalizePaperInsights } from './PaperInsightsPanel';

afterEach(cleanup);

const payload = {
    summary: '本文研究热力学约束如何改善代谢通量分析。',
    researchQuestion: '如何识别热力学不可行通路？',
    methods: ['构建热力学约束模型'],
    findings: ['能够排除不可行的反应通路'],
    limitations: ['参数依赖实验测量'],
    terms: [
        {
            term: 'metabolic flux',
            translation: '代谢通量',
            annotation: '单位时间内通过代谢反应的物质量。',
            pageNumbers: [2, 5],
        },
    ],
};

describe('论文概要面板', () => {
    it('兼容后端 payload 嵌套结构并可跳转术语页码', () => {
        const onJump = vi.fn();
        render(
            <PaperInsightsPanel
                insights={{ status: 'ready', payload, model: 'gemma4:e4b-it-qat' }}
                onJump={onJump}
            />
        );

        expect(screen.getByText(payload.summary)).toBeTruthy();
        expect(screen.getByText('代谢通量')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '跳转到第 5 页' }));
        expect(onJump).toHaveBeenCalledWith(5);
    });

    it('兼容演示环境的平铺结构', () => {
        const normalized = normalizePaperInsights({ status: 'ready', ...payload });
        expect(normalized.summary).toBe(payload.summary);
        expect(normalized.terms[0].pageNumbers).toEqual([2, 5]);
    });

    it('展示生成与失败状态，且失败后可重试', async () => {
        const { rerender } = render(<PaperInsightsPanel insights={{ status: 'generating' }} />);
        expect(screen.getByText('正在后台整理论文要点')).toBeTruthy();

        const onRegenerate = vi.fn().mockResolvedValue(undefined);
        rerender(
            <PaperInsightsPanel
                insights={{ status: 'failed', error: '本地模型暂时不可用' }}
                onRegenerate={onRegenerate}
            />
        );
        expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '重试' }));
        await waitFor(() => expect(onRegenerate).toHaveBeenCalledOnce());
    });
});
