import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SelectionTranslationPopover from './SelectionTranslationPopover';

const anchorRect = { left: 300, top: 180, right: 420, bottom: 202 };

afterEach(cleanup);

describe('论文划词翻译浮窗', () => {
    it('流式阶段立即展示 Markdown 与 LaTeX，并保留忙碌状态', () => {
        render(
            <SelectionTranslationPopover
                anchorRect={anchorRect}
                value={'**关键结论**：$v_i$\n\n$$\\frac{dE}{dt}=k_{restore}(1-E)-k_{leak}ME$$'}
                sourceText='source'
                loading
            />
        );

        const dialog = screen.getByRole('dialog', { name: '划词翻译' });
        expect(dialog.getAttribute('aria-busy')).toBe('true');
        expect(dialog.querySelector('.translate-result-content strong')?.textContent).toBe('关键结论');
        expect(dialog.querySelector('.katex')).not.toBeNull();
        expect(dialog.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
        expect(dialog.querySelector('.selection-translation-popover__streaming-dot')).not.toBeNull();
    });

    it('支持语言、复制、朗读、高亮、笔记、解释和关闭操作', async () => {
        const handlers = {
            onTargetLanguageChange: vi.fn(),
            onCopy: vi.fn(),
            onSpeak: vi.fn(),
            onHighlight: vi.fn(),
            onSaveExcerpt: vi.fn(),
            onOpenNote: vi.fn(),
            onExplain: vi.fn(),
            onClose: vi.fn(),
        };
        render(
            <SelectionTranslationPopover
                anchorRect={anchorRect}
                value='译文'
                sourceText='source'
                {...handlers}
            />
        );

        fireEvent.change(screen.getByRole('combobox', { name: '目标语言' }), { target: { value: 'en' } });
        fireEvent.click(screen.getByRole('button', { name: '复制' }));
        fireEvent.click(screen.getByRole('button', { name: '朗读' }));
        fireEvent.click(screen.getByRole('button', { name: '高亮' }));
        expect(screen.getByRole('group', { name: '选择高亮颜色' }).querySelectorAll('button')).toHaveLength(5);
        fireEvent.click(screen.getByRole('button', { name: '蓝色高亮' }));
        fireEvent.click(screen.getByRole('button', { name: '摘抄' }));
        fireEvent.click(screen.getByRole('button', { name: '笔记' }));
        fireEvent.click(screen.getByRole('button', { name: '解释' }));
        fireEvent.keyDown(window, { key: 'Escape' });

        expect(handlers.onTargetLanguageChange).toHaveBeenCalledWith('en');
        expect(handlers.onCopy).toHaveBeenCalledWith('译文');
        expect(handlers.onSpeak).toHaveBeenCalledWith('译文');
        expect(handlers.onHighlight).toHaveBeenCalledOnce();
        expect(handlers.onHighlight).toHaveBeenCalledWith({ kind: 'highlight', color: 'blue' });
        expect(handlers.onSaveExcerpt).toHaveBeenCalledWith({ kind: 'excerpt', lexicon: null });
        expect(handlers.onOpenNote).toHaveBeenCalledOnce();
        expect(handlers.onExplain).toHaveBeenCalledOnce();
        expect(handlers.onClose).toHaveBeenCalledOnce();
        expect(await screen.findByText('已复制')).not.toBeNull();
    });

    it('点击浮窗外立即关闭，浮窗内部操作不会误触关闭', () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <SelectionTranslationPopover
                anchorRect={anchorRect}
                value='译文'
                sourceText='source'
                onClose={onClose}
            />
        );

        fireEvent.pointerDown(screen.getByRole('dialog', { name: '划词翻译' }));
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.pointerDown(document.body);
        expect(onClose).toHaveBeenCalledOnce();

        rerender(
            <SelectionTranslationPopover
                open={false}
                anchorRect={anchorRect}
                onClose={onClose}
            />
        );
        fireEvent.pointerDown(document.body);
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('短词或词组展示音标、多词性义项、语境义和领域注释，并可摘抄词条', () => {
        const onSaveExcerpt = vi.fn();
        const entry = {
            term: 'flux',
            phonetics: [
                { region: 'UK', ipa: '/flʌks/' },
                { region: 'US', ipa: '/flʌks/' },
            ],
            senses: [
                { partOfSpeech: 'noun', definitions: ['通量', '流量'] },
                { partOfSpeech: 'verb', definitions: ['持续变化'] },
            ],
            contextMeaning: '在本文中指代谢通量。',
            domainNote: '代谢工程中常与 flux balance analysis 连用。',
            model: 'gemma4:e4b-it-qat',
        };

        render(
            <SelectionTranslationPopover
                anchorRect={anchorRect}
                value='通量'
                sourceText='flux'
                selectionKind='vocabulary'
                lexiconState={{ loading: false, entry, error: '' }}
                onSaveExcerpt={onSaveExcerpt}
            />
        );

        expect(screen.getByText('词汇解析')).not.toBeNull();
        expect(screen.getByText('UK /flʌks/')).not.toBeNull();
        expect(screen.getByText('US /flʌks/')).not.toBeNull();
        expect(screen.getByText('noun')).not.toBeNull();
        expect(screen.getByText('verb')).not.toBeNull();
        expect(screen.getByText('在本文中指代谢通量。')).not.toBeNull();
        expect(screen.getByText(/代谢工程中常与/)).not.toBeNull();

        fireEvent.click(screen.getByRole('button', { name: '摘词' }));
        expect(onSaveExcerpt).toHaveBeenCalledWith({ kind: 'vocabulary', lexicon: entry });
    });

    it('错误优先于空状态显示', () => {
        render(
            <SelectionTranslationPopover
                anchorRect={anchorRect}
                error='无法连接本地 Ollama'
            />
        );

        expect(screen.getByRole('alert').textContent).toBe('无法连接本地 Ollama');
        expect(screen.queryByText('暂无译文。')).toBeNull();
    });

    it('失败后可在原浮窗直接重试', () => {
        const onRetry = vi.fn();
        render(
            <SelectionTranslationPopover
                anchorRect={anchorRect}
                error='论文划词翻译等待超过 20 秒，已取消。请重试。'
                onRetry={onRetry}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: '重试' }));
        expect(onRetry).toHaveBeenCalledOnce();
        expect(screen.getByRole('alert').textContent).toContain('已取消');
    });

    it('固定后新选区不会让浮窗跳位，取消固定后恢复自动避让', async () => {
        const boundaryRect = { left: 0, top: 0, right: 1000, bottom: 740 };
        const { rerender } = render(
            <SelectionTranslationPopover
                anchorRect={anchorRect}
                selectionRect={{ left: 260, top: 140, right: 460, bottom: 210 }}
                boundaryRect={boundaryRect}
                sourceText='first selection'
                value='第一段译文'
            />
        );

        const dialog = screen.getByRole('dialog', { name: '划词翻译' });
        await waitFor(() => expect(dialog.style.left).not.toBe(''));
        const initialPosition = { left: dialog.style.left, top: dialog.style.top };
        fireEvent.click(screen.getByRole('button', { name: '固定翻译窗' }));
        expect(screen.getByRole('button', { name: '取消固定翻译窗' }).getAttribute('aria-pressed')).toBe('true');

        rerender(
            <SelectionTranslationPopover
                anchorRect={{ left: 650, top: 680, right: 730, bottom: 704 }}
                selectionRect={{ left: 520, top: 630, right: 760, bottom: 710 }}
                boundaryRect={boundaryRect}
                sourceText='second selection'
                value='第二段译文'
            />
        );

        await waitFor(() => {
            expect(dialog.style.left).toBe(initialPosition.left);
            expect(dialog.style.top).toBe(initialPosition.top);
        });

        fireEvent.click(screen.getByRole('button', { name: '取消固定翻译窗' }));
        await waitFor(() => expect(dialog.style.top).not.toBe(initialPosition.top));
        expect(screen.getByRole('button', { name: '固定翻译窗' }).getAttribute('aria-pressed')).toBe('false');
    });

    it('拖动标题栏时把浮窗限制在阅读工作区内', async () => {
        render(
            <SelectionTranslationPopover
                anchorRect={anchorRect}
                selectionRect={{ left: 260, top: 140, right: 460, bottom: 210 }}
                boundaryRect={{ left: 200, top: 100, right: 900, bottom: 700 }}
                sourceText='source'
                value='译文'
            />
        );

        const dialog = screen.getByRole('dialog', { name: '划词翻译' });
        await waitFor(() => expect(dialog.style.left).not.toBe(''));
        const header = dialog.querySelector('.selection-translation-popover__header');
        const left = Number.parseFloat(dialog.style.left);
        const top = Number.parseFloat(dialog.style.top);
        fireEvent.pointerDown(header, {
            button: 0,
            pointerId: 7,
            clientX: left + 20,
            clientY: top + 12,
        });
        fireEvent.pointerMove(window, { pointerId: 7, clientX: -100, clientY: 900 });

        await waitFor(() => {
            expect(dialog.style.left).toBe('212px');
            expect(dialog.style.top).toBe('268px');
        });
        expect(dialog.classList.contains('is-dragging')).toBe(true);
        fireEvent.pointerUp(window, { pointerId: 7, clientX: -100, clientY: 900 });
        await waitFor(() => expect(dialog.classList.contains('is-dragging')).toBe(false));
    });
});
