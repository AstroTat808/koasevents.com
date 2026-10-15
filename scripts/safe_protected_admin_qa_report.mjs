#!/usr/bin/env node
// Report only static QA identifiers and fixed categories; never print raw browser
// output, production responses, paths, session data, exceptions, or screenshots.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const ADMIN_CASES=new Set([
 'admin-home','admin-actions','admin-business-crm','admin-clients','admin-sales-crm',
 'admin-catalog-manager','admin-email','admin-email-preview','admin-wedding-profitability',
 'admin-events','admin-calendar','admin-mobile-bar-workforce','admin-blog','admin-staff',
 'admin-quickbooks','admin-gallery','admin-security','admin-seo','admin-health',
 'admin-organization','admin-payroll','admin-platform','admin-insurance','admin-vendors',
 'platform-authorized-startup','trusted-browser-account-menu',
 'business-crm-authorized-startup','payment-rule-live-simulator',
 'sales-crm-payment-rule-explanation','catalog-manager-import-rollback',
 'profitability-catalog-publishing','gallery-usage-crop-impact',
 'homepage-placement-crop-override'
]);
const ALLOWED_PATHS=new Map([
 ['/','homepage-placement-crop-override'],
 ['/admin/platform/','admin-platform'],
 ['/admin/health/','admin-health'],
 ['/admin/crm/','admin-business-crm'],
 ['/admin/quickbooks/','admin-quickbooks'],
 ['/admin/quotes/','admin-sales-crm'],
 ['/admin/catalog/','admin-catalog-manager'],
 ['/admin/profitability/','admin-wedding-profitability'],
 ['/admin/gallery/','admin-gallery'],
]);
const API_PATHS=new Set([
 '/api/admin/staff','/api/admin/custom-roles','/api/admin/auth-security',
 '/api/admin/crm','/api/admin/quotes','/api/admin/catalog',
 '/api/admin/profitability','/api/admin/events','/api/admin/calendar',
 '/api/admin/quickbooks','/api/blog?admin=1','/api/admin/vendors',
 '/api/admin/vendor-insurance-compliance','/api/admin/security?days=7',
 '/api/admin/local-seo','/api/admin/health','/api/admin/platform'
]);
const isKnownCase=(name)=>ADMIN_CASES.has(name);
export function safeAdminQaSummary(report){
 if(report?.mode!=='admin'||!Array.isArray(report.routes)||!Array.isArray(report.failures))
   return {ok:false,failed:1,findings:[{case:'unclassified',code:'QA_REPORT_MISSING'}]};
 const findings=[],seen=new Set();
 const add=(name,detail,source)=>{
   const known=isKnownCase(name)?name:'unclassified';
   // Classification only. No detail strings or copied status/body values enter output.
   const msg=typeof detail==='string'?detail:'';
   const code=source==='api'?'QA_ADMIN_API_CONTRACT_FAILED'
     :/timeout|timed out/i.test(msg)?'QA_ADMIN_STARTUP_TIMEOUT'
     :/javascript|page errors|pageerror/i.test(msg)?'QA_ADMIN_SCRIPT_FAILED'
     :/selector|visible|initialized|expected/i.test(msg)?'QA_ADMIN_UI_STATE_FAILED'
     :/http \d{3}/i.test(msg)?'QA_ADMIN_HTTP_FAILED'
     :'QA_ADMIN_CHECK_FAILED';
   const key=known+'|'+code;
   if(seen.has(key))return;seen.add(key);
   if(findings.length<60)findings.push({case:known,code});
 };
 for(const row of report.routes){
   if(!row?.failure)continue;
   add(row.name,row.failure,'route');
 }
 for(const row of Array.isArray(report.protectedApis)?report.protectedApis:[]){
   if(row?.ok!==false)continue;
   const path=typeof row.path==='string'?row.path:'';
   const name=API_PATHS.has(path)?'protected-admin-api':'unclassified';
   add(name,'','api');
 }
 // Detect failures without a named result, without publishing its route/detail.
 if(report.failures.length>0&&findings.length===0)
   add('unclassified','','unknown');
 return {ok:findings.length===0&&report.failures.length===0,
   failed:Math.max(findings.length,report.failures.length),findings};
}
function selfTest(){
 const report={mode:'admin',routes:[
  {name:'platform-authorized-startup',failure:'Timeout 8000ms exceeded. PRIVATE_EMAIL=example@invalid.test'},
  {name:'customer-email',failure:'Javascript page errors: private@example.invalid'}],
  protectedApis:[{path:'/api/admin/health',ok:false}],
  failures:[{route:'/admin/platform/',detail:'PRIVATE_EMAIL'}]};
 const safe=safeAdminQaSummary(report);
 if(safe.findings.length!==3||safe.findings[0].case!=='platform-authorized-startup'
   ||safe.findings[0].code!=='QA_ADMIN_STARTUP_TIMEOUT'
   ||safe.findings[1].case!=='unclassified'
   ||safe.findings[2].code!=='QA_ADMIN_API_CONTRACT_FAILED'
   ||JSON.stringify(safe).includes('PRIVATE')||JSON.stringify(safe).includes('@')
   ||safeAdminQaSummary({}).findings[0].code!=='QA_REPORT_MISSING')
   throw new Error('Privacy-safe QA reporter self-test failed.');
 console.log('PASS | protected-admin sanitized case IDs, stable failure codes, no customer payloads.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv[2]==='--self-test')selfTest();
  else {
   const path=String(process.argv[2]||'');
   // Only read the expected fixed local report path, never an external URL.
   if(path!=='visual-results/admin-chromium/report.json')
     throw new Error('Unexpected report path');
   const report=JSON.parse(readFileSync(path,'utf8'));
   const result=safeAdminQaSummary(report);
   console.log('Protected admin QA | passed='+String(result.ok)+' | failed='+result.failed);
   for(const row of result.findings)
     console.log('QA blocker | '+row.case+' | '+row.code);
   if(!result.ok)process.exitCode=1;
  }
 }catch{
  // Deliberately withhold parser/IO exception text and untrusted content.
  console.error('QA blocker | unclassified | QA_REPORT_MISSING');
  process.exitCode=1;
 }
}
