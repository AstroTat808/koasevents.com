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
