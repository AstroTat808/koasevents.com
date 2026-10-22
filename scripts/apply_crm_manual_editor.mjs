// One-time integration on the feature branch. Every replacement is exact and fails closed.
import { readFileSync, writeFileSync } from 'node:fs';
function patch(path, changes) {
  let source = readFileSync(path, 'utf8');
  for (const [before, after] of changes) {
    if (source.split(before).length !== 2) throw new Error('Integration anchor must occur exactly once in ' + path + ': ' + before.slice(0, 90));
    source = source.replace(before, after);
  }
  writeFileSync(path, source);
}
const bridge = `  // Reuse the existing CRM record model rather than creating a duplicate contact database.
  function publishRecordEditorContext(){
    window.dispatchEvent(new CustomEvent('koa:crm-editor-context',{detail:{projects:data.projects,canManage:can('crm.manage'),selectedId}}));
  }
  window.addEventListener('koa:crm-editor-ready',publishRecordEditorContext);
  window.addEventListener('koa:crm-record-saved',async(event)=>{
    const recordId=String(event.detail?.recordId||'');
    if(!recordId)return;
    selectedId=recordId;
    const url=new URL(window.location.href);url.searchParams.set('record',recordId);window.history.replaceState(null,'',url);
    const search=$('[data-search]');if(search)search.value='';
    for(const selector of ['[data-stage-filter]','[data-business-line-filter]','[data-qualification-filter]','[data-complexity-filter]','[data-task-filter]','[data-review-filter]']){
      const filter=$(selector);if(filter)filter.value='all';
    }
    try{
      if(!await load()||!data.projects.some((p)=>p.id===recordId))throw new Error('Refresh not confirmed');
      window.dispatchEvent(new CustomEvent('koa:crm-editor-refreshed'));
      $('[data-detail]')?.scrollIntoView({behavior:'auto',block:'start'});
    }catch{window.dispatchEvent(new CustomEvent('koa:crm-editor-refresh-failed'));}
  });
`;
const editButtons = `                  <button type="button" hidden data-crm-record-action="update-customer" class="rounded-full border border-white/40 px-4 py-3 text-xs font-bold text-white">Edit customer</button>
                  <button type="button" hidden data-crm-record-action="update-project" class="rounded-full border border-white/40 px-4 py-3 text-xs font-bold text-white">Edit project</button>
`;
patch('src/pages/admin/crm/index.astro', [
  ["import BaseLayout from '../../../layouts/BaseLayout.astro';", "import BaseLayout from '../../../layouts/BaseLayout.astro';\nimport CrmRecordEditor from '../../../components/admin/CrmRecordEditor.astro';"],
  ['      <div data-admin-ui class="hidden grid gap-6">', '      <div data-admin-ui class="hidden grid gap-6">\n        <CrmRecordEditor />'],
  ['                  <div data-detail-links class="flex flex-wrap gap-2"></div>','                  <div data-detail-links class="flex flex-wrap gap-2"></div>\n'+editButtons.trimEnd()],
  ['  function can(permission){', bridge+'  function can(permission){'],
  ['  function render(){', '  function render(){\n    publishRecordEditorContext();'],
  ['  function renderDetail(){', '  function renderDetail(){\n    publishRecordEditorContext();'],
  ["  function projectText(p){ return [p.customer?.name,", "  function projectText(p){ return [p.projectName,p.customer?.name,"],
  ["$('[data-detail-name]').textContent=p.customer?.name||'Unnamed client';", "$('[data-detail-name]').textContent=p.projectName||p.customer?.name||'Unnamed client';"],
  ["$('[data-detail-contact]').textContent=[p.customer?.email,p.customer?.phone]", "$('[data-detail-contact]').textContent=[p.projectName?p.customer?.name:'',p.customer?.email,p.customer?.phone]"],
  ["esc(p.customer?.eventDate||'No date')+'", "esc(p.projectName||'')+(p.projectName?' - ':'')+esc(p.customer?.eventDate||'No date')+'"],
  ["    if(r.status===401)return false;", "    if(r.status===401){window.dispatchEvent(new CustomEvent('koa:crm-editor-context',{detail:{canManage:false}}));return false;}"],
  ["    if(r.status===403){", "    if(r.status===403){\n      window.dispatchEvent(new CustomEvent('koa:crm-editor-context',{detail:{canManage:false}}));"],
]);
patch('netlify/functions/admin-crm.mts', [
  ['    id: record.id,\n    kind:', "    id: record.id,\n    projectName: record.projectName || '',\n    kind:"],
]);
patch('netlify/functions/_shared/crm-cleanup.ts', [
  ["  const protectedRecord=kind===", "  // Staff-entered records may be reviewed, but automatic cleanup must not discard them.\n  const staffEntered=record?.source==='crm-manual-entry' && Boolean(record?.createdBy) && Array.isArray(record?.crmManualHistory) && record.crmManualHistory.some((entry:any)=>entry?.actor===record.createdBy && ['create-customer','create-project'].includes(entry?.action));\n  const protectedRecord=staffEntered||kind==="],
]);
const storagePath = 'netlify/functions/_shared/tenant-storage.ts';
const storage = readFileSync(storagePath, 'utf8');
if (storage.includes('export function conditionalTenantStoreFor')) throw new Error('Conditional storage adapter already exists.');
writeFileSync(storagePath, storage + readFileSync('scripts/crm_conditional_storage.fragment.txt', 'utf8'));
console.log('CRM editor integrated into the existing page, API projection and tenant-scoped storage.');
