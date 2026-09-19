import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireAdmin } from './_shared/admin';

function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}
function opsStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-event-ops', consistency: 'strong' })
    : getDeployStore({ name: 'koa-event-ops' });
}
function clean(value: unknown, max=1000){return String(value||'').trim().slice(0,max);}
function isoDate(value:unknown){
  const raw=clean(value,40);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  return raw;
}
function offsetDate(date:string,days:number){
  const parsed=new Date(date+'T12:00:00Z');
  if(Number.isNaN(parsed.getTime()))return '';
  parsed.setUTCDate(parsed.getUTCDate()+days);
  return parsed.toISOString().slice(0,10);
}
function inRange(date:string,start:string,end:string){return Boolean(date && date>=start && date<=end);}
function minute(value:string){
  if(!/^\d{2}:\d{2}$/.test(value||''))return null;
  const [h,m]=value.split(':').map(Number);return h*60+m;
}
function windowFor(entry:any){
  const ops=entry.ops||{};
  const start=minute(ops.setupStart||ops.eventStart||'');
  let end=minute(ops.teardownEnd||ops.eventEnd||'');
  if(start!=null && end!=null && end<start)end+=1440;
  return {start,end};
}
function overlaps(a:any,b:any){
  const wa=windowFor(a),wb=windowFor(b);
  if(wa.start==null||wa.end==null||wb.start==null||wb.end==null)return null;
  return wa.start < wb.end && wb.start < wa.end;
}
function eventOwners(ops:any){
  const owners=new Set<string>();
  [...(ops?.tasks||[]),...(ops?.timeline||[])].forEach((row:any)=>{
    const owner=clean(row?.owner,180);
    if(owner)owners.add(owner.toLowerCase());
  });
  return owners;
}
function paymentRows(record:any){
  const schedule=record.booking?.payments?.length
    ? record.booking.payments
    : (record.proposal?.paymentSchedule||[]).map((item:any,index:number)=>({id:'pay-'+(index+1),...item}));
  const invoices=Array.isArray(record?.accounting?.quickbooks?.invoices)?record.accounting.quickbooks.invoices:[];
  return schedule.map((payment:any,index:number)=>{
    const invoice=invoices.find((row:any)=>row.paymentId===payment.id);
    const balance=invoice?.invoiceId?Number(invoice.balance??invoice.amount??payment.amount??0):Number(payment.amount||0);
    return {
      id:payment.id||'pay-'+(index+1),
      label:clean(payment.label,180)||'Payment',
      dueDate:isoDate(payment.dueDate),
      amount:Number(payment.amount||0),
      status:!invoice?.invoiceId?'not_invoiced':balance<=0?'paid':'open',
      balance,
      docNumber:invoice?.docNumber||'',
    };
  });
}
function basicChecklist(eventDate:string){
  return [
    {id:'insurance',text:'Event insurance certificate submitted',dueDate:eventDate?offsetDate(eventDate,-60):'',status:'not_started',owner:''},
    {id:'vendors',text:'Vendor list submitted',dueDate:eventDate?offsetDate(eventDate,-30):'',status:'not_started',owner:''},
    {id:'damage',text:'Damage deposit submitted',dueDate:eventDate?offsetDate(eventDate,-30):'',status:'not_started',owner:''},
  ];
}

export default async(req:Request,context:Context)=>{
  const auth=await requireAdmin();if(auth.response)return auth.response;
  if(req.method!=='GET')return new Response('Method not allowed',{status:405});

  const url=new URL(req.url);
  const today=new Date().toISOString().slice(0,10);
  const start=isoDate(url.searchParams.get('start'))||offsetDate(today,-31);
  const end=isoDate(url.searchParams.get('end'))||offsetDate(today,180);
  if(end<start)return Response.json({error:'Calendar end date must be after start date.'},{status:400});

  const records=((await salesStoreFor(context).get('records/index',{type:'json'}))||[]) as any[];
  const booked=records.filter((record)=>record?.kind==='proposal'&&record?.stage==='booked'&&record?.proposal?.status==='booked');
  const entries=await Promise.all(booked.map(async(record)=>{
    const ops:any=(await opsStoreFor(context).get('events/'+record.id,{type:'json'}))||{};
    return {record,ops};
  }));

  const items:any[]=[];
  for(const entry of entries){
    const record=entry.record,ops=entry.ops||{};
    const eventDate=isoDate(record.customer?.eventDate);
    const customerName=clean(record.customer?.name,180)||record.id;
    const venueArea=clean(ops.venueArea,180)||'Koa’s Events';

    if(inRange(eventDate,start,end)){
      const scheduleDetail=[
        ops.setupStart ? 'Setup '+ops.setupStart : '',
        ops.guestArrival ? 'Guests '+ops.guestArrival : '',
        ops.eventStart ? 'Event '+ops.eventStart+(ops.eventEnd?'–'+ops.eventEnd:'') : '',
        ops.teardownEnd ? 'Teardown '+ops.teardownEnd : '',
      ].filter(Boolean).join(' · ');
      items.push({
        id:'event-'+record.id,date:eventDate,time:ops.setupStart||ops.eventStart||'',endTime:ops.teardownEnd||ops.eventEnd||'',
        type:'event',title:customerName,detail:'Booked event · '+venueArea+(scheduleDetail?' · '+scheduleDetail:' · Schedule window incomplete'),status:ops.status||'planning',
        recordId:record.id,customerName,owner:'',venueArea,
      });

      (ops.vendors||[]).forEach((vendor:any)=>{
        if(!vendor.arrivalTime)return;
        items.push({
          id:'vendor-'+record.id+'-'+vendor.id,date:eventDate,time:vendor.arrivalTime,endTime:'',type:'vendor',
          title:(vendor.company||vendor.contact||'Vendor')+' arrival',detail:vendor.role||'Vendor arrival',status:vendor.insuranceStatus||'not_requested',
          recordId:record.id,customerName,owner:vendor.contact||'',venueArea,
        });
      });
      (ops.timeline||[]).forEach((row:any)=>{
        items.push({
          id:'timeline-'+record.id+'-'+row.id,date:eventDate,time:row.time||'',endTime:'',type:'timeline',
          title:row.label||'Run of show',detail:[row.location,row.notes].filter(Boolean).join(' · '),status:'scheduled',
          recordId:record.id,customerName,owner:row.owner||'',venueArea:row.location||venueArea,
        });
      });
      (ops.tasks||[]).forEach((row:any)=>{
        items.push({
          id:'task-'+record.id+'-'+row.id,date:eventDate,time:row.time||'',endTime:'',type:'task',
          title:row.task||'Event-day task',detail:row.notes||'',status:row.status||'not_started',
          recordId:record.id,customerName,owner:row.owner||'',venueArea,
        });
      });
    }

    paymentRows(record).forEach((payment:any)=>{
      if(!inRange(payment.dueDate,start,end))return;
      items.push({
        id:'payment-'+record.id+'-'+payment.id,date:payment.dueDate,time:'',endTime:'',type:'payment',
        title:payment.label,detail:(payment.docNumber?'QBO #'+payment.docNumber+' · ':'')+(payment.status==='paid'?'Paid':payment.status==='open'?'$'+payment.balance.toFixed(2)+' remaining':'Not yet invoiced in QuickBooks'),
        status:payment.status,recordId:record.id,customerName,owner:'',venueArea,
      });
    });

    const checklist=Array.isArray(ops.checklist)&&ops.checklist.length?ops.checklist:basicChecklist(eventDate);
    checklist.filter((row:any)=>row?.dueDate).forEach((row:any)=>{
      const due=isoDate(row.dueDate);if(!inRange(due,start,end))return;
      items.push({
        id:'check-'+record.id+'-'+row.id,date:due,time:'',endTime:'',type:'deadline',
        title:row.text||'Event deadline',detail:row.owner?'Owner: '+row.owner:'Event Ops deadline',
        status:row.status||'not_started',recordId:record.id,customerName,owner:row.owner||'',venueArea,
      });
    });
  }

  const conflicts:any[]=[];
  for(let i=0;i<entries.length;i++){
    for(let j=i+1;j<entries.length;j++){
      const a=entries[i],b=entries[j];
      const dateA=isoDate(a.record.customer?.eventDate),dateB=isoDate(b.record.customer?.eventDate);
      if(!dateA||dateA!==dateB||!inRange(dateA,start,end))continue;
      const areaA=(clean(a.ops?.venueArea,180)||'Koa’s Events').toLowerCase();
      const areaB=(clean(b.ops?.venueArea,180)||'Koa’s Events').toLowerCase();
      const overlap=overlaps(a,b);

      if(areaA===areaB && overlap!==false){
        conflicts.push({
          id:'venue-'+a.record.id+'-'+b.record.id,date:dateA,type:'venue',
          severity:overlap===true?'confirmed':'potential',
          title:overlap===true?'Venue schedule overlap':'Potential venue conflict',
          detail:(a.record.customer?.name||a.record.id)+' and '+(b.record.customer?.name||b.record.id)+' use '+(clean(a.ops?.venueArea,180)||'Koa’s Events')+(overlap===null?' but one or both event windows are incomplete.':'.'),
          recordIds:[a.record.id,b.record.id],
        });
      }

      const ownersA=eventOwners(a.ops),ownersB=eventOwners(b.ops);
      const shared=[...ownersA].filter((owner)=>ownersB.has(owner));
      if(shared.length && overlap!==false){
        conflicts.push({
          id:'staff-'+a.record.id+'-'+b.record.id,date:dateA,type:'staff',
          severity:overlap===true?'confirmed':'potential',
          title:overlap===true?'Staffing overlap':'Potential staffing conflict',
          detail:shared.join(', ')+' assigned to both '+(a.record.customer?.name||a.record.id)+' and '+(b.record.customer?.name||b.record.id)+(overlap===null?' with incomplete event windows.':'.'),
          recordIds:[a.record.id,b.record.id],owners:shared,
        });
      }
    }
  }

  items.sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.time).localeCompare(String(b.time))||String(a.title).localeCompare(String(b.title)));
  conflicts.sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.severity).localeCompare(String(b.severity)));

  return Response.json({
    range:{start,end},
    items,
    conflicts,
    totals:{
      bookedEvents:entries.length,
      calendarItems:items.length,
      confirmedConflicts:conflicts.filter((c)=>c.severity==='confirmed').length,
      potentialConflicts:conflicts.filter((c)=>c.severity==='potential').length,
    }
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/calendar'};
