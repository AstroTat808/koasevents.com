export type CleanupMode = 'auto_trash' | 'review_first' | 'flag_only';

export type CleanupReview = {
  verdict: 'legitimate';
  reviewedAt: string;
  reviewedBy: string;
};

export type CleanupSignal = { code:string; reason:string; score:number };

export type CleanupAssessment = {
  score:number;
  disposition:'clean'|'review'|'auto_trash';
  reasons:string[];
  reasonCodes:string[];
  signals:CleanupSignal[];
  autoTrash:boolean;
  approvedLegitimate:boolean;
  manuallyFlagged:boolean;
};

function clean(v:unknown,max=1000){return String(v??'').trim().slice(0,max);}
function add(signals:Array<{code:string;reason:string;score:number}>,code:string,reason:string,score:number){
  if(!signals.some(s=>s.code===code))signals.push({code,reason,score});
}
function validDate(value:string){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
  const d=new Date(value+'T12:00:00Z');
  return Number.isNaN(d.getTime())?null:d;
}
function syntheticNameSignals(name:string){
  const n=name.trim();
  const lower=n.toLowerCase();
  const signals:Array<{code:string;reason:string;score:number}>=[];
  if(!n)return signals;
  if(/\b(?:test(?:ing)?|fake|spam|asdf|qwerty|dummy|sample|none|null|unknown|delete\s*me)\b/i.test(lower)){
    add(signals,'explicit_test_identity','Name explicitly looks like a test, fake, spam, or placeholder identity',90);
  }
  if(/\d/.test(n))add(signals,'name_contains_digits','Name contains digits',20);
  if(/(.)\1{4,}/i.test(n.replace(/\s/g,'')))add(signals,'repeated_name_characters','Name contains an implausible repeated-character pattern',45);
  const words=n.split(/\s+/).filter(Boolean);
  const weird=words.filter(w=>{
    const letters=w.toLowerCase().replace(/[^a-z]/g,'');
    if(letters.length<5)return false;
    const vowels=(letters.match(/[aeiouy]/g)||[]).length;
    const consonantRun=/[bcdfghjklmnpqrstvwxz]{5,}/.test(letters);
    return consonantRun || vowels/letters.length<0.18;
  });
  if(weird.length)add(signals,'synthetic_name_pattern','Name has a strongly synthetic consonant pattern',25);
  return signals;
}

export function normalizeCleanupMode(value:unknown):CleanupMode{
  return value==='review_first'||value==='flag_only'?'review_first'===value?'review_first':'flag_only':'auto_trash';
}

export function assessCrmRecord(record:any, nowMs=Date.now()):CleanupAssessment{
  if(record?.cleanupReview?.verdict==='legitimate'){
    return {
      score:0,
      disposition:'clean',
      reasons:['Approved as legitimate by an administrator'],
      reasonCodes:['admin_approved_legitimate'],
      signals:[{code:'admin_approved_legitimate',reason:'Approved as legitimate by an administrator',score:0}],
      autoTrash:false,
      approvedLegitimate:true,
      manuallyFlagged:false,
    };
  }

  const signals:Array<{code:string;reason:string;score:number}>=[];
  const kind=clean(record?.kind,30);
  const stage=clean(record?.stage,30);
  const name=clean(record?.customer?.name,180);
  const email=clean(record?.customer?.email,240).toLowerCase();
  const eventDate=clean(record?.customer?.eventDate,40).slice(0,10);
  const createdAt=new Date(record?.createdAt||'').getTime();
  const protectedRecord=kind==='proposal'||stage==='proposal'||stage==='booked'||Boolean(record?.booking)||Boolean(record?.proposal)||Boolean(record?.accounting?.quickbooks?.invoices?.length);

  syntheticNameSignals(name).forEach(s=>add(signals,s.code,s.reason,s.score));

  if(/^(?:test|fake|spam|dummy|sample)(?:[+._-]|@)/i.test(email) || /@example\.(?:com|org|net)$/i.test(email)){
    add(signals,'test_email_identity','Email address looks explicitly intended for testing or placeholder data',75);
  }

  if(eventDate){
    const d=validDate(eventDate);
    if(!d){
      add(signals,'invalid_event_date','Event date is not a valid calendar date',45);
    }else{
      const eventMs=d.getTime();
      const base=Number.isFinite(createdAt)?createdAt:nowMs;
      const year=d.getUTCFullYear();
      if(year<2000 || eventMs < base-365*24*60*60*1000){
        add(signals,'impossible_historic_event_date','Event date is implausibly far in the past for a newly captured client',90);
      }else if(eventMs < base-30*24*60*60*1000){
        add(signals,'stale_past_event_date','Event date predates the CRM record by more than 30 days',45);
      }
      if(eventMs > base+10*365.25*24*60*60*1000){
        add(signals,'far_future_event_date','Event date is more than ten years after inquiry creation',30);
      }
    }
  }

  const manualFlag=record?.cleanupManualFlag;
  if(manualFlag?.flaggedAt){
    add(signals,'manual_review_flag','Manually flagged for review by '+clean(manualFlag.flaggedBy||'administrator',180),35);
  }

  const sec=record?.security||{};
  const risk=Math.max(0,Math.min(100,Number(sec.riskScore)||0));
  const codes=Array.isArray(sec.reasonCodes)?sec.reasonCodes.map((x:any)=>clean(x,80)):[];
  if(sec.disposition==='flagged' && risk>=20){
    add(signals,'security_flagged','Existing inquiry security screen flagged this submission',Math.min(45,Math.round(risk/2)));
  }
  if(codes.some((c:string)=>['disposable_email','invalid_email','suspicious_phone'].includes(c))){
    add(signals,'identity_quality_signal','Security screen detected suspicious contact information',20);
  }
  if(codes.some((c:string)=>['marketing_solicitation','crypto_pitch','finance_solicitation','gambling_solicitation','solicitation_with_link'].includes(c))){
    add(signals,'solicitation_signal','Security screen detected non-client solicitation language',45);
  }

  const score=Math.min(100,signals.reduce((n,s)=>n+s.score,0));
  const strongAuto=signals.some(s=>['explicit_test_identity','impossible_historic_event_date'].includes(s.code)) ||
    (signals.some(s=>s.code==='test_email_identity') && score>=90) ||
    (signals.some(s=>s.code==='solicitation_signal') && score>=90);
  const autoTrash=!protectedRecord && ['inquiry','lead'].includes(kind) && strongAuto && score>=90;

  return {
    score,
    disposition:autoTrash?'auto_trash':score>=35?'review':'clean',
    reasons:signals.map(s=>s.reason),
    reasonCodes:signals.map(s=>s.code),
    signals:signals.map(s=>({code:s.code,reason:s.reason,score:s.score})),
    autoTrash,
    approvedLegitimate:false,
    manuallyFlagged:Boolean(manualFlag?.flaggedAt),
  };
}