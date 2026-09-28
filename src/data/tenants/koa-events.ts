import { businessRules } from '../businessRules';
import { catalogItems, type CatalogItem } from '../catalog';
import type { TenantCatalogSeedItem, TenantProfile } from './types';

function money(value: unknown) {
  const n = Number(String(value ?? '').replace(/[$,%\s,]/g, ''));
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100) / 100) : 0;
}

function catalogGroup(item: CatalogItem): TenantCatalogSeedItem['group'] {
  if (item.category === 'packages') return 'packages';
  if (item.category === 'bar') return 'mobile-bar';
  if (['furniture', 'tabletop', 'decor', 'production'].includes(item.category)) return 'rentals';
  return 'add-ons';
}

function catalogCategory(group: TenantCatalogSeedItem['group']): TenantCatalogSeedItem['category'] {
  if (group === 'rentals') return 'rental';
  if (group === 'fees') return 'fee';
  return 'service';
}

function catalogUnit(item: CatalogItem) {
  if (item.estimatedUnitLabel) return String(item.estimatedUnitLabel).trim().slice(0, 40);
  if (item.quantityLabel) return String(item.quantityLabel).trim().replace(/^additional\s+/i, '').toLowerCase().slice(0, 40);
  if (item.category === 'packages') return 'package';
  return 'each';
}

const weddingPriceByCatalogId: Record<string, number> = Object.fromEntries(
  businessRules.venueWeddingPackages.map((pkg) => [
    pkg.name === 'Plumeria' ? 'signature-wedding' : String(pkg.name).toLowerCase(),
    Number(pkg.price || 0),
  ]),
);

const mobilePriceByCatalogId: Record<string, number> = Object.fromEntries(
  businessRules.mobileBar.packages.map((pkg) => [
    String(pkg.name).toLowerCase() === 'big island'
      ? 'big-island-bar'
      : String(pkg.name).toLowerCase() + '-bar',
    Number(pkg.price || 0),
  ]),
);

function catalogPrice(item: CatalogItem) {
  const configured = weddingPriceByCatalogId[item.id] || mobilePriceByCatalogId[item.id];
  if (configured) return money(configured);
  if (Number(item.publishedUnitPrice) > 0) return money(item.publishedUnitPrice);
  if (Number(item.estimatedUnitPrice) > 0) return money(item.estimatedUnitPrice);
  const match = String(item.priceLabel || '').match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  return match ? money(match[1]) : 0;
}

const bootstrapItems: TenantCatalogSeedItem[] = catalogItems.map((item) => {
  const group = catalogGroup(item);
  return {
    id: String(item.id).trim(),
    name: String(item.name).trim(),
    description: String(item.description || '').trim(),
    group,
    category: catalogCategory(group),
    unitLabel: catalogUnit(item),
    unitPrice: catalogPrice(item),
    active: true,
    taxExempt: false,
    sourceRef: String(item.id).trim(),
    quickBooksType: group === 'rentals' ? 'NonInventory' : 'Service',
  };
});

export const koaEventsTenantProfile: TenantProfile = {
  id: 'koa-events',
  slug: 'koa-events',
  displayName: 'Koa’s Events',
  legalName: "Koa's Events LLC",
  locale: 'en-US',
  currency: 'USD',
  timezone: 'Pacific/Honolulu',
  microsoftTimeZone: 'Hawaiian Standard Time',
  domains: {
    primary: 'koasevents.com',
    admin: 'koasevents.com',
  },
  contact: {
    email: businessRules.contact.email,
    phone: businessRules.contact.phone,
    phoneDisplay: businessRules.contact.phoneDisplay,
    venueAddress: businessRules.contact.venueAddress,
    mailingAddress: businessRules.contact.publicMailingAddress,
  },
  brand: {
    tagline: businessRules.brand.tagline,
    logoPath: '/brand/koa-mark.png',
  },
  tax: {
    id: 'hawaii-get',
    label: 'Hawaiʻi GET',
    kind: 'gross-receipts',
    enabled: true,
    statutoryRate: 4.5,
    customerRate: 4.712,
    maxPassOnRate: 4.712,
    defaultTaxable: true,
    exemptionPolicy: {
      mode: 'manual-review',
      itemLevelRulesConfigured: false,
      reviewMessage:
        'Koa’s Events does not currently have item-level Hawaiʻi GET exemption rules encoded in VenueLoom. Any exempt catalog item must be explicitly reviewed and approved before synchronization.',
    },
  },
  catalog: {
    canonicalAliases: {
      gardenia: 'gardenia',
      orchid: 'orchid',
      hibiscus: 'hibiscus',
      plumeria: 'signature-wedding',
      signature: 'signature-wedding',
      'signature-wedding': 'signature-wedding',
      'signature-wedding-experience': 'signature-wedding',
      'mobile-oahu': 'oahu-bar',
      oahu: 'oahu-bar',
      'oahu-mobile-bar-package': 'oahu-bar',
      'mobile-maui': 'maui-bar',
      maui: 'maui-bar',
      'maui-mobile-bar-package': 'maui-bar',
      'mobile-big-island': 'big-island-bar',
      'big-island': 'big-island-bar',
      'big-island-mobile-bar-package': 'big-island-bar',
    },
    quickBooksAliases: {
      gardenia: ['Wedding Packages:Wedding Package-Gardenia'],
      orchid: ['Wedding Packages:Wedding Package-Orchid'],
      hibiscus: ['Wedding Packages:Wedding Package-Hibiscus'],
      'signature-wedding': ['Wedding Packages:Wedding Package-Plumeria'],
      'oahu-bar': ['Bar:Bar Package-Oahu'],
      'maui-bar': ['Bar:Bar Package-Maui'],
      'big-island-bar': ['Bar:Bar Package-Big Island'],
      'bar-additional-hour': ['Bar:Mobile Bar - Additional Hour'],
      'ceremony-chair': ['Tables & Chairs:Chairs-White/Resin'],
      'reception-chair': ['Tables & Chairs:Chairs-White/Resin'],
      'round-table': ['Tables & Chairs:Table-60-inch/Round'],
      'rectangle-table': ['Tables & Chairs:Table-6-Ft/Rectangle'],
      glassware: [
        'Bar:Glassware - Cocktail Glass',
        'Bar:Glassware - Champange Flutes',
        'Bar:Glassware - Wine Glasses',
      ],
    },
    bootstrapItems,
    websitePlacements: [
      { path: '/catalog/', label: 'Rental + enhancement catalog' },
      { path: '/venue/packages/', label: 'Wedding packages', groups: ['packages'] },
      { path: '/weddings/', label: 'Weddings overview', groups: ['packages'] },
      { path: '/signature-wedding/', label: 'Signature Wedding Experience', itemIds: ['signature-wedding'] },
      { path: '/mobile-bar/', label: 'Mobile Bar', groups: ['mobile-bar'] },
    ],
  },
  bootstrapAdminEmails: ['chris@sibel.org', 'koasadmin@koasevents.com'],
  storage: {
    compatibilityBlobStores: {
      sales: 'koa-sales',
      crm: 'koa-crm',
      quotes: 'koa-quotes',
      eventOps: 'koa-event-ops',
      eventFiles: 'koa-event-files',
      vendors: 'koa-vendors',
      integrations: 'koa-integrations',
      email: 'koa-email',
      health: 'koa-system-health',
      calendar: 'koa-calendar',
      authSecurity: 'koa-auth-security',
    },
  },
  legal: {
    governingLawLabel: 'Hawaii state law',
    disputeVenueLabel: 'Hilo, Hawaii',
  },
};
