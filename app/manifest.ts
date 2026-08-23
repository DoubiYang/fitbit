import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '节律',
    short_name: '节律',
    description: '用可解释数据帮助你安排今天的训练与恢复。',
    lang: 'zh-CN',
    display: 'standalone',
    start_url: '/',
    theme_color: '#123c3b',
    background_color: '#f6f4ee',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
      },
    ],
  };
}
