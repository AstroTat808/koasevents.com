import type { Context } from '@netlify/functions';
import { getDeployStore,getStore } from '@netlify/blobs';
function crm(context:Context){return context.deploy.context==='production'?getStore({name:'koa-crm',consistency:'strong'}):getDeployStore({name:'koa-crm'});}
function ops(context:Context){return context.deploy.context==='production'?getStore({name:'koa-event-ops',consistency:'strong'}):getDeployStore({name:'koa-event-ops'});}
function id(p='TASK'){return p+'-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();}
function offset(date:string,days:number){const d=new Date(date+'T12:00:00Z');if(Number.isNaN(d.getTime()))return'';d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
async function activity(context:Context,recordId:string,type:string,detail:string){const s=crm(context);const cur:any[]=(await s.get('activity/index',{type:'json'}))||[];await s.setJSON('activity/index',[{id:id('ACT'),recordId,type,detail,createdAt:new Date().toISOString()},...cur].slice(0,5000));}
export async function ensureLifecycle(context:Context,record:any){
  if(!record?.id)return;
  const s=crm(context);let tasks:any[]=(await s.get('tasks/index',{type:'json'}))||[];
  const existing=new Set(tasks.filter(t=>t.recordId===record.id).map(t=>String(t.automationKey||'')));
  const add=(automationKey:string,title:string,dueDate:string,priority='normal')=>{if(existing.has(automationKey))return;tasks.unshift({id:id(),recordId:record.id,title,dueDate,assignee:'',status:'open',priority,createdAt:new Date().toISOString(),automationKey});existing.add(automationKey);};
  const eventDate=String(record.customer?.eventDate||'').slice(0,10);
  if(['inquiry','lead'].includes(record.stage)) add('respond-to-inquiry','Respond personally to new inquiry',new Date().toISOString().slice(0,10),'high');
  if(record.proposal?.status==='accepted'){
    add('contract-signing','Confirm SignWell agreement is fully executed','', 'high');
    add('deposit','Confirm reservation deposit is paid','', 'high');
  }
  if(record.stage==='booked'){
    if(eventDate){
      add('insurance-60','Confirm event insurance certificate',offset(eventDate,-60),'high');
      add('final-payment-60','Confirm final payment',offset(eventDate,-60),'high');
      add('vendors-30','Confirm final vendor list',offset(eventDate,-30));
      add('damage-deposit-30','Confirm damage deposit',offset(eventDate,-30),'high');
      add('final-details-14','Review final guest count, floor plan and timeline',offset(eventDate,-14));
      add('event-day','Run event-day operations checklist',eventDate,'high');
      add('post-event','Complete post-event inspection',offset(eventDate,1),'high');
      add('review-check','Confirm review request workflow completed',offset(eventDate,2));
    }
    let o:any=await ops(context).get('events/'+record.id,{type:'json'});
    if(!o){o={recordId:record.id,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'planning',finalGuestCount:Number(record.quote?.state?.guestCount||record.inquiry?.guestCount||0),setupStart:'',guestArrival:'',eventStart:'',eventEnd:'',teardownEnd:'',venueArea:'Koa’s Events',notes:'',vendors:[],questionnaire:[],timeline:[],checklist:[],tasks:[],documents:[]};await ops(context).setJSON('events/'+record.id,o);}
  }
  await s.setJSON('tasks/index',tasks.slice(0,5000));
}
export async function markLifecycleEvent(context:Context,record:any,type:string,detail:string){await ensureLifecycle(context,record);await activity(context,record.id,type,detail);}
