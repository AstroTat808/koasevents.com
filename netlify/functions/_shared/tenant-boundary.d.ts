export type TenantBoundaryProfile = {
  id: string;
  storage: { legacyDataBelongsToTenant: boolean };
};
export function cleanTenantKey(value: unknown): string;
export function tenantDataPrefix(tenant: {id:string}, domain: string): string;
export function tenantDataKey(tenant: {id:string}, domain: string, key: string): string;
export function stampTenantId<T extends Record<string,any>>(tenant:{id:string}, value:T): T & {tenantId:string};
export function tenantOwnsRecord(tenant:TenantBoundaryProfile, value:any): boolean;
export function normalizeTenantRows<T extends Record<string,any>>(
  tenant:TenantBoundaryProfile,
  rows:T[],
): {rows:Array<T & {tenantId:string}>;changed:boolean;rejected:number};
