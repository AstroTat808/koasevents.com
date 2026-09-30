export const LOGIN_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const LOGIN_FAILURE_WINDOW_MS = 30 * 60 * 1000;

export function successfulAuthEventType(type) {
  return type === 'login_success' || type === 'suspicious_login';
}

export function classifyLoginRisk({
  recentFailureCount = 0,
  hasHistory = false,
  knownNetwork = true,
  knownDevice = true,
  trustedDevice = false,
} = {}) {
  const failures = Math.max(0, Number(recentFailureCount) || 0);
  const contextReasons = [];

  if (hasHistory && !knownNetwork) contextReasons.push('new network fingerprint');
  if (hasHistory && !knownDevice) contextReasons.push('new device/browser');

  const failureReason = failures >= 2
    ? failures + ' failed sign-in attempts in the last 30 minutes'
    : '';

  const shouldAlert =
    failures >= 3
    || (!trustedDevice && failures >= 2 && contextReasons.length >= 1);

  const suspicious =
    shouldAlert
    || (!trustedDevice && contextReasons.length >= 2);

  const riskLevel = shouldAlert
    ? 'high'
    : suspicious
      ? 'review'
      : contextReasons.length
        ? 'notice'
        : 'normal';

  const reasons = [
    ...(failureReason ? [failureReason] : []),
    ...contextReasons,
  ];

  return {
    suspicious,
    shouldAlert,
    riskLevel,
    reasons,
    contextReasons,
    recentFailureCount: failures,
    trustedDevice: Boolean(trustedDevice),
  };
}

export function loginAlertSuppressionKey({ email = '', deviceFingerprint = '', device = '' } = {}) {
  const account = String(email || '').trim().toLowerCase();
  const identity = String(deviceFingerprint || device || 'unknown-device').trim().toLowerCase();
  return account + '|' + identity;
}
