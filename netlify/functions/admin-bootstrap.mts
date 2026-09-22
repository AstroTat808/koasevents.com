import type { Context, Config } from '@netlify/functions';
import { admin, requestPasswordRecovery } from '@netlify/identity';

const APPROVED_ADMIN_EMAILS = new Set([
  'chris@sibel.org',
  'koasadmin@koasevents.com',
]);

function clean(value: unknown, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function normalizeEmail(value: unknown) {
  return clean(value, 240).toLowerCase();
}

function randomPassword() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
  return 'Koa!' + raw.slice(0, 24) + '9a';
}

function metadataFor(user: any) {
  return user?.appMetadata || user?.app_metadata || {};
}

function rolesFor(user: any) {
  const candidates = [user?.roles, user?.appMetadata?.roles, user?.app_metadata?.roles];
  const roles = candidates.find(Array.isArray) || [];
  return roles.map((role: any) => clean(role, 40).toLowerCase()).filter(Boolean);
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const origin = clean(req.headers.get('origin'), 300);
  if (!['https://koasevents.com', 'https://www.koasevents.com'].includes(origin)) {
    return Response.json({ error: 'This account setup request must come from the Koa’s Events admin page.' }, { status: 403 });
  }

  const body: any = await req.json().catch(() => null);
  const email = normalizeEmail(body?.email);

  if (!APPROVED_ADMIN_EMAILS.has(email)) {
    return Response.json(
      { error: 'This email is not approved for Koa’s administrator access.' },
      { status: 403 },
    );
  }

  const users = await admin.listUsers({ page: 1, perPage: 200 });
  const existing: any = users.find((user: any) => normalizeEmail(user?.email) === email);
  let created = false;

  if (existing) {
    const currentMetadata = metadataFor(existing);
    const roles = [...new Set([...rolesFor(existing).filter((role) => role !== 'deactivated'), 'admin'])];
    await admin.updateUser(existing.id, {
      role: 'admin',
      app_metadata: {
        ...currentMetadata,
        roles,
        active: true,
      },
    });
  } else {
    await admin.createUser({
      email,
      password: randomPassword(),
      data: {
        role: 'admin',
        app_metadata: {
          roles: ['admin'],
          active: true,
          permissions: [],
        },
        user_metadata: {
          full_name: email === 'chris@sibel.org' ? 'Chris Sibel' : 'Koa’s Admin',
        },
      },
    });
    created = true;
  }

  try {
    await requestPasswordRecovery(email);
  } catch (error) {
    console.error('Admin bootstrap recovery email failed', error);
    return Response.json(
      {
        error: 'The administrator account is ready, but the password setup email could not be sent. Try the setup button again in a moment.',
        accountReady: true,
      },
      { status: 502 },
    );
  }

  return Response.json(
    {
      ok: true,
      created,
      message: created
        ? 'Administrator account created. Check your email for the password setup link.'
        : 'Administrator access verified. Check your email for the password reset link.',
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
};

export const config: Config = { path: '/api/admin/bootstrap' };
