import { blogVisuals } from './blogVisuals';
import { galleryMedia, koaMarketingGallery, koaMarketingMedia } from './media';
import { wixBlogPosts } from './wixBlogPosts';

export type MediaUsage = {
  href: string;
  page: string;
  section: string;
  aspectRatio: string;
  aspectLabel: string;
  impact?: 'high' | 'standard' | 'low';
  impactLabel?: string;
  placementId?: string;
  occurrence?: number;
};

const u = (
  href: string,
  page: string,
  section: string,
  aspectRatio: string,
  aspectLabel: string,
): MediaUsage => ({ href, page, section, aspectRatio, aspectLabel });

const directUsages: Array<[string, MediaUsage]> = [
  [koaMarketingMedia.pavilionTwilightFrontAlt.src, u('/about/', 'About', 'Hero', '16 / 9', 'Desktop hero')],
  [koaMarketingMedia.pavilionDayLush.src, u('/about/', 'About', 'Property story', '4 / 5', 'Tall editorial')],
  [koaMarketingMedia.firstDancePavilion.src, u('/about/', 'About', 'Experience gallery', '3 / 5', 'Tall feature tile')],
  [koaMarketingMedia.mobileBarGuestService.src, u('/about/', 'About', 'Experience gallery', '4 / 3', 'Landscape tile')],
  [koaMarketingMedia.ceremonyVowsCloseup.src, u('/about/', 'About', 'Experience gallery', '4 / 3', 'Landscape tile')],

  [koaMarketingMedia.pavilionDaywide.src, u('/corporate-events/', 'Corporate Events', 'Hero', '16 / 9', 'Desktop hero')],
  [koaMarketingMedia.pavilionWelcomeFront.src, u('/corporate-events/', 'Corporate Events', 'Hospitality + operations', '6 / 5', 'Wide editorial')],

  [koaMarketingMedia.ceremonyLiveCenteredWide.src, u('/east-hawaii-wedding-venue/', 'East Hawaiʻi Wedding Venue', 'Hero', '16 / 9', 'Desktop hero')],
  [koaMarketingMedia.pavilionWelcomeFront.src, u('/east-hawaii-wedding-venue/', 'East Hawaiʻi Wedding Venue', 'Property overview', '6 / 5', 'Wide editorial')],
  [koaMarketingMedia.pavilionReceptionWide.src, u('/east-hawaii-wedding-venue/', 'East Hawaiʻi Wedding Venue', 'Reception setting', '1 / 1', 'Square editorial')],
  [koaMarketingMedia.ceremonyVowsCloseup.src, u('/east-hawaii-wedding-venue/', 'East Hawaiʻi Wedding Venue', 'Wedding experience', '1 / 1', 'Square editorial')],

  [koaMarketingMedia.pavilionSunsetWide.src, u('/', 'Home', 'Hero', '16 / 9', 'Desktop hero')],
  [koaMarketingMedia.ceremonyVowsCloseup.src, u('/', 'Home', 'Flagship experience', '4 / 3', 'Wide feature')],
  [koaMarketingMedia.pavilionDayLush.src, u('/', 'Home', 'The Koa’s way', '4 / 5', 'Tall editorial')],
  [koaMarketingMedia.tropicalDinnerTable.src, u('/', 'Home', 'The Koa’s way', '4 / 5', 'Tall inset')],
  [koaMarketingMedia.ceremonySetupTropical.src, u('/', 'Home', 'Blank canvas', '2 / 3', 'Tall feature tile')],
  [koaMarketingMedia.receptionRustBlue.src, u('/', 'Home', 'Blank canvas', '7 / 5', 'Landscape tile')],
  [koaMarketingMedia.sweetheartRustBlue.src, u('/', 'Home', 'Blank canvas', '7 / 5', 'Landscape tile')],
  [koaMarketingMedia.pavilionWelcomeFront.src, u('/', 'Home', 'Choose the experience · Venue', '4 / 5', 'Portrait card')],
  [koaMarketingMedia.mobileBarHero.src, u('/', 'Home', 'Choose the experience · Mobile Bar', '4 / 5', 'Portrait card')],
  [koaMarketingMedia.pavilionSunsetEvent.src, u('/', 'Home', 'Choose the experience · Combined', '4 / 5', 'Portrait card')],
  [koaMarketingMedia.ceremonyLiveSunset.src, u('/', 'Home', 'Reasons to gather · Weddings', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.cottagePorchDining.src, u('/', 'Home', 'Reasons to gather · Private Events', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.pavilionReceptionDaylightAlt.src, u('/', 'Home', 'Reasons to gather · Corporate', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.mobileBarGuestService.src, u('/', 'Home', 'Mobile Bar feature', '1 / 1', 'Square feature')],
  [koaMarketingMedia.firstDancePavilion.src, u('/', 'Home', 'Lookbook · lead tile', '4 / 3', 'Lead mosaic tile')],
  [koaMarketingMedia.mobileBarGuestService.src, u('/', 'Home', 'Lookbook · upper tile', '16 / 9', 'Wide mosaic tile')],
  [koaMarketingMedia.bridalSuiteWeddingReady.src, u('/', 'Home', 'Lookbook · lower tile', '16 / 9', 'Wide mosaic tile')],
  [koaMarketingMedia.cottageExteriorEvents.src, u('/', 'Home', 'Lookbook · wide tile', '2 / 1', 'Panoramic mosaic tile')],
  [koaMarketingMedia.signatureCocktailPour.src, u('/', 'Home', 'Lookbook · wide tile', '2 / 1', 'Panoramic mosaic tile')],

  [koaMarketingMedia.mobileBarGuestService.src, u('/mobile-bar/', 'Mobile Bar', 'Hero', '16 / 9', 'Desktop hero')],
  [koaMarketingMedia.mobileBarGuestService.src, u('/mobile-bar/', 'Mobile Bar', 'Service gallery', '5 / 6', 'Portrait service card')],
  [koaMarketingMedia.signatureCocktailPour.src, u('/mobile-bar/', 'Mobile Bar', 'Service gallery', '5 / 6', 'Portrait service card')],
  [koaMarketingMedia.mobileBarDetail.src, u('/mobile-bar/', 'Mobile Bar', 'Service gallery', '5 / 6', 'Portrait service card')],
  [koaMarketingMedia.signatureCocktailPour.src, u('/mobile-bar/', 'Mobile Bar', 'Dry-bar model', '1 / 1', 'Square editorial')],

  [koaMarketingMedia.cottagePorchDining.src, u('/private-events/', 'Private Events', 'Hero', '16 / 9', 'Desktop hero')],
  [koaMarketingMedia.pavilionReceptionWide.src, u('/private-events/', 'Private Events', 'Host here', '5 / 4', 'Wide feature')],
  [koaMarketingMedia.mobileBarGuestService.src, u('/private-events/', 'Private Events', 'Bring us to you', '3 / 2', 'Landscape inset')],

  [koaMarketingMedia.pavilionStairsRomantic.src, u('/signature-wedding/', 'Signature Wedding', 'Hero', '16 / 9', 'Desktop hero')],
  [koaMarketingMedia.pavilionSunsetWide.src, u('/signature-wedding/', 'Signature Wedding', 'Your private estate', '1 / 1', 'Square story panel')],
  [koaMarketingMedia.ceremonyLiveGuestView.src, u('/signature-wedding/', 'Signature Wedding', 'Your ceremony', '1 / 1', 'Square story panel')],
  [koaMarketingMedia.receptionRustBlue.src, u('/signature-wedding/', 'Signature Wedding', 'Your reception', '1 / 1', 'Square story panel')],
  [koaMarketingMedia.mobileBarHero.src, u('/signature-wedding/', 'Signature Wedding', 'Your bar experience', '1 / 1', 'Square story panel')],
  [koaMarketingMedia.firstDancePavilion.src, u('/signature-wedding/', 'Signature Wedding', 'Your celebration', '1 / 1', 'Square story panel')],
  [koaMarketingMedia.pavilionNightLightingCollage.src, u('/signature-wedding/', 'Signature Wedding', 'Your planning team', '1 / 1', 'Square story panel')],

  [koaMarketingMedia.cottageExteriorEvents.src, u('/stay/', 'Stay', 'Hero', '16 / 9', 'Desktop hero')],
  [koaMarketingMedia.bridalSuiteWeddingReady.src, u('/stay/', 'Stay', 'Book direct', '6 / 5', 'Wide editorial')],
  [koaMarketingMedia.bridalSuiteWeddingReady.src, u('/stay/', 'Stay', 'Stay gallery', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.bridalLoungeWeddingReady.src, u('/stay/', 'Stay', 'Stay gallery', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.cottageKitchenetteStyled.src, u('/stay/', 'Stay', 'Stay gallery', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.cottageLoftSuite.src, u('/stay/', 'Stay', 'Stay gallery', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.cottagePorchDining.src, u('/stay/', 'Stay', 'Stay gallery', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.guestBathroomStyled.src, u('/stay/', 'Stay', 'Stay gallery', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.cottageExteriorEvents.src, u('/stay/', 'Stay', 'Property preview', '4 / 3', 'Wide feature')],

  [koaMarketingMedia.pavilionWelcomeFront.src, u('/venue/', 'Venue', 'Hero', '16 / 9', 'Desktop hero')],
  [koaMarketingMedia.pavilionDayLush.src, u('/venue/', 'Venue', 'Property overview', '1 / 1', 'Square editorial')],
  [koaMarketingMedia.pavilionTwilightFrontAlt.src, u('/venue/', 'Venue', 'Arrival + gathering', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.pavilionReceptionDaylightAlt.src, u('/venue/', 'Venue', 'Open-air celebration', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.pavilionColorLighting.src, u('/venue/', 'Venue', 'After dark', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.pavilionSunsetEvent.src, u('/venue/', 'Venue', 'Plan with clarity', '6 / 5', 'Wide editorial')],
  [koaMarketingMedia.ceremonyLiveSunset.src, u('/venue/packages/', 'Wedding Packages', 'Hero', '16 / 9', 'Desktop hero')],

  [koaMarketingMedia.ceremonyLiveCenteredWide.src, u('/weddings/', 'Weddings', 'Hero', '16 / 9', 'Desktop hero')],
  [koaMarketingMedia.ceremonyGardenAisleSunlit.src, u('/weddings/', 'Weddings', 'A slower kind of luxury · lead', '4 / 5', 'Tall editorial')],
  [koaMarketingMedia.ceremonyVowsCloseup.src, u('/weddings/', 'Weddings', 'A slower kind of luxury · inset', '4 / 5', 'Tall inset')],
  [koaMarketingMedia.firstDancePavilion.src, u('/weddings/', 'Weddings', 'Signature Wedding', '7 / 5', 'Wide feature')],
  [koaMarketingMedia.pavilionWelcomeFront.src, u('/weddings/', 'Weddings', 'Venue option', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.mobileBarGuestService.src, u('/weddings/', 'Weddings', 'Mobile Bar option', '7 / 5', 'Landscape card')],
  [koaMarketingMedia.pavilionSunsetEvent.src, u('/weddings/', 'Weddings', 'Venue + Bar option', '7 / 5', 'Landscape card')],
];

const usageMap: Record<string, MediaUsage[]> = {};

function classifyImpact(usage: MediaUsage): Pick<MediaUsage, 'impact' | 'impactLabel'> {
  if (usage.page === 'Blog' || usage.page === 'Gallery') {
    return { impact: 'low', impactLabel: 'Lower impact' };
  }

  const highImpactSection =
    usage.section.includes('Hero') ||
    (usage.page === 'Home' && (
      usage.section === 'Flagship experience' ||
      usage.section.startsWith('Choose the experience') ||
      usage.section.startsWith('Reasons to gather')
    )) ||
    (usage.page === 'Weddings' && (
      usage.section === 'Signature Wedding' ||
      usage.section.includes('option') ||
      usage.section.startsWith('A slower kind of luxury')
    )) ||
    (usage.page === 'Signature Wedding' && usage.section.startsWith('Your ')) ||
    (usage.page === 'East Hawaiʻi Wedding Venue' && usage.section === 'Wedding experience') ||
    (usage.page === 'Private Events' && (usage.section === 'Host here' || usage.section === 'Bring us to you')) ||
    (usage.page === 'Mobile Bar' && usage.section === 'Dry-bar model') ||
    (usage.page === 'Venue' && usage.section === 'Plan with clarity');

  return highImpactSection
    ? { impact: 'high', impactLabel: 'High impact' }
    : { impact: 'standard', impactLabel: 'Standard' };
}

const occurrenceBySourceAndPage = new Map<string, number>();

function placementSlug(value: string) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'placement';
}

function placementIdForUsage(usage: MediaUsage) {
  const pageKey = usage.href === '/' ? 'home' : placementSlug(usage.href);
  return [pageKey, placementSlug(usage.section), placementSlug(usage.aspectRatio)].join('__');
}

function addUsage(src: string, usage: MediaUsage) {
  if (!usageMap[src]) usageMap[src] = [];
  const classified = { ...usage, ...classifyImpact(usage) };
  const duplicate = usageMap[src].some((item) =>
    item.href === classified.href &&
    item.section === classified.section &&
    item.aspectRatio === classified.aspectRatio
  );
  if (duplicate) return;

  const occurrenceKey = src + '|' + classified.href;
  const occurrence = occurrenceBySourceAndPage.get(occurrenceKey) || 0;
  occurrenceBySourceAndPage.set(occurrenceKey, occurrence + 1);

  usageMap[src].push({
    ...classified,
    placementId: placementIdForUsage(classified),
    occurrence,
  });
}

for (const [src, usage] of directUsages) addUsage(src, usage);

// Actual article placements: featured images are 16:9, inline article images use
// their editorial body slot, and the related-gallery lead/secondary tiles use
// the exact 16:9 and 4:3 aspect ratios from the blog template.
for (const post of wixBlogPosts) {
  if (post.featuredImage) {
    addUsage(post.featuredImage, u(
      '/blog/' + post.slug + '/',
      'Blog',
      'Featured image',
      '16 / 9',
      'Article hero',
    ));
  }

  for (const image of post.images || []) {
    if (image.role !== 'inline') continue;
    addUsage(image.src, u(
      '/blog/' + post.slug + '/',
      'Blog',
      'Inline article image',
      '4 / 3',
      'Article image',
    ));
  }
}

for (const [slug, config] of Object.entries(blogVisuals)) {
  (config.relatedGallery || []).forEach((src, index) => {
    addUsage(src, u(
      '/blog/' + slug + '/',
      'Blog',
      index === 0 ? 'Related gallery · lead' : 'Related gallery',
      index === 0 ? '16 / 9' : '4 / 3',
      index === 0 ? 'Lead gallery tile' : 'Gallery tile',
    ));
  });
}

for (const item of koaMarketingGallery) {
  addUsage(item.src, u(
    '/gallery/',
    'Gallery',
    item.category,
    '4 / 5',
    'Mobile gallery card',
  ));
}

for (const item of galleryMedia) {
  addUsage(item.src, u(
    '/gallery/',
    'Gallery',
    'Legacy Archive',
    '4 / 3',
    'Archive grid tile',
  ));
}

Object.values(usageMap).forEach((items) => {
  items.sort((a, b) =>
    a.page.localeCompare(b.page) ||
    a.section.localeCompare(b.section) ||
    a.aspectRatio.localeCompare(b.aspectRatio)
  );
});

export const mediaUsageBySrc = usageMap;
