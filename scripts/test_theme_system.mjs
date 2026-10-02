import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT=path.resolve(new URL('..',import.meta.url).pathname);
const SRC=path.join(ROOT,'src');
const OUT=path.join(ROOT,'visual-results');
const failures=[];

async function walk(dir){
  const out=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

const all=await walk(SRC);
const sourceFiles=all.filter((file)=>/\.(astro|css)$/.test(file));
const pageFiles=sourceFiles.filter((file)=>file.includes(path.join('src','pages')+path.sep)&&file.endsWith('.astro'));
const texts=new Map();
for(const file of sourceFiles)texts.set(file,await readFile(file,'utf8'));

const rel=(file)=>path.relative(ROOT,file).replaceAll(path.sep,'/');
const baseLayout=await readFile(path.join(SRC,'layouts','BaseLayout.astro'),'utf8');
const globalCss=await readFile(path.join(SRC,'styles','global.css'),'utf8');
const workspaceNav=await readFile(path.join(SRC,'components','StaffUtilityNav.astro'),'utf8');
const siteHeader=await readFile(path.join(SRC,'components','Header.astro'),'utf8');

for(const needle of [
  "koa-theme-preference",
  "prefers-color-scheme: dark",
  "dataset.themePreference",
  "koa:theme-request",
  "koa:theme-change",
  "koa-theme-color",
]){
  if(!baseLayout.includes(needle))failures.push('BaseLayout theme bootstrap missing '+needle);
}
for(const needle of [
  '--koa-canvas:',
  '--koa-surface:',
  '--koa-text:',
  'html[data-theme="dark"]',
  '[class*="bg-white/"]',
  '[class*="text-[var(--koa-ink)]/"]',
  'background-color: var(--koa-surface)',
]){
  if(!globalCss.includes(needle))failures.push('Global dark theme layer missing '+needle);
}
for(const preference of ['light','dark','system']){
  if(!workspaceNav.includes('data-theme-preference="'+preference+'"')){
    failures.push('Account appearance control missing '+preference);
  }
}
if(!workspaceNav.includes('data-workspace-theme-status')){
  failures.push('Account menu is missing the appearance status.');
}
for(const needle of [
  'data-site-theme-toggle',
  'data-site-theme-moon',
  'data-site-theme-sun',
  "dark ? 'light' : 'dark'",
  "koa:theme-request",
  "koa:theme-change",
]){
  if(!siteHeader.includes(needle))failures.push('Public navbar theme toggle missing '+needle);
}

for(const needle of [
  'data-workspace-theme-toggle',
  'data-workspace-theme-moon',
  'data-workspace-theme-sun',
  "resolved==='dark'?'light':'dark'",
]){
  if(!workspaceNav.includes(needle))failures.push('Visible workspace theme toggle missing '+needle);
}
for(const needle of [
  "save-appearance-preference",
  "appearancePreference",
  "applyAccountThemePreference",
  "/api/account/profile",
]){
  if(!workspaceNav.includes(needle))failures.push('Account-synced theme UI missing '+needle);
}
const accountProfile=await readFile(path.join(ROOT,'netlify','functions','account-profile.mts'),'utf8');
const adminSession=await readFile(path.join(ROOT,'netlify','functions','admin-session.mts'),'utf8');
for(const needle of ['save-appearance-preference','appearance_preference','appearancePreference']){
  if(!accountProfile.includes(needle))failures.push('Account profile theme sync missing '+needle);
}
for(const needle of ['appearance_preference','appearancePreference']){
  if(!adminSession.includes(needle))failures.push('Admin session theme sync missing '+needle);
}

const clientPortal=await readFile(path.join(ROOT,'src','pages','portal','index.astro'),'utf8');
const vendorPortal=await readFile(path.join(ROOT,'src','pages','vendor-portal','index.astro'),'utf8');
const clientPortalApi=await readFile(path.join(ROOT,'netlify','functions','public-client-portal.mts'),'utf8');
const vendorPortalApi=await readFile(path.join(ROOT,'netlify','functions','vendor-portal.mts'),'utf8');
for(const [label,source] of [['client portal',clientPortal],['vendor portal',vendorPortal]]){
  for(const needle of ['data-portal-theme','save-appearance-preference','persist:false']){
    if(!source.includes(needle))failures.push(label+' appearance sync missing '+needle);
  }
}
for(const [label,source] of [['client portal API',clientPortalApi],['vendor portal API',vendorPortalApi]]){
  for(const needle of ['save-appearance-preference','appearancePreference','portalPreferences']){
    if(!source.includes(needle))failures.push(label+' appearance persistence missing '+needle);
  }
}

const intentionalLightSurfaceFiles=new Set([
  'src/pages/admin/email-preview/index.astro',
]);
const rawWhite=/\bbackground(?:-color)?\s*:\s*(?:white\b|#fff(?:fff)?\b|rgba?\(\s*255(?:\s*,|\s+)\s*255(?:\s*,|\s+)\s*255)/i;
const rawBlackText=/\bcolor\s*:\s*(?:black\b|#000(?:000)?\b|rgba?\(\s*0(?:\s*,|\s+)\s*0(?:\s*,|\s+)\s*0)/i;
const rawSurfaceViolations=[];
const rawTextViolations=[];
let bgWhiteUtilities=0;
let bgBlackUtilities=0;
let borderWhiteUtilities=0;
let arbitraryColorUtilities=0;

for(const [file,text] of texts){
  const fileRel=rel(file);
  bgWhiteUtilities+=(text.match(/\bbg-white(?:\/[^\s"'<>]+)?/g)||[]).length;
  bgBlackUtilities+=(text.match(/\bbg-black(?:\/[^\s"'<>]+)?/g)||[]).length;
  borderWhiteUtilities+=(text.match(/\bborder-white(?:\/[^\s"'<>]+)?/g)||[]).length;
  arbitraryColorUtilities+=(text.match(/(?:bg|text|border)-\[(?:#|rgb|hsl|oklch)[^\]]+\]/g)||[]).length;
  text.split(/\r?\n/).forEach((line,index)=>{
    if(rawWhite.test(line)&&!intentionalLightSurfaceFiles.has(fileRel)){
      rawSurfaceViolations.push({file:fileRel,line:index+1,text:line.trim().slice(0,220)});
    }
    if(rawBlackText.test(line)){
      rawTextViolations.push({file:fileRel,line:index+1,text:line.trim().slice(0,220)});
    }
  });
}

const pagesMissingThemeEntry=[];
for(const file of pageFiles){
  const text=texts.get(file)||'';
  if(!text.includes('BaseLayout')&&!text.includes('styles/global.css')){
    pagesMissingThemeEntry.push(rel(file));
  }
}
if(rawSurfaceViolations.length){
  failures.push('Raw white CSS surfaces bypass theme tokens: '+rawSurfaceViolations.slice(0,20).map((row)=>row.file+':'+row.line).join(', '));
}
if(rawTextViolations.length){
  failures.push('Raw black CSS text bypasses theme tokens: '+rawTextViolations.slice(0,20).map((row)=>row.file+':'+row.line).join(', '));
}
if(pagesMissingThemeEntry.length){
  failures.push('Pages missing the shared theme entry: '+pagesMissingThemeEntry.join(', '));
}

await mkdir(OUT,{recursive:true});
const report={
  filesScanned:sourceFiles.length,
  pagesScanned:pageFiles.length,
  bgWhiteUtilities,
  bgBlackUtilities,
  borderWhiteUtilities,
  arbitraryColorUtilities,
  intentionalLightSurfaceFiles:[...intentionalLightSurfaceFiles],
  rawSurfaceViolations,
  rawTextViolations,
  pagesMissingThemeEntry,
  ok:failures.length===0,
  failures,
};
await writeFile(path.join(OUT,'theme-source-audit.json'),JSON.stringify(report,null,2)+'\n');

if(failures.length){
  console.error(JSON.stringify(report,null,2));
  process.exit(1);
}
console.log('PASS | Light / Dark / System bootstrap is wired through BaseLayout and the account menu');
console.log('PASS | public and authenticated admin navbars expose sun/moon quick toggles');
console.log('PASS | every Astro page inherits the shared theme entry');
console.log('PASS | raw white CSS surfaces and raw black text are blocked outside the explicit email-preview exception');
console.log('PASS | theme source audit: '+JSON.stringify({
  filesScanned:report.filesScanned,
  pagesScanned:report.pagesScanned,
  bgWhiteUtilities,
  bgBlackUtilities,
  borderWhiteUtilities,
  arbitraryColorUtilities,
}));
