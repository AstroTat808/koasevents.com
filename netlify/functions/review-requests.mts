import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { sendReviewRequest } from './_shared/review-email.ts';
import { shouldRunScheduledJob } from './_shared/credit-saver';

const HST_OFFSET_MS = -10 * 60 * 60 * 1000;

function configuredDays(name: string, fallback: number, min: number, max: number) {
  const value = Number(Netlify.env.get(name) || fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function hstDateString(nowMs = Date.now()) {
  return new Date(nowMs + HST_OFFSET_MS).toISOString().slice(0, 10);
}

function calendarAgeDays(eventDate: unknown, nowMs = Date.now()) {
  const raw = String(eventDate || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const eventMs = Date.parse(raw + 'T00:00:00Z');
  const todayMs = Date.parse(hstDateString(nowMs) + 'T00:00:00Z');
  if (!Number.isFinite(eventMs) || !Number.isFinite(todayMs)) return null;
  return Math.floor((todayMs - eventMs) / 86_400_000);
}

function alreadyHandled(record: any) {
  const status = String(record?.communications?.reviewRequest?.status || '').toLowerCase();
  return ['sent', 'delivered', 'bounced'].includes(status);
}

function recentFailure(record: any) {
  const state = record?.communications?.reviewRequest;
  if (String(state?.status || '').toLowerCase() !== 'failed') return false;
  const time = Date.parse(String(state?.updatedAt || ''));
  return Number.isFinite(time) && Date.now() - time < 24 * 60 * 60 * 1000;
}

function eventId() {
  return 'EVT-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
}

export default async (_req: Request, context: Context) => {
  if (context.deploy.context !== 'production') return;
  if (!(await shouldRunScheduledJob(context,'review-requests'))) return;

  const apiKey = String(Netlify.env.get('RESEND_API_KEY') || '').trim();
  if (!apiKey) return;

  const delayDays = configuredDays('KOA_REVIEW_REQUEST_DELAY_DAYS', 1, 1, 14);
  const lookbackDays = configuredDays('KOA_REVIEW_REQUEST_LOOKBACK_DAYS', 14, delayDays, 60);

  const store = getStore({ name: 'koa-sales', consistency: 'strong' });
  const records: any[] = (await store.get('records/index', { type: 'json' })) || [];
  const now = new Date().toISOString();
  const appended: any[] = [];

  const candidates = records
    .filter((record) => {
      if (!record || record.stage !== 'booked' || record.kind !== 'proposal') return false;
      if (!String(record.customer?.email || '').includes('@')) return false;
      if (alreadyHandled(record) || recentFailure(record)) return false;
      const age = calendarAgeDays(record.customer?.eventDate);
      return age !== null && age >= delayDays && age <= lookbackDays;
    })
    .sort((a, b) => String(a.customer?.eventDate || '').localeCompare(String(b.customer?.eventDate || '')))
    .slice(0, 25);

  if (!candidates.length) return;

  for (const record of candidates) {
    const result = await sendReviewRequest(record);
    const status = result.sent ? 'sent' : 'failed';

    record.communications = {
      ...(record.communications || {}),
      reviewRequest: {
        messageId: String(result.id || ''),
        status,
        sentAt: result.sent ? now : String(record.communications?.reviewRequest?.sentAt || ''),
        updatedAt: now,
      },
    };

    appended.push({
      id: eventId(),
      type: result.sent ? 'review_request_sent' : 'review_request_failed',
      packageId: record.packageId || record.inquiry?.venuePackage || record.inquiry?.mobileBarPackage || '',
      quoteId: record.quoteId || '',
      recordId: record.id,
      createdAt: now,
      detail: result.sent
        ? 'One-time Google review request sent after the event.'
        : 'Google review request could not be sent.',
      reference: String(result.id || ''),
    });

    await store.setJSON('records/' + record.id, record);
  }

  await store.setJSON('records/index', records.slice(0, 1500));

  if (appended.length) {
    const currentEvents: any[] = (await store.get('analytics/events/index', { type: 'json' })) || [];
    await store.setJSON('analytics/events/index', [...appended, ...currentEvents].slice(0, 10000));
  }
};

export const config: Config = {
  schedule: '0 20 * * *',
};
