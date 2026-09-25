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

  if (source === 'koa-mobile-bar-inquiry') return 'mobile';
  if (service === 'both' || String(inquiry.venuePackage || '').trim()) return 'events';

  const mobile =
    service === 'mobile-bar' ||
    packageId.startsWith('mobile-') ||
    mobilePackage.startsWith('mobile-');

  return mobile ? 'mobile' : 'events';
}

export function emailBrandName(brand: EmailBrandKey) {
  return brand === 'mobile' ? 'Koa’s Mobile Bar' : 'Koa’s Events';
}

const EMAIL_LOGO_CONTENT_ID = 'koa-email-logo';
const EMAIL_LOGO_FILENAME = 'koa-mark.png';
const EMAIL_LOGO_BASE64 = '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';

export function emailLogoUrl(_brand: EmailBrandKey) {
  // Embed the mark inside the MIME message so Apple Mail does not need to
  // fetch a remote image before displaying the branded header.
  return 'cid:' + EMAIL_LOGO_CONTENT_ID;
}

export function emailLogoAttachment() {
  return {
    filename: EMAIL_LOGO_FILENAME,
    content: EMAIL_LOGO_BASE64,
    content_id: EMAIL_LOGO_CONTENT_ID,
    content_type: 'image/png',
  };
}

export function emailDocumentOpen(args: {
  title: string;
  previewText?: string;
  maxWidth?: number;
}) {
  const width = Math.max(520, Math.min(700, Number(args.maxWidth || 600)));
  const preview = String(args.previewText || '').trim();
  return (
    '<!DOCTYPE html><html lang="en" dir="ltr"><head>' +
      '<meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<meta http-equiv="X-UA-Compatible" content="IE=edge">' +
      '<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">' +
      '<title>' + esc(args.title) + '</title>' +
    '</head>' +
    '<body style="margin:0;padding-top:0;padding-right:0;padding-bottom:0;padding-left:0;background-color:#f5f0e7;">' +
      (preview
        ? '<div style="display:none;max-height:0px;overflow:hidden;opacity:0;color:transparent;font-family:Arial,Helvetica,sans-serif;font-size:1px;line-height:1px;">' + esc(preview) + '</div>'
        : '') +
      '<table role="presentation" lang="en" dir="ltr" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f0e7" style="width:100%;background-color:#f5f0e7;border-collapse:collapse;">' +
        '<tr><td align="center" style="padding-top:20px;padding-right:10px;padding-bottom:20px;padding-left:10px;">' +
          '<!--[if mso]><table role="presentation" width="' + width + '" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:' + width + 'px;background-color:#ffffff;border:1px solid #e7dfd0;border-radius:18px;border-collapse:separate;">'
  );
}

export function emailDocumentClose() {
  return (
          '</table>' +
          '<!--[if mso]></td></tr></table><![endif]-->' +
        '</td></tr>' +
      '</table>' +
    '</body></html>'
  );
}

export function emailButton(args: {
  href: string;
  label: string;
  marginTop?: number;
}) {
  const marginTop = Math.max(0, Math.min(48, Number(args.marginTop ?? 22)));
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:' + marginTop + 'px;border-collapse:separate;">' +
      '<tr><td align="center" bgcolor="#173d30" style="background-color:#173d30;border-radius:999px;mso-padding-alt:12px 20px;">' +
        '<a href="' + esc(args.href) + '" style="display:inline-block;padding-top:12px;padding-right:20px;padding-bottom:12px;padding-left:20px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;text-decoration:none;color:#ffffff;">' + esc(args.label) + '</a>' +
      '</td></tr>' +
    '</table>'
  );
}

export function emailHeader(args: {
  brand: EmailBrandKey;
  eyebrow?: string;
  title?: string;
}) {
  const brandName = emailBrandName(args.brand);
  const eyebrow = String(args.eyebrow || '').trim();
  const showEyebrow = Boolean(eyebrow) && eyebrow.toLowerCase() !== brandName.toLowerCase();
  return (
    '<tr><td align="center" bgcolor="#fbf8f2" style="padding-top:16px;padding-right:20px;padding-bottom:16px;padding-left:20px;background-color:#fbf8f2;border-radius:18px 18px 0 0;">' +
      '<img src="' + esc(emailLogoUrl(args.brand)) + '" width="64" height="64" border="0" alt="' + esc(brandName) + '" style="display:block;width:64px;height:64px;border:0;outline:none;text-decoration:none;">' +
      '<div style="padding-top:7px;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:14px;font-weight:800;letter-spacing:1.7px;text-transform:uppercase;color:#173d30;mso-line-height-rule:exactly;">' + esc(brandName) + '</div>' +
      (showEyebrow
        ? '<div style="padding-top:8px;font-family:Arial,Helvetica,sans-serif;font-size:9px;line-height:13px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#8b5a3c;mso-line-height-rule:exactly;">' + esc(eyebrow) + '</div>'
        : '') +
      (args.title
        ? '<div style="padding-top:3px;font-family:Georgia,Times New Roman,serif;font-size:24px;line-height:29px;font-weight:700;color:#173d30;mso-line-height-rule:exactly;">' + esc(args.title) + '</div>'
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

export type EmailSignaturePerson = {
  name?: string;
  title?: string;
  pronouns?: string;
  roleDescription?: string;
  showTitle?: boolean;
  showTeamTitle?: boolean;
  showPronouns?: boolean;
  showRoleDescription?: boolean;
};

export function emailSignature(person: EmailSignaturePerson = {}) {
  const name = String(person.name || '').trim();
  const title = String(person.title || '').trim();
  const pronouns = String(person.pronouns || '').trim();
  const roleDescription = String(person.roleDescription || '').trim();
  const showTitle = person.showTitle !== false;
  const showTeamTitle = person.showTeamTitle !== false;
  const showPronouns = person.showPronouns === true;
  const showRoleDescription = person.showRoleDescription === true;

  const identity = name
    ? '<div style="padding-top:2px;font-size:15px;line-height:22px;font-weight:800;">' + esc(name) + '</div>' +
      (showPronouns && pronouns ? '<div style="font-size:12px;line-height:18px;color:#66736d;">' + esc(pronouns) + '</div>' : '') +
      (showTitle && title ? '<div style="font-size:13px;line-height:20px;color:#66736d;">' + esc(title) + '</div>' : '') +
      (showRoleDescription && roleDescription ? '<div style="padding-top:2px;font-size:12px;line-height:18px;color:#66736d;">' + esc(roleDescription) + '</div>' : '') +
      (showTeamTitle ? '<div style="padding-top:3px;font-size:13px;line-height:20px;font-weight:700;color:#173d30;">Koa’s Events Team</div>' : '')
    : '<div style="padding-top:2px;font-size:15px;line-height:22px;font-weight:800;">Koa’s Events Team</div>';

  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;border-top:1px solid #ece7dc;border-collapse:collapse;">' +
      '<tr><td style="padding-top:18px;font-family:Arial,Helvetica,sans-serif;color:#173d30;">' +
        '<div style="font-size:14px;line-height:22px;">Mahalo,</div>' +
        identity +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;border-collapse:collapse;">' +
          '<tr>' +
            '<td width="24" valign="top" style="padding:2px 7px 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#8b5a3c;">&#9993;</td>' +
            '<td style="padding:2px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;"><a href="mailto:aloha@koasevents.com" style="color:#173d30;text-decoration:none;">aloha@koasevents.com</a></td>' +
          '</tr>' +
          '<tr>' +
            '<td width="24" valign="top" style="padding:2px 7px 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#8b5a3c;">&#9742;</td>' +
            '<td style="padding:2px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;"><a href="tel:+18448085627" style="color:#173d30;text-decoration:none;">(844) 808-KOAS</a></td>' +
          '</tr>' +
          '<tr>' +
            '<td width="24" valign="top" style="padding:2px 7px 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#8b5a3c;">&#8599;</td>' +
            '<td style="padding:2px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;"><a href="https://www.koasevents.com" style="color:#173d30;text-decoration:none;">www.koasevents.com</a></td>' +
          '</tr>' +
        '</table>' +
      '</td></tr>' +
    '</table>'
  );
}

export function emailSignatureText(person: EmailSignaturePerson = {}) {
  const name = String(person.name || '').trim();
  const title = String(person.title || '').trim();
  const pronouns = String(person.pronouns || '').trim();
  const roleDescription = String(person.roleDescription || '').trim();
  const showTitle = person.showTitle !== false;
  const showTeamTitle = person.showTeamTitle !== false;
  const showPronouns = person.showPronouns === true;
  const showRoleDescription = person.showRoleDescription === true;
  const identity = name
    ? [
        name,
        ...(showPronouns && pronouns ? [pronouns] : []),
        ...(showTitle && title ? [title] : []),
        ...(showRoleDescription && roleDescription ? [roleDescription] : []),
        ...(showTeamTitle ? ['Koa’s Events Team'] : []),
      ]
    : ['Koa’s Events Team'];
  return [
    'Mahalo,',
    '',
    ...identity,
    '✉ aloha@koasevents.com',
    '☎ (844) 808-KOAS',
    '↗ www.koasevents.com',
  ].join('\n');
}
