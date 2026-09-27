import type { Config } from '@netlify/functions';
import { requireCapability } from './_shared/admin';
import { emailRoutingSummary, saveEmailRouting } from './_shared/email-routing';
import { emailActivityLog } from './_shared/email-health';

function clean(value:unknown,max=500){return String(value??'').trim().slice(0,max);}
function esc(value:unknown){
  return clean(value,2000).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

async function sendRouteTest(routeId:string,actor:string){
  const summary=await emailRoutingSummary();
  const route=summary.routes.find((row:any)=>row.id===routeId);
  if(!route)throw new Error('Unknown email route.');
  const apiKey=clean(Netlify.env.get('RESEND_API_KEY'),500);
  if(!apiKey)throw new Error('RESEND_API_KEY is not configured.');

  const dynamic=route.mode==='dynamic';
  const to=dynamic?[actor]:route.to;
  const cc=dynamic?[]:route.cc;
  const bcc=dynamic?[]:route.bcc;
  if(!to.length)throw new Error('This route does not currently have a test recipient.');

  const replyTo=String(route.replyTo||'').includes('Client email from')
    ? actor
    : clean(route.replyTo,240);
  const subject='[TEST] '+route.label+' routing verification';
  const effectiveTo=dynamic
    ? 'Dynamic production recipient ('+(route.dynamicSource||'record')+'); test copy sent only to '+actor
    : route.to.join(', ');
  const html='<!doctype html><html><body style="font-family:Arial,sans-serif;color:#173d30">'+
    '<h2>Koa’s Email Route Test</h2>'+
    '<p>This message verifies the current routing configuration for <strong>'+esc(route.label)+'</strong>.</p>'+
    '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse">'+
      '<tr><td><strong>Production To</strong></td><td>'+esc(effectiveTo||'—')+'</td></tr>'+
      '<tr><td><strong>Production CC</strong></td><td>'+esc((route.cc||[]).join(', ')||'—')+'</td></tr>'+
      '<tr><td><strong>Production BCC</strong></td><td>'+esc((route.bcc||[]).join(', ')||'—')+'</td></tr>'+
      '<tr><td><strong>From</strong></td><td>'+esc(route.from||'—')+'</td></tr>'+
      '<tr><td><strong>Reply-To</strong></td><td>'+esc(route.replyTo||'—')+'</td></tr>'+
    '</table>'+
    '<p>'+ (dynamic
      ? 'Dynamic routes intentionally do not send this test to a live client/vendor record.'
      : 'For configurable routes, this test was delivered through the exact current To/CC/BCC route.')+
    '</p></body></html>';
  const text=[
    'Koa’s Email Route Test',
    'Route: '+route.label,
    'Production To: '+(effectiveTo||'—'),
    'Production CC: '+((route.cc||[]).join(', ')||'—'),
    'Production BCC: '+((route.bcc||[]).join(', ')||'—'),
    'From: '+(route.from||'—'),
    'Reply-To: '+(route.replyTo||'—'),
  ].join('\n');

  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{
      Authorization:'Bearer '+apiKey,
      'Content-Type':'application/json',
      'Idempotency-Key':('koa-admin-email-route-test-'+routeId+'-'+Date.now()).slice(0,256),
    },
    body:JSON.stringify({
      from:route.from,
      to,
      cc:cc.length?cc:undefined,
      bcc:bcc.length?bcc:undefined,
      subject,
      html,
      text,
      reply_to:replyTo||undefined,
    }),
    signal:AbortSignal.timeout(12000),
  });
  const body:any=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(clean(body?.message||body?.name||'Resend rejected the test email.',500));
  return {
    ok:true,
    routeId,
    mode:route.mode,
    recipients:{to,cc,bcc},
    from:route.from,
    replyTo:route.replyTo,
    resendMessageId:clean(body?.id,180),
  };
}

export default async (req:Request) => {
  if (req.method === 'GET') {
    const auth=await requireCapability('email.view',req);
    if(auth.response)return auth.response;
    const [routing,activity]=await Promise.all([
      emailRoutingSummary(),
      emailActivityLog(100),
    ]);
    return Response.json({...routing,activity},{headers:{'Cache-Control':'private, no-store'}});
  }
  if (req.method === 'PUT') {
    const auth=await requireCapability('email.manage',req);
    if(auth.response)return auth.response;
    try{
      const body=await req.json().catch(()=>({}));
      const routing=await saveEmailRouting(body,auth.user?.email||'staff');
      const activity=await emailActivityLog(100);
      return Response.json({...routing,activity},{headers:{'Cache-Control':'private, no-store'}});
    }catch(error){
      return Response.json({error:error instanceof Error?error.message:'Unable to save email routing.'},{status:400});
    }
  }
  if(req.method==='POST'){
    const auth=await requireCapability('email.manage',req);
    if(auth.response)return auth.response;
    try{
      const body:any=await req.json().catch(()=>({}));
      if(body?.action!=='send-test')return Response.json({error:'Unknown email action.'},{status:400});
      const actor=clean(auth.user?.email||'',240).toLowerCase();
      if(!actor.includes('@'))return Response.json({error:'Your signed-in account needs an email address to run a route test.'},{status:400});
      return Response.json(await sendRouteTest(clean(body?.routeId,80),actor),{headers:{'Cache-Control':'private, no-store'}});
    }catch(error){
      return Response.json({error:error instanceof Error?error.message:'Unable to send route test.'},{status:400});
    }
  }
  return new Response('Method Not Allowed',{status:405,headers:{Allow:'GET, PUT, POST'}});
};
export const config:Config={path:'/api/admin/email-routing'};
