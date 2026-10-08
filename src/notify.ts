import { eq, inArray, sql } from 'drizzle-orm';
import { notifications, staff, users } from './schema';
import { sendPushToUsers } from './push';
import { sendEmail } from './services/email';
import { renderTransactionalEmail } from './messageTemplates/engine';
import { sendSmsFromTemplate } from './messageTemplates/smsDispatch';
import { adminBookingNotifyEmail, loadBrandVars, loadBusinessSettingsMap, sitePublicUrl } from './messageTemplates/brand';

/**
 * Shared delivery helpers so every event uses the same channels the same way:
 * in-app notification + push to app users, templated email/SMS, and admin alerts.
 * All helpers are best-effort: a failed channel is logged and never breaks the request.
 */

export type StaffContact = { staffId: number; userId: number | null; name: string; phone: string | null; email: string | null };

export async function staffContacts(db: any, staffIds: Array<number | null | undefined>): Promise<StaffContact[]> {
    const ids = [...new Set(staffIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!ids.length) return [];
    const rows = await db.select().from(staff).where(inArray(staff.id, ids));
    return rows.map((r: any) => ({
        staffId: Number(r.id),
        userId: r.userId ? Number(r.userId) : null,
        name: String(r.name || 'Cleaner'),
        phone: r.phone ? String(r.phone) : null,
        email: r.email ? String(r.email) : null,
    }));
}

export async function adminUserIds(db: any): Promise<number[]> {
    const rows = await db.select({ id: users.id }).from(users).where(sql`LOWER(TRIM(${users.role})) = 'admin'`);
    return rows.map((r: any) => Number(r.id)).filter((id: number) => Number.isFinite(id) && id > 0);
}

/** In-app notification plus a push with the same text. */
export async function notifyUsers(
    db: any,
    userIds: Array<number | null | undefined>,
    opts: { type?: string; message: string; pushTitle: string; pushBody?: string; data?: Record<string, unknown>; inApp?: boolean },
): Promise<void> {
    const ids = [...new Set(userIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!ids.length) return;
    if (opts.inApp !== false) {
        try {
            await db.insert(notifications).values(
                ids.map((userId) => ({ userId, type: opts.type || 'system', message: opts.message, isRead: false })),
            );
        } catch (e) {
            console.error('[notify] in-app failed:', e);
        }
    }
    void sendPushToUsers(ids, opts.pushTitle, opts.pushBody || opts.message, opts.data);
}

/** Push only (when an in-app notice was already written elsewhere). */
export function pushUsers(userIds: Array<number | null | undefined>, title: string, body: string, data?: Record<string, unknown>): void {
    const ids = [...new Set(userIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (ids.length) void sendPushToUsers(ids, title, body, data);
}

/** Render a transactional template (with brand variables) and email it. */
export async function emailFromTemplate(
    db: any,
    templateName: string,
    to: { email: string | null | undefined; name?: string | null },
    vars: Record<string, string>,
): Promise<boolean> {
    const email = String(to.email || '').trim();
    if (!email.includes('@')) return false;
    try {
        const brand = await loadBrandVars(db);
        const { subject, html } = await renderTransactionalEmail(db, templateName, { ...brand, ...vars });
        await sendEmail({ to: [{ email, name: to.name || email }], subject, htmlContent: html });
        return true;
    } catch (e) {
        console.error(`[notify] email ${templateName} failed:`, e);
        return false;
    }
}

/** Email the business inbox (ADMIN_BOOKING_EMAIL or the business email). */
export async function emailAdmins(db: any, templateName: string, vars: Record<string, string>): Promise<void> {
    try {
        const to = adminBookingNotifyEmail(await loadBusinessSettingsMap(db));
        if (to) await emailFromTemplate(db, templateName, { email: to, name: 'Admin' }, vars);
    } catch (e) {
        console.error(`[notify] admin email ${templateName} failed:`, e);
    }
}

export async function smsFromTemplate(db: any, templateName: string, phone: string | null | undefined, vars: Record<string, string>): Promise<void> {
    if (!phone) return;
    try {
        const brand = await loadBrandVars(db);
        await sendSmsFromTemplate(db, templateName, phone, { ...brand, ...vars });
    } catch (e) {
        console.error(`[notify] sms ${templateName} failed:`, e);
    }
}

/** "Thu 9 Oct" style date for messages, falling back to the raw value. */
export function friendlyDate(ymd: string | null | undefined): string {
    const [y, m, d] = String(ymd || '').split('-').map(Number);
    if (!y || !m || !d) return String(ymd || '');
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Absolute site link for emails (portal / admin). */
export function siteUrl(path = ''): string {
    return `${sitePublicUrl() || 'https://cleanitneatly.com'}${path}`;
}

export async function userEmailById(db: any, userId: number | null | undefined): Promise<{ email: string; name: string } | null> {
    const id = Number(userId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const rows = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, id)).limit(1);
    return rows[0]?.email ? { email: String(rows[0].email), name: String(rows[0].name || '') } : null;
}
