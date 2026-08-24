export default function PrivacyPage() {
  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <p className="eyebrow">节律</p>
        <h1>隐私政策</h1>
        <p className="lede">
          节律是面向个人使用的健康教练应用。我们通过 Google OAuth 获取 Google Health 授权，把访问令牌与刷新令牌加密保存在你自己部署的服务器数据库中。令牌不会进入浏览器存储或第三方模型。
        </p>
        <p className="lede">
          本阶段不会拉取、展示或向模型发送你的真实健康记录。断开连接会删除本地保存的授权。你也可以在 Google 账号的第三方应用权限页撤销访问。
        </p>
        <p>
          <a href="/rhythm">返回</a>
        </p>
      </header>
    </main>
  );
}
