function esc(value:unknown){return String(value??'').replace(/[&<>"']/g,(m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]||m));}
function fromAddress(){return String(Netlify.env.get('KOA_VENDOR_EMAIL_FROM')||Netlify.env.get('KOA_CLIENT_EMAIL_FROM')||'Koa’s Events <aloha@koasevents.com>').trim();}
function replyTo(){return String(Netlify.env.get('KOA_CLIENT_REPLY_TO')||'aloha@koasevents.com').trim();}
export async function sendVendorEmail(args:{to:string[];subject:string;title:string;body:string;detail?:string;actionLabel?:string;actionUrl?:string;idempotencyKey:string}){
  const apiKey=String(Netlify.env.get('RESEND_API_KEY')||'').trim();
  const recipients=args.to.map(x=>String(x||'').trim()).filter(x=>x.includes('@'));
  if(!apiKey||!recipients.length)return {sent:false,configured:Boolean(apiKey),id:''};
  const action=args.actionUrl?'<p style="margin:24px 0 0"><a href="'+esc(args.actionUrl)+'" style="display:inline-block;background:#173d30;color:#fff;text-decoration:none;border-radius:999px;padding:13px 20px;font:700 12px Arial,sans-serif;letter-spacing:.7px;text-transform:uppercase">'+esc(args.actionLabel||'Open')+'</a></p>':'';
  const detail=args.detail?'<div style="margin-top:18px;padding:14px 16px;background:#f5f0e7;border-radius:12px;font:700 13px/21px Arial,sans-serif;color:#173d30">'+esc(args.detail)+'</div>':'';
  const html='<!doctype html><html><body style="margin:0;background:#f5f0e7"><table role="presentation" width="100%"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" style="max-width:640px;background:#fff;border:1px solid #e7dfd0;border-radius:20px"><tr><td style="padding:30px"><div style="font:800 11px/16px Arial,sans-serif;letter-spacing:1.6px;text-transform:uppercase;color:#a96d4a">Koa’s Events Vendor Network</div><h1 style="font:700 32px/39px Georgia,serif;color:#173d30;margin:10px 0 0">'+esc(args.title)+'</h1><p style="font:15px/24px Arial,sans-serif;color:#46564f;margin:16px 0 0">'+esc(args.body)+'</p>'+detail+action+'<p style="font:12px/19px Arial,sans-serif;color:#7a837f;margin:26px 0 0;border-top:1px solid #ece7dc;padding-top:18px">Koa’s Events · Mountain View, Hawaiʻi</p></td></tr></table></td></tr></table></body></html>';
  const text=[args.title,'',args.body,args.detail||'',args.actionUrl?((args.actionLabel||'Open')+': '+args.actionUrl):''].filter(Boolean).join('\n');
  try{
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':args.idempotencyKey.slice(0,256)},body:JSON.stringify({from:fromAddress(),to:recipients,subject:args.subject,html,text,reply_to:replyTo()}),signal:AbortSignal.timeout(12000)});
    const body:any=await response.json().catch(()=>({}));
    return {sent:response.ok,configured:true,id:response.ok?String(body?.id||''):''};
  }catch(error){console.error('Vendor email failed',error);return {sent:false,configured:true,id:''};}
}
