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
      value: null,
      status: 'conflict',
      note:
        'Venue rental agreement says 50. Client Welcome Summary says 100. Current public wedding packages generally say 50. Do not publish a master capacity until owner approval.',
      source: ['Venue Rental Agreement', 'Client Welcome Summary', 'Current Wix site'],
    } satisfies Rule<number | null>,
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
      price: 1500,
      status: 'published-current' as RuleStatus,
      summary: 'Weekday intimate ceremony package with three hours of venue access.',
      source: ['Current Wedding Packages page', 'Current Custom Package Questionnaire'],
    },
    {
      name: 'Orchid',
      price: 3000,
      status: 'published-current' as RuleStatus,
      summary: 'One-day wedding package with venue access and planning support.',
      source: ['Current Wedding Packages page', 'Current Custom Package Questionnaire'],
    },
    {
      name: 'Hibiscus',
      price: 8000,
      status: 'published-current' as RuleStatus,
      summary: 'Weekend wedding experience with cottage access and coordination support.',
      source: ['Current Wedding Packages page', 'Current Custom Package Questionnaire'],
    },
    {
      name: 'Plumeria',
      price: 20000,
      status: 'published-current' as RuleStatus,
      summary: 'Top-tier wedding package with expanded rentals, production, décor and hospitality.',
      source: ['Current Wedding Packages page', 'Current Custom Package Questionnaire'],
    },
  ],

  mobileBar: {
    model: {
      value:
        'Dry-bar service: Koa’s does not sell alcohol. The client supplies alcohol; Koa’s provides service, supplies and planning support.',
      status: 'published-current',
      source: ['Current Koa’s Mobile Bar page'],
    } satisfies Rule<string>,
    baseFramework: {
      guestCapacity: {
        value: '100 guests; current public copy lists $8 per additional guest',
        status: 'published-current',
      },
      serviceDuration: {
        value: '4 hours; current public copy lists $200 per additional hour',
        status: 'published-current',
      },
      staffing: {
        value: '1–2 bartenders depending on event size; current public copy lists $40/hour per bartender',
        status: 'published-current',
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
    bartenderCompensation: {
      value: null,
      status: 'conflict',
      note:
        'Current Mobile Bar page says 25% per bartender. Current custom questionnaire offers 10% + tip jar OR 25% with no tip jar. Confirm the policy before final publication.',
      source: ['Current Koa’s Mobile Bar page', 'Current Custom Package Questionnaire'],
    } satisfies Rule<string | null>,
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
