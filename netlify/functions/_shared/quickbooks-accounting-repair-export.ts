function clean(value: unknown, max = 12000) {
  return String(value ?? '').trim().slice(0, max);
}

function csvCell(value: unknown) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return '"' + String(text).replace(/"/g, '""') + '"';
}

function money(value: unknown) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function json(value: unknown) {
  return value == null ? '' : JSON.stringify(value);
}

function rowsForExport(audit: any) {
  const rows: Record<string, unknown>[] = [];
  rows.push({
    section:'preview',
    rowType:'summary',
    bulkPreviewId:clean(audit?.bulkPreviewId,140),
    generatedAt:clean(audit?.generatedAt,80),
    updatedAt:clean(audit?.updatedAt,80),
    actor:clean(audit?.actor,240),
    requestedCount:Number(audit?.requestedCount||0),
    repairableClientCount:Number(audit?.repairableClientCount||0),
    writeCount:Number(audit?.writeCount||0),
    blockedClientCount:Number(audit?.blockedClientCount||0),
    cleanClientCount:Number(audit?.cleanClientCount||0),
    errorClientCount:Number(audit?.errorClientCount||0),
    approvalMode:clean(audit?.approvalMode,80),
  });

  for (const client of Array.isArray(audit?.rows) ? audit.rows : []) {
    rows.push({
      section:'client',
      rowType:'classification',
      bulkPreviewId:clean(audit?.bulkPreviewId,140),
      recordId:clean(client?.recordId,120),
      clientName:clean(client?.clientName,240),
      lifecycle:clean(client?.lifecycle,80),
      status:clean(client?.status,80),
      error:clean(client?.error,1200),
      blockedIssues:json(client?.blockedIssues),
    });
    for (const change of Array.isArray(client?.changes) ? client.changes : []) {
      rows.push({
        section:'write',
        rowType:'planned_change',
        bulkPreviewId:clean(audit?.bulkPreviewId,140),
        recordId:clean(client?.recordId,120),
        clientName:clean(client?.clientName,240),
        changeId:clean(change?.id,180),
        changeType:clean(change?.type,80),
        documentType:clean(change?.documentType,40),
        target:clean(change?.target,300),
        documentId:clean(change?.invoiceId || change?.before?.estimateId || change?.before?.invoiceId,120),
        documentNumber:clean(change?.docNumber || change?.before?.docNumber,120),
        beforeTotal:change?.before?.total == null ? '' : money(change.before.total),
        beforeBalance:change?.before?.balance == null ? '' : money(change.before.balance),
        beforePaymentState:clean(change?.before?.paymentState,40),
        afterTotal:change?.after?.total == null ? '' : money(change.after.total),
        afterBalance:change?.after?.balance == null ? '' : money(change.after.balance),
        afterPaymentState:clean(change?.after?.paymentState,40),
        taxHandling:clean(change?.after?.taxHandling,1200),
        before:json(change?.before),
        after:json(change?.after),
      });
    }
  }

  for (const decision of Array.isArray(audit?.decisions) ? audit.decisions : []) {
    rows.push({
      section:'decision',
      rowType:'individual_decision',
      bulkPreviewId:clean(audit?.bulkPreviewId,140),
      decisionId:clean(decision?.decisionId,140),
      decision:clean(decision?.decision,40),
      decidedAt:clean(decision?.decidedAt,80),
      decidedBy:clean(decision?.decidedBy,240),
      recordId:clean(decision?.recordId,120),
      clientName:clean(decision?.clientName,240),
      changeId:clean(decision?.changeId,180),
      previewId:clean(decision?.previewId,140),
      reason:clean(decision?.reason,1200),
      resolved:decision?.resolved == null ? '' : Boolean(decision.resolved),
      remainingIssues:json(decision?.remainingIssues),
      before:json(decision?.before),
      after:json(decision?.after),
    });
    for (const doc of Array.isArray(decision?.documents) ? decision.documents : []) {
      rows.push({
        section:'decision_document',
        rowType:'actual_write',
        bulkPreviewId:clean(audit?.bulkPreviewId,140),
        decisionId:clean(decision?.decisionId,140),
        decision:clean(decision?.decision,40),
        decidedAt:clean(decision?.decidedAt,80),
        decidedBy:clean(decision?.decidedBy,240),
        recordId:clean(decision?.recordId,120),
        clientName:clean(decision?.clientName,240),
        changeId:clean(decision?.changeId,180),
        documentType:clean(doc?.type,40),
        documentId:clean(doc?.id,120),
        documentNumber:clean(doc?.docNumber,120),
        beforeTotal:doc?.beforeTotal == null ? '' : money(doc.beforeTotal),
        afterTotal:doc?.afterTotal == null ? '' : money(doc.afterTotal),
        afterBalance:doc?.balance == null ? '' : money(doc.balance),
      });
    }
  }
  return rows;
}

export function buildAccountingRepairBulkPreviewCsv(audit: any) {
  const rows = rowsForExport(audit);
  const headers = [
    'section','rowType','bulkPreviewId','generatedAt','updatedAt','actor','approvalMode',
    'requestedCount','repairableClientCount','writeCount','blockedClientCount','cleanClientCount','errorClientCount',
    'recordId','clientName','lifecycle','status','error','blockedIssues',
    'changeId','changeType','documentType','target','documentId','documentNumber',
    'beforeTotal','beforeBalance','beforePaymentState','afterTotal','afterBalance','afterPaymentState','taxHandling',
    'decisionId','decision','decidedAt','decidedBy','previewId','reason','resolved','remainingIssues','before','after',
  ];
  return '\uFEFF' + [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(',')),
  ].join('\r\n');
}

function ascii(value: unknown) {
  return String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2192/g, '->')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E\n\r\t]/g, '?');
}

function esc(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrap(value: unknown, width = 96) {
  const source = ascii(value).replace(/\r/g, '');
  const out: string[] = [];
  for (const paragraph of source.split('\n')) {
    let remaining = paragraph;
    if (!remaining) { out.push(''); continue; }
    while (remaining.length > width) {
      let split = remaining.lastIndexOf(' ', width);
      if (split < Math.floor(width * 0.55)) split = width;
      out.push(remaining.slice(0, split));
      remaining = remaining.slice(split).trimStart();
    }
    out.push(remaining);
  }
  return out;
}

type PdfLine = { text:string; size?:number; bold?:boolean; indent?:number; gapBefore?:number };

function pdfLines(audit: any) {
  const lines: PdfLine[] = [];
  const push=(text:unknown,opts:Omit<PdfLine,'text'>={})=>lines.push({text:ascii(text),...opts});
  const detail=(label:string,value:unknown,indent=0)=>{
    wrap(label+': '+(value == null || value === '' ? '-' : value),94-Math.floor(indent/4))
      .forEach((text,index)=>push(text,{size:8.5,indent:index?indent+10:indent}));
  };
  const section=(title:string)=>push(title,{size:12,bold:true,gapBefore:10});

  push('QuickBooks Accounting Repair Bulk Preview Audit',{size:17,bold:true});
  detail('Bulk preview ID',audit?.bulkPreviewId);
  detail('Generated',audit?.generatedAt);
  detail('Updated',audit?.updatedAt);
  detail('Prepared by',audit?.actor);
  detail('Approval mode',audit?.approvalMode);

  section('Summary');
  detail('Clients requested',audit?.requestedCount);
  detail('Repairable clients',audit?.repairableClientCount);
  detail('Individual writes',audit?.writeCount);
  detail('Blocked clients',audit?.blockedClientCount);
  detail('Clean clients',audit?.cleanClientCount);
  detail('Errors / unavailable / ineligible',audit?.errorClientCount);

  section('Client classifications and planned writes');
  for (const client of Array.isArray(audit?.rows) ? audit.rows : []) {
    push((client?.clientName || client?.recordId || 'Client')+' | '+clean(client?.status,80),{size:10.5,bold:true,gapBefore:8});
    detail('Record',client?.recordId,12);
    detail('Lifecycle',client?.lifecycle,12);
    if (client?.error) detail('Error',client.error,12);
    for (const change of Array.isArray(client?.changes) ? client.changes : []) {
      detail(
        'Planned write',
        [
          change?.target || change?.type,
          'before '+(change?.before?.total == null ? '-' : '$'+money(change.before.total).toFixed(2)),
          'after '+(change?.after?.total == null ? '-' : '$'+money(change.after.total).toFixed(2)),
          change?.after?.taxHandling,
        ].filter(Boolean).join(' | '),
        18,
      );
    }
    for (const issue of Array.isArray(client?.blockedIssues) ? client.blockedIssues : []) {
      detail('Blocked', [issue?.label||issue?.code,issue?.protection].filter(Boolean).join(' | '),18);
    }
  }

  section('Individual approval / rejection history');
  const decisions=Array.isArray(audit?.decisions)?audit.decisions:[];
  if(!decisions.length) detail('Decisions','None recorded yet');
  for(const decision of decisions){
    push((decision?.clientName||decision?.recordId||'Client')+' | '+String(decision?.decision||'decision').toUpperCase(),{size:10.5,bold:true,gapBefore:8});
    detail('Change',decision?.changeId,12);
    detail('Decided',decision?.decidedAt,12);
    detail('By',decision?.decidedBy,12);
    if(decision?.reason)detail('Reason',decision.reason,12);
    if(decision?.before)detail('Before',JSON.stringify(decision.before),12);
    if(decision?.after)detail('After',JSON.stringify(decision.after),12);
    for(const doc of Array.isArray(decision?.documents)?decision.documents:[]){
      detail('Actual write',[
        doc?.type,
        '#'+(doc?.docNumber||doc?.id||''),
        doc?.beforeTotal==null?'':'$'+money(doc.beforeTotal).toFixed(2),
        '->',
        doc?.afterTotal==null?'':'$'+money(doc.afterTotal).toFixed(2),
      ].filter(Boolean).join(' '),18);
    }
  }
  return lines;
}

function paginate(lines:PdfLine[]){
  const pages:PdfLine[][]=[]; let current:PdfLine[]=[]; let y=750;
  for(const line of lines){
    const size=Number(line.size||8.5),gap=Number(line.gapBefore||0),step=Math.max(10,size+3);
    if(y-gap-step<42&&current.length){pages.push(current);current=[];y=750;}
    if(gap)y-=gap; current.push(line); y-=step;
  }
  if(current.length)pages.push(current);
  return pages;
}

export function buildAccountingRepairBulkPreviewPdf(audit:any){
  const pages=paginate(pdfLines(audit)); const pageCount=Math.max(1,pages.length);
  const catalogId=1,pagesId=2,regularFontId=3,boldFontId=4,firstPageId=5,firstContentId=firstPageId+pageCount;
  const objects:string[]=[]; objects[catalogId]='<< /Type /Catalog /Pages '+pagesId+' 0 R >>';
  objects[regularFontId]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[boldFontId]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  const kids:string[]=[];
  pages.forEach((page,index)=>{
    const pageId=firstPageId+index,contentId=firstContentId+index;kids.push(pageId+' 0 R');
    let y=750; const commands:string[]=[];
    for(const line of page){
      const size=Number(line.size||8.5),gap=Number(line.gapBefore||0);if(gap)y-=gap;
      const x=54+Number(line.indent||0),font=line.bold?'F2':'F1';
      commands.push('BT /'+font+' '+size.toFixed(2)+' Tf 1 0 0 1 '+x.toFixed(2)+' '+y.toFixed(2)+' Tm ('+esc(line.text)+') Tj ET');
      y-=Math.max(10,size+3);
    }
    const stream=commands.join('\n');
    objects[contentId]='<< /Length '+Buffer.byteLength(stream,'ascii')+' >>\nstream\n'+stream+'\nendstream';
    objects[pageId]='<< /Type /Page /Parent '+pagesId+' 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 '+regularFontId+' 0 R /F2 '+boldFontId+' 0 R >> >> /Contents '+contentId+' 0 R >>';
  });
  objects[pagesId]='<< /Type /Pages /Kids ['+kids.join(' ')+'] /Count '+pageCount+' >>';
  const maxId=firstContentId+pageCount-1;let pdf='%PDF-1.4\n%Audit\n';const offsets:number[]=new Array(maxId+1).fill(0);
  for(let id=1;id<=maxId;id+=1){offsets[id]=Buffer.byteLength(pdf,'ascii');pdf+=id+' 0 obj\n'+objects[id]+'\nendobj\n';}
  const xref=Buffer.byteLength(pdf,'ascii');pdf+='xref\n0 '+(maxId+1)+'\n0000000000 65535 f \n';
  for(let id=1;id<=maxId;id+=1)pdf+=String(offsets[id]).padStart(10,'0')+' 00000 n \n';
  pdf+='trailer\n<< /Size '+(maxId+1)+' /Root '+catalogId+' 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
  return Buffer.from(pdf,'ascii');
}
