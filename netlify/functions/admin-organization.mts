import type { Context, Config } from '@netlify/functions';
import { hasCapability, requireCapability } from './_shared/admin';
import {
  createOrganization,
  listMemberships,
  readOrganization,
  readTenantMigrationAuditReport,
  saveOrganization,
  saveTenantMigrationAuditReport,
  type OrganizationDomain,
  type OrganizationTemplate,
  type OrganizationVenue,
} from './_shared/organization';
import { resolveTenant } from './_shared/tenant';
import { tenantMigrationAudit } from './_shared/tenant-storage';
import { tenantEnv } from './_shared/tenant-env';
import { resolveTxt } from 'node:dns/promises';

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

function domainVerificationToken(host: string) {
  return 'vl_' + crypto.randomUUID().replaceAll('-', '') + '_' + host.replace(/[^a-z0-9]/g,'').slice(0,24);
}

async function verifyDomainOwnership(host: string, token: string) {
  const record = '_venueloom.' + host;
  try {
    const rows = await resolveTxt(record);
    const values = rows.map((parts) => parts.join('')).map((value) => value.trim());
    const expected = 'venueloom-verification=' + token;
    return {
      ok: values.includes(expected),
      record,
      expected,
      values: values.slice(0, 20),
      error: values.includes(expected) ? '' : 'Verification TXT record was not found.',
    };
  } catch (error) {
    return {
      ok: false,
      record,
      expected: 'venueloom-verification=' + token,
      values: [] as string[],
      error: error instanceof Error ? error.message : 'DNS lookup failed.',
    };
  }
}

function stripePriceId(plan: string, interval: 'monthly'|'annual') {
  const raw = clean(Netlify.env.get('VENUELOOM_STRIPE_PRICE_MAP'), 20000);
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    const nested = parsed?.[plan]?.[interval];
    if (nested) return clean(nested, 200);
    return clean(parsed?.[plan + ':' + interval] || parsed?.[plan + '_' + interval] || '', 200);
  } catch {
    return '';
  }
}

async function stripePost(path: string, body: URLSearchParams) {
  const key = clean(Netlify.env.get('VENUELOOM_STRIPE_RESTRICTED_KEY'), 4000);
  if (!key) throw new Error('VenueLoom Stripe restricted key is not configured.');
  const response = await fetch('https://api.stripe.com/v1/' + path.replace(/^\/+/, ''), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data:any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(clean(data?.error?.message || 'Stripe request failed.', 500));
  return data;
}

function validateCatalogRows(value: unknown) {
  const rows = Array.isArray(value) ? value.slice(0, 2000) : [];
  const errors:any[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  rows.forEach((row:any,index:number) => {
    const id = clean(row?.id, 100).toLowerCase();
    const name = clean(row?.name, 180);
    const price = Number(row?.unitPrice ?? row?.price ?? 0);
    if (!id) errors.push({ row:index + 1, field:'id', error:'Catalog item ID is required.' });
    if (!name) errors.push({ row:index + 1, field:'name', error:'Catalog item name is required.' });
    if (!Number.isFinite(price) || price < 0) errors.push({ row:index + 1, field:'unitPrice', error:'Unit price must be zero or greater.' });
    if (id && ids.has(id)) errors.push({ row:index + 1, field:'id', error:'Duplicate catalog item ID.' });
    if (name && names.has(name.toLowerCase())) errors.push({ row:index + 1, field:'name', error:'Duplicate catalog item name.' });
    if (id) ids.add(id);
    if (name) names.add(name.toLowerCase());
  });
  return { rows:rows.length, valid:rows.length > 0 && errors.length === 0, errors:errors.slice(0,200) };
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

function integrationReadiness(tenant:any) {
  const has = (...keys: string[]) => keys.every((key) => Boolean(clean(tenantEnv(tenant,key), 3000)));
  const any = (...keys:string[]) => keys.some((key)=>Boolean(clean(tenantEnv(tenant,key),3000)));
  return {
    quickbooks: {
      configured:
        has('QUICKBOOKS_PRODUCTION_CLIENT_ID','QUICKBOOKS_PRODUCTION_CLIENT_SECRET')
        || has('QUICKBOOKS_CLIENT_ID','QUICKBOOKS_CLIENT_SECRET')
        || has('INTUIT_CLIENT_ID','INTUIT_CLIENT_SECRET'),
      webhookConfigured: any(
        'QUICKBOOKS_PRODUCTION_WEBHOOK_VERIFIER_TOKEN',
        'QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN',
        'INTUIT_WEBHOOK_VERIFIER_TOKEN'
      ),
      credentialScope: tenant.storage.legacyDataBelongsToTenant ? 'tenant-or-legacy' : 'tenant-only',
      settingsUrl: '/admin/quickbooks/',
    },
    signwell: {
      configured: has('SIGNWELL_API_KEY','SIGNWELL_WEBHOOK_ID'),
      webhookConfigured: any('SIGNWELL_WEBHOOK_ID'),
      credentialScope: tenant.storage.legacyDataBelongsToTenant ? 'tenant-or-legacy' : 'tenant-only',
      settingsUrl: '/admin/crm/',
    },
    resend: {
      configured: any('RESEND_API_KEY'),
      monitoringConfigured: any('RESEND_MONITORING_API_KEY'),
      webhookConfigured: any('RESEND_WEBHOOK_SECRET'),
      credentialScope: tenant.storage.legacyDataBelongsToTenant ? 'tenant-or-legacy' : 'tenant-only',
      settingsUrl: '/admin/email/',
    },
    microsoft: {
      configured: Boolean(
        any('MICROSOFT_GRAPH_TENANT_ID')
        && any('MICROSOFT_GRAPH_CLIENT_ID','MICROSOFT_CLIENT_ID')
        && any('MICROSOFT_GRAPH_CLIENT_SECRET','MICROSOFT_CLIENT_SECRET')
      ),
      credentialScope: tenant.storage.legacyDataBelongsToTenant ? 'tenant-or-legacy' : 'tenant-only',
      settingsUrl: '/admin/calendar/',
    },
    stripe: {
      configured: Boolean(clean(Netlify.env.get('VENUELOOM_STRIPE_RESTRICTED_KEY'), 3000)),
      webhookConfigured: Boolean(clean(Netlify.env.get('VENUELOOM_STRIPE_WEBHOOK_SECRET'), 3000)),
      priceMapConfigured: Boolean(clean(Netlify.env.get('VENUELOOM_STRIPE_PRICE_MAP'), 10000)),
      credentialScope: 'platform',
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

function readiness(organization: any, memberships: any[], integrations: ReturnType<typeof integrationReadiness>, tenant: any) {
  const verifiedDomain = (organization.domains || []).some((row: any) => row.status === 'verified');
  const configuredIntegration = Object.values(integrations).some((row: any) => row.configured)
    || Boolean(organization.sandbox?.enabled && (organization.integrations || []).some((row:any)=>
      row.status === 'configured' && String(row.credentialRef || '').startsWith('sandbox:')
    ));
  const checks: Record<string, boolean> = {
    organization: Boolean(organization.displayName && organization.legalName),
    locale: Boolean(organization.locale && organization.currency && organization.timezone),
    venues: (organization.venues || []).some((row: any) => row.active),
    branding: Boolean(organization.branding?.logoPath || organization.branding?.tagline),
    'tax-profile': Boolean(organization.taxProfile?.label),
    catalog: Boolean((tenant?.catalog?.bootstrapItems || []).length || (organization.onboarding?.completedSteps || []).includes('catalog')),
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
  const integrations = integrationReadiness(tenant);

  if (req.method === 'GET') {
    const migrationAudit = await readTenantMigrationAuditReport(context, tenant.id);
    return Response.json({
      organization,
      memberships,
      integrations,
      migrationAudit,
      onboarding: readiness(organization, memberships, integrations, tenant),
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

  if (action === 'create-organization') {
    if (auth.membership?.role !== 'admin') {
      return Response.json({ error:'Only an organization administrator can create a new VenueLoom organization.' }, { status:403 });
    }
    try {
      const created = await createOrganization(context, {
        slug: clean(body.slug,100),
        displayName: clean(body.displayName,180),
        legalName: clean(body.legalName,220),
        email: clean(body.email,240),
        locale: clean(body.locale,60),
        currency: clean(body.currency,8),
        timezone: clean(body.timezone,100),
        country: clean(body.country,100),
      }, { id:auth.user?.id, email:auth.user?.email });
      return Response.json({
        ok:true,
        created,
        tenantSelector: created.organization.id,
        onboardingUrl: '/admin/organization/',
      }, { status:201, headers:{ 'Cache-Control':'private, no-store' } });
    } catch (error) {
      return Response.json({ error:error instanceof Error ? error.message : 'Unable to create organization.' }, { status:400 });
    }
  }

  if (action === 'run-migration-audit') {
    const rawAudit = await tenantMigrationAudit(context, tenant, undefined, { deep:true });
    const migrationAudit = await saveTenantMigrationAuditReport(context, tenant.id, rawAudit);
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
        verificationToken: previous?.verificationToken || domainVerificationToken(host),
        verifiedAt: previous?.verifiedAt || '',
        lastCheckedAt: previous?.lastCheckedAt || '',
        verificationError: previous?.verificationError || '',
      };
    }).filter((row) => row.hostname);
    if (next.filter((row) => row.primary).length > 1) {
      return Response.json({ error: 'Choose only one primary domain.' }, { status: 400 });
    }
    updated = await saveOrganization(context, tenant, (current) => ({ ...current, domains: next }));
  } else if (action === 'verify-domain') {
    const host = hostname(body.hostname);
    const current = (organization.domains || []).find((row:any) => row.hostname === host);
    if (!current) return Response.json({ error:'Save the domain before verifying it.' }, { status:404 });
    const token = current.verificationToken || domainVerificationToken(host);
    const result = await verifyDomainOwnership(host, token);
    const checkedAt = new Date().toISOString();
    updated = await saveOrganization(context, tenant, (currentOrg) => ({
      ...currentOrg,
      domains: (currentOrg.domains || []).map((row:any) => row.hostname === host ? {
        ...row,
        verificationToken: token,
        status: result.ok ? 'verified' : 'failed',
        verifiedAt: result.ok ? (row.verifiedAt || checkedAt) : '',
        lastCheckedAt: checkedAt,
        verificationError: result.ok ? '' : result.error,
      } : row),
    }));
    return Response.json({ ok:result.ok, verification:result, organization:updated }, {
      status:200,
      headers:{ 'Cache-Control':'private, no-store' },
    });
  } else if (action === 'save-integration') {
    const provider = clean(body.provider,40) as any;
    const allowed = new Set(['quickbooks','signwell','resend','microsoft','stripe']);
    if (!allowed.has(provider)) return Response.json({ error:'Unsupported integration provider.' }, { status:400 });
    updated = await saveOrganization(context, tenant, (currentOrg) => ({
      ...currentOrg,
      integrations: (currentOrg.integrations || []).map((row:any) => row.provider === provider ? {
        ...row,
        enabled: body.enabled !== false,
        status: ['not_configured','configured','connected','attention'].includes(clean(body.status,40))
          ? clean(body.status,40) as any
          : row.status,
        remoteAccountId: clean(body.remoteAccountId,180),
        remoteAccountName: clean(body.remoteAccountName,240),
        credentialRef: clean(body.credentialRef,240),
        connectedAt: clean(body.connectedAt,80) || row.connectedAt,
        lastVerifiedAt: clean(body.lastVerifiedAt,80) || row.lastVerifiedAt,
      } : row),
    }));
  } else if (action === 'validate-catalog-import') {
    const validation = validateCatalogRows(body.items);
    if (validation.valid) {
      updated = await saveOrganization(context, tenant, (currentOrg) => ({
        ...currentOrg,
        onboarding: {
          ...currentOrg.onboarding,
          completedSteps: [...new Set([...(currentOrg.onboarding?.completedSteps || []), 'catalog'])],
        },
      }));
    }
    return Response.json({ ok:validation.valid, validation, organization:updated }, {
      status:validation.valid ? 200 : 422,
      headers:{ 'Cache-Control':'private, no-store' },
    });
  } else if (action === 'create-subscription-checkout') {
    if (!hasCapability(auth.user, 'billing.manage')) {
      return Response.json({ error:'Billing management permission required.' }, { status:403 });
    }
    const plan = clean(body.plan || organization.subscription?.plan,100);
    const interval = body.interval === 'annual' ? 'annual' : 'monthly';
    const priceId = stripePriceId(plan, interval);
    if (!plan || !priceId) return Response.json({ error:'No Stripe price is configured for this plan and interval.' }, { status:409 });

    let customerId = clean(organization.subscription?.stripeCustomerId,180);
    if (!customerId) {
      const customer = await stripePost('customers', new URLSearchParams({
        email: clean(body.billingEmail || organization.subscription?.billingEmail || organization.contact.email,240),
        name: organization.displayName,
        'metadata[tenant_id]': tenant.id,
        'metadata[tenant_slug]': organization.slug,
      }));
      customerId = clean(customer.id,180);
      updated = await saveOrganization(context, tenant, (currentOrg) => ({
        ...currentOrg,
        subscription: { ...currentOrg.subscription, stripeCustomerId:customerId, plan, interval },
      }));
    }

    const origin = new URL(req.url).origin;
    const session = await stripePost('checkout/sessions', new URLSearchParams({
      mode:'subscription',
      customer:customerId,
      'line_items[0][price]':priceId,
      'line_items[0][quantity]':String(Math.max(1,Math.round(num(body.seats || organization.subscription?.seats || 1,1,10000)))),
      success_url: origin + '/admin/organization/?subscription=success#subscription',
      cancel_url: origin + '/admin/organization/?subscription=canceled#subscription',
      'subscription_data[metadata][tenant_id]':tenant.id,
      'metadata[tenant_id]':tenant.id,
    }));
    return Response.json({ ok:true, checkoutUrl:clean(session.url,2000), sessionId:clean(session.id,180), customerId }, {
      headers:{ 'Cache-Control':'private, no-store' },
    });
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
    const currentReadiness = readiness(organization, memberships, integrations, tenant);
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
  const nextIntegrations = integrationReadiness(tenant);
  return Response.json({
    ok: true,
    organization: updated,
    memberships: nextMemberships,
    integrations: nextIntegrations,
    onboarding: readiness(updated, nextMemberships, nextIntegrations, tenant),
  }, { headers: { 'Cache-Control': 'private, no-store' } });
};

export const config: Config = { path: '/api/admin/organization' };
