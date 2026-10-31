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
      /echo\s+["']?\$(?:response|recovery|verification|audit|report|payload|raw_file|verification_file|recovery_file|audit_file|report_file|dark_mode_response)["']?/i,
      /cat\s+["']?\$(?:response|recovery|verification|audit_file|report_file|payload_file|raw_file|verification_file|recovery_file|dark_mode_response)["']?/i,
      /cat\s+[^\n]*system-health-dashboard(?:\.raw)?\.json/i,
    ],
  },
  {
    id:'sensitive-raw-response-payload',
    description:'raw CRM/accounting preview payload emitted by workflow logic',
    patterns:[
      /['"]?rows['"]?\s*:\s*preview\.get\(\s*['"]rows['"]\s*\)/i,
    ],
  },
  {
    id:'customer-data-artifact-path',
    description:'customer/accounting or raw System Health artifact path',
    patterns:[
      /accounting-adjustment-diagnostics\.json/i,
      /accounting-repair-bulk-preview\.json/i,
      /production-accounting-audits\.json/i,
      /critical-integration-real-rollback-drill\.json/i,
      /netlify-sandbox-self-heal-drill\.json/i,
      /\bQBO-CUST-\d+\b/i,
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
        const explicitSyntheticFixture = /@example\.(?:com|invalid)\b/i.test(line);
        if(pattern.test(line) && !(rule.id==='prohibited-pii-field' && explicitSyntheticFixture)){
          findings.push({file:rel,line:index+1,rule:rule.id,description:rule.description});
        }
        pattern.lastIndex=0;
      });
    }
  }

  // Historical CI exposure branches recorded raw authenticated responses in
  // artifact directories without necessarily calling the protected Health URL.
  // Track only dedicated response-file variables; ordinary fixture paths are
  // unaffected. A private /tmp or mktemp destination is mandatory.
  lines.forEach((line,index)=>{
    const assignment=line.match(/^\s*(raw_file|verification_file|recovery_file|audit_file|report_file|dark_mode_response)\s*=\s*(.+?)\s*$/i);
    if(!assignment)return;
    const value=assignment[2].trim().replace(/^["']|["']$/g,'');
    const safe=value.startsWith('/tmp/')||value.startsWith('$(mktemp')||value.startsWith('${RUNNER_TEMP}/');
    if(!safe){
      findings.push({file:rel,line:index+1,rule:'sensitive-raw-response-file',
        description:'raw authenticated response files must stay in a private temporary directory'});
    }
  });

  // Protected production API calls must write response bodies to a file, never stdout.
  for(let i=0;i<lines.length;i++){
    if(!protectedEndpoint.test(lines[i])) continue;
    const start=Math.max(0,i-12);
    const block=lines.slice(start,i+1).join('\n');
    const outputMatch=block.match(/(?:^|\s)(?:-o|--output)\s+(?:"([^"]+)"|'([^']+)'|([^\s\\]+))/m);
    if(!/curl\s/i.test(block))continue;
    if(!outputMatch){
      findings.push({
        file:rel,line:i+1,rule:'protected-api-stdout',
        description:'protected production API call without an explicit output file',
      });
      continue;
    }
    const dest=outputMatch[1]||outputMatch[2]||outputMatch[3]||'';
    const variable=dest.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1]||'';
    const assignments=variable?lines.slice(0,i).filter(line=>
      new RegExp('^\\s*'+variable+'\\s*=').test(line)
    ):[];
    const last=assignments[assignments.length-1]||'';
    const privateOutput=dest.startsWith('/tmp/')
      ||(variable&&/(?:mktemp|\/tmp\/)/.test(last)&&!/(?:visual-results|artifacts|uploads)/i.test(last));
    if(!privateOutput){
      findings.push({
        file:rel,line:i+1,rule:'protected-api-output-destination',
        description:'authenticated production response may only be written to a private temporary file, not an uploaded artifact path',
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
