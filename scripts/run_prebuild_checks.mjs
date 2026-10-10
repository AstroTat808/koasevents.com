#!/usr/bin/env node
import { rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const FAILURE_FILE='/tmp/koa-build-failure.json';
const checks=[
  ['build-safety','Build safety','npm',['run','build:safety']],
  ['release-gate-regression','Release gate regression','npm',['run','test:release-gate']],
  ['deploy-recovery-regression','Deploy recovery regression','npm',['run','test:deploy-recovery']],
  ['build-diagnostics-regression','Build diagnostics regression','npm',['run','test:build-diagnostics']],
  ['theme-regression','Theme regression','npm',['run','test:theme']],
  ['health-dashboard-regression','System Health dashboard regression','npm',['run','test:health-dashboard']],
  ['synthetic-health-regression','Synthetic health regression','npm',['run','test:synthetic-health']],
  ['critical-integrations-regression','Critical Integrations regression','npm',['run','test:critical-integrations']],
  ['tenant-hardcoding-audit','Tenant hardcoding audit','npm',['run','audit:tenant:strict']],
  ['tenant-storage-audit','Tenant storage audit','npm',['run','audit:tenant:storage']],
  ['tenant-integrations-audit','Tenant integrations audit','npm',['run','audit:tenant:integrations']],
  ['tenant-schedules-audit','Tenant schedules audit','npm',['run','audit:tenant:schedules']],
  ['tenant-request-audit','Tenant request audit','npm',['run','audit:tenant:requests']],
  ['tenant-isolation-regression','Tenant isolation regression','npm',['run','test:tenant:isolation']],
  ['tenant-isolation-qa','Tenant isolation QA','npm',['run','test:tenant-isolation']],
  ['accounting-regression','Accounting regression','npm',['run','test:accounting']],
  ['qbo-audit-display-regression','QuickBooks audit display regression','npm',['run','test:qbo-audit-display']],
  ['duplicate-booking-regression','Duplicate booking regression','npm',['run','test:duplicate-bookings']],
  ['qbo-accounting-scope-regression','QuickBooks accounting scope regression','npm',['run','test:qbo-accounting-scope']],
  ['invoice-repair-regression','Invoice repair safety regression','npm',['run','test:invoice-repair']],
  ['platform-admin-regression','Platform admin regression','npm',['run','test:platform-admin']],
  ['auth-security-regression','Authentication security regression','npm',['run','test:auth-security']],
];

function display(command,args){return [command,...args].join(' ');}
function recordFailure(id,label,command,args,result){
  const row={
    schemaVersion:1,source:'koa-prebuild-runner',stage:'prebuild',check:id,
    command:display(command,args),
    exitCode:Number.isInteger(result.status)?result.status:1,
    signal:String(result.signal||''),
    message:label+' failed: '+display(command,args),
    commit:String(process.env.COMMIT_REF||process.env.GITHUB_SHA||''),
    deployId:String(process.env.DEPLOY_ID||''),
    buildId:String(process.env.BUILD_ID||''),
    context:String(process.env.CONTEXT||''),
    recordedAt:new Date().toISOString(),
  };
  writeFileSync(FAILURE_FILE,JSON.stringify(row));
  console.error('[koa build diagnosis] '+JSON.stringify(row));
}
try{rmSync(FAILURE_FILE,{force:true});}catch{}
for(const [id,label,command,args] of checks){
  console.log('[koa prebuild] '+label+' · '+display(command,args));
  const result=spawnSync(command,args,{stdio:'inherit',env:process.env});
  if(result.error||result.status!==0){
    recordFailure(id,label,command,args,result);
    process.exit(Number.isInteger(result.status)&&result.status!==0?result.status:1);
  }
}
try{rmSync(FAILURE_FILE,{force:true});}catch{}
console.log('[koa prebuild] PASS · all '+checks.length+' checks completed.');
