import test from 'node:test';
import assert from 'node:assert/strict';
import { controlledEmailQaRecipient } from '../netlify/functions/_shared/email-production-recipient.mjs';

const koa = { id:'koa-events', bootstrapAdminEmails:['internal-owner@approved.example','internal-staff@approved.example'] };
const other = { id:'another-tenant', bootstrapAdminEmails:['other-admin@approved.example'] };
test('production logo QA is routed only to approved Koa bootstrap admin if no configured target', () => {
  assert.equal(controlledEmailQaRecipient(koa,''),'internal-owner@approved.example');
  assert.equal(controlledEmailQaRecipient(koa,null),'internal-owner@approved.example');
});
test('an explicitly configured recipient takes precedence when valid', () => {
  assert.equal(controlledEmailQaRecipient(koa,' VerifiedQA@approved.example '),'verifiedqa@approved.example');
});
test('invalid explicit recipients never silently fall back to another inbox', () => {
  assert.equal(controlledEmailQaRecipient(koa,'invalid-not-email'),'');
  assert.equal(controlledEmailQaRecipient(koa,'invalid @example.com'),'');
});
test('multi-tenant safety blocks implicit recipients outside the original organization', () => {
  assert.equal(controlledEmailQaRecipient(other,''),'');
  assert.equal(controlledEmailQaRecipient({id:'koa-events',bootstrapAdminEmails:[]},''),'');
});
