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
    label: 'raw sensitive response printed with cat',
    pattern: /\bcat\s+[^\n]*(?:system-health|accounting|verification_file|recovery_file|audit_file|report_file|raw_[A-Za-z0-9_]*file)/gi,
  },
  {
    label: 'raw authenticated response echoed',
    pattern: /\becho\s+["']?\$(?:verification|recovery|response|audit|report|raw_[A-Za-z0-9_]*)\b/gi,
  },
  {
    label: 'repair preview rows emitted to CI',
    pattern: /['"]rows['"]\s*:\s*preview\.get\(['"]rows['"]\)/g,
  },
];

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
    if (!lines[index].includes('github-main-signal')) continue;
    const start = Math.max(0, index - 14);
    const window = lines.slice(start, index + 1);
    const outputLine = [...window].reverse().find((line) => /-o\s+/.test(line));
    if (!outputLine) continue;
    const match = outputLine.match(/-o\s+["']?([^"'\\\s]+)/);
    if (!match) continue;
    const destination = match[1];
    if (!destination.startsWith('/tmp/')) {
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

console.log('Sensitive CI data guard passed: production responses are temporary and public artifacts are allowlisted summaries only.');
