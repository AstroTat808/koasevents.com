export interface PhotoBoothPackage {
  id: 'moment' | 'signature' | 'celebration';
  name: string;
  hours: number;
  price: number;
  eyebrow: string;
  description: string;
  highlights: string[];
}

export const photoBoothPackages: PhotoBoothPackage[] = [
  {
    id: 'moment',
    name: 'The Moment',
    hours: 2,
    price: 795,
    eyebrow: 'For intimate gatherings',
    description: 'A thoughtful addition to cocktail hours, birthdays and smaller celebrations.',
    highlights: [
      '2 hours of staffed Mirror X service',
      'Personalized photo frame',
      'Instant print keepsakes',
      'Post-event digital gallery',
    ],
  },
  {
    id: 'signature',
    name: 'The Signature',
    hours: 3,
    price: 1095,
    eyebrow: 'Our most versatile option',
    description: 'A little more time for wedding receptions and full guest lists.',
    highlights: [
      '3 hours of staffed Mirror X service',
      'Personalized photo frame',
      'Instant print keepsakes',
      'Post-event digital gallery',
      'Your choice of print layout',
    ],
  },
  {
    id: 'celebration',
    name: 'The Celebration',
    hours: 4,
    price: 1395,
    eyebrow: 'For a night worth remembering',
    description: 'Extended service for bigger parties, brand activations and lively receptions.',
    highlights: [
      '4 hours of staffed Mirror X service',
      'Personalized photo frame',
      'Instant print keepsakes',
      'Post-event digital gallery',
      'Your choice of print layout',
      'Priority custom welcome-screen design',
    ],
  },
];

export const photoBoothStandardFeatures = [
  'Foto Master Mirror X interactive full-length mirror',
  'On-site booth attendant, setup and breakdown',
  'Professional camera and integrated lighting',
  'Unlimited photo sessions during the booked service window',
  'Personalized event photo design',
  'Standard on-site photo printing and digital gallery',
];

export const photoBoothEnhancements = [
  {
    name: 'Additional service hour',
    price: '$275 / hour',
    description: 'Keep the camera rolling if your timeline runs longer. Subject to availability.',
  },
  {
    name: 'LED backdrop upgrade',
    price: 'From $175',
    description: 'A luminous setting for the mirror; layout and availability confirmed by quote.',
  },
  {
    name: 'Keepsake guestbook',
    price: 'From $125',
    description: 'Let your guests leave a photo and a note in a book for the host.',
  },
  {
    name: 'Custom branded experience',
    price: 'From $150',
    description: 'Welcome-screen and photo-artwork options for companies and special themes.',
  },
];
