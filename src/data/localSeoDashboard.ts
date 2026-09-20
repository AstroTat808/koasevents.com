export type LocalSeoMonth = {
  month: string;
  gbp: {
    impressions: number;
    websiteClicks: number;
    calls: number;
    directions: number;
  };
  searchConsole: {
    impressions: number;
    clicks: number;
    ctr: number;
    avgPosition: number | null;
  };
};

export type TrackedQuery = {
  query: string;
  months: Array<{
    month: string;
    impressions: number;
    clicks: number;
    avgPosition: number | null;
  }>;
};

export type PublishedGbpPost = {
  date: string;
  calendarDate: string;
  title: string;
  pillar: string;
  postId: string;
  state: string;
  searchUrl?: string;
  destinationUrl: string;
};

export const localSeoDashboard = {
  snapshotDate: '2026-09-20',
  reviews: {
    count: 6,
    averageRating: 4.3,
  },
  mobileBarSite: {
    property: 'sc-domain:koasmobilebar.com',
    siteUrl: 'https://koasmobilebar.com/',
    sitemapUrl: 'https://koasmobilebar.com/sitemap.xml',
    sitemapSubmittedUrls: 16,
    sitemapErrors: 0,
    sitemapWarnings: 0,
    lastSitemapDownload: '2026-09-20T05:14:40.855Z',
    status: 'Verified in Search Console; awaiting first performance data.',
    months: [] as Array<{ month: string; impressions: number; clicks: number; ctr: number; avgPosition: number | null }>,
  },
  months: [
    { month: '2026-04', gbp: { impressions: 751, websiteClicks: 40, calls: 3, directions: 57 }, searchConsole: { impressions: 2664, clicks: 97, ctr: 0.0364, avgPosition: 16.76 } },
    { month: '2026-05', gbp: { impressions: 842, websiteClicks: 42, calls: 0, directions: 76 }, searchConsole: { impressions: 3137, clicks: 100, ctr: 0.0319, avgPosition: 19.92 } },
    { month: '2026-06', gbp: { impressions: 697, websiteClicks: 39, calls: 2, directions: 67 }, searchConsole: { impressions: 2873, clicks: 101, ctr: 0.0352, avgPosition: 19.76 } },
    { month: '2026-07', gbp: { impressions: 723, websiteClicks: 44, calls: 5, directions: 34 }, searchConsole: { impressions: 2442, clicks: 99, ctr: 0.0405, avgPosition: 22.73 } },
    { month: '2026-08', gbp: { impressions: 752, websiteClicks: 29, calls: 2, directions: 55 }, searchConsole: { impressions: 2464, clicks: 77, ctr: 0.0313, avgPosition: 22.43 } },
    { month: '2026-09', gbp: { impressions: 335, websiteClicks: 8, calls: 0, directions: 49 }, searchConsole: { impressions: 1367, clicks: 50, ctr: 0.0366, avgPosition: 18.61 } },
  ] satisfies LocalSeoMonth[],
  trackedQueries: [
    {
      query: 'wedding venues hilo',
      months: [
        { month: '2026-04', impressions: 6, clicks: 2, avgPosition: 6.33 },
        { month: '2026-05', impressions: 16, clicks: 3, avgPosition: 4.56 },
        { month: '2026-06', impressions: 5, clicks: 0, avgPosition: 6.8 },
        { month: '2026-07', impressions: 5, clicks: 0, avgPosition: 6.2 },
        { month: '2026-08', impressions: 10, clicks: 1, avgPosition: 3.3 },
        { month: '2026-09', impressions: 6, clicks: 0, avgPosition: 1.17 },
      ],
    },
    {
      query: 'wedding venues big island',
      months: [
        { month: '2026-04', impressions: 21, clicks: 2, avgPosition: 14.81 },
        { month: '2026-05', impressions: 25, clicks: 1, avgPosition: 12.4 },
        { month: '2026-06', impressions: 21, clicks: 0, avgPosition: 8.76 },
        { month: '2026-07', impressions: 27, clicks: 1, avgPosition: 15.19 },
        { month: '2026-08', impressions: 10, clicks: 0, avgPosition: 19.6 },
        { month: '2026-09', impressions: 7, clicks: 0, avgPosition: 47.14 },
      ],
    },
    {
      query: 'mobile bar',
      months: [
        { month: '2026-04', impressions: 31, clicks: 0, avgPosition: 12.32 },
        { month: '2026-05', impressions: 27, clicks: 1, avgPosition: 27.07 },
        { month: '2026-06', impressions: 14, clicks: 1, avgPosition: 12.36 },
        { month: '2026-07', impressions: 27, clicks: 2, avgPosition: 15.33 },
        { month: '2026-08', impressions: 17, clicks: 0, avgPosition: 15.94 },
        { month: '2026-09', impressions: 9, clicks: 1, avgPosition: 18.33 },
      ],
    },
    {
      query: 'venues in hilo',
      months: [
        { month: '2026-04', impressions: 17, clicks: 0, avgPosition: 5.18 },
        { month: '2026-05', impressions: 27, clicks: 2, avgPosition: 3.85 },
        { month: '2026-06', impressions: 11, clicks: 0, avgPosition: 6.36 },
        { month: '2026-07', impressions: 12, clicks: 0, avgPosition: 5.75 },
        { month: '2026-08', impressions: 6, clicks: 0, avgPosition: 13 },
        { month: '2026-09', impressions: 3, clicks: 0, avgPosition: 9.33 },
      ],
    },
  ] satisfies TrackedQuery[],
  publishedPosts: [] satisfies PublishedGbpPost[],
};
