export type TenantTaxPolicyMode = 'manual-review' | 'configured';

export type TenantTaxProfile = {
  id: string;
  label: string;
  kind: 'sales-tax' | 'gross-receipts' | 'vat' | 'gst' | 'other';
  enabled: boolean;
  statutoryRate: number;
  customerRate: number;
  maxPassOnRate: number;
  defaultTaxable: boolean;
  exemptionPolicy: {
    mode: TenantTaxPolicyMode;
    itemLevelRulesConfigured: boolean;
    reviewMessage: string;
  };
};

export type TenantCatalogSeedItem = {
  id: string;
  name: string;
  description: string;
  category: 'service' | 'rental' | 'mileage' | 'fee';
  group: 'packages' | 'rentals' | 'mobile-bar' | 'add-ons' | 'fees' | 'other';
  unitLabel: string;
  unitPrice: number;
  active: boolean;
  taxExempt: boolean;
  sourceRef: string;
  quickBooksType: 'Service' | 'NonInventory';
};

export type TenantCatalogPlacementRule = {
  path: string;
  label: string;
  groups?: TenantCatalogSeedItem['group'][];
  itemIds?: string[];
};

export type TenantCatalogConfig = {
  canonicalAliases: Record<string, string>;
  quickBooksAliases: Record<string, string[]>;
  bootstrapItems: TenantCatalogSeedItem[];
  websitePlacements: TenantCatalogPlacementRule[];
};

export type TenantSalesConfig = {
  packageAliases: Record<string, string>;
  catalogItemByPackage: Record<string, string>;
  weddingPackageIds: string[];
  mobileBarPackageIds: string[];
  privateEventPackageIds: string[];
};

export type TenantDamageDepositConfig = {
  enabled: boolean;
  defaultRentalType: 'one-day' | 'weekend';
  oneDayAmount: number;
  weekendAmount: number;
  dueDaysBefore: number;
  refundWithinDays: number;
};

export type TenantAccountingConfig = {
  damageDeposit: TenantDamageDepositConfig;
};

export type TenantProfile = {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  locale: string;
  currency: string;
  timezone: string;
  microsoftTimeZone: string;
  domains: {
    primary: string;
    admin: string;
  };
  contact: {
    email: string;
    phone: string;
    phoneDisplay: string;
    venueAddress: string;
    mailingAddress: string;
  };
  brand: {
    tagline: string;
    logoPath: string;
  };
  tax: TenantTaxProfile;
  catalog: TenantCatalogConfig;
  sales: TenantSalesConfig;
  accounting: TenantAccountingConfig;
  bootstrapAdminEmails: string[];
  storage: {
    legacyDataBelongsToTenant: boolean;
    compatibilityBlobStores: {
      sales: string;
      quotes: string;
      integrations: string;
      crm: string;
      eventOps: string;
      vendors: string;
      eventFiles: string;
      vendorFiles: string;
      emailAnalytics: string;
      emailRouting: string;
      authSecurity: string;
      staffDirectory: string;
      systemHealth: string;
      workspaceAlerts: string;
    };
  };
  legal: {
    governingLawLabel: string;
    disputeVenueLabel: string;
  };
};
