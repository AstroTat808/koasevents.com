function clean(value, max = 400) {
  return String(value ?? '').trim().slice(0, max);
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function buildQuickBooksEstimateLines(record, itemId) {
  const proposal = record?.proposal || {};
  const raw = Array.isArray(proposal.lineItems) ? proposal.lineItems : [];
  const lines = raw.length ? raw.map((line) => {
    const qty = Math.max(1, Number(line?.quantity || 1));
    const amount = Number(line?.amount || (qty * Number(line?.unitPrice || 0)) || 0);
    const mappedItemId = clean(line?.quickBooksItemId, 80) || itemId;
    return {
      Amount: money(amount),
      DetailType: 'SalesItemLineDetail',
      Description: clean(line?.description, 400),
      SalesItemLineDetail: {
        ItemRef: { value: mappedItemId },
        Qty: qty,
        UnitPrice: qty ? money(amount / qty) : money(amount),
        TaxCodeRef: { value: 'NON' },
      },
    };
  }) : [{
    Amount: money(proposal.subtotal || proposal.total || 0),
    DetailType: 'SalesItemLineDetail',
    Description: 'CRM proposal ' + clean(record?.id, 120),
    SalesItemLineDetail: {
      ItemRef: { value: itemId },
      Qty: 1,
      UnitPrice: money(proposal.subtotal || proposal.total || 0),
      TaxCodeRef: { value: 'NON' },
    },
  }];

  const taxAmount = Math.max(0, Number(proposal.taxAmount || 0));
  if (taxAmount > 0) {
    lines.push({
      Amount: money(taxAmount),
      DetailType: 'SalesItemLineDetail',
      Description: clean(proposal.taxLabel || 'Tax', 400),
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: 1,
        UnitPrice: money(taxAmount),
        TaxCodeRef: { value: 'NON' },
      },
    });
  }
  return lines;
}

export function summarizeQuickBooksEstimateLines(lines) {
  const rows = Array.isArray(lines) ? lines : [];
  return rows.reduce((summary, line) => {
    const amount = money(line?.Amount || 0);
    const nonTaxable = String(line?.SalesItemLineDetail?.TaxCodeRef?.value || '').toUpperCase() === 'NON';
    summary.lineTotal = money(summary.lineTotal + amount);
    if (nonTaxable) summary.nonTaxableTotal = money(summary.nonTaxableTotal + amount);
    else summary.taxableTotal = money(summary.taxableTotal + amount);
    return summary;
  }, { lineTotal: 0, taxableTotal: 0, nonTaxableTotal: 0 });
}

export function quickBooksEstimateLineFingerprint(lines) {
  return JSON.stringify((Array.isArray(lines) ? lines : []).map((line) => ({
    description: clean(line?.Description ?? line?.description, 400).toLowerCase(),
    quantity: Number(line?.SalesItemLineDetail?.Qty ?? line?.quantity ?? 1),
    unitPrice: money(line?.SalesItemLineDetail?.UnitPrice ?? line?.unitPrice ?? 0),
    amount: money(line?.Amount ?? line?.amount ?? 0),
    itemId: clean(line?.SalesItemLineDetail?.ItemRef?.value ?? line?.itemId, 80),
    taxCode: clean(line?.SalesItemLineDetail?.TaxCodeRef?.value ?? line?.taxCode, 40).toUpperCase(),
  })));
}
