import { blogVisuals } from './blogVisuals';
import { galleryMedia, koaMarketingGallery, koaMarketingMedia } from './media';

export type MediaUsage = {
  href: string;
  page: string;
  section: string;
};

const directUsages: Array<[string, MediaUsage]> = [
  [koaMarketingMedia.pavilionTwilightFrontAlt.src, { href:'/about/', page:'About', section:'Hero' }],
  [koaMarketingMedia.pavilionDayLush.src, { href:'/about/', page:'About', section:'Property story' }],
  [koaMarketingMedia.firstDancePavilion.src, { href:'/about/', page:'About', section:'Experience gallery' }],
  [koaMarketingMedia.mobileBarGuestService.src, { href:'/about/', page:'About', section:'Experience gallery' }],
  [koaMarketingMedia.ceremonyVowsCloseup.src, { href:'/about/', page:'About', section:'Experience gallery' }],

  [koaMarketingMedia.pavilionDaywide.src, { href:'/corporate-events/', page:'Corporate Events', section:'Hero' }],
  [koaMarketingMedia.pavilionWelcomeFront.src, { href:'/corporate-events/', page:'Corporate Events', section:'Hospitality + operations' }],

  [koaMarketingMedia.ceremonyLiveCenteredWide.src, { href:'/east-hawaii-wedding-venue/', page:'East Hawaiʻi Wedding Venue', section:'Hero' }],
  [koaMarketingMedia.pavilionWelcomeFront.src, { href:'/east-hawaii-wedding-venue/', page:'East Hawaiʻi Wedding Venue', section:'Property overview' }],
  [koaMarketingMedia.pavilionReceptionWide.src, { href:'/east-hawaii-wedding-venue/', page:'East Hawaiʻi Wedding Venue', section:'Reception setting' }],
  [koaMarketingMedia.ceremonyVowsCloseup.src, { href:'/east-hawaii-wedding-venue/', page:'East Hawaiʻi Wedding Venue', section:'Wedding experience' }],

  [koaMarketingMedia.pavilionSunsetWide.src, { href:'/', page:'Home', section:'Hero' }],
  [koaMarketingMedia.ceremonyVowsCloseup.src, { href:'/', page:'Home', section:'Flagship experience' }],
  [koaMarketingMedia.pavilionDayLush.src, { href:'/', page:'Home', section:'The Koa’s way' }],
  [koaMarketingMedia.tropicalDinnerTable.src, { href:'/', page:'Home', section:'The Koa’s way' }],
  [koaMarketingMedia.ceremonySetupTropical.src, { href:'/', page:'Home', section:'Blank canvas' }],
  [koaMarketingMedia.receptionRustBlue.src, { href:'/', page:'Home', section:'Blank canvas' }],
  [koaMarketingMedia.sweetheartRustBlue.src, { href:'/', page:'Home', section:'Blank canvas' }],
  [koaMarketingMedia.pavilionWelcomeFront.src, { href:'/', page:'Home', section:'Choose the experience · Venue' }],
  [koaMarketingMedia.mobileBarHero.src, { href:'/', page:'Home', section:'Choose the experience · Mobile Bar' }],
  [koaMarketingMedia.pavilionSunsetEvent.src, { href:'/', page:'Home', section:'Choose the experience · Combined' }],
  [koaMarketingMedia.ceremonyLiveSunset.src, { href:'/', page:'Home', section:'Reasons to gather · Weddings' }],
  [koaMarketingMedia.cottagePorchDining.src, { href:'/', page:'Home', section:'Reasons to gather · Private Events' }],
  [koaMarketingMedia.pavilionReceptionDaylightAlt.src, { href:'/', page:'Home', section:'Reasons to gather · Corporate' }],
  [koaMarketingMedia.mobileBarGuestService.src, { href:'/', page:'Home', section:'Mobile Bar feature' }],
  [koaMarketingMedia.firstDancePavilion.src, { href:'/', page:'Home', section:'Lookbook' }],
  [koaMarketingMedia.mobileBarGuestService.src, { href:'/', page:'Home', section:'Lookbook' }],
  [koaMarketingMedia.bridalSuiteWeddingReady.src, { href:'/', page:'Home', section:'Lookbook' }],
  [koaMarketingMedia.cottageExteriorEvents.src, { href:'/', page:'Home', section:'Lookbook' }],
  [koaMarketingMedia.signatureCocktailPour.src, { href:'/', page:'Home', section:'Lookbook' }],

  [koaMarketingMedia.mobileBarGuestService.src, { href:'/mobile-bar/', page:'Mobile Bar', section:'Hero' }],
  [koaMarketingMedia.mobileBarGuestService.src, { href:'/mobile-bar/', page:'Mobile Bar', section:'Service gallery' }],
  [koaMarketingMedia.signatureCocktailPour.src, { href:'/mobile-bar/', page:'Mobile Bar', section:'Service gallery' }],
  [koaMarketingMedia.mobileBarDetail.src, { href:'/mobile-bar/', page:'Mobile Bar', section:'Service gallery' }],
  [koaMarketingMedia.signatureCocktailPour.src, { href:'/mobile-bar/', page:'Mobile Bar', section:'Dry-bar model' }],

  [koaMarketingMedia.cottagePorchDining.src, { href:'/private-events/', page:'Private Events', section:'Hero' }],
  [koaMarketingMedia.pavilionReceptionWide.src, { href:'/private-events/', page:'Private Events', section:'Host here' }],
  [koaMarketingMedia.mobileBarGuestService.src, { href:'/private-events/', page:'Private Events', section:'Bring us to you' }],

  [koaMarketingMedia.pavilionStairsRomantic.src, { href:'/signature-wedding/', page:'Signature Wedding', section:'Hero' }],
  [koaMarketingMedia.pavilionSunsetWide.src, { href:'/signature-wedding/', page:'Signature Wedding', section:'Your private estate' }],
  [koaMarketingMedia.ceremonyLiveGuestView.src, { href:'/signature-wedding/', page:'Signature Wedding', section:'Your ceremony' }],
  [koaMarketingMedia.receptionRustBlue.src, { href:'/signature-wedding/', page:'Signature Wedding', section:'Your reception' }],
  [koaMarketingMedia.mobileBarHero.src, { href:'/signature-wedding/', page:'Signature Wedding', section:'Your bar experience' }],
  [koaMarketingMedia.firstDancePavilion.src, { href:'/signature-wedding/', page:'Signature Wedding', section:'Your celebration' }],
  [koaMarketingMedia.pavilionNightLightingCollage.src, { href:'/signature-wedding/', page:'Signature Wedding', section:'Your planning team' }],

  [koaMarketingMedia.cottageExteriorEvents.src, { href:'/stay/', page:'Stay', section:'Hero' }],
  [koaMarketingMedia.bridalSuiteWeddingReady.src, { href:'/stay/', page:'Stay', section:'Book direct' }],
  [koaMarketingMedia.bridalSuiteWeddingReady.src, { href:'/stay/', page:'Stay', section:'Stay gallery' }],
  [koaMarketingMedia.bridalLoungeWeddingReady.src, { href:'/stay/', page:'Stay', section:'Stay gallery' }],
  [koaMarketingMedia.cottageKitchenetteStyled.src, { href:'/stay/', page:'Stay', section:'Stay gallery' }],
  [koaMarketingMedia.cottageLoftSuite.src, { href:'/stay/', page:'Stay', section:'Stay gallery' }],
  [koaMarketingMedia.cottagePorchDining.src, { href:'/stay/', page:'Stay', section:'Stay gallery' }],
  [koaMarketingMedia.guestBathroomStyled.src, { href:'/stay/', page:'Stay', section:'Stay gallery' }],
  [koaMarketingMedia.cottageExteriorEvents.src, { href:'/stay/', page:'Stay', section:'Property preview' }],

  [koaMarketingMedia.pavilionWelcomeFront.src, { href:'/venue/', page:'Venue', section:'Hero' }],
  [koaMarketingMedia.pavilionDayLush.src, { href:'/venue/', page:'Venue', section:'Property overview' }],
  [koaMarketingMedia.pavilionTwilightFrontAlt.src, { href:'/venue/', page:'Venue', section:'Arrival + gathering' }],
  [koaMarketingMedia.pavilionReceptionDaylightAlt.src, { href:'/venue/', page:'Venue', section:'Open-air celebration' }],
  [koaMarketingMedia.pavilionColorLighting.src, { href:'/venue/', page:'Venue', section:'After dark' }],
  [koaMarketingMedia.pavilionSunsetEvent.src, { href:'/venue/', page:'Venue', section:'Plan with clarity' }],
  [koaMarketingMedia.ceremonyLiveSunset.src, { href:'/venue/packages/', page:'Wedding Packages', section:'Hero' }],

  [koaMarketingMedia.ceremonyLiveCenteredWide.src, { href:'/weddings/', page:'Weddings', section:'Hero' }],
  [koaMarketingMedia.ceremonyGardenAisleSunlit.src, { href:'/weddings/', page:'Weddings', section:'A slower kind of luxury' }],
  [koaMarketingMedia.ceremonyVowsCloseup.src, { href:'/weddings/', page:'Weddings', section:'A slower kind of luxury' }],
  [koaMarketingMedia.firstDancePavilion.src, { href:'/weddings/', page:'Weddings', section:'Signature Wedding' }],
  [koaMarketingMedia.pavilionWelcomeFront.src, { href:'/weddings/', page:'Weddings', section:'Venue option' }],
  [koaMarketingMedia.mobileBarGuestService.src, { href:'/weddings/', page:'Weddings', section:'Mobile Bar option' }],
  [koaMarketingMedia.pavilionSunsetEvent.src, { href:'/weddings/', page:'Weddings', section:'Venue + Bar option' }],
];

const usageMap: Record<string, MediaUsage[]> = {};

function addUsage(src: string, usage: MediaUsage) {
  if (!usageMap[src]) usageMap[src] = [];
  if (!usageMap[src].some((item) => item.href === usage.href && item.section === usage.section)) {
    usageMap[src].push(usage);
  }
}

for (const [src, usage] of directUsages) addUsage(src, usage);

for (const [slug, config] of Object.entries(blogVisuals)) {
  const sources = new Set([...(config.relatedGallery || []), ...Object.keys(config.captions || {})]);
  for (const src of sources) {
    addUsage(src, {
      href: '/blog/' + slug + '/',
      page: 'Blog',
      section: 'Article gallery',
    });
  }
}

for (const item of koaMarketingGallery) {
  addUsage(item.src, {
    href: '/gallery/',
    page: 'Gallery',
    section: item.category,
  });
}

for (const item of galleryMedia) {
  addUsage(item.src, {
    href: '/gallery/',
    page: 'Gallery',
    section: 'Legacy Archive',
  });
}

Object.values(usageMap).forEach((items) => {
  items.sort((a, b) => a.page.localeCompare(b.page) || a.section.localeCompare(b.section));
});

export const mediaUsageBySrc = usageMap;
