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
  role: AdminSessionRole;
  roles: string[];
  isAdmin: boolean;
  permissions: string[];
  capabilities: string[];
  accessBlocked: boolean;
  blockReason: ''|'account_disabled'|'session_revoked'|'password_expired'|'password_change_required';
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
  app_metadata: { roles:string[]; permissions:string[] };
  appMetadata: { roles:string[]; permissions:string[] };
};

export async function getAdminSession():Promise<AdminSession|null> {
  try {
    const response=await fetch('/api/admin/session',{cache:'no-store'});
    if(!response.ok) return null;
    return await response.json() as AdminSession;
  } catch (error) {
    console.error('Protected workspace session check failed',error);
    return null;
  }
}
