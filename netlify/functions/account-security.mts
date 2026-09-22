import type { Config, Context } from '@netlify/functions';
import { admin, getUser } from '@netlify/identity';
import { readAuthSecurityPolicy } from './_shared/admin';
import { appendStaffAudit } from './_shared/staff-audit';

function clean(value: unknown, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function validatePassword(value: unknown) {
  const password = String(value ?? '');
  if (password.length < 10) return { ok:false, error:'Password must be at least 10 characters.' };
  if (password.length > 128) return { ok:false, error:'Password must be 128 characters or fewer.' };
  return { ok:true, password };
}

function metadataFor(user:any) {
  return user?.appMetadata || user?.app_metadata || {};
}

function sessionVersion(user:any) {
  const n=Number(metadataFor(user)?.sessionVersion ?? 0);
  return Number.isFinite(n)&&n>=0?Math.floor(n):0;
}

export default async (req:Request, context:Context) => {
  const sessionUser=await getUser();
  if(!sessionUser?.id) return new Response('Unauthorized',{status:401});

  let current:any;
  try {
    current=await admin.getUser(sessionUser.id);
  } catch {
    return new Response('Unauthorized',{status:401});
  }

  if(req.method==='GET'){
    const policy=await readAuthSecurityPolicy();
    const meta=metadataFor(current);
    return Response.json({
      forcePasswordChange:meta?.forcePasswordChange===true,
      passwordChangedAt:clean(meta?.passwordChangedAt,80),
      sessionVersion:sessionVersion(current),
      passwordExpiryDays:policy.passwordExpiryDays,
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST') return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);
  if(!body) return Response.json({error:'Invalid JSON.'},{status:400});
  const action=clean(body.action,40);

  if(action==='change-password'){
    const validation=validatePassword(body.password);
    if(!validation.ok) return Response.json({error:validation.error},{status:400});

    const nextVersion=sessionVersion(current)+1;
    const now=new Date().toISOString();
    const updatedMeta={
      ...metadataFor(current),
      forcePasswordChange:false,
      passwordChangedAt:now,
      sessionVersion:nextVersion,
      active:metadataFor(current)?.active!==false,
    };

    await admin.updateUser(current.id,{
      password:validation.password,
      app_metadata:updatedMeta,
    });

    await appendStaffAudit(context,{
      actor:clean(current.email,240).toLowerCase(),
      action:'self_password_changed',
      subjectId:clean(current.id,120),
      subjectEmail:clean(current.email,240).toLowerCase(),
      detail:'User changed their password. Existing sessions were revoked.',
      metadata:{sessionVersion:nextVersion},
    });

    return Response.json({
      ok:true,
      message:'Password updated. Sign in again with your new password.',
      signInAgain:true,
    });
  }

  return Response.json({error:'Unknown account-security action.'},{status:400});
};

export const config:Config={path:'/api/account/security'};
