import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { Buffer } from 'node:buffer';

type StoredConnection = {
  realmId: string;
  connectedAt: string;
  companyName?: string;
  encrypted: {
    iv: string;
    data: string;
  };
  accessExpiresAt: string;
  refreshExpiresAt?: string;
};

type TokenSet = {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
};

function integrationStore(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-integrations', consistency: 'strong' })
    : getDeployStore({ name: 'koa-integrations' });
}

function config() {
  const clientId = String(process.env.INTUIT_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.INTUIT_CLIENT_SECRET || '').trim();
  const encryptionKey = String(process.env.QBO_TOKEN_ENCRYPTION_KEY || '').trim();
  const environment = String(process.env.QBO_ENVIRONMENT || 'production').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
  const itemId = String(process.env.QBO_SERVICE_ITEM_ID || '').trim();
  return { clientId, clientSecret, encryptionKey, environment, itemId };
}

export function quickBooksConfiguration() {
  const c = config();
  return {
    configured: Boolean(c.clientId && c.clientSecret && c.encryptionKey),
    clientIdConfigured: Boolean(c.clientId),
    clientSecretConfigured: Boolean(c.clientSecret),
    encryptionKeyConfigured: Boolean(c.encryptionKey),
    serviceItemConfigured: Boolean(c.itemId),
    environment: c.environment,
  };
}

function encryptionBytes() {
  const encoded = config().encryptionKey;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 32) {
    throw new Error('QBO_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return bytes;
}

async function encryptionKey(usages: KeyUsage[]) {
  return crypto.subtle.importKey(
    'raw',
    encryptionBytes(),
    { name: 'AES-GCM' },
    false,
    usages,
  );
}

async function encryptTokens(tokens: { accessToken: string; refreshToken: string }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(['encrypt']);
  const plain = new TextEncoder().encode(JSON.stringify(tokens));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return {
    iv: Buffer.from(iv).toString('base64'),
    data: Buffer.from(cipher).toString('base64'),
  };
}

async function decryptTokens(connection: StoredConnection) {
  const key = await encryptionKey(['decrypt']);
  const iv = Buffer.from(connection.encrypted.iv, 'base64');
  const cipher = Buffer.from(connection.encrypted.data, 'base64');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  return {
    accessToken: String(parsed.accessToken || ''),
    refreshToken: String(parsed.refreshToken || ''),
  };
}

function tokenEndpoint() {
  return 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
}

function accountingBase() {
  return config().environment === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
}

function basicAuthorization() {
  const c = config();
  return 'Basic ' + Buffer.from(c.clientId + ':' + c.clientSecret).toString('base64');
}

async function exchange(params: URLSearchParams): Promise<TokenSet> {
  const response = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: {
      Authorization: basicAuthorization(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token || !data.refresh_token) {
    throw new Error(data.error_description || data.error || 'QuickBooks authorization failed.');
  }
  return data as TokenSet;
}

async function saveConnection(context: Context, realmId: string, tokenSet: TokenSet, companyName = '') {
  const now = Date.now();
  const encrypted = await encryptTokens({
    accessToken: tokenSet.access_token,
    refreshToken: tokenSet.refresh_token,
  });
  const connection: StoredConnection = {
    realmId,
    connectedAt: new Date(now).toISOString(),
    companyName,
    encrypted,
    accessExpiresAt: new Date(now + Number(tokenSet.expires_in || 3600) * 1000).toISOString(),
    refreshExpiresAt: tokenSet.x_refresh_token_expires_in
      ? new Date(now + Number(tokenSet.x_refresh_token_expires_in) * 1000).toISOString()
      : undefined,
  };
  await integrationStore(context).setJSON('quickbooks/connection', connection);
  return connection;
}

export async function getQuickBooksConnection(context: Context) {
  return await integrationStore(context).get('quickbooks/connection', { type: 'json' }) as StoredConnection | null;
}

export async function disconnectQuickBooks(context: Context) {
  await integrationStore(context).delete('quickbooks/connection');
}

export async function createOAuthState(context: Context, requestUrl: string) {
  const c = config();
  if (!c.clientId || !c.clientSecret || !c.encryptionKey) {
    throw new Error('QuickBooks environment variables are not configured.');
  }
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const state = Buffer.from(bytes).toString('base64url');
  const origin = new URL(requestUrl).origin;
  const redirectUri = String(process.env.QBO_REDIRECT_URI || '').trim() || origin + '/api/admin/quickbooks/callback';

  await integrationStore(context).setJSON('quickbooks/oauth-state/' + state, {
    createdAt: new Date().toISOString(),
    redirectUri,
  });

  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: redirectUri,
    state,
  });
  return {
    url: 'https://appcenter.intuit.com/connect/oauth2?' + params.toString(),
    redirectUri,
  };
}

export async function completeOAuth(context: Context, requestUrl: string) {
  const url = new URL(requestUrl);
  const code = String(url.searchParams.get('code') || '');
  const state = String(url.searchParams.get('state') || '');
  const realmId = String(url.searchParams.get('realmId') || '');
  if (!code || !state || !realmId) throw new Error('QuickBooks callback is missing authorization data.');

  const store = integrationStore(context);
  const stateRecord: any = await store.get('quickbooks/oauth-state/' + state, { type: 'json' });
  if (!stateRecord) throw new Error('QuickBooks authorization state is invalid or expired.');
  await store.delete('quickbooks/oauth-state/' + state);

  const created = new Date(stateRecord.createdAt || '').getTime();
  if (!created || Date.now() - created > 20 * 60 * 1000) {
    throw new Error('QuickBooks authorization state expired.');
  }

  const redirectUri = String(stateRecord.redirectUri || '');
  const tokenSet = await exchange(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  }));

  const connection = await saveConnection(context, realmId, tokenSet);
  const company = await qboRequest(context, '/v3/company/' + encodeURIComponent(realmId) + '/companyinfo/' + encodeURIComponent(realmId), { method: 'GET' });
  const companyName = String(company?.CompanyInfo?.CompanyName || company?.CompanyInfo?.LegalName || '');
  if (companyName) {
    connection.companyName = companyName;
    await store.setJSON('quickbooks/connection', connection);
  }
  return connection;
}

async function accessToken(context: Context) {
  const connection = await getQuickBooksConnection(context);
  if (!connection) throw new Error('QuickBooks is not connected.');
  let tokens = await decryptTokens(connection);
  const expiresAt = new Date(connection.accessExpiresAt).getTime();

  if (!expiresAt || expiresAt - Date.now() < 5 * 60 * 1000) {
    const refreshed = await exchange(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }));
    const updated = await saveConnection(
      context,
      connection.realmId,
      {
        ...refreshed,
        refresh_token: refreshed.refresh_token || tokens.refreshToken,
      },
      connection.companyName || '',
    );
    tokens = await decryptTokens(updated);
    return { connection: updated, accessToken: tokens.accessToken };
  }

  return { connection, accessToken: tokens.accessToken };
}

export async function qboRequest(context: Context, path: string, init: RequestInit = {}) {
  const auth = await accessToken(context);
  const run = async (token: string) => {
    const response = await fetch(accountingBase() + path, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
    const data: any = await response.json().catch(() => ({}));
    return { response, data };
  };

  let result = await run(auth.accessToken);
  if (result.response.status === 401) {
    const connection = await getQuickBooksConnection(context);
    if (!connection) throw new Error('QuickBooks is not connected.');
    const tokens = await decryptTokens(connection);
    const refreshed = await exchange(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }));
    const updated = await saveConnection(
      context,
      connection.realmId,
      {
        ...refreshed,
        refresh_token: refreshed.refresh_token || tokens.refreshToken,
      },
      connection.companyName || '',
    );
    const nextTokens = await decryptTokens(updated);
    result = await run(nextTokens.accessToken);
  }

  if (!result.response.ok || result.data?.Fault) {
    const errors = result.data?.Fault?.Error || [];
    const detail = Array.isArray(errors)
      ? errors.map((entry: any) => entry?.Detail || entry?.Message).filter(Boolean).join(' · ')
      : '';
    throw new Error(detail || 'QuickBooks API request failed.');
  }
  return result.data;
}

export async function qboQuery(context: Context, query: string) {
  const connection = await getQuickBooksConnection(context);
  if (!connection) throw new Error('QuickBooks is not connected.');
  return qboRequest(
    context,
    '/v3/company/' + encodeURIComponent(connection.realmId) + '/query?query=' + encodeURIComponent(query),
    { method: 'GET' },
  );
}

export async function qboCreate(context: Context, entity: string, payload: any) {
  const connection = await getQuickBooksConnection(context);
  if (!connection) throw new Error('QuickBooks is not connected.');
  return qboRequest(
    context,
    '/v3/company/' + encodeURIComponent(connection.realmId) + '/' + entity.toLowerCase(),
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export async function qboUpdate(context: Context, entity: string, payload: any) {
  const connection = await getQuickBooksConnection(context);
  if (!connection) throw new Error('QuickBooks is not connected.');
  return qboRequest(
    context,
    '/v3/company/' + encodeURIComponent(connection.realmId) + '/' + entity.toLowerCase() + '?operation=update',
    { method: 'POST', body: JSON.stringify({ ...payload, sparse: true }) },
  );
}

export async function qboGet(context: Context, entity: string, entityId: string) {
  const connection = await getQuickBooksConnection(context);
  if (!connection) throw new Error('QuickBooks is not connected.');
  return qboRequest(
    context,
    '/v3/company/' + encodeURIComponent(connection.realmId) + '/' + entity.toLowerCase() + '/' + encodeURIComponent(entityId),
    { method: 'GET' },
  );
}

export async function qboSend(context: Context, entity: 'invoice' | 'estimate', entityId: string, email: string) {
  const connection = await getQuickBooksConnection(context);
  if (!connection) throw new Error('QuickBooks is not connected.');
  const suffix = email ? '?sendTo=' + encodeURIComponent(email) : '';
  return qboRequest(
    context,
    '/v3/company/' + encodeURIComponent(connection.realmId) + '/' + entity + '/' + encodeURIComponent(entityId) + '/send' + suffix,
    { method: 'POST' },
  );
}

export function configuredServiceItemId() {
  return config().itemId;
}
