export type AdminSessionRole =
  | 'admin'
  | 'manager'
  | 'sales'
  | 'event_coordinator'
  | 'vendor_manager'
  | 'content_editor'
  | 'accounting'
  | 'read_only'
  | 'custom'
  | 'deactivated'
  | 'none';

export type AdminSession = {
  email: string;
  displayName: string;
  jobTitle: string;
  pronouns: string;
  roleDescription: string;
  appearancePreference: ''|'light'|'dark'|'system';
  photoUrl: string;
  signature: {
    showTitle: boolean;
    showTeamTitle: boolean;
    showPronouns: boolean;
    showRoleDescription: boolean;
  };
  role: AdminSessionRole;
  roles: string[];
  isAdmin: boolean;
  permissions: string[];
  capabilities: string[];
  accessBlocked: boolean;
  blockReason: ''|'account_disabled'|'session_revoked'|'password_expired'|'password_change_required';
  tenant: null | { id:string; slug:string; displayName:string; locale:string; currency:string; timezone:string };
  organization: any | null;
  membership: any | null;
  security: {
    forcePasswordChange: boolean;
    passwordChangedAt: string;
    passwordExpiresAt: string;
    passwordExpired: boolean;
    passwordExpiryDays: number;
    sessionVersion: number;
    tokenSessionVersion: number;
    sessionRevoked: boolean;
  };
  app_metadata: { roles:string[]; permissions:string[]; tenantId?:string; membershipId?:string };
  appMetadata: { roles:string[]; permissions:string[]; tenantId?:string; membershipId?:string };
};

import { refreshSession } from '@netlify/identity';

let activeRefresh:Promise<string|null>|null=null;
function refreshIdentityOnce():Promise<string|null>{
  if(!activeRefresh){
    activeRefresh=refreshSession().catch(()=>null).finally(()=>{ activeRefresh=null; });
  }
  return activeRefresh;
}

function sendToLogin(){
  if(typeof window==='undefined')return;
  const state=window as Window & {__koaAdminSessionRedirecting?:boolean};
  if(state.__koaAdminSessionRedirecting)return;
  const path=window.location.pathname;
  if(!path.startsWith('/admin/')||path==='/admin/')return;
  state.__koaAdminSessionRedirecting=true;
  const url=new URL('/admin/',window.location.origin);
  url.searchParams.set('reason','session_expired');
  url.searchParams.set('returnTo',path+window.location.search+window.location.hash);
  window.location.replace(url.pathname+url.search);
}

export async function getAdminSession():Promise<AdminSession|null> {
  try {
    const check=()=>fetch('/api/admin/session',{cache:'no-store'});
    let response=await check();
    if(response.status===401){
      const failure=await response.clone().json().catch(()=>({}));
      // Revocations must never be silently refreshed into new authorization.
      if(failure?.code==='unauthenticated'){
        await refreshIdentityOnce();
        response=await check();
      }
      if(response.status===401){
        sendToLogin();
        return null;
      }
    }
    if(!response.ok)return null;
    const session=await response.json() as AdminSession;
    if(session.accessBlocked&&session.blockReason==='session_revoked')sendToLogin();
    return session;
  }catch{
    // Network/offline failures must not be mislabeled as session expiration.
    return null;
  }
}
