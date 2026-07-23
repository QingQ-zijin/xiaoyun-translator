export const ANNOTATION_COLORS = Object.freeze([
    { value: 'violet', label: '紫色' },
    { value: 'amber', label: '琥珀色' },
    { value: 'blue', label: '蓝色' },
    { value: 'green', label: '绿色' },
    { value: 'rose', label: '玫红色' },
]);

export function AnnotationColorPicker({ value = 'violet', onSelect, ariaLabel = '选择高亮颜色', purpose = '高亮' }) {
    return (
        <div
            className='annotation-color-picker'
            role='group'
            aria-label={ariaLabel}
        >
            {ANNOTATION_COLORS.map((color) => (
                <button
                    type='button'
                    className={`annotation-color is-${color.value} ${value === color.value ? 'is-active' : ''}`}
                    key={color.value}
                    title={color.label}
                    aria-label={`${color.label}${purpose}`}
                    aria-pressed={value === color.value}
                    onClick={() => onSelect?.(color.value)}
                />
            ))}
        </div>
    );
}
