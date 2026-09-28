function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function invoicePaymentProtection(entry = {}) {
  const total = money(entry?.total ?? entry?.amount ?? entry?.TotalAmt ?? 0);
  const balance = money(entry?.balance ?? entry?.Balance ?? total);
  const paidAmount = Math.max(0, money(total - balance));
  if (paidAmount <= 0.005) return { protected:false, state:'unpaid', total, balance, paidAmount };
  if (balance <= 0.005) return { protected:true, state:'paid', total, balance, paidAmount };
  return { protected:true, state:'partially_paid', total, balance, paidAmount };
}

function invoiceSalesLines(invoice = {}) {
  if (Array.isArray(invoice?.lines)) return invoice.lines;
  return (Array.isArray(invoice?.Line) ? invoice.Line : [])
    .filter((line) => line?.DetailType === 'SalesItemLineDetail');
}

export function evaluateInvoiceRepairCandidate(invoice = {}, milestone = null) {
  const protection = invoicePaymentProtection(invoice);
  if (!milestone) {
    return {
      eligible:false,
      needsRepair:true,
      code:'invoice_orphan',
      protection,
      salesLineCount:invoiceSalesLines(invoice).length,
      reason:'No CRM payment milestone matches this invoice, so Accounting Repair will not infer a replacement amount.',
    };
  }

  const expectedAmount = money(milestone?.amount || 0);
  if (Math.abs(money(protection.total - expectedAmount)) < 0.01) {
    return {
      eligible:false,
      needsRepair:false,
      code:'invoice_reconciled',
      protection,
      expectedAmount,
      salesLineCount:invoiceSalesLines(invoice).length,
      reason:'Invoice total already matches the CRM milestone.',
    };
  }

  if (protection.protected) {
    return {
      eligible:false,
      needsRepair:true,
      code:protection.state === 'paid' ? 'invoice_paid_protected' : 'invoice_partially_paid_protected',
      protection,
      expectedAmount,
      salesLineCount:invoiceSalesLines(invoice).length,
      reason:protection.state === 'paid'
        ? 'This invoice is paid. Accounting Repair never changes a paid invoice.'
        : 'This invoice has received $' + protection.paidAmount.toFixed(2) + '. Accounting Repair never changes a partially paid invoice.',
    };
  }

  const salesLineCount = invoiceSalesLines(invoice).length;
  if (salesLineCount !== 1) {
    return {
      eligible:false,
      needsRepair:true,
      code:'invoice_structure_protected',
      protection,
      expectedAmount,
      salesLineCount,
      reason:'Automatic repair only changes one-line CRM milestone invoices. This invoice has ' + salesLineCount + ' sales lines.',
    };
  }

  return {
    eligible:true,
    needsRepair:true,
    code:'invoice_unpaid_safe',
    protection,
    expectedAmount,
    salesLineCount,
    reason:'Invoice is fully unpaid, mapped to a CRM milestone, and has exactly one sales line.',
  };
}
