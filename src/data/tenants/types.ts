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
  bootstrapAdminEmails: string[];
  storage: {
    compatibilityBlobStores: {
      sales?: string;
      crm?: string;
      eventOps?: string;
      eventFiles?: string;
      vendors?: string;
      integrations?: string;
      email?: string;
      health?: string;
      calendar?: string;
      authSecurity?: string;
    };
  };
  legal: {
    governingLawLabel: string;
    disputeVenueLabel: string;
  };
};
