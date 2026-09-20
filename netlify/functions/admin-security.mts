import type { Config, Context } from '@netlify/functions';
import { requireAdmin } from './_shared/admin.ts';
import {
  applyAutomaticBlocks,
  createBlocklistEntry,
  getBlocklist,
  getSecurityEvents,
  removeBlocklistEntry,
  setSecurityReview,
  type BlockDuration,
  type BlockTarget,
  type SecurityEvent,
  type SecurityVerdict,
} from './_shared/security.ts';

function clean(value: unknown, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function clampDays(value: unknown) {
  const parsed = Math.round(Number(value || 30));
  return [1, 7, 30, 90].includes(parsed) ? parsed : 30;
}

function increment(map: Record<string, number>, key: string) {
  const normalized = clean(key, 160) || 'unknown';
  map[normalized] = (map[normalized] || 0) + 1;
}

function topEntries(map: Record<string, number>, limit = 12) {
  return Object.entries(map)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export default async (req: Request, context: Context) => {
  const auth = await requireAdmin();
  if (auth.response) return auth.response;

  if (req.method === 'POST') {
    const payload: any = await req.json().catch(() => null);
    const action = clean(payload?.action, 40);
    const adminEmail = clean(auth.user?.email, 240).toLowerCase();
    const events = await getSecurityEvents(context);

    if (action === 'review') {
      const incidentId = clean(payload?.incidentId, 100);
      const verdict = clean(payload?.verdict, 40) as SecurityVerdict;
      if (!['not_spam', 'confirmed_spam'].includes(verdict)) {
        return Response.json({ error: 'Invalid review verdict.' }, { status: 400 });
      }

      const incident = events.find((event) => event.id === incidentId);
      if (!incident) return Response.json({ error: 'Security incident not found.' }, { status: 404 });

      const review = await setSecurityReview(context, incidentId, verdict, adminEmail);
      let automaticBlocks = [];
      if (verdict === 'confirmed_spam') {
        const reviewedEvents = events.map((event) => event.id === incidentId ? { ...event, review } : event);
        automaticBlocks = await applyAutomaticBlocks(context, { ...incident, review }, reviewedEvents);
      }
      return Response.json({ ok: true, review, automaticBlocks }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    if (action === 'block') {
      const incidentId = clean(payload?.incidentId, 100);
      const target = clean(payload?.target, 20) as BlockTarget;
      const duration = clean(payload?.duration, 20) as BlockDuration;
      if (!['email', 'domain'].includes(target) || !['24h', '7d', 'permanent'].includes(duration)) {
        return Response.json({ error: 'Invalid blocklist request.' }, { status: 400 });
      }

      const incident = events.find((event) => event.id === incidentId);
      if (!incident) return Response.json({ error: 'Security incident not found.' }, { status: 404 });

      const value = target === 'email' ? incident.emailFingerprint : incident.emailDomain;
      const label = target === 'email' ? incident.emailPreview : incident.emailDomain;
      if (!value) return Response.json({ error: 'This incident does not have an available ' + target + ' target.' }, { status: 400 });

      const block = await createBlocklistEntry(context, {
        target,
        value,
        label,
        duration,
        source: 'manual',
        reason: 'Manually blocked from Security + Spam dashboard.',
        incidentId,
        createdBy: adminEmail,
      });
      return Response.json({ ok: true, block }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    if (action === 'unblock') {
      const removed = await removeBlocklistEntry(context, clean(payload?.blockId, 100));
      return Response.json({ ok: true, removed }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    return Response.json({ error: 'Unknown security action.' }, { status: 400 });
  }

  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const days = clampDays(url.searchParams.get('days'));
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const all = await getSecurityEvents(context);
  const events = all.filter((event) => {
    const time = new Date(event.createdAt).getTime();
    return Number.isFinite(time) && time >= cutoff;
  });

  const totals = {
    all: events.length,
    allowed: 0,
    flagged: 0,
    blocked: 0,
    accepted: 0,
  };

  const categories: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const forms: Record<string, number> = {};
  const sources: Record<string, { count: number; blocked: number; flagged: number }> = {};
  const dailyMap = new Map<string, { date: string; allowed: number; flagged: number; blocked: number; accepted: number }>();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    dailyMap.set(date, { date, allowed: 0, flagged: 0, blocked: 0, accepted: 0 });
  }

  for (const event of events) {
    if (event.disposition === 'allowed') totals.allowed += 1;
    if (event.disposition === 'flagged') totals.flagged += 1;
    if (event.disposition === 'blocked') totals.blocked += 1;
    if (event.disposition !== 'blocked') totals.accepted += 1;

    increment(categories, event.category);
    increment(forms, event.formName || 'unknown-form');
    for (const reason of event.reasonCodes || []) increment(reasons, reason);

    if (event.ipFingerprint) {
      const source = sources[event.ipFingerprint] || { count: 0, blocked: 0, flagged: 0 };
      source.count += 1;
      if (event.disposition === 'blocked') source.blocked += 1;
      if (event.disposition === 'flagged') source.flagged += 1;
      sources[event.ipFingerprint] = source;
    }

    const date = event.createdAt.slice(0, 10);
    const bucket = dailyMap.get(date);
    if (bucket) {
      if (event.disposition === 'allowed') bucket.allowed += 1;
      if (event.disposition === 'flagged') bucket.flagged += 1;
      if (event.disposition === 'blocked') bucket.blocked += 1;
      if (event.disposition !== 'blocked') bucket.accepted += 1;
    }
  }

  const topSources = Object.entries(sources)
    .filter(([, value]) => value.count >= 2 || value.blocked > 0)
    .map(([fingerprint, value]) => ({
      fingerprint: fingerprint.slice(0, 10),
      ...value,
    }))
    .sort((a, b) => b.blocked - a.blocked || b.count - a.count)
    .slice(0, 15);

  const recent = events
    .filter((event) => event.disposition !== 'allowed')
    .slice(0, 100)
    .map((event: SecurityEvent) => ({
      id: event.id,
      createdAt: event.createdAt,
      disposition: event.disposition,
      category: event.category,
      formName: event.formName,
      reasons: event.reasons,
      reasonCodes: event.reasonCodes,
      riskScore: event.riskScore,
      sourceFingerprint: event.ipFingerprint.slice(0, 10),
      emailDomain: event.emailDomain,
      emailFingerprint: event.emailFingerprint,
      emailPreview: event.emailPreview,
      phonePreview: event.phonePreview,
      recordId: event.recordId,
      detail: event.detail,
      review: event.review || null,
    }));

  const blocklist = (await getBlocklist(context, false))
    .map((entry) => ({
      id: entry.id,
      target: entry.target,
      label: entry.label,
      source: entry.source,
      reason: entry.reason,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      permanent: entry.permanent,
      active: entry.permanent || Boolean(entry.expiresAt && new Date(entry.expiresAt).getTime() > now),
      incidentId: entry.incidentId,
      createdBy: entry.createdBy,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 200);

  return Response.json({
    days,
    generatedAt: new Date().toISOString(),
    totals: {
      ...totals,
      blockRate: totals.all ? Math.round((totals.blocked / totals.all) * 1000) / 10 : 0,
      flagRate: totals.accepted ? Math.round((totals.flagged / totals.accepted) * 1000) / 10 : 0,
    },
    daily: Array.from(dailyMap.values()),
    topCategories: topEntries(categories),
    topReasons: topEntries(reasons),
    topForms: topEntries(forms),
    topSources,
    recent,
    blocklist,
  }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
};

export const config: Config = { path: '/api/admin/security' };
