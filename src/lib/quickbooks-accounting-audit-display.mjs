function clean(value, max = 180) {
  return String(value ?? '').trim().slice(0, max);
}

function finiteMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100) / 100;
}

export function quickBooksAuditEstimateView(row) {
  const estimateId = clean(row?.estimateId, 100);
  const docNumber = clean(row?.estimateDocNumber, 100);
  const linked = Boolean(estimateId);
  const total = linked ? finiteMoney(row?.estimateTotal) : null;
  const label = docNumber
    ? 'Estimate #' + docNumber
    : linked
      ? 'Estimate linked · QBO ID ' + estimateId
      : 'No QBO estimate';

  return {
    linked,
    label,
    total,
    consistent: label !== 'No QBO estimate' || total === null,
  };
}
