import { PiBooks, PiGear, PiSparkle, PiTranslate } from 'react-icons/pi';

const NAV_ITEMS = [
    { id: 'translate', label: '翻译', Icon: PiTranslate },
    { id: 'research', label: '论文库', Icon: PiBooks },
    { id: 'settings', label: '设置', Icon: PiGear },
];

export default function AppRail({ active = 'research', onNavigate }) {
    return (
        <aside
            className='research-rail'
            aria-label='主导航'
        >
            <div className='research-rail__brand'>
                <img
                    src='/icon.png'
                    alt='小允翻译'
                />
            </div>
            <nav className='research-rail__nav'>
                {NAV_ITEMS.map(({ id, label, Icon }) => (
                    <button
                        className={`research-rail__item ${active === id ? 'is-active' : ''}`}
                        type='button'
                        key={id}
                        aria-current={active === id ? 'page' : undefined}
                        onClick={() => onNavigate?.(id)}
                    >
                        <Icon aria-hidden='true' />
                        <span>{label}</span>
                    </button>
                ))}
            </nav>
            <div className='research-rail__index-status'>
                <PiSparkle aria-hidden='true' />
                <span>正文索引完成</span>
            </div>
        </aside>
    );
}
