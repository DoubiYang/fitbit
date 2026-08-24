import type { AccountView } from '../../server/auth/account-view';
import { authErrorMessage } from '../../server/auth/account-view';

function formatConnectedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('zh-CN', { hour12: false });
}

function ScopeList({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return null;
  }
  return <p className="lede">已授权：{labels.join('、')}</p>;
}

function TestingNote() {
  return <p className="lede">测试模式下 Google 长期授权通常 7 天内到期，过期后需要重新连接。</p>;
}

function Actions(input: { showConnect?: boolean; showManage?: boolean }) {
  return (
    <div className="account-actions">
      {input.showConnect ? (
        <form method="post" action="/rhythm/api/auth/google/start">
          <button type="submit">连接 Google Health</button>
        </form>
      ) : null}
      {input.showManage ? (
        <>
          <form method="post" action="/rhythm/api/account/reauthorize">
            <button type="submit">重新授权</button>
          </form>
          <form method="post" action="/rhythm/api/account/logout">
            <button type="submit" className="button-secondary">
              退出
            </button>
          </form>
          <form method="post" action="/rhythm/api/account/disconnect">
            <button type="submit" className="button-secondary">
              断开连接
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}

export function AccountPanel({ view }: { view: AccountView }) {
  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <p className="eyebrow">节律 · 账户</p>
        <div className="dashboard-header__title-row">
          <h1>Google Health</h1>
        </div>
        <p className="lede">请在浏览器标签中完成授权。独立安装的 PWA 窗口可能无法带回登录状态。</p>
      </header>

      {view.state === 'unconfigured' ? (
        <section className="action-card">
          <h2>需要本地 Google Health 配置</h2>
          <p className="action-card__text">在 `.env.local` 中填写数据库、Google client 与 TOKEN_ENCRYPTION_KEY 后，用 Docker Compose 启动。</p>
          <p className="lede">生成密钥：openssl rand -base64 32</p>
        </section>
      ) : null}

      {view.state === 'unauthenticated' ? (
        <section className="action-card">
          <h2>尚未连接 Google Health</h2>
          <p className="action-card__text">连接后只会保存授权，不会立刻同步健康记录。</p>
          <Actions showConnect />
          <p className="lede">
            若 Google 账号权限页仍显示本应用，请到{' '}
            <a href="https://myaccount.google.com/permissions">Google 第三方应用权限</a> 继续撤销。
          </p>
        </section>
      ) : null}

      {view.state === 'connected' ? (
        <section className="action-card">
          <h2>已连接，等待同步</h2>
          <p className="action-card__text">最近授权时间：{formatConnectedAt(view.connectedAt)}</p>
          <ScopeList labels={view.scopeLabels} />
          {view.canWriteNutrition ? null : <p className="lede">尚未授予营养写回权限，餐食写回将不可用。</p>}
          <TestingNote />
          <Actions showManage />
          <p className="lede">
            断开后若 Google 账号权限页仍显示本应用，请到{' '}
            <a href="https://myaccount.google.com/permissions">Google 第三方应用权限</a> 继续撤销。
          </p>
        </section>
      ) : null}

      {view.state === 'partial' ? (
        <section className="action-card">
          <h2>权限不完整</h2>
          <p className="action-card__text">缺少：{view.missingLabels.join('、')}</p>
          {view.missingCore ? <p className="lede">仪表盘核心数据权限不完整，同步后仍可能缺少睡眠、生命体征或训练。</p> : null}
          {!view.canWriteNutrition ? <p className="lede">营养写回不可用，直到重新授权补齐写权限。</p> : null}
          <ScopeList labels={view.scopeLabels} />
          <TestingNote />
          <Actions showManage />
        </section>
      ) : null}

      {view.state === 'expired' ? (
        <section className="action-card">
          <h2>需要重新连接</h2>
          <p className="action-card__text">长期授权已失效。请重新授权，不要假设连接会永久有效。</p>
          <TestingNote />
          <Actions showManage />
        </section>
      ) : null}

      {view.state === 'callback_error' ? (
        <section className="action-card">
          <h2>授权未完成</h2>
          <p className="action-card__text">{authErrorMessage(view.code)}</p>
          <Actions showConnect />
        </section>
      ) : null}

      <p>
        <a href="/rhythm">返回今日</a>
      </p>
    </main>
  );
}
