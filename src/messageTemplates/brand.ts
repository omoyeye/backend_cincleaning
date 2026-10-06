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

/** HTML block with phone, email, website, address for transactional email shell. */
export function buildContactBlockHtml(map: Record<string, string>): string {
  const phone = (map.phone || '').trim();
  const email = (map.email || '').trim();
  const website = (map.website || '').trim();
  const address = (map.address || '').trim();
  const parts: string[] = [];
  if (phone) {
    const tel = phone.replace(/[^\d+]/g, '');
    parts.push(
      `<strong>Phone:</strong> <a href="tel:${escapeHtml(tel)}" style="color:#0f172a;text-decoration:none;">${escapeHtml(phone)}</a>`
    );
  }
  if (email) {
    parts.push(
      `<strong>Email:</strong> <a href="mailto:${escapeHtml(email)}" style="color:#0f172a;text-decoration:none;">${escapeHtml(email)}</a>`
    );
  }
  if (website) {
    const href = website.startsWith('http') ? website : `https://${website}`;
    parts.push(
      `<strong>Website:</strong> <a href="${escapeHtml(href)}" style="color:#0f172a;text-decoration:none;">${escapeHtml(website)}</a>`
    );
  }
  if (address) {
    parts.push(`<strong>Address:</strong> ${escapeHtml(address)}`);
  }
  if (!parts.length) return '';
  return `<div style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:13px;color:#475569;line-height:1.65;">${parts.join('<br/>')}</div>`;
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

  const base = sitePublicUrl();
  const brand_logo_url = base ? `${base}/brand-logo.png` : '';
  const contact_block = buildContactBlockHtml(map);
  const brand_phone = (map.phone || '').trim();

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
