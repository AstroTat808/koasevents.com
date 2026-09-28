import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const args=new Set(process.argv.slice(2));
const strict=args.has('--strict-platform');
const json=args.has('--json');

const ignoredDirs=new Set(['.git','node_modules','dist','.netlify','.astro','coverage','public/uploads']);
const allowedTenantFiles=[
  'src/data/tenants/koa-events.ts',
  'src/data/businessRules.ts',
  'src/data/catalog.ts',
];

const patterns=[
  {id:'brand-name',re:/Koa(?:'|’)?s Events|Koa(?:'|’)?s\b/gi,kind:'tenant-brand'},
  {id:'domain',re:/koasevents\.com/gi,kind:'tenant-domain'},
  {id:'koa-email',re:/[A-Z0-9._%+-]+@(?:koasevents|koas)\.(?:com|us)/gi,kind:'tenant-contact'},
  {id:'hawaii',re:/Hawai(?:i|ʻi|\u02bbi)|Honolulu|Hilo|Mountain View,?\s+HI|Pacific\/Honolulu|Hawaiian Standard Time/gi,kind:'tenant-locale'},
  {id:'tax-rate-4.712',re:/\b4\.712\b/g,kind:'tenant-tax'},
  {id:'tax-rate-4.5',re:/\b4\.5\b/g,kind:'tenant-tax'},
  {id:'get-label',re:/\b(?:Hawai(?:i|ʻi|\u02bbi)\s+)?GET\b/g,kind:'tenant-tax'},
  {id:'koa-package',re:/\b(?:Gardenia|Orchid|Hibiscus|Plumeria)\b/g,kind:'tenant-catalog'},
  {id:'island-package',re:/\b(?:Oahu|Maui|Big Island)\b/g,kind:'tenant-catalog'},
  {id:'legacy-blob-store',re:/\bkoa-(?:sales|integrations|crm|events|admin|vendors|email|gallery|health)\b/g,kind:'tenant-storage'},
  {id:'koa-css-token',re:/--koa-[a-z0-9-]+/gi,kind:'tenant-brand-token',enforce:false},
];

const platformPrefixes=[
  'netlify/functions/',
  'src/pages/admin/',
  'src/lib/',
  'src/layouts/',
  'src/components/admin/',
  'scripts/',
];

function walk(dir){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(ignoredDirs.has(entry.name)) continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) out.push(...walk(full));
    else if(/\.(?:ts|mts|js|mjs|astro|json|md|yml|yaml|toml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function relative(file){return path.relative(root,file).split(path.sep).join('/');}
function isPlatform(file){return platformPrefixes.some(prefix=>file.startsWith(prefix));}
function allowed(file){return allowedTenantFiles.includes(file)||file.startsWith('src/data/tenants/');}

const findings=[];
for(const filePath of walk(root)){
  const file=relative(filePath);
  let text='';
  try{text=fs.readFileSync(filePath,'utf8');}catch{continue;}
  const lines=text.split(/\r?\n/);
  for(let index=0;index<lines.length;index++){
    const line=lines[index];
    for(const pattern of patterns){
      pattern.re.lastIndex=0;
      let match;
      while((match=pattern.re.exec(line))){
        findings.push({
          id:pattern.id,
          kind:pattern.kind,
          file,
          line:index+1,
          match:match[0],
          platform:isPlatform(file),
          allowed:allowed(file),
          enforce:pattern.enforce!==false,
          excerpt:line.trim().slice(0,260),
        });
        if(match.index===pattern.re.lastIndex)pattern.re.lastIndex++;
      }
    }
  }
}

const byFile=new Map();
for(const finding of findings){
  const rows=byFile.get(finding.file)||[];
  rows.push(finding);
  byFile.set(finding.file,rows);
}
const platformDebt=findings.filter(row=>row.platform&&!row.allowed&&row.enforce!==false);
const summary={
  scannedFiles:new Set(findings.map(row=>row.file)).size,
  findings:findings.length,
  platformDebt:platformDebt.length,
  tenantData:findings.filter(row=>row.allowed).length,
  publicOrOther:findings.filter(row=>!row.platform&&!row.allowed).length,
  filesWithPlatformDebt:new Set(platformDebt.map(row=>row.file)).size,
};

if(json){
  process.stdout.write(JSON.stringify({summary,findings},null,2)+'\n');
}else{
  console.log('# VenueLoom tenant-hardcoding audit');
  console.log('');
  console.log('Findings: '+summary.findings+' across '+summary.scannedFiles+' files.');
  console.log('Platform-sensitive findings: '+summary.platformDebt+' across '+summary.filesWithPlatformDebt+' files.');
  console.log('Tenant-data findings: '+summary.tenantData+'. Public/other findings: '+summary.publicOrOther+'.');
  console.log('');
  const files=[...byFile.keys()].sort((a,b)=>{
    const ad=(byFile.get(a)||[]).filter(row=>row.platform&&!row.allowed&&row.enforce!==false).length;
    const bd=(byFile.get(b)||[]).filter(row=>row.platform&&!row.allowed&&row.enforce!==false).length;
    return bd-ad||a.localeCompare(b);
  });
  for(const file of files){
    const rows=byFile.get(file)||[];
    const debt=rows.filter(row=>row.platform&&!row.allowed&&row.enforce!==false).length;
    console.log('## '+file+(debt?'  [PLATFORM DEBT: '+debt+']':''));
    const grouped=new Map();
    for(const row of rows){
      const key=row.id;
      const bucket=grouped.get(key)||[];
      bucket.push(row);
      grouped.set(key,bucket);
    }
    for(const [key,bucket] of grouped){
      const examples=bucket.slice(0,4).map(row=>'L'+row.line+' '+JSON.stringify(row.match)).join(', ');
      console.log('- '+key+': '+bucket.length+' ('+examples+(bucket.length>4?', …':'')+')');
    }
    console.log('');
  }
}

if(strict&&platformDebt.length){
  console.error('Tenant audit failed: '+platformDebt.length+' hardcoded tenant-specific references remain in platform-sensitive paths.');
  process.exit(1);
}
