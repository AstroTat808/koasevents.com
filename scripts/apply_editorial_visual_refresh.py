#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

MEDIA_TS = r'''export type MediaAsset = {
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
'''

def write(path, content):
    p = ROOT / path
    p.write_text(content, encoding='utf-8')

def patch(path, replacements):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    original = text
    for old, new in replacements:
        if old not in text:
            print(f'warning: pattern not found in {path}: {old[:90]!r}')
        text = text.replace(old, new)
    if text != original:
        p.write_text(text, encoding='utf-8')
        print(f'patched {path}')

def main():
    write('src/data/media.ts', MEDIA_TS)
    print('rewrote src/data/media.ts')

    # Homepage: editorial-only marketing photography and less hero CTA competition.
    patch('src/pages/index.astro', [
        ("import { media, galleryMedia } from '../data/media';", "import { media } from '../data/media';"),
        ("const celebrations = [", "const homepageLookbook = [media.weddingPortrait, media.receptionTable, media.bartenderDetail, media.eveningReception, media.privateEventDetail];\n\nconst celebrations = ["),
        ("          <a href=\"/gallery/\" class=\"rounded-full border border-white/45 px-6 py-3.5 text-xs font-black uppercase tracking-[.13em] text-white backdrop-blur\">View the gallery</a>\n", ""),
        ("{galleryMedia.slice(0,5).map((image,index)=>", "{homepageLookbook.map((image,index)=>"),
    ])

    # Weddings: keep one primary and one secondary hero action, use editorial imagery only.
    patch('src/pages/weddings/index.astro', [
        ("import { media, galleryMedia } from '../../data/media';", "import { media } from '../../data/media';"),
        ("<a href=\"/gallery/\" class=\"rounded-full border border-white/45 px-6 py-3.5 text-xs font-black uppercase tracking-[.12em]\">See the gallery</a>", ""),
        ("<ResponsiveImage {...galleryMedia[7]}", "<ResponsiveImage {...media.weddingPortrait}"),
    ])

    # Signature Wedding: each section gets a distinct professional image.
    patch('src/pages/signature-wedding/index.astro', [
        ("import { media, galleryMedia } from '../../data/media';", "import { media } from '../../data/media';"),
        ("image:galleryMedia[8]", "image:media.privateEventDetail"),
        ("image:galleryMedia[12]", "image:media.eveningReception"),
    ])

    # Venue: avoid pretending stock architecture is Koa's property; use lifestyle/atmosphere imagery,
    # and direct visitors to the real-property Gallery for documentary photography.
    patch('src/pages/venue/index.astro', [
        ("import { media, galleryMedia } from '../../data/media';", "import { media } from '../../data/media';"),
        ("View the property</a>", "See real Koa’s photos</a>"),
        ("['Arrival + gathering','A private Mountain View setting that gives guests a clear sense of arrival and hosts room to shape the flow.',galleryMedia[2]]",
         "['Arrival + gathering','A private Mountain View setting that gives guests a clear sense of arrival and hosts room to shape the flow.',media.weddingPortrait]"),
        ("['Open-air celebration','The pavilion provides a covered center for dining, dancing, entertainment and weather-aware planning.',media.venueWide]",
         "['Open-air celebration','The pavilion provides a covered center for dining, dancing, entertainment and weather-aware planning.',media.receptionTable]"),
        ("['After dark','Lighting, music and hospitality shift the property into a warmer evening atmosphere without losing the island setting.',media.hero]",
         "['After dark','Lighting, music and hospitality shift the property into a warmer evening atmosphere without losing the island setting.',media.eveningReception]"),
        ("<ResponsiveImage {...galleryMedia[6]}", "<ResponsiveImage {...media.rusticTableDetail}"),
        ("<ResponsiveImage {...media.hero} width={1200} height={1400}", "<ResponsiveImage {...media.venueAtmosphere} width={1200} height={1400}"),
    ])

    patch('src/pages/mobile-bar/index.astro', [
        ("import { media, galleryMedia } from '../../data/media';", "import { media } from '../../data/media';"),
        ("<ResponsiveImage {...galleryMedia[8]}", "<ResponsiveImage {...media.bartenderDetail}"),
    ])

    # Stay page: professional lifestyle imagery, while copy remains clear that bookings/details are confirmed directly.
    patch('src/pages/stay/index.astro', [
        ("import { media, galleryMedia } from '../../data/media';", "import { media } from '../../data/media';"),
        ("<ResponsiveImage {...media.venueWide} width={1900}", "<ResponsiveImage {...media.tropicalRoomView} width={1900}"),
        ("<ResponsiveImage {...galleryMedia[6]}", "<ResponsiveImage {...media.tropicalBedroom}"),
        ("Instead of sending guests through a third-party marketplace, the new site is being structured to handle lodging inquiries directly. For now, we confirm dates and stay details personally; a live availability/payment booking system can be added after the stay product, rates and policies are fully standardized.",
         "Stay requests begin directly with Koa’s rather than a third-party marketplace. We confirm dates and stay details personally. A live availability and payment system can be added after rates, occupancy and lodging policies are fully standardized."),
    ])

    patch('src/pages/corporate-events/index.astro', [
        ("import { media, galleryMedia } from '../../data/media';", "import { media } from '../../data/media';"),
        ("<ResponsiveImage {...galleryMedia[12]}", "<ResponsiveImage {...media.tableSettings}"),
    ])

    patch('src/pages/private-events/index.astro', [
        ("import { media, galleryMedia } from '../../data/media';", "import { media } from '../../data/media';"),
        ("<ResponsiveImage {...galleryMedia[10]}", "<ResponsiveImage {...media.privateEventDetail}"),
    ])

    patch('src/pages/venue/packages/index.astro', [
        ("const hero='/media/wix/02b2df_e52c9276c32541ee81d7a9f9e37ed332~mv2.jpg';",
         "const hero='/media/editorial/garden-wedding-moment.jpg';"),
        ("alt=\"Wedding package setting at Koa's Events\"",
         "alt=\"Romantic outdoor wedding moment in a lush garden\""),
    ])

    # Make the gallery's role explicit: this is where visitors see real Koa's photography.
    patch('src/pages/gallery/index.astro', [
        ("Explore Koa’s Events through an editorial gallery of the Mountain View venue, celebrations and event details on Hawaiʻi Island.",
         "See real photographs from Koa’s Events: the Mountain View venue, celebrations and event details on Hawaiʻi Island."),
        ("Rainforest greens, warm light, open-air celebrations and the details that make an event feel considered rather than staged.",
         "These are real photographs from Koa’s Events—venue moments, celebrations and details captured on the property and at our events."),
        ("This gallery is intentionally image-led. Open any photograph to view it larger, then move through the collection with the arrows or your keyboard.",
         "This is the documentary side of the site: real Koa’s photography rather than editorial brand imagery. Open any photograph to view it larger, then move through the collection with the arrows or your keyboard."),
    ])

    # Reduce mobile header footprint.
    patch('src/components/Header.astro', [
        ('<div class="container-shell pt-4 sm:pt-5">', '<div class="container-shell pt-2.5 sm:pt-4">'),
        ('top-[6.35rem]', 'top-[5.45rem]'),
    ])

    css_path = ROOT / 'src/styles/global.css'
    css = css_path.read_text(encoding='utf-8')
    marker = '/* 2026 UX refinement pass */'
    if marker not in css:
        css += r'''

/* 2026 UX refinement pass */
@media (max-width: 767px) {
  .site-nav-shell {
    min-height: 4.15rem;
    padding: .4rem .55rem;
  }

  .brand-medallion {
    width: 2.5rem;
    height: 2.5rem;
  }

  .brand-medallion img {
    width: 1.95rem;
    height: 1.95rem;
  }

  .site-brand {
    gap: .58rem;
  }

  .site-brand-name {
    font-size: 1.28rem;
    line-height: .95;
  }

  .site-menu-trigger {
    gap: .42rem;
    padding: .65rem .78rem;
    font-size: .61rem;
  }

  main h1.display {
    font-size: clamp(2.65rem, 13.5vw, 3.45rem) !important;
    line-height: .94 !important;
    letter-spacing: -.038em;
  }

  main h2.display {
    font-size: clamp(2.35rem, 10.8vw, 3rem) !important;
    line-height: 1 !important;
  }

  main p.text-sm.leading-6,
  main p.text-sm.leading-7 {
    font-size: 1rem !important;
    line-height: 1.75rem !important;
  }

  main section[class*="py-24"]:not(:first-child) {
    padding-top: 4.5rem !important;
    padding-bottom: 4.5rem !important;
  }

  main section[class*="py-20"]:not(:first-child) {
    padding-top: 4rem !important;
    padding-bottom: 4rem !important;
  }

  main .link-arrow {
    line-height: 1.35;
  }
}
'''
        css_path.write_text(css, encoding='utf-8')
        print('patched src/styles/global.css')

    # Guardrail: Wix imagery may appear only on the Gallery route.
    offenders = []
    for p in (ROOT / 'src/pages').rglob('*.astro'):
        rel = p.relative_to(ROOT).as_posix()
        if rel == 'src/pages/gallery/index.astro':
            continue
        text = p.read_text(encoding='utf-8')
        if '/media/wix/' in text or 'galleryMedia' in text:
            offenders.append(rel)
    if offenders:
        raise SystemExit('Wix/gallery imagery still referenced outside Gallery: ' + ', '.join(offenders))

    print('visual refresh complete; gallery-only Wix rule passes')

if __name__ == '__main__':
    main()
