import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const roots = ['netlify/functions', 'netlify/edge-functions', 'src'];
const extensions = new Set(['.ts','.mts','.tsx','.js','.mjs','.jsx','.astro']);
const failures = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes:true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return extensions.has(path.extname(entry.name)) ? [full] : [];
  });
}

function lineOf(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}


const emailTemplateFiles = [
  'netlify/functions/_shared/lead-email.ts',
  'netlify/functions/_shared/review-email.ts',
  'netlify/functions/_shared/vendor-email.ts',
  'netlify/functions/_shared/accounting-alerts.ts',
  'netlify/functions/_shared/auth-security.ts',
  'netlify/functions/_shared/system-health.ts',
  'netlify/functions/admin-email-preview.mts',
];

function checkEmailCompatibility() {
  const brandPath = 'netlify/functions/_shared/email-brand.ts';
  if (!fs.existsSync(brandPath)) {
    failures.push(brandPath + ': shared email-brand module is missing');
    return;
  }

  const brand = fs.readFileSync(brandPath, 'utf8');
  const brandChecks = [
    ['compact explicit logo dimensions', /width="64" height="64"/],
    ['CID logo URL', /return 'cid:' \+ EMAIL_LOGO_CONTENT_ID/],
    ['embedded logo attachment helper', /export function emailLogoAttachment/],
    ['embedded logo content ID', /content_id: EMAIL_LOGO_CONTENT_ID/],
    ['embedded PNG content type', /content_type: 'image\/png'/],
    ['Outlook-safe button padding', /mso-padding-alt:/],
    ['table-based email button helper', /export function emailButton/],
    ['standard email document helper', /export function emailDocumentOpen/],
  ];
  for (const [label, pattern] of brandChecks) {
    if (!pattern.test(brand)) failures.push(brandPath + ': missing ' + label);
  }

  for (const file of emailTemplateFiles) {
    if (!fs.existsSync(file)) {
      failures.push(file + ': automated email template source is missing');
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (!/emailHeader\(/.test(text)) failures.push(file + ': does not use the shared branded email header');
    if (!/emailLogoAttachment\(/.test(text)) failures.push(file + ': does not attach the embedded email logo');
    if (!/emailSignature\(/.test(text)) failures.push(file + ': does not use the shared branded email signature');
    if (/background-image\s*:/.test(text)) failures.push(file + ': CSS background-image is not Outlook-safe');
    if (/<button\b/i.test(text)) failures.push(file + ': HTML <button> found; email actions must use linked table buttons');
    if (/(display\s*:\s*flex|display\s*:\s*grid)/i.test(text)) failures.push(file + ': flex/grid layout found in email HTML');
    if (/src=["']\//i.test(text)) failures.push(file + ': relative image URL found in email HTML');
    if (!/viewport/.test(text)) failures.push(file + ': viewport metadata is missing');
    if (!/X-UA-Compatible/.test(text)) failures.push(file + ': Outlook compatibility metadata is missing');
    if (!/<title>/.test(text)) failures.push(file + ': email document title is missing');
    if (!/dir="ltr"/.test(text)) failures.push(file + ': left-to-right direction metadata is missing');
    if (/#(?:a96d4a|8a918d|78827d|7a857f)/i.test(text)) failures.push(file + ': low-contrast legacy email color remains');
  }
}

function checkEmailFeatureContracts() {
  const contracts = [
    ['src/pages/admin/email-preview/index.astro', [
      ['iPhone email preview', 'data-preview-frame="iphone"'],
      ['Gmail email preview', 'data-preview-frame="gmail"'],
      ['Outlook email preview', 'data-preview-frame="outlook"'],
    ]],
    ['netlify/functions/_shared/email-health.ts', [
      ['email logo health probe', 'async function checkLogo()'],
      ['Resend send access probe', 'async function checkResendSendAccess()'],
      ['Resend delivery health query', 'async function listResendEmails()'],
      ['dedicated monitoring credential', "RESEND_MONITORING_API_KEY"],
      ['signed delivery event storage', 'export async function recordEmailHealthEvent'],
      ['email health summary', 'export async function emailHealthSummary'],
    ]],
    ['netlify/functions/_shared/credential-health.ts', [
      ['credential health summary', 'export async function credentialHealthSummary'],
      ['Resend credential health', "id: 'resend-send'"],
      ['QuickBooks credential health', "id: 'quickbooks'"],
      ['Microsoft Graph credential health', "id: 'microsoft-graph'"],
      ['GitHub credential health', "id: 'github'"],
      ['Netlify credential health', "id: 'netlify'"],
      ['credential recommended actions', 'function recommendedAction'],
      ['QuickBooks reconnect action', "label: 'Reconnect QuickBooks'"],
      ['Microsoft configuration action', "label: 'Open Microsoft configuration'"],
    ]],
    ['netlify/functions/_shared/system-health.ts', [
      ['Email Health integration', "import { emailHealthSummary } from './email-health'"],
      ['health issue classification', 'export function classifyHealthIssue'],
      ['email logo component', "id:'email-logo'"],
      ['email send access component', "id:'email-send-access'"],
      ['email monitoring access component', "id:'email-monitoring-access'"],
      ['email delivery component', "id:'email-delivery'"],
      ['email compatibility component', "id:'email-template-compatibility'"],
      ['email release sync component', "id:'email-release-sync'"],
    ]],
    ['src/pages/admin/health/index.astro', [
      ['Email Health dashboard', 'data-email-health-overall'],
      ['Credential Health dashboard', 'data-credential-health-overall'],
      ['credential health cards', 'data-credential-health-grid'],
      ['credential health recommended actions', 'dataset.credentialHealthAction'],
      ['root cause summary', 'data-root-cause-summary'],
      ['root cause filters', 'data-root-cause-filter'],
      ['root cause clear action', 'data-root-cause-clear'],
      ['health issue type label', 'data-health-detail-issue-type'],
      ['email send access status', 'data-email-health-send'],
      ['email monitoring access status', 'data-email-health-monitoring'],
      ['email release warning', 'data-email-health-release-alert'],
      ['email release warning links', 'data-email-health-release-actions'],
      ['email release status', 'data-email-health-release'],
      ['production email renderer card', 'data-email-renderer-match'],
      ['renderer live commit link', 'data-email-renderer-live'],
      ['renderer GitHub main link', 'data-email-renderer-main'],
      ['renderer deploy link', 'data-email-renderer-deploy'],
      ['email issue list', 'data-email-health-issues'],
      ['email 24-hour delivery stats', 'data-email-health-24-delivered'],
    ]],
    ['netlify/functions/resend-webhook.mts', [
      ['Email Health webhook recording', 'recordEmailHealthEvent'],
    ]],
  ];

  for (const [file, requirements] of contracts) {
    if (!fs.existsSync(file)) {
      failures.push(file + ': required Email Health/preview source is missing');
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    for (const [label, needle] of requirements) {
      if (!text.includes(needle)) failures.push(file + ': missing ' + label + ' contract: ' + needle);
    }
  }
}

function checkScript(file) {
  const text = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);

  for (const diagnostic of sourceFile.parseDiagnostics || []) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    failures.push(file + ':' + lineOf(sourceFile, diagnostic.start || 0) + ' syntax: ' + message);
  }

  let defaultExports = 0;
  let configExports = 0;
  const functionBodies = new Map();

  for (const statement of sourceFile.statements) {
    const modifiers = statement.modifiers || [];
    const isExport = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (isExport && isDefault) defaultExports += 1;

    if (ts.isVariableStatement(statement) && isExport) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === 'config') configExports += 1;
      }
    }

    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      const name = statement.name.text;
      const rows = functionBodies.get(name) || [];
      rows.push(lineOf(sourceFile, statement.pos));
      functionBodies.set(name, rows);
    }
  }

  if (defaultExports > 1) failures.push(file + ': multiple default exports (' + defaultExports + ')');
  if (configExports > 1) failures.push(file + ': multiple exported config declarations (' + configExports + ')');

  for (const [name, lines] of functionBodies) {
    if (lines.length > 1) failures.push(file + ': duplicate top-level function "' + name + '" at lines ' + lines.join(', '));
  }

  const suspicious = [
    /export\s+const\s+config[^\n;]*;\s*\+/,
    /export\s+default[\s\S]{0,80}export\s+default/,
  ];
  for (const pattern of suspicious) {
    if (pattern.test(text)) failures.push(file + ': suspicious concatenated/duplicated export structure');
  }
}

for (const file of roots.flatMap(walk)) {
  if (file.endsWith('.astro')) {
    const text = fs.readFileSync(file, 'utf8');
    if ((text.match(/<script\b/g) || []).length > 6) {
      failures.push(file + ': unusually high number of script blocks; inspect for accidental duplication');
    }
    if (/\$\$\$\s*\(/.test(text)) {
      failures.push(file + ': invalid triple-dollar selector helper ($$) detected');
    }
    if (/(^|[^$])\$\([^\n]*?\)\.forEach\s*\(/m.test(text)) {
      failures.push(file + ': single-element $() selector cannot be iterated with forEach; use $()');
    }
    continue;
  }
  checkScript(file);
}

checkEmailCompatibility();
checkEmailFeatureContracts();

if (failures.length) {
  console.error('\nBuild-safety audit failed:\n');
  for (const failure of failures) console.error(' - ' + failure);
  console.error('\nFix these structural errors before building or deploying.\n');
  process.exit(2);
}

console.log('Build-safety audit passed: no malformed syntax, duplicate default/config exports, or duplicate top-level function bodies detected.');
