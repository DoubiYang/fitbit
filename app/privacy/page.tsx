import type { Metadata } from 'next';

import { LegalPage } from '../../src/ui/legal/legal-page';

export const metadata: Metadata = {
  title: 'Air Recovery 隐私政策',
  description: '了解 Air Recovery 如何访问、使用、保存、共享及删除个人数据。',
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Air Recovery 隐私政策"
      eyebrow="Air Recovery · 数据使用说明"
      paragraphs={['更新日期：2026 年 11 月 7 日。本政策适用于 Air Recovery 网站、Google Health 同步及可选的 MCP 连接。']}
      sections={sections}
      links={<a href="/rhythm/about">关于 Air Recovery</a>}
      returnHref="/rhythm/account"
      returnLabel="返回账户"
    />
  );
}

const sections = [
  {
    title: '我们访问哪些信息',
    content: '在你授权后，应用使用 Google Health 返回的账户标识来关联你的账户，并读取可用的睡眠记录、心率、静息心率、心率变异性、心率区间及区间时长、活动强度、运动记录和最大摄氧量估计。应用还保存你主动填写的健康资料（如出生日期和参考性别）、睡眠目标、时区及餐食记录。应用不收集你的 Google 密码。',
  },
  {
    title: '数据的用途',
    content: '应用定期同步已授权的数据，用于在账户内展示睡眠、心率和活动趋势，计算恢复、睡眠表现、心肺负荷与身体年龄估算，并显示同步状态。这些结果供个人健康管理参考。餐食仅在你点击「同步这一餐」并具有写入权限时，才会把可写入的营养数据发送到 Google Health。',
  },
  {
    title: '存储、保留与安全',
    content: '同步记录和衍生指标保存在服务端 PostgreSQL 数据库，按账户隔离。睡眠、心率变异性、静息心率等健康快照采用 42 天滚动窗口；分钟汇总、其他衍生记录与手动餐食不共用这一保留期限。Google OAuth 凭据会加密保存在服务器数据库，不会返回给 MCP 客户端或餐食模型。网站及 MCP 使用 HTTPS，网站以会话 Cookie 维持登录。',
  },
  {
    title: '可选的 MCP 连接与数据共享',
    content: '在你单独完成 MCP 授权后，你选择的客户端（如 OpenAI 的 ChatGPT 或 Codex）可以按请求读取同步状态、指定日期的睡眠、心率、心率变异性、活动记录与每日健康汇总，用于向你展示、汇总或监测你的数据。未授权的客户端不能查询；应用不会因 Google 登录而自动向客户端发送健康记录。客户端收到的数据由其自身的隐私政策和账户设置管理。Air Recovery 不出售这些数据，也不将其用于广告。',
  },
  {
    title: '可选的餐食 AI 功能',
    content: '在启用了餐食 AI 的部署中，只有你同意并提交照片后，当前照片才会发送给 DeepSeek 进行当次识别；Air Recovery 不在餐食记录中保存照片。餐食助手请求发送当前结构化餐食和你的问题，不附带照片、Google Health 同步记录或登录凭据。',
  },
  {
    title: '撤销授权与删除数据',
    content: <>在<a href="/rhythm/account">账户页</a>选择「断开连接」，会停止后续同步，并删除服务端保存的 Google 授权凭据、健康快照、同步指标及登录会话。你也可以通过 <a href="https://myaccount.google.com/permissions">Google 第三方应用权限</a>撤销访问。断开连接不会删除 Google Health 中的原始数据，也不会删除你保存的手动餐食或客户端已经收到的副本；如需删除剩余的应用数据或账户记录，可联系我们。</>,
  },
  {
    title: 'Google Health 有限使用要求（Limited Use）',
    content: <>Air Recovery 对通过 Google Health API 获取的信息的使用遵循 <a href="https://developers.google.com/health/policies/health-api-developer-user-data-policy">Google Health API 开发者与用户数据政策</a>，包括其中的有限使用（Limited Use）要求。</>,
  },
  {
    title: '联系我们',
    content: <>如对隐私、数据使用或删除有疑问，请联系 <a href="mailto:tibet211@gmail.com">tibet211@gmail.com</a>。我们会在本页标明更新日期，并在数据用途发生变化时更新说明。</>,
  },
];
