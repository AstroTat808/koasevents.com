/**
 * Dedicated Foto Master Mirror X photography provided for the rental lookbook.
 * Actual binaries live under public/media/koa/. A page only renders each asset
 * after verifying that the corresponding file has been committed.
 *
 * Keep this manifest in sync with the files in the approved image pack.
 */
export const mirrorXPhotos = [
  {
    src: '/media/koa/mirror-x-guest-experience.webp',
    alt: 'Guest tapping the full-length interactive Mirror X photo booth at a garden celebration',
    width: 1280,
    height: 854,
  },
  {
    src: '/media/koa/mirror-x-interactive-signature.webp',
    alt: 'Guest using the Mirror X touch-screen drawing feature beside her reflection',
    width: 762,
    height: 952,
  },
  {
    src: '/media/koa/mirror-x-wedding-portrait.webp',
    alt: 'Guest in a white dress posing for the full-length Mirror X photo booth',
    width: 452,
    height: 678,
  },
] as const;
