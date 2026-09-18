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

export const media = {
  hero: editorial(
    'wedding-forest-couple.jpg',
    'Couple standing among lush trees at an outdoor wedding'
  ),
  venueWide: editorial(
    'garden-wedding-ceremony.jpg',
    'Elegant outdoor garden ceremony beneath mature trees'
  ),
  hospitality: editorial(
    'garden-reception-table.jpg',
    'Refined outdoor reception table arranged on a lawn'
  ),
  mobileBar: editorial(
    'bartender-outdoor-event.jpg',
    'Professional bartender preparing cocktails at an outdoor event'
  ),
  plumeria: editorial(
    'garden-wedding-moment.jpg',
    'Romantic wedding moment in a lush garden setting'
  ),
  hibiscus: editorial(
    'garden-wedding-portrait.jpg',
    'Elegant wedding portrait in a botanical garden'
  ),
  orchid: editorial(
    'botanical-reception.jpg',
    'Polished outdoor reception with botanical floral styling'
  ),
  gardenia: editorial(
    'private-event-detail.jpg',
    'Elegant outdoor celebration detail with styled dessert table'
  ),

  weddingForestCouple: editorial(
    'wedding-forest-couple.jpg',
    'Couple standing among lush trees at an outdoor wedding'
  ),
  gardenCeremony: editorial(
    'garden-wedding-ceremony.jpg',
    'Outdoor garden wedding ceremony beneath a large tree'
  ),
  gardenWeddingMoment: editorial(
    'garden-wedding-moment.jpg',
    'Romantic outdoor wedding moment surrounded by greenery'
  ),
  weddingPortrait: editorial(
    'garden-wedding-portrait.jpg',
    'Elegant couple portrait in a lush garden'
  ),
  receptionTable: editorial(
    'garden-reception-table.jpg',
    'Reception table set outdoors on a green lawn'
  ),
  botanicalReception: editorial(
    'botanical-reception.jpg',
    'Outdoor reception styled with botanical floral decor'
  ),
  venueAtmosphere: editorial(
    'venue-atmosphere.jpg',
    'Warm outdoor wedding venue atmosphere with refined event styling'
  ),
  tableSettings: editorial(
    'garden-table-settings.jpg',
    'Elegant table settings arranged in a garden'
  ),
  rusticTableDetail: editorial(
    'rustic-table-detail.jpg',
    'Outdoor dining table with floral centerpiece and natural textures'
  ),
  eveningReception: editorial(
    'evening-reception.jpg',
    'Elegant outdoor evening reception illuminated after sunset'
  ),
  privateEventDetail: editorial(
    'private-event-detail.jpg',
    'Styled outdoor celebration detail with dessert display'
  ),
  bartenderOutdoor: editorial(
    'bartender-outdoor-event.jpg',
    'Professional bartender mixing drinks at an outdoor event'
  ),
  bartenderDetail: editorial(
    'bartender-detail.jpg',
    'Bartender preparing a crafted drink'
  ),
  tropicalDining: editorial(
    'tropical-resort-dining.jpg',
    'Refined dining table in a tropical outdoor setting'
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
