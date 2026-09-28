import type { Context, Config } from '@netlify/functions';
import { hasCapability, requireCapability } from './_shared/admin';
import {
  listMemberships,
  readOrganization,
  saveOrganization,
  type OrganizationDomain,
  type OrganizationTemplate,
  type OrganizationVenue,
} from './_shared/organization';
import { resolveTenant } from './_shared/tenant';
import { tenantMigrationAudit } from './_shared/tenant-storage';

function clean(value: unknown, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function bool(value: unknown) {
  return value === true || String(value ?? '').toLowerCase() === 'true';
}

function num(value: unknown, min = 0, max = 1000000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function hostname(value: unknown) {
  return clean(value, 240)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/[^a-z0-9.-]/g, '');
}

function domainId(host: string) {
  return 'domain_' + host.replace(/[^a-z0-9]+/g, '_').slice(0, 80);
}

function featureFlags(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, enabled]) => [clean(key, 80).toLowerCase().replace(/[^a-z0-9._-]/g, ''), enabled === true])
      .filter(([key]) => Boolean(key)),
  );
}

function venues(value: unknown, fallbackTimezone: string): OrganizationVenue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((row: any, index) => ({
    id: clean(row?.id, 100) || 'venue_' + (index + 1),
    name: clean(row?.name, 180),
    address: clean(row?.address, 600),
    timezone: clean(row?.timezone, 100) || fallbackTimezone,
    capacity: row?.capacity == null || row?.capacity === '' ? null : Math.round(num(row.capacity, 0, 100000)),
    active: row?.active !== false,
  })).filter((row) => row.name);
}

function templates(value: unknown): OrganizationTemplate[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(['proposal','contract','email','welcome','cancellation','vendor','other']);
  return value.slice(0, 200).map((row: any, index) => {
    const type = allowed.has(clean(row?.type, 40)) ? clean(row?.type, 40) : 'other';
    return {
      id: clean(row?.id, 100) || 'template_' + (index + 1),
      type: type as OrganizationTemplate['type'],
      name: clean(row?.name, 180),
      enabled: row?.enabled !== false,
      source: row?.source === 'tenant' ? 'tenant' : 'platform',
      updatedAt: new Date().toISOString(),
    };
  }).filter((row) => row.name);
}

function integrationReadiness() {
  const has = (...keys: string[]) => keys.every((key) => Boolean(clean(Netlify.env.get(key), 3000)));
  return {
    quickbooks: {
      configured:
        has('QUICKBOOKS_PRODUCTION_CLIENT_ID','QUICKBOOKS_PRODUCTION_CLIENT_SECRET')
        || has('QUICKBOOKS_CLIENT_ID','QUICKBOOKS_CLIENT_SECRET')
        || has('INTUIT_CLIENT_ID','INTUIT_CLIENT_SECRET'),
      webhookConfigured: Boolean(
        clean(Netlify.env.get('QUICKBOOKS_PRODUCTION_WEBHOOK_VERIFIER_TOKEN'), 3000)
        || clean(Netlify.env.get('QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN'), 3000)
        || clean(Netlify.env.get('INTUIT_WEBHOOK_VERIFIER_TOKEN'), 3000)
      ),
      settingsUrl: '/admin/quickbooks/',
    },
    signwell: {
      configured: has('SIGNWELL_API_KEY','SIGNWELL_WEBHOOK_ID'),
      webhookConfigured: Boolean(clean(Netlify.env.get('SIGNWELL_WEBHOOK_ID'), 1000)),
      settingsUrl: '/admin/crm/',
    },
    resend: {
      configured: Boolean(clean(Netlify.env.get('RESEND_API_KEY'), 3000)),
      monitoringConfigured: Boolean(clean(Netlify.env.get('RESEND_MONITORING_API_KEY'), 3000)),
      settingsUrl: '/admin/email/',
    },
    microsoft: {
      configured: Boolean(
        clean(Netlify.env.get('MICROSOFT_CLIENT_ID'), 3000)
        && clean(Netlify.env.get('MICROSOFT_CLIENT_SECRET'), 3000)
      ),
      settingsUrl: '/admin/calendar/',
    },
    stripe: {
      configured: Boolean(clean(Netlify.env.get('VENUELOOM_STRIPE_RESTRICTED_KEY'), 3000)),
      webhookConfigured: Boolean(clean(Netlify.env.get('VENUELOOM_STRIPE_WEBHOOK_SECRET'), 3000)),
      priceMapConfigured: Boolean(clean(Netlify.env.get('VENUELOOM_STRIPE_PRICE_MAP'), 10000)),
      settingsUrl: '/admin/organization/#subscription',
    },
  };
}

const ONBOARDING_STEPS = [
  'organization',
  'locale',
  'venues',
  'branding',
  'tax-profile',
  'catalog',
  'integrations',
  'team',
  'templates',
  'domains',
  'subscription',
  'test-workflow',
] as const;

function readiness(organization: any, memberships: any[], integrations: ReturnType<typeof integrationReadiness>) {
  const verifiedDomain = (organization.domains || []).some((row: any) => row.status === 'verified');
  const configuredIntegration = Object.values(integrations).some((row: any) => row.configured);
  const checks: Record<string, boolean> = {
    organization: Boolean(organization.displayName && organization.legalName),
    locale: Boolean(organization.locale && organization.currency && organization.timezone),
    venues: (organization.venues || []).some((row: any) => row.active),
    branding: Boolean(organization.branding?.logoPath || organization.branding?.tagline),
    'tax-profile': Boolean(organization.taxProfile?.label),
    catalog: true,
    integrations: configuredIntegration,
    team: memberships.filter((row) => row.status === 'active').length > 0,
    templates: Array.isArray(organization.templates),
    domains: verifiedDomain,
    subscription: Boolean(organization.subscription?.billingEmail),
    'test-workflow': Boolean(organization.onboarding?.activatedAt),
  };
  return ONBOARDING_STEPS.map((id) => ({ id, complete: checks[id] === true }));
}

export default async (req: Request, context: Context) => {
  const auth = await requireCapability('organization.view', req, context);
  if (auth.response) return auth.response;
  const tenant = auth.tenant || resolveTenant(req);
  const organization = auth.organization || await readOrganization(context, tenant);
  const memberships = await listMemberships(context, tenant.id);
  const integrations = integrationReadiness();

  if (req.method === 'GET') {
    return Response.json({
      organization,
      memberships,
      integrations,
      onboarding: readiness(organization, memberships, integrations),
      catalog: {
        settingsUrl: '/admin/catalog/',
        bootstrapItemCount: tenant.catalog.bootstrapItems.length,
      },
      team: {
        settingsUrl: '/admin/staff/',
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!hasCapability(auth.user, 'organization.manage')) {
    return Response.json({ error: 'Organization management permission required.' }, { status: 403 });
  }

  const body: any = await req.json().catch(() => null);
  if (!body) return Response.json({ error: 'Invalid JSON.' }, { status: 400 });
  const action = clean(body.action, 80);

  let updated = organization;

  if (action === 'run-migration-audit') {
    const migrationAudit = await tenantMigrationAudit(context, tenant);
    return Response.json({ ok:true, migrationAudit }, { headers:{ 'Cache-Control':'private, no-store' } });
  }

  if (action === 'save-identity') {
    updated = await saveOrganization(context, tenant, (current) => ({
      ...current,
      displayName: clean(body.displayName, 180) || current.displayName,
      legalName: clean(body.legalName, 220) || current.legalName,
      status: ['trial','active','past_due','suspended','canceled'].includes(clean(body.status, 40))
        ? clean(body.status, 40) as any
        : current.status,
      contact: {
        ...current.contact,
        email: clean(body.email, 240),
        phone: clean(body.phone, 80),
        venueAddress: clean(body.venueAddress, 600),
        mailingAddress: clean(body.mailingAddress, 600),
      },
    }));
  } else if (action === 'save-locale') {
    updated = await saveOrganization(context, tenant, (current) => ({
      ...current,
      locale: clean(body.locale, 60) || current.locale,
      currency: clean(body.currency, 8).toUpperCase() || current.currency,
      timezone: clean(body.timezone, 100) || current.timezone,
      country: clean(body.country, 100),
    }));
  } else if (action === 'save-branding') {
    updated = await saveOrganization(context, tenant, (current) => ({
      ...current,
      branding: {
        tagline: clean(body.tagline, 300),
        logoPath: clean(body.logoPath, 1000),
        primaryColor: clean(body.primaryColor, 40),
        accentColor: clean(body.accentColor, 40),
        backgroundColor: clean(body.backgroundColor, 40),
      },
    }));
  } else if (action === 'save-tax-profile') {
    const customerRate = num(body.customerRate, 0, 100);
    const statutoryRate = num(body.statutoryRate, 0, 100);
    const maxPassOnRate = num(body.maxPassOnRate, 0, 100);
    updated = await saveOrganization(context, tenant, (current) => ({
      ...current,
      taxProfile: {
        id: clean(body.id, 100) || current.taxProfile.id || 'default-tax',
        label: clean(body.label, 120) || 'Tax',
        kind: clean(body.kind, 80) || 'other',
        enabled: body.enabled !== false,
        statutoryRate,
        customerRate,
        maxPassOnRate,
        defaultTaxable: body.defaultTaxable !== false,
      },
    }));
  } else if (action === 'save-venues') {
    updated = await saveOrganization(context, tenant, (current) => ({
      ...current,
      venues: venues(body.venues, current.timezone),
    }));
  } else if (action === 'save-feature-flags') {
    updated = await saveOrganization(context, tenant, (current) => ({
      ...current,
      featureFlags: featureFlags(body.featureFlags),
    }));
  } else if (action === 'save-domains') {
    const existing = Array.isArray(organization.domains) ? organization.domains : [];
    const incoming = Array.isArray(body.domains) ? body.domains : [];
    const next: OrganizationDomain[] = incoming.slice(0, 30).map((row: any) => {
      const host = hostname(row?.hostname);
      const previous = existing.find((entry: OrganizationDomain) => entry.hostname === host);
      return {
        id: previous?.id || domainId(host),
        hostname: host,
        kind: ['app','portal','marketing','custom'].includes(clean(row?.kind, 40))
          ? clean(row?.kind, 40) as OrganizationDomain['kind']
          : 'custom',
        status: previous?.status === 'verified' ? 'verified' : 'pending',
        primary: row?.primary === true,
      };
    }).filter((row) => row.hostname);
    if (next.filter((row) => row.primary).length > 1) {
      return Response.json({ error: 'Choose only one primary domain.' }, { status: 400 });
    }
    updated = await saveOrganization(context, tenant, (current) => ({ ...current, domains: next }));
  } else if (action === 'save-templates') {
    updated = await saveOrganization(context, tenant, (current) => ({
      ...current,
      templates: templates(body.templates),
    }));
  } else if (action === 'save-subscription') {
    if (!hasCapability(auth.user, 'billing.manage')) {
      return Response.json({ error: 'Billing management permission required.' }, { status: 403 });
    }
    updated = await saveOrganization(context, tenant, (current) => ({
      ...current,
      subscription: {
        ...current.subscription,
        plan: clean(body.plan, 100),
        interval: body.interval === 'annual' ? 'annual' : 'monthly',
        seats: Math.max(1, Math.round(num(body.seats, 1, 10000))),
        billingEmail: clean(body.billingEmail, 240),
      },
    }));
  } else if (action === 'complete-onboarding-step') {
    const step = clean(body.step, 80);
    if (!ONBOARDING_STEPS.includes(step as any)) {
      return Response.json({ error: 'Unknown onboarding step.' }, { status: 400 });
    }
    updated = await saveOrganization(context, tenant, (current) => ({
      ...current,
      onboarding: {
        ...current.onboarding,
        completedSteps: [...new Set([...(current.onboarding?.completedSteps || []), step])],
      },
    }));
  } else if (action === 'activate') {
    const currentReadiness = readiness(organization, memberships, integrations);
    const required = currentReadiness.filter((row) => !row.complete && !['subscription','test-workflow'].includes(row.id));
    if (required.length) {
      return Response.json({
        error: 'Complete the required onboarding items before activation.',
        incomplete: required.map((row) => row.id),
      }, { status: 409 });
    }
    updated = await saveOrganization(context, tenant, (current) => ({
      ...current,
      status: 'active',
      onboarding: {
        ...current.onboarding,
        activatedAt: current.onboarding?.activatedAt || new Date().toISOString(),
        completedSteps: [...new Set([...(current.onboarding?.completedSteps || []), 'test-workflow'])],
      },
    }));
  } else {
    return Response.json({ error: 'Unknown organization action.' }, { status: 400 });
  }

  const nextMemberships = await listMemberships(context, tenant.id);
  const nextIntegrations = integrationReadiness();
  return Response.json({
    ok: true,
    organization: updated,
    memberships: nextMemberships,
    integrations: nextIntegrations,
    onboarding: readiness(updated, nextMemberships, nextIntegrations),
  }, { headers: { 'Cache-Control': 'private, no-store' } });
};

export const config: Config = { path: '/api/admin/organization' };
