export type EmailBrandKey = 'events' | 'mobile';

type BrandableRecord = {
  source?: string;
  packageId?: string;
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

function firstName(value: unknown) {
  const name = String(value ?? '').trim();
  return name.split(/\s+/)[0] || '';
}

export function emailBrandForRecord(record: BrandableRecord = {}): EmailBrandKey {
  const inquiry = record.inquiry || {};
  const source = String(record.source || '').trim().toLowerCase();
  const packageId = String(record.packageId || '').trim().toLowerCase();
  const mobilePackage = String(inquiry.mobileBarPackage || '').trim().toLowerCase();
  const service = String(inquiry.service || '').trim().toLowerCase();

  const mobile =
    source === 'koa-mobile-bar-inquiry' ||
    service === 'mobile-bar' ||
    packageId.startsWith('mobile-') ||
    mobilePackage.startsWith('mobile-');

  return mobile ? 'mobile' : 'events';
}

export function emailBrandName(brand: EmailBrandKey) {
  return brand === 'mobile' ? 'Koa’s Mobile Bar' : 'Koa’s Events';
}

export function emailLogoUrl(brand: EmailBrandKey) {
  return brand === 'mobile'
    ? 'https://koasevents.com/brand/koa-mobile-bar-email-logo.png'
    : 'https://koasevents.com/brand/koa-events-email-logo.png';
}

export function emailHeader(args: {
  brand: EmailBrandKey;
  eyebrow?: string;
  title?: string;
}) {
  const brandName = emailBrandName(args.brand);
  return (
    '<tr><td align="center" bgcolor="#fbf8f2" style="padding:24px 28px 22px;background:#fbf8f2;border-radius:22px 22px 0 0;">' +
      '<img src="' + esc(emailLogoUrl(args.brand)) + '" width="170" alt="' + esc(brandName) + '" style="display:block;width:170px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;">' +
      (args.eyebrow
        ? '<div style="padding-top:15px;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:15px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;color:#a96d4a;">' + esc(args.eyebrow) + '</div>'
        : '') +
      (args.title
        ? '<div style="padding-top:5px;font-family:Georgia,Times New Roman,serif;font-size:27px;line-height:33px;font-weight:700;color:#173d30;">' + esc(args.title) + '</div>'
        : '') +
    '</td></tr>'
  );
}

export function emailGreeting(name?: unknown) {
  const nameText = firstName(name);
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#46564f;">Aloha' +
      (nameText ? ' ' + esc(nameText) : '') +
    ',</div>'
  );
}

export function emailGreetingText(name?: unknown) {
  const nameText = firstName(name);
  return 'Aloha' + (nameText ? ' ' + nameText : '') + ',';
}

export function emailSignature() {
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;border-top:1px solid #ece7dc;">' +
      '<tr><td style="padding-top:22px;font-family:Arial,Helvetica,sans-serif;color:#173d30;">' +
        '<div style="font-size:14px;line-height:22px;">Mahalo,</div>' +
        '<div style="padding-top:2px;font-size:15px;line-height:22px;font-weight:800;">Koa’s Events Team</div>' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">' +
          '<tr>' +
            '<td width="24" valign="top" style="padding:2px 7px 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#a96d4a;">&#9993;</td>' +
            '<td style="padding:2px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;"><a href="mailto:aloha@koasevents.com" style="color:#173d30;text-decoration:none;">aloha@koasevents.com</a></td>' +
          '</tr>' +
          '<tr>' +
            '<td width="24" valign="top" style="padding:2px 7px 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#a96d4a;">&#9742;</td>' +
            '<td style="padding:2px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;"><a href="tel:+18448085627" style="color:#173d30;text-decoration:none;">(844) 808-KOAS</a></td>' +
          '</tr>' +
          '<tr>' +
            '<td width="24" valign="top" style="padding:2px 7px 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#a96d4a;">&#8599;</td>' +
            '<td style="padding:2px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;"><a href="https://www.koasevents.com" style="color:#173d30;text-decoration:none;">www.koasevents.com</a></td>' +
          '</tr>' +
        '</table>' +
      '</td></tr>' +
    '</table>'
  );
}

export function emailSignatureText() {
  return [
    'Mahalo,',
    '',
    'Koa’s Events Team',
    '✉ aloha@koasevents.com',
    '☎ (844) 808-KOAS',
    '↗ www.koasevents.com',
  ].join('\n');
}
