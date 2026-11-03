import type { Context, Config } from '@netlify/functions';
import { requireCapability } from './_shared/admin';
import { runWithTenant } from './_shared/tenant';
import { conditionalTenantStoreFor } from './_shared/tenant-storage';
import { reviewCustomerDuplicates } from './_shared/crm-duplicate-review.mjs';
import { leadOriginEvidence } from './_shared/lead-provenance.mjs';

const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Vary': 'Cookie, Authorization',
};
const respond = (body: unknown, status = 200) => Response.json(body, {status, headers});
const normalize = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
const safeName = (value: unknown) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') return new Response('Method not allowed', {status:405,headers:{...headers,Allow:'POST'}});
  const auth = await requireCapability('crm.view',req,context);
  if (auth.response) return auth.response;
  const tenant = auth.tenant;
  if (!tenant) return respond({error:'Organization access is required.'},403);
  if (req.headers.get('origin') !== new URL(req.url).origin || req.headers.get('sec-fetch-site') === 'cross-site')
    return respond({error:'Open this audit from the signed-in CRM.'},403);
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    return respond({error:'JSON request expected.'},415);
  if (Number(req.headers.get('content-length')||0)>5000) return respond({error:'Audit request is too large.'},413);
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > 5000) return respond({error:'Audit request is too large.'},413);
  let body:any;
  try { body=JSON.parse(raw); } catch { return respond({error:'Invalid JSON request.'},400); }
  if (!Array.isArray(body?.names) || body.names.length<1 || body.names.length>20)
    return respond({error:'Enter 1 to 20 full customer names.'},422);
  const names = [...new Set(body.names.map(safeName).filter(Boolean))];
  if (names.length < 1 || names.length > 20 || names.some((s:string)=>s.length<2||s.length>180||/[<>\x00-\x1f]/.test(s)))
    return respond({error:'Every name must be 2 to 180 characters without markup or control characters.'},422);

  return runWithTenant(tenant, async()=>{
    const sales=conditionalTenantStoreFor(context,tenant,'sales');
    // No writes, imports, projection repair, or audit mutation.
    const snapshot=await sales.readOnlyJSON('records/index');
    if(!Array.isArray(snapshot.data))
      return respond({error:'Active sales index is unavailable. No results can be certified.'},503);
    const records=snapshot.data.filter((row:any)=>row&&typeof row==='object');
    const reports=names.map((name:string)=>{
      const matches=records.filter((row:any)=>normalize(row.customer?.name)===normalize(name));
      const review=reviewCustomerDuplicates(records,{name});
      const byId=new Map(review.records.map((row:any)=>[row.id,row]));
      const evidence=matches.slice(0,100).map((record:any)=>{
        const origin=leadOriginEvidence(record);
        const classification:any=byId.get(record.id)||{};
        return {
          recordId:String(record.id||''),
          kind:String(record.kind||''),
          stage:String(record.stage||''),
          eventDate:String(record.customer?.eventDate||''),
          source:String(record.source||''),
          formName:String(record.inquiry?.formName||''),
          createdAt:String(record.createdAt||''),
          updatedAt:String(record.updatedAt||''),
          location:record.mergedInto?'merged_index_record':'active_sales_index',
          classification:String(classification.classification||'needs_review'),
          testVerified:Boolean(classification.testVerified),
          protectedLinks:classification.protectedLinks||{},
          originReliability:origin.reliability,
          intakeMode:origin.intakeMode,
          originalChannel:origin.channel,
          originalFormName:origin.formName,
          originalCapturedAt:origin.capturedAt,
          customerReportedSource:origin.discoverySource,
          customerReportedReferral:origin.referralSource,
          firstTouch:origin.firstTouch||null,
          submissionAttribution:origin.attribution||null,
        };
      }).sort((a:any,b:any)=>a.createdAt.localeCompare(b.createdAt));
      return {
        name,matchCount:matches.length,truncated:matches.length>100,
        sourceStatus:!matches.length?'not_found':evidence.every((r:any)=>!r.source&&!r.originalChannel)?'unknown':'recorded_fields_available',
        records:evidence,
      };
    });
    return respond({
      ok:true,readOnly:true,generatedAt:new Date().toISOString(),
      scope:'active_tenant_sales_index',
      attributionCaveat:'Original fields and intake snapshots are CRM evidence; UTM/referrer values are browser-reported, not independently verified.',
      historyCaveat:'This report does not search external mailboxes, deleted backups, or archived records outside the active sales index. Matching names alone do not establish customer identity.',
      summary:{
        names:reports.length,matchingRecords:reports.reduce((sum:number,row:any)=>sum+row.matchCount,0),
        namesNotFound:reports.filter((row:any)=>!row.matchCount).length,
        truncated:reports.some((row:any)=>row.truncated),
      },
      reports,
    });
  });
};
export const config:Config={path:'/api/admin/crm/lead-audit'};
