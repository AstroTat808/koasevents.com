import type { Config, Context } from '@netlify/functions';
import { requireCapability } from './_shared/admin';
import { readTenantIndex, tenantStoreFor } from './_shared/tenant-storage';
import { resolveTenant } from './_shared/tenant';

const PACKAGE_IDS = ['mobile-oahu','mobile-maui','mobile-big-island'];
const PACKAGE_LABELS: Record<string,string> = {
  'mobile-oahu':'Oahu',
  'mobile-maui':'Maui',
  'mobile-big-island':'Big Island',
};

function clean(value: unknown, max = 180) {
  return String(value ?? '').trim().slice(0, max);
}
function eventTime(row: any) {
  const value = Date.parse(clean(row?.serverAt || row?.clientAt, 80));
  return Number.isFinite(value) ? value : 0;
}
function uniqueSessions(rows: any[]) {
  return new Set(rows.map((row) => clean(row?.sessionId, 100)).filter(Boolean));
}
function pct(n:number,d:number){ return d>0 ? Math.round((n/d)*1000)/10 : null; }
function wilson(successes:number,total:number){
  if(total<=0)return {low:null,high:null,halfWidth:null};
  const z=1.96,p=successes/total,den=1+(z*z)/total;
  const center=(p+(z*z)/(2*total))/den;
  const half=(z*Math.sqrt((p*(1-p)/total)+(z*z)/(4*total*total)))/den;
  return {
    low:Math.max(0,Math.round((center-half)*1000)/10),
    high:Math.min(100,Math.round((center+half)*1000)/10),
    halfWidth:Math.round(half*1000)/10,
  };
}
function samplePerVariant(rate:number|null,relativeMde=.20){
  const p1=Math.min(.8,Math.max(.05,Number(rate??20)/100));
  const p2=Math.max(.01,p1*(1-relativeMde));
  const avg=(p1+p2)/2,delta=Math.abs(p1-p2);
  return Math.ceil((2*Math.pow(1.96+.84,2)*avg*(1-avg))/Math.pow(delta,2));
}
function readiness(label:string,current:string,candidate:string,eligible:any[],successEvents:any[],days:number){
  const eligibleSessions=uniqueSessions(eligible);
  const successes=uniqueSessions(successEvents.filter((row:any)=>eligibleSessions.has(clean(row?.sessionId,100))));
  const total=eligibleSessions.size,success=successes.size,rate=pct(success,total);
  const ci=wilson(success,total);
  const baselineReady=total>=50&&success>=10;
  const directional=total>=30&&success>=5;
  const perVariant=samplePerVariant(rate,0.20);
  const daily=days>0?total/days:0;
  const daysToDecision=daily>0?Math.ceil((perVariant*2)/daily):null;
  let status='Collecting baseline',tone='red',score=0;
  if(total>=30)score+=30;
  if(total>=50)score+=20;
  if(success>=5)score+=20;
  if(success>=10)score+=15;
  if(ci.halfWidth!==null&&ci.halfWidth<=10)score+=15;
  if(baselineReady){status='Ready for a controlled test';tone='green';}
  else if(directional){status='Directional only';tone='amber';}
  return {
    label,current,candidate,status,tone,score:Math.min(100,score),
    eligibleSessions:total,successes:success,conversionRate:rate,confidence95:ci,
    samplePerVariant:perVariant,estimatedDaysToDecision:daysToDecision,baselineReady,
  };
}
function isMobileRecord(record:any){
  const source=clean(record?.source,100).toLowerCase();
  const line=clean(record?.businessLine,100).toLowerCase();
  const service=clean(record?.inquiry?.service,100).toLowerCase();
  const packageId=clean(record?.packageId||record?.inquiry?.mobileBarPackage,100).toLowerCase();
  return source==='koa-mobile-bar-inquiry'||line==='mobile-bar'||service==='mobile-bar'||packageId.startsWith('mobile-');
}

export default async (req:Request,context:Context)=>{
  const auth=await requireCapability('crm.view',req,context);
  if(auth.response)return auth.response;
  if(req.method!=='GET')return new Response('Method not allowed',{status:405});

  const url=new URL(req.url);
  const requested=Number(url.searchParams.get('days')||90);
  const days=[30,90,180].includes(requested)?requested:90;
  const cutoff=Date.now()-days*86400000;
  const tenant=auth.tenant||resolveTenant(req);
  const store=tenantStoreFor(context,tenant,'sales');
  const [eventsRaw,recordIndex]=await Promise.all([
    store.get('analytics/mobile-bar/events/index',{type:'json'}),
    readTenantIndex<any>(store,tenant,'records/index'),
  ]);
  const events=(Array.isArray(eventsRaw)?eventsRaw:[])
    .filter((row:any)=>eventTime(row)>=cutoff)
    .sort((a:any,b:any)=>eventTime(a)-eventTime(b));
  const records=(Array.isArray(recordIndex?.rows)?recordIndex.rows:[])
    .filter((row:any)=>isMobileRecord(row)&&Date.parse(clean(row?.createdAt,80))>=cutoff);

  const selections=events.filter((row:any)=>
    ['package_card_click','comparison_package_click','quote_package_select'].includes(row.type)
    && PACKAGE_IDS.includes(clean(row?.packageId,80))
  );
  const estimates=events.filter((row:any)=>row.type==='estimate_configured');
  const successes=events.filter((row:any)=>row.type==='quote_submit_success');
  const over100=estimates.filter((row:any)=>Number(row?.guestCount)>100);

  const levers=[
    readiness(
      'Package base prices',
      '$1,500 / $2,000 / $2,500',
      'Candidate: +$100 Oahu/Maui and +$150 Big Island; test one package at a time',
      selections,successes,days,
    ),
    readiness(
      'Additional-guest surcharges',
      '$10 / $12 / $15 per guest',
      'Candidate: $12 / $15 / $18 per guest',
      over100,successes,days,
    ),
    readiness(
      'Bartender labor',
      '$65 / hour / bartender',
      'Candidate first step: $70 / hour / bartender',
      estimates,successes,days,
    ),
  ];

  const packageBaselines=PACKAGE_IDS.map((id)=>{
    const rows=selections.filter((row:any)=>clean(row?.packageId,80)===id);
    const selected=uniqueSessions(rows);
    const won=uniqueSessions(successes.filter((row:any)=>
      clean(row?.packageId,80)===id&&selected.has(clean(row?.sessionId,100))
    ));
    return {
      id,label:PACKAGE_LABELS[id],selectionSessions:selected.size,successes:won.size,
      conversionRate:pct(won.size,selected.size),
    };
  });

  return Response.json({
    generatedAt:new Date().toISOString(),
    days,
    methodology:{
      baselineMinimum:'50 eligible quote sessions and 10 tracked submissions are required before the dashboard marks a lever ready to test.',
      directionalMinimum:'30 eligible sessions and 5 tracked submissions are treated as directional only.',
      decisionTarget:'The decision-grade target estimates the two-variant sample needed to detect a 20% relative conversion-rate change at 95% confidence and 80% power.',
      rule:'Change one pricing lever at a time and keep experiment assignment stable for the full test.',
    },
    metrics:{
      trackedSessions:uniqueSessions(events).size,
      completedInquiries:records.length,
      quoteSelections:uniqueSessions(selections).size,
      over100EstimateSessions:uniqueSessions(over100).size,
    },
    levers,
    packageBaselines,
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin-mobile-bar-pricing-experiments'};