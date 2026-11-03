import { resolveTenant } from './tenant';
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

  if (source.endsWith('mobile-bar-inquiry')) return 'mobile';
  if (service === 'both' || String(inquiry.venuePackage || '').trim()) return 'events';

  const mobile =
    service === 'mobile-bar' ||
    packageId.startsWith('mobile-') ||
    mobilePackage.startsWith('mobile-');

  return mobile ? 'mobile' : 'events';
}

function activeTenant(){ try { return resolveTenant(); } catch { return null; } }

export function emailBrandName(brand: EmailBrandKey) {
  const tenant=activeTenant();
  const root=tenant?.displayName || 'VenueLoom Organization';
  return brand === 'mobile' ? root + ' Mobile Bar' : root;
}

const EMAIL_LOGO_CONTENT_ID = 'venueloom-email-logo';
const EMAIL_LOGO_FILENAME = 'organization-logo.png';
// The pixel image itself is opaque and white-backed; iPhone Mail's Dark Mode
// can recolor HTML backgrounds, but must not change the actual emblem.
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

export function emailLogoMetadata() {
  return {
    contentId: EMAIL_LOGO_CONTENT_ID,
    cid: 'cid:' + EMAIL_LOGO_CONTENT_ID,
    filename: EMAIL_LOGO_FILENAME,
    contentType: 'image/png',
  };
}

export function emailInlineAssetAudit(html: unknown, attachments: any[] = []) {
  const referencedContentIds = Array.from(
    new Set(
      Array.from(String(html ?? '').matchAll(/cid:([^"'\\s>]+)/gi))
        .map((match) => String(match[1] || '').trim())
        .filter(Boolean),
    ),
  );
  const attachedContentIds = Array.from(
    new Set(
      (Array.isArray(attachments) ? attachments : [])
        .map((attachment) => String(attachment?.content_id || attachment?.contentId || '').trim())
        .filter(Boolean),
    ),
  );
  const attached = new Set(attachedContentIds);
  const missingContentIds = referencedContentIds.filter((contentId) => !attached.has(contentId));
  return {
    ok: missingContentIds.length === 0,
    referencedContentIds,
    attachedContentIds,
    missingContentIds,
    detail: missingContentIds.length
      ? 'Missing inline attachment for CID: ' + missingContentIds.join(', ')
      : referencedContentIds.length
        ? 'Every CID image reference has a matching inline attachment.'
        : 'No CID image references were found in the email HTML.',
  };
}

export function assertEmailInlineAssets(html: unknown, attachments: any[] = []) {
  const audit = emailInlineAssetAudit(html, attachments);
  if (!audit.ok) throw new Error('Email inline asset validation failed. ' + audit.detail);
  return audit;
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
      '<img src="' + esc(emailLogoUrl(args.brand)) + '" width="64" height="64" border="0" alt="' + esc(brandName) + '" style="display:block;width:64px;height:64px;border:0;outline:none;text-decoration:none;background-color:#ffffff;">' +
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
      (showTeamTitle ? '<div style="padding-top:3px;font-size:13px;line-height:20px;font-weight:700;color:#173d30;">'+emailBrandName('events')+' Team</div>' : '')
    : '<div style="padding-top:2px;font-size:15px;line-height:22px;font-weight:800;">'+emailBrandName('events')+' Team</div>';

  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;border-top:1px solid #ece7dc;border-collapse:collapse;">' +
      '<tr><td style="padding-top:18px;font-family:Arial,Helvetica,sans-serif;color:#173d30;">' +
        '<div style="font-size:14px;line-height:22px;">Mahalo,</div>' +
        identity +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;border-collapse:collapse;">' +
          '<tr>' +
            '<td width="24" valign="top" style="padding:2px 7px 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#8b5a3c;">&#9993;</td>' +
            '<td style="padding:2px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;"><a href="mailto:' + esc(activeTenant()?.contact.email || '') + '" style="color:#173d30;text-decoration:none;">' + esc(activeTenant()?.contact.email || '') + '</a></td>' +
          '</tr>' +
          '<tr>' +
            '<td width="24" valign="top" style="padding:2px 7px 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#8b5a3c;">&#9742;</td>' +
            '<td style="padding:2px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;"><a href="tel:' + esc(activeTenant()?.contact.phone || '') + '" style="color:#173d30;text-decoration:none;">' + esc(activeTenant()?.contact.phoneDisplay || activeTenant()?.contact.phone || '') + '</a></td>' +
          '</tr>' +
          '<tr>' +
            '<td width="24" valign="top" style="padding:2px 7px 2px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#8b5a3c;">&#8599;</td>' +
            '<td style="padding:2px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;"><a href="https://' + esc(activeTenant()?.domains.primary || '') + '" style="color:#173d30;text-decoration:none;">' + esc(activeTenant()?.domains.primary || '') + '</a></td>' +
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
        ...(showTeamTitle ? [emailBrandName('events')+' Team'] : []),
      ]
    : [emailBrandName('events')+' Team'];
  return [
    'Mahalo,',
    '',
    ...identity,
    '✉ ' + (activeTenant()?.contact.email || ''),
    '☎ ' + (activeTenant()?.contact.phoneDisplay || activeTenant()?.contact.phone || ''),
    '↗ ' + (activeTenant()?.domains.primary || ''),
  ].join('\n');
}
