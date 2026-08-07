import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import Research from '../Research';
import MainRail from './MainRail';
import MainTitlebar from './MainTitlebar';
import OllamaFirstRunGate from './OllamaFirstRunGate';
import SettingsPanel from './SettingsPanel';
import TranslationWorkspace from './TranslationWorkspace';
import UpdateNotice from './UpdateNotice';
import { initialMainRoute, normalizeRoute } from './navigation';
import useAppUpdater from './useAppUpdater';
import './main.css';

function initialRoute() {
    return initialMainRoute(globalThis.location?.search ?? '');
}

const isTauriRuntime = () =>
    Boolean(
        globalThis.window?.__TAURI__ || globalThis.window?.__TAURI_METADATA__ || globalThis.window?.__TAURI_INTERNALS__
    );

export default function Main() {
    const updater = useAppUpdater();
    const [navigation, setNavigation] = useState(() => ({
        route: initialRoute(),
        researchSession: 0,
    }));
    const active = navigation.route;
    const navigate = useCallback((route) => {
        const nextRoute = normalizeRoute(route);
        setNavigation((current) => ({
            route: nextRoute,
            // 每次从主导航进入论文模块时重建阅读会话；Research 会恢复最近阅读论文，
            // 论文管理页仍由阅读器内的“返回论文库”入口显式打开。
            researchSession: nextRoute === 'research' ? current.researchSession + 1 : current.researchSession,
        }));
    }, []);

    useEffect(() => {
        if (!isTauriRuntime()) return undefined;
        let unlisten = () => {};
        void listen('main_navigate', (event) => navigate(event.payload))
            .then((dispose) => {
                unlisten = dispose;
            })
            .catch(() => undefined);
        return () => unlisten();
    }, [navigate]);

    return (
        <div className={`main-shell main-shell--${active}`}>
            <OllamaFirstRunGate />
            <UpdateNotice updater={updater} />
            <MainTitlebar
                active={active}
                onNavigate={navigate}
            />
            <MainRail
                active={active}
                onNavigate={navigate}
            />
            {active === 'research' ? (
                <Research
                    key={navigation.researchSession}
                    embedded
                    startInLibrary={false}
                    onNavigate={navigate}
                />
            ) : active === 'translate' ? (
                <TranslationWorkspace onNavigate={navigate} />
            ) : (
                <SettingsPanel updater={updater} />
            )}
        </div>
    );
}
