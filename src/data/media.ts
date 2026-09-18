export type MediaAsset = {
  src: string;
  alt: string;
  width?: number;
  height?: number;
};

const editorial = (name: string, alt: string): MediaAsset => ({
  src: '/media/editorial/' + name,
  alt,
});

const koa = (name: string, alt: string, width?: number, height?: number): MediaAsset => ({
  src: '/media/koa/' + name,
  alt,
  width,
  height,
});

export const media = {
  homeHero: koa(
    'twilight-tropical-pavilion-wedding-venue.webp',
    "Koa's Events open-air pavilion glowing at twilight on Hawaiʻi Island"
  ),
  koaVenueTwilight: koa(
    'twilight-tropical-pavilion-wedding-venue.webp',
    "Koa's Events pavilion prepared for an evening celebration"
  ),
  koaMobileBar: koa(
    'tropical-golden-hour-wedding-bar.webp',
    "Koa's Mobile Bar trailer styled with tropical florals"
  ),
  koaMobileBarDetail: koa(
    'koa-s-tropical-luxury-mobile-bar.webp',
    "Koa's Mobile Bar service window with tropical styling"
  ),
  koaHospitality: koa(
    'tropical-resort-brunch-tablescape.webp',
    'Tropical tablescape styled for a gathering at Koa’s'
  ),

  hero: koa(
    'twilight-tropical-pavilion-wedding-venue.webp',
    "Koa's Events open-air pavilion glowing at twilight"
  ),
  venueWide: koa(
    'twilight-tropical-pavilion-wedding-venue.webp',
    "Koa's Events pavilion and tropical grounds at twilight"
  ),
  hospitality: koa(
    'tropical-resort-brunch-tablescape.webp',
    'Tropical tablescape styled for a gathering at Koa’s'
  ),
  mobileBar: koa(
    'tropical-golden-hour-wedding-bar.webp',
    "Koa's Mobile Bar trailer styled for an event"
  ),
  plumeria: koa(
    'twilight-tropical-pavilion-wedding-venue.webp',
    "Koa's Events pavilion transformed for an evening wedding"
  ),
  hibiscus: editorial(
    'garden-wedding-portrait.jpg',
    'Elegant wedding portrait in a botanical garden'
  ),
  orchid: editorial(
    'botanical-reception.jpg',
    'Polished outdoor reception with botanical floral styling'
  ),
  gardenia: koa(
    'tropical-resort-brunch-tablescape.webp',
    'Tropical table styling for a private event at Koa’s'
  ),

  weddingForestCouple: editorial(
    'wedding-forest-couple.jpg',
    'Couple standing among lush trees at an outdoor wedding'
  ),
  gardenCeremony: editorial(
    'garden-wedding-ceremony.jpg',
    'Outdoor garden wedding ceremony beneath a large tree'
  ),
  gardenWeddingMoment: koa(
    'twilight-tropical-pavilion-wedding-venue.webp',
    "Koa's Events pavilion transformed for a wedding celebration"
  ),
  weddingPortrait: editorial(
    'garden-wedding-portrait.jpg',
    'Elegant couple portrait in a lush garden'
  ),
  receptionTable: koa(
    'tropical-resort-brunch-tablescape.webp',
    'Styled tropical table setting at Koa’s'
  ),
  botanicalReception: koa(
    'twilight-tropical-pavilion-wedding-venue.webp',
    "Koa's Events pavilion glowing during an evening event"
  ),
  venueAtmosphere: koa(
    'twilight-tropical-pavilion-wedding-venue.webp',
    "Koa's Events pavilion and grounds at twilight"
  ),
  tableSettings: koa(
    'tropical-resort-brunch-tablescape.webp',
    'Tropical table setting showing one way to style Koa’s'
  ),
  rusticTableDetail: koa(
    'koa-s-tropical-luxury-mobile-bar.webp',
    "Koa's Mobile Bar styled with tropical florals and warm wood"
  ),
  eveningReception: koa(
    'twilight-tropical-pavilion-wedding-venue.webp',
    "Koa's Events pavilion illuminated for an evening celebration"
  ),
  privateEventDetail: koa(
    'tropical-resort-brunch-tablescape.webp',
    'Styled table detail for a private gathering at Koa’s'
  ),
  bartenderOutdoor: koa(
    'tropical-golden-hour-wedding-bar.webp',
    "Koa's Mobile Bar styled for an outdoor event"
  ),
  bartenderDetail: koa(
    'koa-s-tropical-luxury-mobile-bar.webp',
    "Koa's Mobile Bar service window and event styling"
  ),
  tropicalDining: koa(
    'tropical-resort-brunch-tablescape.webp',
    'Tropical dining table styled at Koa’s'
  ),
  tropicalBedroom: editorial(
    'tropical-bedroom.jpg',
    'Airy tropical bedroom with natural textures and greenery'
  ),
  tropicalRoomView: editorial(
    'tropical-room-view.jpg',
    'Bright tropical room opening toward palm trees'
  ),
} satisfies Record<string, MediaAsset>;

export const styledGalleryMedia: MediaAsset[] = [
  {
    ...media.homeHero,
    alt: "Styled inspiration: Koa's pavilion transformed for an evening reception",
  },
  {
    ...media.koaMobileBar,
    alt: "Styled inspiration: Koa's Mobile Bar with tropical florals",
  },
  {
    ...media.koaHospitality,
    alt: "Styled inspiration: tropical tablescape at Koa's",
  },
  {
    ...media.koaMobileBarDetail,
    alt: "Styled inspiration: Koa's Mobile Bar service window",
  },
];

const koaMarketing = (name: string, alt: string): MediaAsset => ({
  src: '/media/koa/' + name,
  alt,
});

export const koaMarketingMedia = {
  mobileBarHero: koaMarketing('mobile-bar-hero.webp', 'Koa’s Mobile Bar trailer styled with tropical florals at golden hour'),
  mobileBarDetail: koaMarketing('mobile-bar-detail.webp', 'Koa’s Mobile Bar service window styled for an event'),
  tropicalBrunch: koaMarketing('tropical-brunch.webp', 'Tropical brunch tablescape with blue glassware and island florals'),
  pavilionCeremonyWhite: koaMarketing('pavilion-ceremony-white.webp', 'White floral ceremony aisle inside the Koa’s pavilion'),
  audioGuestbook: koaMarketing('audio-guestbook.webp', 'Vintage phone audio guestbook station with candles and florals'),
  mirrorPhotoBooth: koaMarketing('mirror-photo-booth.webp', 'Guest using a mirrored photo booth at an evening wedding'),
  hexArchStyled: koaMarketing('hex-arch-styled.webp', 'Hexagonal wooden ceremony arch with tropical florals and draping'),
  pavilionReceptionWide: koaMarketing('pavilion-reception-wide.webp', 'Wide reception setup inside the open-air Koa’s pavilion'),
  pavilionWelcomeFront: koaMarketing('pavilion-welcome-front.webp', 'Front entrance of the Koa’s pavilion at golden hour'),
  pavilionSunsetWide: koaMarketing('pavilion-sunset-wide.webp', 'Koa’s pavilion glowing at sunset across the lawn'),
  pavilionDaywide: koaMarketing('pavilion-daywide.webp', 'Koa’s open-air pavilion and lawn in bright daytime'),
  pavilionReceptionEvening: koaMarketing('pavilion-reception-evening.webp', 'Reception tables beneath warm pavilion lights'),
  tropicalDinnerTable: koaMarketing('tropical-dinner-table.webp', 'Tropical dinner table with candles and colorful island florals'),
  pavilionStairsRomantic: koaMarketing('pavilion-stairs-romantic.webp', 'Romantic floral entrance up the pavilion stairs'),
  pavilionNightSide: koaMarketing('pavilion-night-side.webp', 'Side view of the pavilion during an elegant nighttime reception'),
  pavilionFairyLights: koaMarketing('pavilion-fairy-lights.webp', 'Fairy-lit side of the pavilion during an evening reception'),
  champagneFeature: koaMarketing('champagne-feature.webp', 'Blush champagne display and floral reception feature'),
  pavilionSunsetEvent: koaMarketing('pavilion-sunset-event.webp', 'Wedding reception glowing inside the pavilion at sunset'),
  pavilionDayLush: koaMarketing('pavilion-day-lush.webp', 'Koa’s pavilion surrounded by lush tropical landscaping'),
  pavilionColorLighting: koaMarketing('pavilion-color-lighting.webp', 'Pavilion entrance with colorful event uplighting at twilight'),
  ceremonySetupTropical: koaMarketing('ceremony-setup-tropical.webp', 'Tropical ceremony lawn with bamboo seating, lanterns and floral arch'),
  ceremonyLiveSunset: koaMarketing('ceremony-live-sunset.webp', 'Wedding ceremony on the Koa’s lawn at sunset'),
  receptionRustBlue: koaMarketing('reception-rust-blue.webp', 'Reception tables styled in rust, navy and tropical florals inside the pavilion'),
  sweetheartRustBlue: koaMarketing('sweetheart-table-rust-blue.webp', 'Sweetheart table with navy and rust draping, candles and tropical florals'),
  cottageStayCollage: koaMarketing('cottage-stay-collage.webp', 'Staged Koa’s cottage bedroom and kitchen with teal accents'),
  ceremonyGardenAisleSunlit: koaMarketing('ceremony-garden-aisle-sunlit.webp', 'Sunlit ceremony aisle on the Koa’s lawn with tropical floral accents'),
  ceremonyGardenAisleWide: koaMarketing('ceremony-garden-aisle-wide.webp', 'Wide view down a tropical ceremony aisle on the Koa’s lawn'),
  ceremonyLiveCenteredWide: koaMarketing('ceremony-live-centered-wide.webp', 'Centered wide view of a live wedding ceremony on the Koa’s lawn'),
  ceremonyLiveGuestView: koaMarketing('ceremony-live-guest-view.webp', 'Wedding ceremony at Koa’s photographed from the guest seating'),
  ceremonyLiveVertical: koaMarketing('ceremony-live-vertical.webp', 'Vertical view of a live Koa’s wedding ceremony at sunset'),
  ceremonyLiveWide: koaMarketing('ceremony-live-wide.webp', 'Wide live wedding ceremony on the Koa’s lawn with tropical forest backdrop'),
  ceremonyVowsCloseup: koaMarketing('ceremony-vows-closeup.webp', 'Couple exchanging vows during a Koa’s lawn ceremony'),
  firstDancePavilion: koaMarketing('first-dance-pavilion.webp', 'Newlyweds sharing their first dance inside the Koa’s pavilion'),
  pavilionExteriorCollectionCollage: koaMarketing('pavilion-exterior-collection-collage.webp', 'Collection of exterior views showing the Koa’s pavilion and tropical grounds'),
  pavilionExteriorNightCollage: koaMarketing('pavilion-exterior-night-collage.webp', 'Nighttime exterior collage of the Koa’s pavilion and illuminated grounds'),
  pavilionExteriorTwilightCollage: koaMarketing('pavilion-exterior-twilight-collage.webp', 'Twilight exterior collage showing the pavilion across the tropical property'),
  pavilionNightExperienceCollage: koaMarketing('pavilion-night-experience-collage.webp', 'Evening event collage showing the Koa’s pavilion after dark'),
  pavilionNightLightingCollage: koaMarketing('pavilion-night-lighting-collage.webp', 'Night lighting collage showing multiple pavilion lighting looks'),
  pavilionReceptionDaylightAlt: koaMarketing('pavilion-reception-daylight-alt.webp', 'Daylight reception setup inside the open-air Koa’s pavilion'),
  pavilionTwilightFrontAlt: koaMarketing('pavilion-twilight-front-alt.webp', 'Twilight front view of the Koa’s pavilion and landscaped entrance'),
  pavilionVenueShowcaseCollage: koaMarketing('pavilion-venue-showcase-collage.webp', 'Koa’s venue showcase collage featuring the pavilion and tropical grounds'),
} satisfies Record<string, MediaAsset>;

export const koaMarketingGallery = [
  { ...koaMarketingMedia.pavilionSunsetWide, category: 'Venue' },
  { ...koaMarketingMedia.ceremonyLiveSunset, category: 'Ceremony' },
  { ...koaMarketingMedia.receptionRustBlue, category: 'Reception' },
  { ...koaMarketingMedia.mobileBarHero, category: 'Mobile Bar' },
  { ...koaMarketingMedia.pavilionWelcomeFront, category: 'Venue' },
  { ...koaMarketingMedia.pavilionDayLush, category: 'Venue' },
  { ...koaMarketingMedia.pavilionReceptionWide, category: 'Reception' },
  { ...koaMarketingMedia.pavilionStairsRomantic, category: 'Reception' },
  { ...koaMarketingMedia.pavilionFairyLights, category: 'Venue' },
  { ...koaMarketingMedia.pavilionNightSide, category: 'Venue' },
  { ...koaMarketingMedia.pavilionSunsetEvent, category: 'Venue' },
  { ...koaMarketingMedia.pavilionColorLighting, category: 'Venue' },
  { ...koaMarketingMedia.ceremonySetupTropical, category: 'Ceremony' },
  { ...koaMarketingMedia.pavilionCeremonyWhite, category: 'Ceremony' },
  { ...koaMarketingMedia.hexArchStyled, category: 'Ceremony' },
  { ...koaMarketingMedia.pavilionReceptionEvening, category: 'Reception' },
  { ...koaMarketingMedia.tropicalDinnerTable, category: 'Reception' },
  { ...koaMarketingMedia.sweetheartRustBlue, category: 'Reception' },
  { ...koaMarketingMedia.champagneFeature, category: 'Enhancements' },
  { ...koaMarketingMedia.audioGuestbook, category: 'Enhancements' },
  { ...koaMarketingMedia.mirrorPhotoBooth, category: 'Enhancements' },
  { ...koaMarketingMedia.mobileBarDetail, category: 'Mobile Bar' },
  { ...koaMarketingMedia.tropicalBrunch, category: 'Hospitality' },
  { ...koaMarketingMedia.cottageStayCollage, category: 'Stay' },

  // September 2026 gallery additions. Exact duplicate files are intentionally omitted.
  { ...koaMarketingMedia.ceremonyGardenAisleSunlit, category: 'Ceremony' },
  { ...koaMarketingMedia.ceremonyGardenAisleWide, category: 'Ceremony' },
  { ...koaMarketingMedia.ceremonyLiveCenteredWide, category: 'Ceremony' },
  { ...koaMarketingMedia.ceremonyLiveGuestView, category: 'Ceremony' },
  { ...koaMarketingMedia.ceremonyLiveVertical, category: 'Ceremony' },
  { ...koaMarketingMedia.ceremonyLiveWide, category: 'Ceremony' },
  { ...koaMarketingMedia.ceremonyVowsCloseup, category: 'Ceremony' },
  { ...koaMarketingMedia.firstDancePavilion, category: 'Reception' },
  { ...koaMarketingMedia.pavilionReceptionDaylightAlt, category: 'Reception' },
  { ...koaMarketingMedia.pavilionTwilightFrontAlt, category: 'Venue' },
  { ...koaMarketingMedia.pavilionExteriorCollectionCollage, category: 'Venue' },
  { ...koaMarketingMedia.pavilionExteriorNightCollage, category: 'Venue' },
  { ...koaMarketingMedia.pavilionExteriorTwilightCollage, category: 'Venue' },
  { ...koaMarketingMedia.pavilionNightExperienceCollage, category: 'Venue' },
  { ...koaMarketingMedia.pavilionNightLightingCollage, category: 'Venue' },
  { ...koaMarketingMedia.pavilionVenueShowcaseCollage, category: 'Venue' },
];

const galleryIds = [
  '02b2df_f3a265b46b6b47e8a5ea6e1d9bc306c5~mv2.jpg',
  '02b2df_6f409a698f634fb38aedc616443f22d9~mv2.jpg',
  '02b2df_9fc6137f6bbb41c1b56d6b8a4e52c0b2~mv2.jpg',
  '02b2df_1d0515a845054dfb9a41b4da5dd9c1ab~mv2.jpg',
  '02b2df_9f60cf7d8a484f3ebca38106e3ebc6e8~mv2.jpg',
  '02b2df_bec969b83f4f4b44947f72c493323d86~mv2.jpg',
  '02b2df_134e38225674499899ffc87e5684c658~mv2.jpg',
  '02b2df_aba14915428b45348a220f7ab88f3d2a~mv2.jpg',
  '02b2df_97bd06495a3e4da1bd2db314e59cffbe~mv2.jpg',
  '02b2df_3901768201de430cb28eb9f9e7da8332~mv2.jpg',
  '02b2df_213328d005e0446abf493a208f79982f~mv2.jpg',
  '02b2df_1cdc956266954a9c916cc1b4a448903a~mv2.jpg',
  '02b2df_1b178547f4704d59830cbe230824742c~mv2.jpg',
  '02b2df_b151bd1cce124f689fc59d6ded3fea68~mv2.jpg',
  '02b2df_68ad0ae94f7249b8a23133a9856d0564~mv2.jpg',
  '02b2df_9f73076cb26140e4919767f222ab4b36~mv2.jpg',
  '02b2df_af826860522341c5b02a51741ed0b680~mv2.jpg',
  '02b2df_cf32f53725084b5791e4e75a3ea08dc4~mv2.jpg',
  '02b2df_59000d4089b24dbe9d87d0da8e64208b~mv2.jpg',
  '02b2df_bd93259e443d43e48a0f97e35c9433f4~mv2.jpg',
  '02b2df_fab12d12698c452495eda09f64588f1a~mv2.jpg',
  '02b2df_f03a8fe464fe4a78a9aecf5e1f41e8d8~mv2.jpg',
  '02b2df_0718213afe3d42848d994ece03ee18ce~mv2.jpg',
  '02b2df_27f2365122044c91874a59f3a2c9a5d1~mv2.jpg',
  '02b2df_d22caf3eb76643fa906d1c384e808ca3~mv2.jpg',
];

export const galleryMedia: MediaAsset[] = galleryIds.map((id, index) => ({
  src: '/media/wix/' + id,
  alt: "Koa's Events real venue and event gallery photograph " + (index + 1),
  width: 1800,
  height: 1350,
}));

export function netlifyImage(
  source: string,
  width: number,
  height?: number,
  fit: 'cover' | 'contain' | 'fill' = 'cover',
  position: 'center' | 'top' | 'bottom' | 'left' | 'right' = 'center',
  quality = 82,
) {
  const params = new URLSearchParams({
    url: source,
    w: String(width),
    fit,
    position,
    q: String(quality),
  });
  if (height) params.set('h', String(height));
  return '/.netlify/images?' + params.toString();
}

export function netlifySrcSet(
  source: string,
  width: number,
  height: number,
  fit: 'cover' | 'contain' | 'fill' = 'cover',
  position: 'center' | 'top' | 'bottom' | 'left' | 'right' = 'center',
  quality = 82,
) {
  const ratio = height / width;
  const widths = [480, 768, 1024, 1440, 1800].filter((item) => item <= Math.max(width, 1800));
  return widths
    .map((item) => netlifyImage(source, item, Math.round(item * ratio), fit, position, quality) + ' ' + item + 'w')
    .join(', ');
}
