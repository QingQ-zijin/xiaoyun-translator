import { PiArrowClockwise, PiCheckCircle, PiDownloadSimple, PiSpinnerGap, PiWarningCircle, PiX } from 'react-icons/pi';

import { APP_UPDATE_PHASE } from './useAppUpdater';
import './update.css';

function phaseCopy(updater) {
    if (updater.error && ['install', 'relaunch'].includes(updater.errorKind)) {
        return {
            title: updater.errorKind === 'relaunch' ? '更新已安装，等待重启' : '更新失败',
            detail: updater.error,
            Icon: PiWarningCircle,
        };
    }
    if (updater.phase === APP_UPDATE_PHASE.DOWNLOADING) {
        return {
            title: `正在下载 ${updater.updateVersion}`,
            detail: updater.progressPercent === null ? '正在获取更新包…' : `已完成 ${updater.progressPercent}%`,
            Icon: PiSpinnerGap,
        };
    }
    if (updater.phase === APP_UPDATE_PHASE.INSTALLING) {
        return {
            title: '正在安装更新',
            detail: '安装期间请保持应用运行。',
            Icon: PiSpinnerGap,
        };
    }
    if (updater.phase === APP_UPDATE_PHASE.RELAUNCHING) {
        return {
            title: '更新完成，正在重启',
            detail: '小允翻译将在片刻后重新打开。',
            Icon: PiCheckCircle,
        };
    }
    return {
        title: `发现新版本 ${updater.updateVersion}`,
        detail: updater.notes || `当前版本 ${updater.currentVersion || '未知'}，可立即安全更新。`,
        Icon: PiDownloadSimple,
    };
}

export default function UpdateNotice({ updater }) {
    if (!updater?.updateVersion) return null;

    const busy = updater.isChecking || updater.isInstalling;
    const shouldStayVisible =
        busy ||
        updater.phase === APP_UPDATE_PHASE.READY_TO_RELAUNCH ||
        ['install', 'relaunch'].includes(updater.errorKind);
    if (updater.bannerDismissed && !shouldStayVisible) return null;

    const { title, detail, Icon } = phaseCopy(updater);
    const retryingRelaunch = updater.phase === APP_UPDATE_PHASE.READY_TO_RELAUNCH;
    const actionLabel = retryingRelaunch ? '重新启动' : updater.errorKind === 'install' ? '重试更新' : '立即更新';
    const actionDisabled =
        updater.isChecking ||
        [APP_UPDATE_PHASE.DOWNLOADING, APP_UPDATE_PHASE.INSTALLING, APP_UPDATE_PHASE.RELAUNCHING].includes(
            updater.phase
        );

    return (
        <aside
            className={`app-update-notice app-update-notice--${updater.phase}`}
            role='status'
            aria-live='polite'
            aria-label='软件更新通知'
        >
            <span className='app-update-notice__icon'>
                <Icon
                    className={updater.isInstalling ? 'is-spinning' : undefined}
                    aria-hidden='true'
                />
            </span>
            <div className='app-update-notice__content'>
                <strong>{title}</strong>
                <span title={detail}>{detail}</span>
                {updater.phase === APP_UPDATE_PHASE.DOWNLOADING ? (
                    <progress
                        aria-label='更新下载进度'
                        value={updater.progressPercent ?? undefined}
                        max='100'
                    />
                ) : null}
            </div>
            <div className='app-update-notice__actions'>
                <button
                    className='app-update-notice__primary'
                    type='button'
                    onClick={() => void updater.installUpdate()}
                    disabled={actionDisabled}
                >
                    {updater.isInstalling ? (
                        <PiSpinnerGap
                            className='is-spinning'
                            aria-hidden='true'
                        />
                    ) : retryingRelaunch ? (
                        <PiArrowClockwise aria-hidden='true' />
                    ) : (
                        <PiDownloadSimple aria-hidden='true' />
                    )}
                    {updater.isInstalling ? '更新中' : actionLabel}
                </button>
                {!updater.isInstalling ? (
                    <button
                        className='app-update-notice__later'
                        type='button'
                        onClick={updater.dismissBanner}
                        aria-label='本会话稍后更新'
                    >
                        <PiX aria-hidden='true' />
                        稍后
                    </button>
                ) : null}
            </div>
        </aside>
    );
}
