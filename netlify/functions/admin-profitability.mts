import type { Config, Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { requireCapability } from './_shared/admin';

const COST_KEYS = [
  'laborSetup',
  'flowers',
  'cake',
  'mobileBar',
  'cleaning',
  'cottage',
  'rentalsInventory',
  'coordination',
  'photoBooth',
  'lightingAv',
  'parkingStaffing',
  'otherDirect',
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
};

type ActualEvent = {
  id: string;
  eventName: string;
  eventDate: string;
  packageId: string;
  revenue: number;
  costs: CostMap;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

type ProfitabilityState = {
  version: 1;
  packages: PackageModel[];
  addOns: AddOnModel[];
  events: ActualEvent[];
  updatedAt: string;
  updatedBy: string;
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

function emptyCosts(): CostMap {
  return {
    laborSetup: 0,
    flowers: 0,
    cake: 0,
    mobileBar: 0,
    cleaning: 0,
    cottage: 0,
    rentalsInventory: 0,
    coordination: 0,
    photoBooth: 0,
    lightingAv: 0,
    parkingStaffing: 0,
    otherDirect: 0,
  };
}

function normalizeCosts(input: any): CostMap {
  const base = emptyCosts();
  for (const key of COST_KEYS) base[key] = money(input?.[key]);
  return base;
}

function defaultPackages(): PackageModel[] {
  return [
    {
      id: 'gardenia',
      name: 'Gardenia Intimate Wedding',
      price: 5000,
      includedGuests: 20,
      targetMargin: 0.72,
      costs: {
        laborSetup: 400,
        flowers: 150,
        cake: 175,
        mobileBar: 0,
        cleaning: 150,
        cottage: 0,
        rentalsInventory: 0,
        coordination: 250,
        photoBooth: 0,
        lightingAv: 0,
        parkingStaffing: 0,
        otherDirect: 0,
      },
    },
    {
      id: 'orchid',
      name: 'Orchid Wedding Day',
      price: 10000,
      includedGuests: 30,
      targetMargin: 0.72,
      costs: {
        laborSetup: 800,
        flowers: 150,
        cake: 0,
        mobileBar: 0,
        cleaning: 250,
        cottage: 0,
        rentalsInventory: 150,
        coordination: 500,
        photoBooth: 0,
        lightingAv: 75,
        parkingStaffing: 0,
        otherDirect: 0,
      },
    },
    {
      id: 'hibiscus',
      name: 'Hibiscus Wedding Weekend',
      price: 15000,
      includedGuests: 50,
      targetMargin: 0.70,
      costs: {
        laborSetup: 1200,
        flowers: 150,
        cake: 0,
        mobileBar: 0,
        cleaning: 350,
        cottage: 500,
        rentalsInventory: 250,
        coordination: 900,
        photoBooth: 0,
        lightingAv: 100,
        parkingStaffing: 0,
        otherDirect: 0,
      },
    },
    {
      id: 'signature-wedding',
      name: 'Koa’s Signature Wedding Experience',
      price: 20000,
      includedGuests: 50,
      targetMargin: 0.66,
      costs: {
        laborSetup: 1500,
        flowers: 1000,
        cake: 500,
        mobileBar: 900,
        cleaning: 400,
        cottage: 500,
        rentalsInventory: 500,
        coordination: 1200,
        photoBooth: 400,
        lightingAv: 300,
        parkingStaffing: 250,
        otherDirect: 300,
      },
    },
  ];
}

function defaultAddOns(): AddOnModel[] {
  return [
    {
      id: 'mobile-bar-upgrade',
      name: 'Mobile Bar package upgrade',
      category: 'Mobile Bar',
      unit: 'per upgrade',
      directCost: 0,
      targetMargin: 0.60,
      sellPrice: 0,
      priceIncrement: 50,
      note: 'Enter the incremental supplies + labor cost between bar package levels.',
    },
    {
      id: 'mobile-bar-extra-hour',
      name: 'Mobile Bar additional service hour',
      category: 'Mobile Bar',
      unit: 'per hour',
      directCost: 0,
      targetMargin: 0.65,
      sellPrice: 200,
      priceIncrement: 25,
      note: 'Current public framework lists $200 per additional hour; enter actual added labor/supply cost to test that price.',
    },
    {
      id: 'venue-extra-hour',
      name: 'Venue / event additional hour',
      category: 'Time',
      unit: 'per hour',
      directCost: 0,
      targetMargin: 0.75,
      sellPrice: 0,
      priceIncrement: 50,
      note: 'Include staff, utilities, cleanup exposure and any overtime in direct cost.',
    },
    {
      id: 'floral-upgrade',
      name: 'Floral design upgrade',
      category: 'Design',
      unit: 'per upgrade',
      directCost: 0,
      targetMargin: 0.45,
      sellPrice: 0,
      priceIncrement: 50,
      note: 'Use vendor invoice + delivery + handling labor as direct cost.',
    },
    {
      id: 'cake-upgrade',
      name: 'Cake upgrade / allowance overage',
      category: 'Food',
      unit: 'per upgrade',
      directCost: 0,
      targetMargin: 0.40,
      sellPrice: 0,
      priceIncrement: 25,
      note: 'Use bakery invoice + pickup/delivery/handling cost.',
    },
    {
      id: 'photo-booth-extra-hour',
      name: 'Photo booth additional hour',
      category: 'Entertainment',
      unit: 'per hour',
      directCost: 0,
      targetMargin: 0.70,
      sellPrice: 0,
      priceIncrement: 25,
      note: 'Include attendant labor and consumables when applicable.',
    },
    {
      id: 'decor-upgrade',
      name: 'Premium décor upgrade',
      category: 'Design',
      unit: 'per upgrade',
      directCost: 0,
      targetMargin: 0.70,
      sellPrice: 0,
      priceIncrement: 50,
      note: 'For Koa-owned inventory, use handling/setup/cleaning plus a wear-and-replacement allowance.',
    },
    {
      id: 'rental-upgrade',
      name: 'Rental inventory upgrade',
      category: 'Rentals',
      unit: 'per line / bundle',
      directCost: 0,
      targetMargin: 0.75,
      sellPrice: 0,
      priceIncrement: 25,
      note: 'Use incremental handling, setup, cleaning and replacement reserve for Koa-owned inventory; use vendor invoice for outside rentals.',
    },
    {
      id: 'coordination-extra-hour',
      name: 'Additional coordination hour',
      category: 'Labor',
      unit: 'per hour',
      directCost: 0,
      targetMargin: 0.65,
      sellPrice: 0,
      priceIncrement: 25,
      note: 'Direct cost should use loaded labor cost, not wage-only cost.',
    },
  ];
}

function normalizePackage(input: any, fallback: PackageModel): PackageModel {
  return {
    id: fallback.id,
    name: clean(input?.name || fallback.name, 120),
    price: money(input?.price ?? fallback.price),
    includedGuests: Math.round(finite(input?.includedGuests ?? fallback.includedGuests, 1, 500)),
    targetMargin: margin(input?.targetMargin, fallback.targetMargin),
    costs: normalizeCosts(input?.costs ?? fallback.costs),
  };
}

function normalizeAddOn(input: any, fallback: AddOnModel): AddOnModel {
  return {
    id: fallback.id,
    name: clean(input?.name || fallback.name, 140),
    category: clean(input?.category || fallback.category, 80),
    unit: clean(input?.unit || fallback.unit, 80),
    directCost: money(input?.directCost),
    targetMargin: margin(input?.targetMargin, fallback.targetMargin),
    sellPrice: money(input?.sellPrice),
    priceIncrement: Math.max(1, Math.round(finite(input?.priceIncrement ?? fallback.priceIncrement, 1, 1000))),
    note: clean(input?.note || fallback.note, 700),
  };
}

function normalizeEvent(input: any, existing?: ActualEvent): ActualEvent {
  const now = new Date().toISOString();
  const eventDate = clean(input?.eventDate, 20);
  return {
    id: clean(existing?.id || input?.id, 80) || 'event_' + crypto.randomUUID().replaceAll('-', '').slice(0, 16),
    eventName: clean(input?.eventName, 160) || 'Wedding event',
    eventDate: /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : '',
    packageId: clean(input?.packageId, 80),
    revenue: money(input?.revenue),
    costs: normalizeCosts(input?.costs),
    notes: clean(input?.notes, 1200),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

async function readState(context: Context): Promise<ProfitabilityState> {
  const saved = await storeFor(context).get('settings/wedding-profitability', { type: 'json' }) as Partial<ProfitabilityState> | null;
  const defaults = defaultPackages();
  const savedPackages = Array.isArray(saved?.packages) ? saved?.packages : [];
  const packages = defaults.map((fallback) => {
    const found = savedPackages.find((row: any) => clean(row?.id, 80) === fallback.id);
    return normalizePackage(found, fallback);
  });

  const addOnDefaults = defaultAddOns();
  const savedAddOns = Array.isArray(saved?.addOns) ? saved?.addOns : [];
  const addOns = addOnDefaults.map((fallback) => {
    const found = savedAddOns.find((row: any) => clean(row?.id, 80) === fallback.id);
    return normalizeAddOn(found, fallback);
  });

  const events = (Array.isArray(saved?.events) ? saved?.events : [])
    .slice(0, 150)
    .map((row: any) => normalizeEvent(row, {
      ...row,
      costs: normalizeCosts(row?.costs),
      createdAt: clean(row?.createdAt, 60) || new Date().toISOString(),
      updatedAt: clean(row?.updatedAt, 60) || new Date().toISOString(),
    } as ActualEvent))
    .sort((a, b) => (b.eventDate || b.updatedAt).localeCompare(a.eventDate || a.updatedAt));

  return {
    version: 1,
    packages,
    addOns,
    events,
    updatedAt: clean(saved?.updatedAt, 60),
    updatedBy: clean(saved?.updatedBy, 240),
  };
}

async function writeState(context: Context, state: ProfitabilityState, actor: string) {
  const next: ProfitabilityState = {
    ...state,
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: clean(actor, 240),
  };
  await storeFor(context).setJSON('settings/wedding-profitability', next);
  return next;
}

export default async (req: Request, context: Context) => {
  const auth = await requireCapability('sales.profit_settings', req);
  if (auth.response) return auth.response;

  const state = await readState(context);
  if (req.method === 'GET') {
    return Response.json(state, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body: any = await req.json().catch(() => ({}));
  const action = clean(body?.action, 60);
  const actor = clean((auth.user as any)?.email || (auth.user as any)?.user_metadata?.email || 'staff', 240);

  if (action === 'save-packages') {
    const incoming = Array.isArray(body?.packages) ? body.packages : [];
    const defaults = defaultPackages();
    state.packages = defaults.map((fallback) => {
      const found = incoming.find((row: any) => clean(row?.id, 80) === fallback.id);
      return normalizePackage(found, fallback);
    });
    const saved = await writeState(context, state, actor);
    return Response.json({ ok: true, ...saved });
  }

  if (action === 'save-addons') {
    const incoming = Array.isArray(body?.addOns) ? body.addOns : [];
    const defaults = defaultAddOns();
    state.addOns = defaults.map((fallback) => {
      const found = incoming.find((row: any) => clean(row?.id, 80) === fallback.id);
      return normalizeAddOn(found, fallback);
    });
    const saved = await writeState(context, state, actor);
    return Response.json({ ok: true, ...saved });
  }

  if (action === 'upsert-event') {
    const id = clean(body?.event?.id, 80);
    const existing = id ? state.events.find((row) => row.id === id) : undefined;
    const event = normalizeEvent(body?.event, existing);
    if (!event.packageId) return Response.json({ error: 'Choose a wedding package.' }, { status: 400 });
    if (event.revenue <= 0) return Response.json({ error: 'Enter event revenue.' }, { status: 400 });
    state.events = [event, ...state.events.filter((row) => row.id !== event.id)].slice(0, 150);
    const saved = await writeState(context, state, actor);
    return Response.json({ ok: true, event, ...saved });
  }

  if (action === 'delete-event') {
    const id = clean(body?.id, 80);
    state.events = state.events.filter((row) => row.id !== id);
    const saved = await writeState(context, state, actor);
    return Response.json({ ok: true, ...saved });
  }

  if (action === 'reset-planning-assumptions') {
    state.packages = defaultPackages();
    state.addOns = defaultAddOns();
    const saved = await writeState(context, state, actor);
    return Response.json({ ok: true, ...saved });
  }

  return Response.json({ error: 'Unknown action.' }, { status: 400 });
};

export const config: Config = { path: '/api/admin/profitability' };
