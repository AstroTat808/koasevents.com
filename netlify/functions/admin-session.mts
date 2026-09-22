import type { Config } from '@netlify/functions';
import { getAccessContext, isApprovedAdmin } from './_shared/admin';

function clean(value: unknown, max = 240) {
  return String(value || '').trim().slice(0, max);
}

export default async (req:Request) => {
  const ctx = await getAccessContext(req);
  if (!ctx.sessionUser || !ctx.user) return new Response('Unauthorized', { status:401 });

  const email = clean(ctx.user?.email,240).toLowerCase();
  const metadata = ctx.user?.user_metadata || ctx.user?.userMetadata || {};
  const displayName = clean(metadata?.full_name || metadata?.name || ctx.user?.name || '',120);
  const security = ctx.security || {
    forcePasswordChange:false,
    passwordChangedAt:'',
    passwordExpiresAt:'',
    passwordExpired:false,
    passwordExpiryDays:0,
    sessionVersion:0,
    tokenSessionVersion:0,
    sessionRevoked:false,
  };

  return Response.json({
    email,
    displayName,
    role:ctx.role,
    roles:[ctx.role],
    isAdmin:isApprovedAdmin(ctx.user),
    permissions:ctx.capabilities,
    capabilities:ctx.capabilities,
    accessBlocked:Boolean(
      ctx.role === 'none' ||
      ctx.role === 'deactivated' ||
      security.sessionRevoked ||
      security.forcePasswordChange ||
      security.passwordExpired
    ),
    blockReason:
      ctx.role === 'deactivated' || ctx.role === 'none' ? 'account_disabled'
      : security.sessionRevoked ? 'session_revoked'
      : security.passwordExpired ? 'password_expired'
      : security.forcePasswordChange ? 'password_change_required'
      : '',
    security,
    app_metadata:{roles:[ctx.role],permissions:ctx.capabilities},
    appMetadata:{roles:[ctx.role],permissions:ctx.capabilities},
  }, { headers:{'Cache-Control':'private, no-store'} });
};

export const config: Config = { path:'/api/admin/session' };
