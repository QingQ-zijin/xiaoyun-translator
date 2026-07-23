export const createServiceInstanceConfigLifecycle = ({
    serviceInstanceLists,
    listenEvent,
    loadConfig,
    setServiceInstanceConfigMap,
    generation,
    isCurrentGeneration,
    warn = console.warn,
}) => {
    let active = true;
    const changedOverrides = new Map();
    const serviceInstanceKeys = [...new Set(serviceInstanceLists.flat())];
    const isCurrent = () => active && isCurrentGeneration(generation);
    const unlistenPromises = serviceInstanceKeys.map((serviceInstanceKey) => {
        const eventKey = serviceInstanceKey.replaceAll('.', '_').replaceAll('@', ':');
        const handleConfigChange = (event) => {
            if (!isCurrent()) return;
            changedOverrides.set(serviceInstanceKey, event.payload);
            setServiceInstanceConfigMap((currentConfigMap) => ({
                ...(currentConfigMap ?? {}),
                [serviceInstanceKey]: event.payload,
            }));
        };
        try {
            return Promise.resolve(listenEvent(`${eventKey}_changed`, handleConfigChange)).catch((error) => {
                warn('监听服务实例配置变更失败', error);
                return null;
            });
        } catch (error) {
            warn('监听服务实例配置变更失败', error);
            return Promise.resolve(null);
        }
    });

    const ready = Promise.all(unlistenPromises)
        .then(async () => {
            if (!isCurrent()) return;
            const entries = await Promise.all(
                serviceInstanceKeys.map(async (serviceInstanceKey) => [
                    serviceInstanceKey,
                    (await loadConfig(serviceInstanceKey)) ?? {},
                ])
            );
            if (!isCurrent()) return;
            const configMap = Object.fromEntries(entries);
            for (const [serviceInstanceKey, config] of changedOverrides) {
                configMap[serviceInstanceKey] = config;
            }
            setServiceInstanceConfigMap(configMap);
        })
        .catch((error) => {
            warn('加载服务实例配置失败', error);
        });

    const cleanup = () => {
        // 列表切换或组件卸载后，旧监听和旧加载均不得再写回配置。
        active = false;
        for (const unlistenPromise of unlistenPromises) {
            void unlistenPromise.then((unlisten) => {
                unlisten?.();
            });
        }
    };

    return { cleanup, ready };
};
