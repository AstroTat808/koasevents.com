import type { TenantProfile } from './types';

const KOA_PACKAGE_PROFITABILITY = [
    {
      id:'gardenia', name:'Gardenia Intimate Wedding', price:5000, includedGuests:20, targetMargin:0.72,
      costs:{ laborSetup:400,flowers:150,cake:175,mobileBar:0,cleaning:150,cottage:0,rentalsInventory:0,coordination:250,photoBooth:0,lightingAv:0,parkingStaffing:0,otherDirect:0 },
    },
    {
      id:'orchid', name:'Orchid Wedding Day', price:10000, includedGuests:30, targetMargin:0.72,
      costs:{ laborSetup:800,flowers:150,cake:0,mobileBar:0,cleaning:250,cottage:0,rentalsInventory:150,coordination:500,photoBooth:0,lightingAv:75,parkingStaffing:0,otherDirect:0 },
    },
    {
      id:'hibiscus', name:'Hibiscus Wedding Weekend', price:15000, includedGuests:50, targetMargin:0.70,
      costs:{ laborSetup:1200,flowers:150,cake:0,mobileBar:0,cleaning:350,cottage:500,rentalsInventory:250,coordination:900,photoBooth:0,lightingAv:100,parkingStaffing:0,otherDirect:0 },
    },
    {
      id:'signature-wedding', name:'Koa’s Signature Wedding Experience', price:20000, includedGuests:50, targetMargin:0.66,
      costs:{ laborSetup:1500,flowers:1000,cake:500,mobileBar:900,cleaning:400,cottage:500,rentalsInventory:500,coordination:1200,photoBooth:400,lightingAv:300,parkingStaffing:250,otherDirect:300 },
    },
  ];
}
;

export function tenantProfitabilityPackages(tenant:TenantProfile){
  if(tenant.id==='koa-events') return KOA_PACKAGE_PROFITABILITY.map((row:any)=>({...row,costs:{...row.costs}}));
  return tenant.catalog.bootstrapItems
    .filter((item)=>item.group==='packages')
    .map((item)=>({
      id:item.id,
      name:item.name,
      price:Number(item.unitPrice||0),
      includedGuests:0,
      targetMargin:Number(item.targetMargin||0.65),
      costs:{laborSetup:0,flowers:0,cake:0,mobileBar:0,cleaning:0,cottage:0,rentalsInventory:0,coordination:0,photoBooth:0,lightingAv:0,parkingStaffing:0,otherDirect:0},
    }));
}
