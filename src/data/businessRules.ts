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
    venueAddress: '11-3330 Hibiscus St, Mountain View, HI 96771',
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
      publicName: 'Gardenia Intimate Wedding',
      includedFurnitureCoverage: '20 guests',
      position: 'Intimate Weekday',
      salesLabel: 'Intimate + simple',
      customerFit: 'Best for couples planning a small weekday ceremony and celebration with the essentials already handled.',
      salesDescription: 'A focused four-hour micro-wedding for up to 20 guests with the venue, furniture, a simple floral touch, cake and toast, and venue-focused planning support.',
      price: 5000,
      status: 'published-current' as RuleStatus,
      access: '4-hour celebration, Sunday–Thursday; vendor/setup access confirmed in the final proposal',
      baseConfiguration: 'Intimate weekday micro-wedding collection for up to 20 guests with ceremony/reception furniture, a simple floral and toast foundation, and defined venue planning support.',
      includedInventory: 'Chairs and reception tables for up to 20 guests from Koa’s standard inventory',
      planningInventory: {
        includedChairCount: 20,
        includedRoundTables: 3,
        tableDescription: 'Standard Koa’s reception tables sized for up to 20 guests',
      },
      includes: [
        'Private use of the wedding venue for a 4-hour celebration, Sunday–Thursday',
        'Ceremony and reception chairs for up to 20 guests',
        'Reception tables for up to 20 guests from Koa’s standard inventory',
        '1,500 sq. ft. covered pavilion',
        'Simple bridal bouquet',
        'Small wedding cake and champagne toast sized for up to 20 guests',
        'One planning consultation plus final venue walkthrough',
        'Venue/vendor liaison during the included event window',
        'Sonos audio access',
      ],
      limits: [
        'Designed for up to 20 guests; larger weekday weddings require an upgraded collection or custom proposal.',
        'Planning support is venue-focused and does not replace a full-service wedding planner.',
        'Cake, bouquet and toast upgrades are quoted separately when selections exceed the standard included scope.',
      ],
      addOnRules: [
        'Additional event time is quoted by proposal and subject to availability.',
        'Mobile Bar, photo booth, upgraded florals, specialty rentals, premium décor and expanded coordination are optional add-ons.',
        'Additional inventory beyond the included 20-guest setup is quoted from the rental catalog.',
      ],
      source: ['Current Wedding Packages page', 'Current Custom Package Questionnaire'],
    },
    {
      name: 'Orchid',
      publicName: 'Orchid Wedding Day',
      includedFurnitureCoverage: '30 guests',
      position: 'Full Wedding Day',
      salesLabel: 'Full day',
      customerFit: 'Best for couples who want a complete wedding day at Koa’s without the added cost of a full weekend.',
      salesDescription: 'A full 12 PM–10 PM wedding day for up to 30 guests with ceremony and reception furniture, arch, toast, lighting and venue + vendor coordination.',
      price: 10000,
      status: 'published-current' as RuleStatus,
      access: '12:00 PM–10:00 PM',
      baseConfiguration: 'Full one-day micro-wedding collection for up to 30 guests with ceremony/reception furniture, an arch foundation, and venue + vendor coordination.',
      includedInventory: 'Ceremony/reception chairs and reception tables for up to 30 guests, plus ceremony arch and whiskey barrels',
      planningInventory: {
        includedChairCount: 30,
        includedRoundTables: 4,
        includedRectangleTables: 1,
        tableDescription: 'Standard Koa’s reception tables sized for up to 30 guests',
      },
      includes: [
        'Private venue access from 12:00 PM–10:00 PM',
        'Ceremony and reception chairs for up to 30 guests',
        'Reception tables for up to 30 guests from Koa’s standard inventory',
        'Ceremony arch and whiskey barrels',
        'Simple bridal bouquet',
        'Premium champagne toast sized for up to 30 guests',
        'One planning consultation plus final venue walkthrough',
        'Venue + vendor coordination during the included event window',
        'Standard pavilion lighting and Sonos audio access',
      ],
      limits: [
        'Designed for up to 30 guests; larger weddings require an upgraded collection or additional rental proposal.',
        'Venue + vendor coordination covers property logistics and vendor flow, not full wedding planning or full-service day-of coordination.',
        'Floral, champagne and décor upgrades beyond the standard included scope are quoted separately.',
      ],
      addOnRules: [
        'Day-of coordination, Mobile Bar, photo booth, upgraded florals, specialty rentals and premium décor are optional add-ons.',
        'Additional inventory beyond the included 30-guest setup is quoted from the rental catalog.',
        'Extended access before noon or after 10:00 PM is subject to venue rules, availability and a custom proposal.',
      ],
      source: ['Current Wedding Packages page', 'Current Custom Package Questionnaire'],
    },
    {
      name: 'Hibiscus',
      publicName: 'Hibiscus Wedding Weekend',
      includedFurnitureCoverage: '50 guests',
      position: 'Wedding Weekend',
      salesLabel: 'Recommended',
      customerFit: 'Best for most Koa’s micro-weddings: a relaxed weekend, room for up to 50 guests, and meaningful coordination support without paying for every premium extra.',
      salesDescription: 'A Friday-to-Sunday wedding weekend for up to 50 guests with cottage access, furniture, rehearsal time, décor access and defined day-of coordination support.',
      price: 15000,
      status: 'published-current' as RuleStatus,
      access: 'Weekend cottage access: Friday 3:00 PM–Sunday 11:00 AM',
      baseConfiguration: 'Weekend micro-wedding collection for up to 50 guests with cottage access, ceremony/reception furniture, rehearsal time and defined day-of coordination support.',
      includedInventory: 'Ceremony/reception chairs and reception tables for up to 50 guests, plus ceremony arch and whiskey barrels',
      planningInventory: {
        includedChairCount: 50,
        includedRoundTables: 7,
        includedRectangleTables: 2,
        tableDescription: 'Standard Koa’s reception tables sized for up to 50 guests',
      },
      includes: [
        'Weekend cottage access from Friday 3:00 PM–Sunday 11:00 AM',
        'Bridal and Groom Suite Cottage',
        'Ceremony and reception chairs for up to 50 guests',
        'Reception tables for up to 50 guests from Koa’s standard inventory',
        'Ceremony arch and whiskey barrels',
        'One-hour Friday rehearsal',
        'Simple bridal bouquet',
        'Premium champagne toast sized for up to 50 guests',
        'Defined day-of coordination support for the wedding day',
        'Venue/vendor coordination and final venue walkthrough',
        'Standard pavilion lighting and Sonos audio access',
        'Limited access to Koa’s standard décor closet',
      ],
      limits: [
        'Included furniture is capped at 50 guests; larger configurations require additional rentals and a custom logistics review.',
        'Day-of coordination is limited to the hours stated in the final proposal and does not include full-service planning.',
        'Décor closet access is limited to available standard inventory; premium/specialty pieces are separate rentals.',
      ],
      addOnRules: [
        'Mobile Bar, photo booth, upgraded florals, wedding cake, premium lighting, specialty table settings and additional coordination are optional add-ons.',
        'Additional inventory beyond the included 50-guest setup is quoted from the rental catalog.',
        'Additional rehearsal, setup or event hours are subject to availability and custom pricing.',
      ],
      source: ['Current Wedding Packages page', 'Current Custom Package Questionnaire'],
    },
    {
      name: 'Plumeria',
      publicName: 'Koa’s Signature Wedding Experience',
      includedFurnitureCoverage: '50 ceremony + 50 reception guests',
      position: 'Premium Wedding Weekend',
      salesLabel: 'Most inclusive',
      customerFit: 'Best for couples who want fewer vendors and fewer moving pieces to manage themselves.',
      salesDescription: 'The premium weekend experience for up to 50 guests, adding Mobile Bar service, photo booth, floral and cake allowances, upgraded table settings, lighting and expanded coordination.',
      price: 20000,
      status: 'published-current' as RuleStatus,
      access: 'Weekend cottage access: Friday 3:00 PM–Sunday 11:00 AM',
      baseConfiguration: 'Premium weekend wedding collection for up to 50 guests with a defined Mobile Bar service window, photo booth, floral and cake allowances, upgraded table settings, lighting and coordination support.',
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
        'Weekend cottage access from Friday 3:00 PM–Sunday 11:00 AM',
        'Bridal and Groom Suite Cottage',
        'Ceremony and reception furniture for up to 50 guests',
        'Koa’s Mobile Bar dry-bar service for up to 50 guests for 4 service hours under standard package assumptions',
        'Photo booth for up to 4 hours',
        'Glassware and ice-machine access under standard package assumptions',
        'Deluxe lighting package',
        'Floral design allowance up to $1,000',
        'Deluxe table settings for up to 50 guests from Koa’s Signature collection',
        'Wedding cake allowance up to $500',
        'Defined premium day-of coordination hours plus one-hour rehearsal',
        'Parking attendant during the guest-arrival window stated in the final proposal',
        'Decorative closet access',
        'Arch and whiskey barrels',
        'Lawn games',
        'Guest phone and card box',
        'Vendor coordination',
        'Audio equipment and Sonos surround sound',
      ],
      limits: [
        'Base Signature scope is designed around up to 50 guests; added guest inventory, staffing and consumables are quoted separately.',
        'Mobile Bar includes 4 service hours and standard staffing assumptions; extended service, higher-complexity menus or additional staffing are quoted separately.',
        'Photo booth is capped at 4 hours.',
        'Floral and cake inclusions are allowances; selections above the allowance are billed as upgrades.',
        'Day-of coordination and parking staffing are capped to the hours stated in the final proposal.',
        'Raw drone footage is not part of the base package and may be added only when weather, scheduling and operating conditions allow.',
      ],
      addOnRules: [
        'Raw drone footage is an optional add-on subject to operating conditions.',
        'Premium floral/cake selections above the included allowances are billed as upgrades.',
        'Extended Mobile Bar service, additional bartenders, upgraded glassware, specialty rentals, premium décor and extra coordination hours are quoted separately.',
        'Additional inventory beyond the included 50-guest setup is quoted from the rental catalog.',
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
