export default function TermsPage() {
  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <p className="eyebrow">节律</p>
        <h1>服务条款</h1>
        <p className="lede">
          节律提供非医疗的生活方式参考，不构成诊断、治疗或急救建议。你需要使用自己的 Google 账号完成授权，并理解测试模式的授权可能在约 7 天后过期。
        </p>
        <p className="lede">你可以随时断开连接或撤销 Google 权限。继续使用即表示你同意自行保管部署环境中的密钥与数据。</p>
        <p>
          <a href="/rhythm">返回</a>
        </p>
      </header>
    </main>
  );
}
