import { getUser } from '@netlify/identity';

const ADMIN_EMAILS = new Set([
  'chris@sibel.org',
  'koasadmin@koasevents.com',
]);

function normalizedRoles(user: any) {
  const sources = [
    user?.roles,
    user?.app_metadata?.roles,
    user?.appMetadata?.roles,
  ];
  const roles = sources.find(Array.isArray) || [];
  return roles.map((role: unknown) => String(role || '').trim().toLowerCase()).filter(Boolean);
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

export async function requireOperations() {
  const user = await getUser();
  if (!isApprovedOperationsUser(user)) {
    return { user: null, response: new Response('Unauthorized', { status: 401 }) };
  }
  return { user, response: null };
}
