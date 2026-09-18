export type CatalogCategory =
  | 'packages'
  | 'furniture'
  | 'tabletop'
  | 'decor'
  | 'production'
  | 'bar'
  | 'services';

export type CatalogPriceType = 'starting' | 'fixed' | 'per-item' | 'quote' | 'included';

export interface CatalogItem {
  id: string;
  category: CatalogCategory;
  name: string;
  description: string;
  priceType: CatalogPriceType;
  priceLabel: string;
  note?: string;
  featured?: boolean;
  keywords?: string[];
}

export const catalogCategories: { id: 'all' | CatalogCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'packages', label: 'Wedding Packages' },
  { id: 'furniture', label: 'Furniture' },
  { id: 'tabletop', label: 'Tabletop' },
  { id: 'decor', label: 'Décor' },
  { id: 'production', label: 'Production' },
  { id: 'bar', label: 'Mobile Bar' },
  { id: 'services', label: 'Services' },
];

export const catalogItems: CatalogItem[] = [
  {
    id: 'signature-wedding',
    category: 'packages',
    name: 'Koa’s Signature Wedding Experience',
    description: 'Premium wedding weekend experience combining the private property, ceremony and reception foundation, Mobile Bar and coordination support.',
    priceType: 'starting',
    priceLabel: 'Starting at $20,000',
    featured: true,
    keywords: ['plumeria', 'weekend', 'wedding', 'full service'],
  },
  {
    id: 'hibiscus',
    category: 'packages',
    name: 'Hibiscus Wedding Collection',
    description: 'Weekend wedding experience with cottage access, coordination support and an intimate base furniture configuration.',
    priceType: 'starting',
    priceLabel: 'Starting at $8,000',
    keywords: ['weekend', 'cottage', 'wedding'],
  },
  {
    id: 'orchid',
    category: 'packages',
    name: 'Orchid Wedding Collection',
    description: 'One-day venue collection with coordination support and a base furniture configuration.',
    priceType: 'starting',
    priceLabel: 'Starting at $3,000',
    keywords: ['one day', 'venue', 'wedding'],
  },
  {
    id: 'gardenia',
    category: 'packages',
    name: 'Gardenia Wedding Collection',
    description: 'Three-hour Sunday–Thursday intimate wedding starting point built around a 10-guest base configuration.',
    priceType: 'starting',
    priceLabel: 'Starting at $1,500',
    keywords: ['weekday', 'elopement', 'intimate'],
  },

  {
    id: 'ceremony-chair',
    category: 'furniture',
    name: 'Ceremony Chairs',
    description: 'Additional ceremony seating beyond the quantity included in your selected package.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    note: 'Quantity and event configuration determine final pricing.',
    keywords: ['chair', 'seating'],
  },
  {
    id: 'reception-chair',
    category: 'furniture',
    name: 'Reception Chairs',
    description: 'Reception seating added to match your final guest count and floor plan.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['chair', 'seating'],
  },
  {
    id: 'round-table',
    category: 'furniture',
    name: '60-inch Round Tables',
    description: 'Classic reception tables used throughout Koa’s wedding and private-event layouts.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['table', 'round', 'reception'],
  },
  {
    id: 'rectangle-table',
    category: 'furniture',
    name: '6-foot Rectangle Tables',
    description: 'Flexible banquet, service, display or head-table inventory.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['table', 'banquet', 'rectangle'],
  },
  {
    id: 'cocktail-table',
    category: 'furniture',
    name: '36-inch Cocktail Tables',
    description: 'High-top tables for cocktail hour, mingling and bar-adjacent guest flow.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['cocktail', 'high top', 'table'],
  },

  {
    id: 'glassware',
    category: 'tabletop',
    name: 'Glassware',
    description: 'Individual glassware pieces for custom event and bar configurations.',
    priceType: 'per-item',
    priceLabel: '$1.50 / piece',
    note: 'Current published add-on price.',
    keywords: ['barware', 'wine glass', 'champagne'],
  },
  {
    id: 'table-settings',
    category: 'tabletop',
    name: 'Deluxe Table Settings',
    description: 'Elevated place-setting and tablescape support included in the Signature Wedding Experience and available for custom scope.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['place settings', 'dishes', 'flatware', 'tablescape'],
  },
  {
    id: 'tossware',
    category: 'tabletop',
    name: 'Upgraded Tossware',
    description: 'Premium disposable drinkware and serviceware options for events where glassware is not the right fit.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['cups', 'disposable', 'drinkware'],
  },

  {
    id: 'arch-barrels',
    category: 'decor',
    name: 'Ceremony Arch + Whiskey Barrels',
    description: 'Signature ceremony pieces used as a foundation for floral and décor design.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['arbor', 'arch', 'barrel', 'ceremony'],
  },
  {
    id: 'lighting',
    category: 'decor',
    name: 'Lighting Enhancements',
    description: 'Event lighting beyond the venue’s base pavilion lighting, scaled to the space and event design.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['bistro', 'market lights', 'uplight', 'deluxe lighting'],
  },
  {
    id: 'florals',
    category: 'decor',
    name: 'Floral Enhancements',
    description: 'Bouquets, ceremony florals and elevated floral arrangements based on event design and seasonal availability.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['flowers', 'bouquet', 'floral'],
  },
  {
    id: 'lawn-games',
    category: 'decor',
    name: 'Lawn Games',
    description: 'Guest entertainment for cocktail hour and relaxed outdoor portions of the celebration.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['games', 'cocktail hour'],
  },

  {
    id: 'photo-booth',
    category: 'production',
    name: 'Photo Booth',
    description: 'Guest photo experience available within the Signature Wedding Experience and for select custom events.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['photos', 'mirror', 'guest'],
  },
  {
    id: 'audio',
    category: 'production',
    name: 'Audio + Sonos Sound',
    description: 'Venue audio support for announcements and event music within property operating rules.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['speaker', 'sound', 'microphone', 'sonos'],
  },
  {
    id: 'drone-footage',
    category: 'production',
    name: 'Raw Drone Footage',
    description: 'Raw aerial footage included in the Signature Wedding Experience and available by custom scope where conditions permit.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['video', 'aerial', 'drone'],
  },

  {
    id: 'oahu-bar',
    category: 'bar',
    name: 'Oahu Mobile Bar Package',
    description: 'Dry-bar service for beer, champagne and wine under the standard package assumptions.',
    priceType: 'starting',
    priceLabel: 'Starting at $1,200',
    keywords: ['beer', 'wine', 'champagne'],
  },
  {
    id: 'maui-bar',
    category: 'bar',
    name: 'Maui Mobile Bar Package',
    description: 'Beer, champagne, wine and two signature drinks under the standard package assumptions.',
    priceType: 'starting',
    priceLabel: 'Starting at $1,500',
    keywords: ['signature drinks', 'cocktails'],
  },
  {
    id: 'big-island-bar',
    category: 'bar',
    name: 'Big Island Mobile Bar Package',
    description: 'Beer, champagne, wine, two signature drinks and mixed cocktails under the standard package assumptions.',
    priceType: 'starting',
    priceLabel: 'Starting at $1,800',
    featured: true,
    keywords: ['mixed cocktails', 'full bar'],
  },
  {
    id: 'bar-additional-hour',
    category: 'bar',
    name: 'Additional Mobile Bar Service Hour',
    description: 'Additional service time beyond the current four-hour published service framework.',
    priceType: 'fixed',
    priceLabel: '$200 / additional hour',
    note: 'Current published price.',
    keywords: ['extra hour', 'service time'],
  },
  {
    id: 'champagne-toast',
    category: 'bar',
    name: 'Champagne Toast',
    description: 'Add a coordinated champagne toast to your beverage-service plan.',
    priceType: 'starting',
    priceLabel: 'Starting at $70',
    note: 'Current published add-on price.',
    keywords: ['toast', 'champagne'],
  },
  {
    id: 'zero-proof',
    category: 'bar',
    name: 'Zero-Proof Beverage Station',
    description: 'Non-alcoholic beverage service tailored to the event, guest count and menu.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['mocktail', 'soda', 'juice', 'punch', 'coffee'],
  },

  {
    id: 'coordination',
    category: 'services',
    name: 'Day-of Coordination',
    description: 'Event-day operational support available within select wedding collections and custom event scopes.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['coordinator', 'planning'],
  },
  {
    id: 'parking-attendant',
    category: 'services',
    name: 'Parking Attendant',
    description: 'Guest arrival and parking-flow support included in the Signature Wedding Experience and available for custom scope.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['parking', 'arrival'],
  },
  {
    id: 'vendor-coordination',
    category: 'services',
    name: 'Vendor Coordination',
    description: 'Communication and event-day support for approved vendors working at Koa’s.',
    priceType: 'quote',
    priceLabel: 'Custom quote',
    keywords: ['vendors', 'planning', 'coordination'],
  },
];

export const catalogPricingNote =
  'Prices labeled “starting at” are starting prices. Items marked “custom quote” depend on quantity, event scope, availability, logistics and selected package. Final pricing is confirmed in your proposal.';
