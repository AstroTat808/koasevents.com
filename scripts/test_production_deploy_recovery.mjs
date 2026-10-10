import assert from 'node:assert/strict';
import { planProductionDeployRecovery as plan, productionDeployDisposition as classify } from '../netlify/functions/_shared/production-deploy-recovery.mjs';

assert.equal(classify(null), 'absent');
for (const state of ['ready', 'current']) assert.equal(classify({state}), 'ready', state);
for (const state of ['new','pending','queued','enqueued','building','preparing','prepared','processing','uploading','uploaded','pending_review'])
  assert.equal(classify({state}), 'in-progress', state);
for (const state of ['error','failed','cancelled','canceled'])
  assert.equal(classify({state}), 'failed', state);
for (const state of ['', 'unrecognized', undefined]) assert.equal(classify({state}), 'unknown', String(state));
assert.equal(classify({state:' ERROR '}), 'failed');

assert.equal(plan([]).action, 'rebuild');
assert.equal(plan(null).action, 'block');
assert.equal(plan([{id:'a',state:'error'}]).action, 'rebuild');
assert.equal(plan([{id:'a',state:'error'},{id:'b',state:'error'}]).action, 'block');
assert.equal(plan([{id:'a',state:'error'},{id:'b',state:'failed'}]).reason, 'automatic-retry-limit-reached');
assert.equal(plan([{id:'a',state:'error'},{id:'b',state:'building'}]).action, 'reuse');
assert.equal(plan([{id:'a',state:'error'},{id:'b',state:'building'}]).deploy.id, 'b');
assert.equal(plan([{id:'a',state:'error'},{id:'b',state:'ready'}]).action, 'reuse');
assert.equal(plan([{id:'a',state:'error'},{id:'b',state:'ready'}]).deploy.id, 'b');
assert.equal(plan([{id:'a',state:'error'},{id:'b',state:'mystery'}]).action, 'block');
assert.equal(plan([{id:'a',state:'ready'},{id:'b',state:'mystery'}]).action, 'reuse');
console.log('PASS | exact-SHA recovery rejects terminal and unknown states, limits automatic retries, and reuses active builds.');
