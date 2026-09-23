import { getStore } from '@netlify/blobs';
import { admin, getUser } from '@netlify/identity';
import { managedSessionStatus } from './auth-security';
import { defaultTenantConfig } from './tenant-config';

const ADMIN_EMAILS = new Set([
  'chris@sibel.org',
  'koasadmin@koasevents.com',
]);

export const ROLE_IDS = [
  'admin',
  'manager',
  'sales',
  'event_coordinator',
  'vendor_manager',
  'content_editor',
  'accounting',
  'read_only',
] as const;

export type StaffRole = (typeof ROLE_IDS)[number];
export type EffectiveStaffRole = StaffRole | 'custom';

export const STAFF_CAPABILITIES = [
  'admin.dashboard.view',
  'users.manage',
  'crm.view',
  'crm.manage',
  'crm.destructive',
  'crm.workflows',
  'crm.templates',
  'crm.cleanup_policy',
  'sales.view',
  'sales.manage',
  'sales.profit_settings',
  'events.view',
  'event_ops.manage',
  'calendar.view',
  'quickbooks.view',
  'quickbooks.manage',
  'vendors.view',
  'vendors.manage',
  'insurance.view',
  'insurance.manage',
  'blog.view',
  'blog.manage',
  'gallery.view',
  'gallery.manage',
  'seo.view',
  'seo.manage',
  'security.view',
  'security.manage',
  'health.view',
  'health.manage',
] as const;

export type StaffCapability = (typeof STAFF_CAPABILITIES)[number];

export const ROLE_LABELS: Record<StaffRole,string> = {
  admin: 'Administrator',
  manager: 'Manager',
  sales: 'Sales Rep',
  event_coordinator: 'Event Coordinator',
  vendor_manager: 'Vendor Manager',
  content_editor: 'Content Editor',
  accounting: 'Accounting',
  read_only: 'Read Only',
};

const ALL_CAPABILITIES = [...STAFF_CAPABILITIES];

export const ROLE_CAPABILITIES: Record<StaffRole, StaffCapability[]> = {
  admin: ALL_CAPABILITIES,
  manager: [
    'crm.view','crm.manage','crm.destructive','crm.workflows','crm.templates','crm.cleanup_policy',
    'sales.view','sales.manage','sales.profit_settings',
    'events.view','event_ops.manage','calendar.view',
    'quickbooks.view',
    'vendors.view','vendors.manage',
    'insurance.view','insurance.manage',
    'blog.view','blog.manage',
    'health.view',
  ],
  sales: [
    'crm.view','crm.manage',
    'sales.view','sales.manage',
    'calendar.view',
  ],
  event_coordinator: [
    'crm.view',
    'sales.view',
    'events.view','event_ops.manage',
    'calendar.view',
    'vendors.view',
    'insurance.view','insurance.manage',
  ],
  vendor_manager: [
    'crm.view',
    'events.view',
    'calendar.view',
    'vendors.view','vendors.manage',
    'insurance.view','insurance.manage',
  ],
  content_editor: [
    'blog.view','blog.manage',
    'gallery.view','gallery.manage',
    'seo.view','seo.manage',
  ],
  accounting: [
    'crm.view',
    'sales.view',
    'calendar.view',
    'quickbooks.view','quickbooks.manage',
  ],
  read_only: [
    'crm.view',
    'sales.view',
    'events.view',
    'calendar.view',
    'quickbooks.view',
    'vendors.view',
    'insurance.view',
    'blog.view',
    'gallery.view',
    'seo.view',
    'health.view',
  ],
};

export const PAGE_CAPABILITIES = {
  '/admin/': 'admin.dashboard.view',
  '/admin/staff/': 'users.manage',
  '/admin/crm/': 'crm.view',
  '/admin/email-preview/': 'crm.view',
  '/admin/quotes/': 'sales.view',
  '/admin/events/': 'events.view',
  '/admin/calendar/': 'calendar.view',
  '/admin/quickbooks/': 'quickbooks.view',
  '/admin/vendors/': 'vendors.view',
  '/admin/insurance/': 'insurance.view',
  '/admin/blog/': 'blog.view',
  '/admin/gallery/': 'gallery.view',
  '/admin/seo/': 'seo.view',
  '/admin/security/': 'security.view',
  '/admin/health/': 'health.view',
} as const;

export type AuthSecurityPolicy = {
  passwordExpiryDays: number;
  requireChangeOnAdminSet: boolean;
  updatedAt: string;
  updatedBy: string;
};

export const DEFAULT_AUTH_SECURITY_POLICY: AuthSecurityPolicy = {
  passwordExpiryDays: 180,
  requireChangeOnAdminSet: true,
  updatedAt: '',
  updatedBy: '',
};

function securityStore() {
  return getStore({ name:defaultTenantConfig().legacyStores.authSecurity, consistency:'strong' });
}

function clean(value: unknown, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function normalizeRoleValue(value: unknown) {
  return clean(value, 60).toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
}

function metadataFor(user: any) {
  return user?.appMetadata || user?.app_metadata || {};
}

function normalizedRoles(user: any) {
  const sources = [user?.roles, user?.app_metadata?.roles, user?.appMetadata?.roles];
  const roles = sources.find(Array.isArray) || [];
  return roles.map((role: unknown) => normalizeRoleValue(role)).filter(Boolean);
}

function normalizedPermissions(user: any) {
  const sources = [
    user?.app_metadata?.permissions,
    user?.appMetadata?.permissions,
  ];
  const permissions = sources.find(Array.isArray) || [];
  return new Set(
    permissions
      .map((permission: unknown) => clean(permission, 100).toLowerCase())
      .filter((permission: string) => STAFF_CAPABILITIES.includes(permission as StaffCapability)),
  );
}

function roleFromUser(user: any): EffectiveStaffRole | 'deactivated' | 'none' {
  if (!user) return 'none';
  const email = clean(user?.email, 240).toLowerCase();
  const meta = metadataFor(user);
  const roles = normalizedRoles(user);
  if (roles.includes('deactivated') || meta?.active === false) return 'deactivated';
  if (ADMIN_EMAILS.has(email)) return 'admin';

  const direct = normalizeRoleValue(user?.role);
  const candidates = [...roles, direct];
  for (const role of ROLE_IDS) {
    if (candidates.includes(role)) return role;
  }

  if (candidates.includes('custom')) return 'custom';
  if (candidates.includes('staff')) return 'sales';
  return 'none';
}

export function isApprovedAdmin(user: any) {
  return roleFromUser(user) === 'admin';
}

export function isApprovedManager(user: any) {
  const role = roleFromUser(user);
  return role === 'admin' || role === 'manager';
}

export function isApprovedOperationsUser(user: any) {
  const role = roleFromUser(user);
  return role !== 'none' && role !== 'deactivated';
}

export function operationsRole(user: any) {
  return roleFromUser(user);
}

export function customRoleIdFor(user:any) {
  return clean(metadataFor(user)?.customRoleId, 100);
}

export function capabilitiesFor(user: any) {
  const role = roleFromUser(user);
  if (role === 'none' || role === 'deactivated') return [];
  const defaults = role === 'custom' ? [] : (ROLE_CAPABILITIES[role as StaffRole] || []);
  const explicit = normalizedPermissions(user);
  return [...new Set([...defaults, ...explicit])];
}

export function hasCapability(user: any, capability: StaffCapability) {
  return capabilitiesFor(user).includes(capability);
}

export async function readAuthSecurityPolicy(): Promise<AuthSecurityPolicy> {
  try {
    const saved = await securityStore().get('policy', { type:'json' }) as Partial<AuthSecurityPolicy> | null;
    const days = Number(saved?.passwordExpiryDays);
    return {
      passwordExpiryDays: Number.isFinite(days) && days >= 0 && days <= 3650
        ? Math.round(days)
        : DEFAULT_AUTH_SECURITY_POLICY.passwordExpiryDays,
      requireChangeOnAdminSet: saved?.requireChangeOnAdminSet !== false,
      updatedAt: clean(saved?.updatedAt, 80),
      updatedBy: clean(saved?.updatedBy, 240),
    };
  } catch {
    return { ...DEFAULT_AUTH_SECURITY_POLICY };
  }
}

export async function saveAuthSecurityPolicy(input: Partial<AuthSecurityPolicy>, actor: string) {
  const days = Math.max(0, Math.min(3650, Math.round(Number(input?.passwordExpiryDays ?? DEFAULT_AUTH_SECURITY_POLICY.passwordExpiryDays))));
  const policy: AuthSecurityPolicy = {
    passwordExpiryDays: days,
    requireChangeOnAdminSet: input?.requireChangeOnAdminSet !== false,
    updatedAt: new Date().toISOString(),
    updatedBy: clean(actor, 240),
  };
  await securityStore().setJSON('policy', policy);
  return policy;
}

function numberMeta(user: any, key: string) {
  const n = Number(metadataFor(user)?.[key] ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function isoMeta(user: any, key: string) {
  const value = clean(metadataFor(user)?.[key], 80);
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function basePasswordDate(user: any) {
  return isoMeta(user, 'passwordChangedAt')
    || clean(user?.confirmedAt || user?.confirmed_at, 80)
    || clean(user?.createdAt || user?.created_at, 80)
    || '';
}

export function passwordSecurityFor(user: any, sessionUser: any, policy: AuthSecurityPolicy) {
  const passwordChangedAt = isoMeta(user, 'passwordChangedAt');
  const baseline = basePasswordDate(user);
  const baselineMs = baseline ? Date.parse(baseline) : NaN;
  const expiryMs = policy.passwordExpiryDays > 0 && Number.isFinite(baselineMs)
    ? baselineMs + policy.passwordExpiryDays * 24 * 60 * 60 * 1000
    : NaN;
  const passwordExpiresAt = Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : '';
  const passwordExpired = Boolean(passwordExpiresAt && Date.now() >= Date.parse(passwordExpiresAt));
  const forcePasswordChange = metadataFor(user)?.forcePasswordChange === true;
  const authoritativeSessionVersion = numberMeta(user, 'sessionVersion');
  const tokenSessionVersion = numberMeta(sessionUser, 'sessionVersion');
  const sessionRevoked = authoritativeSessionVersion !== tokenSessionVersion;

  return {
    forcePasswordChange,
    passwordChangedAt,
    passwordExpiresAt,
    passwordExpired,
    passwordExpiryDays: policy.passwordExpiryDays,
    sessionVersion: authoritativeSessionVersion,
    tokenSessionVersion,
    sessionRevoked,
  };
}

export async function getAccessContext(req?:Request) {
  const sessionUser = await getUser();
  if (!sessionUser) {
    return {
      sessionUser:null,
      user:null,
      role:'none' as const,
      capabilities:[] as StaffCapability[],
      policy:await readAuthSecurityPolicy(),
      security:null,
    };
  }

  let authoritativeUser: any = sessionUser;
  try {
    if (sessionUser?.id) authoritativeUser = await admin.getUser(sessionUser.id);
  } catch {
    authoritativeUser = sessionUser;
  }

  const policy = await readAuthSecurityPolicy();
  const role = roleFromUser(authoritativeUser);
  const capabilities = capabilitiesFor(authoritativeUser);
  const security = passwordSecurityFor(authoritativeUser, sessionUser, policy);
  const managedSession = req && authoritativeUser?.id ? await managedSessionStatus(req,String(authoritativeUser.id)) : null;
  if(managedSession?.revoked) security.sessionRevoked = true;

  return {
    sessionUser,
    user:authoritativeUser,
    role,
    capabilities,
    policy,
    security,
  };
}

function blockedResponse(ctx: Awaited<ReturnType<typeof getAccessContext>>) {
  if (!ctx.sessionUser || !ctx.user) {
    return new Response('Unauthorized', { status:401 });
  }
  if (ctx.role === 'deactivated' || ctx.role === 'none') {
    return Response.json({ error:'Account access is disabled.', code:'account_disabled' }, { status:403 });
  }
  if (ctx.security?.sessionRevoked) {
    return Response.json({ error:'This session has been revoked. Sign in again.', code:'session_revoked' }, { status:401 });
  }
  if (ctx.security?.forcePasswordChange || ctx.security?.passwordExpired) {
    return Response.json({
      error:ctx.security.passwordExpired ? 'Your password has expired.' : 'A password change is required.',
      code:'password_change_required',
      security:ctx.security,
    }, { status:428 });
  }
  return null;
}

export async function requireAdmin(req?:Request) {
  const ctx = await getAccessContext(req);
  const blocked = blockedResponse(ctx);
  if (blocked) return { user:null, response:blocked };
  if (ctx.role !== 'admin') {
    return { user:null, response:new Response('Unauthorized', { status:401 }) };
  }
  return { user:ctx.user, response:null };
}

export async function requireManager(req?:Request) {
  const ctx = await getAccessContext(req);
  const blocked = blockedResponse(ctx);
  if (blocked) return { user:null, response:blocked };
  if (!['admin','manager'].includes(ctx.role)) {
    return { user:null, response:new Response('Forbidden', { status:403 }) };
  }
  return { user:ctx.user, response:null };
}

export async function requireCapability(capability: StaffCapability, req?:Request) {
  const ctx = await getAccessContext(req);
  const blocked = blockedResponse(ctx);
  if (blocked) return { user:null, response:blocked };
  if (!ctx.capabilities.includes(capability)) {
    return { user:null, response:new Response('Forbidden', { status:403 }) };
  }
  return { user:ctx.user, response:null };
}

export async function requireOperations(req?:Request) {
  const ctx = await getAccessContext(req);
  const blocked = blockedResponse(ctx);
  if (blocked) return { user:null, response:blocked };
  if (ctx.role === 'none' || ctx.role === 'deactivated') {
    return { user:null, response:new Response('Unauthorized', { status:401 }) };
  }
  return { user:ctx.user, response:null };
}
