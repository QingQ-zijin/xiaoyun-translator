import { useEffect, useRef } from 'react';
import { PiArticle, PiBookOpenText, PiCaretRight, PiX } from 'react-icons/pi';

import './ImportKindDialog.css';

const IMPORT_OPTIONS = Object.freeze([
    {
        kind: 'paper',
        title: '论文',
        description: '按单篇研究整理概要、术语与引用。',
        Icon: PiArticle,
    },
    {
        kind: 'book',
        title: '书籍',
        description: '建立独立章节目录，按章组织摘要与关键术语。',
        Icon: PiBookOpenText,
    },
]);

export default function ImportKindDialog({ open, importing = false, pendingFileCount = 0, onSelect, onClose }) {
    const firstOptionRef = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        const focusFrame = requestAnimationFrame(() => firstOptionRef.current?.focus());
        const handleKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            onClose?.();
        };
        globalThis.addEventListener('keydown', handleKeyDown);
        return () => {
            cancelAnimationFrame(focusFrame);
            globalThis.removeEventListener('keydown', handleKeyDown);
        };
    }, [onClose, open]);

    if (!open) return null;

    return (
        <div
            className='import-kind-backdrop'
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) onClose?.();
            }}
        >
            <section
                className='import-kind-dialog'
                role='dialog'
                aria-modal='true'
                aria-labelledby='import-kind-dialog-title'
            >
                <header>
                    <div>
                        <span>{pendingFileCount > 0 ? `已选择 ${pendingFileCount} 个文件` : '导入到文献库'}</span>
                        <h2 id='import-kind-dialog-title'>这次导入什么？</h2>
                    </div>
                    <button
                        className='import-kind-dialog__close'
                        type='button'
                        aria-label='关闭导入类型选择'
                        onClick={onClose}
                    >
                        <PiX aria-hidden='true' />
                    </button>
                </header>
                <div className='import-kind-dialog__options'>
                    {IMPORT_OPTIONS.map(({ kind, title, description, Icon }, index) => (
                        <button
                            ref={index === 0 ? firstOptionRef : undefined}
                            key={kind}
                            type='button'
                            disabled={importing}
                            onClick={() => onSelect?.(kind)}
                        >
                            <span className='import-kind-dialog__icon'>
                                <Icon aria-hidden='true' />
                            </span>
                            <span>
                                <strong>{title}</strong>
                                <small>{description}</small>
                            </span>
                            <PiCaretRight aria-hidden='true' />
                        </button>
                    ))}
                </div>
                <p>支持 PDF、Markdown、DOCX 与 TeX；类型可帮助小允选择合适的目录和概要流程。</p>
            </section>
        </div>
    );
}
