import { getUser } from '@netlify/identity';

const ADMIN_EMAILS = new Set([
  'chris@sibel.org',
  'koasadmin@koasevents.com',
]);

export const STAFF_CAPABILITIES = [
  'blog.manage',
  'event_ops.manage',
  'crm.destructive',
  'crm.workflows',
  'crm.templates',
  'crm.cleanup_policy',
  'sales.profit_settings',
] as const;

export type StaffCapability = (typeof STAFF_CAPABILITIES)[number];

function normalizedRoles(user: any) {
  const sources = [user?.roles, user?.app_metadata?.roles, user?.appMetadata?.roles];
  const roles = sources.find(Array.isArray) || [];
  return roles.map((role: unknown) => String(role || '').trim().toLowerCase()).filter(Boolean);
}

function normalizedPermissions(user: any) {
  const sources = [
    user?.app_metadata?.permissions,
    user?.appMetadata?.permissions,
  ];
  const permissions = sources.find(Array.isArray) || [];
  return new Set(permissions.map((permission: unknown) => String(permission || '').trim().toLowerCase()).filter(Boolean));
}

export function isApprovedAdmin(user: any) {
  if (!user) return false;
  const email = String(user.email || '').trim().toLowerCase();
  const roles = normalizedRoles(user);
  return ADMIN_EMAILS.has(email) || roles.includes('admin');
}

export function isApprovedManager(user: any) {
  if (!user) return false;
  if (isApprovedAdmin(user)) return true;
  return normalizedRoles(user).includes('manager');
}

export function isApprovedOperationsUser(user: any) {
  if (!user) return false;
  if (isApprovedManager(user)) return true;
  const roles = normalizedRoles(user);
  return roles.includes('sales') || roles.includes('staff');
}

export function operationsRole(user: any) {
  if (isApprovedAdmin(user)) return 'admin';
  if (isApprovedManager(user)) return 'manager';
  const roles = normalizedRoles(user);
  if (roles.includes('sales') || roles.includes('staff')) return 'sales';
  return 'none';
}

export function hasCapability(user: any, capability: StaffCapability) {
  if (!user) return false;
  if (isApprovedAdmin(user) || isApprovedManager(user)) return true;
  return normalizedPermissions(user).has(capability);
}

export function capabilitiesFor(user: any) {
  if (isApprovedAdmin(user) || isApprovedManager(user)) return [...STAFF_CAPABILITIES];
  const permissions = normalizedPermissions(user);
  return STAFF_CAPABILITIES.filter((capability) => permissions.has(capability));
}

export async function requireAdmin() {
  const user = await getUser();
  if (!isApprovedAdmin(user)) {
    return { user: null, response: new Response('Unauthorized', { status: 401 }) };
  }
  return { user, response: null };
}

export async function requireManager() {
  const user = await getUser();
  if (!isApprovedManager(user)) {
    return { user: null, response: new Response('Forbidden', { status: 403 }) };
  }
  return { user, response: null };
}

export async function requireCapability(capability: StaffCapability) {
  const user = await getUser();
  if (!user) return { user: null, response: new Response('Unauthorized', { status: 401 }) };
  if (!hasCapability(user, capability)) {
    return { user: null, response: new Response('Forbidden', { status: 403 }) };
  }
  return { user, response: null };
}

export async function requireOperations() {
  const user = await getUser();
  if (!isApprovedOperationsUser(user)) {
    return { user: null, response: new Response('Unauthorized', { status: 401 }) };
  }
  return { user, response: null };
}
