import { LegalPage } from '../../src/ui/legal/legal-page';

export default function TermsPage() {
  return <LegalPage title="服务条款" paragraphs={paragraphs} returnHref="/rhythm/account" returnLabel="返回账户" />;
}

const paragraphs = [
  '节律提供非医疗的生活方式参考，不构成诊断、治疗或急救建议。',
  '你需要使用自己的 Google 账号完成授权，并理解测试模式的授权可能在约 7 天后过期。',
  '你可以随时断开连接或撤销 Google 权限。继续使用即表示你同意自行保管部署环境中的密钥与数据。',
];
