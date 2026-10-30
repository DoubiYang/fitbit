import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { HEALTH_SCOPE, CONSENT_PATH } from './oauth.mjs';

export function oauthApp({ provider, resolveSession, endpoint, accountUrl }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
    next();
  });
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(endpoint.origin), resourceServerUrl: endpoint,
    scopesSupported: [HEALTH_SCOPE], resourceName: '节律健康数据' }));
  const escape = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  app.get(CONSENT_PATH, async (req, res) => {
    try {
      const pending = provider.pending(req.query.request);
      if (await resolveSession(req.headers.cookie) !== provider.userId) {
        res.status(401).type('html').send(`<html lang="zh"><meta charset="utf-8"><p>请先登录绑定的节律账户，再返回并刷新本页。</p><a href="${escape(accountUrl)}">登录节律</a></html>`);
        return;
      }
      const client = await provider.clientsStore.getClient(pending.clientId);
      res.type('html').send(`<html lang="zh"><meta charset="utf-8"><h1>授权读取健康数据</h1><p>客户端：${escape(client.client_name ?? client.client_id)}</p><p>回调地址：${escape(pending.redirectUri)}</p><p>允许读取你的睡眠、心率、HRV和每日健康汇总。</p><form method="post"><input type="hidden" name="request" value="${escape(req.query.request)}"><input type="hidden" name="csrf" value="${escape(pending.csrf)}"><button name="decision" value="approve">同意授权</button><button name="decision" value="deny">取消</button></form></html>`);
    } catch { res.status(400).send('授权请求无效或已过期'); }
  });
  app.post(CONSENT_PATH, express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    if (req.headers.origin !== endpoint.origin) { res.status(403).end(); return; }
    try {
      const pending = provider.pending(req.body.request);
      const userId = await resolveSession(req.headers.cookie);
      if (userId !== provider.userId || req.body.csrf !== pending.csrf) { res.status(403).end(); return; }
      if (req.body.decision !== 'approve') {
        delete provider.state.pending[req.body.request];
        provider.save();
        const redirect = new URL(pending.redirectUri);
        redirect.searchParams.set('error', 'access_denied');
        if (pending.state !== undefined) redirect.searchParams.set('state', pending.state);
        res.redirect(redirect.href);
        return;
      }
      res.redirect(provider.approve(req.body.request, userId));
    } catch { res.status(400).send('授权请求无效或已过期'); }
  });
  app.use(endpoint.pathname, (req, res, next) => {
    if (req.headers.origin && req.headers.origin !== endpoint.origin) { res.status(403).end(); return; }
    next();
  }, requireBearerAuth({ verifier: provider, requiredScopes: [HEALTH_SCOPE], expectedResource: endpoint,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(endpoint) }));
  return app;
}
