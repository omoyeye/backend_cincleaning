import { eq } from 'drizzle-orm';
import { emailTemplates } from '../schema';
import { ensureMessageTemplatesSeededOnce } from './seed';

/** Replace {{var}} placeholders (alphanumeric + underscore keys). */
export function interpolateTemplate(str: string, vars: Record<string, string>): string {
  if (!str) return '';
  return str.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) =>
    vars[key] != null ? String(vars[key]) : ''
  );
}

/** Centered logo block for HTML emails (requires absolute brand_logo_url). */
export function emailBrandLogoBlock(vars: Record<string, string>): string {
  const u = (vars.brand_logo_url || '').trim();
  if (!u) return '';
  const alt = (vars.brand_name || 'Brand').replace(/"/g, '&quot;');
  const src = u.replace(/"/g, '&quot;');
  return `<div style="text-align:center;padding:20px 24px 12px;background:#ffffff;"><img src="${src}" alt="${alt}" width="160" style="max-width:220px;height:auto;border:0;display:inline-block;" /></div>`;
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
  const html = interpolateTemplate(shellRow.body, {
    inner_content: innerHtml,
    brand_name: vars.brand_name || 'CiN Cleaning',
    brand_primary: vars.brand_primary || '#0d9488',
    footer_note: vars.footer_note || 'Thank you for choosing us.',
    brand_logo_block: emailBrandLogoBlock(vars),
    contact_block: vars.contact_block || '',
  });
  return { subject, html };
}

/**
 * Wrap arbitrary admin HTML in the same transactional shell + logo (for broadcast emails).
 */
export async function wrapHtmlInEmailShell(db: any, innerHtml: string, vars: Record<string, string>): Promise<string> {
  await ensureMessageTemplatesSeededOnce(db);
  const shellRow = await getEmailTemplateByName(db, SHELL_NAME);
  if (!shellRow || !shellRow.active) return innerHtml;
  return interpolateTemplate(shellRow.body, {
    inner_content: innerHtml,
    brand_name: vars.brand_name || 'CiN Cleaning',
    brand_primary: vars.brand_primary || '#0d9488',
    footer_note: vars.footer_note || 'Thank you for choosing us.',
    brand_logo_block: emailBrandLogoBlock(vars),
    contact_block: vars.contact_block || '',
  });
}
