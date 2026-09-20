import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { sendResponseReminder } from './_shared/lead-email.ts';

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

function thresholdHours() {
  const configured = Number(Netlify.env.get('KOA_LEAD_RESPONSE_REMINDER_HOURS') || 24);
  if (!Number.isFinite(configured)) return 24;
  return Math.min(168, Math.max(1, Math.round(configured)));
}

export default async (_req: Request, context: Context) => {
  if (context.deploy.context !== 'production') return;

  const apiKey = String(Netlify.env.get('RESEND_API_KEY') || '').trim();
  if (!apiKey) return;

  const store = getStore({ name: 'koa-sales', consistency: 'strong' });
  const records: any[] = (await store.get('records/index', { type: 'json' })) || [];
  const events: any[] = (await store.get('analytics/events/index', { type: 'json' })) || [];
  const limitHours = thresholdHours();
  const now = new Date().toISOString();

  const candidates = records.filter((record) => {
    if (!record || !['inquiry', 'lead'].includes(record.stage)) return false;
    if (!['inquiry', 'lead'].includes(record.kind)) return false;
    if (!record.customer?.email) return false;
    if (hoursSince(record.createdAt) < limitHours) return false;

    const responseLogged = events.some((event) =>
      String(event?.recordId || '') === record.id &&
      RESPONSE_TYPES.has(String(event?.type || '')) &&
      Date.parse(String(event?.createdAt || '')) >= Date.parse(String(record.createdAt || '')),
    );
    if (responseLogged) return false;

    const reminderSent = events.some((event) =>
      String(event?.recordId || '') === record.id &&
      String(event?.type || '') === 'lead_response_reminder_sent',
    );
    if (reminderSent) return false;

    const recentFailure = events.some((event) =>
      String(event?.recordId || '') === record.id &&
      String(event?.type || '') === 'lead_response_reminder_failed' &&
      hoursSince(event?.createdAt) < 6,
    );
    return !recentFailure;
  }).slice(0, 25);

  if (!candidates.length) return;

  const appended: any[] = [];

  for (const record of candidates) {
    const ageHours = hoursSince(record.createdAt);
    const result = await sendResponseReminder(record, ageHours);
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
    await store.setJSON('records/' + record.id, record);

    appended.push({
      id: 'EVT-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(),
      type: result.sent ? 'lead_response_reminder_sent' : 'lead_response_reminder_failed',
      packageId: record.packageId || record.inquiry?.venuePackage || record.inquiry?.mobileBarPackage || '',
      quoteId: record.quoteId || '',
      recordId: record.id,
      createdAt: now,
      detail: result.sent
        ? 'Internal response reminder sent after about ' + Math.max(1, Math.floor(ageHours)) + ' hours without a logged response.'
        : 'Internal response reminder could not be sent.',
      reference: String(result.id || ''),
    });
  }

  await store.setJSON('records/index', records.slice(0, 1500));
  if (appended.length) {
    const latestEvents: any[] = (await store.get('analytics/events/index', { type: 'json' })) || [];
    await store.setJSON('analytics/events/index', [...appended, ...latestEvents].slice(0, 10000));
  }
};

export const config: Config = {
  schedule: '@hourly',
};
