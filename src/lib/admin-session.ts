export type AdminSession = {
  email: string;
  role: 'admin'|'manager'|'sales'|'none';
  roles: string[];
  isAdmin: boolean;
  permissions: string[];
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
