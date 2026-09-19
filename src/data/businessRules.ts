export type RuleStatus =
  | 'confirmed'
  | 'published-current'
  | 'conflict'
  | 'needs-owner-confirmation';

export interface Rule<T> {
  value: T;
  status: RuleStatus;
  note?: string;
  source?: string[];
}

export const businessRules = {
  contact: {
    phone: '+1-844-808-5627',
    phoneDisplay: '844-808-KOAS',
    email: 'aloha@koasevents.com',
    venueAddress: '11-3334 Hibiscus St, Mountain View, HI 96771',
    publicMailingAddress: 'PO Box 169, Mountain View, HI 96771',
  },

  brand: {
    tagline: 'Gather beautifully.',
    palette: {
      rainforest: '#173D30',
      forest: '#2D5A45',
      moss: '#5E7656',
      sage: '#91A06A',
      koaDark: '#9A542B',
      koa: '#B96F36',
      koaLight: '#D49553',
      sand: '#D9C9A7',
      ivory: '#FAF7EF',
    },
  },

  venue: {
    pavilionSqFt: {
      value: 1500,
      status: 'published-current',
      source: ['Current Wedding Packages page'],
    } satisfies Rule<number>,
    maximumOccupancy: {
      value: 100,
      status: 'confirmed',
      note:
        'Approved by Christopher for launch on 2026-09-17. Client-facing venue documents were updated to match.',
      source: ['Owner approval', 'Updated Venue Rental Agreement', 'Updated Client Welcome Summary'],
    } satisfies Rule<number>,
    oneDayAccess: {
      value: '12:00 PM–10:00 PM',
      status: 'published-current',
      source: ['Current Orchid package copy'],
    } satisfies Rule<string>,
    weekdayIntimateAccess: {
      value: '3 hours, Sunday–Thursday',
      status: 'published-current',
      source: ['Current Gardenia package copy'],
    } satisfies Rule<string>,
  },

  venueWeddingPackages: [
    {
      name: 'Gardenia',
      position: 'Intimate Weekday',
      price: 1500,
      status: 'published-current' as RuleStatus,
      access: '3 hours, Sunday–Thursday',
      baseConfiguration: 'Designed around an intimate 10-guest base configuration; larger weekday celebrations require a custom quote.',
      includedInventory: '2 60-inch round tables and chairs for 10 guests',
      planningInventory: {
        includedChairCount: 10,
        includedRoundTables: 2,
        tableDescription: '2 60-inch round tables',
      },
      includes: [
        '1,500 sq. ft. party pavilion',
        'Simple bridal bouquet',
        'Cake and champagne toast',
        'Vendor coordinator',
        'Planning assistance',
        'Sonos surround sound',
        'Curated vendor access',
      ],
      source: ['Current Wedding Packages page', 'Current Custom Package Questionnaire'],
    },
    {
      name: 'Orchid',
      position: 'One-Day Venue',
      price: 3000,
      status: 'published-current' as RuleStatus,
      access: '12:00 PM–10:00 PM',
      baseConfiguration: 'One-day venue package; furniture included for 10 guests, with added rentals available for larger events up to the venue maximum.',
      includedInventory: '2 tables of your choice and chairs for 10 guests',
      planningInventory: {
        includedChairCount: 10,
        includedFlexibleTables: 2,
        tableDescription: '2 tables of your choice',
      },
      includes: [
        'Simple bridal bouquet',
        'Premium champagne for toasting',
        'On-site vendor coordination',
        'Sonos surround sound',
        'Curated vendor and rental access',
      ],
      source: ['Current Wedding Packages page', 'Current Custom Package Questionnaire'],
    },
    {
      name: 'Hibiscus',
      position: 'Weekend Experience',
      price: 8000,
      status: 'published-current' as RuleStatus,
      access: 'Weekend cottage access: Friday 3:00 PM–Sunday 11:00 AM',
      baseConfiguration: 'Weekend experience; furniture included for 10 guests, with added rentals available for larger events up to the venue maximum.',
      includedInventory: '2 60-inch round tables and chairs for 10 guests',
      planningInventory: {
        includedChairCount: 10,
        includedRoundTables: 2,
        tableDescription: '2 60-inch round tables',
      },
      includes: [
        'Bridal and Groom Suite Cottage',
        'Simple bridal bouquet',
        'Premium champagne for toasting',
        'Vendor coordinator',
        'Day-of coordination support',
        'Sonos surround sound',
        'Curated vendor and rental access',
      ],
      source: ['Current Wedding Packages page', 'Current Custom Package Questionnaire'],
    },
    {
      name: 'Plumeria',
      position: 'Full-Service Celebration',
      price: 20000,
      status: 'published-current' as RuleStatus,
      access: 'Weekend cottage access: Friday 3:00 PM–Sunday 11:00 AM',
      baseConfiguration: 'Premium full-service package with included seating/rental inventory for 50; added inventory can be quoted for larger events up to the venue maximum.',
      includedInventory: '50 ceremony chairs, 50 reception chairs, 10 round tables, 2 six-foot rectangle tables, and 10 cocktail tables',
      planningInventory: {
        includedCeremonyChairs: 50,
        includedReceptionChairs: 50,
        includedRoundTables: 10,
        includedRectangleTables: 2,
        includedCocktailTables: 10,
        tableDescription: '10 60-inch round tables, 2 six-foot rectangle tables, and 10 cocktail tables',
      },
      includes: [
        'Bridal and Groom Suite Cottage',
        'Koa’s Mobile Bar service under the dry-bar model',
        'Photo booth',
        'Glassware and ice-machine access',
        'Deluxe lighting package',
        'Raw drone footage',
        'Deluxe floral arrangements',
        'Deluxe table settings',
        'Wedding cake',
        'Day-of coordination',
        'Parking attendant',
        'Decorative closet access',
        'Arch and whiskey barrels',
        'Lawn games',
        'Guest phone and card box',
        'Vendor coordinator',
        'Audio equipment and Sonos surround sound',
      ],
      source: ['Current Wedding Packages page', 'Current Custom Package Questionnaire'],
    },
  ],

  mobileBar: {
    model: {
      value:
        'Koa’s Mobile Bar is a dry-bar service. Koa’s does not sell alcohol. The client purchases the alcohol; Koa’s provides professional bar service, planning, setup and the supplies included in the selected package.',
      status: 'confirmed',
      source: ['Owner approval', 'Current Mobile Bar page'],
    } satisfies Rule<string>,
    baseFramework: {
      guestCapacity: {
        value: 'Standard published package framework is built around up to 100 guests. Events above the standard assumptions receive a custom service and staffing quote.',
        status: 'confirmed',
      },
      serviceDuration: {
        value: '4 hours; current public copy lists $200 per additional hour',
        status: 'published-current',
      },
      staffing: {
        value: 'Bartender labor is included within the standard package assumptions. Additional or custom staffing is quoted when guest count, menu complexity, service time or event logistics require it.',
        status: 'confirmed',
      },
      travel: {
        value: 'No travel fee within 20 miles; current public copy lists $1.50/mile after the first 20 miles',
        status: 'published-current',
      },
      ice: {
        value: 'Up to 150 lbs',
        status: 'published-current',
      },
      mixers: {
        value: 'Choice of five mixers',
        status: 'published-current',
      },
    },
    packages: [
      {
        name: 'Oahu',
        price: 1200,
        includes: ['Beer', 'Champagne', 'Wine'],
        status: 'published-current' as RuleStatus,
      },
      {
        name: 'Maui',
        price: 1500,
        includes: ['Beer', 'Champagne', 'Wine', '2 signature drinks'],
        status: 'published-current' as RuleStatus,
      },
      {
        name: 'Big Island',
        price: 1800,
        includes: ['Beer', 'Champagne', 'Wine', '2 signature drinks', 'Mixed cocktails'],
        status: 'published-current' as RuleStatus,
      },
    ],
    bartenderLabor: {
      value: 'Included within standard package assumptions; custom staffing is quoted when required.',
      status: 'confirmed',
      source: ['Owner approval'],
    } satisfies Rule<string>,
    gratuity: {
      value: 'Optional',
      status: 'confirmed',
      source: ['Owner approval'],
    } satisfies Rule<string>,
    tipJar: {
      value: 'No tip jar by default. A client may request one.',
      status: 'confirmed',
      source: ['Owner approval'],
    } satisfies Rule<string>,
    additionalGuestConsumables: {
      value: '$8 per guest over the standard 100-guest framework is currently published for consumables; additional staffing/logistics may also require a custom quote.',
      status: 'published-current',
    } satisfies Rule<string>,
  },

  policies: {
    reservationDeposit: {
      value: '10% non-refundable deposit',
      status: 'confirmed',
      source: ['Venue Rental Agreement', 'Client Welcome Summary'],
    } satisfies Rule<string>,
    paymentSchedule: {
      value: ['Deposit due within 14 days of signing', 'Second payment due 90 days before event', 'Final payment due 60 days before event'],
      status: 'confirmed',
      source: ['Venue Rental Agreement', 'Client Welcome Summary'],
    } satisfies Rule<string[]>,
    lateFee: {
      value: '$150 per occurrence; two missed payments may cancel the event',
      status: 'confirmed',
      source: ['Venue Rental Agreement', 'Client Welcome Summary'],
    } satisfies Rule<string>,
    damageDeposit: {
      value: '$500 one-day / $1,000 weekend; due 30 days before event; refund within 14 days less deductions',
      status: 'confirmed',
      source: ['Client Welcome Summary'],
    } satisfies Rule<string>,
    cancellation: {
      value: 'Cancellation within 15 calendar days of signing receives a full refund; after that, payments are non-refundable.',
      status: 'confirmed',
      source: ['Venue Rental Agreement', 'Cancellation Form'],
    } satisfies Rule<string>,
    dateChange: {
      value:
        'One change may be requested at least eight months before the original event date; $500 single-day / $1,000 weekend change fee.',
      status: 'confirmed',
      source: ['Venue Rental Agreement', 'Client Welcome Summary'],
    } satisfies Rule<string>,
    insurance: {
      value:
        'Event insurance certificate due 60 days before the event. Vendors must be insured; vendor proof is due 30 days before the event.',
      status: 'confirmed',
      source: ['Venue Rental Agreement', 'Event Day Checklist'],
    } satisfies Rule<string>,
    alcohol: {
      value: 'Only pre-approved bartenders; no self-serve bar; no shots after 8:00 PM.',
      status: 'confirmed',
      source: ['Venue Rental Agreement', 'Event Day Checklist'],
    } satisfies Rule<string>,
    music: {
      value: 'Music off by 10:00 PM; checklist states volume under 75 dB.',
      status: 'confirmed',
      source: ['Event Day Checklist'],
    } satisfies Rule<string>,
    setup: {
      value: 'Setup starts no earlier than 12:00 PM unless approved.',
      status: 'confirmed',
      source: ['Event Day Checklist'],
    } satisfies Rule<string>,
  },
} as const;
