#!/usr/bin/env node
// Idempotent Paperclip bootstrap — safe to run on every startup.
// If bootstrapStatus is already "ready", only re-registers the Telegram webhook.

const BASE = `http://localhost:${process.env.PORT || 3100}`;
const ADMIN_EMAIL = process.env.PAPERCLIP_ADMIN_EMAIL || 'bakasa@gmail.com';
const ADMIN_PASSWORD = process.env.PAPERCLIP_ADMIN_PASSWORD || 'paperclip2026!';
const HERMES_URL = process.env.HERMES_GATEWAY_URL || 'http://hermes-agent.railway.internal:8642';
const HERMES_KEY = process.env.HERMES_GATEWAY_API_KEY || '';
const CURSOR_KEY = process.env.CURSOR_API_KEY || '';
const PUBLIC_URL = process.env.PAPERCLIP_PUBLIC_URL || process.env.PUBLIC_URL || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_ORG = process.env.GITHUB_COMPANY_ORG || 'al-kutub';
const GH_PREFIX = process.env.GITHUB_COMPANY_REPO_PREFIX || 'p-ai';

const log = (msg) => console.log(`[pc-bootstrap] ${msg}`);

let cookie = '';

function mergeCookies(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return;
  for (const chunk of raw.split(/,(?=[^;]+=)/)) {
    const pair = chunk.trim().split(';')[0];
    const [k] = pair.split('=');
    const parts = cookie.split('; ').filter(x => x && !x.startsWith(k + '='));
    parts.push(pair);
    cookie = parts.join('; ');
  }
}

async function api(path, opts = {}) {
  const { method = 'GET', body, base = BASE, bearerToken } = opts;
  const headers = { 'Content-Type': 'application/json' };
  if (base === BASE && PUBLIC_URL) headers['Origin'] = PUBLIC_URL;
  if (cookie) headers['Cookie'] = cookie;
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  mergeCookies(res);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { _raw: text, _status: res.status }; }
}

async function waitReady(maxSecs = 120) {
  const deadline = Date.now() + maxSecs * 1000;
  while (Date.now() < deadline) {
    try {
      const h = await api('/api/health');
      if (h?.bootstrapStatus) return h.bootstrapStatus;
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Paperclip server did not become ready in time');
}

async function ensureGitHubRepo(name) {
  if (!GH_TOKEN) return `https://github.com/${GH_ORG}/${name}`;
  // Check if exists first
  const check = await api(`/repos/${GH_ORG}/${name}`, { base: 'https://api.github.com', bearerToken: GH_TOKEN });
  if (check?.full_name) return `https://github.com/${GH_ORG}/${name}`;
  const r = await api(`/orgs/${GH_ORG}/repos`, {
    method: 'POST', base: 'https://api.github.com', bearerToken: GH_TOKEN,
    body: { name, description: 'Paperclip AI autonomous workspace', auto_init: true, private: false },
  });
  return `https://github.com/${GH_ORG}/${r.name || name}`;
}

async function registerTelegramWebhook() {
  if (!TG_TOKEN || !PUBLIC_URL) { log('Skipping Telegram webhook (no token or url)'); return; }
  const r = await api(`/bot${TG_TOKEN}/setWebhook`, {
    method: 'POST', base: 'https://api.telegram.org',
    body: { url: `${PUBLIC_URL}/telegram/webhook`, allowed_updates: ['message', 'callback_query', 'inline_query'] },
  });
  log(`Telegram webhook: ${r?.description || JSON.stringify(r)}`);
}

async function bootstrap() {
  log('Waiting for Paperclip server...');
  const status = await waitReady();
  log(`bootstrapStatus=${status}`);

  // Always re-register Telegram webhook (idempotent)
  await registerTelegramWebhook();

  if (status !== 'bootstrap_pending') {
    log('Already bootstrapped. Done.');
    return;
  }

  log('Starting first-time bootstrap...');

  // 1. Sign up admin (also sets session cookie)
  const signUp = await api('/api/auth/sign-up/email', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  log(`Sign up: ${signUp?.user?.email || JSON.stringify(signUp).slice(0, 80)}`);

  // If sign-up didn't give a session, sign in explicitly
  if (!cookie) {
    await api('/api/auth/sign-in/email', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
  }

  // 2. Claim first admin
  const claim = await api('/api/bootstrap/claim', { method: 'POST' });
  log(`Admin claimed: ${claim?.email || JSON.stringify(claim).slice(0, 80)}`);

  // 3. Create company
  const company = await api('/api/companies', {
    method: 'POST',
    body: { name: 'HermesWorkers' },
  });
  const companyId = company.id;
  if (!companyId) throw new Error(`Company creation failed: ${JSON.stringify(company)}`);
  log(`Company: ${companyId}`);

  // 4. Create secrets
  const mkSecret = (name, value) => api(`/api/companies/${companyId}/secrets`, {
    method: 'POST', body: { name, value },
  });
  const [cursorSecret, hermesSecret] = await Promise.all([
    mkSecret('CURSOR_API_KEY', CURSOR_KEY),
    mkSecret('HERMES_API_SERVER_KEY', HERMES_KEY),
  ]);
  log(`Secrets: cursor=${cursorSecret.id} hermes=${hermesSecret.id}`);

  const cursorRef = { type: 'secret_ref', version: 'latest', secretId: cursorSecret.id };
  const hermesRef = { type: 'secret_ref', version: 'latest', secretId: hermesSecret.id };

  // 5. Ensure GitHub workspace repo
  const workspaceRepo = await ensureGitHubRepo(`${GH_PREFIX}-workspace`);
  log(`Workspace repo: ${workspaceRepo}`);

  // Helper for agent adapterConfig
  const hermesGatewayConfig = {
    apiBaseUrl: HERMES_URL,
    apiKey: hermesRef,
    dangerouslyAllowInsecureRemoteHttp: true,
    paperclipApiUrl: PUBLIC_URL,
    sessionKeyStrategy: 'issue',
  };
  const cursorConfig = (repo) => ({
    repoUrl: repo,
    env: { CURSOR_API_KEY: cursorRef },
  });

  // 6. Hire agents
  const [ceo, worker, engineer, qa] = await Promise.all([
    api(`/api/companies/${companyId}/agents`, {
      method: 'POST',
      body: { name: 'CEO', role: 'ceo', icon: 'crown', adapterType: 'hermes_gateway', adapterConfig: hermesGatewayConfig },
    }),
    api(`/api/companies/${companyId}/agents`, {
      method: 'POST',
      body: { name: 'Hermes Gateway Worker', role: 'general', icon: 'bot', adapterType: 'hermes_gateway', adapterConfig: hermesGatewayConfig },
    }),
    api(`/api/companies/${companyId}/agents`, {
      method: 'POST',
      body: { name: 'Engineer', role: 'engineer', icon: 'code', adapterType: 'cursor_cloud', adapterConfig: cursorConfig(workspaceRepo) },
    }),
    api(`/api/companies/${companyId}/agents`, {
      method: 'POST',
      body: { name: 'QA', role: 'general', icon: 'bot', adapterType: 'cursor_cloud', adapterConfig: cursorConfig(workspaceRepo) },
    }),
  ]);
  log(`Agents: CEO=${ceo.id} worker=${worker.id} engineer=${engineer.id} qa=${qa.id}`);

  // 7. Enable CEO heartbeat + wire chain of command
  await Promise.all([
    api(`/api/agents/${ceo.id}`, {
      method: 'PATCH',
      body: { runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300, maxConcurrentRuns: 1 } } },
    }),
    api(`/api/agents/${worker.id}`, { method: 'PATCH', body: { reportsTo: ceo.id } }),
    api(`/api/agents/${engineer.id}`, { method: 'PATCH', body: { reportsTo: ceo.id } }),
    api(`/api/agents/${qa.id}`, { method: 'PATCH', body: { reportsTo: ceo.id } }),
  ]);

  log(`Bootstrap complete. Company=${companyId} CEO=${ceo.id}`);
}

bootstrap().catch(err => {
  log(`ERROR: ${err.message}`);
  // Non-fatal: Paperclip still runs, bootstrap can be retried
  process.exit(0);
});
