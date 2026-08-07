import { Button, Divider } from '@nextui-org/react';
import { appConfigDir, appLogDir } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-shell';

import { appVersion } from '../../../../utils/env';

const REPOSITORY_URL = 'https://github.com/QingQ-zijin/xiaoyun-translator';

export default function About() {
    return (
        <div className='h-full w-full px-[100px] py-[80px]'>
            <img
                src='icon.png'
                className='mx-auto mb-[8px] h-[100px]'
                draggable={false}
                alt='小允翻译'
            />
            <h1 className='text-center text-2xl font-bold'>小允翻译——论文阅读器</h1>
            <p className='mb-[8px] text-center text-sm text-gray-500'>版本 {appVersion}</p>
            <p className='mb-[20px] text-center text-sm text-gray-500'>
                本地优先的学术翻译与论文阅读器
            </p>

            <Divider />
            <div className='flex justify-center gap-3 py-3'>
                <Button
                    variant='light'
                    size='sm'
                    onPress={() => open(REPOSITORY_URL)}
                >
                    GitHub
                </Button>
                <Button
                    variant='light'
                    size='sm'
                    onPress={() => open(`${REPOSITORY_URL}/issues`)}
                >
                    问题反馈
                </Button>
                <Button
                    variant='light'
                    size='sm'
                    onPress={() => open(`${REPOSITORY_URL}#快速开始`)}
                >
                    使用教程
                </Button>
            </div>

            <Divider />
            <div className='flex justify-center gap-3 py-3'>
                <Button
                    variant='light'
                    size='sm'
                    onPress={async () => open(await appLogDir())}
                >
                    查看日志
                </Button>
                <Button
                    variant='light'
                    size='sm'
                    onPress={async () => open(await appConfigDir())}
                >
                    打开配置目录
                </Button>
            </div>
        </div>
    );
}
