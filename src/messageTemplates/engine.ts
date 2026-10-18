import { eq } from 'drizzle-orm';
import { emailTemplates } from '../schema';
import { ensureMessageTemplatesSeededOnce } from './seed';
import { loadBrandVars } from './brand';

/** Every email that went through the branded layout starts with this, so it is never wrapped twice. */
export const EMAIL_SHELL_MARKER = '<!--cin-email-shell-->';

/** Replace {{var}} placeholders (alphanumeric + underscore keys). */
export function interpolateTemplate(str: string, vars: Record<string, string>): string {
  if (!str) return '';
  return str.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) =>
    vars[key] != null ? String(vars[key]) : ''
  );
}

/** Logo for the email header; falls back to the brand name in brand colour when there is no logo URL. */
export function emailBrandLogoBlock(vars: Record<string, string>): string {
  const u = (vars.brand_logo_url || '').trim();
  const name = (vars.brand_name || 'CiN Cleaning').replace(/</g, '&lt;');
  if (!u) {
    return `<p style="margin:0;font-size:26px;font-weight:800;letter-spacing:-0.5px;color:${vars.brand_primary || '#0f172a'};">${name}</p>`;
  }
  const alt = name.replace(/"/g, '&quot;');
  const src = u.replace(/"/g, '&quot;');
  return `<img src="${src}" alt="${alt}" width="180" style="display:block;margin:0 auto;width:180px;max-width:70%;height:auto;border:0;outline:none;text-decoration:none;" />`;
}

/** First line of the message as inbox preview text (shown under the subject in Gmail, Outlook, Apple Mail). */
function previewText(innerHtml: string): string {
  const text = innerHtml
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 120 ? `${text.slice(0, 117).trimEnd()}...` : text;
}

/** Variables for the outer layout: brand details always come from Settings, so every email shows logo and contact info. */
async function shellVars(db: any, innerHtml: string, vars: Record<string, string>): Promise<Record<string, string>> {
  let brand: Record<string, string> = {};
  try {
    brand = await loadBrandVars(db);
  } catch {
    brand = {};
  }
  const merged = { ...brand, ...Object.fromEntries(Object.entries(vars).filter(([, v]) => v != null && String(v) !== '')) };
  return {
    ...merged,
    inner_content: innerHtml,
    preheader: previewText(innerHtml),
    brand_name: merged.brand_name || 'CiN Cleaning',
    brand_primary: merged.brand_primary || '#0d9488',
    footer_note: merged.footer_note || 'Thank you for choosing us.',
    brand_logo_block: emailBrandLogoBlock(merged),
    contact_block: merged.contact_block || '',
    social_block: merged.social_block || '',
  };
}

export async function getEmailTemplateByName(db: any, name: string) {
  const rows = await db.select().from(emailTemplates).where(eq(emailTemplates.name, name)).limit(1);
  return rows[0] ?? null;
}

const SHELL_NAME = 'email_shell';

/**
 * Renders inner transactional HTML and wraps with `email_shell` when present and active.
 */
export async function renderTransactionalEmail(
  db: any,
  templateName: string,
  vars: Record<string, string>
): Promise<{ subject: string; html: string }> {
  await ensureMessageTemplatesSeededOnce(db);
  const innerRow = await getEmailTemplateByName(db, templateName);
  if (!innerRow || !innerRow.active) {
    throw new Error(`Email template missing or inactive: ${templateName}`);
  }
  const innerHtml = interpolateTemplate(innerRow.body, vars);
  const subject = interpolateTemplate(innerRow.subject, vars);
  if (templateName === SHELL_NAME) {
    return { subject, html: innerHtml };
  }
  const shellRow = await getEmailTemplateByName(db, SHELL_NAME);
  if (!shellRow || !shellRow.active) {
    return { subject, html: innerHtml };
  }
  const html = EMAIL_SHELL_MARKER + interpolateTemplate(shellRow.body, await shellVars(db, innerHtml, vars));
  return { subject, html };
}

/** Render a layout body (saved or being edited) around a message, for previews. */
export async function renderWithShellBody(db: any, shellBody: string, innerHtml: string, vars: Record<string, string>): Promise<string> {
  return EMAIL_SHELL_MARKER + interpolateTemplate(shellBody, await shellVars(db, innerHtml, vars));
}

/**
 * Wrap arbitrary admin HTML in the same transactional shell + logo (for broadcast emails).
 */
export async function wrapHtmlInEmailShell(db: any, innerHtml: string, vars: Record<string, string>): Promise<string> {
  await ensureMessageTemplatesSeededOnce(db);
  if (innerHtml.includes(EMAIL_SHELL_MARKER)) return innerHtml;
  const shellRow = await getEmailTemplateByName(db, SHELL_NAME);
  if (!shellRow || !shellRow.active) return innerHtml;
  return EMAIL_SHELL_MARKER + interpolateTemplate(shellRow.body, await shellVars(db, innerHtml, vars));
}
