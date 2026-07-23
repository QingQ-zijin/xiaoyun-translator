export function isEditableUndoTarget(target) {
    const element = target?.nodeType === globalThis.Node?.TEXT_NODE ? target.parentElement : target;
    return Boolean(
        element?.isContentEditable ||
            element?.closest?.(
                'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
            )
    );
}

export function shouldHandleAnnotationUndo(event) {
    return Boolean(
        event &&
            !event.defaultPrevented &&
            !event.isComposing &&
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            !event.shiftKey &&
            String(event.key).toLocaleLowerCase() === 'z' &&
            !isEditableUndoTarget(event.target)
    );
}

export function isCurrentAnnotationSave({ sourcePaperId, sourceEpoch, currentPaperId, currentEpoch }) {
    return Boolean(
        sourcePaperId &&
            sourcePaperId === currentPaperId &&
            Number.isInteger(sourceEpoch) &&
            sourceEpoch === currentEpoch
    );
}

const cloneAnnotation = (annotation) =>
    annotation
        ? {
              ...annotation,
              tags: Array.isArray(annotation.tags) ? [...annotation.tags] : annotation.tags,
              rects: Array.isArray(annotation.rects) ? annotation.rects.map((rect) => ({ ...rect })) : annotation.rects,
          }
        : null;

export function createAnnotationUndoAction(type, { before = null, after = null } = {}) {
    if (type === 'create' && after?.id) return { type, after: cloneAnnotation(after) };
    if (type === 'delete' && before?.id) return { type, before: cloneAnnotation(before) };
    if (type === 'update' && before?.id && after?.id && before.id === after.id) {
        return { type, before: cloneAnnotation(before), after: cloneAnnotation(after) };
    }
    return null;
}

export function appendAnnotationUndoAction(stack, action, limit = 100) {
    if (!action) return Array.isArray(stack) ? stack : [];
    const safeStack = Array.isArray(stack) ? stack : [];
    return [...safeStack.slice(-Math.max(0, limit - 1)), action];
}

export function annotationUndoOperation(action) {
    if (action?.type === 'create' && action.after?.id) {
        return { type: 'delete', annotationId: action.after.id };
    }
    if (action?.type === 'delete' && action.before?.id) {
        return { type: 'save', annotation: cloneAnnotation(action.before) };
    }
    if (action?.type === 'update' && action.before?.id) {
        return { type: 'save', annotation: cloneAnnotation(action.before) };
    }
    return null;
}

export function applyAnnotationUndo(items, action, restoredAnnotation = null) {
    const current = Array.isArray(items) ? items : [];
    if (action?.type === 'create' && action.after?.id) {
        return current.filter((item) => item.id !== action.after.id);
    }
    if (action?.type === 'delete' && action.before?.id) {
        const restored = restoredAnnotation ?? action.before;
        return [restored, ...current.filter((item) => item.id !== restored.id)];
    }
    if (action?.type === 'update' && action.before?.id) {
        const restored = restoredAnnotation ?? action.before;
        const exists = current.some((item) => item.id === restored.id);
        return exists ? current.map((item) => (item.id === restored.id ? restored : item)) : [restored, ...current];
    }
    return current;
}
