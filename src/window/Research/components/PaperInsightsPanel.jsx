import { useMemo, useState } from 'react';
import {
    PiArrowClockwise,
    PiCheck,
    PiCircleNotch,
    PiFileText,
    PiFlask,
    PiFunction,
    PiLightbulb,
    PiPlus,
    PiWarningCircle,
} from 'react-icons/pi';

import FormattedTranslation from '../../Translate/components/FormattedTranslation';

const ACTIVE_STATUSES = new Set(['loading', 'indexing', 'generating', 'queued', 'paused']);

function asList(value) {
    return Array.isArray(value) ? value.filter((item) => String(item ?? '').trim()) : [];
}

/**
 * 同时兼容后端返回的 `{ payload: {...} }` 与演示环境的平铺对象。
 */
export function normalizePaperInsights(insights) {
    const root = insights && typeof insights === 'object' ? insights : {};
    const payload = root.payload && typeof root.payload === 'object' ? root.payload : root;
    const summary = String(payload.summary ?? '').trim();
    const status = String(root.status ?? (summary ? 'ready' : 'not_started')).trim() || 'not_started';
    return {
        status,
        summary,
        researchQuestion: String(payload.researchQuestion ?? payload.research_question ?? '').trim(),
        contributions: asList(payload.contributions),
        methods: asList(payload.methods),
        findings: asList(payload.findings),
        implications: asList(payload.implications),
        limitations: asList(payload.limitations),
        formulas: asList(payload.formulas).map((formula) => ({
            latex: String(formula?.latex ?? '').trim(),
            explanation: String(formula?.explanation ?? '').trim(),
        })),
        terms: asList(payload.terms).map((term) => ({
            term: String(term?.term ?? '').trim(),
            translation: String(term?.translation ?? '').trim(),
            annotation: String(term?.annotation ?? '').trim(),
            pageNumbers: asList(term?.pageNumbers ?? term?.page_numbers)
                .map(Number)
                .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0),
        })),
        model: String(root.model ?? payload.model ?? '').trim(),
        cached: Boolean(root.cached),
        error: String(root.error ?? '').trim(),
    };
}

function AcademicMarkup({ value, fontSize = 14 }) {
    if (!String(value ?? '').trim()) return null;
    return (
        <FormattedTranslation
            value={value}
            fontSize={fontSize}
        />
    );
}

function InsightList({ title, icon, items }) {
    if (!items.length) return null;
    return (
        <section className='paper-insights__section'>
            <h3>
                {icon}
                {title}
            </h3>
            <ul>
                {items.map((item, index) => (
                    <li key={`${title}-${index}-${item.slice(0, 20)}`}>
                        <AcademicMarkup value={item} />
                    </li>
                ))}
            </ul>
        </section>
    );
}

export default function PaperInsightsPanel({
    insights,
    error = '',
    onJump,
    onRegenerate,
    glossaryEntries = [],
    onAddTerm,
}) {
    const data = useMemo(() => normalizePaperInsights(insights), [insights]);
    const [regenerating, setRegenerating] = useState(false);
    const [actionError, setActionError] = useState('');
    const [savingTerm, setSavingTerm] = useState('');
    const isActive = ACTIVE_STATUSES.has(data.status) || regenerating;
    const visibleError = actionError || error || data.error;
    const savedTerms = useMemo(
        () =>
            new Set(
                glossaryEntries.map((entry) =>
                    String(entry?.term ?? '')
                        .trim()
                        .toLocaleLowerCase()
                )
            ),
        [glossaryEntries]
    );

    const addTerm = async (item) => {
        if (!onAddTerm || !item?.term || savingTerm) return;
        setSavingTerm(item.term);
        setActionError('');
        try {
            await onAddTerm(item);
        } catch (nextError) {
            setActionError(String(nextError?.message ?? nextError));
        } finally {
            setSavingTerm('');
        }
    };

    const regenerate = async () => {
        if (!onRegenerate || regenerating) return;
        setRegenerating(true);
        setActionError('');
        try {
            await onRegenerate();
        } catch (nextError) {
            setActionError(String(nextError?.message ?? nextError));
        } finally {
            setRegenerating(false);
        }
    };

    if (isActive) {
        const queued = data.status === 'queued' || data.status === 'paused';
        const generating = data.status === 'generating' || regenerating;
        return (
            <section
                className='paper-insights paper-insights--state'
                aria-live='polite'
            >
                <PiCircleNotch
                    className='paper-insights__spinner'
                    aria-hidden='true'
                />
                <strong>
                    {generating ? '正在后台整理论文要点' : queued ? '已加入概要生成队列' : '正在提取论文全文'}
                </strong>
                <p>
                    {generating
                        ? '完成后会保存到本地；之后打开论文将直接读取，不再重复生成。'
                        : queued
                          ? '划词翻译优先使用模型；空闲后会自动继续，不需要手动重试。'
                          : '全文准备完成后会自动生成概要与关键术语，你可以继续阅读。'}
                </p>
            </section>
        );
    }

    if (data.status !== 'ready' || !data.summary) {
        const needsOcr = data.status === 'needs_ocr';
        const failed = data.status === 'failed' || Boolean(visibleError);
        return (
            <section className='paper-insights paper-insights--state'>
                {failed || needsOcr ? <PiWarningCircle aria-hidden='true' /> : <PiFileText aria-hidden='true' />}
                <strong>{needsOcr ? '需要先识别扫描页' : failed ? '概要生成失败' : '等待生成论文概要'}</strong>
                <p>
                    {visibleError ||
                        (needsOcr
                            ? '这篇 PDF 没有可用文本层，完成全文 OCR 后即可生成。'
                            : '导入完成后，小允会在后台整理全文概要、研究要点与关键术语。')}
                </p>
                {onRegenerate && !needsOcr ? (
                    <button
                        className='paper-insights__retry'
                        type='button'
                        onClick={regenerate}
                    >
                        <PiArrowClockwise aria-hidden='true' />
                        {failed ? '重试' : '立即生成'}
                    </button>
                ) : null}
            </section>
        );
    }

    return (
        <article className='paper-insights'>
            <header className='paper-insights__meta'>
                <span>{data.cached ? '已读取本地概要' : '已根据全文生成'}</span>
                {onRegenerate ? (
                    <button
                        type='button'
                        aria-label='重新生成论文概要'
                        title='重新生成'
                        onClick={regenerate}
                    >
                        <PiArrowClockwise aria-hidden='true' />
                    </button>
                ) : null}
            </header>
            <section className='paper-insights__section paper-insights__section--summary'>
                <h2>全文概要</h2>
                <AcademicMarkup value={data.summary} />
            </section>
            {data.researchQuestion ? (
                <section className='paper-insights__question'>
                    <PiLightbulb aria-hidden='true' />
                    <div>
                        <strong>研究问题</strong>
                        <AcademicMarkup value={data.researchQuestion} />
                    </div>
                </section>
            ) : null}
            <InsightList
                title='核心贡献'
                icon={<PiLightbulb aria-hidden='true' />}
                items={data.contributions}
            />
            <InsightList
                title='研究方法'
                icon={<PiFlask aria-hidden='true' />}
                items={data.methods}
            />
            <InsightList
                title='主要发现'
                icon={<PiLightbulb aria-hidden='true' />}
                items={data.findings}
            />
            <InsightList
                title='研究意义'
                icon={<PiLightbulb aria-hidden='true' />}
                items={data.implications}
            />
            <InsightList
                title='研究局限'
                icon={<PiWarningCircle aria-hidden='true' />}
                items={data.limitations}
            />
            {data.formulas.length ? (
                <section className='paper-insights__section paper-insights__formulas'>
                    <h3>
                        <PiFunction aria-hidden='true' />
                        核心公式
                    </h3>
                    <div className='paper-insights__formula-list'>
                        {data.formulas.map((formula, index) => (
                            <article key={`${formula.latex}-${index}`}>
                                <AcademicMarkup
                                    value={formula.latex}
                                    fontSize={15}
                                />
                                <AcademicMarkup value={formula.explanation} />
                            </article>
                        ))}
                    </div>
                </section>
            ) : null}
            <section className='paper-insights__section paper-insights__terms'>
                <h3>关键术语</h3>
                {data.terms.length ? (
                    <dl>
                        {data.terms.map((item, index) => (
                            <div key={`${item.term}-${index}`}>
                                <dt>
                                    <span>
                                        {item.term}
                                        {item.translation ? <em>{item.translation}</em> : null}
                                    </span>
                                    {onAddTerm ? (
                                        <button
                                            type='button'
                                            className='paper-insights__save-term'
                                            aria-label={
                                                savedTerms.has(item.term.toLocaleLowerCase())
                                                    ? `已收录术语：${item.term}`
                                                    : `加入词库：${item.term}`
                                            }
                                            disabled={
                                                savedTerms.has(item.term.toLocaleLowerCase()) || Boolean(savingTerm)
                                            }
                                            onClick={() => addTerm(item)}
                                        >
                                            {savedTerms.has(item.term.toLocaleLowerCase()) ? (
                                                <PiCheck aria-hidden='true' />
                                            ) : savingTerm === item.term ? (
                                                <PiCircleNotch
                                                    className='paper-insights__spinner'
                                                    aria-hidden='true'
                                                />
                                            ) : (
                                                <PiPlus aria-hidden='true' />
                                            )}
                                        </button>
                                    ) : null}
                                </dt>
                                {item.annotation ? (
                                    <dd>
                                        <AcademicMarkup value={item.annotation} />
                                    </dd>
                                ) : null}
                                {item.pageNumbers.length ? (
                                    <dd className='paper-insights__pages'>
                                        {item.pageNumbers.map((pageNumber) => (
                                            <button
                                                type='button'
                                                key={pageNumber}
                                                aria-label={`跳转到第 ${pageNumber} 页`}
                                                onClick={() => onJump?.(pageNumber)}
                                            >
                                                P{pageNumber}
                                            </button>
                                        ))}
                                    </dd>
                                ) : null}
                            </div>
                        ))}
                    </dl>
                ) : (
                    <p className='sidebar-empty'>未从原文中确认到可靠的关键术语。</p>
                )}
            </section>
            {data.model ? <footer className='paper-insights__model'>生成模型：{data.model}</footer> : null}
        </article>
    );
}
