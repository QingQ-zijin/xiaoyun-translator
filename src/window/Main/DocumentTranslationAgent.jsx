import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    PiArrowClockwise,
    PiCheckCircle,
    PiCloudArrowUp,
    PiFileDoc,
    PiFilePdf,
    PiFolderOpen,
    PiImages,
    PiPause,
    PiPlay,
    PiSpinnerGap,
    PiTranslate,
    PiWarningCircle,
} from 'react-icons/pi';

import {
    chooseDocumentTranslationPath,
    getDocument,
    importPapers,
    subscribeToDocumentDrops,
} from '../../domains/research/bridge';
import { LANGUAGE_OPTIONS } from '../../domains/translation/language';
import { documentTranslationProgress } from '../Research/documentTranslation';
import { useDocumentTranslationTask } from '../Research/hooks/useDocumentTranslationTask';

const SUPPORTED_DOCUMENT = /\.(?:pdf|md|markdown|docx|tex)$/iu;

function formatName(document) {
    return document?.paper?.title || document?.sourcePath?.split(/[\\/]/u).at(-1) || '待翻译文档';
}

function formatKind(document) {
    const format = String(document?.sourceFormat ?? document?.documentType ?? 'pdf').toLocaleUpperCase();
    return format === 'MARKDOWN' ? 'MD' : format;
}

export default function DocumentTranslationAgent({ modelName, desktop = true }) {
    const [document, setDocument] = useState(null);
    const [importing, setImporting] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [notice, setNotice] = useState('');
    const [importError, setImportError] = useState('');
    const translation = useDocumentTranslationTask({
        document,
        paperInsights: null,
        translationModel: modelName,
        onNotice: setNotice,
    });
    const progress = documentTranslationProgress(translation.task.totalPages, translation.task.completedPages);
    const running = ['preparing', 'translating', 'exporting'].includes(translation.task.status);
    const exportReady = progress.total > 0 && progress.completed === progress.total && !running;

    const importPaths = useCallback(async (paths) => {
        const path = (Array.isArray(paths) ? paths : [paths])
            .map(String)
            .find((candidate) => SUPPORTED_DOCUMENT.test(candidate));
        if (!path) return;
        setImporting(true);
        setImportError('');
        setNotice('正在复制文件并建立可恢复任务…');
        try {
            const [paper] = await importPapers([path], 'paper');
            if (!paper?.id) throw new Error('文件导入后没有返回任务标识');
            const importedDocument = await getDocument(paper.id);
            setDocument(importedDocument);
            setNotice('文件已就绪。开始后会按页翻译，并在每页完成时保存进度。');
        } catch (reason) {
            setImportError(String(reason?.message ?? reason));
            setNotice('');
        } finally {
            setImporting(false);
        }
    }, []);

    const chooseFile = useCallback(async () => {
        const path = await chooseDocumentTranslationPath();
        if (path) await importPaths([path]);
    }, [importPaths]);

    useEffect(() => {
        if (!desktop) return undefined;
        let dispose = () => {};
        void subscribeToDocumentDrops((paths) => void importPaths(paths)).then((unlisten) => {
            dispose = unlisten;
        });
        return () => dispose();
    }, [desktop, importPaths]);

    useEffect(() => {
        if (document?.paper) translation.show();
        // show 只在文档身份变化时同步任务，不能把 task 本身放进依赖造成重复打开。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [document?.paper?.id]);

    const stage = useMemo(() => {
        if (translation.task.status === 'exporting') return 3;
        if (translation.task.status === 'translating' || exportReady || progress.completed > 0) return 2;
        return document ? 1 : 0;
    }, [document, exportReady, progress.completed, translation.task.status]);

    if (!document) {
        return (
            <section className='document-agent document-agent--empty'>
                <div
                    className={`document-agent__dropzone ${dragging ? 'is-dragging' : ''}`}
                    onDragEnter={(event) => {
                        event.preventDefault();
                        setDragging(true);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false);
                    }}
                    onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        const paths = [...(event.dataTransfer?.files ?? [])].map((file) => file.path).filter(Boolean);
                        if (paths.length) void importPaths(paths);
                    }}
                >
                    <span
                        className='document-agent__drop-icon'
                        aria-hidden='true'
                    >
                        {importing ? <PiSpinnerGap className='is-spinning' /> : <PiCloudArrowUp />}
                    </span>
                    <div>
                        <span className='document-agent__eyebrow'>DOCUMENT TRANSLATION AGENT</span>
                        <h2>{importing ? '正在准备文档' : '拖入整篇文件，得到完整译文 PDF'}</h2>
                        <p>支持 PDF、DOCX、Markdown 与 TeX。数字版直接读取文字，扫描页自动交给 Gemma 视觉识别。</p>
                    </div>
                    <button
                        className='main-primary-button'
                        type='button'
                        disabled={importing}
                        onClick={chooseFile}
                    >
                        <PiFolderOpen aria-hidden='true' />
                        选择文件
                    </button>
                    <small>文件会安全复制到本地文献库，以便暂停、重启和断点续译。</small>
                </div>
                <ol
                    className='document-agent__stages'
                    aria-label='文档翻译流程'
                >
                    <li className='is-active'>
                        <span>01</span>
                        <strong>解析</strong>
                        <small>文字层与扫描页</small>
                    </li>
                    <li>
                        <span>02</span>
                        <strong>翻译</strong>
                        <small>按页流式保存</small>
                    </li>
                    <li>
                        <span>03</span>
                        <strong>导出</strong>
                        <small>原版保真 PDF</small>
                    </li>
                </ol>
                {importError ? <p className='document-agent__error'>{importError}</p> : null}
            </section>
        );
    }

    return (
        <section
            className='document-agent document-agent--active'
            onDragOver={(event) => event.preventDefault()}
        >
            <header className='document-agent__filebar'>
                <span
                    className='document-agent__fileicon'
                    aria-hidden='true'
                >
                    {document.documentType === 'pdf' ? <PiFilePdf /> : <PiFileDoc />}
                </span>
                <div>
                    <strong title={formatName(document)}>{formatName(document)}</strong>
                    <span>
                        {formatKind(document)} · {document.pageCount || translation.task.totalPages || 1} 页
                    </span>
                </div>
                <button
                    type='button'
                    disabled={running}
                    onClick={chooseFile}
                >
                    <PiFolderOpen aria-hidden='true' />
                    更换文件
                </button>
            </header>

            <div className='document-agent__body'>
                <section className='document-agent__run'>
                    <div className='document-agent__run-heading'>
                        <div>
                            <span className='document-agent__eyebrow'>LOCAL DOCUMENT AGENT</span>
                            <h2>{exportReady ? '完整译文已经生成' : '逐页理解、翻译并保存'}</h2>
                        </div>
                        <span className={`document-agent__state is-${translation.task.status || 'idle'}`}>
                            {running ? (
                                <PiSpinnerGap className='is-spinning' />
                            ) : exportReady ? (
                                <PiCheckCircle />
                            ) : (
                                <PiTranslate />
                            )}
                            {translation.task.status === 'preparing'
                                ? '解析与识别'
                                : translation.task.status === 'translating'
                                  ? '正在翻译'
                                  : translation.task.status === 'exporting'
                                    ? '正在导出'
                                    : exportReady
                                      ? '可以导出'
                                      : '等待开始'}
                        </span>
                    </div>
                    <div className='document-agent__progress'>
                        <div>
                            <strong>
                                {progress.completed} / {progress.total || document.pageCount || 1} 页
                            </strong>
                            <span>
                                {translation.task.statusMessage || notice || '每完成一页就会写入本地，不怕中断。'}
                            </span>
                        </div>
                        <progress
                            max={Math.max(1, progress.total || document.pageCount || 1)}
                            value={progress.completed}
                        />
                    </div>
                    <div className={`document-agent__stream ${translation.task.partialText ? '' : 'is-empty'}`}>
                        {translation.task.partialText ? (
                            <p>{translation.task.partialText.slice(-1_200)}</p>
                        ) : (
                            <div>
                                <PiImages aria-hidden='true' />
                                <strong>图片、图表和原页面保持不变</strong>
                                <span>译文作为逐页附录加入同一个 PDF，原文链接与页面对象不会被重绘。</span>
                            </div>
                        )}
                    </div>
                    {translation.task.error || importError ? (
                        <p className='document-agent__error'>
                            <PiWarningCircle aria-hidden='true' />
                            {translation.task.error || importError}
                        </p>
                    ) : null}
                </section>

                <aside className='document-agent__options'>
                    <div>
                        <span className='document-agent__eyebrow'>OUTPUT</span>
                        <h3>译文设置</h3>
                    </div>
                    <label className='document-agent__select'>
                        <span>目标语言</span>
                        <select
                            value={translation.targetLanguage}
                            disabled={running}
                            onChange={(event) => translation.setTargetLanguage(event.target.value)}
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
                    <fieldset className='document-agent__format'>
                        <legend>PDF 形式</legend>
                        <label className={translation.includeOriginal ? 'is-selected' : ''}>
                            <input
                                type='radio'
                                name='document-agent-output'
                                checked={translation.includeOriginal}
                                disabled={running}
                                onChange={() => translation.setIncludeOriginal(true)}
                            />
                            <span>
                                <strong>原版保真 + 译文</strong>
                                <small>推荐 · 原页面、图片、链接全部保留</small>
                            </span>
                        </label>
                        <label className={!translation.includeOriginal ? 'is-selected' : ''}>
                            <input
                                type='radio'
                                name='document-agent-output'
                                checked={!translation.includeOriginal}
                                disabled={running}
                                onChange={() => translation.setIncludeOriginal(false)}
                            />
                            <span>
                                <strong>仅译文 PDF</strong>
                                <small>更轻量，按原始页码排列</small>
                            </span>
                        </label>
                    </fieldset>
                    <ol className='document-agent__mini-stages'>
                        {['读取全文', '逐页翻译', '生成 PDF'].map((label, index) => (
                            <li
                                key={label}
                                className={stage > index ? 'is-complete' : stage === index ? 'is-active' : ''}
                            >
                                <span>{stage > index ? <PiCheckCircle /> : index + 1}</span>
                                {label}
                            </li>
                        ))}
                    </ol>
                </aside>
            </div>

            <footer className='document-agent__actions'>
                <div>
                    {progress.completed > 0 && !running ? (
                        <button
                            type='button'
                            className='document-agent__secondary'
                            onClick={translation.reset}
                        >
                            <PiArrowClockwise aria-hidden='true' />
                            重新翻译
                        </button>
                    ) : null}
                </div>
                <div>
                    {running && translation.task.status !== 'exporting' ? (
                        <button
                            type='button'
                            className='document-agent__secondary'
                            onClick={translation.pause}
                        >
                            <PiPause aria-hidden='true' />
                            暂停并保存
                        </button>
                    ) : !exportReady ? (
                        <button
                            type='button'
                            className='main-primary-button'
                            onClick={translation.start}
                        >
                            <PiPlay aria-hidden='true' />
                            {progress.completed ? '继续翻译' : '开始完整翻译'}
                        </button>
                    ) : null}
                    <button
                        type='button'
                        className='main-primary-button'
                        disabled={!exportReady || translation.task.status === 'exporting'}
                        onClick={translation.exportPdf}
                    >
                        <PiFilePdf aria-hidden='true' />
                        {translation.task.status === 'exporting' ? '正在生成' : '导出完整 PDF'}
                    </button>
                </div>
            </footer>
        </section>
    );
}
