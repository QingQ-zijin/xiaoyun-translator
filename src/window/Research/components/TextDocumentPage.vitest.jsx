import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import TextDocumentPage, { isTextResearchDocument } from './TextDocumentPage';

afterEach(cleanup);

describe('文本论文阅读页', () => {
    it('渲染 Markdown 粗体与 LaTeX，而不是暴露语法', () => {
        const { container } = render(
            <TextDocumentPage
                document={{
                    documentType: 'markdown',
                    textContent: '# 结论\n\n**代谢通量**满足 $v_{in}=v_{out}$。',
                }}
            />
        );
        expect(screen.getByRole('heading', { name: '结论' })).toBeTruthy();
        expect(screen.getByText('代谢通量').tagName).toBe('STRONG');
        expect(container.querySelector('.katex')).toBeTruthy();
        expect(container.textContent).not.toContain('**');
    });

    it('DOCX 抽取正文按段落展示，TeX 失败时明确显示源码和警告', () => {
        const { rerender, container } = render(
            <TextDocumentPage document={{ documentType: 'text', textContent: '第一段\n\n第二段' }} />
        );
        expect(container.querySelectorAll('.text-document-page__content p')).toHaveLength(2);

        rerender(
            <TextDocumentPage
                document={{
                    documentType: 'tex',
                    textContent: '\\section{Methods}',
                    importWarning: 'XeLaTeX 编译失败，已按源码打开',
                }}
            />
        );
        expect(screen.getByRole('status').textContent).toContain('编译失败');
        expect(container.querySelector('pre')?.textContent).toContain('\\section');
    });

    it('只把文本类文档识别为内建文本阅读模式', () => {
        expect(isTextResearchDocument({ documentType: 'markdown' })).toBe(true);
        expect(isTextResearchDocument({ documentType: 'text' })).toBe(true);
        expect(isTextResearchDocument({ documentType: 'tex' })).toBe(true);
        expect(isTextResearchDocument({ documentType: 'pdf' })).toBe(false);
    });
});
