import React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

import remarkLegacyTex from '../../Translate/components/FormattedTranslation/remarkLegacyTex';

const remarkPlugins = [remarkLegacyTex, [remarkMath, { singleDollarTextMath: true }]];
const rehypePlugins = [[rehypeKatex, { strict: 'ignore', throwOnError: false, trust: false }]];

export function isTextResearchDocument(document) {
    return ['markdown', 'text', 'tex'].includes(String(document?.documentType ?? '').toLocaleLowerCase());
}

function PlainText({ value }) {
    return String(value ?? '')
        .split(/\n{2,}/gu)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph, index) => <p key={`${paragraph.slice(0, 32)}-${index}`}>{paragraph}</p>);
}

const markdownComponents = {
    a: ({ children }) => <span className='text-document-page__link'>{children}</span>,
    img: ({ alt }) => <span className='text-document-page__image-alt'>{alt || '图片'}</span>,
};

/**
 * Markdown、DOCX 抽取文本与 TeX 源码共享的单页阅读表面。
 * 外层沿用 PDF 页坐标系，因此划词、高亮、笔记和浮窗无需另一套交互实现。
 */
export default function TextDocumentPage({ document, scale = 1.25, pageRef, children }) {
    const text = String(document?.textContent ?? '');
    const type = String(document?.documentType ?? '').toLocaleLowerCase();
    const visualWidth = Math.round(720 * (scale / 1.25));
    const isMarkdown = type === 'markdown';
    const isTex = type === 'tex';

    return (
        <section
            className={`pdf-page text-document-page text-document-page--${type || 'text'}`}
            data-page-number='1'
            data-page-text={text}
            style={{ width: `${visualWidth}px` }}
            aria-label='第 1 页'
            ref={pageRef}
        >
            <article
                className='text-document-page__content'
                data-pdf-selection-layer='true'
            >
                {document?.importWarning ? (
                    <aside
                        className='text-document-page__warning'
                        role='status'
                    >
                        {document.importWarning}
                    </aside>
                ) : null}
                {isMarkdown ? (
                    <ReactMarkdown
                        components={markdownComponents}
                        rehypePlugins={rehypePlugins}
                        remarkPlugins={remarkPlugins}
                        skipHtml
                    >
                        {text}
                    </ReactMarkdown>
                ) : isTex ? (
                    <pre className='text-document-page__tex'>{text}</pre>
                ) : (
                    <PlainText value={text} />
                )}
            </article>
            {children}
            <span className='pdf-page__number'>1</span>
        </section>
    );
}
