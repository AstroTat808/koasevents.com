import type { Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

export const ADDON_CATALOG_MAPPING: Record<string, string> = {
  'mobile-bar-upgrade': 'mobile-bar-upgrade',
  'mobile-bar-extra-hour': 'bar-additional-hour',
  'venue-extra-hour': 'venue-additional-hour',
  'floral-upgrade': 'florals',
  'cake-upgrade': 'cake-upgrade',
  'photo-booth-extra-hour': 'photo-booth-additional-hour',
  'decor-upgrade': 'decor-upgrade',
  'rental-upgrade': 'rental-upgrade',
  'coordination-extra-hour': 'coordination-additional-hour',
};

export type PublishedAddOnPrice = {
  addOnId: string;
  catalogItemId: string;
  name: string;
  unit: string;
  price: number;
  approvedAt: string;
};

function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}

function finite(value: unknown, min = 0, max = 10_000_000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function clean(value: unknown, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

export function recommendedAddOnPrice(directCost: unknown, targetMargin: unknown, increment: unknown) {
  const cost = finite(directCost);
  const margin = Math.min(0.9, Math.max(0.05, finite(targetMargin, 0.05, 0.9)));
  const step = Math.max(1, Math.round(finite(increment, 1, 1000)));
  if (cost <= 0) return 0;
  return Math.ceil((cost / (1 - margin)) / step) * step;
}

export async function readWeddingProfitabilitySettings(context: Context): Promise<any> {
  return await salesStoreFor(context).get('settings/wedding-profitability', { type: 'json' }) || {};
}

export function publishedAddOnPricingFromState(state: any): PublishedAddOnPrice[] {
  const addOns = Array.isArray(state?.addOns) ? state.addOns : [];
  return addOns
    .filter((row: any) => row?.approved === true && finite(row?.sellPrice) > 0)
    .map((row: any) => ({
      addOnId: clean(row.id, 80),
      catalogItemId: clean(row.catalogItemId || ADDON_CATALOG_MAPPING[clean(row.id, 80)] || '', 80),
      name: clean(row.name, 160),
      unit: clean(row.unit, 80),
      price: Math.round(finite(row.sellPrice) * 100) / 100,
      approvedAt: clean(row.approvedAt, 60),
    }))
    .filter((row: PublishedAddOnPrice) => row.addOnId && row.catalogItemId);
}

export async function readPublishedAddOnPricing(context: Context): Promise<PublishedAddOnPrice[]> {
  const state = await readWeddingProfitabilitySettings(context);
  return publishedAddOnPricingFromState(state);
}

export function publishedPriceMap(rows: PublishedAddOnPrice[]) {
  return new Map(rows.map((row) => [row.catalogItemId, row]));
}
