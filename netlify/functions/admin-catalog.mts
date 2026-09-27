import type { Context, Config } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import readXlsxFile from 'read-excel-file/node';
import { Buffer } from 'node:buffer';
import { hasCapability, requireCapability } from './_shared/admin';
import {
  getQuickBooksCatalog,
  saveQuickBooksCatalog,
  type QuickBooksCatalogItem,
} from './_shared/quickbooks';
import { catalogItems as websiteCatalogItems, type CatalogItem as WebsiteCatalogItem } from '../../src/data/catalog';

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
  return saveQuickBooksCatalog(context,[...byId.values()].sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name)));
}

async function refreshWebsiteCatalog(context: Context) {
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
  const catalog=await saveQuickBooksCatalog(context,[...byId.values()].sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name)));
  return {catalog,added,refreshed};
}

function headerKey(value: unknown) {
  return clean(value,120).toLowerCase().replace(/[^a-z0-9]+/g,'');
}

function suggestMapping(headers: string[]): ImportMapping {
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

function parseCsv(text: string): string[][] {
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

async function rowsFromFile(filename: string, base64: string) {
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

function buildImportRows(rawRows:Record<string,string>[], mapping:ImportMapping, defaultGroup:QuickBooksCatalogItem['group'], catalog:QuickBooksCatalogItem[]):ImportRow[] {
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
    const existing=byId.get(idKey)||byName.get(nameKey);
    let status:ImportRow['status']=existing?'update':'new';
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

export default async (req:Request, context:Context)=>{
  const auth=await requireCapability('sales.view',req);
  if(auth.response)return auth.response;

  if(req.method==='GET'){
    const catalog=await ensureWebsiteCatalog(context);
    const imports=await readImportHistory(context);
    return Response.json({catalog,imports},{headers:{'Cache-Control':'private, no-store'}});
  }
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  if(!hasCapability(auth.user,'sales.profit_settings')){
    return Response.json({error:'Sales Profit Settings permission required to manage the catalog.'},{status:403});
  }

  const payload:any=await req.json().catch(()=>null);
  const action=clean(payload?.action,80);

  if(action==='refresh-website-catalog'){
    const result=await refreshWebsiteCatalog(context);
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
    const next=await saveQuickBooksCatalog(context,[item,...catalog.filter((entry)=>entry.id!==id)].sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name)));
    return Response.json({ok:true,item,catalog:next});
  }

  if(action==='archive-item'){
    const id=clean(payload?.id,80);
    const catalog=await ensureWebsiteCatalog(context);
    const item=catalog.find((entry)=>entry.id===id);
    if(!item)return Response.json({error:'Catalog item not found.'},{status:404});
    const next=await saveQuickBooksCatalog(context,catalog.map((entry)=>entry.id===id?{...entry,active:false,updatedAt:new Date().toISOString()}:entry));
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
    const byId=new Map(catalog.map((item)=>[item.id,item]));
    const byName=new Map(catalog.map((item)=>[item.name.toLowerCase(),item]));
    for(const row of usable){
      const existing=byId.get(row.item.id)||byName.get(row.item.name.toLowerCase());
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
      byId.set(targetId,nextItem);
      byName.set(nextItem.name.toLowerCase(),nextItem);
    }
    const next=await saveQuickBooksCatalog(context,[...byId.values()].sort((a,b)=>a.group.localeCompare(b.group)||a.name.localeCompare(b.name)));
    const entry={
      id,filename,createdAt:new Date().toISOString(),createdBy:clean(auth.user?.email,240),
      imported:usable.length,newCount:usable.filter((row)=>row.status==='new').length,
      updatedCount:usable.filter((row)=>row.status==='update').length,duplicateMode,rolledBackAt:'',
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
    const catalog=await saveQuickBooksCatalog(context,snapshot.catalog);
    const previous=history.find((row:any)=>row.id===id);
    const entry={...(previous||{id}),rolledBackAt:new Date().toISOString(),rolledBackBy:clean(auth.user?.email,240)};
    const imports=await writeImportHistory(context,entry);
    return Response.json({ok:true,catalog,imports,rollback:entry});
  }

  return Response.json({error:'Unknown catalog action.'},{status:400});
};

export const config:Config={path:'/api/admin/catalog'};
