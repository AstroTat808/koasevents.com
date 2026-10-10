import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const workflowsDir=path.join(root,'.github','workflows');

function walk(dir){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) out.push(...walk(full));
    else if(/\.ya?ml$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const rules=[
  {
    id:'raw-response-echo',
    description:'raw protected API response logging',
    patterns:[
      /echo\s+["']?\$(?:response|recovery|verification|audit|report|payload)["']?/i,
      /cat\s+["']?\$(?:response|recovery|verification|audit_file|report_file|payload_file)["']?/i,
      /cat\s+[^\n]*system-health-dashboard(?:\.raw)?\.json/i,
    ],
  },
  {
    id:'customer-data-artifact-path',
    description:'customer/accounting or raw System Health artifact path',
    patterns:[
      /accounting-adjustment-diagnostics\.json/i,
      /accounting-repair-bulk-preview\.json/i,
      /production-accounting-audits\.json/i,
      /(?:^|[\/])system-health-dashboard\.json\b/im,
    ],
  },
  {
    id:'authenticated-production-artifact',
    description:'authenticated production browser evidence retained as an Actions artifact',
    patterns:[
      /name:\s*koa-system-health-mobile-/i,
      /name:\s*koa-admin-startup-/i,
      /name:\s*koa-live-theme-/i,
      /name:\s*koa-visual-qa-/i,
    ],
  },
  {
    id:'prohibited-pii-field',
    description:'PII, external-account identifier, or customer-level financial field name in workflow logic',
    patterns:[
      /["'](?:client|clientName|email|recordId|qboCustomerId|quickBooksCustomerId|estimateId|estimateDocNumber|rawFields|proposalTotal|estimateTotal|salesLineTotal|transactionAdjustment|discountLineAmount|totalTax|expectedTotal|actualTotal|liveClientEstimateTotal)["']/,
    ],
  },
];

const protectedEndpoint=/https:\/\/koasevents\.com\/api\/system-health\/github-main-signal/i;
const findings=[];

for(const file of walk(workflowsDir)){
  const rel=path.relative(root,file).replaceAll('\\','/');
  const text=fs.readFileSync(file,'utf8');
  const lines=text.split(/\r?\n/);

  for(const rule of rules){
    for(const pattern of rule.patterns){
      lines.forEach((line,index)=>{
        if(pattern.test(line)){
          findings.push({file:rel,line:index+1,rule:rule.id,description:rule.description});
        }
        pattern.lastIndex=0;
      });
    }
  }

  // Protected production API calls must write response bodies to a file, never stdout.
  for(let i=0;i<lines.length;i++){
    if(!protectedEndpoint.test(lines[i])) continue;
    const start=Math.max(0,i-12);
    const block=lines.slice(start,i+1).join('\n');
    if(/curl\s/i.test(block) && !/(?:^|\s)-o\s+/m.test(block) && !/--output\s+/m.test(block)){
      findings.push({
        file:rel,
        line:i+1,
        rule:'protected-api-stdout',
        description:'protected production API call without an explicit output file',
      });
    }
  }
}

if(findings.length){
  console.error('CI privacy gate FAILED.');
  for(const f of findings){
    console.error(`- ${f.file}:${f.line} [${f.rule}] ${f.description}`);
  }
  process.exit(1);
}

console.log(`CI privacy gate passed: ${walk(workflowsDir).length} workflow files scanned; no prohibited production-data logging or artifact retention patterns found.`);
