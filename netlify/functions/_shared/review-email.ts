type ReviewRecord = {
  id: string;
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
  return (
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>' +
    '<body style="margin:0;padding:0;background:#f5f0e7;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f0e7">' +
        '<tr><td align="center" style="padding:28px 12px;">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:650px;background:#ffffff;border:1px solid #e7dfd0;border-radius:22px;">' +
            '<tr><td bgcolor="#173d30" style="padding:24px 28px;background:#173d30;border-radius:22px 22px 0 0;">' +
              '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
                '<td width="56"><img src="https://koasevents.com/brand/koa-mark.png" width="52" height="52" alt="Koa’s Events" style="display:block;border:0;border-radius:12px;"></td>' +
                '<td style="padding-left:14px;"><div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#e4c48f;">Koa’s Events</div>' +
                '<div style="padding-top:4px;font-family:Georgia,Times New Roman,serif;font-size:27px;line-height:32px;font-weight:700;color:#ffffff;">Mahalo for celebrating with us.</div></td>' +
              '</tr></table>' +
            '</td></tr>' +
            '<tr><td style="padding:32px 30px;">' +
              '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#66736d;">Aloha ' + esc(firstName(record)) + ',</div>' +
              '<div style="padding-top:10px;font-family:Georgia,Times New Roman,serif;font-size:34px;line-height:40px;font-weight:700;color:#173d30;">Would you share your Koa’s experience?</div>' +
              '<div style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#46564f;">Thank you for trusting Koa’s Events with your celebration' + (eventDate ? ' on ' + esc(eventDate) : '') + '. If you have a moment, we would be grateful if you shared an honest Google review. Your feedback helps future couples and hosts understand what it is actually like to celebrate with Koa’s.</div>' +
              '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;"><tr><td bgcolor="#173d30" style="background-color:#173d30;border-radius:999px;">' +
                '<a href="' + esc(url) + '" style="display:inline-block;padding:14px 22px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;font-weight:800;letter-spacing:1px;text-transform:uppercase;text-decoration:none;color:#ffffff;">Share a Google review →</a>' +
              '</td></tr></table>' +
              '<div style="padding-top:22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:25px;color:#46564f;">If there is anything you would rather tell us directly, simply reply to this email. We read every note.</div>' +
              '<div style="padding-top:26px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#173d30;"><strong>Mahalo,</strong><br>Koa’s Events Team</div>' +
              '<div style="padding-top:24px;margin-top:24px;border-top:1px solid #ece7dc;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:18px;color:#8a918d;">This is a one-time post-event feedback request from Koa’s Events.</div>' +
            '</td></tr>' +
          '</table>' +
        '</td></tr>' +
      '</table>' +
    '</body></html>'
  );
}

function text(record: ReviewRecord) {
  const eventDate = formatDate(record.customer?.eventDate);
  return [
    'Aloha ' + firstName(record) + ',',
    '',
    'Mahalo for celebrating with Koa’s Events' + (eventDate ? ' on ' + eventDate : '') + '.',
    '',
    'If you have a moment, we would be grateful if you shared an honest Google review. Your feedback helps future couples and hosts understand what it is actually like to celebrate with Koa’s.',
    '',
    'Share a Google review:',
    reviewUrl(),
    '',
    'If there is anything you would rather tell us directly, simply reply to this email. We read every note.',
    '',
    'Mahalo,',
    'Koa’s Events Team',
    '',
    'This is a one-time post-event feedback request from Koa’s Events.',
  ].join('\n');
}

export async function sendReviewRequest(record: ReviewRecord) {
  const apiKey = String(Netlify.env.get('RESEND_API_KEY') || '').trim();
  const email = String(record.customer?.email || '').trim();
  if (!apiKey || !email || !email.includes('@')) {
    return { sent: false, configured: Boolean(apiKey), id: '' };
  }

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
        subject: 'Mahalo from Koa’s Events — would you share your experience?',
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
