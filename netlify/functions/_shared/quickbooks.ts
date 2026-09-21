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

function env(...names: string[]) {
  for (const name of names) {
    const value = String(Netlify.env.get(name) || '').trim();
    if (value) return value;
  }
  return '';
}

function config() {
  const rawEnvironment = env('QUICKBOOKS_ENVIRONMENT', 'QBO_ENVIRONMENT') || 'production';
  const environment = rawEnvironment.toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
  const clientId = environment === 'sandbox'
    ? env('QUICKBOOKS_SANDBOX_CLIENT_ID', 'QUICKBOOKS_CLIENT_ID', 'INTUIT_CLIENT_ID')
    : env('QUICKBOOKS_PRODUCTION_CLIENT_ID', 'QUICKBOOKS_CLIENT_ID', 'INTUIT_CLIENT_ID');
  const clientSecret = environment === 'sandbox'
    ? env('QUICKBOOKS_SANDBOX_CLIENT_SECRET', 'QUICKBOOKS_CLIENT_SECRET', 'INTUIT_CLIENT_SECRET')
    : env('QUICKBOOKS_PRODUCTION_CLIENT_SECRET', 'QUICKBOOKS_CLIENT_SECRET', 'INTUIT_CLIENT_SECRET');
  const encryptionKey = env('QUICKBOOKS_TOKEN_ENCRYPTION_KEY', 'QBO_TOKEN_ENCRYPTION_KEY');
  const itemId = env('QUICKBOOKS_SERVICE_ITEM_ID', 'QBO_SERVICE_ITEM_ID');
  const redirectUri = environment === 'sandbox'
    ? env('QUICKBOOKS_SANDBOX_REDIRECT_URI', 'QUICKBOOKS_REDIRECT_URI', 'QBO_REDIRECT_URI')
    : env('QUICKBOOKS_PRODUCTION_REDIRECT_URI', 'QUICKBOOKS_REDIRECT_URI', 'QBO_REDIRECT_URI');
  const webhookVerifierToken = environment === 'sandbox'
    ? env('QUICKBOOKS_SANDBOX_WEBHOOK_VERIFIER_TOKEN', 'QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN', 'INTUIT_WEBHOOK_VERIFIER_TOKEN')
    : env('QUICKBOOKS_PRODUCTION_WEBHOOK_VERIFIER_TOKEN', 'QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN', 'INTUIT_WEBHOOK_VERIFIER_TOKEN');
  return { clientId, clientSecret, encryptionKey, environment, itemId, redirectUri, webhookVerifierToken };
}

export function quickBooksConfiguration() {
  const c = config();
  return {
    configured: Boolean(c.clientId && c.clientSecret),
    clientIdConfigured: Boolean(c.clientId),
    clientSecretConfigured: Boolean(c.clientSecret),
    encryptionKeyConfigured: Boolean(c.encryptionKey || c.clientSecret),
    serviceItemConfigured: Boolean(c.itemId),
    webhookVerifierConfigured: Boolean(c.webhookVerifierToken),
    redirectUriConfigured: Boolean(c.redirectUri),
    redirectUri: c.redirectUri,
    environment: c.environment,
    productionCredentialsConfigured: Boolean(
      env('QUICKBOOKS_PRODUCTION_CLIENT_ID') &&
      env('QUICKBOOKS_PRODUCTION_CLIENT_SECRET')
    ),
    productionWebhookConfigured: Boolean(env('QUICKBOOKS_PRODUCTION_WEBHOOK_VERIFIER_TOKEN')),
    productionRedirectConfigured: Boolean(env('QUICKBOOKS_PRODUCTION_REDIRECT_URI') || env('QUICKBOOKS_REDIRECT_URI', 'QBO_REDIRECT_URI')),
    sandboxCredentialsConfigured: Boolean(
      env('QUICKBOOKS_SANDBOX_CLIENT_ID', 'QUICKBOOKS_CLIENT_ID', 'INTUIT_CLIENT_ID') &&
      env('QUICKBOOKS_SANDBOX_CLIENT_SECRET', 'QUICKBOOKS_CLIENT_SECRET', 'INTUIT_CLIENT_SECRET')
    ),
  };
}

async function encryptionBytes() {
  const c = config();
  if (c.encryptionKey) {
    const bytes = Buffer.from(c.encryptionKey, 'base64');
    if (bytes.length !== 32) {
      throw new Error('QUICKBOOKS_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
    }
    return bytes;
  }
  if (!c.clientSecret) {
    throw new Error('QUICKBOOKS_CLIENT_SECRET is required for QuickBooks token encryption.');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(c.clientSecret));
  return new Uint8Array(digest);
}

async function keyFromBytes(bytes: Uint8Array, usages: KeyUsage[]) {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usages);
}

async function encryptionKey(usages: KeyUsage[]) {
  return keyFromBytes(await encryptionBytes(), usages);
}

async function legacyEncryptionKey(usages: KeyUsage[]) {
  const c = config();
  if (!c.clientSecret) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(c.clientSecret));
  return keyFromBytes(new Uint8Array(digest), usages);
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
  const iv = Buffer.from(connection.encrypted.iv, 'base64');
  const cipher = Buffer.from(connection.encrypted.data, 'base64');

  const decryptWith = async (key: CryptoKey) => {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    const parsed = JSON.parse(new TextDecoder().decode(plain));
    return {
      accessToken: String(parsed.accessToken || ''),
      refreshToken: String(parsed.refreshToken || ''),
    };
  };

  try {
    return await decryptWith(await encryptionKey(['decrypt']));
  } catch (error) {
    const c = config();
    if (!c.encryptionKey) throw error;
    const legacyKey = await legacyEncryptionKey(['decrypt']);
    if (!legacyKey) throw error;
    return await decryptWith(legacyKey);
  }
}

function tokenEndpoint() {
  return 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
}

function revokeEndpoint() {
  return 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
}

async function revokeToken(token: string) {
  const response = await fetch(revokeEndpoint(), {
    method: 'POST',
    headers: {
      Authorization: basicAuthorization(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    const data: any = await response.json().catch(() => ({}));
    throw new Error(data.error_description || data.error || 'QuickBooks token revocation failed.');
  }
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

function connectionKey() {
  return 'quickbooks/connection/' + config().environment;
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
  await integrationStore(context).setJSON(connectionKey(), connection);
  return connection;
}

export async function getQuickBooksConnection(context: Context) {
  const store = integrationStore(context);
  const environmentSpecific = await store.get(connectionKey(), { type: 'json' }) as StoredConnection | null;
  if (environmentSpecific) return environmentSpecific;

  // Backward compatibility: the original sandbox connection used the legacy shared key.
  // Never reuse that legacy connection while production is active.
  if (config().environment === 'sandbox') {
    return await store.get('quickbooks/connection', { type: 'json' }) as StoredConnection | null;
  }
  return null;
}

export async function disconnectQuickBooks(context: Context) {
  const store = integrationStore(context);
  const connection = await getQuickBooksConnection(context);
  if (!connection) return;

  try {
    const tokens = await decryptTokens(connection);
    await revokeToken(tokens.refreshToken || tokens.accessToken);
  } finally {
    await store.delete(connectionKey());
    if (config().environment === 'sandbox') {
      await store.delete('quickbooks/connection');
    }
  }
}

function settingsKey() {
  return 'quickbooks/settings/' + config().environment;
}

export async function getQuickBooksSettings(context: Context) {
  const store = integrationStore(context);
  const environmentSpecific = await store.get(settingsKey(), { type: 'json' }) as any;
  if (environmentSpecific) return environmentSpecific;

  if (config().environment === 'sandbox') {
    const legacy = await store.get('quickbooks/settings', { type: 'json' }) as any;
    if (legacy) return legacy;
  }

  return {
    serviceItemId: '',
    serviceItemName: '',
  };
}

export async function saveQuickBooksSettings(context: Context, settings: { serviceItemId?: string; serviceItemName?: string }) {
  const clean = {
    serviceItemId: String(settings.serviceItemId || '').trim().slice(0, 80),
    serviceItemName: String(settings.serviceItemName || '').trim().slice(0, 240),
  };
  await integrationStore(context).setJSON(settingsKey(), clean);
  return clean;
}

export type QuickBooksCatalogItem = {
  id: string;
  name: string;
  description: string;
  category: 'service' | 'rental' | 'mileage' | 'fee';
  unitLabel: string;
  unitPrice: number;
  active: boolean;
  getExempt: boolean;
  quickBooksItemId: string;
  quickBooksItemName: string;
  quickBooksType: 'Service' | 'NonInventory';
  incomeAccountId: string;
  incomeAccountName: string;
  updatedAt: string;
};

export type QuickBooksGetSettings = {
  enabled: boolean;
  label: string;
  statutoryRate: number;
  customerRate: number;
  maxPassOnRate: number;
  quickBooksItemId: string;
  quickBooksItemName: string;
};

export type QuickBooksDepositSettings = {
  defaultPercent: number;
  venueWeddingPercent: number;
  mobileBarPercent: number;
  privateEventPercent: number;
  venueWeddingSecondDueDaysBefore: number;
  venueWeddingFinalDueDaysBefore: number;
  mobileBarFinalDueDaysBefore: number;
  privateEventFinalDueDaysBefore: number;
  defaultFinalDueDaysBefore: number;
  updatedAt: string;
};

function catalogKey() {
  return 'quickbooks/catalog/' + config().environment;
}

function getSettingsKey() {
  return 'quickbooks/get-settings/' + config().environment;
}

function depositSettingsKey() {
  return 'quickbooks/deposit-settings/' + config().environment;
}

function cleanDepositPercent(value: unknown, fallback = 10) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed * 1000) / 1000));
}

function cleanDueDays(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(730, Math.max(0, Math.round(parsed)));
}

export async function getQuickBooksDepositSettings(context: Context): Promise<QuickBooksDepositSettings> {
  const stored = await integrationStore(context).get(depositSettingsKey(), { type: 'json' }) as any;
  return {
    defaultPercent: cleanDepositPercent(stored?.defaultPercent, 10),
    venueWeddingPercent: cleanDepositPercent(stored?.venueWeddingPercent, 10),
    mobileBarPercent: cleanDepositPercent(stored?.mobileBarPercent, 10),
    privateEventPercent: cleanDepositPercent(stored?.privateEventPercent, 10),
    venueWeddingSecondDueDaysBefore: cleanDueDays(stored?.venueWeddingSecondDueDaysBefore, 90),
    venueWeddingFinalDueDaysBefore: cleanDueDays(stored?.venueWeddingFinalDueDaysBefore, 60),
    mobileBarFinalDueDaysBefore: cleanDueDays(stored?.mobileBarFinalDueDaysBefore, 14),
    privateEventFinalDueDaysBefore: cleanDueDays(stored?.privateEventFinalDueDaysBefore, 30),
    defaultFinalDueDaysBefore: cleanDueDays(stored?.defaultFinalDueDaysBefore, 30),
    updatedAt: String(stored?.updatedAt || ''),
  };
}

export async function saveQuickBooksDepositSettings(context: Context, settings: Partial<QuickBooksDepositSettings>) {
  const current = await getQuickBooksDepositSettings(context);
  const next: QuickBooksDepositSettings = {
    defaultPercent: cleanDepositPercent(settings.defaultPercent, current.defaultPercent),
    venueWeddingPercent: cleanDepositPercent(settings.venueWeddingPercent, current.venueWeddingPercent),
    mobileBarPercent: cleanDepositPercent(settings.mobileBarPercent, current.mobileBarPercent),
    privateEventPercent: cleanDepositPercent(settings.privateEventPercent, current.privateEventPercent),
    venueWeddingSecondDueDaysBefore: cleanDueDays(settings.venueWeddingSecondDueDaysBefore, current.venueWeddingSecondDueDaysBefore),
    venueWeddingFinalDueDaysBefore: cleanDueDays(settings.venueWeddingFinalDueDaysBefore, current.venueWeddingFinalDueDaysBefore),
    mobileBarFinalDueDaysBefore: cleanDueDays(settings.mobileBarFinalDueDaysBefore, current.mobileBarFinalDueDaysBefore),
    privateEventFinalDueDaysBefore: cleanDueDays(settings.privateEventFinalDueDaysBefore, current.privateEventFinalDueDaysBefore),
    defaultFinalDueDaysBefore: cleanDueDays(settings.defaultFinalDueDaysBefore, current.defaultFinalDueDaysBefore),
    updatedAt: new Date().toISOString(),
  };
  await integrationStore(context).setJSON(depositSettingsKey(), next);
  return next;
}

export async function getQuickBooksCatalog(context: Context): Promise<QuickBooksCatalogItem[]> {
  const stored = await integrationStore(context).get(catalogKey(), { type: 'json' }) as any;
  if (!Array.isArray(stored)) return [];
  return stored.map((item: any) => ({
    id: String(item?.id || '').trim().slice(0, 80),
    name: String(item?.name || '').trim().slice(0, 100),
    description: String(item?.description || '').trim().slice(0, 1000),
    category: ['rental','mileage','fee'].includes(String(item?.category || ''))
      ? String(item.category) as QuickBooksCatalogItem['category']
      : 'service',
    unitLabel: String(item?.unitLabel || 'each').trim().slice(0, 40),
    unitPrice: Math.max(0, Number(item?.unitPrice || 0)),
    active: item?.active !== false,
    getExempt: item?.getExempt === true,
    quickBooksItemId: String(item?.quickBooksItemId || '').trim().slice(0, 80),
    quickBooksItemName: String(item?.quickBooksItemName || item?.name || '').trim().slice(0, 100),
    quickBooksType: String(item?.quickBooksType || '') === 'NonInventory' ? 'NonInventory' : 'Service',
    incomeAccountId: String(item?.incomeAccountId || '').trim().slice(0, 80),
    incomeAccountName: String(item?.incomeAccountName || '').trim().slice(0, 160),
    updatedAt: String(item?.updatedAt || ''),
  })).filter((item: QuickBooksCatalogItem) => item.id && item.name);
}

export async function saveQuickBooksCatalog(context: Context, catalog: QuickBooksCatalogItem[]) {
  const cleanCatalog = (Array.isArray(catalog) ? catalog : []).slice(0, 500).map((item) => ({
    id: String(item.id || '').trim().slice(0, 80),
    name: String(item.name || '').trim().slice(0, 100),
    description: String(item.description || '').trim().slice(0, 1000),
    category: ['service','rental','mileage','fee'].includes(String(item.category || '')) ? item.category : 'service',
    unitLabel: String(item.unitLabel || 'each').trim().slice(0, 40),
    unitPrice: Math.max(0, Math.round(Number(item.unitPrice || 0) * 100) / 100),
    active: item.active !== false,
    getExempt: item.getExempt === true,
    quickBooksItemId: String(item.quickBooksItemId || '').trim().slice(0, 80),
    quickBooksItemName: String(item.quickBooksItemName || item.name || '').trim().slice(0, 100),
    quickBooksType: item.quickBooksType === 'NonInventory' ? 'NonInventory' : 'Service',
    incomeAccountId: String(item.incomeAccountId || '').trim().slice(0, 80),
    incomeAccountName: String(item.incomeAccountName || '').trim().slice(0, 160),
    updatedAt: String(item.updatedAt || new Date().toISOString()),
  })).filter((item) => item.id && item.name);
  await integrationStore(context).setJSON(catalogKey(), cleanCatalog);
  return cleanCatalog;
}

export async function getQuickBooksGetSettings(context: Context): Promise<QuickBooksGetSettings> {
  const stored = await integrationStore(context).get(getSettingsKey(), { type: 'json' }) as any;
  return {
    enabled: true,
    label: String(stored?.label || 'Hawaiʻi GET').trim().slice(0, 80),
    statutoryRate: 4.5,
    customerRate: 4.712,
    maxPassOnRate: 4.712,
    quickBooksItemId: String(stored?.quickBooksItemId || '').trim().slice(0, 80),
    quickBooksItemName: String(stored?.quickBooksItemName || '').trim().slice(0, 100),
  };
}

export async function saveQuickBooksGetSettings(context: Context, settings: Partial<QuickBooksGetSettings>) {
  const current = await getQuickBooksGetSettings(context);
  const next: QuickBooksGetSettings = {
    enabled: true,
    label: String(settings.label ?? current.label ?? 'Hawaiʻi GET').trim().slice(0, 80) || 'Hawaiʻi GET',
    statutoryRate: 4.5,
    customerRate: 4.712,
    maxPassOnRate: 4.712,
    quickBooksItemId: String(settings.quickBooksItemId ?? current.quickBooksItemId ?? '').trim().slice(0, 80),
    quickBooksItemName: String(settings.quickBooksItemName ?? current.quickBooksItemName ?? '').trim().slice(0, 100),
  };
  await integrationStore(context).setJSON(getSettingsKey(), next);
  return next;
}

export async function createOAuthState(context: Context, requestUrl: string) {
  const c = config();
  if (!c.clientId || !c.clientSecret) {
    throw new Error('QuickBooks environment variables are not configured.');
  }
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const state = Buffer.from(bytes).toString('base64url');
  const origin = new URL(requestUrl).origin;
  const redirectUri = c.redirectUri || origin + '/.netlify/functions/quickbooks-callback';

  await integrationStore(context).setJSON('quickbooks/oauth-state/' + state, {
    createdAt: new Date().toISOString(),
    redirectUri,
    environment: c.environment,
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
  if (String(stateRecord.environment || '') && String(stateRecord.environment) !== config().environment) {
    throw new Error('QuickBooks environment changed during authorization. Start the connection again.');
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
    await store.setJSON(connectionKey(), connection);
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
    '/v3/company/' + encodeURIComponent(connection.realmId) + '/' + entity.toLowerCase(),
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

export async function qboOperation(
  context: Context,
  entity: string,
  entityId: string,
  syncToken: string,
  operation: 'delete' | 'void',
) {
  const connection = await getQuickBooksConnection(context);
  if (!connection) throw new Error('QuickBooks is not connected.');
  const path = '/v3/company/' + encodeURIComponent(connection.realmId) + '/' +
    entity.toLowerCase() + '?operation=' + encodeURIComponent(operation);
  return qboRequest(context, path, {
    method: 'POST',
    body: JSON.stringify({ Id: entityId, SyncToken: syncToken }),
  });
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


export function quickBooksWebhookVerifierToken() {
  return config().webhookVerifierToken;
}
