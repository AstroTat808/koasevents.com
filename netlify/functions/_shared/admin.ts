import { getUser } from '@netlify/identity';

const ADMIN_EMAILS = new Set([
  'chris@sibel.org',
  'koasadmin@koasevents.com',
]);

export function isApprovedAdmin(user: any) {
  if (!user) return false;
  const email = String(user.email || '').trim().toLowerCase();
  const roles = user?.app_metadata?.roles || [];
  return (
    ADMIN_EMAILS.has(email) ||
    (Array.isArray(roles) && roles.includes('admin'))
  );
}

export async function requireAdmin() {
  const user = await getUser();
  if (!isApprovedAdmin(user)) {
    return { user: null, response: new Response('Unauthorized', { status: 401 }) };
  }
  return { user, response: null };
}

const OPERATIONS_ROLES = new Set(['staff', 'sales', 'manager']);

export function isApprovedOperationsUser(user: any) {
  if (!user) return false;
  if (isApprovedAdmin(user)) return true;
  const roles = user?.app_metadata?.roles || [];
  return Array.isArray(roles) && roles.some((role: unknown) => OPERATIONS_ROLES.has(String(role || '').trim().toLowerCase()));
}

export async function requireOperations() {
  const user = await getUser();
  if (!isApprovedOperationsUser(user)) {
    return { user: null, response: new Response('Unauthorized', { status: 401 }) };
  }
  return { user, response: null };
}
