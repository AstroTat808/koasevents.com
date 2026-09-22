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
  const jobTitle = clean(metadata?.job_title || metadata?.jobTitle || '',120);
  const pronouns = clean(metadata?.pronouns || '',80);
  const roleDescription = clean(metadata?.role_description || metadata?.roleDescription || '',220);
  const photoUrl = metadata?.has_profile_photo===true
    ? '/api/staff/photo/'+encodeURIComponent(clean(ctx.user?.id,120))+(metadata?.profile_photo_version?'?v='+encodeURIComponent(clean(metadata.profile_photo_version,80)):'')
    : '';
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
    jobTitle,
    pronouns,
    roleDescription,
    photoUrl,
    signature:{
      showTitle:metadata?.signature_show_title!==false,
      showTeamTitle:metadata?.signature_show_team_title!==false,
      showPronouns:metadata?.signature_show_pronouns===true,
      showRoleDescription:metadata?.signature_show_role_description===true,
    },
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
