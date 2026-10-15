import { galleryMedia } from './media';

// These are original Koa's Wix venue/event archive photographs.
// The archive does not identify which home (if either) each photo depicts.
// Never relabel the images as photos of a specific home without verification.
export const lodgingHomes = [
  {
    id: 'three-bedroom',
    eyebrow: 'Home one',
    title: 'Three-bedroom home',
    bedrooms: 3,
    bathrooms: 2,
    photo: galleryMedia[0],
    photoVerifiedForHome: false,
  },
  {
    id: 'two-bedroom',
    eyebrow: 'Home two',
    title: 'Two-bedroom home',
    bedrooms: 2,
    bathrooms: 1,
    photo: galleryMedia[1],
    photoVerifiedForHome: false,
  },
] as const;

export const combinedOvernightCapacity = 10;

export const lodgingPreferences = [
  { value: 'three-bedroom', label: 'Three-bedroom home (3 bedrooms · 2 bathrooms)' },
  { value: 'two-bedroom', label: 'Two-bedroom home (2 bedrooms · 1 bathroom)' },
  { value: 'both', label: 'Both homes (up to 10 overnight guests combined)' },
  { value: 'either', label: 'Either home — flexible' },
] as const;
