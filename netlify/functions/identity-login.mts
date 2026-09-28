import type { Handler } from '@netlify/functions';
import { tenantProfiles } from '../../src/data/tenants';

function bootstrapAdminEmails() {
  return new Set(tenantProfiles.flatMap((tenant) => tenant.bootstrapAdminEmails).map((email) => String(email).toLowerCase()));
}

const handler: Handler = async (event) => {
  const payload = JSON.parse(event.body || '{}');
  const user = payload.user || {};
  const email = String(user.email || '').trim().toLowerCase();

  const existingAppMetadata =
    user.app_metadata && typeof user.app_metadata === 'object'
      ? user.app_metadata
      : {};

  const existingRoles = Array.isArray(existingAppMetadata.roles)
    ? existingAppMetadata.roles.filter((role: unknown) => typeof role === 'string')
    : [];

  const roles = bootstrapAdminEmails().has(email)
    ? [...new Set([...existingRoles.filter((role: string) => role !== 'deactivated'), 'admin'])]
    : existingRoles;

  return {
    statusCode: 200,
    body: JSON.stringify({
      app_metadata: {
        ...existingAppMetadata,
        roles,
      },
    }),
  };
};

export { handler };
