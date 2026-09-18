import { getUser } from '@netlify/identity';

export async function requireAdmin() {
  const user = await getUser();
  const roles = user?.app_metadata?.roles || [];
  if (!user || !Array.isArray(roles) || !roles.includes('admin')) {
    return { user: null, response: new Response('Unauthorized', { status: 401 }) };
  }
  return { user, response: null };
}
