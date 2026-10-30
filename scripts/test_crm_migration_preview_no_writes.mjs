import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationPreview } from '../netlify/functions/_shared/customer-identity-workflow.mjs';
const tenantId='synthetic-tenant';
test('migration GET preview uses no-write storage methods and never calls writes or backfill',async()=>{
  const records=[{
    id:'REC-1',tenantId,kind:'inquiry',createdAt:'2026-01-01T00:00:00Z',
    customer:{name:'Synthetic private account',email:'private@example.invalid',phone:'8085550000'},
  }];
  const reads=[];
  const store=(map,label)=>({
    readOnlyJSON:async key=>{reads.push(label+':'+key);return {data:map[key]??null,source:'canonical',etag:null};},
    readJSON:async()=>{throw new Error('write-capable readJSON was called');},
    writeJSON:async()=>{throw new Error('migration preview attempted a write');},
    mirrorJSON:async()=>{throw new Error('migration preview attempted to mirror');},
  });
  const result=await migrationPreview({tenantId,sales:store({'records/index':records},'sales'),crm:store({},'crm')});
  assert.equal(result.plan.assignmentCount,1);
  assert.deepEqual(result.plan.changeType,'assign_missing_customer_id_only');
  assert.equal(result.currentApproval,null);
  assert.deepEqual(result.recentMigrations,[]);
  assert.equal(reads.length,3);
  assert.deepEqual(reads.map(x=>x.split(':')[0]),['sales','crm','crm']);
  assert.equal(records[0].customerId,undefined);
});
