import type { Metadata } from 'next';

import { LegalPage } from '../../src/ui/legal/legal-page';

export const metadata: Metadata = {
  title: 'Air Recovery',
  description: '查看睡眠、心率、运动和恢复趋势的个人健康数据工具。',
};

export default function AboutPage() {
  return (
    <LegalPage
      title="Air Recovery"
      eyebrow="个人健康数据与恢复"
      brandIcon
      sections={[
        { title: '应用用途', content: 'Air Recovery 帮助你查看自己的睡眠、心率、活动与恢复趋势。你可以查看每天的健康指标和心肺负荷，作为安排训练和休息的参考。应用不提供医疗诊断。' },
        { title: '为什么连接 Google Health', content: '经你授权后，应用会同步 Google Health 中的睡眠、心率、静息心率、心率变异性、活动与训练等数据，用于展示历史变化及计算每日恢复和负荷。你可以随时在账户页断开连接。' },
        { title: '在你选用的客户端查看', content: '如果你另行授权 MCP 客户端，例如 ChatGPT 或 Codex，它可以查询你的同步状态、选定日期的健康数据及每日汇总。连接 Google Health 本身不会自动把健康记录发给这些客户端。' },
      ]}
      links={<><a href="/rhythm/privacy">隐私政策</a><a href="/rhythm/terms">服务条款</a></>}
      returnHref="/rhythm/account"
      returnLabel="前往账户"
    />
  );
}
