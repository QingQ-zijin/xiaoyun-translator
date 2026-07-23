import React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

import { normalizeTranslationForDisplay } from './normalize';
import remarkLegacyTex from './remarkLegacyTex';

const remarkPlugins = [remarkLegacyTex, [remarkMath, { singleDollarTextMath: true }]];
const rehypePlugins = [[rehypeKatex, { strict: 'ignore', throwOnError: false, trust: false }]];

const markdownComponents = {
    a: ({ children }) => <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
};

function FormattedTranslation({ value, fontSize = 16 }) {
    return (
        <div
            className='translate-result-content w-full min-w-0 select-text whitespace-pre-wrap break-words [&_p]:my-0 [&_p+p]:mt-3 [&_strong]:font-semibold [&_strong]:text-foreground [&_h1]:mt-3 [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_blockquote]:my-2 [&_blockquote]:border-l-[3px] [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_code]:rounded [&_code]:bg-default-100 [&_code]:px-1 [&_.katex-display]:my-2 [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden'
            style={{ fontSize: `${fontSize}px` }}
        >
            <ReactMarkdown
                components={markdownComponents}
                rehypePlugins={rehypePlugins}
                remarkPlugins={remarkPlugins}
                skipHtml
            >
                {normalizeTranslationForDisplay(value)}
            </ReactMarkdown>
        </div>
    );
}

export default React.memo(FormattedTranslation);
