// Server copy of frontend/src/seo/routePaths.ts (sitemap needs SERVICE_AREAS). Keep in sync.
/** Public marketing + booking paths (descriptive slugs). Legacy paths still resolve in App. */

export type CustomerPageKey =
  | 'home'
  | 'residential'
  | 'standardCleaning'
  | 'deepCleaning'
  | 'endOfTenancy'
  | 'commercial'
  | 'airbnbShortLet'
  | 'about'
  | 'gallery'
  | 'blog'
  | 'pricing'
  | 'contact'
  | 'faq'
  | 'terms'
  | 'book'
  | 'area';

export const CUSTOMER_PAGE_PATH: Record<CustomerPageKey, string> = {
  home: '/',
  residential: '/residential-cleaning',
  standardCleaning: '/standard-cleaning',
  deepCleaning: '/deep-cleaning',
  endOfTenancy: '/end-of-tenancy-cleaning',
  commercial: '/commercial-cleaning',
  airbnbShortLet: '/airbnb-short-let-cleaning',
  about: '/about-us',
  gallery: '/cleaning-gallery',
  blog: '/cleaning-blog',
  pricing: '/cleaning-pricing',
  contact: '/contact-us',
  faq: '/cleaning-faq',
  terms: '/terms-and-conditions',
  book: '/book-cleaning',
  area: '/cleaning-in',
};

/** Local-SEO area landing pages: slug → display name. */
export const SERVICE_AREAS: Record<string, string> = {
  'manchester': 'Manchester',
  'south-manchester': 'South Manchester',
  'north-manchester': 'North Manchester',
  'east-manchester': 'East Manchester',
  'west-manchester': 'West Manchester',
  'central-manchester': 'Central Manchester',
  'london': 'London',
  'central-london': 'Central London',
  'north-london': 'North London',
  'south-london': 'South London',
  'east-london': 'East London',
  'west-london': 'West London',
};

/** Legacy URLs → canonical path (301-style replaceState in client). */
export const LEGACY_PATH_REDIRECT: Record<string, string> = {
  '/commercial': '/commercial-cleaning',
  '/about': '/about-us',
  '/pricing': '/cleaning-pricing',
  '/contact': '/contact-us',
  '/book': '/book-cleaning',
  '/faq': '/cleaning-faq',
  '/terms': '/terms-and-conditions',
  '/portal': '/my-account',
  '/home': '/',
  '/residential': '/residential-cleaning',
  '/blog': '/cleaning-blog',
  '/cleaning-tips': '/cleaning-blog',
  '/gallery': '/cleaning-gallery',
};

export const PORTAL_PATH = '/my-account';
export const ADMIN_PATH = '/admin';
export const STAFF_PATH = '/staff';
export const RESET_PASSWORD_PATH = '/reset-password';

export function pathForCustomerPage(page: CustomerPageKey): string {
  return CUSTOMER_PAGE_PATH[page];
}

/** Pathname → marketing page + optional blog article slug. */
export function parseCustomerRoute(pathname: string): { page: CustomerPageKey; blogSlug: string | null } {
  const p = pathname.replace(/\/$/, '') || '/';
  if (p === '/blog') return { page: 'blog', blogSlug: null };
  const blogArticle = /^\/cleaning-blog\/([^/]+)$/.exec(p);
  if (blogArticle) {
    return { page: 'blog', blogSlug: decodeURIComponent(blogArticle[1]) };
  }
  if (p === '/cleaning-blog') return { page: 'blog', blogSlug: null };
  if (p === '/cleaning-gallery') return { page: 'gallery', blogSlug: null };
  if (p === '/' || p === '/home') return { page: 'home', blogSlug: null };
  if (p === '/residential-cleaning' || p === '/residential') return { page: 'residential', blogSlug: null };
  if (p === '/standard-cleaning') return { page: 'standardCleaning', blogSlug: null };
  if (p === '/deep-cleaning') return { page: 'deepCleaning', blogSlug: null };
  if (p === '/end-of-tenancy-cleaning') return { page: 'endOfTenancy', blogSlug: null };
  if (p === '/airbnb-short-let-cleaning') return { page: 'airbnbShortLet', blogSlug: null };
  if (p === '/commercial-cleaning' || p === '/commercial') return { page: 'commercial', blogSlug: null };
  if (p === '/about-us' || p === '/about') return { page: 'about', blogSlug: null };
  if (p === '/cleaning-pricing' || p === '/pricing') return { page: 'pricing', blogSlug: null };
  if (p === '/contact-us' || p === '/contact') return { page: 'contact', blogSlug: null };
  if (p === '/cleaning-faq' || p === '/faq') return { page: 'faq', blogSlug: null };
  if (p === '/terms-and-conditions' || p === '/terms') return { page: 'terms', blogSlug: null };
  if (p === '/book-cleaning' || p === '/book') return { page: 'book', blogSlug: null };
  // Area landing pages reuse blogSlug to carry the area slug.
  const areaMatch = /^\/cleaning-in-([a-z0-9-]+)$/.exec(p);
  if (areaMatch) return { page: 'area', blogSlug: areaMatch[1] };
  return { page: 'home', blogSlug: null };
}

export function customerPageFromPath(pathname: string): CustomerPageKey | null {
  return parseCustomerRoute(pathname).page;
}

export function getViewFromPathname(pathname: string): 'customer' | 'admin' | 'staff' | 'portal' | 'reset-password' {
  const p = pathname.replace(/\/$/, '') || '/';
  if (p === ADMIN_PATH) return 'admin';
  if (p === STAFF_PATH) return 'staff';
  if (p === PORTAL_PATH || p === '/portal') return 'portal';
  if (p === RESET_PASSWORD_PATH) return 'reset-password';
  return 'customer';
}

/** All indexable public paths for sitemap (no trailing slash except root). */
export const SITEMAP_CUSTOMER_PATHS: string[] = [
  '/',
  '/residential-cleaning',
  '/standard-cleaning',
  '/deep-cleaning',
  '/end-of-tenancy-cleaning',
  '/commercial-cleaning',
  '/airbnb-short-let-cleaning',
  '/about-us',
  '/cleaning-gallery',
  '/cleaning-blog',
  '/cleaning-pricing',
  '/contact-us',
  '/cleaning-faq',
  '/terms-and-conditions',
  '/book-cleaning',
  ...Object.keys(SERVICE_AREAS).map((slug) => `/cleaning-in-${slug}`),
];

export type SeoPageId =
  | 'home'
  | 'residential'
  | 'standardCleaning'
  | 'deepCleaning'
  | 'endOfTenancy'
  | 'commercial'
  | 'airbnbShortLet'
  | 'about'
  | 'gallery'
  | 'blog'
  | 'pricing'
  | 'contact'
  | 'faq'
  | 'terms'
  | 'book'
  | 'area'
  | 'portal'
  | 'admin'
  | 'staff';

export function seoPageIdForRoute(
  view: 'customer' | 'admin' | 'staff' | 'portal',
  customerPage: CustomerPageKey
): SeoPageId {
  if (view === 'admin') return 'admin';
  if (view === 'staff') return 'staff';
  if (view === 'portal') return 'portal';
  return customerPage;
}

export function pathForSeoPageId(id: SeoPageId): string {
  switch (id) {
    case 'home':
      return '/';
    case 'residential':
      return '/residential-cleaning';
    case 'standardCleaning':
      return '/standard-cleaning';
    case 'deepCleaning':
      return '/deep-cleaning';
    case 'endOfTenancy':
      return '/end-of-tenancy-cleaning';
    case 'commercial':
      return '/commercial-cleaning';
    case 'airbnbShortLet':
      return '/airbnb-short-let-cleaning';
    case 'about':
      return '/about-us';
    case 'gallery':
      return '/cleaning-gallery';
    case 'blog':
      return '/cleaning-blog';
    case 'pricing':
      return '/cleaning-pricing';
    case 'contact':
      return '/contact-us';
    case 'faq':
      return '/cleaning-faq';
    case 'terms':
      return '/terms-and-conditions';
    case 'book':
      return '/book-cleaning';
    case 'area':
      return '/cleaning-in';
    case 'portal':
      return PORTAL_PATH;
    case 'admin':
      return ADMIN_PATH;
    case 'staff':
      return STAFF_PATH;
    default:
      return '/';
  }
}
