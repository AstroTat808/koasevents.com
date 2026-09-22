export type SetupItem={
  id:string;
  type:string;
  label:string;
  location:string;
  quantity:number;
  providedBy:string;
  responsibleVendorId:string;
  deliveryVendorId:string;
  setupVendorId:string;
  removalVendorId:string;
  setupTime:string;
  removalTime:string;
  notes:string;
  status:'planned'|'confirmed'|'set'|'removed';
};

function clean(value:unknown,max=1200){return String(value??'').trim().slice(0,max);}
function dateOnly(value:unknown){const s=clean(value,10);return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:'';}
function offset(date:string,days:number){const d=new Date(date+'T12:00:00Z');if(Number.isNaN(d.getTime()))return '';d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function todayHst(){return new Date(Date.now()-10*60*60*1000).toISOString().slice(0,10);}
function token(){return 'veb_'+crypto.randomUUID().replaceAll('-','');}
function mins(time:unknown){const m=/^(\d{1,2}):(\d{2})/.exec(clean(time,20));if(!m)return null;return Number(m[1])*60+Number(m[2]);}
function diffDays(a:string,b:string){if(!a||!b)return null;return Math.round((Date.parse(a+'T12:00:00Z')-Date.parse(b+'T12:00:00Z'))/86400000);}

export function ensureVendorBriefState(input:any[]){
  return (Array.isArray(input)?input:[]).map((vendor:any)=>({
    ...vendor,
    briefToken:clean(vendor?.briefToken,100)||token(),
    briefSentAt:clean(vendor?.briefSentAt,60),
    briefAcknowledgedAt:clean(vendor?.briefAcknowledgedAt,60),
    briefAcknowledgedName:clean(vendor?.briefAcknowledgedName,180),
    briefAcknowledgements:Array.isArray(vendor?.briefAcknowledgements)?vendor.briefAcknowledgements.map((x:any)=>clean(x,80)).filter(Boolean).slice(0,30):[],
    loadInZone:clean(vendor?.loadInZone,180),
    parkingInstructions:clean(vendor?.parkingInstructions,1000),
    powerWaterNeeds:clean(vendor?.powerWaterNeeds,1000),
    departureTime:clean(vendor?.departureTime,40),
    emergencyContact:clean(vendor?.emergencyContact,300),
    briefNote:clean(vendor?.briefNote,1600),
  }));
}

export function vendorBriefRules(vendor:any){
  const role=clean(vendor?.role,160).toLowerCase();
  const rules=[
    {id:'arrival',label:'I confirm the assigned arrival/load-in time and will contact Koa’s before changing it.'},
    {id:'setup-window',label:'I understand setup may not begin before 12:00 PM unless Koa’s has specifically approved earlier access.'},
    {id:'load-in',label:'I will follow the assigned parking, loading, setup-area, power, water, and access instructions.'},
    {id:'property',label:'I will protect the property, remove my materials/trash, and leave my work area clean.'},
    {id:'departure',label:'I will remove vendor equipment/items on schedule, leave no vehicle overnight, and be fully cleared no later than 9:00 AM the next day unless Koa’s approves otherwise.'},
    {id:'ownership',label:'I have reviewed the setup/removal responsibilities assigned to my company in this event brief.'},
  ];
  if(/dj|music|musician|band|entertain/.test(role))rules.push({id:'sound',label:'I understand amplified music must remain under 75 dB and all music must be off by 10:00 PM.'});
  if(/bar|bartend|mobile bar|cater/.test(role))rules.push({id:'alcohol',label:'If providing alcohol service, I understand Koa’s requires an approved bartender, no self-service bar, and no shots after 8:00 PM.'});
  return rules;
}

export function sanitizeSetupItems(input:unknown):SetupItem[]{
  if(!Array.isArray(input))return [];
  const statuses=new Set(['planned','confirmed','set','removed']);
  return input.slice(0,250).map((row:any)=>({
    id:clean(row?.id,80)||('SET-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase()),
    type:clean(row?.type,80)||'Custom',
    label:clean(row?.label,240),
    location:clean(row?.location,180),
    quantity:Math.max(0,Math.min(1000,Math.round(Number(row?.quantity)||0))),
    providedBy:clean(row?.providedBy,180),
    responsibleVendorId:clean(row?.responsibleVendorId,100),
    deliveryVendorId:clean(row?.deliveryVendorId,100),
    setupVendorId:clean(row?.setupVendorId,100),
    removalVendorId:clean(row?.removalVendorId,100),
    setupTime:clean(row?.setupTime,40),
    removalTime:clean(row?.removalTime,40),
    notes:clean(row?.notes,1600),
    status:statuses.has(row?.status)?row.status:'planned',
  })).filter((row)=>row.label);
}

export function setupForVendor(items:SetupItem[],vendorId:string){
  return (Array.isArray(items)?items:[]).filter((item)=>[
    item.responsibleVendorId,item.deliveryVendorId,item.setupVendorId,item.removalVendorId
  ].includes(vendorId));
}

function deadlineStatus(dueDate:string,complete:boolean){
  if(complete)return 'complete';
  const today=todayHst();const delta=diffDays(dueDate,today);
  if(delta===null)return 'open';
  if(delta<0)return 'overdue';
  if(delta<=7)return 'due_soon';
  return 'open';
}

export function buildVendorOperations(record:any,ops:any){
  const eventDate=dateOnly(record?.customer?.eventDate);
  const vendors=ensureVendorBriefState(ops?.vendors||[]);
  const setupItems=sanitizeSetupItems(ops?.setupItems||[]);
  const deadlines:any[]=[];
  for(const vendor of vendors){
    const name=vendor.company||vendor.contact||'Vendor';
    if(eventDate){
      const insuranceDue=offset(eventDate,-30);
      deadlines.push({id:vendor.id+':insurance',vendorId:vendor.id,vendorName:name,type:'policy',label:'Vendor insurance approved',dueDate:insuranceDue,status:deadlineStatus(insuranceDue,vendor.insuranceStatus==='approved')});
      const briefDue=offset(eventDate,-14);
      deadlines.push({id:vendor.id+':brief',vendorId:vendor.id,vendorName:name,type:'operations',label:'Event Brief acknowledged',dueDate:briefDue,status:deadlineStatus(briefDue,Boolean(vendor.briefAcknowledgedAt))});
      deadlines.push({id:vendor.id+':arrival',vendorId:vendor.id,vendorName:name,type:'operations',label:'Arrival/load-in time confirmed',dueDate:briefDue,status:deadlineStatus(briefDue,Boolean(vendor.arrivalTime))});
      const assigned=setupForVendor(setupItems,vendor.id);
      if(assigned.length){
        deadlines.push({id:vendor.id+':setup',vendorId:vendor.id,vendorName:name,type:'operations',label:'Setup/removal ownership confirmed',dueDate:briefDue,status:deadlineStatus(briefDue,Boolean(vendor.briefAcknowledgedAt))});
      }
    }
  }

  const conflicts:any[]=[];
  const guestArrival=mins(ops?.guestArrival);const eventStart=mins(ops?.eventStart);
  for(const vendor of vendors){
    const name=vendor.company||vendor.contact||'Vendor';const arrival=mins(vendor.arrivalTime);
    if(eventDate&&vendor.insuranceStatus!=='approved')conflicts.push({id:vendor.id+':insurance',severity:'high',vendorId:vendor.id,label:name+' insurance is not approved for this event.'});
    if(arrival!==null&&guestArrival!==null&&arrival>=guestArrival)conflicts.push({id:vendor.id+':late-guest',severity:'high',vendorId:vendor.id,label:name+' arrival is at or after guest arrival.'});
    else if(arrival!==null&&eventStart!==null&&arrival>=eventStart)conflicts.push({id:vendor.id+':late-event',severity:'high',vendorId:vendor.id,label:name+' arrival is at or after event start.'});
    if(eventDate&&!vendor.arrivalTime){
      const days=diffDays(eventDate,todayHst());if(days!==null&&days<=14)conflicts.push({id:vendor.id+':arrival-missing',severity:'medium',vendorId:vendor.id,label:name+' does not have a confirmed arrival time.'});
    }
    if(eventDate&&!vendor.briefAcknowledgedAt){
      const days=diffDays(eventDate,todayHst());if(days!==null&&days<=14)conflicts.push({id:vendor.id+':ack-missing',severity:'medium',vendorId:vendor.id,label:name+' has not acknowledged the Event Brief.'});
    }
  }

  for(let i=0;i<vendors.length;i++){
    for(let j=i+1;j<vendors.length;j++){
      const a=vendors[i],b=vendors[j],am=mins(a.arrivalTime),bm=mins(b.arrivalTime);
      if(am===null||bm===null)continue;
      const sameZone=clean(a.loadInZone,180)&&clean(a.loadInZone,180).toLowerCase()===clean(b.loadInZone,180).toLowerCase();
      if(sameZone&&Math.abs(am-bm)<=15)conflicts.push({id:a.id+':'+b.id+':loadin',severity:'medium',vendorId:'',label:(a.company||a.contact)+' and '+(b.company||b.contact)+' have overlapping load-in times in '+a.loadInZone+'.'});
    }
  }

  for(let i=0;i<setupItems.length;i++){
    for(let j=i+1;j<setupItems.length;j++){
      const a=setupItems[i],b=setupItems[j];
      if(!a.location||!b.location||a.location.toLowerCase()!==b.location.toLowerCase())continue;
      const at=mins(a.setupTime),bt=mins(b.setupTime);
      if(at!==null&&bt!==null&&Math.abs(at-bt)<=15&&a.setupVendorId&&b.setupVendorId&&a.setupVendorId!==b.setupVendorId){
        conflicts.push({id:a.id+':'+b.id+':setup',severity:'low',vendorId:'',label:a.label+' and '+b.label+' are scheduled for setup at nearly the same time in '+a.location+'.'});
      }
    }
  }

  for(const deadline of deadlines.filter((d)=>d.status==='overdue'||d.status==='due_soon')){
    conflicts.push({id:'deadline:'+deadline.id,severity:deadline.status==='overdue'?'high':'low',vendorId:deadline.vendorId,label:deadline.vendorName+' — '+deadline.label+' is '+(deadline.status==='overdue'?'overdue':'due soon')+' ('+deadline.dueDate+').'});
  }

  return {
    deadlines,
    conflicts,
    counts:{
      high:conflicts.filter((x)=>x.severity==='high').length,
      medium:conflicts.filter((x)=>x.severity==='medium').length,
      low:conflicts.filter((x)=>x.severity==='low').length,
      overdue:deadlines.filter((x)=>x.status==='overdue').length,
      dueSoon:deadlines.filter((x)=>x.status==='due_soon').length,
      unacknowledged:vendors.filter((x)=>!x.briefAcknowledgedAt).length,
    },
  };
}
