import { PiBooks, PiGear, PiSparkle, PiTranslate } from 'react-icons/pi';

const NAV_ITEMS = [
    { id: 'translate', label: '翻译', Icon: PiTranslate },
    { id: 'research', label: '论文库', Icon: PiBooks },
    { id: 'settings', label: '设置', Icon: PiGear },
];

export default function MainRail({ active, onNavigate }) {
    return (
        <aside
            className='main-rail'
            aria-label='主导航'
        >
            <div className='main-rail__brand'>
                <img
                    src='/icon.png'
                    alt='小允翻译'
                />
            </div>
            <nav className='main-rail__nav'>
                {NAV_ITEMS.map(({ id, label, Icon }) => (
                    <button
                        className={`main-rail__item ${active === id ? 'is-active' : ''}`}
                        type='button'
                        key={id}
                        aria-current={active === id ? 'page' : undefined}
                        onClick={() => onNavigate(id)}
                    >
                        <Icon aria-hidden='true' />
                        <span>{label}</span>
                    </button>
                ))}
            </nav>
            <div
                className='main-rail__status'
                title='所有模型均通过本机 Ollama 运行'
            >
                <PiSparkle aria-hidden='true' />
                <span>本地 AI</span>
            </div>
        </aside>
    );
}
