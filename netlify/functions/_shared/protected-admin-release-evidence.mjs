// Only fixed, public QA identifiers may enter persistent production Release History.
// No raw URLs, error messages, screenshot links, browser logs or customer fields.
const ROUTES=new Set([
  'admin-home','admin-actions','admin-business-crm','admin-clients','admin-sales-crm',
  'admin-catalog-manager','admin-email','admin-email-preview','admin-wedding-profitability',
  'admin-events','admin-calendar','admin-mobile-bar-workforce','admin-blog','admin-staff',
  'admin-quickbooks','admin-gallery','admin-security','admin-seo','admin-health',
  'admin-organization','admin-payroll','admin-platform','admin-insurance','admin-vendors',
  'user-management-api','custom-roles-api','auth-security-api','business-crm-api',
  'sales-crm-api','catalog-manager-api','wedding-profitability-api','event-ops-api',
  'calendar-api','quickbooks-api','blog-admin-api','vendor-crm-api',
  'vendor-insurance-api','security-api','local-seo-api','system-health-api',
  'platform-admin-api','gallery-api','unknown',
]);
const CODES=new Set([
  'ADMIN_QA_ASSERTION_FAILED','ADMIN_QA_AUTHORIZATION_GUARD_FAILED',
  'ADMIN_QA_PUBLIC_READ_FAILED','ADMIN_QA_DOCUMENT_HTTP_FAILED',
  'ADMIN_QA_CLIENT_EXCEPTION','ADMIN_QA_TIMEOUT','ADMIN_QA_STARTUP_STATE_FAILED',
  'ADMIN_QA_TRUSTED_SESSION_UI_FAILED','ADMIN_QA_GALLERY_UI_FAILED',
  'ADMIN_QA_HOMEPAGE_CROP_FAILED',
]);
const TOP_CODES=new Set(['ADMIN_QA_REPORT_MISSING','ADMIN_QA_REPORT_MALFORMED',
  'ADMIN_QA_UNEXPECTED_PROCESS_FAILURE']);
export function normalizeProtectedAdminQa(input,{commit,deployId,runId,checkedAt}={}){
  if(!/^[a-f0-9]{40}$/.test(String(commit||''))||
    !/^[a-f0-9]{24}$/.test(String(deployId||''))||
    !/^[0-9]{4,20}$/.test(String(runId||''))||
    !Number.isFinite(Date.parse(String(checkedAt||''))))throw Error('ADMIN_QA_INVALID_IDENTITY');
  if(!input||typeof input!=='object'||Array.isArray(input)||
    typeof input.ok!=='boolean'||!Number.isSafeInteger(input.totalFailures)||
    input.totalFailures<0||input.totalFailures>150||!Array.isArray(input.failures)||
    input.failures.length>150)throw Error('ADMIN_QA_INVALID_SUMMARY');
  const rows=input.failures.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||
      !ROUTES.has(row.route)||!CODES.has(row.code)||
      Object.keys(row).sort().join(',')!=='code,route')
      throw Error('ADMIN_QA_UNALLOWLISTED_FAILURE');
    return {route:row.route,code:row.code};
  });
  if(Object.keys(input).some(key=>!['ok','totalFailures','failures','code'].includes(key))||
    (input.code!==undefined&&!TOP_CODES.has(input.code))||
    (input.ok&&input.totalFailures!==0)||
    (input.ok&&rows.length!==0)||
    (!input.ok&&input.totalFailures===0&&!TOP_CODES.has(input.code))||
    (input.totalFailures!==rows.length&&input.totalFailures<=150&&input.code===undefined)||
    (input.totalFailures!==0&&!rows.length&&!TOP_CODES.has(input.code)))
    throw Error('ADMIN_QA_INCONSISTENT_SUMMARY');
  const code=input.code||null;
  return {
    status:input.ok?'passed':'failed',browser:'chromium',
    checkedAt:String(checkedAt),commit:String(commit),deployId:String(deployId),
    runId:String(runId),source:'github-actions-oidc',
    checkedCount:42, // Count of registered admin routes / API probes; not per-test execution count.
    failureCount:input.totalFailures,failures:rows,code,
  };
}
