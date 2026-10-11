export type TurnstileAlertKind = 'infrastructure_failure' | 'security_mismatch' | 'unclassified_rejections' | 'expected_rejections' | 'healthy';
export type TurnstileAlertSeverity = 'urgent' | 'upcoming' | 'info' | 'none';
export interface TurnstileActivitySummary {
  rejected24h: number;
  expectedRejected24h: number;
  infrastructureRejected24h: number;
  infrastructureRejected15m: number;
  securityMismatch24h: number;
  unclassifiedRejected24h: number;
  smokePattern24h: number;
  latestRejectedAt: string;
}
export interface TurnstileAlert {
  kind: TurnstileAlertKind;
  severity: TurnstileAlertSeverity;
  title: string;
  detail: string;
}
export function classifyTurnstileRejection(row: { ok?: unknown; codes?: unknown }): 'accepted' | 'infrastructure' | 'security_mismatch' | 'expected_rejection' | 'unclassified_rejection';
export function summarizeTurnstileActivity(rows: any[], nowMs?: number): TurnstileActivitySummary;
export function classifyTurnstileAlert(status: any): TurnstileAlert;
