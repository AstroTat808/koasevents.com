import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { buildCustomerDirectory } from '../netlify/functions/_shared/customer-directory.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = await readFile(new URL('../netlify/functions/admin-crm-customers.mts',import.meta.url),'utf8');
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const tenantId = 'synthetic-tenant';
const one = {
  id:'INQ-ONE',tenantId,kind:'inquiry',stage:'booked',
  customer:{name:'Synthetic Person',email:'person@example.test',phone:'8085551000',eventDate:'2027-03-01'},
  projectName:'Synthetic Wedding',
  booking:{status:'booked', contract:{status:'signed'},payments:[{id:'D1',amount:500,status:'paid',dueDate:'2027-01-01'}]},
  accounting:{quickbooks:{customerId:'qb-synthetic',payments:[{id:'QP1',total:500,txnDate:'2027-01-02'}],invoices:[{invoiceId:'I1',total:3000,balance:2500,docNumber:'1001'}],password:'do-not-return'}},
};
const two = {
  id:'INQ-TWO',tenantId,kind:'inquiry',stage:'proposal',
  customer:{name:'Synthetic Person',email:'person@example.test',phone:'8085551000',eventDate:'2028-06-01'},
  projectName:'Another Event',booking:{status:'pending',payments:[]},accounting:{quickbooks:{payments:[],invoices:[]}},
};
function endpoint(records = [one,two], auth = {tenant:{id:tenantId}}) {
  const calls=[];
  const modules = {
    './_shared/admin': {requireCapability: async name => {calls.push(name);return auth;}},
    './_shared/tenant': {runWithTenant: (_,task)=>task()},
    './_shared/tenant-storage': {
      tenantStoreFor: (_,tenant,domain) => {
        assert.equal(tenant.id,tenantId);
        return {get:async key => key==='notes/index'?[{id:'N1',recordId:one.id}]:key==='tasks/index'?[{id:'T1',recordId:two.id,status:'open'}]:[]};
      },
      readTenantIndex: async (_store,tenant,key) => {
        assert.equal(tenant.id,tenantId);assert.equal(key,'records/index');return {rows:records};
      },
    },
    './_shared/customer-directory.mjs': {buildCustomerDirectory},
  };
  const exports = { };
  const module = {exports};
  new Function('require','module','exports',compiled)(path=>{assert.ok(modules[path],path);return modules[path];},module,exports);
  return {handle:module.exports.default,calls};
}
const cid=buildCustomerDirectory([one,two],{tenantId}).customers[0].id;
test('profile requires crm.view before opening tenant data',async()=>{
  const e=endpoint([one],{response:new Response('Blocked',{status:403})});
  const r=await e.handle(new Request('https://crm.example.test/api/admin/crm-customers?customerId='+cid),{});
  assert.equal(r.status,403);
  assert.deepEqual(e.calls,['crm.view']);
});
test('profile blocks invalid customers and disallows writes',async()=>{
  const e=endpoint();
  assert.equal((await e.handle(new Request('https://crm.example.test/api/admin/crm-customers?customerId=bad'),{})).status,400);
  assert.equal((await e.handle(new Request('https://crm.example.test/api/admin/crm-customers',{method:'POST'}),{})).status,405);
});
test('profile includes every project and separate booking, QuickBooks payments and invoices',async()=>{
  const e=endpoint();
  const r=await e.handle(new Request('https://crm.example.test/api/admin/crm-customers?customerId='+cid),{});
  assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);
  const payload=await r.json();
  assert.equal(payload.customer.projectCount,2);
  assert.equal(payload.projects.length,2);
  const wedding=payload.projects.find(row=>row.id===one.id);
  assert.equal(wedding.booking.payments.length,1);
  assert.equal(wedding.booking.payments[0].amount,500);
  assert.equal(wedding.accounting.payments[0].amount,500);
  assert.equal(wedding.accounting.invoices[0].balance,2500);
  assert.equal(wedding.noteCount,1);
  assert.equal(payload.projects.find(row=>row.id===two.id).openTaskCount,1);
  assert.equal(payload.counts.quickBooksInvoices,1);
  assert.equal(payload.counts.quickBooksPayments,1);
  assert.equal(payload.projects[0].accounting.password,undefined);
  assert.ok(!JSON.stringify(payload).includes('do-not-return'));
});
test('profile never silently falls back to a different customer',async()=>{
  const e=endpoint();
  const r=await e.handle(new Request('https://crm.example.test/api/admin/crm-customers?customerId=CUST-AAAAAAAAAAAAAAAAAAAAAAAA'),{});
  assert.equal(r.status,404);
});
