import { emailBrandForRecord, emailBrandName, emailButton, emailGreeting, emailGreetingText, emailHeader, emailSignature, emailSignatureText } from './email-brand.ts';

type ReviewRecord = {
  id: string;
  source?: string;
  packageId?: string;
  customer?: {
    name?: string;
    email?: string;
    eventDate?: string;
  };
  inquiry?: Record<string, any>;
};

function esc(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function firstName(record: ReviewRecord) {
  const name = String(record.customer?.name || '').trim();
  return name.split(/\s+/)[0] || 'there';
}

function formatDate(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const date = new Date(raw.length <= 10 ? raw + 'T12:00:00' : raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function reviewUrl() {
  return String(
    Netlify.env.get('KOA_GOOGLE_REVIEW_URL') ||
    'https://search.google.com/local/writereview?placeid=ChIJqUJ-794zUnkR59_4DdRzq4g'
  ).trim();
}

function html(record: ReviewRecord) {
  const eventDate = formatDate(record.customer?.eventDate);
  const url = reviewUrl();
  const brand = emailBrandForRecord(record);
  const brandName = emailBrandName(brand);

  return (
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no"></head>' +
    '<body style="margin:0;padding:0;background:#f5f0e7;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f0e7">' +
        '<tr><td align="center" style="padding-top:20px;padding-right:10px;padding-bottom:20px;padding-left:10px;">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:650px;background:#ffffff;border:1px solid #e7dfd0;border-radius:22px;">' +
            emailHeader({ brand, eyebrow: brandName, title: 'Mahalo for celebrating with us.' }) +
            '<tr><td style="padding-top:26px;padding-right:22px;padding-bottom:26px;padding-left:22px;">' +
              emailGreeting(firstName(record)) +
              '<div style="padding-top:10px;font-family:Georgia,Times New Roman,serif;font-size:34px;line-height:40px;font-weight:700;color:#173d30;">Would you share your Koa’s experience?</div>' +
              '<div style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#46564f;">Thank you for trusting ' + esc(brandName) + ' with your celebration' + (eventDate ? ' on ' + esc(eventDate) : '') + '. If you have a moment, we would be grateful if you shared an honest Google review. Your feedback helps future couples and hosts understand what it is actually like to celebrate with Koa’s.</div>' +
              emailButton({ href: url, label: 'Share a Google review →', marginTop: 22 }) +
              '<div style="padding-top:22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#46564f;">If there is anything you would rather tell us directly, simply reply to this email. We read every note.</div>' +
              emailSignature() +
              '<div style="padding-top:18px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:18px;color:#8a918d;">This is a one-time post-event feedback request from ' + esc(brandName) + '.</div>' +
            '</td></tr>' +
          '</table>' +
        '</td></tr>' +
      '</table>' +
    '</body></html>'
  );
}

function text(record: ReviewRecord) {
  const eventDate = formatDate(record.customer?.eventDate);
  const brand = emailBrandForRecord(record);
  const brandName = emailBrandName(brand);

  return [
    emailGreetingText(firstName(record)),
    '',
    'Mahalo for celebrating with ' + brandName + (eventDate ? ' on ' + eventDate : '') + '.',
    '',
    'If you have a moment, we would be grateful if you shared an honest Google review. Your feedback helps future couples and hosts understand what it is actually like to celebrate with Koa’s.',
    '',
    'Share a Google review:',
    reviewUrl(),
    '',
    'If there is anything you would rather tell us directly, simply reply to this email. We read every note.',
    '',
    emailSignatureText(),
    '',
    'This is a one-time post-event feedback request from ' + brandName + '.',
  ].join('\n');
}

export async function sendReviewRequest(record: ReviewRecord) {
  const apiKey = String(Netlify.env.get('RESEND_API_KEY') || '').trim();
  const email = String(record.customer?.email || '').trim();
  if (!apiKey || !email || !email.includes('@')) {
    return { sent: false, configured: Boolean(apiKey), id: '' };
  }

  const brandName = emailBrandName(emailBrandForRecord(record));
  const from = String(Netlify.env.get('KOA_CLIENT_EMAIL_FROM') || 'Koa’s Events <aloha@koasevents.com>').trim();
  const replyTo = String(Netlify.env.get('KOA_CLIENT_REPLY_TO') || 'aloha@koasevents.com').trim();

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Idempotency-Key': ('koa-google-review-' + record.id).slice(0, 256),
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Mahalo from ' + brandName + ' — would you share your experience?',
        html: html(record),
        text: text(record),
        reply_to: replyTo,
      }),
      signal: AbortSignal.timeout(12_000),
    });

    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Review request email failed', response.status, body?.message || body?.name || '');
      return { sent: false, configured: true, id: '' };
    }

    return { sent: true, configured: true, id: String(body?.id || '') };
  } catch (error) {
    console.error('Review request email error', error);
    return { sent: false, configured: true, id: '' };
  }
}
