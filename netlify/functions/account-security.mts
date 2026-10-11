import type { Config, Context } from '@netlify/functions';
import { admin, getUser } from '@netlify/identity';
import { readAuthSecurityPolicy } from './_shared/admin';
import {
  isTrustedDevice,
  managedSessionStatus,
  readTrustedDeviceSettings,
  readTrustedDevices,
  registerManagedSession,
  renameTrustedDevice,
  requestDeviceFingerprint,
  resolveTrustedDeviceHandle,
  saveTrustedDeviceSettings,
  trustKnownDevice,
  trustedDeviceHandle,
  TRUSTED_DEVICE_COOKIE_MAX_AGE_SECONDS,
  untrustKnownDevice,
} from './_shared/auth-security';
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

function userMetadataFor(user:any) {
  return user?.userMetadata || user?.user_metadata || {};
}

function sessionVersion(user:any) {
  const n=Number(metadataFor(user)?.sessionVersion ?? 0);
  return Number.isFinite(n)&&n>=0?Math.floor(n):0;
}

function sameOrigin(req:Request) {
  const origin=clean(req.headers.get('origin'),400);
  if(!origin)return true;
  try{return new URL(origin).host===new URL(req.url).host;}catch{return false;}
}

function defaultDeviceName(user:any,device:string) {
  const meta=userMetadataFor(user);
  const displayName=clean(meta?.full_name||meta?.name||user?.name||user?.email,180);
  const firstName=clean(displayName.split(/\s+/)[0],60)||'My';
  const deviceName=clean(String(device||'').split(' on ').pop()||'browser',80);
  return firstName+'’s '+(deviceName||'browser');
}

async function deviceView(row:any,currentFingerprint:string) {
  return {
    id:await trustedDeviceHandle(String(row?.fingerprint||'')),
    name:clean(row?.name||row?.device||'Trusted device',120),
    device:clean(row?.device,160),
    trustedAt:clean(row?.trustedAt,80),
    trustedBy:clean(row?.trustedBy,240),
    lastSeenAt:clean(row?.lastSeenAt,80),
    lastUsedAt:clean(row?.lastUsedAt||row?.lastSeenAt,80),
    expiresAt:clean(row?.expiresAt,80),
    current:Boolean(currentFingerprint&&row?.fingerprint===currentFingerprint),
  };
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

  const actor=clean(current.email,240).toLowerCase();

  if(req.method==='GET'){
    const [policy,trustedDeviceSettings,trustedDevices,currentFingerprint,currentStatus]=await Promise.all([
      readAuthSecurityPolicy(),
      readTrustedDeviceSettings(current.id),
      readTrustedDevices(current.id),
      requestDeviceFingerprint(req),
      managedSessionStatus(req,current.id),
    ]);
    const meta=metadataFor(current);
    const currentTrusted=Boolean(currentFingerprint&&await isTrustedDevice(current.id,currentFingerprint));
    const currentTrustedRow=currentTrusted?trustedDevices.find((row)=>row.fingerprint===currentFingerprint):null;
    const devices=await Promise.all(trustedDevices.map((row)=>deviceView(row,currentFingerprint)));
    return Response.json({
      forcePasswordChange:meta?.forcePasswordChange===true,
      passwordChangedAt:clean(meta?.passwordChangedAt,80),
      sessionVersion:sessionVersion(current),
      passwordExpiryDays:policy.passwordExpiryDays,
      trustedDeviceExpiryDays:trustedDeviceSettings.expiryDays,
      currentDevice:{
        trusted:currentTrusted,
        name:clean(currentTrustedRow?.name,120),
        device:clean(currentStatus?.session?.device||'Current browser',160),
        tracked:Boolean(currentStatus?.session),
      },
      trustedDevices:devices.sort((a,b)=>Number(b.current)-Number(a.current)||Date.parse(b.lastSeenAt||'')-Date.parse(a.lastSeenAt||'')),
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(req.method!=='POST') return new Response('Method not allowed',{status:405});
  if(!sameOrigin(req)) return Response.json({error:'Invalid request origin.'},{status:403});
  const body:any=await req.json().catch(()=>null);
  if(!body) return Response.json({error:'Invalid JSON.'},{status:400});
  const action=clean(body.action,60);

  if(action==='trust-current-browser'){
    const session=await registerManagedSession(req,current);
    if(!session?.id)return Response.json({error:'Current browser session could not be identified.'},{status:409});
    if(session.revokedAt)return Response.json({error:'This browser session has been revoked. Sign in again before trusting it.'},{status:409});
    const trusted=await trustKnownDevice(
      current.id,
      session.id,
      actor,
      context,
      actor,
      clean(body.name,120)||defaultDeviceName(current,session.device),
    );
    await appendStaffAudit(context,{
      actor,
      action:'self_device_trusted',
      subjectId:clean(current.id,120),
      subjectEmail:actor,
      detail:'Trusted the current browser as '+trusted.name+'.',
      metadata:{device:trusted.device,name:trusted.name},
    });
    const response=Response.json({
      ok:true,
      message:trusted.name+' is now trusted.',
      device:await deviceView(trusted,session.id),
    },{headers:{'Cache-Control':'private, no-store'}});
    response.headers.append('Set-Cookie','koa_sid='+encodeURIComponent(session.id)+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+TRUSTED_DEVICE_COOKIE_MAX_AGE_SECONDS);
    return response;
  }

  if(action==='save-trusted-device-expiry'){
    const days=Number(body.expiryDays);
    if(![0,30,60,90].includes(days)){
      return Response.json({error:'Trusted-device expiration must be Never, 30, 60, or 90 days.'},{status:400});
    }
    const settings=await saveTrustedDeviceSettings(current.id,days,actor);
    const trustedDevices=await readTrustedDevices(current.id);
    await appendStaffAudit(context,{
      actor,
      action:'self_trusted_device_expiry_changed',
      subjectId:clean(current.id,120),
      subjectEmail:actor,
      detail:settings.expiryDays
        ?'Trusted devices will auto-revoke after '+settings.expiryDays+' days without use.'
        :'Trusted-device automatic expiration was disabled.',
      metadata:{expiryDays:settings.expiryDays,activeTrustedDevices:trustedDevices.length},
    });
    return Response.json({
      ok:true,
      message:settings.expiryDays
        ?'Trusted browsers will auto-revoke after '+settings.expiryDays+' days without use.'
        :'Trusted-browser automatic expiration is off.',
      trustedDeviceExpiryDays:settings.expiryDays,
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='rename-trusted-device'){
    const existing=await resolveTrustedDeviceHandle(current.id,clean(body.deviceId,80));
    if(!existing)return Response.json({error:'Trusted device not found.'},{status:404});
    const name=clean(body.name,120);
    if(!name)return Response.json({error:'Device name is required.'},{status:400});
    const updated=await renameTrustedDevice(current.id,existing.fingerprint,name,actor,context,actor);
    await appendStaffAudit(context,{
      actor,
      action:'self_device_renamed',
      subjectId:clean(current.id,120),
      subjectEmail:actor,
      detail:'Renamed a trusted device to '+updated.name+'.',
      metadata:{device:updated.device,name:updated.name},
    });
    const currentFingerprint=await requestDeviceFingerprint(req);
    return Response.json({
      ok:true,
      message:'Trusted device renamed.',
      device:await deviceView(updated,currentFingerprint),
    },{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='revoke-trusted-device'){
    const existing=await resolveTrustedDeviceHandle(current.id,clean(body.deviceId,80));
    if(!existing)return Response.json({error:'Trusted device not found.'},{status:404});
    const removed=await untrustKnownDevice(current.id,existing.fingerprint,actor,context,actor);
    await appendStaffAudit(context,{
      actor,
      action:'self_device_trust_revoked',
      subjectId:clean(current.id,120),
      subjectEmail:actor,
      detail:'Revoked trusted-device status from '+clean(removed.name||removed.device,120)+'.',
      metadata:{device:removed.device,name:removed.name||removed.device},
    });
    return Response.json({
      ok:true,
      message:'Trusted-device status revoked.',
    },{headers:{'Cache-Control':'private, no-store'}});
  }

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
      actor,
      action:'self_password_changed',
      subjectId:clean(current.id,120),
      subjectEmail:actor,
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
