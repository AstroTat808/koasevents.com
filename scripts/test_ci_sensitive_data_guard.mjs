import fs from 'node:fs';

const workflows = [
  '.github/workflows/production-visual-qa.yml',
  '.github/workflows/critical-integrations-rollback-drill.yml',
];

const forbiddenLiterals = [
  'visual-results/system-health-dashboard.json',
  'visual-results/accounting-adjustment-diagnostics.json',
  'visual-results/accounting-repair-bulk-preview.json',
  'visual-results/production-accounting-audits.json',
  'visual-results/critical-integration-real-rollback-drill.json',
  'visual-results/netlify-sandbox-self-heal-drill.json',
  'Historical QBO adjustment diagnostics:',
  'Production safe repair preview:',
];

const forbiddenPatterns = [
  { label: 'hard-coded QuickBooks customer record ID', pattern: /\bQBO-CUST-\d+\b/g },
  {
    label: 'raw response body printed with cat',
    pattern: /\bcat\s+["']?\$(?:raw_file|verification_file|recovery_file|audit_file|report_file|dark_mode_response)\b/gi,
  },
  {
    label: 'raw authenticated response echoed',
    pattern: /\becho\s+["']?\$(?:verification|recovery|response|audit|report|raw_file|verification_file|recovery_file|audit_file|report_file|dark_mode_response)\b/gi,
  },
  {
    label: 'repair preview rows emitted to CI',
    pattern: /['"]rows['"]\s*:\s*preview\.get\(['"]rows['"]\)/g,
  },
];

const rawFileVariables = new Set([
  'raw_file',
  'verification_file',
  'recovery_file',
  'audit_file',
  'report_file',
  'dark_mode_response',
]);

const violations = [];

for (const workflow of workflows) {
  const source = fs.readFileSync(workflow, 'utf8');
  const lines = source.split(/\r?\n/);

  for (const literal of forbiddenLiterals) {
    if (source.includes(literal)) {
      violations.push(`${workflow}: forbidden literal ${literal}`);
    }
  }

  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(source)) {
      violations.push(`${workflow}: ${rule.label}`);
    }
    rule.pattern.lastIndex = 0;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const assignment = lines[index].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=["']([^"']+)["']\s*$/);
    if (assignment && rawFileVariables.has(assignment[1]) && !assignment[2].startsWith('/tmp/')) {
      violations.push(
        `${workflow}:${index + 1}: raw response variable ${assignment[1]} must point into /tmp, found ${assignment[2]}`,
      );
    }

    if (!lines[index].includes('github-main-signal')) continue;
    const start = Math.max(0, index - 16);
    const windowText = lines.slice(start, index + 1).join('\n');
    const outputMatch = windowText.match(/-o\s+(?:"([^"]+)"|'([^']+)'|([^\s\\]+))/);
    if (!outputMatch) {
      violations.push(
        `${workflow}:${index + 1}: authenticated github-main-signal call must capture its response body instead of writing it to stdout`,
      );
      continue;
    }
    const destination = outputMatch[1] || outputMatch[2] || outputMatch[3] || '';
    if (destination.startsWith('visual-results/')) {
      violations.push(
        `${workflow}:${index + 1}: authenticated github-main-signal response cannot be written directly to an artifact path`,
      );
    }
    if (destination.startsWith('$')) {
      const variableName=destination.slice(1).replace(/[{}]/g,'');
      if (!rawFileVariables.has(variableName)) {
        violations.push(
          `${workflow}:${index + 1}: authenticated response uses unapproved output variable ${destination}`,
        );
      }
    } else if (!destination.startsWith('/tmp/')) {
      violations.push(
        `${workflow}:${index + 1}: authenticated github-main-signal response must be written only to /tmp, found ${destination}`,
      );
    }
  }
}

if (violations.length) {
  console.error('Sensitive CI data guard failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('Sensitive CI data guard passed: authenticated production responses stay in /tmp and uploaded artifacts exclude raw client/accounting/System Health payloads.');
