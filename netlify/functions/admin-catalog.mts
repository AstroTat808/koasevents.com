import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import readXlsxFile from 'read-excel-file/node';
import { Buffer } from 'node:buffer';
import { hasCapability, requireCapability } from './_shared/admin';
import {
  getCatalogPriceHistory,
  getQuickBooksCatalog,
  getQuickBooksConnection,
  qboQuery,
  qboUpdate,
  saveQuickBooksCatalog,
  type QuickBooksCatalogItem,
} from './_shared/quickbooks';
import { catalogItems as websiteCatalogItems, type CatalogItem as WebsiteCatalogItem } from '../../src/data/catalog';
import { businessRules } from '../../src/data/businessRules';

type ImportMapping = Partial<Record<
  'id' | 'name' | 'description' | 'group' | 'category' | 'unitLabel' | 'unitPrice' |
  'internalCost' | 'targetMargin' | 'getExempt' | 'active',
  string
>>;

type ImportRow = {
  rowNumber: number;
  raw: Record<string,string>;
  item: QuickBooksCatalogItem;
  status: 'new' | 'update' | 'duplicate' | 'invalid';
  duplicateId: string;
  errors: string[];
};

const IMPORT_LIMIT_BYTES = 2 * 1024 * 1024;
const IMPORT_LIMIT_ROWS = 1000;

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name:'koa-integrations', consistency:'strong' })
    : getDeployStore({ name:'koa-integrations' });
}

function salesStoreFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name:'koa-sales', consistency:'strong' })
    : getDeployStore({ name:'koa-sales' });
}

function clean(value: unknown, max = 1000) {
  return String(value ?? '').trim().slice(0,max);
}

function money(value: unknown) {
  const n=Number(String(value ?? '').replace(/[$,%\s,]/g,''));
  return Number.isFinite(n) ? Math.max(0,Math.round(n*100)/100) : 0;
}

function percent(value: unknown) {
  const raw=clean(value,40);
  if(!raw)return 0;
  const hasPercent=raw.includes('%');
  let n=Number(raw.replace(/[,%\s]/g,''));
  if(!Number.isFinite(n))return 0;
  if(!hasPercent && n>0 && n<=1)n*=100;
  return Math.min(100,Math.max(0,Math.round(n*100)/100));
}

function bool(value: unknown, fallback=false) {
  const v=clean(value,40).toLowerCase();
  if(!v)return fallback;
  if(['1','true','yes','y','active','on','exempt'].includes(v))return true;
  if(['0','false','no','n','inactive','off','taxable'].includes(v))return false;
  return fallback;
}

function slug(value: unknown) {
  return clean(value,100).toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);
}

function normalizeGroup(value: unknown, fallback: QuickBooksCatalogItem['group']='other'): QuickBooksCatalogItem['group'] {
  const v=clean(value,100).toLowerCase().replace(/[_\s]+/g,'-');
  if(!v)return fallback;
  if(v.includes('wedding') || v.includes('package') || v.includes('collection'))return 'packages';
  if(v.includes('mobile') || v === 'bar' || v.includes('bar-package'))return 'mobile-bar';
  if(['rental','rentals','furniture','tabletop','decor','décor','production','inventory'].some(x=>v.includes(x)))return 'rentals';
  if(v.includes('fee'))return 'fees';
  if(v.includes('add') || v.includes('service') || v.includes('upgrade'))return 'add-ons';
  return ['packages','rentals','mobile-bar','add-ons','fees','other'].includes(v)
    ? v as QuickBooksCatalogItem['group']
    : fallback;
}

function normalizeCategory(value: unknown, group: QuickBooksCatalogItem['group']): QuickBooksCatalogItem['category'] {
  const v=clean(value,80).toLowerCase();
  if(['service','rental','mileage','fee'].includes(v))return v as QuickBooksCatalogItem['category'];
  if(group==='rentals')return 'rental';
  if(group==='fees')return 'fee';
  return 'service';
}

function groupForWebsite(item: WebsiteCatalogItem): QuickBooksCatalogItem['group'] {
  if(item.category==='packages')return 'packages';
  if(item.category==='bar')return 'mobile-bar';
  if(['furniture','tabletop','decor','production'].includes(item.category))return 'rentals';
  return 'add-ons';
}

function unitForWebsite(item: WebsiteCatalogItem) {
  if(item.estimatedUnitLabel)return clean(item.estimatedUnitLabel,40);
  if(item.quantityLabel)return clean(item.quantityLabel,40).replace(/^additional\s+/i,'').toLowerCase();
  if(item.category==='packages')return 'package';
  return 'each';
}

function priceForWebsite(item: WebsiteCatalogItem) {
  if(Number(item.publishedUnitPrice)>0)return money(item.publishedUnitPrice);
  if(Number(item.estimatedUnitPrice)>0)return money(item.estimatedUnitPrice);
  const match=String(item.priceLabel||'').match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  return match ? money(match[1]) : 0;
}

function websiteSeed(): QuickBooksCatalogItem[] {
  const now=new Date().toISOString();
  return websiteCatalogItems.map((item) => {
    const group=groupForWebsite(item);
    return {
      id:clean(item.id,80),
      name:clean(item.name,100),
      description:clean(item.description,1000),
      category:normalizeCategory('',group),
      group,
      unitLabel:unitForWebsite(item),
      unitPrice:priceForWebsite(item),
      internalCost:0,
      targetMargin:0,
      active:true,
      getExempt:false,
      source:'website',
      sourceRef:clean(item.id,160),
      quickBooksItemId:'',
      quickBooksItemName:'',
      quickBooksType:group==='rentals' ? 'NonInventory' : 'Service',
      incomeAccountId:'',
      incomeAccountName:'',
      updatedAt:now,
    };
  }).filter((item)=>item.id&&item.name);
}

async function ensureWebsiteCatalog(context: Context) {
  const existing=await getQuickBooksCatalog(context);
  const byId=new Map(existing.map((item)=>[item.id,item]));
  let changed=false;
  for(const seed of websiteSeed()){
    if(byId.has(seed.id))continue;
    byId.set(seed.id,seed);
    changed=true;
  }
  if(!changed)return existing;
  return saveQuickBooksCatalog(
    context,
    [...byId.values()].sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name)),
    {actor:'system',source:'website-seed',note:'Seeded missing items from the public website catalog.'},
  );
}

async function refreshWebsiteCatalog(context: Context, actor = 'system') {
  const existing=await getQuickBooksCatalog(context);
  const byId=new Map(existing.map((item)=>[item.id,item]));
  let added=0, refreshed=0;
  for(const seed of websiteSeed()){
    const prior=byId.get(seed.id);
    if(!prior){
      byId.set(seed.id,seed); added+=1; continue;
    }
    if(prior.source!=='website')continue;
    byId.set(seed.id,{
      ...seed,
      internalCost:prior.internalCost,
      targetMargin:prior.targetMargin,
      getExempt:prior.getExempt,
      active:prior.active,
      quickBooksItemId:prior.quickBooksItemId,
      quickBooksItemName:prior.quickBooksItemName,
      quickBooksType:prior.quickBooksType,
      incomeAccountId:prior.incomeAccountId,
      incomeAccountName:prior.incomeAccountName,
      updatedAt:new Date().toISOString(),
    });
    refreshed+=1;
  }
  const catalog=await saveQuickBooksCatalog(
    context,
    [...byId.values()].sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name)),
    {actor,source:'website-sync',note:'Synchronized website-owned catalog items from the public catalog source.'},
  );
  return {catalog,added,refreshed};
}


function normalizePackageCatalogId(value: unknown) {
  const raw=clean(value,100).toLowerCase().replaceAll('_','-').replace(/\s+/g,'-');
  if(!raw)return '';
  if(raw==='plumeria'||raw==='signature'||raw==='signature-wedding-experience'||raw.includes('signature'))return 'signature-wedding';
  if(raw.includes('gardenia'))return 'gardenia';
  if(raw.includes('orchid'))return 'orchid';
  if(raw.includes('hibiscus'))return 'hibiscus';
  if(raw==='mobile-oahu'||raw==='oahu'||raw==='oahu-mobile-bar-package')return 'oahu-bar';
  if(raw==='mobile-maui'||raw==='maui'||raw==='maui-mobile-bar-package')return 'maui-bar';
  if(raw==='mobile-big-island'||raw==='big-island'||raw==='big-island-mobile-bar-package')return 'big-island-bar';
  return raw;
}

function websitePlacementsForItem(item:QuickBooksCatalogItem) {
  const placements:Array<{path:string;label:string}>=[
    {path:'/catalog/',label:'Rental + enhancement catalog'},
  ];
  if(item.group==='packages'){
    placements.push({path:'/venue/packages/',label:'Wedding packages'});
    placements.push({path:'/weddings/',label:'Weddings overview'});
    if(item.id==='signature-wedding')placements.push({path:'/signature-wedding/',label:'Signature Wedding Experience'});
  }
  if(item.group==='mobile-bar'){
    placements.push({path:'/mobile-bar/',label:'Mobile Bar'});
  }
  return placements.filter((row,index,all)=>all.findIndex(other=>other.path===row.path)===index);
}

async function readSalesRecords(context:Context) {
  const raw=await salesStoreFor(context).get('records/index',{type:'json'}) as any;
  return Array.isArray(raw)?raw:[];
}

function proposalUsesCatalogItem(record:any,item:QuickBooksCatalogItem) {
  if(record?.kind!=='proposal'||!record?.proposal)return false;
  const lines=Array.isArray(record.proposal.lineItems)?record.proposal.lineItems:[];
  if(lines.some((line:any)=>clean(line?.catalogItemId||line?.id,80)===item.id))return true;
  if(item.group==='packages'){
    const packageId=normalizePackageCatalogId(record?.packageId||record?.quote?.state?.startingPoint||record?.inquiry?.venuePackage||record?.inquiry?.packageInterest||'');
    if(packageId===item.id && lines.some((line:any)=>clean(line?.id,80)==='collection'))return true;
  }
  return false;
}

function proposalUsage(records:any[],item:QuickBooksCatalogItem) {
  const used=records.filter(record=>proposalUsesCatalogItem(record,item));
  const statuses:Record<string,number>={};
  used.forEach((record:any)=>{
    const status=clean(record?.proposal?.status||record?.stage||record?.status||'unknown',40)||'unknown';
    statuses[status]=(statuses[status]||0)+1;
  });
  return {
    count:used.length,
    statuses,
    samples:used.slice(0,12).map((record:any)=>({
      id:clean(record?.id,100),
      client:clean(record?.customer?.name,180),
      eventDate:clean(record?.customer?.eventDate,40),
      status:clean(record?.proposal?.status||record?.stage||record?.status,40),
      total:money(record?.proposal?.total),
    })),
  };
}

function qboLineItemIds(transaction:any) {
  const lines=Array.isArray(transaction?.Line)?transaction.Line:[];
  return lines
    .map((line:any)=>clean(line?.SalesItemLineDetail?.ItemRef?.value,80))
    .filter(Boolean);
}

async function loadQuickBooksTransactions(context:Context) {
  const connection=await getQuickBooksConnection(context);
  if(!connection?.realmId)return {connected:false,transactions:[] as any[],error:''};
  const transactions:any[]=[];
  try{
    for(const entity of ['Estimate','Invoice','SalesReceipt']){
      const data:any=await qboQuery(context,'select * from '+entity+' maxresults 1000');
      const rows=Array.isArray(data?.QueryResponse?.[entity])?data.QueryResponse[entity]:[];
      rows.forEach((row:any)=>transactions.push({
        entity,
        id:clean(row?.Id,80),
        docNumber:clean(row?.DocNumber,80),
        txnDate:clean(row?.TxnDate,40),
        total:money(row?.TotalAmt),
        itemIds:qboLineItemIds(row),
      }));
    }
    return {connected:true,transactions,error:''};
  }catch(error){
    return {connected:true,transactions:[] as any[],error:error instanceof Error?clean(error.message,500):'QuickBooks transaction lookup failed.'};
  }
}

function transactionUsage(transactions:any[],item:QuickBooksCatalogItem) {
  const qboId=clean(item.quickBooksItemId,80);
  if(!qboId)return {mapped:false,count:null,samples:[] as any[]};
  const used=transactions.filter((row:any)=>Array.isArray(row.itemIds)&&row.itemIds.includes(qboId));
  return {
    mapped:true,
    count:used.length,
    samples:used.slice(0,12).map((row:any)=>({
      entity:row.entity,id:row.id,docNumber:row.docNumber,txnDate:row.txnDate,total:row.total,
    })),
  };
}

async function itemUsage(context:Context,item:QuickBooksCatalogItem) {
  const [records,qbo,history]=await Promise.all([
    readSalesRecords(context),
    loadQuickBooksTransactions(context),
    getCatalogPriceHistory(context,{catalogItemId:item.id,limit:20}),
  ]);
  return {
    catalogItemId:item.id,
    proposals:proposalUsage(records,item),
    website:{count:websitePlacementsForItem(item).length,placements:websitePlacementsForItem(item)},
    quickBooks:{
      connected:qbo.connected,
      error:qbo.error,
      ...transactionUsage(qbo.transactions,item),
    },
    priceHistory:history,
  };
}

const QBO_CATALOG_ALIASES:Record<string,string[]>={
  gardenia:['Wedding Packages:Wedding Package-Gardenia'],
  orchid:['Wedding Packages:Wedding Package-Orchid'],
  hibiscus:['Wedding Packages:Wedding Package-Hibiscus'],
  'signature-wedding':['Wedding Packages:Wedding Package-Plumeria'],
  'oahu-bar':['Bar:Bar Package-Oahu'],
  'maui-bar':['Bar:Bar Package-Maui'],
  'big-island-bar':['Bar:Bar Package-Big Island'],
  'bar-additional-hour':['Bar:Mobile Bar - Additional Hour'],
  'ceremony-chair':['Tables & Chairs:Chairs-White/Resin'],
  'reception-chair':['Tables & Chairs:Chairs-White/Resin'],
  'round-table':['Tables & Chairs:Table-60-inch/Round'],
  'rectangle-table':['Tables & Chairs:Table-6-Ft/Rectangle'],
  glassware:['Bar:Glassware - Cocktail Glass','Bar:Glassware - Champange Flutes','Bar:Glassware - Wine Glasses'],
};

async function loadQuickBooksItems(context:Context) {
  const connection=await getQuickBooksConnection(context);
  if(!connection?.realmId)return {connected:false,items:[] as any[],error:''};
  try{
    const data:any=await qboQuery(context,'select * from Item maxresults 1000');
    const items=(Array.isArray(data?.QueryResponse?.Item)?data.QueryResponse.Item:[])
      .filter((item:any)=>['Service','NonInventory'].includes(String(item?.Type||'')))
      .map((item:any)=>({
        id:clean(item?.Id,80),
        syncToken:clean(item?.SyncToken,40),
        name:clean(item?.Name,160),
        fullyQualifiedName:clean(item?.FullyQualifiedName||item?.Name,220),
        type:clean(item?.Type,40),
        active:item?.Active!==false,
        taxable:item?.Taxable!==false,
        unitPrice:money(item?.UnitPrice),
        incomeAccountId:clean(item?.IncomeAccountRef?.value,80),
        incomeAccountName:clean(item?.IncomeAccountRef?.name,160),
      }));
    return {connected:true,items,error:''};
  }catch(error){
    return {connected:true,items:[] as any[],error:error instanceof Error?clean(error.message,500):'QuickBooks item lookup failed.'};
  }
}

function qboNameIndex(items:any[]) {
  const index=new Map<string,any[]>();
  (Array.isArray(items)?items:[]).forEach((item:any)=>{
    [item?.name,item?.fullyQualifiedName].map(value=>clean(value,220).toLowerCase()).filter(Boolean).forEach((key)=>{
      const rows=index.get(key)||[];
      if(!rows.some(row=>row.id===item.id))rows.push(item);
      index.set(key,rows);
    });
  });
  return index;
}

function qboCandidatesForItem(item:QuickBooksCatalogItem,index:Map<string,any[]>) {
  const names=[
    ...(QBO_CATALOG_ALIASES[item.id]||[]),
    clean(item.quickBooksItemName,160),
    clean(item.name,160),
  ].filter(Boolean);
  const byId=new Map<string,any>();
  names.forEach(name=>{
    (index.get(String(name).toLowerCase())||[]).forEach((row:any)=>byId.set(row.id,row));
  });
  return [...byId.values()];
}

function expectedWebsitePrice(itemId:string,seedById:Map<string,QuickBooksCatalogItem>) {
  const seed=seedById.get(itemId);
  if(!seed)return 0;
  const packageById:Record<string,number>=Object.fromEntries(
    businessRules.venueWeddingPackages.map((pkg:any)=>[
      pkg.name==='Plumeria'?'signature-wedding':String(pkg.name||'').toLowerCase(),
      Number(pkg.price||0),
    ]),
  );
  const mobileById:Record<string,number>=Object.fromEntries(
    businessRules.mobileBar.packages.map((pkg:any)=>[
      String(pkg.name||'').toLowerCase()==='big island'?'big-island-bar':String(pkg.name||'').toLowerCase()+'-bar',
      Number(pkg.price||0),
    ]),
  );
  return money(packageById[itemId]||mobileById[itemId]||seed.unitPrice||0);
}

async function runCatalogAudit(context:Context,catalog:QuickBooksCatalogItem[]) {
  const seedById=new Map(websiteSeed().map(item=>[item.id,item]));
  const qbo=await loadQuickBooksItems(context);
  const qboById=new Map(qbo.items.map((item:any)=>[item.id,item]));
  const catalogByQboId=new Map<string,QuickBooksCatalogItem[]>();
  catalog.forEach((item)=>{
    const id=clean(item.quickBooksItemId,80);
    if(id)catalogByQboId.set(id,[...(catalogByQboId.get(id)||[]),item]);
  });
  const qboByName=qboNameIndex(qbo.items);

  const rows=catalog.map((item)=>{
    const issues:Array<{code:string;severity:'warning'|'error';detail:string}>=[];
    const expected=seedById.get(item.id);
    const publicPrice=expectedWebsitePrice(item.id,seedById);
    if(expected){
      if(item.group!==expected.group)issues.push({code:'group_mismatch',severity:'error',detail:'Catalog group is '+item.group+'; website source expects '+expected.group+'.'});
      if(item.category!==expected.category)issues.push({code:'category_mismatch',severity:'error',detail:'Accounting category is '+item.category+'; website source expects '+expected.category+'.'});
      if(publicPrice>0 && Math.abs(Number(item.unitPrice||0)-publicPrice)>0.005){
        issues.push({code:'price_mismatch',severity:'warning',detail:'Catalog price '+money(item.unitPrice).toFixed(2)+' differs from published/source price '+publicPrice.toFixed(2)+'.'});
      }
    }
    if(item.getExempt){
      issues.push({code:'get_exemption_unverified',severity:'warning',detail:'GET exempt is enabled, but no item-level exemption rule is documented in the current website/business-rule source.'});
    }

    let qboMatch:any=null;
    let qboSuggestion:any=null;
    let qboCandidates:any[]=[];
    if(qbo.connected&&!qbo.error){
      if(item.quickBooksItemId){
        qboMatch=qboById.get(item.quickBooksItemId)||null;
        if(!qboMatch){
          issues.push({code:'qbo_mapping_missing',severity:'error',detail:'Mapped QuickBooks item #'+item.quickBooksItemId+' was not found.'});
        }
      }
      if(!qboMatch){
        qboCandidates=qboCandidatesForItem(item,qboByName);
        if(qboCandidates.length===1)qboSuggestion=qboCandidates[0];
        if(!item.quickBooksItemId){
          issues.push({
            code:'qbo_unmapped',
            severity:'warning',
            detail:qboCandidates.length===1
              ? 'No QuickBooks item is mapped; one known-name match is available.'
              : qboCandidates.length>1
                ? 'No QuickBooks item is mapped; multiple QuickBooks candidates need an explicit choice.'
                : 'No QuickBooks item is mapped.',
          });
        }
      }

      const live=qboMatch||qboSuggestion;
      if(live){
        if(live.active===false)issues.push({code:'qbo_item_inactive',severity:'warning',detail:'Matched QuickBooks item is inactive.'});
        if(item.quickBooksType!==live.type)issues.push({code:'qbo_type_mismatch',severity:'warning',detail:'Catalog expects '+item.quickBooksType+' but QuickBooks item is '+live.type+'.'});
        if(qboMatch && clean(item.quickBooksItemName,160) && clean(item.quickBooksItemName,160).toLowerCase()!==clean(live.fullyQualifiedName||live.name,160).toLowerCase()){
          issues.push({code:'qbo_name_mismatch',severity:'warning',detail:'Stored QuickBooks item name differs from the live Product/Service name.'});
        }
        if(!item.incomeAccountId&&live.incomeAccountId){
          issues.push({code:'qbo_income_account_metadata_missing',severity:'warning',detail:'QuickBooks has an income account, but the catalog mapping is missing the account ID.'});
        }else if(item.incomeAccountId&&live.incomeAccountId&&item.incomeAccountId!==live.incomeAccountId){
          issues.push({code:'qbo_income_account_mismatch',severity:'warning',detail:'Stored income-account mapping differs from the live QuickBooks item.'});
        }
        if(Number(item.unitPrice||0)>0 && Math.abs(Number(live.unitPrice||0)-Number(item.unitPrice||0))>0.005){
          issues.push({code:'qbo_price_mismatch',severity:'warning',detail:'QuickBooks default rate '+money(live.unitPrice).toFixed(2)+' differs from Catalog Manager '+money(item.unitPrice).toFixed(2)+'.'});
        }
        if(qboMatch){
          const shared=catalogByQboId.get(item.quickBooksItemId)||[];
          if(shared.length>1){
            issues.push({code:'qbo_mapping_shared',severity:'warning',detail:'QuickBooks Product/Service #'+item.quickBooksItemId+' is mapped to '+shared.length+' catalog items; transaction usage is not unique.'});
          }
        }
        const expectedTaxable=item.getExempt!==true;
        if(Boolean(live.taxable)!==expectedTaxable){
          issues.push({code:'qbo_tax_mismatch',severity:'warning',detail:'QuickBooks taxable flag does not match the Catalog Manager GET setting. This is review-only because the repository has no item-level GET exemption policy.'});
        }
      }
    }

    return {
      id:item.id,name:item.name,group:item.group,category:item.category,unitPrice:item.unitPrice,
      getExempt:item.getExempt,quickBooksItemId:item.quickBooksItemId,quickBooksItemName:item.quickBooksItemName,
      publicPrice:publicPrice||null,sourceExpected:Boolean(expected),
      qboMatch,qboSuggestion,qboCandidateCount:qboCandidates.length,issues,
      status:issues.some(issue=>issue.severity==='error')?'error':issues.length?'warning':'ok',
    };
  });

  return {
    checkedAt:new Date().toISOString(),
    qbo:{connected:qbo.connected,error:qbo.error},
    getPolicy:{
      status:'source-not-itemized',
      detail:'The current repository does not define item-level Hawaiʻi GET exemptions. Catalog items default to GET taxable; any explicit exemption is flagged for review. Live QuickBooks Taxable flags are compared to the Catalog Manager setting.',
    },
    summary:{
      total:rows.length,
      ok:rows.filter(row=>row.status==='ok').length,
      warnings:rows.filter(row=>row.status==='warning').length,
      errors:rows.filter(row=>row.status==='error').length,
      publishedPriceMismatches:rows.filter(row=>row.issues.some(issue=>issue.code==='price_mismatch')).length,
      quickBooksPriceMismatches:rows.filter(row=>row.issues.some(issue=>issue.code==='qbo_price_mismatch')).length,
      qboSharedMappings:rows.filter(row=>row.issues.some(issue=>issue.code==='qbo_mapping_shared')).length,
      categoryMismatches:rows.filter(row=>row.issues.some(issue=>['group_mismatch','category_mismatch'].includes(issue.code))).length,
      getExemptReview:rows.filter(row=>row.issues.some(issue=>issue.code==='get_exemption_unverified'||issue.code==='qbo_tax_mismatch')).length,
      qboMapped:rows.filter(row=>Boolean(row.qboMatch)).length,
      qboUnmapped:rows.filter(row=>row.issues.some(issue=>issue.code==='qbo_unmapped')).length,
    },
    rows,
  };
}

async function reconcileSafeCatalogIssues(context:Context,catalog:QuickBooksCatalogItem[],actor:string) {
  const seedById=new Map(websiteSeed().map(item=>[item.id,item]));
  const qbo=await loadQuickBooksItems(context);
  if(!qbo.connected)throw new Error('QuickBooks is not connected.');
  if(qbo.error)throw new Error(qbo.error);
  const qboById=new Map(qbo.items.map((item:any)=>[item.id,item]));
  const qboByName=qboNameIndex(qbo.items);
  const next=catalog.map(item=>({...item}));
  const actions:Array<{catalogItemId:string;action:string;detail:string}>=[];

  for(const item of next){
    const expected=seedById.get(item.id);
    const publicPrice=expectedWebsitePrice(item.id,seedById);
    if(expected && (item.group!==expected.group || item.category!==expected.category)){
      const before=item.group+'/'+item.category;
      item.group=expected.group;
      item.category=expected.category;
      item.quickBooksType=expected.category==='rental'?'NonInventory':'Service';
      item.updatedAt=new Date().toISOString();
      actions.push({catalogItemId:item.id,action:'category',detail:'Aligned catalog classification from '+before+' to '+item.group+'/'+item.category+' using the website catalog source.'});
    }
    let live=item.quickBooksItemId?qboById.get(item.quickBooksItemId):null;
    if(!live){
      const candidates=qboCandidatesForItem(item,qboByName);
      if(candidates.length===1)live=candidates[0];
    }
    if(!live)continue;

    if(item.quickBooksItemId!==live.id || item.quickBooksItemName!==live.fullyQualifiedName){
      item.quickBooksItemId=live.id;
      item.quickBooksItemName=live.fullyQualifiedName||live.name;
      item.quickBooksType=live.type==='NonInventory'?'NonInventory':'Service';
      item.incomeAccountId=live.incomeAccountId||item.incomeAccountId;
      item.incomeAccountName=live.incomeAccountName||item.incomeAccountName;
      item.updatedAt=new Date().toISOString();
      actions.push({catalogItemId:item.id,action:'mapped',detail:'Linked Catalog Manager to QuickBooks '+(live.fullyQualifiedName||live.name)+' #'+live.id+'.'});
    }

    const patch:any={Id:live.id,SyncToken:live.syncToken};
    let shouldUpdate=false;
    const centralMatchesPublished=publicPrice>0 && Math.abs(Number(item.unitPrice||0)-publicPrice)<0.005;
    if(centralMatchesPublished && Math.abs(Number(live.unitPrice||0)-publicPrice)>0.005){
      patch.UnitPrice=publicPrice;
      shouldUpdate=true;
      actions.push({catalogItemId:item.id,action:'qbo-price',detail:'Updated QuickBooks price from '+money(live.unitPrice).toFixed(2)+' to '+publicPrice.toFixed(2)+'.'});
    }
    // GET/taxability mismatches are intentionally audit-only. The repository does
    // not define item-level Hawaiʻi GET exemptions, so this workflow must not make
    // an accounting taxability decision on the owner's behalf.
    if(shouldUpdate){
      if(!live.syncToken)throw new Error('QuickBooks item '+live.id+' is missing SyncToken; safe reconciliation stopped.');
      await qboUpdate(context,'item',patch);
    }
  }

  const saved=await saveQuickBooksCatalog(
    context,
    next.sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name)),
    {actor,source:'catalog-audit-reconcile',note:'Applied safe website classification, Catalog Manager ↔ QuickBooks mapping, and conflict-free QuickBooks price reconciliation. GET/taxability differences remain review-only.'},
  );
  return {catalog:saved,actions,audit:await runCatalogAudit(context,saved)};
}

function headerKey(value: unknown) {
  return clean(value,120).toLowerCase().replace(/[^a-z0-9]+/g,'');
}

export function suggestMapping(headers: string[]): ImportMapping {
  const aliases: Record<keyof ImportMapping,string[]> = {
    id:['id','sku','itemid','code'],
    name:['name','item','itemname','product','service','descriptionname'],
    description:['description','details','notes','itemdescription'],
    group:['group','cataloggroup','businessgroup','typegroup','section'],
    category:['category','accountingcategory','itemtype','type'],
    unitLabel:['unit','unitlabel','uom','unitofmeasure'],
    unitPrice:['price','unitprice','sellprice','sellingprice','rate','amount'],
    internalCost:['cost','internalcost','directcost','unitcost'],
    targetMargin:['targetmargin','margin','targetmarginpercent','marginpercent'],
    getExempt:['getexempt','taxexempt','exempt','getstatus','taxstatus'],
    active:['active','enabled','status'],
  };
  const normalized=new Map(headers.map((h)=>[headerKey(h),h]));
  const mapping:ImportMapping={};
  (Object.keys(aliases) as Array<keyof ImportMapping>).forEach((key)=>{
    const found=aliases[key].map((alias)=>normalized.get(alias)).find(Boolean);
    if(found)mapping[key]=found;
  });
  return mapping;
}

export function parseCsv(text: string): string[][] {
  const rows:string[][]=[]; let row:string[]=[]; let cell=''; let quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){
      if(ch==='"' && text[i+1]==='"'){cell+='"';i+=1;}
      else if(ch==='"')quoted=false;
      else cell+=ch;
    }else if(ch==='"'){quoted=true;}
    else if(ch===','){row.push(cell);cell='';}
    else if(ch==='\n'){row.push(cell);rows.push(row);row=[];cell='';}
    else if(ch!=='\r'){cell+=ch;}
  }
  if(cell.length||row.length){row.push(cell);rows.push(row);}
  return rows;
}

export async function rowsFromFile(filename: string, base64: string) {
  if(!base64)throw new Error('Choose a CSV or Excel file.');
  const buffer=Buffer.from(base64,'base64');
  if(buffer.byteLength>IMPORT_LIMIT_BYTES)throw new Error('Catalog imports are limited to 2 MB.');
  const lower=filename.toLowerCase();
  let rows:any[][];
  if(lower.endsWith('.csv')){
    rows=parseCsv(buffer.toString('utf8'));
  }else if(lower.endsWith('.xlsx')){
    rows=await readXlsxFile(buffer);
  }else{
    throw new Error('Use a .csv or .xlsx catalog file.');
  }
  rows=rows.filter((row)=>Array.isArray(row)&&row.some((cell)=>clean(cell,10)));
  if(rows.length<2)throw new Error('The import file needs a header row and at least one data row.');
  if(rows.length-1>IMPORT_LIMIT_ROWS)throw new Error('Catalog imports are limited to 1,000 rows at a time.');
  const headers=rows[0].map((cell,index)=>clean(cell,120)||('Column '+(index+1)));
  return {headers,rows:rows.slice(1).map((row)=>Object.fromEntries(headers.map((h,i)=>[h,clean(row[i],4000)])))};
}

function importedItem(raw:Record<string,string>, mapping:ImportMapping, defaultGroup:QuickBooksCatalogItem['group'], rowNumber:number):QuickBooksCatalogItem {
  const get=(key:keyof ImportMapping)=>mapping[key] ? raw[String(mapping[key])] : '';
  const name=clean(get('name'),100);
  const group=normalizeGroup(get('group'),defaultGroup);
  const id=clean(get('id'),80)||slug(name)||('import-row-'+rowNumber);
  return {
    id,
    name,
    description:clean(get('description'),1000),
    group,
    category:normalizeCategory(get('category'),group),
    unitLabel:clean(get('unitLabel'),40)||(group==='packages'?'package':'each'),
    unitPrice:money(get('unitPrice')),
    internalCost:money(get('internalCost')),
    targetMargin:percent(get('targetMargin')),
    active:bool(get('active'),true),
    getExempt:bool(get('getExempt'),false),
    source:'import',
    sourceRef:'',
    quickBooksItemId:'',
    quickBooksItemName:'',
    quickBooksType:group==='rentals'?'NonInventory':'Service',
    incomeAccountId:'',
    incomeAccountName:'',
    updatedAt:new Date().toISOString(),
  };
}

export function buildImportRows(rawRows:Record<string,string>[], mapping:ImportMapping, defaultGroup:QuickBooksCatalogItem['group'], catalog:QuickBooksCatalogItem[]):ImportRow[] {
  const byId=new Map(catalog.map((item)=>[item.id.toLowerCase(),item]));
  const byName=new Map(catalog.map((item)=>[item.name.trim().toLowerCase(),item]));
  const seenIds=new Set<string>();
  const seenNames=new Set<string>();
  return rawRows.map((raw,index)=>{
    const item=importedItem(raw,mapping,defaultGroup,index+2);
    const errors:string[]=[];
    if(!item.name)errors.push('Name is required.');
    const idKey=item.id.toLowerCase();
    const nameKey=item.name.trim().toLowerCase();
    const idMatch=byId.get(idKey);
    const nameMatch=byName.get(nameKey);
    const existing=idMatch||nameMatch;
    let status:ImportRow['status']=existing?'update':'new';
    if(idMatch&&nameMatch&&idMatch.id!==nameMatch.id){
      status='invalid';
      errors.push('ID and name match different existing catalog items.');
    }
    if((idKey&&seenIds.has(idKey))||(nameKey&&seenNames.has(nameKey))){
      status='duplicate';
      errors.push('Duplicate ID or name inside this import file.');
    }
    if(errors.length&&status!=='duplicate')status='invalid';
    if(idKey)seenIds.add(idKey);
    if(nameKey)seenNames.add(nameKey);
    return {rowNumber:index+2,raw,item,status,duplicateId:existing?.id||'',errors};
  });
}

async function readImportHistory(context:Context){
  const store=storeFor(context);
  const raw=await store.get('catalog/imports/index',{type:'json'}) as any;
  return Array.isArray(raw)?raw.slice(0,20):[];
}

async function writeImportHistory(context:Context,entry:any){
  const store=storeFor(context);
  const current=await readImportHistory(context);
  const next=[entry,...current.filter((row:any)=>row.id!==entry.id)].slice(0,20);
  await store.setJSON('catalog/imports/index',next);
  return next;
}

function importId(){
  const bytes=crypto.getRandomValues(new Uint8Array(6));
  return 'CAT-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
}

export async function catalogFingerprint(catalog:QuickBooksCatalogItem[]) {
  const stable=(Array.isArray(catalog)?catalog:[])
    .map(item=>({
      id:item.id,name:item.name,description:item.description,category:item.category,group:item.group,
      unitLabel:item.unitLabel,unitPrice:item.unitPrice,internalCost:item.internalCost,targetMargin:item.targetMargin,
      active:item.active,getExempt:item.getExempt,source:item.source,sourceRef:item.sourceRef,
      quickBooksItemId:item.quickBooksItemId,quickBooksItemName:item.quickBooksItemName,
      quickBooksType:item.quickBooksType,incomeAccountId:item.incomeAccountId,incomeAccountName:item.incomeAccountName,
      updatedAt:item.updatedAt,
    }))
    .sort((a,b)=>a.id.localeCompare(b.id));
  const bytes=new TextEncoder().encode(JSON.stringify(stable));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
}

export default async (req:Request, context:Context)=>{
  const auth=await requireCapability('sales.view',req);
  if(auth.response)return auth.response;

  if(req.method==='GET'){
    const [catalog,imports,priceHistory]=await Promise.all([
      ensureWebsiteCatalog(context),
      readImportHistory(context),
      getCatalogPriceHistory(context,{limit:150}),
    ]);
    return Response.json({catalog,imports,priceHistory},{headers:{'Cache-Control':'private, no-store'}});
  }
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});

  const payload:any=await req.json().catch(()=>null);
  const action=clean(payload?.action,80);
  const actor=clean((auth.user as any)?.email || (auth.user as any)?.user_metadata?.email || 'staff',240) || 'staff';

  if(action==='item-usage'){
    const id=clean(payload?.id,80);
    const catalog=await ensureWebsiteCatalog(context);
    const item=catalog.find(entry=>entry.id===id);
    if(!item)return Response.json({error:'Catalog item not found.'},{status:404});
    return Response.json({ok:true,usage:await itemUsage(context,item)},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(action==='run-audit'){
    const catalog=await ensureWebsiteCatalog(context);
    return Response.json({ok:true,audit:await runCatalogAudit(context,catalog)},{headers:{'Cache-Control':'private, no-store'}});
  }

  if(!hasCapability(auth.user,'sales.profit_settings')){
    return Response.json({error:'Sales Profit Settings permission required to manage the catalog.'},{status:403});
  }

  if(action==='reconcile-safe-audit'){
    const catalog=await ensureWebsiteCatalog(context);
    const result=await reconcileSafeCatalogIssues(context,catalog,actor);
    return Response.json({ok:true,...result});
  }

  if(action==='refresh-website-catalog'){
    const result=await refreshWebsiteCatalog(context,actor);
    return Response.json({ok:true,...result});
  }

  if(action==='save-item'){
    const catalog=await ensureWebsiteCatalog(context);
    const input=payload?.item||{};
    const requestedId=clean(input.id,80);
    const name=clean(input.name,100);
    if(!name)return Response.json({error:'Catalog item name is required.'},{status:400});
    const id=requestedId||slug(name)||('catalog-'+Date.now());
    const prior=catalog.find((item)=>item.id===id);
    const group=normalizeGroup(input.group,prior?.group||'other');
    const item:QuickBooksCatalogItem={
      id,name,
      description:clean(input.description,1000),
      group,
      category:normalizeCategory(input.category,group),
      unitLabel:clean(input.unitLabel,40)||(group==='packages'?'package':'each'),
      unitPrice:money(input.unitPrice),
      internalCost:money(input.internalCost),
      targetMargin:percent(input.targetMargin),
      active:input.active!==false,
      getExempt:input.getExempt===true,
      source:'catalog-manager',
      sourceRef:clean(prior?.sourceRef||'',160),
      quickBooksItemId:clean(prior?.quickBooksItemId||'',80),
      quickBooksItemName:clean(prior?.quickBooksItemName||'',100),
      quickBooksType:prior?.quickBooksType||(group==='rentals'?'NonInventory':'Service'),
      incomeAccountId:clean(prior?.incomeAccountId||'',80),
      incomeAccountName:clean(prior?.incomeAccountName||'',160),
      updatedAt:new Date().toISOString(),
    };
    const next=await saveQuickBooksCatalog(
      context,
      [item,...catalog.filter((entry)=>entry.id!==id)].sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name)),
      {actor,source:'catalog-manager',sourceRef:id,note:'Catalog Manager item save.'},
    );
    return Response.json({ok:true,item,catalog:next});
  }

  if(action==='archive-item'){
    const id=clean(payload?.id,80);
    const catalog=await ensureWebsiteCatalog(context);
    const item=catalog.find((entry)=>entry.id===id);
    if(!item)return Response.json({error:'Catalog item not found.'},{status:404});
    const next=await saveQuickBooksCatalog(
      context,
      catalog.map((entry)=>entry.id===id?{...entry,active:false,updatedAt:new Date().toISOString()}:entry),
      {actor,source:'catalog-manager-archive',sourceRef:id,note:'Catalog Manager item archived.'},
    );
    return Response.json({ok:true,catalog:next});
  }

  if(action==='preview-import' || action==='commit-import'){
    const filename=clean(payload?.filename,180);
    const file=await rowsFromFile(filename,clean(payload?.base64,3_000_000));
    const mapping=(payload?.mapping&&typeof payload.mapping==='object'?payload.mapping:suggestMapping(file.headers)) as ImportMapping;
    const defaultGroup=normalizeGroup(payload?.defaultGroup,'other');
    if(!mapping.name){
      return Response.json({error:'Map one source column to Name before importing.',headers:file.headers,suggestedMapping:suggestMapping(file.headers)},{status:400});
    }
    const catalog=await ensureWebsiteCatalog(context);
    const rows=buildImportRows(file.rows,mapping,defaultGroup,catalog);
    const summary={
      rows:rows.length,
      valid:rows.filter((row)=>!['invalid','duplicate'].includes(row.status)).length,
      new:rows.filter((row)=>row.status==='new').length,
      updates:rows.filter((row)=>row.status==='update').length,
      duplicates:rows.filter((row)=>row.status==='duplicate').length,
      invalid:rows.filter((row)=>row.status==='invalid').length,
    };

    if(action==='preview-import'){
      return Response.json({
        ok:true,headers:file.headers,mapping,suggestedMapping:suggestMapping(file.headers),summary,
        rows:rows.slice(0,100).map((row)=>({rowNumber:row.rowNumber,status:row.status,duplicateId:row.duplicateId,errors:row.errors,item:row.item})),
      });
    }

    const duplicateMode=payload?.duplicateMode==='skip'?'skip':'update';
    const usable=rows.filter((row)=>row.status!=='invalid'&&row.status!=='duplicate'&&(duplicateMode==='update'||row.status!=='update'));
    if(!usable.length)return Response.json({error:'No valid catalog rows are available to import.',summary},{status:400});
    const id=importId();
    const store=storeFor(context);
    await store.setJSON('catalog/imports/snapshots/'+id,{catalog,createdAt:new Date().toISOString(),filename});
    const byId=new Map(catalog.map((item)=>[item.id.toLowerCase(),item]));
    const byName=new Map(catalog.map((item)=>[item.name.toLowerCase(),item]));
    for(const row of usable){
      const existing=byId.get(row.item.id.toLowerCase())||byName.get(row.item.name.toLowerCase());
      const targetId=existing?.id||row.item.id;
      const nextItem:QuickBooksCatalogItem={
        ...(existing||row.item),
        ...row.item,
        id:targetId,
        quickBooksItemId:existing?.quickBooksItemId||'',
        quickBooksItemName:existing?.quickBooksItemName||'',
        quickBooksType:existing?.quickBooksType||row.item.quickBooksType,
        incomeAccountId:existing?.incomeAccountId||'',
        incomeAccountName:existing?.incomeAccountName||'',
        source:'import',
        sourceRef:id,
        updatedAt:new Date().toISOString(),
      };
      byId.set(targetId.toLowerCase(),nextItem);
      if(existing)byName.delete(existing.name.toLowerCase());
      byName.set(nextItem.name.toLowerCase(),nextItem);
    }
    const next=await saveQuickBooksCatalog(
      context,
      [...byId.values()].sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name)),
      {actor,source:'catalog-import',sourceRef:id,note:'Catalog import: '+filename},
    );
    const entry={
      id,filename,createdAt:new Date().toISOString(),createdBy:clean(auth.user?.email,240),
      imported:usable.length,newCount:usable.filter((row)=>row.status==='new').length,
      updatedCount:usable.filter((row)=>row.status==='update').length,duplicateMode,
      afterFingerprint:await catalogFingerprint(next),rolledBackAt:'',
    };
    const imports=await writeImportHistory(context,entry);
    return Response.json({ok:true,catalog:next,import:entry,imports,summary});
  }

  if(action==='rollback-import'){
    const id=clean(payload?.id,100);
    const store=storeFor(context);
    const history=await readImportHistory(context);
    const latestActive=history.find((row:any)=>!row?.rolledBackAt);
    if(!latestActive||latestActive.id!==id){
      return Response.json({error:'Only the most recent active import can be rolled back. Roll back newer imports first so catalog history stays consistent.'},{status:409});
    }
    const snapshot=await store.get('catalog/imports/snapshots/'+id,{type:'json'}) as any;
    if(!snapshot||!Array.isArray(snapshot.catalog))return Response.json({error:'Import rollback snapshot was not found.'},{status:404});
    const currentCatalog=await getQuickBooksCatalog(context);
    if(latestActive.afterFingerprint && await catalogFingerprint(currentCatalog)!==latestActive.afterFingerprint){
      return Response.json({error:'The catalog changed after this import. Automatic rollback is blocked so later manual, profitability, or QuickBooks changes are not lost.'},{status:409});
    }
    const catalog=await saveQuickBooksCatalog(
      context,
      snapshot.catalog,
      {actor,source:'catalog-import-rollback',sourceRef:id,note:'Rolled back catalog import '+id+'.'},
    );
    const previous=history.find((row:any)=>row.id===id);
    const entry={...(previous||{id}),rolledBackAt:new Date().toISOString(),rolledBackBy:clean(auth.user?.email,240)};
    const imports=await writeImportHistory(context,entry);
    return Response.json({ok:true,catalog,imports,rollback:entry});
  }

  return Response.json({error:'Unknown catalog action.'},{status:400});
};

export const config:Config={path:'/api/admin/catalog'};
