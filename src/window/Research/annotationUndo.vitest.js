import { describe, expect, it } from 'vitest';

import {
    annotationUndoOperation,
    appendAnnotationUndoAction,
    applyAnnotationUndo,
    createAnnotationUndoAction,
    isCurrentAnnotationSave,
    isEditableUndoTarget,
    shouldHandleAnnotationUndo,
} from './annotationUndo';

describe('论文批注撤销快捷键', () => {
    it('在阅读区接管 Ctrl+Z 和 Command+Z，但不接管重做组合键', () => {
        const target = document.createElement('div');
        expect(shouldHandleAnnotationUndo({ key: 'z', ctrlKey: true, target })).toBe(true);
        expect(shouldHandleAnnotationUndo({ key: 'Z', metaKey: true, target })).toBe(true);
        expect(shouldHandleAnnotationUndo({ key: 'z', ctrlKey: true, shiftKey: true, target })).toBe(false);
        expect(shouldHandleAnnotationUndo({ key: 'z', ctrlKey: true, altKey: true, target })).toBe(false);
    });

    it('输入框和可编辑区域保留系统自己的撤销', () => {
        const input = document.createElement('input');
        const textarea = document.createElement('textarea');
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        const child = document.createElement('span');
        editor.append(child);

        [input, textarea, child].forEach((target) => {
            expect(isEditableUndoTarget(target)).toBe(true);
            expect(shouldHandleAnnotationUndo({ key: 'z', ctrlKey: true, target })).toBe(false);
        });
    });

    it('保存期间切换论文或重新进入阅读会话时，迟到结果不得进入当前撤销栈', () => {
        expect(
            isCurrentAnnotationSave({
                sourcePaperId: 'paper-a',
                sourceEpoch: 4,
                currentPaperId: 'paper-a',
                currentEpoch: 4,
            })
        ).toBe(true);
        expect(
            isCurrentAnnotationSave({
                sourcePaperId: 'paper-a',
                sourceEpoch: 4,
                currentPaperId: 'paper-b',
                currentEpoch: 5,
            })
        ).toBe(false);
        expect(
            isCurrentAnnotationSave({
                sourcePaperId: 'paper-a',
                sourceEpoch: 4,
                currentPaperId: 'paper-a',
                currentEpoch: 6,
            })
        ).toBe(false);
    });

    it('为新建、删除和更新生成可持久化的反向操作', () => {
        const before = { id: 'annotation-1', paperId: 'paper-a', note: '旧笔记', tags: ['旧'] };
        const after = { ...before, note: '新笔记', tags: ['新'] };
        const created = createAnnotationUndoAction('create', { after });
        const deleted = createAnnotationUndoAction('delete', { before });
        const updated = createAnnotationUndoAction('update', { before, after });

        expect(annotationUndoOperation(created)).toEqual({ type: 'delete', annotationId: 'annotation-1' });
        expect(annotationUndoOperation(deleted)).toEqual({ type: 'save', annotation: before });
        expect(annotationUndoOperation(updated)).toEqual({ type: 'save', annotation: before });

        after.tags.push('稍后修改');
        expect(updated.after.tags).toEqual(['新']);
    });

    it('删除后撤销会恢复完整批注，更新后撤销会恢复旧版本', () => {
        const before = { id: 'annotation-1', paperId: 'paper-a', note: '旧笔记' };
        const after = { ...before, note: '新笔记' };
        const sibling = { id: 'annotation-2', paperId: 'paper-a', note: '其他笔记' };
        const deleteAction = createAnnotationUndoAction('delete', { before });
        const updateAction = createAnnotationUndoAction('update', { before, after });

        expect(applyAnnotationUndo([sibling], deleteAction)).toEqual([before, sibling]);
        expect(applyAnnotationUndo([after, sibling], updateAction)).toEqual([before, sibling]);
        expect(applyAnnotationUndo([after, sibling], createAnnotationUndoAction('create', { after }))).toEqual([
            sibling,
        ]);
    });

    it('撤销栈遵循容量限制且忽略无效动作', () => {
        const first = createAnnotationUndoAction('create', { after: { id: 'first' } });
        const second = createAnnotationUndoAction('create', { after: { id: 'second' } });
        const third = createAnnotationUndoAction('create', { after: { id: 'third' } });
        expect(appendAnnotationUndoAction([first, second], third, 2)).toEqual([second, third]);
        expect(appendAnnotationUndoAction([first], null, 2)).toEqual([first]);
    });
});
