import type { Config } from '@netlify/functions';
import { capabilitiesFor, isApprovedAdmin, operationsRole, requireOperations } from './_shared/admin';

function clean(value: unknown, max=240) {
  return String(value || '').trim().slice(0,max);
}

export default async () => {
  const auth=await requireOperations();
  if(auth.response) return auth.response;
  const role=operationsRole(auth.user);
  const permissions=capabilitiesFor(auth.user);
  const email=clean(auth.user?.email,240).toLowerCase();
  return Response.json({
    email,
    role,
    roles:[role],
    isAdmin:isApprovedAdmin(auth.user),
    permissions,
    app_metadata:{roles:[role],permissions},
    appMetadata:{roles:[role],permissions},
  },{headers:{'Cache-Control':'private, no-store'}});
};

export const config:Config={path:'/api/admin/session'};
