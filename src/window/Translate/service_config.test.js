import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFile } from 'node:fs/promises';

let serviceConfigEvents = {};

before(async () => {
    serviceConfigEvents = await import('./service_config_events.js');
});

const getStartLifecycle = () => {
    const startLifecycle =
        serviceConfigEvents.createServiceInstanceConfigLifecycle ??
        serviceConfigEvents.subscribeServiceInstanceConfigChanges;
    assert.equal(typeof startLifecycle, 'function', '应提供服务实例配置同步生命周期函数');
    return startLifecycle;
};

const normalizeLifecycle = (lifecycle) => ({
    cleanup: typeof lifecycle === 'function' ? lifecycle : lifecycle.cleanup,
    ready: lifecycle?.ready ?? Promise.resolve(),
});

const createDeferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

const createStateHarness = (initialValue = null) => {
    const state = { value: initialValue };
    const setServiceInstanceConfigMap = (nextValue) => {
        state.value = typeof nextValue === 'function' ? nextValue(state.value) : nextValue;
    };
    return { state, setServiceInstanceConfigMap };
};

const createListenerHarness = ({ deferRegistration = false } = {}) => {
    const listeners = new Map();
    const removedEventNames = [];
    const resolveRegistrations = [];
    const listenEvent = (eventName, handler) => {
        listeners.set(eventName, handler);
        const unlisten = () => {
            listeners.delete(eventName);
            removedEventNames.push(eventName);
        };
        if (!deferRegistration) return Promise.resolve(unlisten);
        return new Promise((resolve) => {
            resolveRegistrations.push(() => resolve(unlisten));
        });
    };
    return {
        listenEvent,
        listeners,
        removedEventNames,
        resolveNextRegistration: () => resolveRegistrations.shift()?.(),
        resolveRegistrations: () => resolveRegistrations.forEach((resolve) => resolve()),
    };
};

const startLifecycle = (overrides = {}) => {
    const generation = overrides.generation ?? 1;
    return getStartLifecycle()({
        serviceInstanceLists: overrides.serviceInstanceLists ?? [['ollama@local'], ['system'], [], []],
        listenEvent: overrides.listenEvent ?? (() => Promise.resolve(() => {})),
        loadConfig: overrides.loadConfig ?? (() => Promise.resolve({})),
        setServiceInstanceConfigMap: overrides.setServiceInstanceConfigMap ?? (() => {}),
        generation,
        isCurrentGeneration: overrides.isCurrentGeneration ?? ((candidate) => candidate === generation),
        warn: overrides.warn ?? (() => {}),
    });
};

test('先监听四类去重实例再并行加载并提交当前列表的精确配置 map', async () => {
    const calls = [];
    const listenerHarness = createListenerHarness({ deferRegistration: true });
    const stateHarness = createStateHarness({ obsolete: { enabled: true } });
    const configLoads = new Map();
    const lifecycle = normalizeLifecycle(
        startLifecycle({
            serviceInstanceLists: [
                ['ollama@local', 'custom.service'],
                ['system'],
                ['lingva_tts'],
                ['anki', 'ollama@local'],
            ],
            listenEvent: (eventName, handler) => {
                calls.push(`listen:${eventName}`);
                return listenerHarness.listenEvent(eventName, handler);
            },
            loadConfig: (serviceInstanceKey) => {
                calls.push(`load:${serviceInstanceKey}`);
                const configLoad = createDeferred();
                configLoads.set(serviceInstanceKey, configLoad);
                return configLoad.promise;
            },
            setServiceInstanceConfigMap: stateHarness.setServiceInstanceConfigMap,
        })
    );

    assert.equal(
        calls.some((call) => call.startsWith('load:')),
        false,
        '监听注册完成前不得开始读取配置'
    );
    for (let index = 0; index < 4; index += 1) {
        listenerHarness.resolveNextRegistration();
    }
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
        calls.some((call) => call.startsWith('load:')),
        false,
        '必须等待全部监听注册完成'
    );

    listenerHarness.resolveNextRegistration();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.filter((call) => call.startsWith('load:')).length, 5, '全部配置读取必须并行启动');
    for (const [serviceInstanceKey, configLoad] of configLoads) {
        configLoad.resolve({ key: serviceInstanceKey });
    }
    await lifecycle.ready;

    const firstLoadIndex = calls.findIndex((call) => call.startsWith('load:'));
    assert.equal(firstLoadIndex, 5, '全部事件监听必须先于任何配置读取注册');
    assert.deepEqual([...listenerHarness.listeners.keys()].sort(), [
        'anki_changed',
        'custom_service_changed',
        'lingva_tts_changed',
        'ollama:local_changed',
        'system_changed',
    ]);
    assert.deepEqual(Object.keys(stateHarness.state.value).sort(), [
        'anki',
        'custom.service',
        'lingva_tts',
        'ollama@local',
        'system',
    ]);
    assert.equal(calls.filter((call) => call === 'load:ollama@local').length, 1);

    lifecycle.cleanup();
});

test('旧列表慢加载不得覆盖新列表的快速加载结果', async () => {
    let currentGeneration = 0;
    const oldLoad = createDeferred();
    const newLoad = createDeferred();
    const stateHarness = createStateHarness();
    const isCurrentGeneration = (generation) => generation === currentGeneration;

    const oldLifecycle = normalizeLifecycle(
        startLifecycle({
            serviceInstanceLists: [['old-service'], [], [], []],
            loadConfig: () => oldLoad.promise,
            setServiceInstanceConfigMap: stateHarness.setServiceInstanceConfigMap,
            generation: ++currentGeneration,
            isCurrentGeneration,
        })
    );
    const newLifecycle = normalizeLifecycle(
        startLifecycle({
            serviceInstanceLists: [['new-service'], [], [], []],
            loadConfig: () => newLoad.promise,
            setServiceInstanceConfigMap: stateHarness.setServiceInstanceConfigMap,
            generation: ++currentGeneration,
            isCurrentGeneration,
        })
    );

    newLoad.resolve({ model: 'new-model' });
    await newLifecycle.ready;
    assert.deepEqual(stateHarness.state.value, { 'new-service': { model: 'new-model' } });

    oldLoad.resolve({ model: 'old-model' });
    await oldLifecycle.ready;
    assert.deepEqual(stateHarness.state.value, { 'new-service': { model: 'new-model' } });

    oldLifecycle.cleanup();
    newLifecycle.cleanup();
});

test('加载期间先到的配置事件立即更新且最终覆盖较旧的加载快照', async () => {
    const ollamaLoad = createDeferred();
    const listenerHarness = createListenerHarness();
    const originalConfigMap = { obsolete: { enabled: true } };
    const stateHarness = createStateHarness(originalConfigMap);
    const lifecycle = normalizeLifecycle(
        startLifecycle({
            listenEvent: listenerHarness.listenEvent,
            loadConfig: (serviceInstanceKey) =>
                serviceInstanceKey === 'ollama@local' ? ollamaLoad.promise : Promise.resolve({ language: 'en' }),
            setServiceInstanceConfigMap: stateHarness.setServiceInstanceConfigMap,
        })
    );

    listenerHarness.listeners.get('ollama:local_changed')({ payload: { model: 'event-model' } });

    assert.notStrictEqual(stateHarness.state.value, originalConfigMap);
    assert.deepEqual(originalConfigMap, { obsolete: { enabled: true } });
    assert.deepEqual(stateHarness.state.value['ollama@local'], { model: 'event-model' });

    ollamaLoad.resolve({ model: 'stale-model' });
    await lifecycle.ready;
    assert.deepEqual(stateHarness.state.value, {
        'ollama@local': { model: 'event-model' },
        system: { language: 'en' },
    });

    lifecycle.cleanup();
});

test('监听 Promise 拒绝会被消费并且不阻断配置加载', async () => {
    const listenError = new Error('listen failed');
    const rejectedListen = Promise.reject(listenError);
    const warnings = [];
    const stateHarness = createStateHarness();
    const lifecycleResult = startLifecycle({
        serviceInstanceLists: [['ollama@local'], [], [], []],
        listenEvent: () => rejectedListen,
        loadConfig: () => Promise.resolve({ model: 'loaded-model' }),
        setServiceInstanceConfigMap: stateHarness.setServiceInstanceConfigMap,
        warn: (...args) => warnings.push(args),
    });
    const lifecycle = normalizeLifecycle(lifecycleResult);

    await lifecycle.ready;
    await Promise.resolve();

    assert.deepEqual(stateHarness.state.value, { 'ollama@local': { model: 'loaded-model' } });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][1], listenError);

    if (typeof lifecycleResult !== 'function') lifecycle.cleanup();
});

test('加载已经开始后卸载也不会在读取完成时更新状态', async () => {
    const configLoad = createDeferred();
    const loadStarted = createDeferred();
    const stateHarness = createStateHarness();
    const lifecycle = normalizeLifecycle(
        startLifecycle({
            serviceInstanceLists: [['ollama@local'], [], [], []],
            loadConfig: () => {
                loadStarted.resolve();
                return configLoad.promise;
            },
            setServiceInstanceConfigMap: stateHarness.setServiceInstanceConfigMap,
        })
    );

    await loadStarted.promise;
    lifecycle.cleanup();
    configLoad.resolve({ model: 'late-model' });
    await lifecycle.ready;

    assert.equal(stateHarness.state.value, null);
});

test('列表变化或组件卸载会清理延迟注册的监听且旧事件不再更新配置', async () => {
    const listenerHarness = createListenerHarness({ deferRegistration: true });
    let updateCount = 0;
    const lifecycle = normalizeLifecycle(
        startLifecycle({
            listenEvent: listenerHarness.listenEvent,
            setServiceInstanceConfigMap: () => {
                updateCount += 1;
            },
        })
    );
    const staleHandler = listenerHarness.listeners.get('ollama:local_changed');

    lifecycle.cleanup();
    staleHandler({ payload: { model: 'stale-model' } });
    assert.equal(updateCount, 0, '清理后的旧监听不得写回配置');
    assert.deepEqual(listenerHarness.removedEventNames, []);

    listenerHarness.resolveRegistrations();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(listenerHarness.removedEventNames.sort(), ['ollama:local_changed', 'system_changed']);
});

test('Translate 只加载 Ollama 配置并在单一 effect 中清理事件和请求', async () => {
    const source = await readFile(new URL('./index.jsx', import.meta.url), 'utf8');

    assert.match(source, /loadOllamaTranslationConfig/);
    assert.match(source, /loadOllamaVisionConfig/);
    assert.match(
        source,
        /Promise\.all\(\[[\s\S]*loadOllamaTranslationConfig\(\),[\s\S]*loadOllamaVisionConfig\(\),[\s\S]*invoke\('get_settings_v2'\)/
    );
    assert.match(source, /listen\('new_text'/);
    assert.match(source, /listen\('selection_capture_state'/);
    assert.match(source, /translateAbortRef\.current\?\.abort\(\)/);
    assert.match(source, /cleanups\.forEach\(\(cleanup\) => cleanup\(\)\)/);
    assert.doesNotMatch(source, /translateServiceInstanceList|recognizeServiceInstanceList|ttsServiceInstanceList|collectionServiceInstanceList/);
});
