import { type EmailBrandKey, emailBrandName, emailButton, emailGreeting, emailGreetingText, emailHeader, emailLogoAttachment, emailSignature, emailSignatureText } from './email-brand.ts';

function esc(value:unknown){
  return String(value??'').replace(/[&<>"']/g,(m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]||m));
}

function fromAddress(){
  return String(Netlify.env.get('KOA_VENDOR_EMAIL_FROM')||Netlify.env.get('KOA_CLIENT_EMAIL_FROM')||'Koa’s Events <aloha@koasevents.com>').trim();
}

function replyTo(){
  return String(Netlify.env.get('KOA_CLIENT_REPLY_TO')||'aloha@koasevents.com').trim();
}

export async function sendVendorEmail(args:{
  to:string[];
  subject:string;
  title:string;
  body:string;
  detail?:string;
  actionLabel?:string;
  actionUrl?:string;
  idempotencyKey:string;
  recipientName?:string;
  brand?:EmailBrandKey;
}){
  const apiKey=String(Netlify.env.get('RESEND_API_KEY')||'').trim();
  const recipients=args.to.map(x=>String(x||'').trim()).filter(x=>x.includes('@'));
  if(!apiKey||!recipients.length)return {sent:false,configured:Boolean(apiKey),id:''};

  const brand=args.brand||'events';
  const brandName=emailBrandName(brand);
  const action=args.actionUrl
    ? emailButton({href:args.actionUrl,label:args.actionLabel||'Open',marginTop:22})
    :'';
  const detail=args.detail
    ? '<div style="margin-top:18px;padding:14px 16px;background:#f5f0e7;border-radius:12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:21px;font-weight:700;color:#173d30">'+esc(args.detail)+'</div>'
    :'';

  const html=
    '<!doctype html><html lang="en" dir="ltr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no"><title>'+esc(args.subject)+'</title></head><body style="margin:0;background:#f5f0e7">' +
      '<table role="presentation" lang="en" dir="ltr" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding-top:20px;padding-right:10px;padding-bottom:20px;padding-left:10px">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#fff;border:1px solid #e7dfd0;border-radius:20px">' +
          emailHeader({brand,eyebrow:brandName,title:'Vendor Event Brief'}) +
          '<tr><td style="padding-top:26px;padding-right:22px;padding-bottom:26px;padding-left:22px">' +
            emailGreeting(args.recipientName) +
            '<h1 style="font-family:Georgia,Times New Roman,serif;font-size:32px;line-height:39px;font-weight:700;color:#173d30;margin:10px 0 0">'+esc(args.title)+'</h1>' +
            '<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#46564f;margin:16px 0 0">'+esc(args.body)+'</p>' +
            detail +
            action +
            emailSignature() +
            '<p style="font:11px/18px Arial,sans-serif;color:#66736d;margin:18px 0 0">This operational message was sent by '+esc(brandName)+' for an upcoming event.</p>' +
          '</td></tr>' +
        '</table>' +
      '</td></tr></table>' +
    '</body></html>';

  const text=[
    emailGreetingText(args.recipientName),
    '',
    args.title,
    '',
    args.body,
    args.detail||'',
    args.actionUrl?((args.actionLabel||'Open')+': '+args.actionUrl):'',
    '',
    emailSignatureText(),
  ].filter(Boolean).join('\n');

  try{
    const response=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{
        Authorization:'Bearer '+apiKey,
        'Content-Type':'application/json',
        'Idempotency-Key':args.idempotencyKey.slice(0,256)
      },
      body:JSON.stringify({
        from:fromAddress(),
        to:recipients,
        subject:args.subject,
        html,
        text,
        attachments:[emailLogoAttachment()],
        reply_to:replyTo()
      }),
      signal:AbortSignal.timeout(12000)
    });
    const body:any=await response.json().catch(()=>({}));
    return {sent:response.ok,configured:true,id:response.ok?String(body?.id||''):''};
  }catch(error){
    console.error('Vendor email failed',error);
    return {sent:false,configured:true,id:''};
  }
}
