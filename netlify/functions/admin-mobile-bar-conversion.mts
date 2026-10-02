import type { Config, Context } from '@netlify/functions';
import { requireCapability } from './_shared/admin';
import { tenantStoreFor } from './_shared/tenant-storage';
import { resolveTenant } from './_shared/tenant';

const PACKAGE_IDS = ['mobile-oahu','mobile-maui','mobile-big-island','mobile-custom'];
const PACKAGE_LABELS: Record<string,string> = {
  'mobile-oahu':'Oahu',
  'mobile-maui':'Maui',
  'mobile-big-island':'Big Island',
  'mobile-custom':'Custom / bartender-only',
};
const STAGE_LABELS: Record<string,string> = {
  'package_selected':'Package selected',
  'estimate_configured':'Estimate configured',
  'event_details_started':'Event details started',
  'security_complete':'Security completed',
  'submit_attempt':'Submit attempted',
  'browse':'Browsing',
};

function clean(value: unknown, max = 180) {
  return String(value ?? '').trim().slice(0, max);
}
function eventTime(row: any) {
  const value = Date.parse(clean(row?.serverAt || row?.clientAt, 80));
  return Number.isFinite(value) ? value : 0;
}
function pct(n: number, d: number) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}
function uniqueSessions(rows: any[]) {
  return new Set(rows.map((row) => clean(row?.sessionId, 100)).filter(Boolean));
}
function isMobileRecord(record: any) {
  const source = clean(record?.source, 100).toLowerCase();
  const line = clean(record?.businessLine, 100).toLowerCase();
  const service = clean(record?.inquiry?.service, 100).toLowerCase();
  const packageId = clean(record?.packageId || record?.inquiry?.mobileBarPackage, 100).toLowerCase();
  return source === 'koa-mobile-bar-inquiry' || line === 'mobile-bar' || service === 'mobile-bar' || packageId.startsWith('mobile-');
}

export default async (req: Request, context: Context) => {
  const auth = await requireCapability('crm.view', req, context);
  if (auth.response) return auth.response;
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const requestedDays = Number(url.searchParams.get('days') || 30);
  const days = [7,30,90].includes(requestedDays) ? requestedDays : 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const tenant = auth.tenant || resolveTenant(req);
  const store = tenantStoreFor(context, tenant, 'sales');
  const [eventsRaw, recordsRaw] = await Promise.all([
    store.get('analytics/mobile-bar/events/index', { type: 'json' }),
    store.get('records/index', { type: 'json' }),
  ]);

  const events = (Array.isArray(eventsRaw) ? eventsRaw : [])
    .filter((row: any) => eventTime(row) >= cutoff)
    .sort((a: any, b: any) => eventTime(a) - eventTime(b));
  const records = (Array.isArray(recordsRaw) ? recordsRaw : [])
    .filter((row: any) => isMobileRecord(row) && Date.parse(clean(row?.createdAt, 80)) >= cutoff);

  const sessions = uniqueSessions(events);
  const cardEvents = events.filter((row: any) => row.type === 'package_card_click');
  const comparisonEvents = events.filter((row: any) => row.type === 'comparison_package_click');
  const selectionEvents = events.filter((row: any) => ['package_card_click','comparison_package_click','quote_package_select'].includes(row.type));
  const estimateEvents = events.filter((row: any) => row.type === 'estimate_configured');
  const detailEvents = events.filter((row: any) => row.type === 'event_details_started');
  const securityEvents = events.filter((row: any) => row.type === 'security_complete');
  const attemptEvents = events.filter((row: any) => row.type === 'submit_attempt');
  const successEvents = events.filter((row: any) => row.type === 'quote_submit_success');

  const successSessions = uniqueSessions(successEvents);
  const abandonmentBySession = new Map<string, any>();
  for (const row of events.filter((entry: any) => entry.type === 'quote_abandon')) {
    const sessionId = clean(row?.sessionId, 100);
    if (!sessionId || successSessions.has(sessionId)) continue;
    abandonmentBySession.set(sessionId, row);
  }

  const abandonmentMap = new Map<string, number>();
  for (const row of abandonmentBySession.values()) {
    const stage = clean(row?.stage, 64) || 'browse';
    abandonmentMap.set(stage, (abandonmentMap.get(stage) || 0) + 1);
  }
  const abandonment = [...abandonmentMap.entries()]
    .map(([stage,count]) => ({ stage, label: STAGE_LABELS[stage] || stage.replaceAll('_',' '), count }))
    .sort((a,b) => b.count - a.count);

  const packageIds = [...PACKAGE_IDS];
  for (const record of records) {
    const id = clean(record?.packageId || record?.inquiry?.mobileBarPackage, 100);
    if (id && !packageIds.includes(id)) packageIds.push(id);
  }

  const packages = packageIds.map((id) => {
    const selections = selectionEvents.filter((row: any) => row.packageId === id);
    const selectedSessions = uniqueSessions(selections);
    const trackedSuccesses = uniqueSessions(successEvents.filter((row: any) => row.packageId === id));
    const completedInquiries = records.filter((record: any) => clean(record?.packageId || record?.inquiry?.mobileBarPackage,100) === id).length;
    return {
      id,
      label: PACKAGE_LABELS[id] || id,
      cardClicks: cardEvents.filter((row: any) => row.packageId === id).length,
      comparisonClicks: comparisonEvents.filter((row: any) => row.packageId === id).length,
      selectionSessions: selectedSessions.size,
      trackedSuccesses: trackedSuccesses.size,
      completedInquiries,
      trackedConversionRate: pct(trackedSuccesses.size, selectedSessions.size),
    };
  });

  const quoteStarts = uniqueSessions(selectionEvents).size;
  const abandoned = abandonmentBySession.size;
  const funnel = [
    { key:'package_selected', label:'Package selected', count:quoteStarts },
    { key:'estimate_configured', label:'Estimate configured', count:uniqueSessions(estimateEvents).size },
    { key:'event_details_started', label:'Event details started', count:uniqueSessions(detailEvents).size },
    { key:'security_complete', label:'Security completed', count:uniqueSessions(securityEvents).size },
    { key:'submit_attempt', label:'Submit attempted', count:uniqueSessions(attemptEvents).size },
    { key:'submitted', label:'Tracked submission', count:successSessions.size },
  ];

  return Response.json({
    generatedAt: new Date().toISOString(),
    days,
    metrics: {
      trackedSessions: sessions.size,
      packageCardClicks: cardEvents.length,
      comparisonClicks: comparisonEvents.length,
      quoteStarts,
      trackedSubmissions: successSessions.size,
      completedInquiries: records.length,
      abandonedSessions: abandoned,
      abandonmentRate: pct(abandoned, quoteStarts),
    },
    funnel,
    packages,
    abandonment,
  }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
};

export const config: Config = {
  path: '/api/admin-mobile-bar-conversion',
};
