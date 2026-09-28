import assert from 'node:assert/strict';
import {
  evaluateInvoiceRepairCandidate,
  invoicePaymentProtection,
} from '../netlify/functions/_shared/quickbooks-accounting-repair-safety.mjs';

const line=(id='1')=>({id,description:'Milestone',amount:1200,itemId:'257'});

const unpaid=evaluateInvoiceRepairCandidate(
  {invoiceId:'U1',total:1500,balance:1500,lines:[line()]},
  {id:'pay-1',amount:1200},
);
assert.equal(unpaid.eligible,true,'Fully unpaid one-line milestone invoice should be repairable.');
assert.equal(unpaid.code,'invoice_unpaid_safe');
assert.equal(unpaid.protection.paidAmount,0);

const partial=evaluateInvoiceRepairCandidate(
  {invoiceId:'P1',total:1500,balance:900,lines:[line()]},
  {id:'pay-1',amount:1200},
);
assert.equal(partial.eligible,false,'Partially paid invoice must not be repairable.');
assert.equal(partial.code,'invoice_partially_paid_protected');
assert.equal(partial.protection.paidAmount,600);

const paid=evaluateInvoiceRepairCandidate(
  {invoiceId:'F1',total:1500,balance:0,lines:[line()]},
  {id:'pay-1',amount:1200},
);
assert.equal(paid.eligible,false,'Paid invoice must not be repairable.');
assert.equal(paid.code,'invoice_paid_protected');
assert.equal(paid.protection.paidAmount,1500);

const orphan=evaluateInvoiceRepairCandidate(
  {invoiceId:'O1',total:1500,balance:1500,lines:[line()]},
  null,
);
assert.equal(orphan.eligible,false,'Orphan invoice must not be repairable.');
assert.equal(orphan.code,'invoice_orphan');

const multi=evaluateInvoiceRepairCandidate(
  {invoiceId:'M1',total:1500,balance:1500,lines:[line('1'),line('2')]},
  {id:'pay-1',amount:1200},
);
assert.equal(multi.eligible,false,'Multi-line invoice must not be repairable.');
assert.equal(multi.code,'invoice_structure_protected');
assert.equal(multi.salesLineCount,2);

const qboShape=invoicePaymentProtection({TotalAmt:500,Balance:125});
assert.equal(qboShape.state,'partially_paid','Live QuickBooks invoice shape must use the same protection logic.');
assert.equal(qboShape.paidAmount,375);

console.log('Invoice repair safety tests passed: unpaid editable; partial, paid, orphan, and multi-line invoices protected.');
