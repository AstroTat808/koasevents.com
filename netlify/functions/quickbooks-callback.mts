import type { Context } from '@netlify/functions';
import { completeOAuth } from './_shared/quickbooks';

export default async (req: Request, context: Context) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);

  try {
    await completeOAuth(context, req.url);
    return Response.redirect(url.origin + '/admin/quickbooks/?connected=1', 302);
  } catch (error) {
    console.error('QuickBooks OAuth callback failed', error);
    return Response.redirect(url.origin + '/admin/quickbooks/?qbo=error', 302);
  }
};
