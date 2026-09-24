import type { Config, Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireCapability } from './_shared/admin';
import {
  ADDON_CATALOG_MAPPING,
  recommendedAddOnPrice,
} from './_shared/wedding-pricing';

const WEDDING_PACKAGE_IDS = ['gardenia','orchid','hibiscus','signature-wedding'] as const;
const COST_KEYS = [
  'laborSetup','flowers','cake','mobileBar','cleaning','cottage',
  'rentalsInventory','coordination','photoBooth','lightingAv',
  'parkingStaffing','otherDirect',
] as const;

type CostKey = (typeof COST_KEYS)[number];
type CostMap = Record<CostKey, number>;

type PackageModel = {
  id: string;
  name: string;
  price: number;
  includedGuests: number;
  targetMargin: number;
  costs: CostMap;
};

type AddOnModel = {
  id: string;
  name: string;
  category: string;
  unit: string;
  directCost: number;
  targetMargin: number;
  sellPrice: number;
  priceIncrement: number;
  note: string;
  catalogItemId: string;
  approved: boolean;
  approvedAt: string;
  approvedBy: string;
};

type EventAddOn = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
};

type ActualEvent = {
  id: string;
  eventName: string;
  eventDate: string;
  packageId: string;
  revenue: number;
  guestCount: number;
  addOns: EventAddOn[];
  crmRecordId: string;
  crmSynced: boolean;
  costs: CostMap;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

type ProfitabilityState = {
  version: 2;
  packages: PackageModel[];
  addOns: AddOnModel[];
  events: ActualEvent[];
  updatedAt: string;
  updatedBy: string;
};

type SalesRecord = {
  id: string;
  kind?: string;
  stage?: string;
  status?: string;
  packageId?: string;
  createdAt?: string;
  updatedAt?: string;
  customer?: { name?: string; email?: string; phone?: string; eventDate?: string; notes?: string };
  inquiry?: Record<string, any>;
  quote?: { state?: Record<string, any> };
  proposal?: {
    status?: string;
    lineItems?: Array<Record<string, any>>;
    subtotal?: number;
    discountAmount?: number;
    taxAmount?: number;
    total?: number;
    depositPercent?: number;
    depositAmount?: number;
    paymentSchedule?: Array<Record<string, any>>;
  };
  booking?: Record<string, any>;
};

function storeFor(context: Context) {
  return context.deploy.context === 'production'
    ? getStore({ name: 'koa-sales', consistency: 'strong' })
    : getDeployStore({ name: 'koa-sales' });
}

function clean(value: unknown, max = 600) {
  return String(value ?? '').trim().slice(0, max);
}

function finite(value: unknown, min = 0, max = 10_000_000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function money(value: unknown) {
  return Math.round(finite(value, 0, 10_000_000) * 100) / 100;
}

function margin(value: unknown, fallback = 0.6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.9, Math.max(0.05, n));
}

function normalizeWeddingPackage(value: unknown) {
  const raw = clean(value, 100).toLowerCase().replaceAll('_','-').replaceAll(' ','-');
  if (raw === 'plumeria' || raw === 'signature' || raw === 'signature-wedding-experience') return 'signature-wedding';
  if (raw.includes('gardenia')) return 'gardenia';
  if (raw.includes('orchid')) return 'orchid';
  if (raw.includes('hibiscus')) return 'hibiscus';
  if (raw.includes('signature')) return 'signature-wedding';
  return raw;
}

function isWeddingPackage(value: unknown): value is (typeof WEDDING_PACKAGE_IDS)[number] {
  return WEDDING_PACKAGE_IDS.includes(normalizeWeddingPackage(value) as any);
}

function emptyCosts(): CostMap {
  return {
    laborSetup:0, flowers:0, cake:0, mobileBar:0, cleaning:0, cottage:0,
    rentalsInventory:0, coordination:0, photoBooth:0, lightingAv:0,
    parkingStaffing:0, otherDirect:0,
  };
}

function normalizeCosts(input: any): CostMap {
  const base = emptyCosts();
  for (const key of COST_KEYS) base[key] = money(input?.[key]);
  return base;
}

function sumCosts(costs: CostMap) {
  return COST_KEYS.reduce((sum, key) => sum + money(costs?.[key]), 0);
}

function defaultPackages(): PackageModel[] {
  return [
    {
      id:'gardenia', name:'Gardenia Intimate Wedding', price:5000, includedGuests:20, targetMargin:0.72,
      costs:{ laborSetup:400,flowers:150,cake:175,mobileBar:0,cleaning:150,cottage:0,rentalsInventory:0,coordination:250,photoBooth:0,lightingAv:0,parkingStaffing:0,otherDirect:0 },
    },
    {
      id:'orchid', name:'Orchid Wedding Day', price:10000, includedGuests:30, targetMargin:0.72,
      costs:{ laborSetup:800,flowers:150,cake:0,mobileBar:0,cleaning:250,cottage:0,rentalsInventory:150,coordination:500,photoBooth:0,lightingAv:75,parkingStaffing:0,otherDirect:0 },
    },
    {
      id:'hibiscus', name:'Hibiscus Wedding Weekend', price:15000, includedGuests:50, targetMargin:0.70,
      costs:{ laborSetup:1200,flowers:150,cake:0,mobileBar:0,cleaning:350,cottage:500,rentalsInventory:250,coordination:900,photoBooth:0,lightingAv:100,parkingStaffing:0,otherDirect:0 },
    },
    {
      id:'signature-wedding', name:'Koa’s Signature Wedding Experience', price:20000, includedGuests:50, targetMargin:0.66,
      costs:{ laborSetup:1500,flowers:1000,cake:500,mobileBar:900,cleaning:400,cottage:500,rentalsInventory:500,coordination:1200,photoBooth:400,lightingAv:300,parkingStaffing:250,otherDirect:300 },
    },
  ];
}

function defaultAddOns(): AddOnModel[] {
  const rows = [
    ['mobile-bar-upgrade','Mobile Bar package upgrade','Mobile Bar','per upgrade',0,0.60,0,50,'Enter the incremental supplies + labor cost between bar package levels.'],
    ['mobile-bar-extra-hour','Mobile Bar additional service hour','Mobile Bar','per hour',0,0.65,200,25,'Current public framework lists $200 per additional hour; enter actual added labor/supply cost to test that price.'],
    ['venue-extra-hour','Venue / event additional hour','Time','per hour',0,0.75,0,50,'Include staff, utilities, cleanup exposure and any overtime in direct cost.'],
    ['floral-upgrade','Floral design upgrade','Design','per upgrade',0,0.45,0,50,'Use vendor invoice + delivery + handling labor as direct cost.'],
    ['cake-upgrade','Cake upgrade / allowance overage','Food','per upgrade',0,0.40,0,25,'Use bakery invoice + pickup/delivery/handling cost.'],
    ['photo-booth-extra-hour','Photo booth additional hour','Entertainment','per hour',0,0.70,0,25,'Include attendant labor and consumables when applicable.'],
    ['decor-upgrade','Premium décor upgrade','Design','per upgrade',0,0.70,0,50,'For Koa-owned inventory, use handling/setup/cleaning plus a wear-and-replacement allowance.'],
    ['rental-upgrade','Rental inventory upgrade','Rentals','per line / bundle',0,0.75,0,25,'Use incremental handling, setup, cleaning and replacement reserve for Koa-owned inventory; use vendor invoice for outside rentals.'],
    ['coordination-extra-hour','Additional coordination hour','Labor','per hour',0,0.65,0,25,'Direct cost should use loaded labor cost, not wage-only cost.'],
  ] as const;
  return rows.map(([id,name,category,unit,directCost,targetMargin,sellPrice,priceIncrement,note]) => ({
    id,name,category,unit,directCost,targetMargin,sellPrice,priceIncrement,note,
    catalogItemId:ADDON_CATALOG_MAPPING[id] || id,
    approved:false, approvedAt:'', approvedBy:'',
  }));
}

function normalizePackage(input: any, fallback: PackageModel): PackageModel {
  return {
    id:fallback.id,
    name:clean(input?.name || fallback.name,120),
    price:money(input?.price ?? fallback.price),
    includedGuests:Math.round(finite(input?.includedGuests ?? fallback.includedGuests,1,500)),
    targetMargin:margin(input?.targetMargin,fallback.targetMargin),
    costs:normalizeCosts(input?.costs ?? fallback.costs),
  };
}

function normalizeAddOn(input: any, fallback: AddOnModel): AddOnModel {
  return {
    id:fallback.id,
    name:clean(input?.name || fallback.name,140),
    category:clean(input?.category || fallback.category,80),
    unit:clean(input?.unit || fallback.unit,80),
    directCost:money(input?.directCost),
    targetMargin:margin(input?.targetMargin,fallback.targetMargin),
    sellPrice:money(input?.sellPrice),
    priceIncrement:Math.max(1,Math.round(finite(input?.priceIncrement ?? fallback.priceIncrement,1,1000))),
    note:clean(input?.note || fallback.note,700),
    catalogItemId:clean(input?.catalogItemId || fallback.catalogItemId,80),
    approved:input?.approved === true,
    approvedAt:clean(input?.approvedAt,60),
    approvedBy:clean(input?.approvedBy,240),
  };
}

function normalizeEventAddOns(input: any): EventAddOn[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0,80).map((row:any,index:number) => ({
    id:clean(row?.id || row?.catalogItemId || 'addon-'+(index+1),80),
    description:clean(row?.description || row?.name,200),
    quantity:Math.max(1,Math.round(finite(row?.quantity,1,500))),
    unitPrice:money(row?.unitPrice),
    amount:money(row?.amount ?? finite(row?.quantity,1,500) * finite(row?.unitPrice)),
  })).filter((row:EventAddOn) => row.description);
}

function normalizeEvent(input: any, existing?: ActualEvent, preserveUpdatedAt = false): ActualEvent {
  const now = new Date().toISOString();
  const eventDate = clean(input?.eventDate,20);
  const savedUpdatedAt = clean(input?.updatedAt,60);
  return {
    id:clean(existing?.id || input?.id,100) || 'event_'+crypto.randomUUID().replaceAll('-','').slice(0,16),
    eventName:clean(input?.eventName,160) || 'Wedding event',
    eventDate:/^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : '',
    packageId:normalizeWeddingPackage(input?.packageId),
    revenue:money(input?.revenue),
    guestCount:Math.round(finite(input?.guestCount,0,500)),
    addOns:normalizeEventAddOns(input?.addOns),
    crmRecordId:clean(input?.crmRecordId,100),
    crmSynced:input?.crmSynced === true,
    costs:normalizeCosts(input?.costs),
    notes:clean(input?.notes,1200),
    createdAt:existing?.createdAt || clean(input?.createdAt,60) || now,
    updatedAt:preserveUpdatedAt && savedUpdatedAt ? savedUpdatedAt : now,
  };
}

async function readSalesRecords(context: Context): Promise<SalesRecord[]> {
  const raw = await storeFor(context).get('records/index',{ type:'json' }) as SalesRecord[] | null;
  return Array.isArray(raw) ? raw : [];
}

function packageIdForRecord(record:SalesRecord) {
  return normalizeWeddingPackage(
    record.packageId ||
    record.quote?.state?.startingPoint ||
    record.inquiry?.venuePackage ||
    record.inquiry?.packageInterest ||
    '',
  );
}

function guestCountForRecord(record:SalesRecord) {
  return Math.round(finite(
    record.quote?.state?.guestCount ??
    record.inquiry?.guestCount ??
    record.inquiry?.estimatedGuestCount ??
    0,
    0,500,
  ));
}

function revenueForRecord(record:SalesRecord) {
  return money(
    record.proposal?.total ??
    record.quote?.state?.estimatedStartingTotal ??
    record.quote?.state?.basePackagePrice ??
    0,
  );
}

function addOnsForRecord(record:SalesRecord) {
  const lines = Array.isArray(record.proposal?.lineItems) ? record.proposal!.lineItems! : [];
  return normalizeEventAddOns(lines.filter((line:any) => {
    const id = clean(line?.id || line?.catalogItemId,80);
    return id !== 'collection' && !WEDDING_PACKAGE_IDS.includes(normalizeWeddingPackage(id) as any);
  }));
}

function isBookedWedding(record:SalesRecord) {
  const packageId = packageIdForRecord(record);
  const booked = record.stage === 'booked' || record.status === 'booked' || record.proposal?.status === 'booked';
  return record.kind === 'proposal' && booked && isWeddingPackage(packageId);
}

function crmEventFromRecord(record:SalesRecord, existing?:ActualEvent): ActualEvent {
  const now = new Date().toISOString();
  const packageId = packageIdForRecord(record);
  return {
    id:existing?.id || 'crm-'+clean(record.id,90),
    eventName:clean(record.customer?.name,160) || existing?.eventName || 'Booked wedding',
    eventDate:clean(record.customer?.eventDate,20),
    packageId,
    revenue:revenueForRecord(record),
    guestCount:guestCountForRecord(record),
    addOns:addOnsForRecord(record),
    crmRecordId:clean(record.id,100),
    crmSynced:true,
    costs:existing?.costs || emptyCosts(),
    notes:existing?.notes || '',
    createdAt:existing?.createdAt || clean(record.createdAt,60) || now,
    updatedAt:existing?.updatedAt || clean(record.updatedAt,60) || now,
  };
}

function mergeCrmEvents(storedEvents:ActualEvent[],records:SalesRecord[]) {
  const savedByCrm = new Map(storedEvents.filter(e=>e.crmRecordId).map(e=>[e.crmRecordId,e]));
  const crmEvents = records.filter(isBookedWedding).map(record=>crmEventFromRecord(record,savedByCrm.get(clean(record.id,100))));
  const crmIds = new Set(crmEvents.map(e=>e.crmRecordId));
  const manualOrHistorical = storedEvents.filter(e=>!e.crmRecordId || !crmIds.has(e.crmRecordId));
  return [...crmEvents,...manualOrHistorical]
    .slice(0,300)
    .sort((a,b)=>(b.eventDate || b.updatedAt).localeCompare(a.eventDate || a.updatedAt));
}

function packagePerformance(records:SalesRecord[],events:ActualEvent[],packages:PackageModel[]) {
  return WEDDING_PACKAGE_IDS.map(packageId => {
    const packageName = packages.find(p=>p.id===packageId)?.name || packageId;
    const rows = records.filter(r=>packageIdForRecord(r)===packageId);
    const inquiries = rows.filter(r=>r.kind==='inquiry').length;
    const proposals = rows.filter(r=>r.kind==='proposal').length;
    const bookedRows = rows.filter(isBookedWedding);
    const bookings = bookedRows.length;
    const bookedValue = bookedRows.reduce((sum,r)=>sum+revenueForRecord(r),0);
    const actualRows = events.filter(e=>e.packageId===packageId && sumCosts(e.costs)>0);
    const realizedRevenue = actualRows.reduce((sum,e)=>sum+e.revenue,0);
    const realizedDirectCost = actualRows.reduce((sum,e)=>sum+sumCosts(e.costs),0);
    const realizedProfit = realizedRevenue-realizedDirectCost;
    return {
      packageId,
      packageName,
      inquiries,
      proposals,
      bookings,
      conversionRate:inquiries>0 ? bookings/inquiries : null,
      proposalConversionRate:proposals>0 ? bookings/proposals : null,
      averageContractValue:bookings>0 ? bookedValue/bookings : null,
      bookedRevenue:bookedValue,
      actualCostEvents:actualRows.length,
      realizedRevenue,
      realizedDirectCost,
      realizedProfit,
      grossMargin:realizedRevenue>0 ? realizedProfit/realizedRevenue : null,
    };
  });
}

function evidenceLeaders(performance:any[]) {
  const totalBookings = performance.reduce((sum,row)=>sum+row.bookings,0);
  const totalActuals = performance.reduce((sum,row)=>sum+row.actualCostEvents,0);
  const bookingSorted = [...performance].sort((a,b)=>b.bookings-a.bookings);
  const profitSorted = [...performance].sort((a,b)=>b.realizedProfit-a.realizedProfit);
  const popularUnique = bookingSorted[0]?.bookings > (bookingSorted[1]?.bookings ?? -1);
  const profitableUnique = profitSorted[0]?.realizedProfit > (profitSorted[1]?.realizedProfit ?? -1);
  return {
    bookingThreshold:5,
    actualCostThreshold:5,
    totalBookings,
    totalActualCostEvents:totalActuals,
    mostPopular:totalBookings>=5 && popularUnique ? bookingSorted[0]?.packageId || null : null,
    mostProfitable:totalActuals>=5 && profitableUnique ? profitSorted[0]?.packageId || null : null,
  };
}

async function readState(context:Context):Promise<ProfitabilityState> {
  const saved = await storeFor(context).get('settings/wedding-profitability',{ type:'json' }) as Partial<ProfitabilityState> | null;
  const defaults = defaultPackages();
  const savedPackages = Array.isArray(saved?.packages) ? saved!.packages! : [];
  const packages = defaults.map(fallback=>normalizePackage(savedPackages.find((row:any)=>clean(row?.id,80)===fallback.id),fallback));

  const addOnDefaults = defaultAddOns();
  const savedAddOns = Array.isArray(saved?.addOns) ? saved!.addOns! : [];
  const addOns = addOnDefaults.map(fallback=>normalizeAddOn(savedAddOns.find((row:any)=>clean(row?.id,80)===fallback.id),fallback));

  const events = (Array.isArray(saved?.events) ? saved!.events! : [])
    .slice(0,300)
    .map((row:any)=>normalizeEvent(row,{
      ...row,
      costs:normalizeCosts(row?.costs),
      createdAt:clean(row?.createdAt,60) || new Date().toISOString(),
      updatedAt:clean(row?.updatedAt,60) || new Date().toISOString(),
    } as ActualEvent,true));

  return {
    version:2,
    packages,
    addOns,
    events,
    updatedAt:clean(saved?.updatedAt,60),
    updatedBy:clean(saved?.updatedBy,240),
  };
}

async function writeState(context:Context,state:ProfitabilityState,actor:string) {
  const next:ProfitabilityState = {
    ...state,
    version:2,
    updatedAt:new Date().toISOString(),
    updatedBy:clean(actor,240),
  };
  await storeFor(context).setJSON('settings/wedding-profitability',next);
  return next;
}

function rebalanceSchedule(rows:any[] | undefined,total:number,depositAmount:number) {
  const input = Array.isArray(rows) ? rows : [];
  if (!input.length) return input;
  const first = { ...input[0], amount:depositAmount };
  const remainingRows = input.slice(1);
  if (!remainingRows.length) return [first];
  const remaining = Math.max(0,money(total-depositAmount));
  const weights = remainingRows.map(row=>Math.max(0,finite(row?.amount)));
  const weightTotal = weights.reduce((sum,value)=>sum+value,0);
  let allocated = 0;
  const balanced = remainingRows.map((row,index)=>{
    const last = index===remainingRows.length-1;
    const amount = last
      ? money(Math.max(0,remaining-allocated))
      : money(weightTotal>0 ? remaining*(weights[index]/weightTotal) : remaining/remainingRows.length);
    allocated = money(allocated+amount);
    return { ...row, amount };
  });
  return [first,...balanced];
}

function recalcDraftProposal(record:SalesRecord,catalogItemId:string,price:number) {
  if (record.kind!=='proposal' || !record.proposal || record.proposal.status!=='draft' || record.stage==='booked') return false;
  const lines = Array.isArray(record.proposal.lineItems) ? record.proposal.lineItems : [];
  let changed = false;
  const nextLines = lines.map((line:any)=>{
    const lineId = clean(line?.catalogItemId || line?.id,80);
    if (lineId!==catalogItemId) return line;
    const quantity = Math.max(1,Math.round(finite(line?.quantity,1,500)));
    changed = true;
    return { ...line, unitPrice:price, amount:money(quantity*price), custom:false };
  });
  if (!changed) return false;

  const subtotal = money(nextLines.reduce((sum:number,line:any)=>sum+finite(line?.amount),0));
  const discountAmount = Math.min(subtotal,money(record.proposal.discountAmount));
  const taxableGross = nextLines.filter((line:any)=>line?.getExempt!==true).reduce((sum:number,line:any)=>sum+finite(line?.amount),0);
  const taxableAfterDiscount = subtotal>0 ? Math.max(0,taxableGross-(discountAmount*taxableGross/subtotal)) : 0;
  const taxRate = 4.712;
  const taxAmount = money(taxableAfterDiscount*taxRate/100);
  const total = money(subtotal-discountAmount+taxAmount);
  const depositPercent = finite(record.proposal.depositPercent,0,100);
  const depositAmount = money(total*depositPercent/100);

  record.proposal = {
    ...record.proposal,
    lineItems:nextLines,
    subtotal,
    discountAmount,
    taxAmount,
    total,
    depositAmount,
    paymentSchedule:rebalanceSchedule(record.proposal.paymentSchedule,total,depositAmount),
  };
  record.updatedAt = new Date().toISOString();
  return true;
}

async function updateDraftProposalPricing(context:Context,catalogItemId:string,price:number) {
  const store = storeFor(context);
  const records = await readSalesRecords(context);
  let updated = 0;
  for (const record of records) {
    if (!recalcDraftProposal(record,catalogItemId,price)) continue;
    await store.setJSON('records/'+record.id,record);
    updated += 1;
  }
  if (updated) await store.setJSON('records/index',records.slice(0,1500));
  return updated;
}

async function responseState(context:Context,state:ProfitabilityState) {
  const records = await readSalesRecords(context);
  const events = mergeCrmEvents(state.events,records);
  const performance = packagePerformance(records,events,state.packages);
  return {
    ...state,
    events,
    crmSync:{
      bookedWeddingCount:records.filter(isBookedWedding).length,
      syncedAt:new Date().toISOString(),
    },
    performance,
    leaders:evidenceLeaders(performance),
  };
}

export default async (req:Request,context:Context) => {
  const auth = await requireCapability('sales.profit_settings',req);
  if (auth.response) return auth.response;

  let state = await readState(context);
  if (req.method==='GET') {
    return Response.json(await responseState(context,state),{ headers:{ 'Cache-Control':'private, no-store' } });
  }
  if (req.method!=='POST') return new Response('Method not allowed',{ status:405 });

  const body:any = await req.json().catch(()=>({}));
  const action = clean(body?.action,60);
  const actor = clean((auth.user as any)?.email || (auth.user as any)?.user_metadata?.email || 'staff',240);

  if (action==='save-packages') {
    const incoming = Array.isArray(body?.packages) ? body.packages : [];
    state.packages = defaultPackages().map(fallback=>normalizePackage(incoming.find((row:any)=>clean(row?.id,80)===fallback.id),fallback));
    state = await writeState(context,state,actor);
    return Response.json({ ok:true,...await responseState(context,state) });
  }

  if (action==='save-addons') {
    const incoming = Array.isArray(body?.addOns) ? body.addOns : [];
    state.addOns = defaultAddOns().map(fallback=>{
      const previous = state.addOns.find(row=>row.id===fallback.id);
      const next = normalizeAddOn(incoming.find((row:any)=>clean(row?.id,80)===fallback.id),fallback);
      if (previous?.approved && (previous.sellPrice!==next.sellPrice || previous.targetMargin!==next.targetMargin || previous.directCost!==next.directCost)) {
        next.approved = false;
        next.approvedAt = '';
        next.approvedBy = '';
      } else if (previous?.approved) {
        next.approved = true;
        next.approvedAt = previous.approvedAt;
        next.approvedBy = previous.approvedBy;
      }
      return next;
    });
    state = await writeState(context,state,actor);
    return Response.json({ ok:true,...await responseState(context,state) });
  }

  if (action==='approve-addon-price') {
    const id = clean(body?.id,80);
    const addon = state.addOns.find(row=>row.id===id);
    if (!addon) return Response.json({ error:'Add-on not found.' },{ status:404 });
    const recommended = recommendedAddOnPrice(addon.directCost,addon.targetMargin,addon.priceIncrement);
    if (recommended<=0) return Response.json({ error:'Enter a direct cost before approving a recommended price.' },{ status:400 });
    addon.sellPrice = money(recommended);
    addon.approved = true;
    addon.approvedAt = new Date().toISOString();
    addon.approvedBy = actor;
    const updatedDraftProposals = await updateDraftProposalPricing(context,addon.catalogItemId,addon.sellPrice);
    state = await writeState(context,state,actor);
    return Response.json({
      ok:true,
      approved:{ id:addon.id,catalogItemId:addon.catalogItemId,price:addon.sellPrice,updatedDraftProposals },
      ...await responseState(context,state),
    });
  }

  if (action==='unpublish-addon-price') {
    const id = clean(body?.id,80);
    const addon = state.addOns.find(row=>row.id===id);
    if (!addon) return Response.json({ error:'Add-on not found.' },{ status:404 });
    addon.approved = false;
    addon.approvedAt = '';
    addon.approvedBy = '';
    state = await writeState(context,state,actor);
    return Response.json({ ok:true,...await responseState(context,state) });
  }

  if (action==='upsert-event') {
    const records = await readSalesRecords(context);
    const merged = mergeCrmEvents(state.events,records);
    const id = clean(body?.event?.id,100);
    const existing = id ? merged.find(row=>row.id===id) : undefined;
    const event = normalizeEvent(body?.event,existing);
    if (!isWeddingPackage(event.packageId)) return Response.json({ error:'Choose a wedding package.' },{ status:400 });
    if (event.revenue<=0) return Response.json({ error:'Enter event revenue.' },{ status:400 });

    if (existing?.crmRecordId) {
      event.crmRecordId = existing.crmRecordId;
      event.crmSynced = true;
      event.eventName = existing.eventName;
      event.eventDate = existing.eventDate;
      event.packageId = existing.packageId;
      event.revenue = existing.revenue;
      event.guestCount = existing.guestCount;
      event.addOns = existing.addOns;
    }
    state.events = [event,...state.events.filter(row=>row.id!==event.id && (!event.crmRecordId || row.crmRecordId!==event.crmRecordId))].slice(0,300);
    state = await writeState(context,state,actor);
    return Response.json({ ok:true,event,...await responseState(context,state) });
  }

  if (action==='delete-event') {
    const id = clean(body?.id,100);
    const row = state.events.find(event=>event.id===id);
    if (row?.crmRecordId) return Response.json({ error:'CRM-synced weddings cannot be deleted here. Update the booking in Sales CRM instead.' },{ status:409 });
    state.events = state.events.filter(event=>event.id!==id);
    state = await writeState(context,state,actor);
    return Response.json({ ok:true,...await responseState(context,state) });
  }

  if (action==='reset-planning-assumptions') {
    state.packages = defaultPackages();
    state.addOns = defaultAddOns();
    state = await writeState(context,state,actor);
    return Response.json({ ok:true,...await responseState(context,state) });
  }

  return Response.json({ error:'Unknown action.' },{ status:400 });
};

export const config:Config = { path:'/api/admin/profitability' };
