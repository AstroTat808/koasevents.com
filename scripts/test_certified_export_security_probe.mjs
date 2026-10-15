#!/usr/bin/env node
import assert from 'node:assert/strict';
import { verifyCertifiedExportNegativeProbes } from '../netlify/functions/_shared/certified-export-security-probe.mjs';
const result=verifyCertifiedExportNegativeProbes();
assert.equal(result.ok,true,'Both PDF and JSON must reject every uncertified synthetic release.');
assert.equal(result.denied,result.expected,'All synthetic negative fixtures must be rejected.');
assert.deepEqual(result.formats,['json','pdf']);
console.log('PASS | production export-security contract: '+result.denied+' rejected synthetic PDF/JSON export attempts.');
