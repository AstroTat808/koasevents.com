import type { Config, Context } from '@netlify/functions';
import { readPublishedAddOnPricing } from './_shared/wedding-pricing';

export default async (_req: Request, context: Context) => {
  const prices = await readPublishedAddOnPricing(context);
  return Response.json(
    { prices, updatedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60' } },
  );
};

export const config: Config = { path: '/api/catalog-pricing' };
