import { useMemo, useState } from 'react';
import { PiArrowClockwise, PiCircleNotch, PiWarningCircle } from 'react-icons/pi';

const SOURCE_LABELS = {
    native: 'PDF 原生书签',
    contents: '根据书籍目录页校准',
    text: '根据正文标题识别',
    ocr: '根据 Gemma OCR 识别',
};

function activeOutlineIndex(outline, currentPage) {
    const safePage = Math.max(1, Number(currentPage) || 1);
    let activeIndex = -1;
    for (let index = 0; index < outline.length; index += 1) {
        const item = outline[index];
        const start = Math.max(1, Number(item.pageNumber) || 1);
        const end = Math.max(start, Number(item.endPage) || start);
        if (safePage >= start && safePage <= end) activeIndex = index;
    }
    return activeIndex;
}

function normalizedPageNumbers(value) {
    return (Array.isArray(value) ? value : [])
        .map(Number)
        .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0);
}

function normalizeChapterInsight(insight) {
    if (!insight || typeof insight !== 'object') return null;
    const payload = insight.payload && typeof insight.payload === 'object' ? insight.payload : insight;
    return {
        ...insight,
        ordinal: Number(insight.ordinal),
        title: String(insight.title ?? '').trim(),
        startPage: Number(insight.startPage ?? insight.start_page),
        endPage: Number(insight.endPage ?? insight.end_page),
        status: String(insight.status ?? '').trim(),
        error: String(insight.error ?? '').trim(),
        cached: Boolean(insight.cached),
        summary: String(payload.summary ?? '').trim(),
        terms: (Array.isArray(payload.terms) ? payload.terms : []).map((term) => ({
            term: String(term?.term ?? '').trim(),
            translation: String(term?.translation ?? '').trim(),
            annotation: String(term?.annotation ?? '').trim(),
            pageNumbers: normalizedPageNumbers(term?.pageNumbers ?? term?.page_numbers),
        })),
    };
}

/**
 * 目录重建后同一序号可能指向不同章节，因此缓存必须匹配完整章节身份。
 */
function matchesChapter(insight, item, ordinal) {
    return (
        insight &&
        insight.ordinal === ordinal &&
        insight.title === item.title &&
        insight.startPage === item.pageNumber &&
        insight.endPage === item.endPage
    );
}

function ChapterInsightView({ item, ordinal, insight, state, onJump, onRegenerate }) {
    const stateStatus = String(state?.status ?? '').trim();
    const status = stateStatus || insight?.status || 'not_started';
    const error = String(state?.error ?? insight?.error ?? '').trim();
    const isActive = ['loading', 'queued', 'generating', 'paused'].includes(status);
    const regenerate = () => onRegenerate?.(item, ordinal);

    if (isActive) {
        return (
            <section
                className='chapter-insight chapter-insight--state'
                role='status'
                aria-live='polite'
            >
                <PiCircleNotch
                    className='chapter-insight__spinner'
                    aria-hidden='true'
                />
                <strong>{status === 'paused' ? '章节概要等待模型空闲' : '正在整理本章要点'}</strong>
                <p>仅处理当前章节，完成后永久保存在本地；划词翻译仍保持最高优先级。</p>
            </section>
        );
    }

    if (status === 'needs_ocr') {
        return (
            <section
                className='chapter-insight chapter-insight--state'
                role='status'
                aria-live='polite'
            >
                <PiWarningCircle aria-hidden='true' />
                <strong>本章需要先完成 OCR</strong>
                <p>扫描页没有可用文本层，识别完成后即可按需生成章节概要。</p>
            </section>
        );
    }

    if (status === 'failed' || error) {
        return (
            <section
                className='chapter-insight chapter-insight--state chapter-insight--error'
                role='alert'
                aria-live='assertive'
            >
                <PiWarningCircle aria-hidden='true' />
                <strong>本章概要生成失败</strong>
                <p>{error || '暂时无法整理本章内容。'}</p>
                {onRegenerate ? (
                    <button
                        type='button'
                        onClick={regenerate}
                    >
                        <PiArrowClockwise aria-hidden='true' />
                        重试
                    </button>
                ) : null}
            </section>
        );
    }

    if (status !== 'ready' || !insight?.summary) {
        return (
            <section className='chapter-insight chapter-insight--state'>
                <strong>{item.title}</strong>
                <p>选择章节后按需生成并永久缓存，不会一次处理整本长文档。</p>
                {onRegenerate ? (
                    <button
                        type='button'
                        onClick={regenerate}
                    >
                        生成本章概要
                    </button>
                ) : null}
            </section>
        );
    }

    return (
        <article className='chapter-insight'>
            <header className='chapter-insight__header'>
                <div>
                    <small
                        role='status'
                        aria-live='polite'
                    >
                        {insight.cached ? '已读取本地缓存' : '已生成并保存'}
                    </small>
                    <strong title={item.title}>{item.title}</strong>
                </div>
                {onRegenerate ? (
                    <button
                        type='button'
                        aria-label={`重新生成章节概要：${item.title}`}
                        title='重新生成'
                        onClick={regenerate}
                    >
                        <PiArrowClockwise aria-hidden='true' />
                    </button>
                ) : null}
            </header>
            <section className='chapter-insight__summary'>
                <h3>章节大意</h3>
                <p>{insight.summary}</p>
            </section>
            <section className='chapter-insight__terms'>
                <h3>关键术语</h3>
                {insight.terms.length ? (
                    <dl>
                        {insight.terms.map((term, index) => (
                            <div key={`${term.term}-${index}`}>
                                <dt>
                                    <span>{term.term}</span>
                                    {term.translation ? <em>{term.translation}</em> : null}
                                </dt>
                                {term.annotation ? <dd>{term.annotation}</dd> : null}
                                {term.pageNumbers.length ? (
                                    <dd className='chapter-insight__pages'>
                                        {term.pageNumbers.map((pageNumber) => (
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
                    <p>本章没有确认到可靠的关键术语。</p>
                )}
            </section>
        </article>
    );
}

export default function DocumentOutlinePanel({
    outline = [],
    currentPage = 1,
    onJump,
    chapterInsights = [],
    chapterInsightState,
    onSelectChapter,
    onRegenerateChapter,
}) {
    const [localSelectedIndex, setLocalSelectedIndex] = useState(null);
    const safeOutline = useMemo(
        () =>
            (Array.isArray(outline) ? outline : [])
                .map((item, index) => ({
                    ...item,
                    key: item.id ?? `${item.title}-${item.pageNumber}-${item.level}-${index}`,
                    title: String(item.title ?? '').trim(),
                    pageNumber: Math.max(1, Number(item.pageNumber) || 1),
                    endPage: Math.max(1, Number(item.endPage ?? item.pageNumber) || 1),
                    level: Math.min(8, Math.max(1, Number(item.level) || 1)),
                }))
                .filter((item) => item.title)
                .map((item, index) => ({ ...item, ordinal: index })),
        [outline]
    );
    const safeInsights = useMemo(
        () => (Array.isArray(chapterInsights) ? chapterInsights : []).map(normalizeChapterInsight).filter(Boolean),
        [chapterInsights]
    );
    const activeIndex = activeOutlineIndex(safeOutline, currentPage);
    const sources = [...new Set(safeOutline.map((item) => SOURCE_LABELS[item.source]).filter(Boolean))];
    const stateIndexValue =
        chapterInsightState?.selectedIndex ?? chapterInsightState?.selectedOrdinal ?? chapterInsightState?.ordinal;
    const hasStateIndex = stateIndexValue !== null && stateIndexValue !== undefined && stateIndexValue !== '';
    const stateIndex = hasStateIndex && Number.isInteger(Number(stateIndexValue)) ? Number(stateIndexValue) : null;
    const selectedIndex = stateIndex ?? localSelectedIndex;
    const selectedItem = selectedIndex == null ? null : safeOutline[selectedIndex];
    const selectedInsight = selectedItem
        ? safeInsights.find((insight) => matchesChapter(insight, selectedItem, selectedIndex)) ?? null
        : null;
    const stateInsight = normalizeChapterInsight(
        chapterInsightState?.insight ?? chapterInsightState?.data ?? chapterInsightState
    );
    const currentInsight =
        selectedItem && matchesChapter(stateInsight, selectedItem, selectedIndex) ? stateInsight : selectedInsight;
    const visibleState = stateIndex === selectedIndex ? chapterInsightState : null;

    if (!safeOutline.length) {
        return (
            <section className='document-outline document-outline--empty'>
                <strong>尚未识别到章节目录</strong>
                <p>小允会先读取 PDF 书签；没有书签时再分析正文标题。扫描件需先完成全文 OCR。</p>
            </section>
        );
    }

    return (
        <section className='document-outline'>
            <header className='document-outline__meta'>
                <span>{safeOutline.length} 个章节节点</span>
                <small>{sources.join(' · ') || '本地目录'}</small>
            </header>
            <nav aria-label='文档章节目录'>
                {safeOutline.map((item, index) => {
                    const cached = safeInsights.some(
                        (insight) => insight.status === 'ready' && matchesChapter(insight, item, index)
                    );
                    return (
                        <button
                            type='button'
                            key={item.key}
                            className={index === activeIndex ? 'is-active' : ''}
                            style={{ '--outline-level': item.level }}
                            aria-current={index === activeIndex ? 'location' : undefined}
                            aria-pressed={index === selectedIndex}
                            onClick={() => {
                                setLocalSelectedIndex(index);
                                onJump?.(item.pageNumber);
                                onSelectChapter?.(item, index);
                            }}
                        >
                            <span>{item.title}</span>
                            <span className='document-outline__row-meta'>
                                {cached ? <small>已存</small> : null}
                                <small>P{item.pageNumber}</small>
                            </span>
                        </button>
                    );
                })}
            </nav>
            {selectedItem ? (
                <ChapterInsightView
                    item={selectedItem}
                    ordinal={selectedIndex}
                    insight={currentInsight}
                    state={visibleState}
                    onJump={onJump}
                    onRegenerate={onRegenerateChapter}
                />
            ) : (
                <p className='document-outline__selection-hint'>选择章节后按需生成并永久缓存，不会批量占用 GPU。</p>
            )}
            <p className='document-outline__hint'>章节页码均来自本地验证；无法确认的 AI 推测不会用于跳转。</p>
        </section>
    );
}
