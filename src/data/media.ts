export type MediaAsset = {
  src: string;
  alt: string;
  width?: number;
  height?: number;
};

export const media = {
  hero: {
    src: '/media/wix/02b2df_dbe1e4c043e0401590406df45a251117~mv2.jpg',
    alt: "Koa's Events pavilion illuminated at night in Mountain View, Hawaiʻi",
    width: 1800,
    height: 1200,
  },
  venueWide: {
    src: '/media/wix/02b2df_ef974bce03ba4e3d8e142a172d0acec0~mv2.jpg',
    alt: "Event setting at Koa's Events on Hawaiʻi Island",
    width: 1800,
    height: 1200,
  },
  hospitality: {
    src: '/media/wix/02b2df_aba14915428b45348a220f7ab88f3d2a~mv2.jpg',
    alt: "Koa's Events hospitality and celebration detail",
    width: 1200,
    height: 1600,
  },
  mobileBar: {
    src: '/media/wix/02b2df_9f60cf7d8a484f3ebca38106e3ebc6e8~mv2.jpg',
    alt: "Koa's Mobile Bar set for an event on Hawaiʻi Island",
    width: 1600,
    height: 1100,
  },
  plumeria: {
    src: '/media/wix/02b2df_e52c9276c32541ee81d7a9f9e37ed332~mv2.jpg',
    alt: "Plumeria wedding package setting at Koa's Events",
    width: 1600,
    height: 1050,
  },
  hibiscus: {
    src: '/media/wix/02b2df_42eefaaa7fe94a06b3f8de17227cfe71~mv2.jpg',
    alt: "Hibiscus wedding package setting at Koa's Events",
    width: 1400,
    height: 1000,
  },
  orchid: {
    src: '/media/wix/02b2df_300c97b1e5034a84af4a24b8004d0839~mv2.jpg',
    alt: "Orchid wedding package setting at Koa's Events",
    width: 1400,
    height: 1000,
  },
  gardenia: {
    src: '/media/wix/02b2df_ffed23b2d69e4bb3b12da0482778d19f~mv2.jpg',
    alt: "Gardenia intimate wedding setting at Koa's Events",
    width: 1400,
    height: 1000,
  },
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
  alt: "Koa's Events wedding and venue gallery photograph " + (index + 1),
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
