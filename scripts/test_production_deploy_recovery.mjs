import assert from 'node:assert/strict';
import { productionDeployDisposition as classify } from '../netlify/functions/_shared/production-deploy-recovery.mjs';

assert.equal(classify(null),'absent');
for (const state of ['ready','current'])
  assert.equal(classify({state}),'ready',state);
for (const state of ['new','pending','queued','enqueued','building','preparing','prepared','processing','uploading','uploaded','pending_review'])
  assert.equal(classify({state}),'in-progress',state);
for (const state of ['error','failed','cancelled','canceled'])
  assert.equal(classify({state}),'failed',state);
for (const state of ['',undefined,'mystery'])
  assert.equal(classify({state}),'unknown',String(state));
assert.equal(classify({state:' ERROR '}),'failed','case/space normalization');
console.log('PASS | ready/in-progress/failed production deploy disposition is fail-closed and does not accept errored deploys.');
