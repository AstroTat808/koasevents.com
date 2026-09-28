import type { Config, Context } from '@netlify/functions';
import { resolveTenant, runForEachTenant } from './_shared/tenant';
import { tenantStoreFor } from './_shared/tenant-storage';
import { tenantEnv } from './_shared/tenant-env';
import { sendClientFollowUp, sendResponseReminder } from './_shared/lead-email.ts';

const RESPONSE_TYPES = new Set([
  'email',
  'call',
  'meeting',
  'responded',
  'proposal_sent',
  'quickbooks_estimate_sent',
]);

function hoursSince(value: unknown) {
  const time = Date.parse(String(value || ''));
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, (Date.now() - time) / 3_600_000);
}

function reminderBusinessHours() {
  const configured = Number(tenantEnv(resolveTenant(),'LEAD_RESPONSE_REMINDER_HOURS','KOA_LEAD_RESPONSE_REMINDER_HOURS') || 4);
  if (!Number.isFinite(configured)) return 4;
  return Math.min(24, Math.max(1, configured));
}

function clientFollowUpHours() {
  const configured = Number(tenantEnv(resolveTenant(),'CLIENT_FOLLOW_UP_HOURS','KOA_CLIENT_FOLLOW_UP_HOURS') || 24);
  if (!Number.isFinite(configured)) return 24;
  return Math.min(168, Math.max(6, configured));
}

function businessStartHour() {
  const configured = Number(tenantEnv(resolveTenant(),'BUSINESS_START_HOUR','KOA_BUSINESS_START_HOUR') || 9);
  return Number.isFinite(configured) ? Math.min(16, Math.max(0, Math.floor(configured))) : 9;
}

function businessEndHour() {
  const start = businessStartHour();
  const configured = Number(tenantEnv(resolveTenant(),'BUSINESS_END_HOUR','KOA_BUSINESS_END_HOUR') || 17);
  return Number.isFinite(configured) ? Math.min(24, Math.max(start + 1, Math.floor(configured))) : 17;
}

function localBusinessClock(utcMs: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTenant().timezone || 'UTC',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcMs));
  return {
    weekday: parts.find((part) => part.type === 'weekday')?.value || '',
    hour: Number(parts.find((part) => part.type === 'hour')?.value || 0),
  };
}

function isBusinessOpen(utcMs = Date.now()) {
  const local = localBusinessClock(utcMs);
  return !['Sat','Sun'].includes(local.weekday)
    && local.hour >= businessStartHour()
    && local.hour < businessEndHour();
}

function businessHoursBetween(startValue: unknown, endMs = Date.now()) {
  const startMs = Date.parse(String(startValue || ''));
  if (!Number.isFinite(startMs) || endMs <= startMs) return 0;

  // Reminder windows are short; sample in 15-minute slices so DST and arbitrary
  // tenant time zones are handled by Intl rather than a fixed UTC offset.
  const step = 15 * 60 * 1000;
  const cappedEnd = Math.min(endMs, startMs + 60 * 86_400_000);
  let milliseconds = 0;
  for (let cursor = startMs; cursor < cappedEnd; cursor += step) {
    const next = Math.min(cursor + step, cappedEnd);
    if (isBusinessOpen(cursor + Math.floor((next - cursor) / 2))) milliseconds += next - cursor;
  }
  return milliseconds / 3_600_000;
}

function relatedRecordIds(record: any, records: any[]) {
  const ids = new Set<string>([String(record.id || '')].filter(Boolean));
  const quoteId = String(record.quoteId || '');
  if (quoteId) {
    records.filter((entry) => String(entry?.quoteId || '') === quoteId).forEach((entry) => ids.add(String(entry.id || '')));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of records) {
      const entryId = String(entry?.id || '');
      const sourceId = String(entry?.source || '');
      if (!entryId) continue;
      if ((sourceId && ids.has(sourceId)) || (record.source && entryId === String(record.source))) {
        if (!ids.has(entryId)) { ids.add(entryId); changed = true; }
        if (sourceId && !ids.has(sourceId)) { ids.add(sourceId); changed = true; }
      }
    }
  }
  return ids;
}

function waitingSince(record: any, records: any[]) {
  const ids = relatedRecordIds(record, records);
  const dates = records
    .filter((entry) => ids.has(String(entry?.id || '')))
    .map((entry) => Date.parse(String(entry?.createdAt || '')))
    .filter((value) => Number.isFinite(value));
  const earliest = dates.length ? Math.min(...dates) : Date.parse(String(record.createdAt || ''));
  return Number.isFinite(earliest) ? new Date(earliest).toISOString() : String(record.createdAt || '');
}

function hasResponse(record: any, records: any[], events: any[]) {
  const ids = relatedRecordIds(record, records);
  const since = Date.parse(waitingSince(record, records));
  return events.some((event) =>
    ids.has(String(event?.recordId || '')) &&
    RESPONSE_TYPES.has(String(event?.type || '')) &&
    Date.parse(String(event?.createdAt || '')) >= since
  );
}

function hasEvent(record: any, records: any[], events: any[], type: string) {
  const ids = relatedRecordIds(record, records);
  return events.some((event) =>
    ids.has(String(event?.recordId || '')) &&
    String(event?.type || '') === type
  );
}

function recentFailure(record: any, records: any[], events: any[], type: string, retryHours = 6) {
  const ids = relatedRecordIds(record, records);
  return events.some((event) =>
    ids.has(String(event?.recordId || '')) &&
    String(event?.type || '') === type &&
    hoursSince(event?.createdAt) < retryHours
  );
}

async function runTenantJob(_req:Request,context:Context){
  if (context.deploy.context !== 'production') return;
  if (!isBusinessOpen()) return;

  const apiKey = String(tenantEnv(resolveTenant(),'RESEND_API_KEY') || '').trim();
  if (!apiKey) return;

  const store = tenantStoreFor(context, resolveTenant(), 'sales');
  const records: any[] = (await store.get('records/index', { type: 'json' })) || [];
  const events: any[] = (await store.get('analytics/events/index', { type: 'json' })) || [];
  const reminderThreshold = reminderBusinessHours();
  const followUpThreshold = clientFollowUpHours();
  const now = new Date().toISOString();

  const candidates = records
    .filter((record) =>
      record &&
      ['inquiry', 'lead'].includes(record.stage) &&
      ['inquiry', 'lead'].includes(record.kind) &&
      record.customer?.email &&
      !hasResponse(record, records, events)
    )
    .sort((a, b) => Date.parse(waitingSince(a, records)) - Date.parse(waitingSince(b, records)))
    .slice(0, 40);

  if (!candidates.length) return;

  const appended: any[] = [];

  for (const record of candidates) {
    const since = waitingSince(record, records);
    const wallHours = Math.max(0, (Date.now() - Date.parse(since)) / 3_600_000);
    const businessHours = businessHoursBetween(since);

    if (
      businessHours >= reminderThreshold &&
      !hasEvent(record, records, events, 'lead_response_reminder_sent') &&
      !recentFailure(record, records, events, 'lead_response_reminder_failed')
    ) {
      const result = await sendResponseReminder(record, businessHours);
      const status = result.sent ? 'sent' : 'failed';

      record.communications = {
        ...(record.communications || {}),
        responseReminder: {
          messageId: String(result.id || ''),
          status,
          sentAt: result.sent ? now : '',
          updatedAt: now,
        },
      };

      appended.push({
        id: 'EVT-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(),
        type: result.sent ? 'lead_response_reminder_sent' : 'lead_response_reminder_failed',
        packageId: record.packageId || record.inquiry?.venuePackage || record.inquiry?.mobileBarPackage || '',
        quoteId: record.quoteId || '',
        recordId: record.id,
        createdAt: now,
        detail: result.sent
          ? 'Internal response reminder sent after about ' + Math.max(1, Math.floor(businessHours)) + ' business hours without a logged response.'
          : 'Internal response reminder could not be sent.',
        reference: String(result.id || ''),
      });
    }

    if (
      wallHours >= followUpThreshold &&
      !hasEvent(record, records, events, 'client_follow_up_sent') &&
      !recentFailure(record, records, events, 'client_follow_up_failed')
    ) {
      const result = await sendClientFollowUp(record);
      const status = result.sent ? 'sent' : 'failed';

      record.communications = {
        ...(record.communications || {}),
        clientFollowUp: {
          messageId: String(result.id || ''),
          status,
          sentAt: result.sent ? now : '',
          updatedAt: now,
        },
      };

      appended.push({
        id: 'EVT-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(),
        type: result.sent ? 'client_follow_up_sent' : 'client_follow_up_failed',
        packageId: record.packageId || record.inquiry?.venuePackage || record.inquiry?.mobileBarPackage || '',
        quoteId: record.quoteId || '',
        recordId: record.id,
        createdAt: now,
        detail: result.sent
          ? 'Personal-style 24-hour follow-up sent to client because no staff response was logged.'
          : '24-hour client follow-up could not be sent.',
        reference: String(result.id || ''),
      });
    }

    await store.setJSON('records/' + record.id, record);
  }

  await store.setJSON('records/index', records.slice(0, 1500));
  if (appended.length) {
    const latestEvents: any[] = (await store.get('analytics/events/index', { type: 'json' })) || [];
    await store.setJSON('analytics/events/index', [...appended, ...latestEvents].slice(0, 10000));
  }
}
export default async (req:Request, context:Context) => {
  if (context.deploy.context !== 'production') return;
  return runForEachTenant(context, () => runTenantJob(req, context));
};

export const config: Config = {
  schedule: '@hourly',
};
