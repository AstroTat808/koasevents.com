// Security outcomes are not infrastructure health. A correct CAPTCHA rejection
// must never be promoted into an outage or silently counted as an accepted token.
const INFRASTRUCTURE_CODES = new Set([
  'missing-secret', 'siteverify-unavailable', 'invalid-input-secret',
  'missing-input-secret', 'internal-error', 'bad-request',
]);
const EXPECTED_REJECTION_CODES = new Set([
  'missing-token', 'missing-input-response', 'invalid-input-response',
  'timeout-or-duplicate',
]);

export function classifyTurnstileAlert(status = {}) {
  const totals = status?.totals || {};
  const recentRejected = Math.max(0, Number(totals.rejected24h) || 0);
  const expectedRejected = Math.max(0, Number(totals.expectedRejected24h) || 0);
  const infrastructureRejected = Math.max(0, Number(totals.infrastructureRejected24h) || 0);
  const unexpectedRejected = Math.max(0, Number(totals.unexpectedRejected24h) || 0);
  const mismatchCount = Math.max(0, Number(status?.mismatches?.total) || 0);
  const reasons = [];
  if (!status?.siteKeyConfigured) reasons.push('site_key_missing');
  if (!status?.secretConfigured) reasons.push('server_secret_missing');
  if (!status?.widgetRendering?.ok) reasons.push('widget_health_failed');
  if (!status?.siteverify?.ok) reasons.push('siteverify_probe_failed');
  if (!status?.telemetry?.ok) reasons.push('history_recorder_unhealthy');
  if (infrastructureRejected > 0) reasons.push('runtime_verification_errors');

  if (reasons.length) {
    return {
      status: 'infrastructure_failure', alert: true, severity: 'urgent',
      reasons, rejected24h: recentRejected,
      expectedRejected24h: expectedRejected,
      infrastructureRejected24h: infrastructureRejected,
      unexpectedRejected24h: unexpectedRejected,
      summary: 'Turnstile infrastructure needs attention: ' + reasons.join(', ') +
        '. Rejected tokens remain blocked.',
    };
  }
  if (mismatchCount || unexpectedRejected) {
    return {
      status: 'verification_anomaly', alert: true, severity: 'urgent',
      reasons: [...(mismatchCount ? ['hostname_or_action_mismatch'] : []),
        ...(unexpectedRejected ? ['unclassified_rejection'] : [])],
      rejected24h: recentRejected,
      expectedRejected24h: expectedRejected,
      infrastructureRejected24h: 0,
      unexpectedRejected24h: unexpectedRejected,
      summary: 'Turnstile verification anomaly requires investigation. No token was trusted without valid verification.',
    };
  }
  if (expectedRejected > 0) {
    return {
      status: 'expected_rejections', alert: false, severity: 'info',
      reasons: [], rejected24h: recentRejected,
      expectedRejected24h: expectedRejected,
      infrastructureRejected24h: 0, unexpectedRejected24h: 0,
      summary: expectedRejected + ' invalid Turnstile token(s) correctly rejected in 24h. Protection healthy; no outage.',
    };
  }
  return {
    status: 'healthy', alert: false, severity: 'green',
    reasons: [], rejected24h: 0, expectedRejected24h: 0,
    infrastructureRejected24h: 0, unexpectedRejected24h: 0,
    summary: 'Turnstile enforcement and validation-history recording healthy; no recent invalid tokens.',
  };
}

export function classifyRejectionCodes(codes) {
  const values = Array.isArray(codes) ? codes.map((value) => String(value || '').trim()) : [];
  if (values.some((code) => INFRASTRUCTURE_CODES.has(code))) return 'infrastructure';
  if (values.length && values.every((code) => EXPECTED_REJECTION_CODES.has(code))) return 'expected';
  return 'unexpected';
}
