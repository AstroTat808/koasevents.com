import type { Config } from '@netlify/functions';
import { requireCapability, operationsRole, ROLE_LABELS } from './_shared/admin';
import { emailButton, emailGreeting, emailGreetingText, emailHeader, emailLogoAttachment, emailSignature, emailSignatureText, type EmailBrandKey } from './_shared/email-brand';
import { resolveTenant } from './_shared/tenant';
import { tenantEnv } from './_shared/tenant-env';

type PreviewTemplate = {
  id:string;
  category:string;
  name:string;
  subject:string;
  title:string;
  body:string;
  staff?:boolean;
  personalized?:boolean;
};

function templatesFor(tenant:any):PreviewTemplate[] {
  const name=tenant.displayName||'Organization';
  return [
    {id:'lead-notification',category:'CRM intake',name:'Internal lead notification',subject:'New Wedding Inquiry — Sample Client',title:'New Wedding Inquiry',body:'A new inquiry has arrived. The most relevant details are summarized below, with a direct link back to the Sales CRM.',staff:true},
    {id:'client-confirmation',category:'CRM intake',name:'Immediate client confirmation',subject:'We received your '+name+' wedding inquiry',title:'Thank you for thinking of '+name+' for your celebration.',body:'We received your inquiry and our team will review the date, guest count, service scope, and details you shared.'},
    {id:'response-reminder',category:'Follow-up automation',name:'Internal response reminder',subject:'Follow-up due — Sample Client',title:'Sample Client is waiting for a response.',body:'This lead has been open for about 4 business hours with no response activity logged in the Sales CRM.',staff:true},
    {id:'client-follow-up',category:'Follow-up automation',name:'24-hour client follow-up',subject:'A quick follow-up on your '+name+' inquiry',title:'Just checking in on your plans.',body:'We wanted to make sure your inquiry came through. If anything has changed, reply here and send the latest information.'},
    {id:'review-request',category:'Post-event',name:'Google review request',subject:'Thank you from '+name+' — would you share your experience?',title:'Would you share your '+name+' experience?',body:'Thank you for trusting '+name+' with your celebration. If you have a moment, we would be grateful if you shared an honest Google review.'},
    {id:'vendor-brief',category:'Vendor operations',name:'Vendor Event Brief',subject:name+' Vendor Event Brief — Sample Event',title:'Your event brief is ready.',body:'Please review your event-specific arrival, setup, removal, insurance, and acknowledgment requirements before coming onsite.'},
    {id:'vendor-insurance',category:'Vendor operations',name:'Vendor insurance reminder',subject:'Your '+name+' vendor insurance expires soon',title:'Insurance update needed.',body:'Your certificate of insurance is approaching expiration. Please provide an updated certificate so upcoming event compliance remains current.'},
    {id:'accounting-alert',category:'Accounting',name:'Accounting reconciliation alert',subject:name+' accounting mismatch detected',title:'Accounting reconciliation changed.',body:'A CRM and QuickBooks payment or invoice value no longer matches. Open the Sales CRM to review the affected record.',staff:true},
    {id:'system-health',category:'System operations',name:'System Health alert',subject:name+' System Health alert',title:'Health change detected.',body:'The health monitor detected a change in one or more protected organization services. Open System Health for the current checks and incident history.',staff:true},
    {id:'security-alert',category:'Security',name:'Suspicious sign-in alert',subject:name+' security alert: suspicious sign-in',title:'Suspicious organization sign-in',body:'A sign-in matched one or more security risk signals. Review the account, device, and active session history in User Management.',staff:true},
    {id:'staff-response',category:'CRM communication',name:'Staff-sent client response',subject:'Your '+name+' event details',title:'Your '+name+' event details',body:'Thank you for the update. I reviewed your event details and wanted to follow up personally with the next steps for your booking.',personalized:true},
  ];
}

function clean(value:unknown,max=1000){return String(value??'').trim().slice(0,max);}
function esc(value:unknown){return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
function userMetadata(user:any){return user?.user_metadata||user?.userMetadata||{};}
function personFor(user:any,tenant:any){
  const meta=userMetadata(user);
  const name=clean(meta?.full_name||meta?.name||user?.name||user?.email||(tenant.displayName+' Team'),180);
  const customTitle=clean(meta?.job_title||meta?.jobTitle,120);
  const role=operationsRole(user);
  const fallback=role&&role!=='custom'&&role in ROLE_LABELS?ROLE_LABELS[role as keyof typeof ROLE_LABELS]:tenant.displayName+' Team';
  return {
    name,
    title:customTitle||fallback,
    pronouns:clean(meta?.pronouns,80),
    roleDescription:clean(meta?.role_description||meta?.roleDescription,220),
    showTitle:meta?.signature_show_title!==false,
    showTeamTitle:meta?.signature_show_team_title!==false,
    showPronouns:meta?.signature_show_pronouns===true,
    showRoleDescription:meta?.signature_show_role_description===true,
  };
}

function renderTemplate(template:PreviewTemplate,brand:EmailBrandKey,person:ReturnType<typeof personFor>,tenant:any){
  const recipient=template.staff?'Team':'Malia';
  const extra =
    template.id==='client-confirmation'
      ? '<div style="margin-top:20px;padding:16px 18px;background:#f5f0e7;border-radius:14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:21px;font-weight:700;color:#173d30;">Event date: June 12, 2027 · Guest count: 42 · Package interest: Sample Collection</div>'
      : template.id==='vendor-brief'
      ? emailButton({href:'https://'+tenant.domains.primary+'/admin/vendors/',label:'Open event brief →',marginTop:22})
      : template.id==='review-request'
      ? emailButton({href:'https://'+tenant.domains.primary,label:'Share a Google review →',marginTop:22})
      : '';
  const html='<!doctype html><html lang="en" dir="ltr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no"><title>'+esc(template.subject)+'</title></head><body style="margin:0;background:#f5f0e7;">'
    +'<table role="presentation" lang="en" dir="ltr" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding-top:20px;padding-right:10px;padding-bottom:20px;padding-left:10px;">'
    +'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:650px;background:#fff;border:1px solid #e7dfd0;border-radius:22px;">'
    +emailHeader({brand,eyebrow:template.category,title:template.title})
    +'<tr><td style="padding-top:26px;padding-right:22px;padding-bottom:26px;padding-left:22px;">'
    +emailGreeting(recipient)
    +'<p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#46564f;">'+esc(template.body)+'</p>'
    +extra
    +emailSignature(template.personalized?person:{})
    +'</td></tr></table></td></tr></table></body></html>';
  const text=[
    emailGreetingText(recipient),'',
    template.title,'',
    template.body,
    template.id==='client-confirmation'?'Event date: June 12, 2027 · Guest count: 42 · Package interest: Sample Collection':'',
    '',
    emailSignatureText(template.personalized?person:{}),
  ].filter(Boolean).join('\n');
  return {html,text};
}

export default async(req:Request)=>{
  const auth=await requireCapability('email.view',req);
  if(auth.response)return auth.response;
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  const body:any=await req.json().catch(()=>null);
  if(!body)return Response.json({error:'Invalid JSON.'},{status:400});
  const tenant=auth.tenant||resolveTenant(req);
  const templates=templatesFor(tenant);
  const templateId=clean(body.templateId,80);
  const brand:EmailBrandKey=body.brand==='mobile'?'mobile':'events';
  const template=templates.find((row)=>row.id===templateId);
  if(!template)return Response.json({error:'Choose a valid email template.'},{status:400});

  const to=clean(auth.user?.email,240).toLowerCase();
  if(!to.includes('@'))return Response.json({error:'Your signed-in account does not have a valid email address.'},{status:400});
  const apiKey=clean(tenantEnv(tenant,'RESEND_API_KEY'),500);
  if(!apiKey)return Response.json({error:'Resend is not configured. RESEND_API_KEY is missing.'},{status:503});

  const person=personFor(auth.user,tenant);
  const rendered=renderTemplate(template,brand,person,tenant);
  const from=clean(tenantEnv(tenant,'CLIENT_EMAIL_FROM','KOA_CLIENT_EMAIL_FROM'),240)||(tenant.displayName+' <'+tenant.contact.email+'>');
  const replyTo=clean(tenantEnv(tenant,'CLIENT_REPLY_TO','KOA_CLIENT_REPLY_TO'),240)||tenant.contact.email;
  const subject='[TEST] '+template.subject+' · '+(brand==='mobile'?tenant.displayName+' Mobile Bar':tenant.displayName);

  try{
    const response=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
      body:JSON.stringify({from,to:[to],subject,html:rendered.html,text:rendered.text,attachments:[emailLogoAttachment()],reply_to:replyTo}),
      signal:AbortSignal.timeout(12_000),
    });
    const result:any=await response.json().catch(()=>({}));
    if(!response.ok)return Response.json({error:clean(result?.message,500)||'Resend could not send the test email.'},{status:502});
    return Response.json({ok:true,to,messageId:clean(result?.id,160),template:template.name,brand});
  }catch(error){
    return Response.json({error:error instanceof Error?clean(error.message,500):'Email delivery failed.'},{status:502});
  }
};

export const config:Config={path:'/api/admin/email-preview'};
