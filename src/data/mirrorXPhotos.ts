/**
 * Dedicated Foto Master Mirror X photography provided for the rental lookbook.
 * Actual binaries live under public/media/koa/. A page only renders each asset
 * after verifying that the corresponding file has been committed.
 *
 * Keep this manifest in sync with the files in the approved image pack.
 */
export const mirrorXPhotos = [
  {
    src: '/media/koa/mirror-x-interactive-signature.webp',
    alt: 'Mirror X example: a guest signs her photo on the full-length interactive touchscreen',
    width: 762,
    height: 952,
  },
  {
    src: '/media/koa/mirror-x-guest-experience.webp',
    alt: 'Mirror X example: a guest taps the photo booth screen during a garden celebration',
    width: 1280,
    height: 854,
  },
  {
    src: '/media/koa/mirror-x-wedding-portrait.webp',
    alt: 'Guest in a white dress posing for the full-length Mirror X photo booth',
    width: 452,
    height: 678,
  },
] as const;
