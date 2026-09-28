import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import type { TenantProfile } from '../../../src/data/tenants';

export type OrganizationStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'canceled';
export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'removed';

export type OrganizationVenue = {
  id: string;
  name: string;
  address: string;
  timezone: string;
  capacity: number | null;
  active: boolean;
};

export type OrganizationDomain = {
  id: string;
  hostname: string;
  kind: 'app' | 'portal' | 'marketing' | 'custom';
  status: 'pending' | 'verified' | 'failed';
  primary: boolean;
};

export type OrganizationTemplate = {
  id: string;
  type: 'proposal' | 'contract' | 'email' | 'welcome' | 'cancellation' | 'vendor' | 'other';
  name: string;
  enabled: boolean;
  source: 'platform' | 'tenant';
  updatedAt: string;
};

export type OrganizationSubscription = {
  provider: 'stripe';
  status: 'not_configured' | 'trialing' | 'active' | 'past_due' | 'canceled';
  plan: string;
  interval: 'monthly' | 'annual';
  seats: number;
  billingEmail: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  currentPeriodEnd: string;
  trialEndsAt: string;
};

export type OrganizationRecord = {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  status: OrganizationStatus;
  locale: string;
  currency: string;
  timezone: string;
  country: string;
  contact: {
    email: string;
    phone: string;
    venueAddress: string;
    mailingAddress: string;
  };
  branding: {
    tagline: string;
    logoPath: string;
    primaryColor: string;
    accentColor: string;
    backgroundColor: string;
  };
  taxProfile: {
    id: string;
    label: string;
    kind: string;
    enabled: boolean;
    statutoryRate: number;
    customerRate: number;
    maxPassOnRate: number;
    defaultTaxable: boolean;
  };
  venues: OrganizationVenue[];
  domains: OrganizationDomain[];
  featureFlags: Record<string, boolean>;
  templates: OrganizationTemplate[];
  subscription: OrganizationSubscription;
  onboarding: {
    completedSteps: string[];
    activatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type MembershipRecord = {
  id: string;
  tenantId: string;
  userId: string;
  email: string;
  role: string;
  capabilities: string[];
  status: MembershipStatus;
  invitedAt: string;
  acceptedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type TenantContext = {
  tenantId: string;
  organization: OrganizationRecord;
  membership: MembershipRecord;
  profile: TenantProfile;
};

const CONTROL_STORE = 'venueloom-control';

function controlStore(context?: Context) {
  if (!context) return getStore({ name: CONTROL_STORE, consistency: 'strong' });
  return context.deploy.context === 'production'
    ? getStore({ name: CONTROL_STORE, consistency: 'strong' })
    : getDeployStore({ name: CONTROL_STORE });
}

function clean(value: unknown, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizedHost(value: unknown) {
  return clean(value, 240).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0];
}

function membershipId(tenantId: string, userId: string) {
  return 'm_' + tenantId.replace(/[^a-z0-9_-]/gi, '_') + '_' + userId.replace(/[^a-z0-9_-]/gi, '_');
}

function defaultSubscription(profile: TenantProfile): OrganizationSubscription {
  return {
    provider: 'stripe',
    status: 'not_configured',
    plan: '',
    interval: 'monthly',
    seats: 1,
    billingEmail: profile.contact.email,
    stripeCustomerId: '',
    stripeSubscriptionId: '',
    currentPeriodEnd: '',
    trialEndsAt: '',
  };
}

function organizationFromProfile(profile: TenantProfile): OrganizationRecord {
  const now = new Date().toISOString();
  return {
    id: profile.id,
    slug: profile.slug,
    displayName: profile.displayName,
    legalName: profile.legalName,
    status: 'active',
    locale: profile.locale,
    currency: profile.currency,
    timezone: profile.timezone,
    country: '',
    contact: {
      email: profile.contact.email,
      phone: profile.contact.phone,
      venueAddress: profile.contact.venueAddress,
      mailingAddress: profile.contact.mailingAddress,
    },
    branding: {
      tagline: profile.brand.tagline,
      logoPath: profile.brand.logoPath,
      primaryColor: '',
      accentColor: '',
      backgroundColor: '',
    },
    taxProfile: {
      id: profile.tax.id,
      label: profile.tax.label,
      kind: profile.tax.kind,
      enabled: profile.tax.enabled,
      statutoryRate: profile.tax.statutoryRate,
      customerRate: profile.tax.customerRate,
      maxPassOnRate: profile.tax.maxPassOnRate,
      defaultTaxable: profile.tax.defaultTaxable,
    },
    venues: [{
      id: 'primary',
      name: profile.displayName,
      address: profile.contact.venueAddress,
      timezone: profile.timezone,
      capacity: null,
      active: true,
    }],
    domains: [
      {
        id: 'primary-marketing',
        hostname: normalizedHost(profile.domains.primary),
        kind: 'marketing',
        status: 'verified',
        primary: true,
      },
      ...(normalizedHost(profile.domains.admin) && normalizedHost(profile.domains.admin) !== normalizedHost(profile.domains.primary)
        ? [{
            id: 'primary-admin',
            hostname: normalizedHost(profile.domains.admin),
            kind: 'app' as const,
            status: 'verified' as const,
            primary: false,
          }]
        : []),
    ],
    featureFlags: {},
    templates: [],
    subscription: defaultSubscription(profile),
    onboarding: {
      completedSteps: ['organization', 'locale', 'branding', 'tax-profile'],
      activatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export async function readOrganization(context: Context | undefined, profile: TenantProfile) {
  const store = controlStore(context);
  const key = 'organizations/' + profile.id;
  const existing = await store.get(key, { type: 'json' }) as OrganizationRecord | null;
  if (existing) return existing;
  const seeded = organizationFromProfile(profile);
  await store.setJSON(key, seeded);
  const index = ((await store.get('organizations/index', { type: 'json' })) || []) as Array<{id:string;slug:string;displayName:string;status:string}>;
  if (!index.some((row) => row.id === seeded.id)) {
    await store.setJSON('organizations/index', [
      ...index,
      { id: seeded.id, slug: seeded.slug, displayName: seeded.displayName, status: seeded.status },
    ]);
  }
  return seeded;
}

export async function saveOrganization(
  context: Context | undefined,
  profile: TenantProfile,
  updater: (current: OrganizationRecord) => OrganizationRecord,
) {
  const store = controlStore(context);
  const current = await readOrganization(context, profile);
  const next = updater(structuredClone(current));
  if (next.id !== profile.id) throw new Error('Organization ID cannot be changed.');
  next.updatedAt = new Date().toISOString();
  await store.setJSON('organizations/' + profile.id, next);

  const index = ((await store.get('organizations/index', { type: 'json' })) || []) as Array<{id:string;slug:string;displayName:string;status:string}>;
  const row = { id: next.id, slug: next.slug, displayName: next.displayName, status: next.status };
  await store.setJSON('organizations/index', [row, ...index.filter((entry) => entry.id !== next.id)]);
  return next;
}


export function effectiveTenantProfile(profile: TenantProfile, organization: OrganizationRecord): TenantProfile {
  const primaryDomain = organization.domains.find((domain) => domain.primary && domain.status === 'verified')
    || organization.domains.find((domain) => domain.status === 'verified');
  const appDomain = organization.domains.find((domain) => domain.kind === 'app' && domain.status === 'verified');
  return {
    ...profile,
    displayName: organization.displayName || profile.displayName,
    legalName: organization.legalName || profile.legalName,
    locale: organization.locale || profile.locale,
    currency: organization.currency || profile.currency,
    timezone: organization.timezone || profile.timezone,
    domains: {
      primary: primaryDomain?.hostname || profile.domains.primary,
      admin: appDomain?.hostname || primaryDomain?.hostname || profile.domains.admin,
    },
    contact: {
      ...profile.contact,
      email: organization.contact.email || profile.contact.email,
      phone: organization.contact.phone || profile.contact.phone,
      phoneDisplay: organization.contact.phone || profile.contact.phoneDisplay,
      venueAddress: organization.contact.venueAddress || profile.contact.venueAddress,
      mailingAddress: organization.contact.mailingAddress || profile.contact.mailingAddress,
    },
    brand: {
      ...profile.brand,
      tagline: organization.branding.tagline || profile.brand.tagline,
      logoPath: organization.branding.logoPath || profile.brand.logoPath,
    },
    tax: {
      ...profile.tax,
      id: organization.taxProfile.id || profile.tax.id,
      label: organization.taxProfile.label || profile.tax.label,
      kind: (organization.taxProfile.kind || profile.tax.kind) as TenantProfile['tax']['kind'],
      enabled: organization.taxProfile.enabled,
      statutoryRate: Number(organization.taxProfile.statutoryRate || 0),
      customerRate: Number(organization.taxProfile.customerRate || 0),
      maxPassOnRate: Number(organization.taxProfile.maxPassOnRate || 0),
      defaultTaxable: organization.taxProfile.defaultTaxable,
    },
  };
}

export async function readEffectiveTenant(context: Context | undefined, profile: TenantProfile) {
  const organization = await readOrganization(context, profile);
  return effectiveTenantProfile(profile, organization);
}

export async function readMembership(context: Context | undefined, tenantId: string, userId: string) {
  if (!tenantId || !userId) return null;
  return await controlStore(context).get('memberships/' + tenantId + '/' + userId, { type: 'json' }) as MembershipRecord | null;
}

export async function ensureMembership(
  context: Context | undefined,
  profile: TenantProfile,
  user: any,
  role: string,
  capabilities: string[],
) {
  const userId = clean(user?.id, 160);
  const email = clean(user?.email, 240).toLowerCase();
  if (!userId) throw new Error('Authenticated user ID is required for tenant membership.');

  const store = controlStore(context);
  const key = 'memberships/' + profile.id + '/' + userId;
  const existing = await store.get(key, { type: 'json' }) as MembershipRecord | null;
  const now = new Date().toISOString();

  if (!existing && !profile.storage.legacyDataBelongsToTenant) return null;

  const membership: MembershipRecord = existing
    ? {
        ...existing,
        email,
        role,
        capabilities: [...new Set(capabilities)],
        status: existing.status === 'removed' ? 'removed' : existing.status === 'suspended' ? 'suspended' : 'active',
        acceptedAt: existing.acceptedAt || now,
        updatedAt: now,
      }
    : {
        id: membershipId(profile.id, userId),
        tenantId: profile.id,
        userId,
        email,
        role,
        capabilities: [...new Set(capabilities)],
        status: 'active',
        invitedAt: now,
        acceptedAt: now,
        createdAt: now,
        updatedAt: now,
      };

  await store.setJSON(key, membership);
  const indexKey = 'memberships/' + profile.id + '/index';
  const index = ((await store.get(indexKey, { type: 'json' })) || []) as MembershipRecord[];
  await store.setJSON(indexKey, [membership, ...index.filter((row) => row.userId !== userId)].slice(0, 1000));
  return membership;
}

export async function saveMembership(context: Context | undefined, membership: MembershipRecord) {
  const store = controlStore(context);
  const now = new Date().toISOString();
  const next = { ...membership, updatedAt: now };
  await store.setJSON('memberships/' + next.tenantId + '/' + next.userId, next);
  const indexKey = 'memberships/' + next.tenantId + '/index';
  const index = ((await store.get(indexKey, { type: 'json' })) || []) as MembershipRecord[];
  await store.setJSON(indexKey, [next, ...index.filter((row) => row.userId !== next.userId)].slice(0, 1000));
  return next;
}

export async function listMemberships(context: Context | undefined, tenantId: string) {
  const rows = ((await controlStore(context).get('memberships/' + tenantId + '/index', { type: 'json' })) || []) as MembershipRecord[];
  return rows.filter((row) => row.tenantId === tenantId && row.status !== 'removed');
}

export async function buildTenantContext(
  context: Context | undefined,
  profile: TenantProfile,
  user: any,
  role: string,
  capabilities: string[],
): Promise<TenantContext | null> {
  const organization = await readOrganization(context, profile);
  const effectiveProfile = effectiveTenantProfile(profile, organization);
  const membership = await ensureMembership(context, profile, user, role, capabilities);
  if (!membership || membership.status !== 'active') return null;
  return {
    tenantId: profile.id,
    organization,
    membership,
    profile: effectiveProfile,
  };
}
