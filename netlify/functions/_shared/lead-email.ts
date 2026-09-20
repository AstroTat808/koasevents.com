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

type LeadKind = 'wedding' | 'event' | 'stay' | 'discovery' | 'mobile';

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
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(n)
    : '';
}

function formatDate(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const date = new Date(raw.length <= 10 ? raw + 'T12:00:00' : raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function leadKind(record: LeadRecord): LeadKind {
  switch (record.source) {
    case 'koa-wedding-inquiry':
      return 'wedding';
    case 'koa-stay-inquiry':
      return 'stay';
    case 'koa-discovery-call-request':
      return 'discovery';
    case 'koa-mobile-bar-inquiry':
      return 'mobile';
    default:
      return 'event';
  }
}

function heading(record: LeadRecord) {
  const kind = leadKind(record);
  if (kind === 'wedding') return 'New Wedding Inquiry';
  if (kind === 'stay') return 'New Stay Inquiry';
  if (kind === 'discovery') return 'New Discovery Call Request';
  if (kind === 'mobile') return 'New Mobile Bar Inquiry';

  return 'New Private Event Inquiry';
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

function serviceLabel(value: unknown) {
  const raw = String(value ?? '').trim();
  const labels: Record<string, string> = {
    venue: 'Venue',
    'mobile-bar': 'Mobile Bar',
    both: 'Venue + Mobile Bar',
    stay: 'Stay at Koa’s',
    'discovery-call': 'Discovery Call',
  };
  return labels[raw] || raw;
}

function row(label: string, value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return (
    '<tr>' +
      '<td width="180" valign="top" style="padding-top:8px;padding-right:16px;padding-bottom:8px;padding-left:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#78827d;">' +
        esc(label) +
      '</td>' +
      '<td valign="top" style="padding-top:8px;padding-right:0;padding-bottom:8px;padding-left:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#173d30;">' +
        esc(text).replace(/\n/g, '<br>') +
      '</td>' +
    '</tr>'
  );
}

function rowsFor(record: LeadRecord) {
  const inquiry = record.inquiry || {};
  const kind = leadKind(record);
  const rows: string[] = [];

  rows.push(row('CRM record', record.id));

  if (kind === 'wedding') {
    rows.push(row('Couple / client', record.customer?.name));
    rows.push(row('Email', record.customer?.email));
    rows.push(row('Phone', record.customer?.phone));
    rows.push(row('Wedding date', formatDate(record.customer?.eventDate)));
    rows.push(row('Alternate date', formatDate(inquiry.alternativeDate)));
    rows.push(row('Guest count', inquiry.guestCount));
    rows.push(row('Budget', inquiry.budget));
    rows.push(row('Planning from', inquiry.planningFrom));
    rows.push(row('Wedding package', packageLabel(record)));
    rows.push(row('Saved quote', record.quoteId));
    rows.push(row('Selected rentals', inquiry.selectedCatalogItems));
    rows.push(row('Manual add-ons', inquiry.manualAddOns));
    rows.push(row('Wedding vision', record.customer?.notes || inquiry.priorities));
    return rows.join('');
  }

  if (kind === 'stay') {
    rows.push(row('Guest', record.customer?.name));
    rows.push(row('Email', record.customer?.email));
    rows.push(row('Arrival', formatDate(inquiry.arrival || record.customer?.eventDate)));
    rows.push(row('Departure', formatDate(inquiry.departure)));
    rows.push(row('Guests', inquiry.guestCount));
    rows.push(row('Stay type', inquiry.stayType));
    rows.push(row('Notes', record.customer?.notes || inquiry.priorities));
    return rows.join('');
  }

  if (kind === 'discovery') {
    rows.push(row('Client / couple', record.customer?.name));
    rows.push(row('Email', record.customer?.email));
    rows.push(row('Phone', record.customer?.phone));
    rows.push(row('Preferred date', formatDate(inquiry.preferredDate || record.customer?.eventDate)));
    rows.push(row('Preferred time', inquiry.preferredTime));
    rows.push(row('Alternate window', inquiry.alternateWindow));
    rows.push(row('Related wedding package', packageLabel(record)));
    rows.push(row('Saved quote', record.quoteId));
    return rows.join('');
  }

  if (kind === 'mobile') {
    rows.push(row('Client', record.customer?.name));
    rows.push(row('Email', record.customer?.email));
    rows.push(row('Phone', record.customer?.phone));
    rows.push(row('Event date', formatDate(record.customer?.eventDate)));
    rows.push(row('Event type', inquiry.eventType));
    rows.push(row('Guest count', inquiry.guestCount));
    rows.push(row('Budget', inquiry.budget));
    rows.push(row('Event location', inquiry.eventLocation));
    rows.push(row('Mobile Bar package', packageLabel(record)));
    rows.push(row('Service hours', inquiry.serviceHours));
    rows.push(row('Bartenders', inquiry.bartenderCount));
    rows.push(row('One-way miles', inquiry.oneWayMiles));
    rows.push(row('Gratuity preference', inquiry.gratuityMode));
    rows.push(row('Glassware count', inquiry.glasswareCount));
    rows.push(row('Custom add-ons', Array.isArray(inquiry.customAddOns) ? inquiry.customAddOns.join(', ') : ''));
    rows.push(row('Estimated total', money(inquiry.estimatedTotal)));
    rows.push(row('Notes / priorities', record.customer?.notes || inquiry.priorities));
    return rows.join('');
  }

  rows.push(row('Client', record.customer?.name));
  rows.push(row('Email', record.customer?.email));
  rows.push(row('Phone', record.customer?.phone));
  rows.push(row('Event date', formatDate(record.customer?.eventDate)));
  rows.push(row('Event type', inquiry.eventType));
  rows.push(row('Guest count', inquiry.guestCount));
  rows.push(row('Budget', inquiry.budget));
  rows.push(row('Service requested', serviceLabel(inquiry.service)));
  rows.push(row('Venue package', inquiry.venuePackage ? packageLabel(record) : ''));
  rows.push(row('Mobile Bar package', inquiry.mobileBarPackage ? packageLabel({ ...record, packageId: inquiry.mobileBarPackage }) : ''));
  rows.push(row('Event location', inquiry.eventLocation));
  rows.push(row('Bar style', inquiry.barStyle));
  rows.push(row('Venue tour', inquiry.venueTour));
  rows.push(row('How they found Koa’s', inquiry.source));
  rows.push(row('Selected rentals', inquiry.selectedCatalogItems));
  rows.push(row('Manual add-ons', inquiry.manualAddOns));
  rows.push(row('Priorities / notes', record.customer?.notes || inquiry.priorities));
  return rows.join('');
}

function estimateLines(record: LeadRecord) {
  if (leadKind(record) !== 'mobile') return '';
  const items = Array.isArray(record.inquiry?.estimateLineItems) ? record.inquiry?.estimateLineItems : [];
  if (!items.length) return '';

  const rows = items.map((item: any) => {
    const amount = money(item.amount);
    return (
      '<tr>' +
        '<td valign="top" style="padding-top:9px;padding-right:12px;padding-bottom:9px;padding-left:0;border-top:1px solid #ece7dc;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#173d30;">' +
          esc(String(item.quantity || 1) + ' × ' + String(item.description || '')) +
        '</td>' +
        '<td valign="top" align="right" style="padding-top:9px;padding-right:0;padding-bottom:9px;padding-left:12px;border-top:1px solid #ece7dc;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;font-weight:700;color:#173d30;">' +
          esc(amount || (item.custom ? 'Custom' : '')) +
        '</td>' +
      '</tr>'
    );
  }).join('');

  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;">' +
      '<tr><td style="padding-top:0;padding-right:0;padding-bottom:8px;padding-left:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#a96d4a;">Estimate breakdown</td></tr>' +
      '<tr><td>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
          rows +
        '</table>' +
      '</td></tr>' +
    '</table>'
  );
}

function buildHtml(record: LeadRecord) {
  const title = heading(record);
  const crmUrl = 'https://koasevents.com/admin/quotes/?q=' + encodeURIComponent(record.id);
  const clientName = String(record.customer?.name || '').trim() || 'New lead';

  return (
    '<!DOCTYPE html>' +
    '<html>' +
      '<head>' +
        '<meta charset="UTF-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
        '<meta http-equiv="X-UA-Compatible" content="IE=edge">' +
        '<title>' + esc(title) + '</title>' +
      '</head>' +
      '<body style="margin:0;padding:0;background-color:#f5f0e7;">' +
        '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc(title + ' from ' + clientName) + '</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f0e7" style="width:100%;background-color:#f5f0e7;">' +
          '<tr>' +
            '<td align="center" style="padding-top:28px;padding-right:12px;padding-bottom:28px;padding-left:12px;">' +
              '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:680px;background-color:#ffffff;border:1px solid #e7dfd0;border-radius:22px;">' +
                '<tr>' +
                  '<td bgcolor="#173d30" style="padding-top:24px;padding-right:28px;padding-bottom:24px;padding-left:28px;background-color:#173d30;border-radius:22px 22px 0 0;">' +
                    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
                      '<tr>' +
                        '<td width="56" valign="middle">' +
                          '<img src="https://koasevents.com/brand/koa-mark.png" width="52" height="52" border="0" alt="Koa’s Events" style="display:block;width:52px;height:52px;border:0;border-radius:12px;">' +
                        '</td>' +
                        '<td valign="middle" style="padding-left:14px;">' +
                          '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#e4c48f;">Koa’s Events</div>' +
                          '<div style="padding-top:4px;font-family:Georgia,Times New Roman,serif;font-size:27px;line-height:32px;font-weight:700;color:#ffffff;">' + esc(title) + '</div>' +
                        '</td>' +
                      '</tr>' +
                    '</table>' +
                  '</td>' +
                '</tr>' +
                '<tr>' +
                  '<td style="padding-top:30px;padding-right:30px;padding-bottom:30px;padding-left:30px;">' +
                    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#a96d4a;">Lead summary</div>' +
                    '<div style="padding-top:7px;font-family:Georgia,Times New Roman,serif;font-size:34px;line-height:39px;font-weight:700;color:#173d30;">' + esc(clientName) + '</div>' +
                    '<div style="padding-top:10px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#66736d;">The most relevant details for this inquiry are summarized below. The CRM record contains the full quote state, security history, and follow-up workflow.</div>' +
                    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;">' +
                      rowsFor(record) +
                    '</table>' +
                    estimateLines(record) +
                    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">' +
                      '<tr>' +
                        '<td bgcolor="#173d30" style="background-color:#173d30;border-radius:999px;">' +
                          '<a href="' + esc(crmUrl) + '" style="display:inline-block;padding-top:14px;padding-right:22px;padding-bottom:14px;padding-left:22px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;font-weight:800;letter-spacing:1px;text-transform:uppercase;text-decoration:none;color:#ffffff;">Open in Sales CRM →</a>' +
                        '</td>' +
                      '</tr>' +
                    '</table>' +
                    '<div style="padding-top:24px;margin-top:24px;border-top:1px solid #ece7dc;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:18px;color:#8a918d;">Replying to this email addresses the client when their email is available. This notification was generated by the Koa’s Events CRM intake pipeline.</div>' +
                  '</td>' +
                '</tr>' +
              '</table>' +
            '</td>' +
          '</tr>' +
        '</table>' +
      '</body>' +
    '</html>'
  );
}

function buildText(record: LeadRecord) {
  const inquiry = record.inquiry || {};
  const kind = leadKind(record);
  const lines = [
    heading(record),
    '',
    'CRM record: ' + record.id,
    'Client: ' + (record.customer?.name || ''),
    'Email: ' + (record.customer?.email || ''),
    'Phone: ' + (record.customer?.phone || ''),
  ];

  if (kind === 'wedding') {
    lines.push(
      'Wedding date: ' + formatDate(record.customer?.eventDate),
      'Alternate date: ' + formatDate(inquiry.alternativeDate),
      'Guest count: ' + (inquiry.guestCount || ''),
      'Budget: ' + (inquiry.budget || ''),
      'Planning from: ' + (inquiry.planningFrom || ''),
      'Wedding package: ' + packageLabel(record),
      'Saved quote: ' + (record.quoteId || ''),
      '',
      'Wedding vision:',
      String(record.customer?.notes || inquiry.priorities || ''),
    );
  } else if (kind === 'stay') {
    lines.push(
      'Arrival: ' + formatDate(inquiry.arrival || record.customer?.eventDate),
      'Departure: ' + formatDate(inquiry.departure),
      'Guests: ' + (inquiry.guestCount || ''),
      'Stay type: ' + (inquiry.stayType || ''),
      '',
      'Notes:',
      String(record.customer?.notes || inquiry.priorities || ''),
    );
  } else if (kind === 'discovery') {
    lines.push(
      'Preferred date: ' + formatDate(inquiry.preferredDate || record.customer?.eventDate),
      'Preferred time: ' + (inquiry.preferredTime || ''),
      'Alternate window: ' + (inquiry.alternateWindow || ''),
      'Related wedding package: ' + packageLabel(record),
      'Saved quote: ' + (record.quoteId || ''),
    );
  } else if (kind === 'mobile') {
    lines.push(
      'Event date: ' + formatDate(record.customer?.eventDate),
      'Event type: ' + (inquiry.eventType || ''),
      'Guest count: ' + (inquiry.guestCount || ''),
      'Budget: ' + (inquiry.budget || ''),
      'Event location: ' + (inquiry.eventLocation || ''),
      'Mobile Bar package: ' + packageLabel(record),
      'Service hours: ' + (inquiry.serviceHours || ''),
      'Bartenders: ' + (inquiry.bartenderCount || ''),
      'Estimated total: ' + money(inquiry.estimatedTotal),
      '',
      'Notes / priorities:',
      String(record.customer?.notes || inquiry.priorities || ''),
    );
  } else {
    lines.push(
      'Event date: ' + formatDate(record.customer?.eventDate),
      'Event type: ' + (inquiry.eventType || ''),
      'Guest count: ' + (inquiry.guestCount || ''),
      'Budget: ' + (inquiry.budget || ''),
      'Service requested: ' + serviceLabel(inquiry.service),
      'Event location: ' + (inquiry.eventLocation || ''),
      'Venue package: ' + (inquiry.venuePackage ? packageLabel(record) : ''),
      'Mobile Bar package: ' + (inquiry.mobileBarPackage ? packageLabel({ ...record, packageId: inquiry.mobileBarPackage }) : ''),
      '',
      'Priorities / notes:',
      String(record.customer?.notes || inquiry.priorities || ''),
    );
  }

  lines.push(
    '',
    'Open in Sales CRM:',
    'https://koasevents.com/admin/quotes/?q=' + encodeURIComponent(record.id),
  );

  return lines.join('\n');
}

export async function sendLeadNotification(record: LeadRecord) {
  const apiKey = String(Netlify.env.get('RESEND_API_KEY') || '').trim();
  if (!apiKey) return { sent: false, configured: false, id: '' };

  const to = String(Netlify.env.get('KOA_LEAD_EMAIL_TO') || 'aloha@koasevents.com').trim();
  const from = String(Netlify.env.get('KOA_LEAD_EMAIL_FROM') || 'Koa’s Events <leads@koasevents.com>').trim();
  const subject = heading(record) + ' — ' + (record.customer?.name || record.id);
  const requestBody = JSON.stringify({
    from,
    to: [to],
    subject,
    html: buildHtml(record),
    text: buildText(record),
    reply_to: record.customer?.email || undefined,
  });
  const idempotencyKey = ('koa-lead-' + record.id + '-' + String(record.source || 'website')).slice(0, 256);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: requestBody,
        signal: AbortSignal.timeout(12_000),
      });
      const body: any = await response.json().catch(() => ({}));

      if (response.ok) {
        return { sent: true, configured: true, id: String(body?.id || '') };
      }

      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      console.error('Lead notification email failed', response.status, body?.message || body?.name || '');
      if (!retryable || attempt === 2) return { sent: false, configured: true, id: '' };
    } catch (error) {
      console.error('Lead notification email error', error);
      if (attempt === 2) return { sent: false, configured: true, id: '' };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return { sent: false, configured: true, id: '' };
}
