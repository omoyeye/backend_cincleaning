import { businessSettings } from '../schema';

/** Public site origin for absolute asset URLs in emails (e.g. https://yoursite.com). */
export function sitePublicUrl(): string {
  const raw = (
    process.env.PUBLIC_SITE_URL ||
    process.env.SITE_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.VITE_SITE_URL ||
    ''
  ).trim();
  return raw.replace(/\/$/, '');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Phone, email, website and address for the email footer (dark background, tappable links). */
export function buildContactBlockHtml(map: Record<string, string>): string {
  const phone = (map.phone || '').trim();
  const email = (map.email || '').trim();
  const website = (map.website || '').trim();
  const address = (map.address || '').trim();
  const link = 'color:#e2e8f0;text-decoration:none;font-weight:600;';
  const items: string[] = [];
  if (phone) items.push(`<a href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}" style="${link}">${escapeHtml(phone)}</a>`);
  if (email) items.push(`<a href="mailto:${escapeHtml(email)}" style="${link}">${escapeHtml(email)}</a>`);
  if (website) {
    const href = website.startsWith('http') ? website : `https://${website}`;
    items.push(`<a href="${escapeHtml(href)}" style="${link}">${escapeHtml(website.replace(/^https?:\/\//, ''))}</a>`);
  }
  if (!items.length && !address) return '';
  // Spaces around the separators let the line wrap on narrow phone screens.
  const sep = ' <span style="color:#475569;padding:0 4px;">&#124;</span> ';
  return `<p style="margin:0 0 6px;font-size:13px;line-height:1.9;color:#cbd5e1;">${items.join(sep)}</p>${
    address ? `<p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8;">${escapeHtml(address)}</p>` : ''
  }`;
}

const SOCIAL_LABELS: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  twitter: 'X',
  x: 'X',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  whatsapp: 'WhatsApp',
};

/** Social profile links (from Settings > social links) as small pills for the footer. */
export function buildSocialBlockHtml(map: Record<string, string>): string {
  let links: Record<string, unknown> = {};
  try {
    const raw = map.socialLinks;
    const parsed = typeof raw === 'string' && raw.trim().startsWith('{') ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') links = parsed;
  } catch {
    links = {};
  }
  const pills = Object.entries(links)
    .filter(([, url]) => typeof url === 'string' && /^https?:\/\//i.test(url))
    .map(([key, url]) => {
      const label = SOCIAL_LABELS[key.toLowerCase()] || key.charAt(0).toUpperCase() + key.slice(1);
      return `<a href="${escapeHtml(String(url))}" style="display:inline-block;margin:4px 3px;padding:6px 14px;border-radius:999px;background:#1e293b;border:1px solid #334155;color:#e2e8f0;font-size:12px;font-weight:600;text-decoration:none;">${escapeHtml(label)}</a>`;
    });
  return pills.length ? `<div style="margin:16px 0 4px;">${pills.join(' ')}</div>` : '';
}

/** Load brand strings from flat business_settings rows for email/SMS variables. */
export async function loadBrandVars(db: any): Promise<Record<string, string>> {
  const rows = await db.select().from(businessSettings);
  const map = rows.reduce((acc: Record<string, string>, curr: { key: string; value: string | null }) => {
    acc[curr.key] = curr.value ?? '';
    return acc;
  }, {});

  const companyName = (map.companyName || '').trim() || 'CiN Cleaning';
  let primary = (map.theme_primary || map.primaryColor || '#0d9488').trim();
  if (primary && !primary.startsWith('#')) primary = `#${primary}`;

  // Logo: uploaded logo URL, else the site's brand-logo.png (site URL from env, else the Website setting).
  const uploaded = String(map.logoUrl || '').trim();
  const website = String(map.website || '').trim().replace(/\/$/, '');
  const base = sitePublicUrl() || (website ? (website.startsWith('http') ? website : `https://${website}`) : '');
  const brand_logo_url = /^https?:\/\//i.test(uploaded) ? uploaded : base ? `${base}/brand-logo.png` : '';
  const contact_block = buildContactBlockHtml(map);
  const social_block = buildSocialBlockHtml(map);
  const brand_phone = (map.phone || '').trim();
  const brand_website_url = website ? (website.startsWith('http') ? website : `https://${website}`) : base;

  return {
    brand_name: companyName,
    brand_primary: primary,
    footer_note: `Thank you for choosing ${companyName}.`,
    brand_logo_url,
    contact_block,
    brand_phone,
    brand_email: (map.email || '').trim(),
    brand_website: (map.website || '').trim(),
    brand_address: (map.address || '').trim(),
    brand_website_url,
    brand_phone_href: brand_phone.replace(/[^\d+]/g, ''),
    social_block,
    brand_tagline: 'Professional Cleaning Services · London &amp; Manchester',
    year: String(new Date().getFullYear()),
  };
}

export async function loadBusinessSettingsMap(db: any): Promise<Record<string, string>> {
  const rows = await db.select().from(businessSettings);
  return rows.reduce((acc: Record<string, string>, curr: { key: string; value: string | null }) => {
    acc[curr.key] = curr.value ?? '';
    return acc;
  }, {});
}

export function adminInvoiceRecipientEmail(map: Record<string, string>): string {
  const env = process.env.STAFF_INVOICE_EMAIL?.trim();
  if (env) return env;
  const e = (map.email || '').trim();
  if (e.includes('@')) return e;
  return 'staff@cleanitneatly.com';
}

/** Inbox for new-booking alerts (defaults to support/business email). */
export function adminBookingNotifyEmail(map: Record<string, string>): string {
  const env = process.env.ADMIN_BOOKING_EMAIL?.trim();
  if (env) return env;
  return adminInvoiceRecipientEmail(map);
}
