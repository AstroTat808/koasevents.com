import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { buildIdentityMigrationPlan, IdentityMigrationError } from '../netlify/functions/_shared/customer-identity-migration.mjs';
import { migrationAction, migrationPreview } from '../netlify/functions/_shared/customer-identity-workflow.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source=await readFile(new URL('../netlify/functions/admin-crm-customer-migration.mts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const tenantId='synthetic-tenant';
const records=[{id:'INQ-A',tenantId,kind:'inquiry',stage:'booked',
  customer:{name:'Synthetic Client',email:'synthetic@example.test',phone:'8085551111',eventDate:'2027-01-01'},
  booking:{payments:[{amount:500}]},accounting:{quickbooks:{customerId:'qb-synthetic'}}}];
class Store{
  constructor(values={}){this.data=new Map(Object.entries(values).map(([key,value])=>[key,{data:structuredClone(value),etag:'1'}]));}
  async readJSON(key){return structuredClone(this.data.get(key)||{data:null,etag:null});}
  async writeJSON(key,value,etag){
    const before=this.data.get(key);
    if((before?.etag||null)!==etag)return {modified:false};
    this.data.set(key,{data:structuredClone(value),etag:String(Number(before?.etag||'0')+1)});
    return {modified:true};
  }
  async mirrorJSON(){return true;}
}
function endpoint(auth={user:{id:'admin-A'},tenant:{id:tenantId}},currentRecords=records){
  const sales=new Store({'records/index':currentRecords,...Object.fromEntries(currentRecords.map(r=>['records/'+r.id,r]))});
  const crm=new Store();const requested=[];
  const modules={
    './_shared/admin':{
      requireAdmin:async()=>{requested.push('admin');return auth;},
      requireCapability:async permission=>{requested.push(permission);return auth;}},
    './_shared/tenant':{runWithTenant:(_,fn)=>fn()},
    './_shared/tenant-storage':{conditionalTenantStoreFor:(_,tenant,domain)=>{assert.equal(tenant.id,tenantId);return domain==='sales'?sales:crm;}},
    './_shared/customer-identity-migration.mjs':{IdentityMigrationError},
    './_shared/customer-identity-workflow.mjs':{migrationPreview,migrationAction},
  };
  const module={exports:{}};
  new Function('require','module','exports',compiled)(name=>{assert.ok(modules[name],name);return modules[name];},module,module.exports);
  return {handle:module.exports.default,requested,sales,crm};
}
function call(action,planId,options={}){
  return new Request('https://crm.example.test/api/admin/crm-customer-migration',{
    method:'POST',headers:{origin:'https://crm.example.test','content-type':'application/json',...options.headers},
    body:typeof options.body==='string'?options.body:JSON.stringify({action,planId,confirmation:action.toUpperCase(),...options.body}),
  });
}
test('GET migration preview requires staff crm.view and remains read-only',async()=>{
  const e=endpoint();
  const response=await e.handle(new Request('https://crm.example.test/api/admin/crm-customer-migration'),{});
  assert.equal(response.status,200);assert.deepEqual(e.requested,['crm.view']);
  assert.equal((await response.json()).plan.assignmentCount,1);
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal((await e.sales.readJSON('records/index')).data[0].customerId,undefined);
});
test('POST requires administrator privileges before accessing storage',async()=>{
  const e=endpoint({response:new Response('Blocked',{status:403})});
  const response=await e.handle(call('propose','CIM-AAAAAAAAAAAAAAAAAAAAAAAA'),{});
  assert.equal(response.status,403);assert.deepEqual(e.requested,['admin']);
});
test('rejects CSRF origins, non-JSON and missing explicit confirmations',async()=>{
  const e=endpoint();const id=buildIdentityMigrationPlan(records,tenantId).planId;
  assert.equal((await e.handle(call('propose',id,{headers:{origin:'https://other.example.test'}}),{})).status,403);
  assert.equal((await e.handle(call('propose',id,{headers:{'content-type':'text/plain'}}),{})).status,415);
  assert.equal((await e.handle(call('propose',id,{body:{confirmation:'something-else'}}),{})).status,422);
  assert.equal((await e.handle(call('propose',id,{body:'{bad'}),{})).status,400);
});
test('two-admin approval and rollback retain signed records and payment history',async()=>{
  const e=endpoint();const id=buildIdentityMigrationPlan(records,tenantId).planId;
  const proposed=await e.handle(call('propose',id),{});
  assert.equal(proposed.status,200);assert.equal((await proposed.json()).approval.status,'proposed');
  const rejected=await e.handle(call('approve',id),{});
  assert.equal(rejected.status,409);assert.equal((await rejected.json()).code,'second_approver_required');
  const second=endpoint({user:{id:'admin-B'},tenant:{id:tenantId}});
  // Reuse the same underlying tenant stores while supplying a distinct authenticated actor.
  const module={exports:{}};
  const modules={
    './_shared/admin':{requireAdmin:async()=>({user:{id:'admin-B'},tenant:{id:tenantId}}),
      requireCapability:async()=>({user:{id:'admin-B'},tenant:{id:tenantId}})},
    './_shared/tenant':{runWithTenant:(_,fn)=>fn()},
    './_shared/tenant-storage':{conditionalTenantStoreFor:(_,tenant,domain)=>{assert.equal(tenant.id,tenantId);return domain==='sales'?e.sales:e.crm;}},
    './_shared/customer-identity-migration.mjs':{IdentityMigrationError},
    './_shared/customer-identity-workflow.mjs':{migrationPreview,migrationAction},
  };
  new Function('require','module','exports',compiled)(name=>modules[name],module,module.exports);
  const secondHandle=module.exports.default;
  assert.equal((await secondHandle(call('approve',id),{})).status,200);
  assert.equal((await secondHandle(call('apply',id),{})).status,200);
  const after=(await e.sales.readJSON('records/index')).data[0];
  assert.ok(after.customerId);
  assert.deepEqual(after.booking,records[0].booking);
  assert.deepEqual(after.accounting,records[0].accounting);
  assert.equal((await secondHandle(call('rollback',id),{})).status,200);
  assert.deepEqual((await e.sales.readJSON('records/index')).data,records);
});
