// Release marker: QuickBooks preview audit export and targeted rollback.
function clean(value: unknown, max = 12000) {
  return String(value ?? '').trim().slice(0, max);
}

function csvCell(value: unknown) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return '"' + String(text).replace(/"/g, '""') + '"';
}

function json(value: unknown) {
  return value == null ? '' : JSON.stringify(value);
}

function auditRows(preview: any) {
  const rows: Record<string, unknown>[] = [];
  const summary = preview?.summary || {};
  rows.push({
    section: 'preview',
    rowType: 'summary',
    previewId: clean(preview?.previewId, 120),
    generatedAt: clean(preview?.generatedAt, 80),
    actor: clean(preview?.actor, 180),
    qboCustomers: Number(summary.qboCustomers || 0),
    qboEstimates: Number(summary.qboEstimates || 0),
    qboInvoices: Number(summary.qboInvoices || 0),
    qboPayments: Number(summary.qboPayments || 0),
    activeSyncCustomers: Number(summary.activeSyncCustomers || 0),
    excludedCustomers: Number(summary.excludedCustomers || 0),
    suggestedExclusions: Number(summary.suggestedExclusions || 0),
    newImports: Number(summary.newImports || 0),
    matched: Number(summary.matched || 0),
    linked: Number(summary.linked || 0),
    needsDecision: Number(summary.needsDecision || 0),
    duplicateFlags: Number(summary.duplicateFlags || 0),
    bulkEligibleNewImports: Number(summary.bulkEligibleNewImports || 0),
    needsIndividualReview: Number(summary.needsIndividualReview || 0),
    crmOutboundActions: Number(summary.crmOutboundActions || 0),
  });

  for (const plan of Array.isArray(preview?.customerPlans) ? preview.customerPlans : []) {
    const f = plan?.financial || {};
    rows.push({
      section: 'customer',
      rowType: 'customer_plan',
      customerId: clean(plan?.customerId, 120),
      customerName: clean(plan?.qbo?.name, 240),
      email: clean(plan?.qbo?.email, 240),
      phone: clean(plan?.qbo?.phone, 100),
      eventDate: clean(plan?.qbo?.eventDate, 40),
      decision: clean(plan?.decision, 60),
      action: clean(plan?.action, 60),
      reason: clean(plan?.reason, 500),
      duplicateRiskLevel: clean(plan?.duplicateRisk?.level, 40),
      duplicateRiskScore: Number(plan?.duplicateRisk?.score || 0),
      duplicateRiskSignals: (Array.isArray(plan?.duplicateRisk?.signals) ? plan.duplicateRisk.signals : []).map((value: any) => clean(value,80)).join(' | '),
      bulkEligible: Boolean(plan?.bulkEligible),
      exclusionReasonCode: clean(plan?.exclusion?.reasonCode, 80),
      exclusionReasonLabel: clean(plan?.exclusion?.reasonLabel, 120),
      exclusionReason: clean(plan?.exclusion?.reason, 500),
      suggestedExclusionCode: clean(plan?.suggestedExclusion?.code, 80),
      suggestedExclusionLabel: clean(plan?.suggestedExclusion?.label, 120),
      suggestedExclusionConfidence: clean(plan?.suggestedExclusion?.confidence, 40),
      suggestedExclusionReason: clean(plan?.suggestedExclusion?.reason, 500),
      suggestedExclusionEvidence: (Array.isArray(plan?.suggestedExclusion?.evidence) ? plan.suggestedExclusion.evidence : []).map((value: any) => clean(value,120)).join(' | '),
      crmRecordId: clean(plan?.matchedRecordId, 120),
      predictedRecordId: clean(plan?.predictedRecordId, 120),
      candidateRecordIds: (Array.isArray(plan?.candidates) ? plan.candidates : []).map((row: any) => clean(row?.recordId, 120)).filter(Boolean).join(' | '),
      estimateCount: Number(f.estimates || 0),
      estimateTotal: Number(f.estimateTotal || 0),
      invoiceCount: Number(f.invoices || 0),
      invoiceTotal: Number(f.invoiceTotal || 0),
      openBalance: Number(f.openBalance || 0),
      paymentCount: Number(f.payments || 0),
      paymentTotal: Number(f.paymentTotal || 0),
      crmBefore: json(plan?.before),
      projectedAfter: json(plan?.after),
    });

    for (const candidate of Array.isArray(plan?.candidates) ? plan.candidates : []) {
      rows.push({
        section: 'customer',
        rowType: 'candidate',
        customerId: clean(plan?.customerId, 120),
        customerName: clean(plan?.qbo?.name, 240),
        decision: clean(plan?.decision, 60),
        crmRecordId: clean(candidate?.recordId, 120),
        candidateName: clean(candidate?.name, 240),
        candidateEmail: clean(candidate?.email, 240),
        candidatePhone: clean(candidate?.phone, 100),
        candidateEventDate: clean(candidate?.eventDate, 40),
        candidateStage: clean(candidate?.stage, 80),
        currentQuickBooksCustomerId: clean(candidate?.currentQuickBooksCustomerId, 120),
        candidateRiskLevel: clean(candidate?.riskLevel, 40),
        candidateScore: Number(candidate?.score || 0),
        candidateSignals: (Array.isArray(candidate?.signals) ? candidate.signals : []).map((value: any) => clean(value,80)).join(' | '),
        reason: clean(candidate?.reason, 500),
      });
    }

    for (const doc of Array.isArray(f.estimateDocs) ? f.estimateDocs : []) {
      rows.push({
        section: 'estimate',
        rowType: 'estimate',
        customerId: clean(plan?.customerId, 120),
        customerName: clean(plan?.qbo?.name, 240),
        documentId: clean(doc?.id, 120),
        documentNumber: clean(doc?.docNumber, 120),
        txnDate: clean(doc?.txnDate, 40),
        total: Number(doc?.total || 0),
        emailStatus: clean(doc?.emailStatus, 80),
      });
    }
    for (const doc of Array.isArray(f.invoiceDocs) ? f.invoiceDocs : []) {
      rows.push({
        section: 'invoice',
        rowType: 'invoice',
        customerId: clean(plan?.customerId, 120),
        customerName: clean(plan?.qbo?.name, 240),
        documentId: clean(doc?.id, 120),
        documentNumber: clean(doc?.docNumber, 120),
        txnDate: clean(doc?.txnDate, 40),
        dueDate: clean(doc?.dueDate, 40),
        total: Number(doc?.total || 0),
        balance: Number(doc?.balance || 0),
        emailStatus: clean(doc?.emailStatus, 80),
      });
    }
    for (const doc of Array.isArray(f.paymentDocs) ? f.paymentDocs : []) {
      rows.push({
        section: 'payment',
        rowType: 'payment',
        customerId: clean(plan?.customerId, 120),
        customerName: clean(plan?.qbo?.name, 240),
        documentId: clean(doc?.id, 120),
        txnDate: clean(doc?.txnDate, 40),
        total: Number(doc?.total || 0),
      });
    }
  }

  for (const outbound of Array.isArray(preview?.outbound) ? preview.outbound : []) {
    for (const action of Array.isArray(outbound?.actions) ? outbound.actions : []) {
      rows.push({
        section: 'crm_to_quickbooks',
        rowType: 'outbound_action',
        crmRecordId: clean(outbound?.recordId, 120),
        customerName: clean(outbound?.name, 240),
        customerId: clean(outbound?.customerId, 120),
        estimateId: clean(outbound?.estimateId, 120),
        actionType: clean(action?.type, 80),
        action: clean(action?.action, 80),
        field: clean(action?.field, 120),
        reason: clean(action?.reason, 500),
        before: json(action?.before),
        after: json(action?.after),
      });
    }
  }

  return rows;
}

export function buildQuickBooksCrmPreviewCsv(preview: any) {
  const rows = auditRows(preview);
  const headers = [
    'section','rowType','previewId','generatedAt','actor',
    'customerId','customerName','email','phone','eventDate',
    'decision','action','reason','duplicateRiskLevel','duplicateRiskScore','duplicateRiskSignals','bulkEligible',
    'exclusionReasonCode','exclusionReasonLabel','exclusionReason','suggestedExclusionCode','suggestedExclusionLabel','suggestedExclusionConfidence','suggestedExclusionReason','suggestedExclusionEvidence',
    'crmRecordId','predictedRecordId','candidateRecordIds',
    'candidateName','candidateEmail','candidatePhone','candidateEventDate','candidateStage','currentQuickBooksCustomerId','candidateRiskLevel','candidateScore','candidateSignals',
    'estimateCount','estimateTotal','invoiceCount','invoiceTotal','openBalance','paymentCount','paymentTotal',
    'documentId','documentNumber','txnDate','dueDate','total','balance','emailStatus',
    'estimateId','actionType','field','before','after','crmBefore','projectedAfter',
    'qboCustomers','qboEstimates','qboInvoices','qboPayments','activeSyncCustomers','excludedCustomers','suggestedExclusions','newImports','matched','linked','needsDecision','duplicateFlags','bulkEligibleNewImports','needsIndividualReview','crmOutboundActions',
  ];
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(',')),
  ];
  return '\uFEFF' + lines.join('\r\n');
}

function pdfAscii(value: unknown) {
  return String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2192/g, '->')
    .replace(/\u00A0/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E\n\r\t]/g, '?');
}

function pdfEscape(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapText(value: unknown, width = 96) {
  const source = pdfAscii(value).replace(/\r/g, '');
  const output: string[] = [];
  for (const paragraph of source.split('\n')) {
    if (!paragraph) {
      output.push('');
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > width) {
      let split = remaining.lastIndexOf(' ', width);
      if (split < Math.floor(width * 0.55)) split = width;
      output.push(remaining.slice(0, split));
      remaining = remaining.slice(split).trimStart();
    }
    output.push(remaining);
  }
  return output;
}

type PdfLine = { text: string; size?: number; bold?: boolean; indent?: number; gapBefore?: number };

function previewPdfLines(preview: any) {
  const lines: PdfLine[] = [];
  const summary = preview?.summary || {};
  const push = (text: unknown, options: Omit<PdfLine,'text'> = {}) => lines.push({ text:pdfAscii(text), ...options });
  const section = (title: string) => push(title, { size:12, bold:true, gapBefore:10 });
  const detail = (label: string, value: unknown, indent = 0) => {
    const wrapped = wrapText(label + ': ' + (value == null || value === '' ? '-' : value), 94 - Math.floor(indent / 4));
    wrapped.forEach((text, index) => push(text, { size:8.5, indent:index ? indent + 10 : indent }));
  };
  const jsonBlock = (label: string, value: unknown) => {
    push(label, { size:8.5, bold:true, indent:12, gapBefore:4 });
    const pretty = value == null ? 'null' : JSON.stringify(value, null, 2);
    wrapText(pretty, 88).forEach((text) => push(text, { size:7.2, indent:22 }));
  };

  push('QuickBooks <-> CRM Preview Sync Audit', { size:17, bold:true });
  detail('Preview ID', preview?.previewId);
  detail('Generated', preview?.generatedAt);
  detail('Prepared by', preview?.actor);
  detail('Expires', preview?.expiresAt);

  section('Summary');
  detail('QuickBooks customers', summary.qboCustomers);
  detail('Estimates', summary.qboEstimates);
  detail('Invoices', summary.qboInvoices);
  detail('Payments', summary.qboPayments);
  detail('Active sync customers', summary.activeSyncCustomers);
  detail('Excluded customers', summary.excludedCustomers);
  detail('Suggested exclusions', summary.suggestedExclusions);
  detail('New CRM imports', summary.newImports);
  detail('Matched', summary.matched);
  detail('Already linked', summary.linked);
  detail('Needs decision', summary.needsDecision);
  detail('Duplicate / review flags', summary.duplicateFlags);
  detail('Bulk-eligible new imports', summary.bulkEligibleNewImports);
  detail('Individual-review rows', summary.needsIndividualReview);
  detail('CRM -> QuickBooks actions', summary.crmOutboundActions);

  section('Customer review');
  for (const plan of Array.isArray(preview?.customerPlans) ? preview.customerPlans : []) {
    push((plan?.qbo?.name || 'Unnamed customer') + ' | QBO #' + clean(plan?.customerId, 120), { size:10.5, bold:true, gapBefore:8 });
    detail('Email', plan?.qbo?.email, 12);
    detail('Phone', plan?.qbo?.phone, 12);
    detail('Event date', plan?.qbo?.eventDate, 12);
    detail('Decision', plan?.decision, 12);
    detail('Planned action', plan?.action, 12);
    detail('Reason', plan?.reason, 12);
    detail('Duplicate risk', [plan?.duplicateRisk?.level, plan?.duplicateRisk?.score ? 'score ' + plan.duplicateRisk.score : '', ...(Array.isArray(plan?.duplicateRisk?.signals) ? plan.duplicateRisk.signals : [])].filter(Boolean).join(' | '), 12);
    detail('Bulk eligible', plan?.bulkEligible ? 'Yes - low-risk only' : 'No', 12);
    if (plan?.exclusion) {
      detail('Exclusion reason', [plan.exclusion.reasonLabel, plan.exclusion.reasonCode, plan.exclusion.reason].filter(Boolean).join(' | '), 12);
      detail('Excluded by', [plan.exclusion.excludedBy, plan.exclusion.excludedAt].filter(Boolean).join(' | '), 12);
    }
    if (plan?.suggestedExclusion) {
      detail('Suggested exclusion', [plan.suggestedExclusion.label, plan.suggestedExclusion.confidence, plan.suggestedExclusion.reason].filter(Boolean).join(' | '), 12);
      detail('Suggestion evidence', (Array.isArray(plan.suggestedExclusion.evidence) ? plan.suggestedExclusion.evidence : []).join(' | '), 12);
    }
    detail('Matched CRM record', plan?.matchedRecordId, 12);
    detail('Predicted CRM record', plan?.predictedRecordId, 12);

    const candidates = Array.isArray(plan?.candidates) ? plan.candidates : [];
    if (candidates.length) {
      push('Possible CRM matches', { size:8.5, bold:true, indent:12, gapBefore:4 });
      for (const candidate of candidates) {
        detail(
          clean(candidate?.recordId,120) + ' / ' + clean(candidate?.name,180),
          [candidate?.email, candidate?.phone, candidate?.eventDate, candidate?.stage, candidate?.riskLevel, candidate?.score ? 'score ' + candidate.score : '', ...(Array.isArray(candidate?.signals) ? candidate.signals : []), candidate?.reason].filter(Boolean).join(' | '),
          22,
        );
      }
    }

    const f = plan?.financial || {};
    detail('Financial summary', [
      Number(f.estimates || 0) + ' estimate(s) $' + Number(f.estimateTotal || 0).toFixed(2),
      Number(f.invoices || 0) + ' invoice(s) $' + Number(f.invoiceTotal || 0).toFixed(2),
      '$' + Number(f.openBalance || 0).toFixed(2) + ' open',
      Number(f.payments || 0) + ' payment(s) $' + Number(f.paymentTotal || 0).toFixed(2),
    ].join(' | '), 12);

    for (const doc of Array.isArray(f.estimateDocs) ? f.estimateDocs : []) {
      detail('Estimate', '#' + clean(doc?.docNumber || doc?.id,120) + ' | ' + clean(doc?.txnDate,40) + ' | $' + Number(doc?.total || 0).toFixed(2) + ' | ' + clean(doc?.emailStatus,80), 22);
    }
    for (const doc of Array.isArray(f.invoiceDocs) ? f.invoiceDocs : []) {
      detail('Invoice', '#' + clean(doc?.docNumber || doc?.id,120) + ' | ' + clean(doc?.txnDate,40) + ' | due ' + clean(doc?.dueDate,40) + ' | $' + Number(doc?.total || 0).toFixed(2) + ' | $' + Number(doc?.balance || 0).toFixed(2) + ' open', 22);
    }
    for (const doc of Array.isArray(f.paymentDocs) ? f.paymentDocs : []) {
      detail('Payment', '#' + clean(doc?.id,120) + ' | ' + clean(doc?.txnDate,40) + ' | $' + Number(doc?.total || 0).toFixed(2), 22);
    }

    jsonBlock('CRM before', plan?.before);
    jsonBlock('Projected after', plan?.after);
  }

  section('CRM -> QuickBooks planned updates');
  const outbound = Array.isArray(preview?.outbound) ? preview.outbound : [];
  if (!outbound.length) detail('Updates', 'None');
  for (const row of outbound) {
    push((row?.name || row?.recordId || 'CRM record') + ' | CRM ' + clean(row?.recordId,120), { size:10.5, bold:true, gapBefore:8 });
    for (const action of Array.isArray(row?.actions) ? row.actions : []) {
      detail('Action', [action?.type, action?.field || action?.action, action?.reason].filter(Boolean).join(' | '), 12);
      jsonBlock('Before', action?.before);
      jsonBlock('After', action?.after);
    }
  }

  return lines;
}

function paginate(lines: PdfLine[]) {
  const pages: PdfLine[][] = [];
  let current: PdfLine[] = [];
  let y = 750;
  for (const line of lines) {
    const size = Number(line.size || 8.5);
    const gap = Number(line.gapBefore || 0);
    const step = Math.max(10, size + 3);
    if (y - gap - step < 42 && current.length) {
      pages.push(current);
      current = [];
      y = 750;
    }
    if (gap) y -= gap;
    current.push(line);
    y -= step;
  }
  if (current.length) pages.push(current);
  return pages;
}

export function buildQuickBooksCrmPreviewPdf(preview: any) {
  const pages = paginate(previewPdfLines(preview));
  const pageCount = Math.max(1, pages.length);
  const catalogId = 1;
  const pagesId = 2;
  const regularFontId = 3;
  const boldFontId = 4;
  const firstPageId = 5;
  const firstContentId = firstPageId + pageCount;
  const objects: string[] = [];

  objects[catalogId] = '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>';
  objects[regularFontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[boldFontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';

  const kids: string[] = [];
  pages.forEach((page, index) => {
    const pageId = firstPageId + index;
    const contentId = firstContentId + index;
    kids.push(pageId + ' 0 R');

    let y = 750;
    const commands: string[] = [];
    for (const line of page) {
      const size = Number(line.size || 8.5);
      const gap = Number(line.gapBefore || 0);
      if (gap) y -= gap;
      const x = 54 + Number(line.indent || 0);
      const font = line.bold ? 'F2' : 'F1';
      commands.push('BT /' + font + ' ' + size.toFixed(2) + ' Tf 1 0 0 1 ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' Tm (' + pdfEscape(line.text) + ') Tj ET');
      y -= Math.max(10, size + 3);
    }
    const stream = commands.join('\n');
    objects[contentId] = '<< /Length ' + Buffer.byteLength(stream, 'ascii') + ' >>\nstream\n' + stream + '\nendstream';
    objects[pageId] = '<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ' + regularFontId + ' 0 R /F2 ' + boldFontId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>';
  });
  objects[pagesId] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pageCount + ' >>';

  const maxId = firstContentId + pageCount - 1;
  let pdf = '%PDF-1.4\n%Audit\n';
  const offsets: number[] = new Array(maxId + 1).fill(0);
  for (let id = 1; id <= maxId; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, 'ascii');
    pdf += id + ' 0 obj\n' + objects[id] + '\nendobj\n';
  }
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += 'xref\n0 ' + (maxId + 1) + '\n';
  pdf += '0000000000 65535 f \n';
  for (let id = 1; id <= maxId; id += 1) {
    pdf += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size ' + (maxId + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf, 'ascii');
}
