import { LegalPage } from '../../src/ui/legal/legal-page';

export default function PrivacyPage() {
  return <LegalPage title="隐私政策" paragraphs={paragraphs} returnHref="/rhythm/account" returnLabel="返回账户" />;
}

const paragraphs = [
  '已授权的健康记录会同步为本地健康快照，并在本地读取和展示。',
  '经你同意后，当前餐食照片只用于一次视觉识别；保存后不会保留照片或识别来源。',
  '餐食助手只会收到当前结构化餐食和当前问题，不会收到照片、OAuth、会话或刷新令牌。',
  'OAuth 凭据会加密保存在服务器数据库，不会进入浏览器存储或模型请求。断开连接会删除本地授权；你也可以在 Google 账号的第三方应用权限页撤销访问。',
];
