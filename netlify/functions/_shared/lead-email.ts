type LeadRecord = {
  id: string;
  source?: string;
  quoteId?: string;
  packageId?: string;
  createdAt?: string;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
    eventDate?: string;
    notes?: string;
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

function money(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n)
    : '';
}

function labelSource(source = '') {
  const labels: Record<string, string> = {
    'koa-wedding-inquiry': 'Wedding Inquiry',
    'koa-event-inquiry': 'Event Inquiry',
    'koa-mobile-bar-inquiry': 'Mobile Bar Inquiry',
    'koa-discovery-call-request': 'Discovery Call Request',
    'koa-stay-inquiry': 'Stay Inquiry',
  };
  return labels[source] || 'Website Inquiry';
}

function packageLabel(record: LeadRecord) {
  const id = String(record.packageId || record.inquiry?.venuePackage || record.inquiry?.mobileBarPackage || '');
  const labels: Record<string, string> = {
    gardenia: 'Gardenia Wedding Collection',
    orchid: 'Orchid Wedding Collection',
    hibiscus: 'Hibiscus Wedding Collection',
    'signature-wedding': 'Koa’s Signature Wedding Experience',
    'mobile-oahu': 'Koa’s Mobile Bar — Oahu Package',
    'mobile-maui': 'Koa’s Mobile Bar — Maui Package',
    'mobile-big-island': 'Koa’s Mobile Bar — Big Island Package',
    'mobile-custom': 'Koa’s Mobile Bar — Custom / Bartender-only',
  };
  return labels[id] || id;
}

function row(label: string, value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return '<tr><td style="padding:7px 0;color:#66736d;font-size:13px;width:165px;vertical-align:top;">' +
    esc(label) +
    '</td><td style="padding:7px 0;color:#16372d;font-size:14px;font-weight:650;vertical-align:top;">' +
    esc(text).replace(/\n/g, '<br>') +
    '</td></tr>';
}

function listRows(record: LeadRecord) {
  const inquiry = record.inquiry || {};
  const lines: string[] = [];
  lines.push(row('CRM record', record.id));
  lines.push(row('Client / couple', record.customer?.name));
  lines.push(row('Email', record.customer?.email));
  lines.push(row('Phone', record.customer?.phone));
  lines.push(row('Event date', record.customer?.eventDate));
  lines.push(row('Event type', inquiry.eventType));
  lines.push(row('Guest count', inquiry.guestCount));
  lines.push(row('Budget', inquiry.budget));
  lines.push(row('Package', packageLabel(record)));
  lines.push(row('Event location', inquiry.eventLocation));
  lines.push(row('Alternate date', inquiry.alternativeDate));
  lines.push(row('Preferred contact', inquiry.contactMethod));
  lines.push(row('Preferred time', inquiry.preferredTime));
  lines.push(row('Departure', inquiry.departure));
  lines.push(row('Stay type', inquiry.stayType));
  lines.push(row('Estimated total', money(inquiry.estimatedTotal)));
  lines.push(row('Saved quote', record.quoteId));
  lines.push(row('Selected catalog items', inquiry.selectedCatalogItems));
  lines.push(row('Manual add-ons', inquiry.manualAddOns));
  lines.push(row('Custom add-ons', Array.isArray(inquiry.customAddOns) ? inquiry.customAddOns.join(', ') : ''));
  lines.push(row('Notes / priorities', record.customer?.notes || inquiry.priorities));
  return lines.join('');
}

function estimateLines(record: LeadRecord) {
  const items = Array.isArray(record.inquiry?.estimateLineItems) ? record.inquiry?.estimateLineItems : [];
  if (!items.length) return '';
  const rows = items.map((item: any) => {
    const amount = money(item.amount);
    return '<tr><td style="padding:8px 0;border-top:1px solid #ece7dc;color:#16372d;font-size:13px;">' +
      esc(String(item.quantity || 1) + ' × ' + String(item.description || '')) +
      '</td><td style="padding:8px 0;border-top:1px solid #ece7dc;color:#16372d;font-size:13px;font-weight:700;text-align:right;">' +
      esc(amount || (item.custom ? 'Custom' : '')) +
      '</td></tr>';
  }).join('');
  return '<div style="margin-top:22px;"><div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#a96d4a;font-weight:800;margin-bottom:8px;">Estimate breakdown</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0">' + rows + '</table></div>';
}

function buildHtml(record: LeadRecord) {
  const source = labelSource(record.source || '');
  const crmUrl = 'https://koasevents.com/admin/quotes/?q=' + encodeURIComponent(record.id);
  return '<!doctype html><html><body style="margin:0;background:#f5f0e7;font-family:Arial,Helvetica,sans-serif;color:#16372d;">' +
    '<div style="display:none;max-height:0;overflow:hidden;">New ' + esc(source) + ' from ' + esc(record.customer?.name || 'a prospective client') + '.</div>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f0e7;padding:28px 12px;"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #e7dfd0;">' +
    '<tr><td style="background:#173d30;padding:26px 30px;"><table role="presentation" width="100%"><tr><td style="vertical-align:middle;"><img src="https://koasevents.com/brand/koa-mark.png" width="52" height="52" alt="Koa’s Events" style="display:block;border-radius:12px;"></td><td style="padding-left:14px;color:#fff;"><div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#e4c48f;font-weight:800;">Koa’s Events</div><div style="font-size:25px;font-weight:750;margin-top:4px;">New ' + esc(source) + '</div></td></tr></table></td></tr>' +
    '<tr><td style="padding:30px;">' +
    '<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#a96d4a;font-weight:800;">Lead summary</div>' +
    '<div style="font-family:Georgia,Times,serif;font-size:34px;line-height:1.05;margin-top:8px;color:#16372d;">' + esc(record.customer?.name || 'New inquiry') + '</div>' +
    '<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#66736d;">Submitted through ' + esc(source) + '. Open the CRM record for the full timeline, security review, quote state, and next-step workflow.</div>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:20px;">' + listRows(record) + '</table>' +
    estimateLines(record) +
    '<div style="margin-top:28px;"><a href="' + esc(crmUrl) + '" style="display:inline-block;background:#173d30;color:#ffffff;text-decoration:none;border-radius:999px;padding:14px 22px;font-size:12px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;">Open in Sales CRM →</a></div>' +
    '<div style="margin-top:24px;padding-top:18px;border-top:1px solid #ece7dc;font-size:11px;line-height:1.6;color:#8a918d;">This notification was generated from the Koa’s Events CRM intake pipeline. Replying to this email will reply to the client when their email address is available.</div>' +
    '</td></tr></table></td></tr></table></body></html>';
}

function buildText(record: LeadRecord) {
  const inquiry = record.inquiry || {};
  const lines = [
    'New ' + labelSource(record.source || ''),
    '',
    'CRM record: ' + record.id,
    'Client / couple: ' + (record.customer?.name || ''),
    'Email: ' + (record.customer?.email || ''),
    'Phone: ' + (record.customer?.phone || ''),
    'Event date: ' + (record.customer?.eventDate || ''),
    'Event type: ' + (inquiry.eventType || ''),
    'Guest count: ' + (inquiry.guestCount || ''),
    'Budget: ' + (inquiry.budget || ''),
    'Package: ' + packageLabel(record),
    'Event location: ' + (inquiry.eventLocation || ''),
    'Estimated total: ' + money(inquiry.estimatedTotal),
    'Saved quote: ' + (record.quoteId || ''),
    '',
    'Notes / priorities:',
    String(record.customer?.notes || inquiry.priorities || ''),
    '',
    'Open in Sales CRM:',
    'https://koasevents.com/admin/quotes/?q=' + encodeURIComponent(record.id),
  ];
  return lines.filter((line, index) => line || index < 2).join('\n');
}

export async function sendLeadNotification(record: LeadRecord) {
  const apiKey = String(Netlify.env.get('RESEND_API_KEY') || '').trim();
  if (!apiKey) return { sent: false, configured: false };

  const to = String(Netlify.env.get('KOA_LEAD_EMAIL_TO') || 'aloha@koasevents.com').trim();
  const from = String(Netlify.env.get('KOA_LEAD_EMAIL_FROM') || 'Koa’s Events <leads@koasevents.com>').trim();
  const subject = 'New ' + labelSource(record.source || '') + ' — ' + (record.customer?.name || record.id);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'koa-lead-' + record.id,
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html: buildHtml(record),
        text: buildText(record),
        reply_to: record.customer?.email || undefined,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Lead notification email failed', response.status, body?.message || body?.name || '');
      return { sent: false, configured: true };
    }
    return { sent: true, configured: true, id: String(body?.id || '') };
  } catch (error) {
    console.error('Lead notification email error', error);
    return { sent: false, configured: true };
  }
}
