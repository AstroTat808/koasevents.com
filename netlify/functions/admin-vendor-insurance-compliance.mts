import type { Context, Config } from '@netlify/functions';
import { getDeployStore,getStore } from '@netlify/blobs';
import { requireOperations } from './_shared/admin';
import { masterInsuranceForEvent, todayHst } from './_shared/vendor-insurance-sync.ts';

function store(c:Context,name:string){return c.deploy.context==='production'?getStore({name,consistency:'strong'}):getDeployStore({name});}
function daysUntil(date:unknown){const raw=String(date||'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return null;const target=Date.parse(raw+'T00:00:00Z');const today=Date.parse(todayHst()+'T00:00:00Z');return Math.ceil((target-today)/86400000);}
export default async(_req:Request,context:Context)=>{
  const auth=await requireOperations();if(auth.response)return auth.response;
  const [vendors,records]=await Promise.all([
    store(context,'koa-vendors').get('vendors/index',{type:'json'}),
    store(context,'koa-sales').get('records/index',{type:'json'}),
  ]);
  const vendorRows:Array<any>=Array.isArray(vendors)?vendors:[];
  const booked:Array<any>=(Array.isArray(records)?records:[]).filter((r:any)=>r?.stage==='booked'&&r?.kind==='proposal'&&String(r?.customer?.eventDate||'')>=todayHst());
  const opsStore=store(context,'koa-event-ops');
  const eventRows=await Promise.all(booked.map(async(record:any)=>({record,ops:(await opsStore.get('events/'+record.id,{type:'json'}))||{vendors:[]}})));

  const rows=vendorRows.map((vendor:any)=>{
    const ins=vendor.insurance||{};const days=daysUntil(ins.expiresAt);let status='missing';
    if(ins.status==='approved'&&days!==null&&days<0)status='expired';
    else if(ins.status==='approved'&&days!==null&&days<=30)status='expiring_soon';
    else if(ins.status==='approved')status='approved';
    else if(ins.rejectionReason)status='rejected';
    else if(ins.status==='received')status='pending';
    else if(ins.status==='expired')status='expired';
    else status='missing';

    const affected=eventRows.flatMap(({record,ops}:any)=>{
      const assignment=(ops.vendors||[]).find((v:any)=>String(v.marketplaceVendorId||'')===String(vendor.id||''));
      if(!assignment)return [];
      const result=masterInsuranceForEvent(vendor,record.customer?.eventDate);
      return [{recordId:record.id,customerName:String(record.customer?.name||''),eventDate:String(record.customer?.eventDate||''),packageId:String(record.packageId||''),covered:result.covered,status:result.status,issue:result.issue}];
    });
    return {
      vendorId:vendor.id,name:vendor.name,category:vendor.category,status,
      insuranceStatus:String(ins.status||'not_requested'),expiresAt:String(ins.expiresAt||''),daysUntilExpiration:days,
      additionalInsured:Boolean(ins.additionalInsured),hasDocument:Boolean(ins.document?.id),rejectionReason:String(ins.rejectionReason||''),
      upcomingEvents:affected,affectedUpcomingEvents:affected.filter((e:any)=>!e.covered),
    };
  });

  const summary={
    total:rows.length,
    missing:rows.filter(r=>r.status==='missing').length,
    pending:rows.filter(r=>r.status==='pending').length,
    approved:rows.filter(r=>r.status==='approved').length,
    rejected:rows.filter(r=>r.status==='rejected').length,
    expiringSoon:rows.filter(r=>r.status==='expiring_soon').length,
    expired:rows.filter(r=>r.status==='expired').length,
    affectedEvents:rows.reduce((sum,r)=>sum+r.affectedUpcomingEvents.length,0),
  };
  return Response.json({summary,rows},{headers:{'Cache-Control':'private, no-store'}});
};
export const config:Config={path:'/api/admin/vendor-insurance-compliance'};