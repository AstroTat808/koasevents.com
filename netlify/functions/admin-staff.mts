import type { Context, Config } from '@netlify/functions';
import { admin, requestPasswordRecovery } from '@netlify/identity';
import { requireAdmin, STAFF_CAPABILITIES } from './_shared/admin';
import { appendStaffAudit, readStaffAudit } from './_shared/staff-audit';

const PROTECTED_ADMIN_EMAILS = new Set(['chris@sibel.org','koasadmin@koasevents.com']);
const USER_ROLES = new Set(['sales','manager','admin']);

const CAPABILITY_LABELS: Record<string,string> = {
  'blog.manage':'Publish + manage Blog',
  'event_ops.manage':'Edit Event Ops',
  'crm.destructive':'Trash / restore CRM clients',
  'crm.workflows':'Manage CRM workflows',
  'crm.templates':'Manage CRM templates',
  'crm.cleanup_policy':'Change CRM cleanup policy',
  'sales.profit_settings':'Change sales profitability settings',
};

function clean(value: unknown, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function normalizeEmail(value: unknown) {
  return clean(value, 240).toLowerCase();
}

function strongTemporaryPassword() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
  return 'Koa!' + raw.slice(0, 28) + '9a';
}

function validatePassword(value: unknown) {
  const password = String(value ?? '');
  if (password.length < 10) return { ok:false, error:'Password must be at least 10 characters.' };
  if (password.length > 128) return { ok:false, error:'Password must be 128 characters or fewer.' };
  return { ok:true, password };
}

function metadataFor(user: any) {
  return user?.appMetadata || user?.app_metadata || {};
}

function rolesFor(user: any) {
  const candidates = [user?.roles, user?.appMetadata?.roles, user?.app_metadata?.roles];
  const roles = candidates.find(Array.isArray) || [];
  return roles.map((role: any) => clean(role, 40).toLowerCase()).filter(Boolean);
}

function permissionsFor(user: any) {
  const values = metadataFor(user)?.permissions;
  return Array.isArray(values)
    ? values
        .map((permission: any) => clean(permission, 80).toLowerCase())
        .filter((permission: string) => STAFF_CAPABILITIES.includes(permission as any))
    : [];
}

function isDeactivated(user: any) {
  return rolesFor(user).includes('deactivated') || metadataFor(user)?.active === false;
}

function effectiveRole(user: any) {
  const email = normalizeEmail(user?.email);
  if (PROTECTED_ADMIN_EMAILS.has(email)) return 'admin';
  if (isDeactivated(user)) return 'deactivated';
  const roles = rolesFor(user);
  const directRole = clean(user?.role, 40).toLowerCase();
  if (roles.includes('admin') || directRole === 'admin') return 'admin';
  if (roles.includes('manager') || directRole === 'manager') return 'manager';
  if (roles.includes('sales') || roles.includes('staff') || directRole === 'sales') return 'sales';
  return 'none';
}

function normalizedName(user: any) {
  return clean(
    user?.name ||
    user?.userMetadata?.full_name ||
    user?.user_metadata?.full_name,
    180,
  );
}

function normalizeUser(user: any) {
  const confirmedAt = clean(user?.confirmedAt || user?.confirmed_at, 80);
  return {
    id: clean(user?.id, 120),
    email: normalizeEmail(user?.email),
    name: normalizedName(user),
    role: effectiveRole(user),
    permissions: permissionsFor(user),
    active: !isDeactivated(user),
    status: isDeactivated(user) ? 'deactivated' : confirmedAt ? 'active' : 'pending',
    confirmedAt,
    createdAt: clean(user?.createdAt || user?.created_at, 80),
    updatedAt: clean(user?.updatedAt || user?.updated_at, 80),
    lastSignInAt: clean(user?.lastSignInAt || user?.last_sign_in_at, 80),
    protected: PROTECTED_ADMIN_EMAILS.has(normalizeEmail(user?.email)),
  };
}

function publicRoleLabel(role: string) {
  if (role === 'admin') return 'Administrator';
  if (role === 'manager') return 'Manager';
  if (role === 'sales') return 'Sales Rep';
  return role;
}

async function allUsers() {
  return await admin.listUsers({ page:1, perPage:200 });
}

function activeAdminCount(users: any[]) {
  return users.filter((user) => !isDeactivated(user) && effectiveRole(user) === 'admin').length;
}

function ensureCanModifyTarget(actor: any, target: any, action: string) {
  const actorEmail = normalizeEmail(actor?.email);
  const targetEmail = normalizeEmail(target?.email);
  const actorId = clean(actor?.id, 120);
  const targetId = clean(target?.id, 120);

  if (PROTECTED_ADMIN_EMAILS.has(targetEmail) && !PROTECTED_ADMIN_EMAILS.has(actorEmail)) {
    return 'Only a protected Koa’s administrator can modify another protected administrator account.';
  }

  if (actorId && actorId === targetId && ['deactivate','delete'].includes(action)) {
    return 'You cannot deactivate or delete the account you are currently using.';
  }

  return '';
}

export default async (req: Request, context: Context) => {
  const auth = await requireAdmin();
  if (auth.response) return auth.response;

  const actor = normalizeEmail(auth.user?.email) || 'admin';
  const actorId = clean(auth.user?.id, 120);

  if (req.method === 'GET') {
    const [users, audit] = await Promise.all([
      allUsers(),
      readStaffAudit(context, 500),
    ]);

    const normalized = users.map(normalizeUser).sort((a, b) => {
      const order: Record<string,number> = { admin:0, manager:1, sales:2, deactivated:3, none:4 };
      return (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.email.localeCompare(b.email);
    });

    return Response.json({
      users: normalized,
      audit,
      capabilities: STAFF_CAPABILITIES.map((id) => ({ id, label: CAPABILITY_LABELS[id] || id })),
      summary: {
        total: normalized.length,
        active: normalized.filter((user) => user.status === 'active').length,
        pending: normalized.filter((user) => user.status === 'pending').length,
        deactivated: normalized.filter((user) => user.status === 'deactivated').length,
        admins: normalized.filter((user) => user.role === 'admin' && user.status !== 'deactivated').length,
        managers: normalized.filter((user) => user.role === 'manager' && user.status !== 'deactivated').length,
        sales: normalized.filter((user) => user.role === 'sales' && user.status !== 'deactivated').length,
      },
    }, { headers:{'Cache-Control':'private, no-store'} });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status:405 });

  const body: any = await req.json().catch(() => null);
  if (!body) return Response.json({ error:'Invalid JSON.' }, { status:400 });

  const action = clean(body.action, 40);

  if (action === 'create-user' || action === 'invite') {
    const email = normalizeEmail(body.email);
    const name = clean(body.name, 180);
    const role = clean(body.role, 40).toLowerCase();
    const setupMode = clean(body.setupMode || 'email', 20).toLowerCase();

    if (!email.includes('@')) return Response.json({ error:'A valid email is required.' }, { status:400 });
    if (!name) return Response.json({ error:'Name is required.' }, { status:400 });
    if (!USER_ROLES.has(role)) return Response.json({ error:'Choose Sales Rep, Manager, or Administrator.' }, { status:400 });
    if (!['email','manual'].includes(setupMode)) return Response.json({ error:'Choose email setup or set password now.' }, { status:400 });

    const users = await allUsers();
    const existing = users.find((user: any) => normalizeEmail(user?.email) === email);
    if (existing) return Response.json({ error:'That email already has an account. Edit the existing user instead.' }, { status:409 });

    let password = strongTemporaryPassword();
    if (setupMode === 'manual') {
      const validation = validatePassword(body.password);
      if (!validation.ok) return Response.json({ error:validation.error }, { status:400 });
      password = validation.password!;
    }

    const created: any = await admin.createUser({
      email,
      password,
      data:{
        role,
        app_metadata:{ roles:[role], active:true, permissions:[] },
        user_metadata:{ full_name:name },
      },
    });

    let setupEmailSent = false;
    let setupEmailError = '';
    if (setupMode === 'email') {
      try {
        await requestPasswordRecovery(email);
        setupEmailSent = true;
      } catch (error) {
        setupEmailError = error instanceof Error ? clean(error.message, 500) : 'Password setup email failed.';
      }
    }

    await appendStaffAudit(context, {
      actor,
      action:'user_created',
      subjectId:clean(created?.id,120),
      subjectEmail:email,
      detail:'Created '+publicRoleLabel(role)+' account for '+email+'.',
      metadata:{ role, setupMode, setupEmailSent },
    });

    return Response.json({
      ok:true,
      user:normalizeUser(created),
      setupMode,
      setupEmailSent,
      setupEmailError,
      message: setupMode === 'email'
        ? (setupEmailSent ? 'Account created and password setup email sent.' : 'Account created, but the setup email could not be sent.')
        : 'Account created with the password you set.',
    });
  }

  const userId = clean(body.userId, 120);
  if (!userId) return Response.json({ error:'User ID required.' }, { status:400 });

  const current: any = await admin.getUser(userId);
  if (!current) return Response.json({ error:'User not found.' }, { status:404 });

  const email = normalizeEmail(current?.email);
  const guardError = ensureCanModifyTarget(auth.user, current, action);
  if (guardError) return Response.json({ error:guardError }, { status:403 });

  if (action === 'reset-password' || action === 'resend-setup') {
    await requestPasswordRecovery(email);
    await appendStaffAudit(context, {
      actor,
      action:'password_reset_sent',
      subjectId:userId,
      subjectEmail:email,
      detail:'Sent password setup/reset email to '+email+'.',
      metadata:{},
    });
    return Response.json({ ok:true, message:'Password setup/reset email sent.' });
  }

  if (action === 'set-password') {
    const validation = validatePassword(body.password);
    if (!validation.ok) return Response.json({ error:validation.error }, { status:400 });

    await admin.updateUser(userId, { password:validation.password });

    await appendStaffAudit(context, {
      actor,
      action:'password_set_by_admin',
      subjectId:userId,
      subjectEmail:email,
      detail:'Administrator set a new password for '+email+'.',
      metadata:{ actorId },
    });

    return Response.json({ ok:true, message:'Password updated.' });
  }

  if (action === 'set-name') {
    const name = clean(body.name, 180);
    if (!name) return Response.json({ error:'Name is required.' }, { status:400 });

    const updated: any = await admin.updateUser(userId, {
      user_metadata:{ ...(current?.userMetadata || current?.user_metadata || {}), full_name:name },
    });

    await appendStaffAudit(context, {
      actor,
      action:'user_name_changed',
      subjectId:userId,
      subjectEmail:email,
      detail:'Changed display name for '+email+' to '+name+'.',
      metadata:{ from:normalizedName(current), to:name },
    });

    return Response.json({ ok:true, user:normalizeUser(updated) });
  }

  if (action === 'set-role') {
    const role = clean(body.role, 40).toLowerCase();
    if (!USER_ROLES.has(role)) return Response.json({ error:'Choose Sales Rep, Manager, or Administrator.' }, { status:400 });

    const previous = effectiveRole(current);
    if (current?.id === actorId && role !== 'admin') {
      return Response.json({ error:'You cannot remove Administrator access from the account you are currently using.' }, { status:403 });
    }

    if (PROTECTED_ADMIN_EMAILS.has(email) && role !== 'admin') {
      return Response.json({ error:'Protected administrator accounts must remain Administrators.' }, { status:403 });
    }

    if (previous === 'admin' && role !== 'admin') {
      const users = await allUsers();
      if (activeAdminCount(users) <= 1) {
        return Response.json({ error:'At least one active Administrator account must remain.' }, { status:409 });
      }
    }

    const appMetadata = {
      ...metadataFor(current),
      roles:[role],
      active:true,
      previousRole:undefined,
      permissions:permissionsFor(current),
    };

    const updated: any = await admin.updateUser(userId, { role, app_metadata:appMetadata });

    await appendStaffAudit(context, {
      actor,
      action:'user_role_changed',
      subjectId:userId,
      subjectEmail:email,
      detail:'Changed role for '+email+' from '+previous+' to '+role+'.',
      metadata:{ from:previous, to:role },
    });

    return Response.json({ ok:true, user:normalizeUser(updated) });
  }

  if (action === 'set-permissions') {
    if (effectiveRole(current) === 'admin') {
      return Response.json({ error:'Administrators already have all permissions.' }, { status:400 });
    }

    const requested = Array.isArray(body.permissions)
      ? body.permissions.map((value: any) => clean(value,80).toLowerCase())
      : [];
    const permissions = [...new Set(requested.filter((value: string) => STAFF_CAPABILITIES.includes(value as any)))];
    const appMetadata = { ...metadataFor(current), permissions };
    const updated: any = await admin.updateUser(userId, { app_metadata:appMetadata });

    await appendStaffAudit(context, {
      actor,
      action:'user_permissions_changed',
      subjectId:userId,
      subjectEmail:email,
      detail:'Updated individual permissions for '+email+'.',
      metadata:{ from:permissionsFor(current), to:permissions },
    });

    return Response.json({ ok:true, user:normalizeUser(updated) });
  }

  if (action === 'deactivate') {
    if (PROTECTED_ADMIN_EMAILS.has(email)) {
      return Response.json({ error:'Protected administrator accounts cannot be deactivated.' }, { status:403 });
    }

    if (effectiveRole(current) === 'admin') {
      const users = await allUsers();
      if (activeAdminCount(users) <= 1) {
        return Response.json({ error:'At least one active Administrator account must remain.' }, { status:409 });
      }
    }

    const previous = effectiveRole(current);
    const appMetadata = {
      ...metadataFor(current),
      roles:['deactivated'],
      active:false,
      previousRole: previous === 'deactivated' ? clean(metadataFor(current)?.previousRole,40) || 'sales' : previous,
      permissions:permissionsFor(current),
    };

    const updated: any = await admin.updateUser(userId, { role:'deactivated', app_metadata:appMetadata });

    await appendStaffAudit(context, {
      actor,
      action:'user_deactivated',
      subjectId:userId,
      subjectEmail:email,
      detail:'Deactivated '+email+'.',
      metadata:{ previousRole:previous },
    });

    return Response.json({ ok:true, user:normalizeUser(updated) });
  }

  if (action === 'reactivate') {
    const requested = clean(body.role,40).toLowerCase();
    const stored = clean(metadataFor(current)?.previousRole,40).toLowerCase();
    const role = USER_ROLES.has(requested) ? requested : USER_ROLES.has(stored) ? stored : 'sales';

    const appMetadata = {
      ...metadataFor(current),
      roles:[role],
      active:true,
      previousRole:undefined,
      permissions:permissionsFor(current),
    };

    const updated: any = await admin.updateUser(userId, { role, app_metadata:appMetadata });

    await appendStaffAudit(context, {
      actor,
      action:'user_reactivated',
      subjectId:userId,
      subjectEmail:email,
      detail:'Reactivated '+email+' as '+role+'.',
      metadata:{ role },
    });

    return Response.json({ ok:true, user:normalizeUser(updated) });
  }

  if (action === 'delete') {
    if (PROTECTED_ADMIN_EMAILS.has(email)) {
      return Response.json({ error:'Protected administrator accounts cannot be deleted.' }, { status:403 });
    }

    if (effectiveRole(current) === 'admin') {
      const users = await allUsers();
      if (activeAdminCount(users) <= 1) {
        return Response.json({ error:'At least one active Administrator account must remain.' }, { status:409 });
      }
    }

    await appendStaffAudit(context, {
      actor,
      action:'user_deleted',
      subjectId:userId,
      subjectEmail:email,
      detail:'Permanently deleted account '+email+'.',
      metadata:{ role:effectiveRole(current), permissions:permissionsFor(current) },
    });

    await admin.deleteUser(userId);
    return Response.json({ ok:true, deletedId:userId });
  }

  return Response.json({ error:'Unknown user-management action.' }, { status:400 });
};

export const config: Config = { path:'/api/admin/staff' };
