import type { APIRoute } from 'astro';
import { wixBlogPosts } from '../data/wixBlogPosts';

export const prerender = true;

const SITE = 'https://koasevents.com';

type SitemapEntry = {
  path: string;
  changefreq?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  priority?: string;
  lastmod?: string;
};

const staticEntries: SitemapEntry[] = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/about/', changefreq: 'monthly', priority: '0.8' },
  { path: '/weddings/', changefreq: 'weekly', priority: '0.9' },
  { path: '/east-hawaii-wedding-venue/', changefreq: 'monthly', priority: '0.85' },
  { path: '/signature-wedding/', changefreq: 'weekly', priority: '0.9' },
  { path: '/venue/', changefreq: 'weekly', priority: '0.9' },
  { path: '/venue/packages/', changefreq: 'weekly', priority: '0.85' },
  { path: '/venue/faq/', changefreq: 'monthly', priority: '0.7' },
  { path: '/mobile-bar/', changefreq: 'weekly', priority: '0.9' },
  { path: '/mobile-bar/faq/', changefreq: 'monthly', priority: '0.7' },
  { path: '/private-events/', changefreq: 'weekly', priority: '0.8' },
  { path: '/corporate-events/', changefreq: 'monthly', priority: '0.75' },
  { path: '/stay/', changefreq: 'monthly', priority: '0.75' },
  { path: '/gallery/', changefreq: 'weekly', priority: '0.8' },
  { path: '/catalog/', changefreq: 'weekly', priority: '0.8' },
  { path: '/blog/', changefreq: 'weekly', priority: '0.75' },
  { path: '/contact/', changefreq: 'monthly', priority: '0.7' },
  { path: '/inquire/', changefreq: 'monthly', priority: '0.7' },
  { path: '/wedding-inquiry/', changefreq: 'monthly', priority: '0.7' },
  { path: '/privacy/', changefreq: 'yearly', priority: '0.3' },
  { path: '/terms/', changefreq: 'yearly', priority: '0.3' },
];

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const xmlUrl = ({ path, changefreq, priority, lastmod }: SitemapEntry) => {
  const tags = [
    `<loc>${escapeXml(`${SITE}${path}`)}</loc>`,
    lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : '',
    changefreq ? `<changefreq>${changefreq}</changefreq>` : '',
    priority ? `<priority>${priority}</priority>` : '',
  ].filter(Boolean);

  return `  <url>\n    ${tags.join('\n    ')}\n  </url>`;
};

export const GET: APIRoute = () => {
  const blogEntries: SitemapEntry[] = wixBlogPosts
    .filter((post) => post.status === 'published')
    .map((post) => ({
      path: `/blog/${post.slug}/`,
      lastmod: (post.updatedAt || post.publishedAt).slice(0, 10),
      changefreq: 'monthly',
      priority: '0.7',
    }));

  const entries = [...staticEntries, ...blogEntries];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(xmlUrl),
    '</urlset>',
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
