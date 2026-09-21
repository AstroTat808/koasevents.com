import type { Context, Config } from '@netlify/functions';
import { getDeployStore,getStore } from '@netlify/blobs';

function sales(context:Context){return context.deploy.context==='production'?getStore({name:'koa-sales',consistency:'strong'}):getDeployStore({name:'koa-sales'});}
function crm(context:Context){return context.deploy.context==='production'?getStore({name:'koa-crm',consistency:'strong'}):getDeployStore({name:'koa-crm'});}
function ops(context:Context){return context.deploy.context==='production'?getStore({name:'koa-event-ops',consistency:'strong'}):getDeployStore({name:'koa-event-ops'});}
function clean(v:unknown,max=4000){return String(v??'').trim().slice(0,max);}
function id(p='MSG'){return p+'-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();}
async function idx<T>(store:any,key:string):Promise<T[]>{return ((await store.get(key,{type:'json'}))||[]) as T[];}
function paymentSummary(record:any){
  const schedule=record.booking?.payments||record.proposal?.paymentSchedule||[];
  const invoices=record?.accounting?.quickbooks?.invoices||[];
  return schedule.map((p:any,i:number)=>{const pid=p.id||'pay-'+(i+1);const inv=invoices.find((x:any)=>x.paymentId===pid);return{id:pid,label:p.label,dueDate:p.dueDate,amount:Number(p.amount||0),status:inv?.invoiceId?(Number(inv.balance||0)<=0?'paid':'open'):'not_invoiced',balance:inv?.invoiceId?Number(inv.balance||0):Number(p.amount||0),docNumber:inv?.docNumber||''};});
}
export default async(req:Request,context:Context)=>{
  const token=clean(context.params.token,100);
  if(!/^[A-Za-z0-9_-]{24,100}$/.test(token))return Response.json({error:'Invalid portal link.'},{status:400});
  const ss=sales(context), cs=crm(context);
  const records:any[]=await idx<any>(ss,'records/index');
  const record=records.find(r=>r?.kind==='proposal'&&r?.proposal?.publicToken===token);
  if(!record)return Response.json({error:'Client portal not found.'},{status:404});
  if(req.method==='GET'){
    const [appointments,messages]=await Promise.all([idx<any>(cs,'appointments/index'),idx<any>(cs,'client-messages/index')]);
    const eventOps:any=record.stage==='booked'?await ops(context).get('events/'+record.id,{type:'json'}):null;
    const contract=record.booking?.contract||null;
    return Response.json({project:{
      id:record.id,stage:record.stage,status:record.status,customerName:record.customer?.name||'',eventDate:record.customer?.eventDate||'',packageId:record.packageId||'',
      proposal:{status:record.proposal?.status||'',total:Number(record.proposal?.total||0),depositAmount:Number(record.proposal?.depositAmount||0),acceptedAt:record.proposal?.acceptance?.acceptedAt||'',url:'/proposal/?token='+token},
      contract:contract?{status:contract.status||'pending',title:contract.title||'',signwell:contract.signwell||{},signedPdfAvailable:Boolean(contract.signwell?.signedPdfStored),url:'/booking/?token='+token}:null,
      payments:paymentSummary(record),
      planningAvailable:record.stage==='booked',planningUrl:'/planning/?token='+token,
      documents:(eventOps?.documents||[]).filter((d:any)=>d.uploadedBy==='client').map((d:any)=>({id:d.id,name:d.name,label:d.label,category:d.category,uploadedAt:d.uploadedAt})),
      appointments:appointments.filter((a:any)=>a.recordId===record.id&&a.status!=='cancelled').sort((a:any,b:any)=>String(a.startsAt).localeCompare(String(b.startsAt))),
      messages:messages.filter((m:any)=>m.recordId===record.id).sort((a:any,b:any)=>String(a.createdAt).localeCompare(String(b.createdAt))).slice(-100),
    }},{headers:{'Cache-Control':'private, no-store'}});
  }
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);const action=clean(body?.action,50);
  if(action==='send-message'){
    const text=clean(body?.message,5000);if(!text)return Response.json({error:'Message required.'},{status:400});
    const current=await idx<any>(cs,'client-messages/index');const row={id:id(),recordId:record.id,sender:'client',senderName:record.customer?.name||'Client',message:text,createdAt:new Date().toISOString(),readByTeam:false};
    await cs.setJSON('client-messages/index',[...current,row].slice(-5000));return Response.json({ok:true,message:row});
  }
  if(action==='request-appointment'){
    const title=clean(body?.title,300)||'Client requested appointment';const startsAt=clean(body?.startsAt,80);
    if(!startsAt)return Response.json({error:'Choose a requested date and time.'},{status:400});
    const current=await idx<any>(cs,'appointments/index');const row={id:id('APT'),recordId:record.id,title,startsAt,durationMinutes:Math.max(15,Math.min(240,Number(body?.durationMinutes)||60)),location:clean(body?.location,300),notes:clean(body?.notes,2000),status:'requested',createdAt:new Date().toISOString(),requestedBy:'client'};
    await cs.setJSON('appointments/index',[row,...current].slice(0,3000));return Response.json({ok:true,appointment:row});
  }
  return Response.json({error:'Unknown portal action.'},{status:400});
};
export const config:Config={path:'/api/client-portal/:token'};
