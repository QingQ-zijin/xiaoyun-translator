import { Store } from '@tauri-apps/plugin-store';
import { appConfigDir, join } from '@tauri-apps/api/path';

export let store = new Store();

export async function initStore() {
    const appConfigDirPath = await appConfigDir();
    const appConfigPath = await join(appConfigDirPath, 'config.json');
    store = new Store(appConfigPath);
    await store.load();
}
