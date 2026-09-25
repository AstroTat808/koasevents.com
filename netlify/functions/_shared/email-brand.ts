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

export function emailLogoUrl(_brand: EmailBrandKey) {
  // Use the compact Koa mark in email clients. The previous tall lockup assets
  // reserve a large transparent area in Apple Mail and can appear blank.
  return 'https://koasevents.com/brand/koa-mark.png';
}

export function emailDocumentOpen(args: {
  title: string;
  previewText?: string;
  maxWidth?: number;
}) {
  const width = Math.max(520, Math.min(700, Number(args.maxWidth || 600)));
  const preview = String(args.previewText || '').trim();
  return (
    '<!DOCTYPE html><html lang="en"><head>' +
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
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f0e7" style="width:100%;background-color:#f5f0e7;border-collapse:collapse;">' +
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
  return (
    '<tr><td align="center" bgcolor="#fbf8f2" style="padding-top:16px;padding-right:20px;padding-bottom:16px;padding-left:20px;background-color:#fbf8f2;border-radius:18px 18px 0 0;">' +
      '<img src="' + esc(emailLogoUrl(args.brand)) + '" width="52" height="52" border="0" alt="' + esc(brandName) + '" style="display:block;width:52px;height:52px;border:0;outline:none;text-decoration:none;">' +
      '<div style="padding-top:7px;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:14px;font-weight:800;letter-spacing:1.7px;text-transform:uppercase;color:#173d30;mso-line-height-rule:exactly;">' + esc(brandName) + '</div>' +
      (args.eyebrow
        ? '<div style="padding-top:8px;font-family:Arial,Helvetica,sans-serif;font-size:9px;line-height:13px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#a96d4a;mso-line-height-rule:exactly;">' + esc(args.eyebrow) + '</div>'
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
      (showPronouns && pronouns ? '<div style="font-size:12px;line-height:18px;color:#7a857f;">' + esc(pronouns) + '</div>' : '') +
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
