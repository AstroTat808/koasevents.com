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
  verificationToken?: string;
  verifiedAt?: string;
  lastCheckedAt?: string;
  verificationError?: string;
};

export type OrganizationTemplate = {
  id: string;
  type: 'proposal' | 'contract' | 'email' | 'welcome' | 'cancellation' | 'vendor' | 'other';
  name: string;
  enabled: boolean;
  source: 'platform' | 'tenant';
  updatedAt: string;
};

export type OrganizationIntegration = {
  provider: 'quickbooks' | 'signwell' | 'resend' | 'microsoft' | 'stripe';
  enabled: boolean;
  status: 'not_configured' | 'configured' | 'connected' | 'attention';
  remoteAccountId: string;
  remoteAccountName: string;
  connectedAt: string;
  lastVerifiedAt: string;
  credentialRef?: string;
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
  integrations: OrganizationIntegration[];
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
    integrations: [
      { provider:'quickbooks', enabled:true, status:'not_configured', remoteAccountId:'', remoteAccountName:'', connectedAt:'', lastVerifiedAt:'' },
      { provider:'signwell', enabled:true, status:'not_configured', remoteAccountId:'', remoteAccountName:'', connectedAt:'', lastVerifiedAt:'' },
      { provider:'resend', enabled:true, status:'not_configured', remoteAccountId:'', remoteAccountName:'', connectedAt:'', lastVerifiedAt:'' },
      { provider:'microsoft', enabled:true, status:'not_configured', remoteAccountId:'', remoteAccountName:'', connectedAt:'', lastVerifiedAt:'' },
      { provider:'stripe', enabled:true, status:'not_configured', remoteAccountId:'', remoteAccountName:'', connectedAt:'', lastVerifiedAt:'' },
    ],
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
        role: profile.storage.legacyDataBelongsToTenant ? role : existing.role,
        capabilities: profile.storage.legacyDataBelongsToTenant ? [...new Set(capabilities)] : existing.capabilities,
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


export async function listOrganizations(context?: Context) {
  const store = controlStore(context);
  const index = ((await store.get('organizations/index', { type: 'json' })) || []) as Array<{id:string;slug:string;displayName:string;status:string}>;
  return index;
}

export async function readOrganizationById(context: Context | undefined, id: string) {
  const key = clean(id, 120);
  if (!key) return null;
  return await controlStore(context).get('organizations/' + key, { type: 'json' }) as OrganizationRecord | null;
}

export async function readOrganizationByHost(context: Context | undefined, host: string) {
  const normalized = normalizedHost(host);
  if (!normalized) return null;
  const index = await listOrganizations(context);
  for (const row of index) {
    const organization = await readOrganizationById(context, row.id);
    if (!organization) continue;
    if ((organization.domains || []).some((domain) =>
      domain.status === 'verified' && normalizedHost(domain.hostname) === normalized
    )) return organization;
  }
  return null;
}

export function profileFromOrganization(organization: OrganizationRecord): TenantProfile {
  const primary = organization.domains.find((domain) => domain.primary && domain.status === 'verified')
    || organization.domains.find((domain) => domain.status === 'verified');
  const app = organization.domains.find((domain) => domain.kind === 'app' && domain.status === 'verified');
  return {
    id: organization.id,
    slug: organization.slug,
    displayName: organization.displayName,
    legalName: organization.legalName,
    locale: organization.locale || 'en-US',
    currency: organization.currency || 'USD',
    timezone: organization.timezone || 'UTC',
    microsoftTimeZone: 'UTC',
    calendar: {
      recordMarkerPrefix: 'VENUELOOM_RECORD_ID:',
      legacyRecordMarkerPrefixes: [],
    },
    domains: {
      primary: primary?.hostname || '',
      admin: app?.hostname || primary?.hostname || '',
    },
    contact: {
      email: organization.contact.email || '',
      phone: organization.contact.phone || '',
      phoneDisplay: organization.contact.phone || '',
      venueAddress: organization.contact.venueAddress || '',
      mailingAddress: organization.contact.mailingAddress || '',
    },
    brand: {
      tagline: organization.branding.tagline || '',
      logoPath: organization.branding.logoPath || '',
    },
    tax: {
      id: organization.taxProfile.id || 'default-tax',
      label: organization.taxProfile.label || 'Tax',
      kind: (organization.taxProfile.kind || 'other') as TenantProfile['tax']['kind'],
      enabled: organization.taxProfile.enabled === true,
      statutoryRate: Number(organization.taxProfile.statutoryRate || 0),
      customerRate: Number(organization.taxProfile.customerRate || 0),
      maxPassOnRate: Number(organization.taxProfile.maxPassOnRate || 0),
      defaultTaxable: organization.taxProfile.defaultTaxable !== false,
      exemptionPolicy: {
        mode: 'manual-review',
        itemLevelRulesConfigured: false,
        reviewMessage: 'Review tenant tax exemptions before synchronization.',
      },
    },
    catalog: { canonicalAliases:{}, quickBooksAliases:{}, bootstrapItems:[], websitePlacements:[] },
    sales: { packageAliases:{}, catalogItemByPackage:{}, weddingPackageIds:[], mobileBarPackageIds:[], privateEventPackageIds:[] },
    accounting: {
      damageDeposit: {
        enabled: false,
        defaultRentalType: 'one-day',
        oneDayAmount: 0,
        weekendAmount: 0,
        dueDaysBefore: 30,
        refundWithinDays: 14,
      },
    },
    bootstrapAdminEmails: [],
    storage: {
      legacyDataBelongsToTenant: false,
      compatibilityBlobStores: {
        sales:'', quotes:'', integrations:'', crm:'', eventOps:'', vendors:'', eventFiles:'', vendorFiles:'',
        emailAnalytics:'', emailRouting:'', authSecurity:'', staffDirectory:'', staffFiles:'', staffAudit:'', staffAvailability:'',
        security:'', systemHealth:'', calendarSync:'', userPreferences:'', blog:'', gallery:'', localSeo:'', workspaceAlerts:'',
      },
    },
    legal: { governingLawLabel:'', disputeVenueLabel:'' },
  };
}

function tenantIdFromSlug(value: unknown) {
  return clean(value, 100).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export async function createOrganization(
  context: Context | undefined,
  input: { slug?:string; displayName?:string; legalName?:string; email?:string; locale?:string; currency?:string; timezone?:string; country?:string },
  creator: { id?:string; email?:string },
) {
  const slug = tenantIdFromSlug(input.slug || input.displayName);
  const displayName = clean(input.displayName, 180);
  const legalName = clean(input.legalName || displayName, 220);
  const email = clean(input.email || creator.email, 240).toLowerCase();
  const userId = clean(creator.id, 160);
  if (!slug || !displayName || !userId || !email) throw new Error('Organization name, slug, creator ID, and email are required.');

  const store = controlStore(context);
  const existing = await readOrganizationById(context, slug);
  if (existing) throw new Error('An organization with this slug already exists.');
  const index = await listOrganizations(context);
  if (index.some((row) => row.slug === slug)) throw new Error('An organization with this slug already exists.');

  const now = new Date().toISOString();
  const organization: OrganizationRecord = {
    id: slug,
    slug,
    displayName,
    legalName,
    status: 'trial',
    locale: clean(input.locale, 60) || 'en-US',
    currency: (clean(input.currency, 8) || 'USD').toUpperCase(),
    timezone: clean(input.timezone, 100) || 'UTC',
    country: clean(input.country, 100),
    contact: { email, phone:'', venueAddress:'', mailingAddress:'' },
    branding: { tagline:'', logoPath:'', primaryColor:'', accentColor:'', backgroundColor:'' },
    taxProfile: { id:'default-tax', label:'Tax', kind:'other', enabled:false, statutoryRate:0, customerRate:0, maxPassOnRate:0, defaultTaxable:true },
    venues: [],
    domains: [],
    featureFlags: {},
    integrations: [
      { provider:'quickbooks', enabled:false, status:'not_configured', remoteAccountId:'', remoteAccountName:'', connectedAt:'', lastVerifiedAt:'' },
      { provider:'signwell', enabled:false, status:'not_configured', remoteAccountId:'', remoteAccountName:'', connectedAt:'', lastVerifiedAt:'' },
      { provider:'resend', enabled:false, status:'not_configured', remoteAccountId:'', remoteAccountName:'', connectedAt:'', lastVerifiedAt:'' },
      { provider:'microsoft', enabled:false, status:'not_configured', remoteAccountId:'', remoteAccountName:'', connectedAt:'', lastVerifiedAt:'' },
      { provider:'stripe', enabled:false, status:'not_configured', remoteAccountId:'', remoteAccountName:'', connectedAt:'', lastVerifiedAt:'' },
    ],
    templates: [],
    subscription: {
      provider:'stripe', status:'not_configured', plan:'', interval:'monthly', seats:1, billingEmail:email,
      stripeCustomerId:'', stripeSubscriptionId:'', currentPeriodEnd:'', trialEndsAt:'',
    },
    onboarding: { completedSteps:['organization','locale'], activatedAt:'' },
    createdAt: now,
    updatedAt: now,
  };

  await store.setJSON('organizations/' + organization.id, organization);
  await store.setJSON('organizations/index', [
    { id:organization.id, slug:organization.slug, displayName:organization.displayName, status:organization.status },
    ...index.filter((row) => row.id !== organization.id),
  ]);

  const membership: MembershipRecord = {
    id: membershipId(organization.id, userId),
    tenantId: organization.id,
    userId,
    email,
    role: 'admin',
    capabilities: [],
    status: 'active',
    invitedAt: now,
    acceptedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await saveMembership(context, membership);
  return { organization, membership, profile: profileFromOrganization(organization) };
}


export type PlatformSupportSession = {
  id: string;
  token: string;
  tenantId: string;
  adminUserId: string;
  adminEmail: string;
  reason: string;
  readOnly: true;
  createdAt: string;
  expiresAt: string;
  endedAt: string;
};

export async function createPlatformSupportSession(
  context: Context | undefined,
  input: { tenantId:string; adminUserId:string; adminEmail:string; reason:string; ttlMinutes?:number },
) {
  const tenantId=clean(input.tenantId,120);
  const adminUserId=clean(input.adminUserId,160);
  const adminEmail=clean(input.adminEmail,240).toLowerCase();
  const reason=clean(input.reason,500);
  if(!tenantId||!adminUserId||!adminEmail||!reason) throw new Error('Tenant, administrator, and support reason are required.');
  const organization=await readOrganizationById(context,tenantId);
  if(!organization) throw new Error('Organization not found.');
  const ttl=Math.max(5,Math.min(30,Number(input.ttlMinutes||15)));
  const now=new Date();
  const token='vls_'+crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
  const session:PlatformSupportSession={
    id:'support_'+crypto.randomUUID().replaceAll('-','').slice(0,24),
    token,
    tenantId,
    adminUserId,
    adminEmail,
    reason,
    readOnly:true,
    createdAt:now.toISOString(),
    expiresAt:new Date(now.getTime()+ttl*60_000).toISOString(),
    endedAt:'',
  };
  const store=controlStore(context);
  await store.setJSON('support-sessions/by-token/'+token,session);
  const history=((await store.get('support-sessions/history',{type:'json'}))||[]) as PlatformSupportSession[];
  await store.setJSON('support-sessions/history',[session,...history].slice(0,1000));
  return session;
}

export async function readPlatformSupportSession(context:Context|undefined,token:string) {
  const key=clean(token,220);
  if(!key)return null;
  return await controlStore(context).get('support-sessions/by-token/'+key,{type:'json'}) as PlatformSupportSession|null;
}

export async function endPlatformSupportSession(context:Context|undefined,token:string,adminUserId:string) {
  const current=await readPlatformSupportSession(context,token);
  if(!current)return null;
  if(current.adminUserId!==clean(adminUserId,160))throw new Error('Support session belongs to another administrator.');
  const ended={...current,endedAt:new Date().toISOString()};
  const store=controlStore(context);
  await store.setJSON('support-sessions/by-token/'+current.token,ended);
  const history=((await store.get('support-sessions/history',{type:'json'}))||[]) as PlatformSupportSession[];
  await store.setJSON('support-sessions/history',[ended,...history.filter((row)=>row.id!==ended.id)].slice(0,1000));
  return ended;
}

export async function listPlatformSupportSessions(context:Context|undefined,limit=100) {
  const rows=((await controlStore(context).get('support-sessions/history',{type:'json'}))||[]) as PlatformSupportSession[];
  return rows.slice(0,Math.max(1,Math.min(500,limit)));
}
