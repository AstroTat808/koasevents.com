// Security telemetry classification. These rules never participate in admission
// control: the CRM still verifies every token and blocks unsuccessful Siteverify.
// "Expected" means the rejection is consistent with an incomplete/invalid
// challenge, not proof that the sender was a bot.
const EXPECTED_REJECTION_CODES = new Set([
  'missing-token', 'missing-input-response', 'invalid-input-response',
  'timeout-or-duplicate',
]);
const INFRASTRUCTURE_CODES = new Set([
  'missing-secret', 'missing-input-secret', 'invalid-input-secret',
  'siteverify-unavailable', 'siteverify-http-error',
  'siteverify-invalid-response', 'internal-error',
]);
const MISMATCH_CODES = new Set(['hostname-mismatch', 'action-mismatch']);
const DAY = 86400000;
const FIFTEEN_MINUTES = 15 * 60000;

function safeCode(value) {
  return String(value ?? '').trim().toLowerCase().slice(0, 120);
}

export function classifyTurnstileRejection(row) {
  if (row?.ok === true) return 'accepted';
  const codes = Array.isArray(row?.codes) ? row.codes.map(safeCode).filter(Boolean) : [];
  if (codes.some((code) => INFRASTRUCTURE_CODES.has(code))) return 'infrastructure';
  if (codes.some((code) => MISMATCH_CODES.has(code))) return 'security_mismatch';
  if (codes.length && codes.every((code) => EXPECTED_REJECTION_CODES.has(code))) return 'expected_rejection';
  return 'unclassified_rejection';
}

export function summarizeTurnstileActivity(rows, nowMs = Date.now()) {
  const counts = {
    rejected24h: 0,
    expectedRejected24h: 0,
    infrastructureRejected24h: 0,
    infrastructureRejected15m: 0,
    securityMismatch24h: 0,
    unclassifiedRejected24h: 0,
    smokePattern24h: 0,
    latestRejectedAt: '',
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = Date.parse(String(row?.createdAt ?? ''));
    if (!Number.isFinite(at) || at > nowMs || at <= nowMs - DAY || row?.ok !== false) continue;
    counts.rejected24h += 1;
    if (!counts.latestRejectedAt || at > Date.parse(counts.latestRejectedAt)) {
      counts.latestRejectedAt = new Date(at).toISOString();
    }
    if (row?.sourceHint === 'matches-ci-smoke-pattern') counts.smokePattern24h += 1;
    const reason = classifyTurnstileRejection(row);
    if (reason === 'expected_rejection') counts.expectedRejected24h += 1;
    else if (reason === 'infrastructure') {
      counts.infrastructureRejected24h += 1;
      if (at > nowMs - FIFTEEN_MINUTES) counts.infrastructureRejected15m += 1;
    } else if (reason === 'security_mismatch') counts.securityMismatch24h += 1;
    else counts.unclassifiedRejected24h += 1;
  }
  return counts;
}

export function classifyTurnstileAlert(status) {
  const totals = status?.activity || {};
  const infrastructure = [
    !status?.siteKeyConfigured ? 'public site key missing' : '',
    !status?.secretConfigured ? 'server-side secret missing' : '',
    !status?.widgetRendering?.ok ? 'protected form widget check failed' : '',
    !status?.siteverify?.ok ? 'Cloudflare Siteverify probe failed' : '',
    !status?.telemetry?.ok ? 'validation-history storage integrity failed' : '',
    Number(totals.infrastructureRejected15m || 0) > 0
      ? 'server-side verification infrastructure errors in the last 15 minutes'
      : '',
  ].filter(Boolean);
  if (infrastructure.length) {
    return {
      kind: 'infrastructure_failure',
      severity: 'urgent',
      title: 'Turnstile verification infrastructure failure',
      detail: infrastructure.join('; '),
    };
  }
  if (Number(status?.mismatches?.total || 0) > 0 || Number(totals.securityMismatch24h || 0) > 0) {
    return {
      kind: 'security_mismatch',
      severity: 'urgent',
      title: 'Turnstile security mismatch detected',
      detail: 'Cloudflare-accepted challenge metadata failed hostname or action matching; investigate before treating this as ordinary bot activity.',
    };
  }
  if (Number(totals.unclassifiedRejected24h || 0) > 0) {
    return {
      kind: 'unclassified_rejections',
      severity: 'upcoming',
      title: 'Turnstile rejection reasons need review',
      detail: 'Rejections contain unknown codes; do not assume these were bots or that verification infrastructure is healthy.',
    };
  }
  if (Number(totals.expectedRejected24h || 0) > 0) {
    return {
      kind: 'expected_rejections',
      severity: 'info',
      title: 'Turnstile rejected invalid challenges',
      detail: 'Invalid, missing, expired or duplicate tokens were rejected by the server; not an infrastructure failure by itself.',
    };
  }
  return {
    kind: 'healthy',
    severity: 'none',
    title: 'Turnstile verification operational',
    detail: 'Required configuration, site verification and event recording checks are healthy.',
  };
}
