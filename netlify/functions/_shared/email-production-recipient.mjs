// A production QA email may go only to an explicitly configured address,
// or the source-controlled bootstrap administrator of Koa's original tenant.
// Never default to a customer, sales contact, or a dynamic organization user.
const valid = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export function controlledEmailQaRecipient(tenant, configured) {
  const explicit = String(configured || '').trim().toLowerCase();
  if (explicit) return valid(explicit) ? explicit : '';
  if (tenant?.id !== 'koa-events') return '';
  const bootstrap = Array.isArray(tenant?.bootstrapAdminEmails) ? tenant.bootstrapAdminEmails : [];
  const firstAdmin = String(bootstrap[0] || '').trim().toLowerCase();
  return valid(firstAdmin) ? firstAdmin : '';
}
