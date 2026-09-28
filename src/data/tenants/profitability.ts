import type { TenantProfile } from './types';
import { koaProfitabilityPackageDefaults } from './koa-profitability';

export type TenantProfitabilityCostDefaults = {
  laborSetup:number; flowers:number; cake:number; mobileBar:number; cleaning:number; cottage:number;
  rentalsInventory:number; coordination:number; photoBooth:number; lightingAv:number;
  parkingStaffing:number; otherDirect:number;
};

export type TenantProfitabilityPackageDefault = {
  id:string;
  name:string;
  price:number;
  includedGuests:number;
  targetMargin:number;
  costs:TenantProfitabilityCostDefaults;
};

function zeroCosts():TenantProfitabilityCostDefaults {
  return {
    laborSetup:0,flowers:0,cake:0,mobileBar:0,cleaning:0,cottage:0,
    rentalsInventory:0,coordination:0,photoBooth:0,lightingAv:0,parkingStaffing:0,otherDirect:0,
  };
}

export function tenantProfitabilityPackageDefaults(tenant:TenantProfile):TenantProfitabilityPackageDefault[] {
  if(tenant.id==='koa-events') {
    return koaProfitabilityPackageDefaults.map((row)=>({
      ...row,
      costs:{...row.costs},
    })) as TenantProfitabilityPackageDefault[];
  }

  return tenant.sales.weddingPackageIds.map((packageId)=>{
    const catalogId=tenant.sales.catalogItemByPackage[packageId]||packageId;
    const catalog=tenant.catalog.bootstrapItems.find((item)=>item.id===catalogId);
    return {
      id:packageId,
      name:catalog?.name||packageId,
      price:Number(catalog?.unitPrice||0),
      includedGuests:1,
      targetMargin:0.6,
      costs:zeroCosts(),
    };
  });
}
