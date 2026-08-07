import { PiArrowClockwise, PiFilePdf, PiPause, PiPlay, PiTranslate, PiX } from 'react-icons/pi';

import { LANGUAGE_OPTIONS } from '../../../domains/translation/language';
import { documentTranslationProgress } from '../documentTranslation';
import './DocumentTranslationDialog.css';

export default function DocumentTranslationDialog({
    open,
    paper,
    task,
    targetLanguage,
    includeOriginal,
    onTargetLanguageChange,
    onIncludeOriginalChange,
    onStart,
    onPause,
    onReset,
    onExport,
    onClose,
}) {
    if (!open || !paper) return null;
    const progress = documentTranslationProgress(task?.totalPages, task?.completedPages);
    const running = task?.status === 'translating' || task?.status === 'preparing';
    const exportReady = progress.total > 0 && progress.completed === progress.total && !running;
    const canStart = !running && task?.status !== 'exporting';

    return (
        <div
            className='document-translation-backdrop'
            role='presentation'
            onPointerDown={(event) => event.target === event.currentTarget && onClose?.()}
        >
            <section
                className='document-translation-dialog'
                role='dialog'
                aria-modal='true'
                aria-label='全文翻译'
            >
                <header>
                    <div className='document-translation-dialog__title'>
                        <span aria-hidden='true'>
                            <PiTranslate />
                        </span>
                        <div>
                            <strong>全文翻译</strong>
                            <small>{paper.title}</small>
                        </div>
                    </div>
                    <button
                        type='button'
                        aria-label='关闭全文翻译'
                        onClick={onClose}
                    >
                        <PiX />
                    </button>
                </header>

                <div className='document-translation-dialog__body'>
                    <div className='document-translation-dialog__options'>
                        <label>
                            <span>目标语言</span>
                            <select
                                value={targetLanguage}
                                disabled={running}
                                onChange={(event) => onTargetLanguageChange?.(event.target.value)}
                            >
                                {LANGUAGE_OPTIONS.filter((language) => language.value !== 'auto').map((language) => (
                                    <option
                                        key={language.value}
                                        value={language.value}
                                    >
                                        {language.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <fieldset>
                            <legend>导出格式</legend>
                            <label>
                                <input
                                    type='radio'
                                    name='document-translation-mode'
                                    aria-label='双语 PDF'
                                    checked={includeOriginal}
                                    onChange={() => onIncludeOriginalChange?.(true)}
                                />
                                <span>
                                    <strong>双语 PDF</strong>
                                    <small>保留完整原 PDF，在末尾附逐页译文</small>
                                </span>
                            </label>
                            <label>
                                <input
                                    type='radio'
                                    name='document-translation-mode'
                                    aria-label='仅译文 PDF'
                                    checked={!includeOriginal}
                                    onChange={() => onIncludeOriginalChange?.(false)}
                                />
                                <span>
                                    <strong>仅译文 PDF</strong>
                                    <small>体积更小，按原页码输出完整译文</small>
                                </span>
                            </label>
                        </fieldset>
                    </div>

                    <section className='document-translation-progress'>
                        <div>
                            <strong>
                                {task?.status === 'preparing'
                                    ? '正在读取全文…'
                                    : task?.status === 'translating'
                                      ? `正在翻译第 ${task.currentPage || 1} 页`
                                      : task?.status === 'exporting'
                                        ? '正在生成 PDF…'
                                        : exportReady
                                          ? '全文翻译已完成'
                                          : task?.status === 'paused'
                                            ? '已暂停，可随时继续'
                                            : '按页翻译，完成一页保存一页'}
                            </strong>
                            <span>
                                {progress.completed} / {progress.total || paper.pageCount || 1} 页
                            </span>
                        </div>
                        <progress
                            max={Math.max(1, progress.total)}
                            value={progress.completed}
                            aria-label='全文翻译进度'
                        />
                        <p>
                            {task?.statusMessage ||
                                '使用当前论文概要与术语表消歧；已保存页面会直接复用，不会重复调用模型。'}
                        </p>
                        {task?.partialText ? (
                            <blockquote aria-label='当前页流式译文'>{task.partialText.slice(-600)}</blockquote>
                        ) : null}
                        {task?.error ? <div className='document-translation-dialog__error'>{task.error}</div> : null}
                    </section>
                </div>

                <footer>
                    <div>
                        {progress.completed > 0 && !running ? (
                            <button
                                className='document-translation-dialog__secondary'
                                type='button'
                                onClick={onReset}
                            >
                                <PiArrowClockwise />
                                重新翻译
                            </button>
                        ) : null}
                    </div>
                    <div>
                        {running ? (
                            <button
                                className='document-translation-dialog__secondary'
                                type='button'
                                onClick={onPause}
                            >
                                <PiPause />
                                暂停
                            </button>
                        ) : !exportReady ? (
                            <button
                                className='document-translation-dialog__secondary'
                                type='button'
                                disabled={!canStart || exportReady}
                                onClick={onStart}
                            >
                                <PiPlay />
                                {progress.completed > 0 ? '继续翻译' : '开始翻译'}
                            </button>
                        ) : null}
                        <button
                            className='document-translation-dialog__primary'
                            type='button'
                            disabled={!exportReady || task?.status === 'exporting'}
                            onClick={onExport}
                        >
                            <PiFilePdf />
                            {task?.status === 'exporting' ? '生成中' : '导出完整 PDF'}
                        </button>
                    </div>
                </footer>
            </section>
        </div>
    );
}
