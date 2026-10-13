#!/usr/bin/env node
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const FAILURE_FILE='/tmp/koa-build-failure.json';
const steps=[
  ['production-release-gate','Production release gate','node',['scripts/verify_netlify_release_gate.mjs'],false],
  ['source-visual-audit','Source visual audit','python3',['scripts/production_visual_qa.py','--mode','source'],false],
  ['prebuild-checks','Prebuild checks','node',['scripts/run_prebuild_checks.mjs'],true],
  ['astro-build','Astro production build','npm',['run','build','--ignore-scripts'],false],
];

function display(command,args){return [command,...args].join(' ');}
function writeFailure(id,label,command,args,result,preserveExisting){
  if(preserveExisting&&existsSync(FAILURE_FILE))return;
  const row={
    schemaVersion:1,source:'koa-netlify-build-runner',stage:id,check:id,
    command:display(command,args),
    exitCode:Number.isInteger(result.status)?result.status:1,
    signal:String(result.signal||''),
    message:label+' failed: '+display(command,args),
    commit:String(process.env.COMMIT_REF||''),
    deployId:String(process.env.DEPLOY_ID||''),
    buildId:String(process.env.BUILD_ID||''),
    context:String(process.env.CONTEXT||''),
    recordedAt:new Date().toISOString(),
  };
  writeFileSync(FAILURE_FILE,JSON.stringify(row));
  console.error('[koa build diagnosis] '+JSON.stringify(row));
}
try{rmSync(FAILURE_FILE,{force:true});}catch{}
for(const [id,label,command,args,preserveExisting] of steps){
  console.log('[koa netlify build] '+label+' · '+display(command,args));
  const result=spawnSync(command,args,{stdio:'inherit',env:process.env});
  if(result.error||result.status!==0){
    writeFailure(id,label,command,args,result,preserveExisting);
    process.exit(Number.isInteger(result.status)&&result.status!==0?result.status:1);
  }
}
try{rmSync(FAILURE_FILE,{force:true});}catch{}
console.log('[koa netlify build] PASS · structured production build completed.');
