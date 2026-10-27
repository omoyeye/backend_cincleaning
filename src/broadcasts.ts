import type { Express } from 'express';
import { desc, eq, sql } from 'drizzle-orm';
import { broadcasts, notifications, superadmins, users } from './schema';
import { broadcastSync } from './realtime';
import { notifyUsers } from './notify';
import { sendEmail } from './services/email';
import { loadBrandVars } from './messageTemplates/brand';
import { wrapHtmlInEmailShell } from './messageTemplates/engine';

/**
 * Admin Communication hub: email broadcasts (branded shell), app notifications (+ phone push),
 * audience counts, a live preview and a log of what was sent.
 */

export type EmailAudience = 'all' | 'customers' | 'marketing' | 'inactive' | 'staff' | 'specific';
export type AppAudience = 'all' | 'customers' | 'staff';

const EMAIL_AUDIENCES: EmailAudience[] = ['all', 'customers', 'marketing', 'inactive', 'staff', 'specific'];
const APP_AUDIENCES: AppAudience[] = ['all', 'customers', 'staff'];

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const ROLE = sql`LOWER(TRIM(${users.role}))`;

/** Customers with no booking dated in the last 30 days (or never booked). */
const INACTIVE = sql`${ROLE} = 'customer' AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.customer_id = ${users.id} AND b.date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 30 DAY), '%Y-%m-%d')
)`;

function audienceWhere(a: Exclude<EmailAudience, 'specific'> | AppAudience) {
    switch (a) {
        case 'customers':
            return sql`${ROLE} = 'customer'`;
        case 'marketing':
            return sql`${ROLE} = 'customer' AND ${users.marketingOptIn} = TRUE`;
        case 'inactive':
            return INACTIVE;
        case 'staff':
            return sql`${ROLE} = 'staff'`;
        default:
            return sql`${ROLE} IN ('customer', 'staff')`;
    }
}

/** Accept the old Communication Center names too (all_users, specificEmails). */
function normaliseEmailAudience(raw: unknown): EmailAudience {
    const v = String(raw ?? 'all');
    if (v === 'all_users') return 'all';
    return (EMAIL_AUDIENCES as string[]).includes(v) ? (v as EmailAudience) : 'all';
}

/** Plain text (no tags) becomes paragraphs so admins can just type. */
export function bodyToHtml(body: string): string {
    const text = String(body || '').trim();
    if (/<[a-z][\s\S]*>/i.test(text)) return text;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text
        .split(/\n{2,}/)
        .map((p) => `<p>${esc(p).replace(/\n/g, '<br />')}</p>`)
        .join('\n');
}

function personalise(str: string, name: string, brandName: string) {
    const first = String(name || '').trim().split(/\s+/)[0] || 'there';
    return str
        .replace(/\{\{\s*client_name\s*\}\}/g, name || 'there')
        .replace(/\{\{\s*first_name\s*\}\}/g, first)
        .replace(/\{\{\s*brand_name\s*\}\}/g, brandName);
}

async function senderName(db: any, user: any): Promise<string> {
    try {
        const rows = await db.select({ name: superadmins.name }).from(superadmins).where(eq(superadmins.id, Number(user?.id))).limit(1);
        if (rows[0]?.name) return String(rows[0].name);
    } catch {
        /* fall through */
    }
    return String(user?.name || user?.email || 'Admin');
}

async function logBroadcast(db: any, row: Record<string, unknown>) {
    try {
        await db.insert(broadcasts).values(row);
    } catch (e) {
        console.error('[broadcasts] log failed:', e);
    }
}

export function registerBroadcastRoutes(app: Express, db: any, auth: any, requireAdmin: (req: any, res: any) => boolean) {
    /** How many people each audience reaches, for the composer. */
    app.get('/api/admin/broadcast/audiences', auth, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const count = async (where: any, needEmail: boolean) => {
                const [row] = await db
                    .select({ n: sql<number>`COUNT(*)` })
                    .from(users)
                    .where(needEmail ? sql`${where} AND ${users.email} IS NOT NULL AND ${users.email} <> ''` : where);
                return Number(row?.n || 0);
            };
            const email: Record<string, number> = {};
            for (const a of EMAIL_AUDIENCES) if (a !== 'specific') email[a] = await count(audienceWhere(a), true);
            const appCounts: Record<string, number> = {};
            for (const a of APP_AUDIENCES) appCounts[a] = await count(audienceWhere(a), false);
            res.json({ email, app: appCounts });
        } catch (e) {
            console.error('broadcast audiences', e);
            res.status(500).json({ error: 'Could not count audiences' });
        }
    });

    /** The finished branded email exactly as recipients see it, with a sample name. */
    app.post('/api/admin/broadcast/preview', auth, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const brand = await loadBrandVars(db);
            const brandName = String(brand.brand_name || 'CiN Cleaning');
            const inner = personalise(bodyToHtml(String(req.body?.body || '')), 'Sarah Jones', brandName);
            const html = await wrapHtmlInEmailShell(db, inner || '<p style="color:#94a3b8">Your message appears here.</p>', brand);
            res.json({ subject: personalise(String(req.body?.subject || ''), 'Sarah Jones', brandName), html });
        } catch (e) {
            console.error('broadcast preview', e);
            res.status(500).json({ error: 'Could not build the preview' });
        }
    });

    app.post('/api/admin/broadcast/email', auth, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const { subject, body, content, audience, recipientType, specificEmails, test } = req.body || {};
            const messageBody = String(body ?? content ?? '');
            if (!String(subject || '').trim() || !messageBody.trim()) return res.status(400).json({ error: 'Subject and message are required' });

            const segment = normaliseEmailAudience(audience ?? recipientType);
            let recipients: Array<{ email: string; name: string }> = [];

            if (test || segment === 'specific') {
                const list: string[] = Array.isArray(specificEmails)
                    ? specificEmails
                    : String(specificEmails || '').split(/[,;\s]+/);
                const wanted = [...new Set(list.map((e) => String(e || '').trim().toLowerCase()).filter(isEmail))];
                if (!wanted.length) return res.status(400).json({ error: 'Add at least one valid email address.' });
                const known = await db
                    .select({ email: users.email, name: users.name })
                    .from(users)
                    .where(sql`LOWER(TRIM(${users.email})) IN (${sql.join(wanted.map((w) => sql`${w}`), sql`, `)})`);
                const byEmail = new Map<string, string>(known.map((u: any) => [String(u.email).toLowerCase(), String(u.name || '')]));
                recipients = wanted.map((email) => ({ email, name: byEmail.get(email) || 'there' }));
            } else {
                const rows = await db
                    .select({ email: users.email, name: users.name })
                    .from(users)
                    .where(sql`${audienceWhere(segment)} AND ${users.email} IS NOT NULL AND ${users.email} <> ''`);
                recipients = rows.map((u: any) => ({ email: String(u.email), name: String(u.name || '') }));
            }

            if (!recipients.length) return res.json({ sent: 0, total: 0, failed: 0, message: 'No matching recipients' });

            const brand = await loadBrandVars(db);
            const brandName = String(brand.brand_name || 'CiN Cleaning');
            const htmlBody = bodyToHtml(messageBody);
            let sent = 0;
            const errors: string[] = [];
            for (const r of recipients) {
                try {
                    const html = await wrapHtmlInEmailShell(db, personalise(htmlBody, r.name, brandName), brand);
                    await sendEmail({
                        to: [{ email: r.email, name: r.name }],
                        subject: (test ? '[Test] ' : '') + personalise(String(subject), r.name, brandName),
                        htmlContent: html,
                    });
                    sent += 1;
                } catch (e: any) {
                    errors.push(`${r.email}: ${e?.message || 'failed'}`);
                }
            }

            if (!test) {
                await logBroadcast(db, {
                    channel: 'email',
                    audience: segment,
                    subject: String(subject).slice(0, 255),
                    body: messageBody,
                    recipients: recipients.length,
                    sent,
                    failed: recipients.length - sent,
                    createdBy: await senderName(db, req.user),
                });
                broadcastSync('all');
            }
            res.json({ sent, total: recipients.length, failed: recipients.length - sent, errors: errors.slice(0, 10) });
        } catch (error) {
            console.error('Bulk email error:', error);
            res.status(500).json({ error: 'Failed to send the email' });
        }
    });

    app.post('/api/admin/broadcast/notification', auth, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const message = String(req.body?.message || '').trim();
            const title = String(req.body?.title || '').trim();
            const raw = String(req.body?.audience ?? req.body?.recipientType ?? 'all');
            const audience: AppAudience = raw === 'all_users' ? 'all' : (APP_AUDIENCES as string[]).includes(raw) ? (raw as AppAudience) : 'all';
            const push = req.body?.push !== false;
            if (!message) return res.status(400).json({ error: 'Write a message first' });
            if (message.length > 500) return res.status(400).json({ error: 'Keep app messages under 500 characters' });

            const rows = await db.select({ id: users.id }).from(users).where(audienceWhere(audience));
            const ids = rows.map((r: any) => Number(r.id));
            if (ids.length) {
                const brand = await loadBrandVars(db);
                const pushTitle = title || String(brand.brand_name || 'CiN Cleaning');
                const inApp = title ? `${title}: ${message}` : message;
                if (push) {
                    await notifyUsers(db, ids, { type: 'system', message: inApp, pushTitle, pushBody: message });
                } else {
                    await db.insert(notifications).values(ids.map((userId: number) => ({ userId, type: 'system', message: inApp, isRead: false })));
                }
            }
            await logBroadcast(db, {
                channel: push ? 'push' : 'notification',
                audience,
                subject: title ? title.slice(0, 255) : null,
                body: message,
                recipients: ids.length,
                sent: ids.length,
                failed: 0,
                createdBy: await senderName(db, req.user),
            });
            broadcastSync('notifications');
            broadcastSync('all');
            res.json({ sent: ids.length, total: ids.length });
        } catch (error) {
            console.error('broadcast notification', error);
            res.status(500).json({ error: 'Failed to send the notification' });
        }
    });

    app.get('/api/admin/broadcasts', auth, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const rows = await db.select().from(broadcasts).orderBy(desc(broadcasts.createdAt)).limit(100);
            res.json(
                rows.map((r: any) => ({
                    id: Number(r.id),
                    channel: String(r.channel),
                    audience: String(r.audience),
                    subject: r.subject ?? null,
                    body: String(r.body || ''),
                    recipients: Number(r.recipients || 0),
                    sent: Number(r.sent || 0),
                    failed: Number(r.failed || 0),
                    createdBy: r.createdBy ?? null,
                    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
                })),
            );
        } catch (e) {
            console.error('broadcast history', e);
            res.status(500).json({ error: 'Could not load sent messages' });
        }
    });
}
