import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';

import cors from 'cors';
import { db, poolConnection } from './db';
import { attachRealtime, broadcastSync } from './realtime';
import {
    services,
    bookings,
    users,
    staff,
    extraServices,
    businessSettings,
    emailTemplates,
    smsTemplates,
    notifications,
    discounts,
    bookingStaff,
    superadmins,
    bookingMessages,
    staffInvoices,
    customerInvoices,
    galleryItems,
    blogPosts,
    bookingReminderLog,
    promotions,
    quoteLeads,
    directMessages,
    expenses,
} from './schema';
import { slugify } from './seed/blogGallerySeed';
import { sendEmail } from './services/email';
import {
    BREVO_PRIVATE_KEYS,
    clearBrevoConfig,
    getBrevoConfig,
    getPublicBrevoConfig,
    loadBrevoConfigFromDb,
    persistBrevoConfig,
} from './services/brevoConfig';
import { renderTransactionalEmail, wrapHtmlInEmailShell } from './messageTemplates/engine';
import { SERVICE_AREAS } from './shared/routePaths';
import {
    ensureMessageTemplatesSeededOnce
} from './messageTemplates/seed';
import {
    loadBrandVars,
    loadBusinessSettingsMap,
    adminInvoiceRecipientEmail,
    adminBookingNotifyEmail,
} from './messageTemplates/brand';
import { sendSmsFromTemplate } from './messageTemplates/smsDispatch';
import { buildBookingDetailsHtml } from './messageTemplates/bookingDetailsEmail';
import { buildDepositBankSectionHtml } from './messageTemplates/depositBankEmailHtml';
import { computeAdminPatchScheduleConflicts } from './scheduleConflictCheck';
import {
    runAutomaticBookingReminders,
    runPostCompletionReviewRequests,
    runRecurringBookingCreation,
    runRebookingNudges,
    loadBookingReminderSettings,
    saveBookingReminderSettings,
    type BookingReminderSettings,
} from './bookingReminders';
import { registerJobTrackingRoutes, runJobTrackingMonitor, trackingResetPatch } from './jobTracking';
import { registerPushToken, unregisterPushToken } from './push';
import { runColumnMigrations } from './migrations';
import { registerStaffAssessmentRoutes } from './staffAssessments';
import {
    calculateHourlyPrice,
    hourlyRateFor,
    lookupPricingRegion,
    type HourlyPriceBreakdown,
    type PricingRegion,
} from './shared/pricing';
import { getServiceTrigger } from './shared/bookingHelpers';
import { eq, desc, asc, sql, inArray, or, and, gte, lte } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import Stripe from 'stripe';
import rateLimit from 'express-rate-limit';

const app = express();
const envJwtSecret = String(process.env.JWT_SECRET || '');
const isProd = process.env.NODE_ENV === 'production';
const JWT_SECRET =
    envJwtSecret && envJwtSecret.length >= 32
        ? envJwtSecret
        : isProd
            ? ''
            : randomBytes(48).toString('hex');
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters long.');
}
if (!envJwtSecret || envJwtSecret.length < 32) {
    if (!isProd) {
        console.warn(
            '[auth] JWT_SECRET missing/short in development; using an ephemeral in-memory secret. Set JWT_SECRET in .env to keep sessions stable across restarts.',
        );
    }
}

/** Repo root (works with `tsx server/index.ts` and `dist-server/server/index.js`). */
function resolveRepoRoot(): string {
    const candidates = [process.cwd(), path.resolve(__dirname, '..'), path.resolve(__dirname, '..', '..')];
    for (const root of candidates) {
        try {
            if (fs.existsSync(path.join(root, 'package.json'))) return root;
        } catch {
            /* ignore */
        }
    }
    return process.cwd();
}

const REPO_ROOT = resolveRepoRoot();
const BROADCAST_EMAIL_UPLOAD_DIR = path.join(REPO_ROOT, 'uploads', 'broadcast-email');

const MAX_BROADCAST_IMAGE_BYTES = 2.5 * 1024 * 1024;

function parseDataUrlImage(dataUrl: string): { buffer: Buffer; ext: string; mime: string } | null {
    const s = dataUrl.trim();
    if (!s.toLowerCase().startsWith('data:image/')) return null;
    const lower = s.toLowerCase();
    const marker = ';base64,';
    const markerIdx = lower.indexOf(marker);
    if (markerIdx === -1) return null;
    const meta = s.slice('data:'.length, markerIdx);
    const mimePrimary = meta.split(';')[0].trim().toLowerCase();
    const normalizedMime =
        mimePrimary === 'image/jpg' || mimePrimary === 'image/pjpeg' ? 'image/jpeg' : mimePrimary;
    const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    if (!allowed.has(normalizedMime)) return null;
    const ext =
        normalizedMime === 'image/jpeg' ? 'jpg' : normalizedMime === 'image/png' ? 'png' : normalizedMime === 'image/gif' ? 'gif' : 'webp';
    const b64 = s.slice(markerIdx + marker.length).replace(/\s/g, '');
    let buffer: Buffer;
    try {
        buffer = Buffer.from(b64, 'base64');
    } catch {
        return null;
    }
    if (!buffer.length || buffer.length > MAX_BROADCAST_IMAGE_BYTES) return null;
    return { buffer, ext, mime: normalizedMime };
}

/** Public website origin (frontend on Vercel). Links to site pages such as /my-account must use this, not the API host. */
const PUBLIC_SITE_URL = String(process.env.PUBLIC_SITE_URL || '').trim().replace(/\/$/, '');

function publicSiteUrl(req: any): string {
    return PUBLIC_SITE_URL || publicBaseUrlFromRequest(req);
}

/** Origin of this API server, used for pages and files it serves itself (/pay/*, /uploads/*). */
function publicBaseUrlFromRequest(req: any): string {
    const xfProto = req.headers['x-forwarded-proto'];
    const firstProto = typeof xfProto === 'string' ? xfProto.split(',')[0].trim() : '';
    const proto =
        firstProto === 'https' || firstProto === 'http'
            ? firstProto
            : req.protocol === 'https'
                ? 'https'
                : 'http';
    const xfHost = req.headers['x-forwarded-host'];
    const host =
        typeof xfHost === 'string' && xfHost.trim()
            ? xfHost.split(',')[0].trim()
            : (req.get('host') as string) || 'localhost';
    return `${proto}://${host}`;
}

/** HttpOnly session cookie (browser); Bearer header still accepted for API clients. */
const AUTH_SESSION_COOKIE = 'nn_session';

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!cookieHeader) return out;
    for (const part of cookieHeader.split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k) {
            try {
                out[k] = decodeURIComponent(v);
            } catch {
                out[k] = v;
            }
        }
    }
    return out;
}

function getSessionTokenFromRequest(req: any): string | undefined {
    const authHeader = req.headers?.authorization;
    if (authHeader && typeof authHeader === 'string') {
        const m = authHeader.match(/^Bearer\s+(\S+)/i);
        if (m?.[1]) return m[1];
    }
    const cookies = parseCookieHeader(req.headers?.cookie);
    return cookies[AUTH_SESSION_COOKIE];
}

function authCookieBaseOptions(): {
    httpOnly: boolean;
    path: string;
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
} {
    const sameSiteRaw = String(process.env.COOKIE_SAME_SITE || 'lax').toLowerCase();
    const sameSite: 'lax' | 'strict' | 'none' =
        sameSiteRaw === 'strict' ? 'strict' : sameSiteRaw === 'none' ? 'none' : 'lax';
    const secure =
        sameSite === 'none'
            ? true
            : process.env.COOKIE_SECURE === '1' ||
            (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0');
    return { httpOnly: true, path: '/', secure, sameSite };
}

function attachAuthCookie(res: any, token: string) {
    const base = authCookieBaseOptions();
    res.cookie(AUTH_SESSION_COOKIE, token, {
        ...base,
        maxAge: 7 * 24 * 60 * 60 * 1000,
    });
}

function clearAuthCookie(res: any) {
    const base = authCookieBaseOptions();
    res.clearCookie(AUTH_SESSION_COOKIE, {
        path: base.path,
        httpOnly: base.httpOnly,
        secure: base.secure,
        sameSite: base.sameSite,
    });
}

/** Plain JSON for `/api/login` + `/api/me` (avoids BigInt / driver-specific values breaking `res.json`). */
function toPublicSessionUser(row: Record<string, unknown>, isSuperadmin: boolean): Record<string, unknown> {
    const idRaw = row.id;
    const id =
        typeof idRaw === 'bigint'
            ? Number(idRaw)
            : typeof idRaw === 'number' && Number.isFinite(idRaw)
                ? idRaw
                : Number(idRaw);
    const rawRole = String(row.role ?? (isSuperadmin ? 'admin' : 'customer')).trim().toLowerCase();
    const normalizedRole =
        isSuperadmin || rawRole === 'superadmin' || rawRole === 'manager' || rawRole === 'admin'
            ? 'admin'
            : rawRole === 'staff'
                ? 'staff'
                : 'customer';
    const out: Record<string, unknown> = {
        id: Number.isFinite(id) ? id : idRaw,
        email: String(row.email ?? ''),
        name: String(row.name ?? ''),
        role: normalizedRole,
        isSuperadmin,
    };
    if ('isVerified' in row || 'is_verified' in row) {
        out.isVerified = Boolean((row as { isVerified?: unknown }).isVerified ?? (row as { is_verified?: unknown }).is_verified);
    }
    if (row.loyaltyPoints != null) {
        const lp = Number(row.loyaltyPoints);
        out.loyaltyPoints = Number.isFinite(lp) ? lp : 0;
    }
    if (row.referralCode != null) out.referralCode = String(row.referralCode);
    if (row.referredBy != null) out.referredBy = String(row.referredBy);
    if ('phone' in row) {
        const p = row.phone;
        out.phone = p != null && String(p).trim() ? String(p) : null;
    }
    if ('address' in row) {
        const a = row.address;
        out.address = a != null && String(a).trim() ? String(a) : null;
    }
    if ('postcode' in row) {
        const pc = row.postcode;
        out.postcode = pc != null && String(pc).trim() ? String(pc) : null;
    }
    if ('adminTabs' in row || 'admin_tabs' in row) {
        const raw = (row as { adminTabs?: unknown; admin_tabs?: unknown }).adminTabs
            ?? (row as { adminTabs?: unknown; admin_tabs?: unknown }).admin_tabs;
        const parsed = Array.isArray(raw)
            ? raw
            : typeof raw === 'string'
                ? (() => {
                    try {
                        const p = JSON.parse(raw);
                        return Array.isArray(p) ? p : [];
                    } catch {
                        return [];
                    }
                })()
                : [];
        out.adminTabs = parsed
            .filter((x) => typeof x === 'string')
            .map((x) => String(x).trim())
            .filter(Boolean);
    }
    const ca = row.createdAt;
    if (ca != null) {
        const d = ca instanceof Date ? ca : new Date(ca as string | number);
        if (!Number.isNaN(d.getTime())) out.createdAt = d.toISOString();
    }
    return out;
}

/** Behind Apache/Nginx reverse proxy (DirectAdmin, etc.) — correct client IPs for logs/rate limits */
// if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
//     app.set('trust proxy', 1);
// }

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

function weeklyInvoiceJobTableHtml(jobListForEmail: any[]): string {
    const rows = jobListForEmail
        .map((j: any) => {
            const n = Number(j.staffCount) || 1;
            const assignment =
                n > 1 ? `Team - ${n} staff; your time = booked ÷ ${n}` : 'Solo';
            const bookedCell = Number(
                j.bookedHours != null ? j.bookedHours : (Number(j.yourHours || j.hours || 0) * n) || 0
            ).toFixed(2);
            const clientRef =
                j.clientJobTotal != null && !Number.isNaN(Number(j.clientJobTotal))
                    ? '£' + Number(j.clientJobTotal).toFixed(2)
                    : '-';
            return (
                '<tr>' +
                `<td>${j.id}</td>` +
                `<td>${j.date}</td>` +
                `<td>${j.customer}</td>` +
                `<td>${bookedCell}</td>` +
                `<td>${n}</td>` +
                `<td>${Number(j.yourHours ?? j.hours ?? 0).toFixed(2)}</td>` +
                `<td>£${Number(j.hourlyRate || 0).toFixed(2)}</td>` +
                `<td>£${Number(j.yourShare || 0).toFixed(2)}</td>` +
                `<td>${assignment}</td>` +
                `<td>${clientRef}</td>` +
                '</tr>'
            );
        })
        .join('');
    return `<table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;font-size:13px;">
<tr style="background:#f1f5f9;"><th>Job ID</th><th>Date</th><th>Customer</th><th>Booked hrs</th><th>Staff</th><th>Your hrs</th><th>Rate</th><th>Your pay</th><th>Assignment</th><th>Client £ (ref)</th></tr>
${rows}
</table>`;
}


function getBookingStartMs(b: any): number {
    const [year, month, day] = String(b.date || '').split('-').map(Number);
    const [hours, minutes] = String(b.time || '').split(':').map(Number);
    return new Date(year || 1970, (month || 1) - 1, day || 1, hours || 0, minutes || 0).getTime();
}

function isChatOpenForBooking(b: any, hasAssignedStaff: boolean): boolean {
    if (Boolean((b as any).chatClosedByAdmin)) return false;
    const startMs = getBookingStartMs(b);
    const unlockMs = startMs - (10 * 60 * 1000);
    return hasAssignedStaff && Date.now() >= unlockMs;
}

/** Load one booking by URL segment: numeric PK. */
async function selectBookingByRouteParam(raw: number | undefined | null): Promise<(typeof bookings.$inferSelect) | null> {
    const rows = await db.select().from(bookings).where(eq(bookings.id, raw ?? 0)).limit(1);
    return rows[0] ?? null;
}

const VALID_SERVICE_TRIGGERS = [
    'standard',
    'deep',
    'end_of_tenancy',
    'airbnb',
    'commercial',
    'jet_washing',
    'custom',
] as const;

const VALID_WIZARD_STEPS = [
    'details',
    'extras',
    'schedule',
    'location',
    'requirements',
    'invoice',
] as const;

type ValidServiceTrigger = typeof VALID_SERVICE_TRIGGERS[number];
type ValidWizardStep = typeof VALID_WIZARD_STEPS[number];

/** Normalize admin-supplied bookingFlow into a safe {trigger, steps} shape, or null. */
function sanitizeBookingFlowInput(raw: unknown): { trigger: ValidServiceTrigger; steps: ValidWizardStep[] } | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const trig = typeof obj.trigger === 'string' ? (obj.trigger as string).toLowerCase() : '';
    const trigger = (VALID_SERVICE_TRIGGERS as readonly string[]).includes(trig)
        ? (trig as ValidServiceTrigger)
        : 'standard';
    const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
    const seen = new Set<string>();
    const steps: ValidWizardStep[] = [];
    for (const s of rawSteps) {
        const key = typeof s === 'string' ? s.toLowerCase() : '';
        if ((VALID_WIZARD_STEPS as readonly string[]).includes(key) && !seen.has(key)) {
            seen.add(key);
            steps.push(key as ValidWizardStep);
        }
    }
    return { trigger, steps };
}

async function notifyAssignedStaffSms(
    staffIds: number[],
    booking: {
        /** Public code (e.g. CIN-XXXXXX) for SMS template `booking_id`. */
        displayBookingId: string;
        contactName?: string | null;
        date?: string | null;
        time?: string | null;
        addressLine1?: string | null;
        addressCity?: string | null;
        addressPostcode?: string | null;
    }
) {
    if (!staffIds?.length) return;
    const brand = await loadBrandVars(db);
    const jobAddress = [booking.addressLine1, booking.addressCity, booking.addressPostcode].filter(Boolean).join(', ') || 'See portal';
    for (const sid of staffIds) {
        const rec = await db.select().from(staff).where(eq(staff.id, sid)).limit(1);
        if (!rec.length || !rec[0].phone) continue;
        try {
            await sendSmsFromTemplate(db, 'staff_new_assignment', rec[0].phone, {
                ...brand,
                staff_name: rec[0].name,
                booking_id: booking.displayBookingId,
                client_name: booking.contactName || 'Client',
                service_date: String(booking.date || ''),
                service_time: String(booking.time || ''),
                job_address: jobAddress,
            });
        } catch (e) {
            console.error('notifyAssignedStaffSms:', e);
        }
    }
}


/** Hero CMS JSON can include multiple base64 images; TEXT (64KB) is too small. */


// async function ensureStaffCancelRequestsTable() {
//     await db.execute(sql.raw(`
//         CREATE TABLE IF NOT EXISTS staff_cancel_requests (
//             id INT AUTO_INCREMENT PRIMARY KEY,
//             booking_id INT NOT NULL,
//             staff_user_id BIGINT UNSIGNED NOT NULL,
//             staff_name VARCHAR(255) NOT NULL,
//             reason TEXT NULL,
//             status VARCHAR(20) NOT NULL DEFAULT 'Pending',
//             admin_note TEXT NULL,
//             responded_by BIGINT UNSIGNED NULL,
//             responded_at TIMESTAMP NULL DEFAULT NULL,
//             created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
//             INDEX idx_staff_cancel_requests_booking_id (booking_id),
//             INDEX idx_staff_cancel_requests_status (status),
//             INDEX idx_staff_cancel_requests_staff_user_id (staff_user_id)
//         )
//     `));
//     try {
//         await poolConnection.query(
//             'ALTER TABLE `staff_cancel_requests` MODIFY COLUMN `booking_id` INT NOT NULL',
//         );
//     } catch (e: any) {
//         const m = String(e?.message || e?.sqlMessage || '').toLowerCase();
//         if (!m.includes("doesn't exist") && !m.includes('unknown column') && !m.includes('duplicate')) {
//             console.warn('staff_cancel_requests.booking_id INT migration:', e?.message || e);
//         }
//     }
// }

/**
 * Ensures every `superadmins` row has a matching `users` row (role admin) so FK-backed
 * notifications and admin bell queries work for superadmin logins.
 */
async function ensureSuperadminsMirroredToAdminUsers() {
    const supers = await db.select().from(superadmins);
    for (const s of supers) {
        try {
            const existing = await db.select().from(users).where(eq(users.email, s.email)).limit(1);
            if (existing.length > 0) {
                await db.update(users).set({ role: 'admin', name: s.name }).where(eq(users.id, existing[0].id));
            } else {
                await db.insert(users).values({
                    email: s.email,
                    passwordHash: s.passwordHash,
                    name: s.name,
                    role: 'admin',
                    isVerified: true,
                });
            }
        } catch (e) {
            console.warn('ensureSuperadminsMirroredToAdminUsers:', s.email, e);
        }
    }
}

async function getAdminUserIds(): Promise<number[]> {
    const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`LOWER(TRIM(${users.role})) = 'admin'`);
    return rows.map((r) => Number(r.id)).filter((id) => Number.isFinite(id) && id > 0);
}

function getReferralRewardAmount(settingsMap: Record<string, unknown>): number {
    const raw = Number(settingsMap?.referralRewardAmount);
    if (!Number.isFinite(raw) || raw < 0) return 20;
    return raw;
}

function mapGalleryRow(g: typeof galleryItems.$inferSelect) {
    return {
        id: Number(g.id),
        title: g.title,
        imageUrl: g.imageUrl,
        caption: g.caption ?? null,
        sortOrder: g.sortOrder ?? 0,
        published: Boolean(g.published),
    };
}

function mapBlogRow(b: typeof blogPosts.$inferSelect) {
    return {
        id: Number(b.id),
        title: b.title,
        slug: b.slug,
        excerpt: b.excerpt ?? null,
        bodyHtml: b.bodyHtml,
        heroImageUrl: b.heroImageUrl ?? null,
        metaTitle: b.metaTitle ?? null,
        metaDescription: b.metaDescription ?? null,
        metaKeywords: b.metaKeywords ?? null,
        published: Boolean(b.published),
        publishedAt: b.publishedAt ? new Date(b.publishedAt as unknown as Date).toISOString() : null,
        createdAt: b.createdAt ? new Date(b.createdAt as unknown as Date).toISOString() : null,
        updatedAt: b.updatedAt ? new Date(b.updatedAt as unknown as Date).toISOString() : null,
    };
}

/** Browser origins allowed to call the API with cookies: CORS_ORIGIN, else the public site (+ www variant). */
function resolveCorsOrigins(): string[] {
    const explicit = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
    if (explicit.length) return explicit;
    if (!PUBLIC_SITE_URL) return [];
    try {
        const u = new URL(PUBLIC_SITE_URL);
        const alt = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
        return [PUBLIC_SITE_URL, `${u.protocol}//${alt}`];
    } catch {
        return [PUBLIC_SITE_URL];
    }
}
const corsOrigins = resolveCorsOrigins();
const corsOptions = {
    credentials: true,
    // Development (no origins configured) reflects any origin; production should set PUBLIC_SITE_URL or CORS_ORIGIN.
    origin: corsOrigins.length ? corsOrigins : (true as boolean),
    exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Limit'],
};
app.use(cors(corsOptions));

app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    if (isProd) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many attempts. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const contactLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/forgot-password', authLimiter);
app.use('/api/reset-password', authLimiter);
app.use('/api/contact', contactLimiter);
app.use('/api/quote-lead', contactLimiter);
app.use('/api/quote-submit', contactLimiter);
app.use('/api/newsletter-signup', contactLimiter);

// ── Stripe setup ──
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

// Stripe webhook must be registered BEFORE express.json() so it receives the raw body
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    let event: Stripe.Event;
    try {
        if (stripeWebhookSecret) {
            event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] as string, stripeWebhookSecret);
        } else {
            event = req.body as Stripe.Event;
        }
    } catch (err: any) {
        console.error('Stripe webhook signature verification failed:', err?.message);
        return res.status(400).send(`Webhook Error: ${err?.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object as Stripe.PaymentIntent;
        const invoiceId = pi.metadata?.invoiceId;
        const bookingId = pi.metadata?.bookingId;
        if (invoiceId) {
            try {
                await db.update(customerInvoices).set({
                    status: 'paid',
                    paidAt: new Date(),
                }).where(eq(customerInvoices.id, Number(invoiceId)));
                console.log(`[stripe] Invoice #${invoiceId} marked paid via webhook`);
                broadcastSync('all');
            } catch (e: any) {
                console.error('[stripe] Failed to update invoice:', e?.message);
            }
        }
        if (bookingId) {
            try {
                await db.update(bookings).set({ invoicePaid: true }).where(eq(bookings.id, Number(bookingId)));
                console.log(`[stripe] Booking #${bookingId} deposit marked paid via webhook`);
                broadcastSync('all');
            } catch (e: any) {
                console.error('[stripe] Failed to update booking:', e?.message);
            }
        }
    }

    res.json({ received: true });
});

app.use(express.json({ limit: '12mb' }));
app.use('/uploads', express.static(path.join(REPO_ROOT, 'uploads')));

function stripHtmlTags(value: unknown): unknown {
    if (typeof value === 'string') {
        return value.replace(/<[^>]*>/g, '').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/<[^>]*>/g, '');
    }
    if (Array.isArray(value)) return value.map(stripHtmlTags);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = stripHtmlTags(v);
        return out;
    }
    return value;
}

app.use((req, _res, next) => {
    if (req.body && typeof req.body === 'object' && req.path !== '/api/stripe-webhook' && req.path !== '/api/admin/broadcast/email') {
        req.body = stripHtmlTags(req.body);
    }
    next();
});

// Request Logger
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
});

app.get('/api/health', async (_req, res) => {
    try {
        await db.execute(sql`SELECT 1`);
        res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
    } catch (e: any) {
        res.status(503).json({ status: 'error', message: 'Database connection failed' });
    }
});

/** AI concierge chat -- proxies to Anthropic Claude API */
app.post('/api/ai/chat', express.json(), async (req, res) => {
    try {
        const { query, brandName, knowledgeBase, systemPrompt, websiteUrl, apiKeyOverride } = req.body as {
            query?: string;
            brandName?: string;
            knowledgeBase?: string;
            systemPrompt?: string;
            websiteUrl?: string;
            apiKeyOverride?: string;
        };

        if (!query || typeof query !== 'string' || !query.trim()) {
            res.status(400).json({ error: 'query is required' });
            return;
        }

        const apiKey = (apiKeyOverride?.trim() || process.env.ANTHROPIC_API_KEY || '').trim();
        if (!apiKey) {
            res.json({
                response:
                    'Sorry — our assistant is temporarily unavailable. Please try again in a moment, or reach us using the contact details on our website.',
            });
            return;
        }

        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey });

        const brand = brandName?.trim() || 'our business';
        const system = (systemPrompt || '').replace(/\{\{BRAND\}\}/g, brand);
        const kb = (knowledgeBase || '').slice(0, 100_000);
        const website = (websiteUrl || '').trim();

        const contextLines: string[] = [
            '--- Business context (use for accurate answers; do not invent facts not present below) ---',
        ];
        if (website) contextLines.push(`Website: ${website}`);
        if (kb) contextLines.push('', 'Reference material:', kb);

        const fullSystem = [system, '', ...contextLines].join('\n');

        const message = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: fullSystem,
            messages: [{ role: 'user', content: query.trim() }],
        });

        const text =
            message.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n') || "I'm sorry, I couldn't process that. Please try again!";

        res.json({ response: text });
    } catch (error) {
        console.error('Claude AI error:', error);
        res.json({
            response: "Hello! I'm your booking assistant. How can I help you with your booking today?",
        });
    }
});

/** Google Maps — return the public JS API key to the client */
app.get('/api/maps/key', (_req, res) => {
    const key = process.env.GOOGLE_MAPS_API_KEY || '';
    if (!key) return res.status(503).json({ error: 'Google Maps API key not configured' });
    res.json({ key });
});

/** Google Maps — server-side geocode (protects the key for Geocoding API calls) */
app.post('/api/maps/geocode', express.json(), async (req, res) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    if (!apiKey) return res.status(503).json({ error: 'Google Maps API key not configured' });
    const { address } = req.body as { address?: string };
    if (!address || typeof address !== 'string' || address.trim().length < 3) {
        return res.status(400).json({ error: 'Address is required' });
    }
    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address.trim())}&key=${apiKey}&region=gb`;
        const resp = await fetch(url);
        const data = (await resp.json()) as {
            status: string;
            results?: { geometry: { location: { lat: number; lng: number } }; formatted_address: string }[];
        };
        if (data.status !== 'OK' || !data.results?.length) {
            return res.status(404).json({ error: 'Address not found', status: data.status });
        }
        const loc = data.results[0].geometry.location;
        res.json({ lat: loc.lat, lng: loc.lng, formatted: data.results[0].formatted_address });
    } catch (err) {
        console.error('Geocode error:', err);
        res.status(500).json({ error: 'Geocoding failed' });
    }
});

/** Google Maps — server-side directions */
app.post('/api/maps/directions', express.json(), async (req, res) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    if (!apiKey) return res.status(503).json({ error: 'Google Maps API key not configured' });
    const { origin, destination } = req.body as { origin?: string; destination?: string };
    if (!origin || !destination) return res.status(400).json({ error: 'Origin and destination required' });
    try {
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=driving&key=${apiKey}&region=gb`;
        const resp = await fetch(url);
        const data = await resp.json();
        res.json(data);
    } catch (err) {
        console.error('Directions error:', err);
        res.status(500).json({ error: 'Directions failed' });
    }
});

/** Public gallery & blog - registered early (before other large route blocks) */
app.get('/api/gallery', async (_req, res) => {
    try {
        const rows = await db
            .select()
            .from(galleryItems)
            .where(eq(galleryItems.published, true))
            .orderBy(asc(galleryItems.sortOrder), asc(galleryItems.id));
        res.json(rows.map(mapGalleryRow));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
});

app.get('/api/blog-posts', async (_req, res) => {
    try {
        const rows = await db
            .select()
            .from(blogPosts)
            .where(eq(blogPosts.published, true))
            .orderBy(desc(blogPosts.publishedAt), desc(blogPosts.id));
        res.json(rows.map(mapBlogRow));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to load posts' });
    }
});

app.get('/api/blog-posts/:slug', async (req, res) => {
    try {
        const slug = String(req.params.slug || '').trim();
        if (!slug) return res.status(400).json({ error: 'Invalid slug' });
        const rows = await db
            .select()
            .from(blogPosts)
            .where(and(eq(blogPosts.slug, slug), eq(blogPosts.published, true)))
            .limit(1);
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(mapBlogRow(rows[0]));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to load post' });
    }
});

// Auth
app.post('/api/login', async (req, res) => {
    try {
        const { email: rawEmail, password } = req.body || {};
        const email = String(rawEmail ?? '')
            .trim()
            .toLowerCase();
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        if (password == null || String(password).length === 0) {
            return res.status(400).json({ error: 'Password is required' });
        }

        // 1. Check superadmins FIRST
        const superResult = await db.select().from(superadmins).where(eq(superadmins.email, email));
        let user: any = null;
        let isSuperadmin = false;

        if (superResult.length > 0) {
            user = superResult[0];
            user.role = 'admin'; // Force role for frontend
            isSuperadmin = true;
        } else {
            // 2. Check normal users (customers, staff)
            const userResult = await db.select().from(users).where(eq(users.email, email));
            if (userResult.length > 0) {
                user = userResult[0];
                isSuperadmin = false;
            }
        }

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = await bcrypt.compare(password, String(user.passwordHash ?? ''));
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const foundUser = toPublicSessionUser(user as Record<string, unknown>, isSuperadmin);

        // Generate JWT
        const token = jwt.sign(
            {
                id: foundUser.id,
                email: foundUser.email,
                role: foundUser.role,
                isSuperadmin: foundUser.isSuperadmin,
            },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        attachAuthCookie(res, token);
        res.json({ user: foundUser, token });
    } catch (error: any) {
        console.error("Login error:", error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Middleware to verify JWT (Bearer or HttpOnly session cookie)
const authenticateToken = (req: any, res: any, next: any) => {
    const token = getSessionTokenFromRequest(req);

    if (!token) return res.status(401).json({ message: 'No token provided' });

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
        if (err) return res.status(403).json({ message: 'Invalid or expired token' });
        req.user = user;
        next();
    });
};

app.post('/api/logout', (_req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
});

app.post('/api/account/delete', authenticateToken, async (req: any, res: any) => {
    try {
        const userId = req.user.id;
        const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        const userEmail = userRow?.email || 'unknown';

        try {
            await sendEmail({
                to: [{ email: 'info@cleanitneatly.com' }],
                subject: `GDPR Account Deletion Request - User #${userId}`,
                htmlContent: `<p>User #${userId} (${userEmail}) has requested account deletion via the app on ${new Date().toISOString()}. All personal data must be erased within 30 days per UK GDPR Article 17.</p><p>Action required: delete user record, associated bookings PII, chat messages, and any other personal data.</p>`,
            });
        } catch {}

        if (userEmail && userEmail !== 'unknown') {
            try {
                await sendEmail({
                    to: [{ email: userEmail }],
                    subject: 'Account Deletion Request Received - CiN Cleaning',
                    htmlContent: `<p>We have received your request to delete your account and personal data. This will be processed within 30 days as required by UK GDPR.</p><p>If you did not make this request, please contact us immediately at info@cleanitneatly.com.</p>`,
                });
            } catch {}
        }

        clearAuthCookie(res);
        res.json({ message: 'Account deletion requested. Your data will be erased within 30 days.' });
    } catch {
        res.status(500).json({ error: 'Could not process deletion request.' });
    }
});

app.post('/api/account/data-export', authenticateToken, async (req: any, res: any) => {
    try {
        const userId = req.user.id;
        const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        const userEmail = userRow?.email || 'unknown';

        try {
            await sendEmail({
                to: [{ email: 'info@cleanitneatly.com' }],
                subject: `GDPR Subject Access Request - User #${userId}`,
                htmlContent: `<p>User #${userId} (${userEmail}) has submitted a Subject Access Request (SAR) via the app on ${new Date().toISOString()}. A copy of their personal data must be provided within 30 days per UK GDPR Article 15.</p><p>Data to include: user profile, booking history, chat messages, payment records, notification preferences, referral data.</p>`,
            });
        } catch {}

        if (userEmail && userEmail !== 'unknown') {
            try {
                await sendEmail({
                    to: [{ email: userEmail }],
                    subject: 'Data Export Request Received - CiN Cleaning',
                    htmlContent: `<p>We have received your Subject Access Request. A copy of your personal data will be sent to this email address within 30 days as required by UK GDPR.</p><p>If you did not make this request, please contact us at info@cleanitneatly.com.</p>`,
                });
            } catch {}
        }

        res.json({ message: 'Your data export request has been submitted. You will receive it via email within 30 days.' });
    } catch {
        res.status(500).json({ error: 'Could not process data export request.' });
    }
});

const isAdminUser = (req: any): boolean => {
    return req?.user?.role === 'admin' || req?.user?.isSuperadmin === true;
};

const requireAdmin = (req: any, res: any): boolean => {
    if (!isAdminUser(req)) {
        res.status(403).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
};

registerJobTrackingRoutes(app, db, authenticateToken, requireAdmin);
registerStaffAssessmentRoutes(app, db, authenticateToken);

// Get current user from token
app.get('/api/me', authenticateToken, async (req: any, res: any) => {
    try {
        const { id, isSuperadmin } = req.user;
        let user;

        if (isSuperadmin) {
            const results = await db.select().from(superadmins).where(eq(superadmins.id, id)).limit(1);
            user = results[0] ? { ...results[0], role: 'admin', isSuperadmin: true } : null;
        } else {
            const results = await db.select().from(users).where(eq(users.id, id)).limit(1);
            user = results[0] ? { ...results[0], isSuperadmin: false } : null;
        }

        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(toPublicSessionUser(user as Record<string, unknown>, Boolean(isSuperadmin)));
    } catch (error: any) {
        res.status(500).json({ message: 'Failed to fetch current user' });
    }
});

app.get('/api/users/:id', authenticateToken, async (req: any, res: any) => {
    try {
        const userId = parseInt(req.params.id);
        if (!isAdminUser(req) && Number(req.user?.id) !== Number(userId)) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        // Check normal users
        let userResult = await db.select().from(users).where(eq(users.id, userId));
        let user: any = userResult[0];
        let isSuperadmin = false;

        if (!user) {
            // Check superadmins
            const superResult = await db.select().from(superadmins).where(eq(superadmins.id, userId));
            if (superResult.length > 0) {
                user = superResult[0];
                user.role = 'admin';
                isSuperadmin = true;
            }
        }

        if (!user) return res.status(404).json({ error: 'User not found' });

        let userInfo: any = { ...user, isSuperadmin };
        delete userInfo.passwordHash;

        // If staff, append staff data
        if (userInfo.role === 'staff') {
            const staffData = await db.select().from(staff).where(eq(staff.userId, userId));
            if (staffData.length) {
                userInfo = { ...userInfo, ...staffData[0] };
            }
        }
        res.json(userInfo);
    } catch (error) {
        console.error("Fetch user error:", error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

app.patch('/api/users/:id', authenticateToken, async (req: any, res) => {
    try {
        const userId = parseInt(req.params.id);
        if (!Number.isFinite(userId) || userId <= 0) {
            return res.status(400).json({ error: 'Invalid user id' });
        }
        const isSelf = Number(req.user?.id) === userId;
        if (!isAdminUser(req) && !isSelf) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!existing.length) return res.status(404).json({ error: 'User not found' });

        const payload = req.body || {};
        const hasOwn = (k: string) => Object.prototype.hasOwnProperty.call(payload, k);
        const patch: Record<string, unknown> = {};

        if (hasOwn('name')) {
            const name = String(payload.name || '').trim();
            if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
            patch.name = name;
        }
        if (hasOwn('email')) {
            const email = String(payload.email || '').trim().toLowerCase();
            if (!email) return res.status(400).json({ error: 'Email cannot be empty.' });
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({ error: 'Email looks invalid.' });
            }
            const emailOwner = await db.select().from(users).where(eq(users.email, email)).limit(1);
            if (emailOwner.length && Number(emailOwner[0].id) !== userId) {
                return res.status(409).json({ error: 'Email is already in use by another account.' });
            }
            patch.email = email;
        }
        if (hasOwn('phone')) {
            const phoneRaw = payload.phone != null ? String(payload.phone).trim() : '';
            patch.phone = phoneRaw || null;
        }
        if (hasOwn('address')) {
            const raw = payload.address != null ? String(payload.address).trim() : '';
            patch.address = raw || null;
        }
        if (hasOwn('postcode')) {
            const rawPc = payload.postcode != null ? String(payload.postcode).trim().toUpperCase() : '';
            if (rawPc) {
                const UK_PC = /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/;
                if (!UK_PC.test(rawPc)) {
                    return res.status(400).json({ error: 'Postcode looks invalid.' });
                }
                // Canonicalise to "OUTWARD INWARD" with a single space.
                const compact = rawPc.replace(/\s+/g, '');
                patch.postcode = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
            } else {
                patch.postcode = null;
            }
        }

        if (hasOwn('imageUrl')) {
            const imgUrl = payload.imageUrl != null ? String(payload.imageUrl).trim() : '';
            patch.imageUrl = imgUrl || null;
        }

        // Optional password change. Self-updates must verify current password first.
        if (hasOwn('password') && payload.password) {
            const newPw = String(payload.password);
            if (newPw.length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters.' });
            }
            if (isSelf && !isAdminUser(req)) {
                const currentPassword = payload.currentPassword ? String(payload.currentPassword) : '';
                if (!currentPassword) {
                    return res.status(400).json({ error: 'Current password is required to change password.' });
                }
                const currentHash = String(existing[0].passwordHash || '');
                if (!currentHash) {
                    return res.status(400).json({ error: 'Cannot verify current password.' });
                }
                const matches = await bcrypt.compare(currentPassword, currentHash);
                if (!matches) {
                    return res.status(400).json({ error: 'Current password is incorrect.' });
                }
            }
            patch.passwordHash = await bcrypt.hash(newPw, 10);
        }

        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update.' });
        }

        await db.update(users).set(patch as any).where(eq(users.id, userId));
        const [updated] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!updated) return res.status(404).json({ error: 'User not found' });
        const { passwordHash, ...safeUser } = updated;
        res.json(safeUser);
    } catch (error) {
        console.error('Update user profile error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// Referrals
app.get('/api/referrals', authenticateToken, async (req: any, res) => {
    try {
        const { userId, type } = req.query;
        const settingsMap = await loadBusinessSettingsMap(db);
        const referralRewardAmount = getReferralRewardAmount(settingsMap);

        if (userId) {
            let referrerUserId = parseInt(userId as string, 10);
            if (Number.isNaN(referrerUserId)) return res.json([]);

            // Backward compatibility: some clients may send staff profile id instead of users.id
            if (String(type || '').toLowerCase() === 'staff') {
                const asUser = await db.select().from(users).where(eq(users.id, referrerUserId)).limit(1);
                if (!asUser.length) {
                    const sp = await db.select().from(staff).where(eq(staff.id, referrerUserId)).limit(1);
                    if (sp.length && Number(sp[0].userId) > 0) {
                        referrerUserId = Number(sp[0].userId);
                    }
                }
            }

            // Non-admin can only fetch their own referrals
            if (req.user.role !== 'admin' && Number(req.user.id) !== referrerUserId) {
                return res.status(403).json({ error: 'Unauthorized' });
            }

            // Find users referred by this user
            const referrer = await db.select().from(users).where(eq(users.id, referrerUserId));
            if (!referrer.length) return res.json([]);
            const code = referrer[0].referralCode;
            const referred = await db.select().from(users).where(eq(users.referredBy, code ?? ''));

            const results = referred.map(u => ({
                id: `ref-${u.id}`,
                referrerId: referrerUserId,
                referrerName: referrer[0].name,
                referrerType: String(type || '').toLowerCase() === 'staff' ? 'staff' : 'customer',
                referredClientName: u.name,
                dateReferred: u.createdAt,
                status: u.isVerified ? 'Completed' : 'Pending',
                rewardAmount: referralRewardAmount
            }));
            return res.json(results);
        }

        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
        // Admins see normalized referral rows across customer + staff referrers.
        const referredRows = await db.select().from(users).where(sql`referred_by IS NOT NULL`);
        const codes = Array.from(
            new Set(
                referredRows
                    .map((r) => String(r.referredBy || '').trim())
                    .filter((v) => v.length > 0)
            )
        );
        const referrers = codes.length
            ? await db.select().from(users).where(inArray(users.referralCode, codes))
            : [];
        const referrerByCode = new Map(referrers.map((u) => [String(u.referralCode || '').trim(), u]));

        const results = referredRows.map((u) => {
            const code = String(u.referredBy || '').trim();
            const ref = referrerByCode.get(code);
            const refRole = String(ref?.role || '').toLowerCase();
            return {
                id: `ref-${u.id}`,
                referrerId: Number(ref?.id || 0),
                referrerName: ref?.name || `Unknown (${code})`,
                referrerType: refRole === 'staff' ? 'staff' : 'customer',
                referredClientName: u.name,
                dateReferred: u.createdAt,
                status: u.isVerified ? 'Completed' : 'Pending',
                rewardAmount: referralRewardAmount,
            };
        });
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch referrals' });
    }
});

app.get('/api/admin/loyalty-overview', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const allUsers = await db.select().from(users);
        const customers = allUsers.filter((u) => String(u.role || '').toLowerCase() === 'customer');
        const totalCustomers = customers.length;
        const customersWithPoints = customers.filter((u) => Number(u.loyaltyPoints || 0) > 0).length;
        const totalPoints = customers.reduce((s, u) => s + Number(u.loyaltyPoints || 0), 0);

        const topCustomers = customers
            .map((u) => ({
                id: Number(u.id),
                name: u.name,
                email: u.email,
                loyaltyPoints: Number(u.loyaltyPoints || 0),
                referralCode: String(u.referralCode || ''),
            }))
            .sort((a, b) => b.loyaltyPoints - a.loyaltyPoints)
            .slice(0, 12);

        const referredRows = allUsers.filter((u) => String(u.referredBy || '').trim().length > 0);
        const referrerByCode = new Map(
            allUsers
                .filter((u) => String(u.referralCode || '').trim().length > 0)
                .map((u) => [String(u.referralCode || '').trim(), u] as const)
        );
        const refCounts = new Map<number, { id: number; name: string; role: string; referrals: number }>();
        for (const r of referredRows) {
            const code = String(r.referredBy || '').trim();
            const ref = referrerByCode.get(code);
            if (!ref) continue;
            const id = Number(ref.id);
            if (!refCounts.has(id)) {
                refCounts.set(id, {
                    id,
                    name: ref.name,
                    role: String(ref.role || 'customer'),
                    referrals: 0,
                });
            }
            refCounts.get(id)!.referrals += 1;
        }
        const topReferrers = Array.from(refCounts.values())
            .sort((a, b) => b.referrals - a.referrals)
            .slice(0, 12);

        res.json({
            totalCustomers,
            customersWithPoints,
            totalPoints,
            topCustomers,
            topReferrers,
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch loyalty overview' });
    }
});

app.get('/api/admin/dashboard-stats', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const thisMonthStart = todayStr.slice(0, 7) + '-01';
        const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthStart = lastMonthDate.toISOString().slice(0, 10).slice(0, 7) + '-01';
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
        const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);

        // Revenue this month
        const [revenueThisMonth] = await db.select({
            total: sql`COALESCE(SUM(CAST(total_price AS DECIMAL(10,2))), 0)`
        }).from(bookings).where(
            and(
                gte(bookings.date, thisMonthStart),
                inArray(bookings.status, ['Confirmed', 'Completed'])
            )
        );

        // Revenue last month
        const [revenueLastMonth] = await db.select({
            total: sql`COALESCE(SUM(CAST(total_price AS DECIMAL(10,2))), 0)`
        }).from(bookings).where(
            and(
                gte(bookings.date, lastMonthStart),
                lte(bookings.date, lastMonthEnd),
                inArray(bookings.status, ['Confirmed', 'Completed'])
            )
        );

        // Bookings this month
        const [bookingsThisMonth] = await db.select({
            count: sql`COUNT(*)`
        }).from(bookings).where(gte(bookings.date, thisMonthStart));

        // Bookings last month
        const [bookingsLastMonth] = await db.select({
            count: sql`COUNT(*)`
        }).from(bookings).where(
            and(gte(bookings.date, lastMonthStart), lte(bookings.date, lastMonthEnd))
        );

        // Bookings by status
        const statusCounts = await db.select({
            status: bookings.status,
            count: sql`COUNT(*)`
        }).from(bookings).groupBy(bookings.status);

        // Today's bookings
        const [todayBookings] = await db.select({
            count: sql`COUNT(*)`
        }).from(bookings).where(eq(bookings.date, todayStr));

        // This week's bookings
        const [weekBookings] = await db.select({
            count: sql`COUNT(*)`
        }).from(bookings).where(gte(bookings.date, weekAgo));

        // Average rating
        const [avgRating] = await db.select({
            avg: sql`COALESCE(AVG(rating), 0)`,
            count: sql`COUNT(rating)`
        }).from(bookings).where(sql`rating IS NOT NULL`);

        // Cancellation rate this month
        const [cancelledThisMonth] = await db.select({
            count: sql`COUNT(*)`
        }).from(bookings).where(
            and(
                gte(bookings.date, thisMonthStart),
                eq(bookings.status, 'Cancelled')
            )
        );

        // Total customers
        const [totalCustomers] = await db.select({
            count: sql`COUNT(*)`
        }).from(users).where(sql`LOWER(TRIM(role)) = 'customer'`);

        // New customers this month
        const [newCustomersThisMonth] = await db.select({
            count: sql`COUNT(*)`
        }).from(users).where(
            and(
                sql`LOWER(TRIM(role)) = 'customer'`,
                gte(users.createdAt, new Date(thisMonthStart))
            )
        );

        // Active staff
        const [activeStaff] = await db.select({
            count: sql`COUNT(*)`
        }).from(staff).where(eq(staff.status, 'Active'));

        // Revenue by month (last 6 months) for trend chart
        const revenueByMonth = await db.select({
            month: sql`DATE_FORMAT(date, '%Y-%m')`,
            total: sql`COALESCE(SUM(CAST(total_price AS DECIMAL(10,2))), 0)`,
            count: sql`COUNT(*)`
        }).from(bookings).where(
            and(
                gte(bookings.date, new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString().slice(0, 10)),
                inArray(bookings.status, ['Confirmed', 'Completed'])
            )
        ).groupBy(sql`DATE_FORMAT(date, '%Y-%m')`).orderBy(sql`DATE_FORMAT(date, '%Y-%m')`);

        // Top services
        const topServices = await db.select({
            serviceType: bookings.serviceType,
            count: sql`COUNT(*)`,
            revenue: sql`COALESCE(SUM(CAST(total_price AS DECIMAL(10,2))), 0)`
        }).from(bookings).where(
            inArray(bookings.status, ['Confirmed', 'Completed'])
        ).groupBy(bookings.serviceType).orderBy(sql`COUNT(*) DESC`).limit(5);

        const bookingsThisMonthCount = Number(bookingsThisMonth?.count) || 0;
        const cancelledCount = Number(cancelledThisMonth?.count) || 0;
        const cancellationRate = bookingsThisMonthCount > 0
            ? Math.round((cancelledCount / bookingsThisMonthCount) * 100)
            : 0;

        res.json({
            revenue: {
                thisMonth: Number(revenueThisMonth?.total) || 0,
                lastMonth: Number(revenueLastMonth?.total) || 0,
                trend: revenueByMonth.map(r => ({
                    month: r.month,
                    total: Number(r.total) || 0,
                    bookings: Number(r.count) || 0,
                })),
            },
            bookings: {
                today: Number(todayBookings?.count) || 0,
                thisWeek: Number(weekBookings?.count) || 0,
                thisMonth: bookingsThisMonthCount,
                lastMonth: Number(bookingsLastMonth?.count) || 0,
                byStatus: Object.fromEntries(
                    statusCounts.map(s => [s.status || 'Unknown', Number(s.count) || 0])
                ),
            },
            customers: {
                total: Number(totalCustomers?.count) || 0,
                newThisMonth: Number(newCustomersThisMonth?.count) || 0,
            },
            staff: {
                active: Number(activeStaff?.count) || 0,
            },
            ratings: {
                average: Math.round((Number(avgRating?.avg) || 0) * 10) / 10,
                totalReviews: Number(avgRating?.count) || 0,
            },
            cancellationRate,
            topServices: topServices.map(s => ({
                serviceType: s.serviceType,
                count: Number(s.count) || 0,
                revenue: Number(s.revenue) || 0,
            })),
        });
    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard stats' });
    }
});

app.get('/api/admin/accounts', authenticateToken, async (req: any, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Admin only' });
    try {
        const rows = await db
            .select({
                id: users.id,
                name: users.name,
                email: users.email,
                role: users.role,
                adminTabs: users.adminTabs,
                createdAt: users.createdAt,
            })
            .from(users)
            .where(sql`LOWER(TRIM(${users.role})) = 'admin'`)
            .orderBy(desc(users.id));
        res.json(rows);
    } catch (e) {
        console.error('admin/accounts get:', e);
        res.status(500).json({ error: 'Failed to fetch admin accounts' });
    }
});

app.patch('/api/admin/accounts/:id/menu-scope', authenticateToken, async (req: any, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Admin only' });
    if (req.user?.isSuperadmin !== true) return res.status(403).json({ error: 'Superadmin only' });
    try {
        const id = parseInt(req.params.id);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid account id' });
        const allowedTabs = [
            'overview',
            'bookings',
            'quotes',
            'assignment',
            'rota',
            'liveMap',
            'staff',
            'staffInvoices',
            'performance',
            'customerInvoices',
            'expenses',
            'services',
            'marketing',
            'reviews',
            'communication',
            'support',
            'settings',
        ];
        const raw = Array.isArray(req.body?.adminTabs) ? req.body.adminTabs : [];
        const tabs = raw
            .filter((x: unknown) => typeof x === 'string')
            .map((x: string) => x.trim())
            .filter((x: string) => allowedTabs.includes(x));
        if (tabs.length === 0) {
            return res.status(400).json({ error: 'Select at least one menu for this admin.' });
        }
        const target = await db.select().from(users).where(eq(users.id, id)).limit(1);
        if (!target.length) return res.status(404).json({ error: 'Admin account not found' });
        if (String(target[0].role || '').toLowerCase() !== 'admin') {
            return res.status(400).json({ error: 'Target account is not an admin user.' });
        }
        await db.update(users).set({ adminTabs: tabs } as any).where(eq(users.id, id));
        res.json({ message: 'Admin menu scope updated', adminTabs: tabs });
    } catch (e) {
        console.error('admin/accounts menu-scope patch:', e);
        res.status(500).json({ error: 'Failed to update admin menu scope' });
    }
});

app.patch('/api/referrals/:referralId', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const raw = req.params.referralId.replace(/^ref-/, '');
        const userId = parseInt(raw, 10);
        if (Number.isNaN(userId)) return res.status(400).json({ error: 'Invalid referral id' });
        const { status, rewardAmount } = req.body || {};
        if (status === 'Completed' || status === 'Pending') {
            await db.update(users).set({ isVerified: status === 'Completed' }).where(eq(users.id, userId));
        }
        if (rewardAmount !== undefined && rewardAmount !== null && rewardAmount !== '') {
            const parsed = Number(rewardAmount);
            if (!Number.isFinite(parsed) || parsed < 0) {
                return res.status(400).json({ error: 'Invalid reward amount' });
            }
            await db
                .insert(businessSettings)
                .values({ key: 'referralRewardAmount', value: String(parsed) })
                .onDuplicateKeyUpdate({ set: { value: String(parsed) } });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update referral' });
    }
});

// Services
/** Optional £ rate from admin input: positive number as a decimal string, anything else clears it (null). */
function parseOptionalRate(v: unknown): string | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}

app.get('/api/services', async (req, res) => {
    const results = await db.select().from(services);
    res.json(results);
});

app.post('/api/services', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { name, description, baseRate, londonRate, minDuration, minNotice, icon, pricingModel, active, callOutCharge, bookingFlow } = req.body || {};
    if (!name || String(name).trim() === '') {
        return res.status(400).json({ error: 'Service name is required' });
    }
    if (baseRate === undefined || baseRate === null || baseRate === '') {
        return res.status(400).json({ error: 'Base rate is required' });
    }
    const rawModel = pricingModel != null ? String(pricingModel).toLowerCase() : 'hourly';
    const model =
        rawModel === 'fixed' || rawModel === 'flat'
            ? 'flat'
            : ['hourly', 'size_based', 'room_based', 'bedroom_based', 'quote'].includes(rawModel)
                ? rawModel
                : 'hourly';
    const md =
        minDuration != null && minDuration !== '' && !Number.isNaN(parseInt(String(minDuration), 10))
            ? parseInt(String(minDuration), 10)
            : 2;
    const mn =
        minNotice != null && minNotice !== '' && !Number.isNaN(parseInt(String(minNotice), 10))
            ? parseInt(String(minNotice), 10)
            : 2;
    let coVal: string | null = null;
    if (callOutCharge != null && callOutCharge !== '') {
        const n = Number(callOutCharge);
        if (Number.isFinite(n) && n >= 0) coVal = String(n);
    }
    const flow = sanitizeBookingFlowInput(bookingFlow);
    const result = await db
        .insert(services)
        .values({
            name: String(name).trim(),
            description: description != null ? String(description) : null,
            baseRate: String(baseRate),
            londonRate: parseOptionalRate(londonRate),
            minDuration: md,
            minNotice: mn,
            callOutCharge: coVal,
            icon: icon != null ? String(icon) : 'Sparkles',
            pricingModel: model,
            active: active !== false && active !== 0 && active !== 'false',
            bookingFlow: flow,
        })
        .$returningId();
    broadcastSync('all');
    res.json({ id: result[0].id, message: 'Service created' });
});

app.patch('/api/services/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const sid = parseInt(req.params.id, 10);
    if (Number.isNaN(sid)) return res.status(400).json({ error: 'Invalid service id' });
    const allowed = [
        'name',
        'description',
        'baseRate',
        'pricingModel',
        'minDuration',
        'minNotice',
        'icon',
        'features',
        'active',
    ] as const;
    const patch: Record<string, unknown> = {};
    for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) {
            patch[k] = (req.body as Record<string, unknown>)[k];
        }
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'callOutCharge')) {
        const v = (req.body as Record<string, unknown>).callOutCharge;
        if (v === null || v === undefined || v === '') {
            patch.callOutCharge = null;
        } else {
            const n = Number(v);
            patch.callOutCharge = Number.isFinite(n) && n >= 0 ? String(n) : null;
        }
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'bookingFlow')) {
        const v = (req.body as Record<string, unknown>).bookingFlow;
        patch.bookingFlow = v == null ? null : sanitizeBookingFlowInput(v);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'londonRate')) {
        patch.londonRate = parseOptionalRate((req.body as Record<string, unknown>).londonRate);
    }
    if (patch.baseRate !== undefined) patch.baseRate = String(patch.baseRate);
    if (patch.pricingModel !== undefined) {
        const raw = String(patch.pricingModel).toLowerCase();
        patch.pricingModel =
            raw === 'fixed' || raw === 'flat'
                ? 'flat'
                : ['hourly', 'size_based', 'room_based', 'bedroom_based', 'quote'].includes(raw)
                    ? raw
                    : 'hourly';
    }
    if (patch.minDuration !== undefined) patch.minDuration = parseInt(String(patch.minDuration), 10) || 2;
    if (patch.minNotice !== undefined) patch.minNotice = parseInt(String(patch.minNotice), 10) || 2;
    if (Object.keys(patch).length === 0) return res.json({ message: 'Service updated' });
    await db.update(services).set(patch as any).where(eq(services.id, sid));
    broadcastSync('all');
    res.json({ message: 'Service updated' });
});

app.delete('/api/services/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const sid = parseInt(req.params.id, 10);
    if (Number.isNaN(sid)) return res.status(400).json({ error: 'Invalid service id' });
    await db.delete(services).where(eq(services.id, sid));
    broadcastSync('all');
    res.json({ message: 'Service deleted' });
});

// Extra Services
app.get('/api/extra-services', async (req, res) => {
    const results = await db.select().from(extraServices);
    res.json(results);
});

app.post('/api/extra-services', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { name, price, type, duration, active } = req.body;
    const result = await db.insert(extraServices).values({ name, price, type, duration, active }).$returningId();
    broadcastSync('all');
    res.json({ id: result[0].id, message: 'Extra service created' });
});

app.patch('/api/extra-services/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const eid = parseInt(req.params.id, 10);
    if (Number.isNaN(eid)) return res.status(400).json({ error: 'Invalid extra id' });
    const { name, price, type, duration, active } = req.body;
    await db.update(extraServices).set({ name, price, type, duration, active }).where(eq(extraServices.id, eid));
    broadcastSync('all');
    res.json({ message: 'Extra service updated' });
});

app.delete('/api/extra-services/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const eid = parseInt(req.params.id, 10);
    if (Number.isNaN(eid)) return res.status(400).json({ error: 'Invalid extra id' });
    await db.delete(extraServices).where(eq(extraServices.id, eid));
    broadcastSync('all');
    res.json({ message: 'Extra service deleted' });
});

// Discounts
app.get('/api/discounts', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'staff') return res.status(403).json({ error: 'Unauthorized' });
    const results = await db.select().from(discounts);
    res.json(results);
});

app.post('/api/discounts', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'staff') return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { code, type, value, usageLimit } = req.body;
        await db.insert(discounts).values({
            code,
            type,
            value: value.toString(),
            usageLimit: usageLimit ? parseInt(usageLimit, 10) : null
        });
        broadcastSync('all');
        res.json({ message: 'Discount created' });
    } catch (err: any) {
        console.error("Create discount err:", err);
        res.status(500).json({ error: 'Failed' });
    }
});

app.delete('/api/discounts/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'staff') return res.status(403).json({ error: 'Unauthorized' });
    await db.delete(discounts).where(eq(discounts.id, parseInt(req.params.id)));
    broadcastSync('all');
    res.json({ message: 'Discount deleted' });
});

app.post('/api/validate-discount', async (req, res) => {
    try {
        const { code } = req.body;
        const discount = await db.select().from(discounts).where(eq(discounts.code, code));

        if (!discount.length || !discount[0].isActive) {
            return res.status(404).json({ valid: false, message: 'Invalid or inactive code' });
        }

        const d = discount[0];
        if (d.expiresAt && new Date(d.expiresAt) < new Date()) {
            return res.status(400).json({ valid: false, message: 'Code expired' });
        }
        if (d.usageLimit !== null && (d.usedCount ?? 0) >= d.usageLimit) {
            return res.status(400).json({ valid: false, message: 'Usage limit reached' });
        }

        res.json({ valid: true, discount: d });
    } catch (error) {
        res.status(500).json({ error: 'Validation failed' });
    }
});

// Registration
app.post('/api/register', async (req, res) => {
    try {
        const { email: rawEmail, password, name: rawName, referredBy, phone: rawPhone } = req.body || {};
        const email = String(rawEmail ?? '')
            .trim()
            .toLowerCase();
        const name = String(rawName ?? '').trim();
        const phone =
            rawPhone != null && String(rawPhone).trim() ? String(rawPhone).trim().slice(0, 50) : null;
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        if (password == null || String(password).length < 1) {
            return res.status(400).json({ error: 'Password is required' });
        }
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }
        console.log("REGISTER INPUTS:", { email, referredBy, hasPhone: !!phone });

        if (referredBy) {
            const referrer = await db.select().from(users).where(eq(users.referralCode, referredBy));
            console.log("REFERRER FOUND:", referrer);
            if (!referrer.length) {
                return res.status(400).json({ error: 'Invalid referral code.' });
            }
        }

        const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (existing.length) {
            return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
        }

        // Random referral code: CIN + 4 random chars (aligned with booking id prefix)
        const referralCode = 'CIN' + Math.random().toString(36).substring(2, 6).toUpperCase();
        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = await db.insert(users).values({
            email,
            passwordHash: hashedPassword,
            name,
            role: 'customer',
            isVerified: false,
            referralCode,
            referredBy, // Nullable
            loyaltyPoints: 0,
            phone,
        }).$returningId();

        const newUserId = newUser[0].id;

        // Auto-match past guest bookings to this new registered user via email
        await db.update(bookings)
            .set({ customerId: newUserId })
            .where(eq(bookings.contactEmail, email));

        const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(referralCode)}`;

        const brandWelcome = await loadBrandVars(db);
        try {
            const { subject, html } = await renderTransactionalEmail(db, 'customer_welcome', {
                ...brandWelcome,
                client_name: name,
                client_email: email,
                referral_code: referralCode,
                qr_code_url: qrCodeUrl,
            });
            await sendEmail({ to: [{ email, name }], subject, htmlContent: html });
        } catch (emailErr) {
            console.error('Welcome email failed:', emailErr);
        }
        if (phone) {
            try {
                await sendSmsFromTemplate(db, 'customer_welcome_sms', phone, {
                    ...brandWelcome,
                    client_name: name,
                });
            } catch (smsErr) {
                console.error('Welcome SMS failed:', smsErr);
            }
        }

        // 3. Notify Admin(s)
        const adminIds = await getAdminUserIds();
        if (adminIds.length > 0) {
            await db.insert(notifications).values(
                adminIds.map((adminId) => ({
                    userId: adminId,
                    type: 'system' as const,
                    message: `New User Registration: ${name} (${email})`,
                    isRead: false,
                }))
            );
        }

        broadcastSync('notifications');

        const regToken = jwt.sign(
            { id: newUserId, email, role: 'customer', isSuperadmin: false },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        attachAuthCookie(res, regToken);
        res.status(201).json({
            id: newUserId,
            message: 'User registered. Please check your email.',
            referralCode,
            token: regToken,
            user: { id: newUserId, name, email, role: 'customer', isVerified: false, referralCode, loyaltyPoints: 0, phone },
        });
    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});


// --- Public Contact / Support Inquiry ---------------------------------------
// Accepts a website contact-form submission and emails it to the support inbox.
// Rate-limited per-IP (in-memory) so a single abusive client cannot spam the inbox.
const CONTACT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const CONTACT_MAX_PER_WINDOW = 5;
const contactIpHits = new Map<string, number[]>();

function escapeHtmlBasic(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isPlausibleEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/** `business_settings.value` stores JSON objects as strings; parse for keys like `cancellationPolicy`. */
function parseBusinessSettingObject(map: Record<string, string>, key: string): Record<string, unknown> | undefined {
    const raw = map[key];
    if (raw == null || typeof raw !== 'string' || !raw.trim()) return undefined;
    try {
        const v = JSON.parse(raw) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
        /* ignore */
    }
    return undefined;
}

async function resolveSupportInboxEmail(): Promise<string> {
    const envFallback = (process.env.SUPPORT_EMAIL || process.env.CONTACT_INBOX || '').trim();
    try {
        const rows = await db.select().from(businessSettings).where(eq(businessSettings.key, 'email'));
        const raw = rows[0]?.value;
        if (raw && typeof raw === 'string' && isPlausibleEmail(raw.trim())) {
            return raw.trim();
        }
    } catch (e) {
        // Fall through to env / default.
    }
    if (isPlausibleEmail(envFallback)) return envFallback;
    return 'support@cleanitneatly.com';
}

function parseLocalBookingStartMs(rawDate: unknown, rawTime: unknown): number {
    const dateStr = String(rawDate || '').trim();
    const timeStr = String(rawTime || '09:00').trim();
    const dateParts = dateStr.split('-').map(Number);
    if (dateParts.length !== 3 || dateParts.some((n) => Number.isNaN(n))) return NaN;
    const [y, mo, d] = dateParts;
    const [hhRaw, mmRaw] = timeStr.split(':');
    const hh = Number(hhRaw);
    const mm = Number(mmRaw ?? '0');
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return NaN;
    return new Date(y, mo - 1, d, hh, mm, 0, 0).getTime();
}

function durationHoursFromUnknown(v: unknown): number | null {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    return null;
}

/** Email capture from the first-time-visitor discount popup (GDPR: requires explicit marketing consent). */
app.post('/api/newsletter-signup', async (req, res) => {
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const email = String(body.email ?? '').trim().slice(0, 160);
        const marketingConsent = body.marketingConsent === true;
        if (!isPlausibleEmail(email)) return res.status(400).json({ error: 'A valid email address is required.' });
        if (!marketingConsent) return res.status(400).json({ error: 'Marketing consent is required to sign up.' });

        const ipHeader = req.headers['x-forwarded-for'];
        const ip = Array.isArray(ipHeader) ? ipHeader[0] : (typeof ipHeader === 'string' ? ipHeader.split(',')[0] : '') || req.ip || 'unknown';
        const now = Date.now();
        const recent = (contactIpHits.get(ip) || []).filter((t) => now - t < CONTACT_WINDOW_MS);
        if (recent.length >= CONTACT_MAX_PER_WINDOW) {
            return res.status(429).json({ error: 'Too many requests from this device. Please try again shortly.' });
        }
        recent.push(now);
        contactIpHits.set(ip, recent);

        const admins = await db
            .select({ id: users.id })
            .from(users)
            .where(sql`LOWER(TRIM(${users.role})) = 'admin'`);
        for (const admin of admins) {
            await db.insert(notifications).values({
                userId: admin.id,
                type: 'system',
                message: `New first-time discount signup: ${email} (marketing consent: yes, timestamp: ${new Date().toISOString()})`,
                isRead: false,
            });
        }
        if (admins.length > 0) broadcastSync('notifications');

        res.json({ success: true });
    } catch (error) {
        console.error('Newsletter signup error:', error);
        res.status(500).json({ error: 'Failed to process signup' });
    }
});

app.post('/api/contact', async (req, res) => {
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const name = String(body.name ?? '').trim().slice(0, 120);
        const email = String(body.email ?? '').trim().slice(0, 160);
        const serviceType = String(body.serviceType ?? '').trim().slice(0, 120);
        const message = String(body.message ?? '').trim().slice(0, 4000);

        if (!name) return res.status(400).json({ error: 'Please share your name.' });
        if (!isPlausibleEmail(email)) return res.status(400).json({ error: 'A valid email address is required.' });
        if (message.length < 5) return res.status(400).json({ error: 'Tell us a little more about what you need.' });

        // Basic per-IP rate limit to keep the support inbox clean.
        const ipHeader = req.headers['x-forwarded-for'];
        const ip = Array.isArray(ipHeader) ? ipHeader[0] : (typeof ipHeader === 'string' ? ipHeader.split(',')[0] : '') || req.ip || 'unknown';
        const now = Date.now();
        const recent = (contactIpHits.get(ip) || []).filter((t) => now - t < CONTACT_WINDOW_MS);
        if (recent.length >= CONTACT_MAX_PER_WINDOW) {
            return res.status(429).json({ error: 'Too many messages from this device. Please try again shortly.' });
        }
        recent.push(now);
        contactIpHits.set(ip, recent);

        const supportInbox = await resolveSupportInboxEmail();
        const brandVars = await loadBrandVars(db);
        const brandName = brandVars?.brand_name || 'CiN Cleaning';
        const subject = `[${brandName}] Website inquiry from ${name}`;

        const safeName = escapeHtmlBasic(name);
        const safeEmail = escapeHtmlBasic(email);
        const safeService = escapeHtmlBasic(serviceType || 'Not specified');
        const safeMessage = escapeHtmlBasic(message).replace(/\n/g, '<br />');

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 620px; margin: 0 auto;">
                <h2 style="margin:0 0 8px 0; font-size:20px;">New website inquiry</h2>
                <p style="color:#475569; margin:0 0 16px 0; font-size:14px;">Submitted via the Contact Us form on ${brandName}.</p>
                <table cellpadding="0" cellspacing="0" style="width:100%; border-collapse:collapse; font-size:14px;">
                    <tr><td style="padding:8px 0; color:#64748b; width:120px;">Name</td><td style="padding:8px 0; font-weight:600;">${safeName}</td></tr>
                    <tr><td style="padding:8px 0; color:#64748b;">Email</td><td style="padding:8px 0; font-weight:600;"><a href="mailto:${safeEmail}" style="color:#0ea5e9;">${safeEmail}</a></td></tr>
                    <tr><td style="padding:8px 0; color:#64748b;">Service</td><td style="padding:8px 0; font-weight:600;">${safeService}</td></tr>
                </table>
                <div style="margin-top:16px; padding:16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; line-height:1.6;">
                    ${safeMessage}
                </div>
                <p style="color:#94a3b8; font-size:12px; margin-top:18px;">Reply directly to this email to respond to ${safeName}.</p>
            </div>
        `;

        try {
            await sendEmail({
                to: [{ email: supportInbox, name: brandName }],
                subject,
                htmlContent,
            });
        } catch (err) {
            console.error('Contact form email failed to dispatch:', err);
            return res.status(502).json({ error: 'We could not deliver your message right now. Please try again in a few minutes.' });
        }

        res.json({ ok: true, message: 'Message received — our team will be in touch shortly.' });
    } catch (error) {
        console.error('Contact form error:', error);
        res.status(500).json({ error: 'Unable to submit your message right now.' });
    }
});


// --- Quote Widget → Brevo CRM -------------------------------------------------
const QUOTE_PIPELINE_MAP: Record<string, string> = {
    'Standard Cleaning': 'standard',
    'Deep Cleaning': 'deep',
    'End of Tenancy': 'end_of_tenancy',
    'Airbnb / Short-Let': 'airbnb',
    'Commercial': 'commercial',
};

// Phase-1 lead capture: email + phone + name before the visitor uses the quote tool.
app.post('/api/quote-lead', async (req, res) => {
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const firstName = String(body.first_name ?? '').trim().slice(0, 120);
        const email = String(body.email ?? '').trim().toLowerCase().slice(0, 160);
        const phone = String(body.phone ?? '').trim().slice(0, 50);

        if (!isPlausibleEmail(email)) return res.status(400).json({ error: 'A valid email address is required.' });

        const ipHeader = req.headers['x-forwarded-for'];
        const ip = Array.isArray(ipHeader) ? ipHeader[0] : (typeof ipHeader === 'string' ? ipHeader.split(',')[0] : '') || req.ip || 'unknown';
        const now = Date.now();
        const recent = (contactIpHits.get(ip) || []).filter((t) => now - t < CONTACT_WINDOW_MS);
        if (recent.length >= CONTACT_MAX_PER_WINDOW) {
            return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
        }
        recent.push(now);
        contactIpHits.set(ip, recent);

        const inserted = await db.insert(quoteLeads).values({
            firstName: firstName || null,
            email,
            phone: phone || null,
            postcode: null,
            serviceType: 'Pending',
            bedrooms: null,
            bathrooms: null,
            priceEstimate: null,
            status: 'new',
        }).$returningId();
        const leadId = inserted[0]?.id;
        broadcastSync('quotes');

        res.json({ ok: true, id: leadId });
    } catch (error) {
        console.error('[quote-lead] error:', error);
        res.status(500).json({ error: 'Could not save your details.' });
    }
});

app.post('/api/quote-submit', async (req, res) => {
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const firstName = String(body.first_name ?? '').trim().slice(0, 120);
        const email = String(body.email ?? '').trim().toLowerCase().slice(0, 160);
        const phone = String(body.phone ?? '').trim().slice(0, 50);
        const postcode = String(body.postcode ?? '').trim().toUpperCase().slice(0, 12);
        const serviceType = String(body.service_type ?? '').trim().slice(0, 120);
        const bedrooms = String(body.bedrooms ?? '').trim().slice(0, 10);
        const bathrooms = String(body.bathrooms ?? '').trim().slice(0, 10);
        const rawEstimate = Number(body.price_estimate);
        const priceEstimate = Number.isFinite(rawEstimate) && rawEstimate > 0 ? rawEstimate : null;
        const existingLeadId = Number(body.lead_id) || null;

        if (!firstName) return res.status(400).json({ error: 'Please tell us your first name.' });
        if (!isPlausibleEmail(email)) return res.status(400).json({ error: 'A valid email address is required.' });
        if (!serviceType) return res.status(400).json({ error: 'Please choose a service.' });

        const ipHeader = req.headers['x-forwarded-for'];
        const ip = Array.isArray(ipHeader) ? ipHeader[0] : (typeof ipHeader === 'string' ? ipHeader.split(',')[0] : '') || req.ip || 'unknown';
        const now = Date.now();
        const recent = (contactIpHits.get(ip) || []).filter((t) => now - t < CONTACT_WINDOW_MS);
        if (recent.length >= CONTACT_MAX_PER_WINDOW) {
            return res.status(429).json({ error: 'Too many requests from this device. Please try again shortly.' });
        }
        recent.push(now);
        contactIpHits.set(ip, recent);

        // 1. Persist the lead — update the existing row if lead_id was captured earlier, else insert new.
        let leadId: number | undefined;
        if (existingLeadId) {
            await db.update(quoteLeads).set({
                firstName,
                email,
                phone: phone || null,
                postcode: postcode || null,
                serviceType,
                bedrooms: bedrooms || null,
                bathrooms: bathrooms || null,
                priceEstimate: priceEstimate == null ? null : priceEstimate.toFixed(2),
            }).where(eq(quoteLeads.id, existingLeadId));
            leadId = existingLeadId;
        } else {
            const inserted = await db.insert(quoteLeads).values({
                firstName,
                email,
                phone: phone || null,
                postcode: postcode || null,
                serviceType,
                bedrooms: bedrooms || null,
                bathrooms: bathrooms || null,
                priceEstimate: priceEstimate == null ? null : priceEstimate.toFixed(2),
                status: 'new',
            }).$returningId();
            leadId = inserted[0]?.id;
        }

        // 2. Surface it to admins in-app.
        try {
            const admins = await db
                .select({ id: users.id })
                .from(users)
                .where(sql`LOWER(TRIM(${users.role})) = 'admin'`);
            const estimateText = priceEstimate == null ? 'bespoke quote' : `est. £${priceEstimate}`;
            for (const admin of admins) {
                await db.insert(notifications).values({
                    userId: admin.id,
                    type: 'system',
                    message: `New quote lead: ${firstName} wants ${serviceType} in ${postcode || 'unknown postcode'} (${estimateText}). ${email}${phone ? ' · ' + phone : ''}`,
                    isRead: false,
                });
            }
            if (admins.length > 0) broadcastSync('notifications');
        } catch (notifyErr) {
            console.error('[quote-submit] admin notification failed:', notifyErr);
        }
        broadcastSync('quotes');

        // 3. Email the visitor their estimate (the main purpose of collecting the address).
        try {
            const brand = await loadBrandVars(db);
            const siteUrl = String(brand.site_url || 'https://cleanitneatly.com').replace(/\/$/, '');
            const bedLabel = bedrooms ? `${bedrooms} bed` : '';
            const bathLabel = bathrooms ? `${bathrooms} bath` : '';
            const propertySummary =
                serviceType.toLowerCase().includes('commercial')
                    ? 'Commercial premises'
                    : [bedLabel, bathLabel].filter(Boolean).join(', ') || 'Not specified';
            const { subject, html } = await renderTransactionalEmail(db, 'client_quote_estimate', {
                ...brand,
                client_name: firstName,
                service_type: serviceType,
                property_summary: propertySummary,
                price_line: priceEstimate == null ? 'Bespoke quote — we will be in touch' : `From £${priceEstimate}`,
                discount_code: 'FIRST10',
                booking_url: `${siteUrl}/book-cleaning`,
            });
            await sendEmail({ to: [{ email, name: firstName }], subject, htmlContent: html });
        } catch (mailErr) {
            console.error('[quote-submit] estimate email failed:', mailErr);
        }

        // 4. Best-effort CRM sync to Brevo.
        let synced = false;
        const cfg = getBrevoConfig();
        if (cfg.apiKey) {
            const headers = { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' };
            try {
                const contactRes = await fetch('https://api.brevo.com/v3/contacts', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        email,
                        attributes: {
                            FIRSTNAME: firstName,
                            SMS: phone,
                            POSTCODE: postcode,
                            LAST_SERVICE_INTEREST: serviceType,
                            QUOTE_BEDROOMS: bedrooms,
                            QUOTE_BATHROOMS: bathrooms,
                            QUOTE_PRICE: priceEstimate ?? '',
                            LEAD_SOURCE: 'quote_widget',
                        },
                        listIds: [2],
                        updateEnabled: true,
                    }),
                });
                const dealRes = await fetch('https://api.brevo.com/v3/crm/deals', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        name: `Quote — ${serviceType} — ${firstName} (${postcode || 'no postcode'})`,
                        attributes: {
                            deal_stage: 'New Lead',
                            pipeline: QUOTE_PIPELINE_MAP[serviceType] || 'standard',
                            amount: priceEstimate ?? 0,
                        },
                    }),
                });
                // Brevo returns 204 on an existing-contact update, so accept any 2xx.
                synced = contactRes.ok && dealRes.ok;
                if (!synced) {
                    console.warn('[quote-submit] Brevo sync not confirmed:', contactRes.status, dealRes.status);
                }
                if (synced && leadId) {
                    await db.update(quoteLeads).set({ brevoSynced: true }).where(eq(quoteLeads.id, leadId));
                }
            } catch (brevoErr) {
                console.error('[quote-submit] Brevo sync failed:', brevoErr);
            }
        }

        res.json({ ok: true, id: leadId, synced });
    } catch (error) {
        console.error('[quote-submit] error:', error);
        res.status(500).json({ error: 'Quote submission failed.' });
    }
});

const QUOTE_LEAD_STATUSES = ['new', 'contacted', 'converted', 'lost'];

app.get('/api/admin/quote-leads', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const rows = await db.select().from(quoteLeads).orderBy(desc(quoteLeads.createdAt)).limit(1000);

        // Link each lead to bookings made with the same email, so admins can see who actually booked.
        const emails = Array.from(new Set(rows.map((r) => String(r.email || '').trim().toLowerCase()).filter(Boolean)));
        const bookingsByEmail = new Map<string, Array<{ id: number; bookingId: string | null; date: string; status: string | null; totalPrice: string | null; createdAt: Date | null }>>();
        if (emails.length > 0) {
            const matches = await db
                .select({
                    id: bookings.id,
                    bookingId: bookings.bookingId,
                    date: bookings.date,
                    status: bookings.status,
                    totalPrice: bookings.totalPrice,
                    createdAt: bookings.createdAt,
                    email: sql<string>`LOWER(TRIM(${bookings.contactEmail}))`,
                })
                .from(bookings)
                .where(inArray(sql`LOWER(TRIM(${bookings.contactEmail}))`, emails))
                .orderBy(asc(bookings.createdAt));
            for (const m of matches) {
                const list = bookingsByEmail.get(m.email) ?? [];
                list.push(m);
                bookingsByEmail.set(m.email, list);
            }
        }

        res.json(rows.map((r) => {
            const all = bookingsByEmail.get(String(r.email || '').trim().toLowerCase()) ?? [];
            const leadAt = r.createdAt ? new Date(r.createdAt).getTime() : 0;
            const after = all.filter((b) => (b.createdAt ? new Date(b.createdAt).getTime() : 0) >= leadAt);
            const first = after[0];
            return {
                ...r,
                matchedBooking: first
                    ? { id: first.id, bookingId: first.bookingId, date: first.date, status: first.status, totalPrice: first.totalPrice }
                    : null,
                bookingsAfterQuote: after.length,
                bookingsBeforeQuote: all.length - after.length,
            };
        }));
    } catch (error) {
        console.error('[quote-leads] list error:', error);
        res.status(500).json({ error: 'Failed to fetch quote leads' });
    }
});

app.patch('/api/admin/quote-leads/:id', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });
        const updates: { status?: string; statusUpdatedAt?: Date; adminNotes?: string | null } = {};
        if (req.body?.status !== undefined) {
            const status = String(req.body.status);
            if (!QUOTE_LEAD_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
            updates.status = status;
            updates.statusUpdatedAt = new Date();
        }
        if (req.body?.adminNotes !== undefined) {
            const notes = String(req.body.adminNotes ?? '').trim().slice(0, 5000);
            updates.adminNotes = notes || null;
        }
        if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });
        const existing = await db.select({ id: quoteLeads.id }).from(quoteLeads).where(eq(quoteLeads.id, id)).limit(1);
        if (!existing.length) return res.status(404).json({ error: 'Quote request not found' });
        await db.update(quoteLeads).set(updates).where(eq(quoteLeads.id, id));
        broadcastSync('quotes');
        res.json({ message: 'Lead updated' });
    } catch (error) {
        console.error('[quote-leads] update error:', error);
        res.status(500).json({ error: 'Failed to update lead' });
    }
});

app.delete('/api/admin/quote-leads/:id', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });
        const existing = await db.select({ id: quoteLeads.id }).from(quoteLeads).where(eq(quoteLeads.id, id)).limit(1);
        if (!existing.length) return res.status(404).json({ error: 'Quote request not found' });
        await db.delete(quoteLeads).where(eq(quoteLeads.id, id));
        broadcastSync('quotes');
        res.json({ message: 'Lead deleted' });
    } catch (error) {
        console.error('[quote-leads] delete error:', error);
        res.status(500).json({ error: 'Failed to delete lead' });
    }
});

// Bookings
type StandardBookingPrice = {
    region: PricingRegion;
    regionSource: string;
    hourlyRate: number;
    breakdown: HourlyPriceBreakdown;
};

/**
 * Authoritative price for Standard (hourly) cleans: pricing region from the postcode, rates and extras from the
 * database, discount re-validated with the same rules as /api/validate-discount. Other services return null
 * and keep their existing behaviour.
 */
async function priceStandardBooking(bookingData: any): Promise<StandardBookingPrice | null> {
    const serviceRows = await db.select().from(services);
    const hint = String(bookingData?.serviceType ?? '').trim().toLowerCase();
    const svc = serviceRows.find(
        (s) => String(s.id) === String(bookingData?.serviceType ?? '') || String(s.name || '').trim().toLowerCase() === hint,
    );
    if (!svc) return null;
    const trigger = getServiceTrigger({ id: String(svc.id), name: svc.name, bookingFlow: svc.bookingFlow } as any);
    if (trigger !== 'standard') return null;

    const lookup = await lookupPricingRegion(bookingData?.address?.postcode);
    const region: PricingRegion = lookup?.region ?? 'standard';
    const hourlyRate = hourlyRateFor({ baseRate: svc.baseRate, londonRate: svc.londonRate }, region);

    const minHours = Number(svc.minDuration) > 0 ? Number(svc.minDuration) : 2;
    const requested =
        durationHoursFromUnknown(bookingData?.duration) ?? durationHoursFromUnknown(bookingData?.propertyDetails?.duration);
    const hours = Math.max(minHours, requested ?? minHours);

    const extraRows = await db.select().from(extraServices);
    const extras = (Array.isArray(bookingData?.extras) ? bookingData.extras : [])
        .map((item: { id?: unknown; quantity?: unknown }) => {
            const row = extraRows.find((e) => String(e.id) === String(item?.id));
            return row ? { price: row.price, quantity: Number(item?.quantity) || 0 } : null;
        })
        .filter(Boolean) as Array<{ price: string; quantity: number }>;

    let discount: { type: string; value: string } | null = null;
    const code = String(bookingData?.discountCode ?? '').trim();
    if (code) {
        const [d] = await db.select().from(discounts).where(eq(discounts.code, code)).limit(1);
        const usable =
            d &&
            d.isActive &&
            !(d.expiresAt && new Date(d.expiresAt) < new Date()) &&
            !(d.usageLimit !== null && (d.usedCount ?? 0) >= d.usageLimit);
        if (usable) discount = { type: String(d.type), value: String(d.value) };
    }

    const base = {
        hourlyRate,
        hours,
        extras,
        cleaningMaterials: bookingData?.propertyDetails?.cleaningMaterials ?? null,
        discount,
    };
    const tipRaw = Number(bookingData?.tipAmount);
    let tipAmount: number;
    if (bookingData?.tipAmount !== undefined && bookingData?.tipAmount !== null && Number.isFinite(tipRaw)) {
        tipAmount = Math.max(0, tipRaw);
    } else {
        // Older clients fold the tip into totalPrice: anything above the correct price is the customer's tip.
        const withoutTip = calculateHourlyPrice(base);
        const clientTotal = Number(bookingData?.totalPrice);
        tipAmount = Number.isFinite(clientTotal) ? Math.max(0, clientTotal - withoutTip.total) : 0;
    }

    return {
        region,
        regionSource: lookup?.source ?? 'none',
        hourlyRate,
        breakdown: calculateHourlyPrice({ ...base, tip: { amount: tipAmount } }),
    };
}

app.post('/api/bookings', async (req, res) => {
    try {
        const bookingData = req.body;
        const frequencyValueRaw = String(bookingData?.frequency || '').trim();
        const normalizedFrequency =
            frequencyValueRaw === 'One-time' ||
                frequencyValueRaw === 'Weekly' ||
                frequencyValueRaw === 'Fortnightly' ||
                frequencyValueRaw === 'Monthly'
                ? frequencyValueRaw
                : undefined;
        const propertyDetailsSnapshot =
            bookingData?.propertyDetails && typeof bookingData.propertyDetails === 'object'
                ? {
                    ...(bookingData.propertyDetails as Record<string, unknown>),
                    ...(normalizedFrequency ? { frequency: normalizedFrequency } : {}),
                }
                : bookingData?.propertyDetails || null;
        const depositAccepted =
            bookingData.depositTermsAccepted === true ||
            bookingData.depositTermsAccepted === 'true' ||
            bookingData.depositTermsAccepted === 1;
        if (!depositAccepted) {
            return res.status(400).json({
                error: 'Please confirm acceptance of deposit and payment terms before completing your booking.',
            });
        }

        // Standard cleans: the server's price is what gets saved (the client's total is quietly corrected).
        const serverPrice = await priceStandardBooking(bookingData);
        if (serverPrice) {
            const correctTotal = serverPrice.breakdown.total.toFixed(2);
            const clientTotal = Number(bookingData.totalPrice);
            if (!Number.isFinite(clientTotal) || Math.round(clientTotal * 100) !== serverPrice.breakdown.pence.total) {
                console.warn(
                    `[pricing] Standard booking total corrected from ${bookingData.totalPrice} to ${correctTotal} ` +
                    `(${serverPrice.region} via ${serverPrice.regionSource}, £${serverPrice.hourlyRate.toFixed(2)}/h x ${serverPrice.breakdown.hours}h)`,
                );
            }
            bookingData.totalPrice = correctTotal;
            bookingData.discountAmount = serverPrice.breakdown.discount.toFixed(2);
        }

        // Handle Discount & Points Calculation
        let discountAmount = 0;
        let pointsToEarn = 0;

        if (bookingData.discountCode) {
            const discount = await db.select().from(discounts).where(eq(discounts.code, bookingData.discountCode));
            if (discount.length && discount[0].isActive) {
                const d = discount[0];
                // Update Usage
                await db.update(discounts).set({ usedCount: ((d.usedCount || 0) + 1) }).where(eq(discounts.id, d.id));

                // Calculate Discount Amount (Simulate logic, ideally frontend passes exact amount or we recalc)
                // For now assume frontend sends finalized totalPrice, but we store the discount metadata
                discountAmount = parseFloat(bookingData.discountAmount || 0);
            }
        }

        // Points Logic: 1 point per £10 spent (approx)
        pointsToEarn = Math.floor(parseFloat(bookingData.totalPrice) / 10);

        const publicBookingId = `CIN-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

        // Soft conflict check (non-blocking): detect overlapping booking windows so admin can triage.
        let conflictWarning: {
            conflictCount: number;
            conflictingBookingIds: string[];
            message: string;
        } | null = null;
        try {
            const allRows = await db.select({
                id: bookings.id,
                bookingId: bookings.bookingId,
                customerId: bookings.customerId,
                serviceType: bookings.serviceType,
                date: bookings.date,
                time: bookings.time,
                status: bookings.status,
                totalPrice: bookings.totalPrice,
                addressLine1: bookings.addressLine1,
                addressCity: bookings.addressCity,
                addressPostcode: bookings.addressPostcode,
                contactName: bookings.contactName,
                contactEmail: bookings.contactEmail,
                contactPhone: bookings.contactPhone,
                propertyDetails: bookings.propertyDetails,
                extras: bookings.extras,
                assignedStaffId: bookings.assignedStaffId,
            }).from(bookings);
            const serviceRows = await db.select().from(services);
            const extraRowsForOverlap = await db.select().from(extraServices);
            const serviceHint = String(bookingData?.serviceType || '').trim().toLowerCase();
            const matchedService = serviceRows.find((s) =>
                String(s.id) === String(bookingData?.serviceType || '') ||
                String(s.name || '').trim().toLowerCase() === serviceHint
            );
            const explicitDuration =
                durationHoursFromUnknown(bookingData?.duration) ??
                durationHoursFromUnknown(bookingData?.propertyDetails?.duration);
            let estimatedNewDuration = explicitDuration ?? Number(matchedService?.minDuration || 2);
            if (!explicitDuration && Array.isArray(bookingData?.extras) && bookingData.extras.length > 0) {
                const byId = new Map<string, { duration?: number | null }>(
                    extraRowsForOverlap.map((e) => [String(e.id), { duration: e.duration }])
                );
                for (const ex of bookingData.extras as Array<{ id?: unknown; quantity?: unknown }>) {
                    const exRow = byId.get(String(ex?.id ?? ''));
                    const exMinutes = Number(exRow?.duration || 0);
                    const qty = Math.max(1, Number(ex?.quantity || 1));
                    if (Number.isFinite(exMinutes) && exMinutes > 0) {
                        estimatedNewDuration += (exMinutes * qty) / 60;
                    }
                }
            }
            estimatedNewDuration = Math.max(1 / 60, estimatedNewDuration);

            const newStart = parseLocalBookingStartMs(bookingData?.date, bookingData?.time);
            if (Number.isFinite(newStart)) {
                const newEnd = newStart + estimatedNewDuration * 3600000;
                const conflicts = allRows
                    .filter((r) => String(r.status || '') !== 'Cancelled')
                    .filter((r) => {
                        const existingStart = parseLocalBookingStartMs(r.date, r.time);
                        if (!Number.isFinite(existingStart)) return false;
                        const pd = (r.propertyDetails as { duration?: unknown } | null) || null;
                        const existingService = serviceRows.find((s) =>
                            String(s.id) === String(r.serviceType || '') ||
                            String(s.name || '').trim().toLowerCase() === String(r.serviceType || '').trim().toLowerCase()
                        );
                        const existingDuration =
                            durationHoursFromUnknown(pd?.duration) ??
                            Number(existingService?.minDuration || 2);
                        const existingEnd = existingStart + Math.max(1 / 60, existingDuration) * 3600000;
                        return newStart < existingEnd && existingStart < newEnd;
                    })
                    .map((r) => String(r.bookingId ?? r.id));
                if (conflicts.length > 0) {
                    conflictWarning = {
                        conflictCount: conflicts.length,
                        conflictingBookingIds: conflicts.slice(0, 20),
                        message:
                            'Thanks - your booking is confirmed. We noticed a possible schedule overlap and our team will review it shortly.',
                    };
                }
            }
        } catch (conflictErr) {
            console.warn('Non-blocking booking conflict check failed:', conflictErr);
        }

        // Look up registered user by email if customerId is missing
        let validCustomerId = bookingData.customerId;
        if (!validCustomerId && bookingData.contact?.email) {
            const matchedUser = await db.select().from(users).where(eq(users.email, bookingData.contact.email));
            if (matchedUser.length > 0) {
                validCustomerId = matchedUser[0].id;
            }
        }

        const insertedRows = await db
            .insert(bookings)
            .values({
                bookingId: publicBookingId,
                customerId: validCustomerId || null,
                serviceType: bookingData.serviceType,
                date: bookingData.date,
                time: bookingData.time,
                totalPrice: bookingData.totalPrice?.toString() || '0',
                addressLine1: bookingData.address?.line1 || '',
                addressCity: bookingData.address?.city || '',
                addressPostcode: bookingData.address?.postcode || '',
                contactName: bookingData.contact?.name || 'Guest',
                contactEmail: bookingData.contact?.email || '',
                contactPhone: bookingData.contact?.phone || '',
                propertyDetails: propertyDetailsSnapshot,
                extras: bookingData.extras || null,
                instructions: bookingData.instructions || null,
                discountCode: bookingData.discountCode ? String(bookingData.discountCode).trim().slice(0, 50) : null,
                discountAmount: discountAmount.toString(),
                pointsEarned: pointsToEarn,
                depositTermsAcceptedAt: new Date(),
                priceRegion: serverPrice?.region ?? null,
                hourlyRate: serverPrice ? serverPrice.hourlyRate.toFixed(2) : null,
            })
            .$returningId();
        const numericBookingId = Number(insertedRows[0]?.id);
        if (!Number.isFinite(numericBookingId) || numericBookingId <= 0) {
            throw new Error('Failed to obtain new booking primary key');
        }

        // Trigger Notification if we resolved a customer (body or email match)
        if (validCustomerId) {
            await db.insert(notifications).values({
                userId: validCustomerId,
                type: 'booking_update',
                message: `Booking ${publicBookingId} created! You will earn ${pointsToEarn} loyalty points upon completion.`,
                isRead: false
            });
        }

        // Notify every admin account (never assume a fixed user id; a missing one would fail the whole request).
        const adminIdsForNewBooking = await getAdminUserIds();
        if (adminIdsForNewBooking.length) {
            await db.insert(notifications).values(
                adminIdsForNewBooking.map((userId) => ({
                    userId,
                    type: 'booking_update',
                    message: `New Booking Request: ${publicBookingId}`,
                    isRead: false,
                })),
            );
        }

        // Multi-Staff Assignment
        if (bookingData.assignedStaffIds && Array.isArray(bookingData.assignedStaffIds)) {
            await db.delete(bookingStaff).where(eq(bookingStaff.bookingId, numericBookingId));
            if (bookingData.assignedStaffIds.length > 0) {
                await db.insert(bookingStaff).values(
                    bookingData.assignedStaffIds.map((sid: number) => ({
                        bookingId: numericBookingId,
                        staffId: sid,
                        isPrimary: false
                    }))
                );
                // Update legacy field for backward compatibility (set to first staff)
                await db
                    .update(bookings)
                    .set({ assignedStaffId: bookingData.assignedStaffIds[0] })
                    .where(eq(bookings.id, numericBookingId));

                // Notify assigned staff
                for (let sid of bookingData.assignedStaffIds) {
                    const staffRecord = await db.select().from(staff).where(eq(staff.id, sid));
                    if (staffRecord.length > 0 && staffRecord[0].userId) {
                        await db.insert(notifications).values({
                            userId: staffRecord[0].userId,
                            type: 'system',
                            message: `New assignment: Booking ${publicBookingId} for ${bookingData.contact?.name || 'Client'} on ${bookingData.date} at ${bookingData.time} (${bookingData.duration || bookingData.propertyDetails?.duration || 'N/A'}h).`,
                            isRead: false
                        });
                    }
                }
                await notifyAssignedStaffSms(bookingData.assignedStaffIds, {
                    displayBookingId: publicBookingId,
                    contactName: bookingData.contact?.name,
                    date: bookingData.date,
                    time: bookingData.time,
                    addressLine1: bookingData.address?.line1,
                    addressCity: bookingData.address?.city,
                    addressPostcode: bookingData.address?.postcode,
                });
            }
        }

        broadcastSync('all');

        const contactEmail = String(bookingData.contact?.email || '').trim();

        const extraRows = await db.select().from(extraServices);
        const extraNameById = new Map<string, string>(extraRows.map((e) => [String(e.id), e.name]));
        const bookingDetailsHtml = buildBookingDetailsHtml(bookingData, {
            bookingId: publicBookingId,
            pointsToEarn,
            discountAmount,
            extraNameById,
        });

        const settingsMapForBookingEmails = await loadBusinessSettingsMap(db);
        const bookingTotalGbp =
            Number.parseFloat(String(bookingData.totalPrice ?? 0)) || 0;

        // Auto-create Stripe payment intent for deposit
        let payNowHtml = '';
        let stripePaymentLinkForResponse = '';
        if (stripe && bookingTotalGbp > 0) {
            try {
                const depositPolicy = settingsMapForBookingEmails.depositPolicy
                    ? JSON.parse(settingsMapForBookingEmails.depositPolicy)
                    : { requiredPercent: 40 };
                const depositPercent = Number(depositPolicy.requiredPercent) || 40;
                const chargeAmount = +(bookingTotalGbp * depositPercent / 100).toFixed(2);
                const amountPence = Math.round(chargeAmount * 100);
                if (amountPence >= 30) {
                    const pi = await stripe.paymentIntents.create({
                        amount: amountPence,
                        currency: 'gbp',
                        metadata: { bookingId: String(numericBookingId), bookingRef: publicBookingId },
                        description: `Deposit (${depositPercent}%) — Booking ${publicBookingId} — ${bookingData.contact?.name || 'Guest'}`,
                        receipt_email: contactEmail || undefined,
                    });
                    const payUrl = `${publicBaseUrlFromRequest(req)}/pay/booking/${numericBookingId}`;
                    stripePaymentLinkForResponse = payUrl;
                    await db.update(bookings).set({
                        stripePaymentIntentId: pi.id,
                        stripePaymentLink: payUrl,
                    } as any).where(eq(bookings.id, numericBookingId));

                    const brandVars = await loadBrandVars(db);
                    payNowHtml = `<div style="text-align:center;margin:24px 0;">
  <p style="margin:0 0 12px;font-size:15px;font-weight:700;color:#0f172a;">Pay your deposit online — quick &amp; secure</p>
  <a href="${payUrl}" style="display:inline-block;background:${brandVars.brand_primary || '#7c3aed'};color:#ffffff;padding:16px 36px;border-radius:12px;font-weight:800;text-decoration:none;font-size:16px;">Pay Now — £${chargeAmount.toFixed(2)}</a>
  <p style="font-size:12px;color:#64748b;margin-top:10px;">Or copy this link: ${payUrl}</p>
</div>`;
                }
            } catch (stripeErr) {
                console.error('Auto Stripe payment intent for booking:', stripeErr);
            }
        }

        const bookingDetailsHtmlFull =
            bookingDetailsHtml +
            payNowHtml +
            buildDepositBankSectionHtml(settingsMapForBookingEmails, bookingTotalGbp);

        const brand = await loadBrandVars(db);
        const commonBookingEmailVars: Record<string, string> = {
            ...brand,
            booking_id: publicBookingId,
            booking_details_html: bookingDetailsHtmlFull,
            service_date: String(bookingData.date || ''),
            service_time: String(bookingData.time || ''),
            client_email: contactEmail || '-',
        };

        if (contactEmail) {
            try {
                const { subject, html } = await renderTransactionalEmail(db, 'client_booking_confirmation', {
                    ...commonBookingEmailVars,
                    client_name: bookingData.contact?.name || 'Guest',
                });
                await sendEmail({
                    to: [{ email: contactEmail, name: bookingData.contact?.name || 'Guest' }],
                    subject,
                    htmlContent: html,
                });
            } catch (mailErr) {
                console.error('Booking confirmation email (customer):', mailErr);
            }
        }

        try {
            const adminTo = adminBookingNotifyEmail(settingsMapForBookingEmails);
            if (adminTo) {
                const { subject, html } = await renderTransactionalEmail(db, 'admin_new_booking_alert', commonBookingEmailVars);
                await sendEmail({
                    to: [{ email: adminTo, name: 'Bookings' }],
                    subject,
                    htmlContent: html,
                });
            }
        } catch (adminMailErr) {
            console.error('Booking alert email (admin):', adminMailErr);
        }

        res.status(201).json({
            id: numericBookingId,
            bookingId: publicBookingId,
            message: 'Booking created successfully',
            depositTermsAcceptedAt: new Date().toISOString(),
            ...(stripePaymentLinkForResponse ? { stripePaymentLink: stripePaymentLinkForResponse } : {}),
            ...(conflictWarning ? { conflictWarning } : {}),
        });
    } catch (error: any) {
        console.error("Booking Error:", error);
        res.status(500).json({ error: 'Failed to create booking' });
    }
});

app.get('/api/bookings', authenticateToken, async (req: any, res) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = (page - 1) * limit;

        let results: any[] = [];
        let totalCount = 0;

        if (req.user.role === 'admin') {
            const countRes = await db.select({ count: sql`count(*)` }).from(bookings);
            totalCount = Number(countRes[0]?.count) || 0;

            const sortedIds = await db
                .select({ id: bookings.id })
                .from(bookings)
                .orderBy(desc(bookings.date))
                .limit(limit)
                .offset(offset);

            const ids = sortedIds.map(row => row.id);
            if (ids.length > 0) {
                results = await db.select().from(bookings).where(inArray(bookings.id, ids));
                // Sort array to match the ID list returned by the initial query
                results.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
            }
        } else if (req.user.role === 'staff') {
            const staffProfile = await db.select().from(staff).where(eq(staff.userId, req.user.id));
            if (!staffProfile.length) return res.json([]);
            const sid = staffProfile[0].id;

            const staffAssignments = await db.select().from(bookingStaff).where(eq(bookingStaff.staffId, sid));
            const bookingIdSet = new Set(staffAssignments.map((a) => a.bookingId).filter((id): id is number => id != null));

            const legacyAssigned = await db
                .select({ id: bookings.id })
                .from(bookings)
                .where(eq(bookings.assignedStaffId, sid));
            legacyAssigned.forEach((b) => bookingIdSet.add(b.id));

            const bookingIds = [...bookingIdSet];
            if (!bookingIds.length) return res.json([]);

            totalCount = bookingIds.length;

            const sortedIds = await db
                .select({ id: bookings.id })
                .from(bookings)
                .where(inArray(bookings.id, bookingIds))
                .orderBy(desc(bookings.date))
                .limit(limit)
                .offset(offset);

            const ids = sortedIds.map(r => r.id);
            if (ids.length > 0) {
                results = await db.select().from(bookings).where(inArray(bookings.id, ids));
                results.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
            }
        } else {
            // Customers: linked account and/or same email as guest checkout
            const uid = req.user.id;
            const countRes = await db.select({ count: sql`count(*)` }).from(bookings).where(eq(bookings.customerId, uid));
            totalCount = Number(countRes[0]?.count) || 0;

            const sortedIds = await db
                .select({ id: bookings.id })
                .from(bookings)
                .where(eq(bookings.customerId, uid))
                .orderBy(desc(bookings.date))
                .limit(limit)
                .offset(offset);

            const ids = sortedIds.map(r => r.id);
            if (ids.length > 0) {
                results = await db.select().from(bookings).where(inArray(bookings.id, ids));
                results.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
            }
        }

        // Include pagination metadata in headers to preserve backward compatibility with array response
        res.setHeader('X-Total-Count', String(totalCount));
        res.setHeader('X-Page', String(page));
        res.setHeader('X-Limit', String(limit));


        res.json(await enrichBookingsForViewer(results, req.user.role === 'staff'));
    } catch (error) {
        console.error("Fetch bookings error:", error);
        res.status(500).json({ error: 'Failed to fetch bookings' });
    }
});

app.get('/api/bookings/:id', authenticateToken, async (req: any, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid booking id' });
        const b = await selectBookingByRouteParam(id);
        if (!b) return res.status(404).json({ error: 'Booking not found' });

        if (req.user.role === 'staff') {
            const me = await db.select().from(staff).where(eq(staff.userId, req.user.id)).limit(1);
            if (!me.length) return res.status(403).json({ error: 'Unauthorized' });
            const links = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, id));
            const assigned = b.assignedStaffId === me[0].id || links.some((l) => l.staffId === me[0].id);
            if (!assigned) return res.status(403).json({ error: 'Unauthorized' });
        } else if (req.user.role !== 'admin') {
            const userEmail = String(req.user.email || '').trim().toLowerCase();
            const bookingEmail = String(b.contactEmail || '').trim().toLowerCase();
            const owns = b.customerId === req.user.id || (userEmail && bookingEmail && userEmail === bookingEmail);
            if (!owns) return res.status(403).json({ error: 'Unauthorized' });
        }

        const [enriched] = await enrichBookingsForViewer([b], req.user.role === 'staff');
        res.json(enriched);
    } catch (error) {
        console.error('Fetch booking error:', error);
        res.status(500).json({ error: 'Failed to fetch booking' });
    }
});

/** Shapes booking rows for portal clients (nested contact/address, merged staff ids; staff never see price or client contact details). */
async function enrichBookingsForViewer(results: any[], isStaffViewer: boolean) {
        const resultIds = results.map(b => Number(b.id)).filter(id => Number.isFinite(id) && id > 0);
        const relevantAssignments = resultIds.length > 0
            ? await db.select().from(bookingStaff).where(inArray(bookingStaff.bookingId, resultIds))
            : [];
        const assignmentMap = new Map<number, number[]>();
        relevantAssignments.forEach((a) => {
            const bid = Number(a.bookingId);
            if (!Number.isFinite(bid)) return;
            if (!assignmentMap.has(bid)) assignmentMap.set(bid, []);
            assignmentMap.get(bid)?.push(Number(a.staffId));
        });

        return results.map(b => {
            const {
                contactName, contactEmail, contactPhone,
                addressLine1, addressCity, addressPostcode,
                totalPrice,
                ...rest
            } = b;
            const pd = (b as { propertyDetails?: unknown }).propertyDetails;
            const pdObj = pd && typeof pd === 'object' ? (pd as Record<string, unknown>) : null;
            const snapFreq = typeof pdObj?.frequency === 'string' ? pdObj.frequency : undefined;
            const chatClosedAt = (b as { chatClosedAt?: Date | null }).chatClosedAt;
            const fromLinks = assignmentMap.get(Number(b.id)) || [];
            const mergedStaffIds = new Set<number>();
            for (const sid of fromLinks) mergedStaffIds.add(Number(sid));
            if (b.assignedStaffId != null) mergedStaffIds.add(Number(b.assignedStaffId));
            return {
                ...rest,
                totalPrice: isStaffViewer ? 0 : Number(totalPrice),
                contact: isStaffViewer
                    ? { name: contactName, email: '', phone: undefined }
                    : {
                        name: contactName,
                        email: contactEmail,
                        phone: contactPhone
                    },
                address: {
                    line1: addressLine1,
                    city: addressCity,
                    postcode: addressPostcode
                },
                /** Legacy `assigned_staff_id` + `booking_staff` rows so staff/clients never see an empty array when someone is assigned. */
                assignedStaffIds: [...mergedStaffIds],
                /** Keep invoice frequency stable even when DB lacks a dedicated `frequency` column. */
                frequency:
                    typeof (b as { frequency?: unknown }).frequency === 'string'
                        ? (b as { frequency?: string }).frequency
                        : snapFreq,
                chatClosedByAdmin: Boolean((b as { chatClosedByAdmin?: boolean }).chatClosedByAdmin),
                chatClosedAt: chatClosedAt
                    ? (chatClosedAt instanceof Date ? chatClosedAt.toISOString() : String(chatClosedAt))
                    : null,
                invoicePaid: Boolean((b as { invoicePaid?: boolean }).invoicePaid),
            };
        });
}

// ─── Reviews endpoint ───────────────────────────────────────────────────────
app.get('/api/reviews', authenticateToken, async (req: any, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const offset = (page - 1) * limit;
        const ratingFilter = parseInt(req.query.rating as string);
        const sortMode: string = String(req.query.sort || 'newest');

        // Determine which booking IDs this user is allowed to see
        let allowedIds: number[] | 'all' = 'all';
        if (req.user.role === 'staff') {
            const staffProfile = await db.select().from(staff).where(eq(staff.userId, req.user.id));
            if (!staffProfile.length) return res.json({ reviews: [], total: 0, page, limit, avgRating: null, distribution: {} });
            const sid = staffProfile[0].id;
            const staffAssignments = await db.select({ bookingId: bookingStaff.bookingId }).from(bookingStaff).where(eq(bookingStaff.staffId, sid));
            const legacyIds = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.assignedStaffId, sid));
            const idSet = new Set<number>([
                ...staffAssignments.map(a => a.bookingId).filter((id): id is number => id != null),
                ...legacyIds.map(b => b.id),
            ]);
            allowedIds = [...idSet];
            if (allowedIds.length === 0) {
                return res.json({ reviews: [], total: 0, page, limit, avgRating: null, distribution: {} });
            }
        } else if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // Build where clause: must have a rating
        const conditions: any[] = [sql`${bookings.rating} IS NOT NULL`];
        if (!isNaN(ratingFilter) && ratingFilter >= 1 && ratingFilter <= 5) {
            conditions.push(eq(bookings.rating, ratingFilter));
        }
        if (allowedIds !== 'all') {
            conditions.push(inArray(bookings.id, allowedIds as number[]));
        }
        const whereClause = and(...conditions);

        // Count total
        const countRes = await db.select({ count: sql`count(*)` }).from(bookings).where(whereClause);
        const total = Number(countRes[0]?.count) || 0;

        // Sort order
        let orderCol: any;
        if (sortMode === 'highest') {
            orderCol = desc(bookings.rating);
        } else if (sortMode === 'lowest') {
            orderCol = asc(bookings.rating);
        } else {
            orderCol = desc(bookings.date);
        }

        // Fetch sorted IDs (deferred join — keeps sort buffer small)
        const sortedIds = await db
            .select({ id: bookings.id })
            .from(bookings)
            .where(whereClause)
            .orderBy(orderCol)
            .limit(limit)
            .offset(offset);

        const ids = sortedIds.map(r => r.id);
        if (!ids.length) {
            return res.json({ reviews: [], total, page, limit, avgRating: null, distribution: {} });
        }

        // Fetch full rows for the page
        const rows = await db
            .select({
                id: bookings.id,
                bookingId: bookings.bookingId,
                contactName: bookings.contactName,
                serviceType: bookings.serviceType,
                date: bookings.date,
                rating: bookings.rating,
                feedback: bookings.feedback,
                status: bookings.status,
                assignedStaffId: bookings.assignedStaffId,
            })
            .from(bookings)
            .where(inArray(bookings.id, ids));

        // Preserve sorted order
        rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

        // Fetch booking-staff links for these IDs
        const assignments = await db.select().from(bookingStaff).where(inArray(bookingStaff.bookingId, ids));
        const staffIds = [...new Set([
            ...assignments.map(a => a.staffId).filter((id): id is number => id != null),
            ...rows.map(r => r.assignedStaffId).filter((id): id is number => id != null),
        ])];
        const staffMap = new Map<number, string>();
        if (staffIds.length > 0) {
            const staffRows = await db.select({ id: staff.id, name: staff.name }).from(staff).where(inArray(staff.id, staffIds));
            staffRows.forEach(s => staffMap.set(s.id, s.name));
        }
        const assignmentMap = new Map<number, number[]>();
        assignments.forEach(a => {
            const bid = Number(a.bookingId);
            if (!assignmentMap.has(bid)) assignmentMap.set(bid, []);
            assignmentMap.get(bid)!.push(Number(a.staffId));
        });

        const reviews = rows.map(b => {
            const merged = new Set<number>();
            (assignmentMap.get(Number(b.id)) || []).forEach(id => merged.add(id));
            if (b.assignedStaffId != null) merged.add(Number(b.assignedStaffId));
            const staffNames = [...merged].map(id => staffMap.get(id)).filter(Boolean);
            return {
                id: b.id,
                bookingId: b.bookingId,
                customerName: b.contactName,
                serviceType: b.serviceType,
                date: b.date,
                rating: b.rating,
                feedback: b.feedback || null,
                staffNames,
            };
        });

        // Compute aggregate stats (across all matching rows, not just current page)
        const allRatingsRes = await db
            .select({ rating: bookings.rating })
            .from(bookings)
            .where(and(sql`${bookings.rating} IS NOT NULL`, ...(allowedIds !== 'all' ? [inArray(bookings.id, allowedIds as number[])] : [])));
        const allRatings = allRatingsRes.map(r => Number(r.rating)).filter(n => n >= 1 && n <= 5);
        const avgRating = allRatings.length ? +(allRatings.reduce((s, n) => s + n, 0) / allRatings.length).toFixed(2) : null;
        const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        allRatings.forEach(r => { distribution[r] = (distribution[r] || 0) + 1; });

        res.setHeader('X-Total-Count', String(total));
        res.setHeader('X-Page', String(page));
        res.setHeader('X-Limit', String(limit));
        res.json({ reviews, total, page, limit, avgRating, distribution });
    } catch (error) {
        console.error('Fetch reviews error:', error);
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

const MAX_PAYMENT_FEE_EVIDENCE_ITEMS = 6;
const MAX_PAYMENT_FEE_EVIDENCE_DATA_URL_LEN = 750_000;

function normalizeAndValidatePaymentFeeEvidencePayload(raw: unknown): { items: unknown[] } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('paymentFeeEvidence must be an object');
    }
    const items = (raw as { items?: unknown }).items;
    if (!Array.isArray(items)) {
        throw new Error('paymentFeeEvidence.items must be an array');
    }
    if (items.length > MAX_PAYMENT_FEE_EVIDENCE_ITEMS) {
        throw new Error(`At most ${MAX_PAYMENT_FEE_EVIDENCE_ITEMS} files allowed`);
    }
    const out: unknown[] = [];
    for (const it of items) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
            throw new Error('Each evidence item must be an object');
        }
        const o = it as Record<string, unknown>;
        const kindRaw = o.kind;
        const kind =
            kindRaw === 'cancellation_fee' ? 'cancellation_fee' : kindRaw === 'deposit' ? 'deposit' : null;
        if (!kind) {
            throw new Error('Each item needs kind: deposit or cancellation_fee');
        }
        const dataUrl = typeof o.dataUrl === 'string' ? o.dataUrl.trim() : '';
        if (!dataUrl) {
            throw new Error('Each item needs a file upload');
        }
        if (dataUrl.length > MAX_PAYMENT_FEE_EVIDENCE_DATA_URL_LEN) {
            throw new Error('One or more files are too large');
        }
        const lower = dataUrl.toLowerCase();
        if (!lower.startsWith('data:image/') && !lower.startsWith('data:application/pdf')) {
            throw new Error('Only images or PDF files are allowed');
        }
        const uploadedAt =
            typeof o.uploadedAt === 'string' && o.uploadedAt.trim()
                ? o.uploadedAt.trim()
                : new Date().toISOString();
        const fileName = typeof o.fileName === 'string' ? o.fileName.trim().slice(0, 180) : '';
        const note = typeof o.note === 'string' ? o.note.trim().slice(0, 500) : '';
        out.push({
            kind,
            dataUrl,
            uploadedAt,
            ...(fileName ? { fileName } : {}),
            ...(note ? { note } : {}),
        });
    }
    return { items: out };
}

app.patch('/api/bookings/:id', authenticateToken, async (req: any, res) => {
    try {
        const routeParam = parseInt(req.params.id);
        const updates = req.body;
        const {
            assignedStaffIds,
            forceScheduleOverlap,
            shortNoticeConsent,
            depositTermsAcknowledged,
            paymentFeeEvidence,
            ...bookingUpdates
        } = updates as Record<string, unknown> & {
            assignedStaffIds?: unknown;
            forceScheduleOverlap?: unknown;
            shortNoticeConsent?: unknown;
            depositTermsAcknowledged?: unknown;
            paymentFeeEvidence?: unknown;
        };
        if (req.user.role !== 'admin') {
            delete (bookingUpdates as { invoicePaid?: unknown }).invoicePaid;
        }
        const existing = await db.select().from(bookings).where(eq(bookings.id, routeParam)).limit(1);
        if (!existing.length) return res.status(404).json({ error: 'Booking not found' });
        const booking = existing[0];
        const id = booking.id;
        const displayBookingLabel = String(booking.bookingId ?? id);
        /** Set when client cancels inside short-notice window with fee consent (persisted on same update). */
        let shortNoticeFeeConsentTimestamp: Date | undefined = undefined;

        if (req.user.role === 'customer') {
            const userEmail = String(req.user.email || '').trim().toLowerCase();
            const bookingEmail = String(booking.contactEmail || '').trim().toLowerCase();
            const ownsBooking = booking.customerId === req.user.id || (userEmail && bookingEmail && userEmail === bookingEmail);
            if (!ownsBooking) return res.status(403).json({ error: 'You can only update your own bookings.' });

            if (assignedStaffIds) {
                return res.status(403).json({ error: 'Customers cannot change staff assignment.' });
            }

            const topLevelKeys = Object.keys(updates as Record<string, unknown>).filter(
                (k) => (updates as Record<string, unknown>)[k] !== undefined,
            );

            const hasPaymentFeeEvidenceKey = Object.prototype.hasOwnProperty.call(
                updates as Record<string, unknown>,
                'paymentFeeEvidence',
            );
            if (hasPaymentFeeEvidenceKey) {
                if (topLevelKeys.length !== 1 || topLevelKeys[0] !== 'paymentFeeEvidence') {
                    return res.status(400).json({ error: 'Send only paymentFeeEvidence for this update.' });
                }
                try {
                    const validated = normalizeAndValidatePaymentFeeEvidencePayload(
                        (updates as Record<string, unknown>).paymentFeeEvidence,
                    );
                    await db
                        .update(bookings)
                        .set({ paymentFeeEvidence: validated } as any)
                        .where(eq(bookings.id, id));
                    broadcastSync('bookings');
                    return res.json({ message: 'Evidence saved', paymentFeeEvidence: validated });
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : 'Invalid payload';
                    return res.status(400).json({ error: msg });
                }
            }

            const keys = Object.keys(bookingUpdates || {}).filter((k) => (bookingUpdates as Record<string, unknown>)[k] !== undefined);
            const wantsDepositAck =
                depositTermsAcknowledged === true ||
                depositTermsAcknowledged === 'true' ||
                depositTermsAcknowledged === 1;
            if (wantsDepositAck) {
                if (keys.length > 0) {
                    return res.status(400).json({ error: 'Acknowledgement must be sent without other booking fields.' });
                }
                const existingAt = (booking as { depositTermsAcceptedAt?: Date | null }).depositTermsAcceptedAt;
                if (existingAt) {
                    const iso =
                        existingAt instanceof Date ? existingAt.toISOString() : String(existingAt);
                    broadcastSync('bookings');
                    return res.json({ message: 'Already recorded', depositTermsAcceptedAt: iso });
                }
                const now = new Date();
                await db.update(bookings).set({ depositTermsAcceptedAt: now }).where(eq(bookings.id, id));
                broadcastSync('bookings');
                return res.json({ message: 'Deposit terms recorded', depositTermsAcceptedAt: now.toISOString() });
            }

            const ratingOnly = keys.length > 0 && keys.every((k) => k === 'rating' || k === 'feedback');

            if (ratingOnly) {
                if (!keys.includes('rating')) {
                    return res.status(400).json({ error: 'A star rating (1–5) is required.' });
                }
                if (String(booking.status) !== 'Completed') {
                    return res.status(400).json({ error: 'You can only rate completed bookings.' });
                }
                const existingRating = (booking as { rating?: number | null }).rating;
                if (existingRating != null && existingRating > 0) {
                    return res.status(400).json({ error: 'This booking has already been rated.' });
                }
                const r = Number((bookingUpdates as { rating?: unknown }).rating);
                if (!Number.isFinite(r) || Math.round(r) !== r || r < 1 || r > 5) {
                    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
                }
                const fbRaw = (bookingUpdates as { feedback?: unknown }).feedback;
                const fb =
                    fbRaw != null && String(fbRaw).trim() !== ''
                        ? String(fbRaw).trim().slice(0, 4000)
                        : null;

                await db
                    .update(bookings)
                    .set({ rating: Math.round(r), feedback: fb })
                    .where(eq(bookings.id, id));

                const targets = new Set<number>();
                if (booking.assignedStaffId) targets.add(Number(booking.assignedStaffId));
                const assignedRows = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, id));
                assignedRows.forEach((a) => { if (a.staffId != null) targets.add(a.staffId); });
                for (const sid of targets) {
                    const staffRecord = await db.select().from(staff).where(eq(staff.id, sid)).limit(1);
                    if (staffRecord.length > 0 && staffRecord[0].userId) {
                        await db.insert(notifications).values({
                            userId: staffRecord[0].userId,
                            type: 'system',
                            message: `A client rated booking ${displayBookingLabel}: ${Math.round(r)}/5 stars.`,
                            isRead: false,
                        });
                    }
                }

                broadcastSync('all');
                return res.json({ message: 'Booking updated' });
            }

            const statusOnly = keys.length === 1 && keys[0] === 'status';
            if (!statusOnly) {
                return res.status(403).json({ error: 'Customers can only cancel bookings or submit ratings.' });
            }

            if (bookingUpdates.status !== 'Cancelled') {
                return res.status(403).json({ error: 'Only cancellation is allowed from client portal.' });
            }

            const [year, month, day] = String(booking.date || '').split('-').map(Number);
            const [hours, minutes] = String(booking.time || '').split(':').map(Number);
            const bookingDate = new Date(year, (month || 1) - 1, day || 1, hours || 0, minutes || 0);
            const diffHours = (bookingDate.getTime() - Date.now()) / (1000 * 60 * 60);
            if (diffHours < 24) {
                const settingsMap = await loadBusinessSettingsMap(db);
                const rawPolicy = parseBusinessSettingObject(settingsMap, 'cancellationPolicy');
                const windowHours = Number(rawPolicy?.shortNoticeWindowHours);
                const feePercent = Number(rawPolicy?.shortNoticeFeePercent);
                const normalizedWindowHours = Number.isFinite(windowHours) ? Math.max(1, windowHours) : 24;
                const normalizedFeePercent = Number.isFinite(feePercent) ? Math.min(100, Math.max(0, feePercent)) : 10;
                const isInsideShortNoticeWindow = diffHours < normalizedWindowHours;
                const consented = shortNoticeConsent === true || shortNoticeConsent === 'true' || shortNoticeConsent === 1;

                if (isInsideShortNoticeWindow && !consented) {
                    return res.status(400).json({
                        error: `Cancellations within ${normalizedWindowHours} hours require consent to the short-notice fee (${normalizedFeePercent}% of booking total).`,
                        requiresShortNoticeConsent: true,
                        shortNoticeWindowHours: normalizedWindowHours,
                        shortNoticeFeePercent: normalizedFeePercent,
                    });
                }
                if (isInsideShortNoticeWindow && consented) {
                    shortNoticeFeeConsentTimestamp = new Date();
                }
            }
        }

        if (req.user.role === 'staff') {
            return res.status(403).json({
                error: 'Staff cannot edit booking details directly. Use cancellation request (3+ days) or contact admin.',
            });
        }

        if (req.user.role === 'admin' && updates && Object.prototype.hasOwnProperty.call(updates, 'invoicePaid')) {
            (bookingUpdates as { invoicePaid?: boolean }).invoicePaid = Boolean((updates as { invoicePaid?: unknown }).invoicePaid);
        }

        if (req.user.role === 'admin') {
            const u = bookingUpdates as Record<string, unknown>;
            const hasStaffIdsKey = updates && Object.prototype.hasOwnProperty.call(updates, 'assignedStaffIds');
            const staffIdsInBody = hasStaffIdsKey ? (updates as { assignedStaffIds?: unknown }).assignedStaffIds : undefined;
            const needsConflictCheck =
                hasStaffIdsKey ||
                u.assignedStaffId !== undefined ||
                u.date !== undefined ||
                u.time !== undefined;

            const allowScheduleOverlapOverride =
                forceScheduleOverlap === true || forceScheduleOverlap === 'true' || forceScheduleOverlap === 1;

            if (needsConflictCheck && !allowScheduleOverlapOverride) {
                const assignedStaffIdsForCheck: number[] | undefined = hasStaffIdsKey
                    ? Array.isArray(staffIdsInBody)
                        ? (staffIdsInBody as number[])
                        : []
                    : undefined;

                const [allRows, allStaffLinks, svcRows, exRows] = await Promise.all([
                    db.select({
                        id: bookings.id,
                        bookingId: bookings.bookingId,
                        customerId: bookings.customerId,
                        serviceType: bookings.serviceType,
                        date: bookings.date,
                        time: bookings.time,
                        status: bookings.status,
                        totalPrice: bookings.totalPrice,
                        addressLine1: bookings.addressLine1,
                        addressCity: bookings.addressCity,
                        addressPostcode: bookings.addressPostcode,
                        contactName: bookings.contactName,
                        contactEmail: bookings.contactEmail,
                        contactPhone: bookings.contactPhone,
                        propertyDetails: bookings.propertyDetails,
                        extras: bookings.extras,
                        assignedStaffId: bookings.assignedStaffId,
                    }).from(bookings),
                    db.select().from(bookingStaff),
                    db.select().from(services),
                    db.select().from(extraServices),
                ]);
                const assignmentMap = new Map<number, number[]>();
                for (const a of allStaffLinks) {
                    const bid = Number(a.bookingId);
                    if (!Number.isFinite(bid)) continue;
                    if (!assignmentMap.has(bid)) assignmentMap.set(bid, []);
                    assignmentMap.get(bid)!.push(Number(a.staffId));
                }
                const conflicting = computeAdminPatchScheduleConflicts(
                    allRows,
                    assignmentMap,
                    id,
                    u,
                    assignedStaffIdsForCheck,
                    svcRows,
                    exRows
                );
                if (conflicting.length > 0) {
                    return res.status(409).json({
                        error:
                            'Assigned staff already have another booking whose visit time overlaps this one (checked by date + start time and estimated duration — not the calendar date alone). Reschedule one job, pick different staff, or retry with forceScheduleOverlap: true if you accept the overlap.',
                        conflictingBookingIds: conflicting,
                    });
                }
            }
        }

        const finalPatch: Record<string, unknown> = { ...bookingUpdates };
        if (shortNoticeFeeConsentTimestamp != null) {
            finalPatch.shortNoticeCancelFeeConsentedAt = shortNoticeFeeConsentTimestamp;
        }
        if (req.user.role === 'admin') {
            const u = bookingUpdates as Record<string, unknown>;
            const scheduleChanged =
                (u.date !== undefined && String(u.date) !== String(booking.date)) ||
                (u.time !== undefined && String(u.time) !== String(booking.time));
            let assignmentChanged =
                u.assignedStaffId !== undefined && Number(u.assignedStaffId) !== Number(booking.assignedStaffId);
            if (!assignmentChanged && Array.isArray(assignedStaffIds)) {
                const current = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, id));
                const before = [...new Set(current.map((r) => Number(r.staffId)))].sort().join(',');
                const after = [...new Set((assignedStaffIds as unknown[]).map(Number))].sort().join(',');
                assignmentChanged = before !== after;
            }
            if (scheduleChanged) Object.assign(finalPatch, trackingResetPatch('schedule'));
            else if (assignmentChanged) Object.assign(finalPatch, trackingResetPatch('assignment'));
        }
        await db.update(bookings).set(finalPatch as any).where(eq(bookings.id, id));

        if (assignedStaffIds && Array.isArray(assignedStaffIds) && req.user.role === 'admin') {
            // Snapshot who was previously linked so we can notify them if this patch removes them.
            const prevLinks = await db
                .select()
                .from(bookingStaff)
                .where(eq(bookingStaff.bookingId, id));
            const prevStaffIds = new Set<number>(prevLinks.map((r) => Number(r.staffId)));
            if (booking.assignedStaffId != null) prevStaffIds.add(Number(booking.assignedStaffId));
            const nextStaffIds = new Set<number>((assignedStaffIds as number[]).map((v) => Number(v)));
            const removedStaffIds = Array.from(prevStaffIds).filter((sid) => !nextStaffIds.has(sid));
            await db.delete(bookingStaff).where(eq(bookingStaff.bookingId, id));
            if (assignedStaffIds.length > 0) {
                await db.insert(bookingStaff).values(
                    assignedStaffIds.map((sid: number) => ({
                        bookingId: id,
                        staffId: sid
                    }))
                );

                // Notify newly assigned staff
                const assignedNames: string[] = [];
                for (let sid of assignedStaffIds) {
                    const staffRecord = await db.select().from(staff).where(eq(staff.id, sid));
                    if (staffRecord.length > 0 && staffRecord[0].userId) {
                        assignedNames.push(staffRecord[0].name);
                        await db.insert(notifications).values({
                            userId: staffRecord[0].userId,
                            type: 'system',
                            message: `New assignment: Booking ${displayBookingLabel} for ${booking.contactName || 'Client'} on ${booking.date} at ${booking.time} (${(booking.propertyDetails as any)?.duration || 'N/A'}h).`,
                            isRead: false
                        });
                    }
                }
                if (booking.customerId) {
                    await db.insert(notifications).values({
                        userId: booking.customerId,
                        type: 'booking_update',
                        message: `Your booking ${displayBookingLabel} has been assigned to ${assignedNames.join(', ') || 'our team'} on ${booking.date} at ${booking.time}.`,
                        isRead: false
                    });
                }
                await notifyAssignedStaffSms(assignedStaffIds, {
                    displayBookingId: displayBookingLabel,
                    contactName: booking.contactName,
                    date: booking.date,
                    time: booking.time,
                    addressLine1: booking.addressLine1,
                    addressCity: booking.addressCity,
                    addressPostcode: booking.addressPostcode,
                });
            } else if (prevStaffIds.size > 0) {
                // Admin fully unassigned the booking — notify removed staff and the client so everyone sees the reset.
                for (const sid of removedStaffIds) {
                    const staffRecord = await db.select().from(staff).where(eq(staff.id, sid)).limit(1);
                    if (staffRecord.length > 0 && staffRecord[0].userId) {
                        await db.insert(notifications).values({
                            userId: staffRecord[0].userId,
                            type: 'system',
                            message: `Booking ${displayBookingLabel} (${booking.contactName || 'Client'} · ${booking.date} ${booking.time}) has been unassigned by admin and returned to the dispatch queue.`,
                            isRead: false,
                        });
                    }
                }
                if (booking.customerId) {
                    await db.insert(notifications).values({
                        userId: booking.customerId,
                        type: 'booking_update',
                        message: `Your booking ${displayBookingLabel} is being re-scheduled with a new team. We'll confirm the assigned cleaner shortly.`,
                        isRead: false,
                    });
                }
            }
        } else if (req.user.role === 'admin' && (bookingUpdates.date || bookingUpdates.time || bookingUpdates.status)) {
            // Check if existing staff exist and notify them of the change automatically
            const assignments = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, id));
            for (let a of assignments) {
                if (a.staffId == null) continue;
                const staffRecord = await db.select().from(staff).where(eq(staff.id, a.staffId));
                if (staffRecord.length > 0 && staffRecord[0].userId) {
                    await db.insert(notifications).values({
                        userId: staffRecord[0].userId,
                        type: 'system',
                        message: `Booking #${displayBookingLabel} has been updated. Please review the new details (e.g. Schedule/Status).`,
                        isRead: false
                    });
                }
            }
        }

        if (req.user.role === 'customer' && bookingUpdates.status === 'Cancelled') {
            const targets = new Set<number>();
            if (booking.assignedStaffId) targets.add(booking.assignedStaffId);
            const assigned = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, id));
            assigned.forEach((a) => { if (a.staffId != null) targets.add(a.staffId); });
            for (const sid of targets) {
                const staffRecord = await db.select().from(staff).where(eq(staff.id, sid)).limit(1);
                if (staffRecord.length > 0 && staffRecord[0].userId) {
                    await db.insert(notifications).values({
                        userId: staffRecord[0].userId,
                        type: 'booking_cancelled',
                        message: `Booking ${displayBookingLabel} for ${booking.contactName || 'Client'} on ${booking.date} at ${booking.time} was cancelled by the client.`,
                        isRead: false
                    });
                }
            }

            // Notify all admins as well (operational visibility).
            const adminIds = await getAdminUserIds();
            if (adminIds.length > 0) {
                await db.insert(notifications).values(
                    adminIds.map((adminId) => ({
                        userId: adminId,
                        type: 'booking_cancelled',
                        message: `Client cancelled booking ${displayBookingLabel} (${booking.date} ${booking.time}) — ${booking.contactName || 'Client'}.`,
                        isRead: false,
                    }))
                );
            }

            const custId = booking.customerId != null ? Number(booking.customerId) : NaN;
            if (Number.isFinite(custId) && custId > 0) {
                await db.insert(notifications).values({
                    userId: custId,
                    type: 'booking_update',
                    message: `Your booking ${displayBookingLabel} on ${booking.date} at ${booking.time} has been cancelled. If a short-notice fee applies, you will be contacted with payment details.`,
                    isRead: false,
                });
            }

            try {
                const brand = await loadBrandVars(db);
                const settingsMap = await loadBusinessSettingsMap(db);
                const [cy, cm, cd] = String(booking.date || '').split('-').map(Number);
                const [ch, cmin] = String(booking.time || '').split(':').map(Number);
                const bookingAt = new Date(cy, (cm || 1) - 1, cd || 1, ch || 0, cmin || 0);
                const hoursUntil = (bookingAt.getTime() - Date.now()) / (1000 * 60 * 60);

                let shortNoticeLineHtml = '';
                if (Number.isFinite(hoursUntil) && hoursUntil < 24) {
                    const rawPolicy = parseBusinessSettingObject(settingsMap, 'cancellationPolicy');
                    const windowHours = Number(rawPolicy?.shortNoticeWindowHours);
                    const feePercent = Number(rawPolicy?.shortNoticeFeePercent);
                    const w = Number.isFinite(windowHours) ? Math.max(1, windowHours) : 24;
                    const f = Number.isFinite(feePercent) ? Math.min(100, Math.max(0, feePercent)) : 10;
                    if (hoursUntil < w) {
                        const note = `Because this cancellation is within ${w} hours of your appointment, a short-notice fee of up to ${f}% of the booking total may apply. Our team will contact you if payment is required.`;
                        shortNoticeLineHtml = `<p style="margin:16px 0;padding:14px 16px;background:#fffbeb;border-radius:10px;border:1px solid #fde68a;color:#92400e;font-size:14px;">${escapeHtmlBasic(
                            note
                        )}</p>`;
                    }
                }

                const clientMail = String(booking.contactEmail || '').trim();
                if (clientMail && isPlausibleEmail(clientMail)) {
                    const { subject, html } = await renderTransactionalEmail(db, 'client_booking_cancelled', {
                        ...brand,
                        client_name: escapeHtmlBasic(booking.contactName || 'Guest'),
                        booking_id: escapeHtmlBasic(String(id)),
                        service_type: escapeHtmlBasic(String(booking.serviceType || '')),
                        service_date: escapeHtmlBasic(String(booking.date || '')),
                        service_time: escapeHtmlBasic(String(booking.time || '')),
                        short_notice_line: shortNoticeLineHtml,
                    });
                    await sendEmail({
                        to: [{ email: clientMail, name: booking.contactName || 'Guest' }],
                        subject,
                        htmlContent: html,
                    });
                }

                const adminTo = adminBookingNotifyEmail(settingsMap);
                if (adminTo && isPlausibleEmail(adminTo)) {
                    const { subject, html } = await renderTransactionalEmail(db, 'admin_booking_cancelled_alert', {
                        ...brand,
                        booking_id: escapeHtmlBasic(String(id)),
                        service_type: escapeHtmlBasic(String(booking.serviceType || '')),
                        service_date: escapeHtmlBasic(String(booking.date || '')),
                        service_time: escapeHtmlBasic(String(booking.time || '')),
                        client_name: escapeHtmlBasic(booking.contactName || 'Guest'),
                        client_email: escapeHtmlBasic(String(booking.contactEmail || '-')),
                        booking_total: escapeHtmlBasic(Number(booking.totalPrice || 0).toFixed(2)),
                    });
                    await sendEmail({
                        to: [{ email: adminTo, name: 'Bookings' }],
                        subject,
                        htmlContent: html,
                    });
                }
            } catch (emailErr) {
                console.error('Cancellation emails (Brevo):', emailErr);
            }
        }
        broadcastSync('all');
        broadcastSync('notifications');
        res.json({ message: 'Booking updated' });
    } catch (error) {
        console.error('Failed to update booking:', error);
        res.status(500).json({ error: 'Failed to update booking' });
    }
});

app.post('/api/bookings/:id/staff-cancel-request', authenticateToken, async (req: any, res) => {
    try {
        if (req.user.role !== 'staff') return res.status(403).json({ error: 'Staff only' });
        const staffUserId = parseInt(req.user.id);
        if (!Number.isFinite(staffUserId) || staffUserId <= 0) {
            return res.status(401).json({ error: 'Invalid staff session.' });
        }
        const booking = await selectBookingByRouteParam(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        const numericBookingId = booking.id;
        const displayBookingLabel = String(booking.bookingId ?? numericBookingId);

        const staffRows = await db.select().from(staff).where(eq(staff.userId, staffUserId)).limit(1);
        if (!staffRows.length) return res.status(403).json({ error: 'Staff profile not found' });
        const staffProfile = staffRows[0];

        const links = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, numericBookingId));
        const assignedToStaff =
            booking.assignedStaffId === staffProfile.id || links.some((x) => x.staffId === staffProfile.id);
        if (!assignedToStaff) {
            return res.status(403).json({ error: 'You can only request cancellation for your assigned jobs.' });
        }

        if (String(booking.status) === 'Cancelled' || String(booking.status) === 'Completed') {
            return res.status(400).json({ error: `Cannot request cancellation for a ${booking.status} booking.` });
        }

        const [year, month, day] = String(booking.date || '').split('-').map(Number);
        const [hours, minutes] = String(booking.time || '').split(':').map(Number);
        const bookingAt = new Date(year, (month || 1) - 1, day || 1, hours || 0, minutes || 0);
        const diffHours = (bookingAt.getTime() - Date.now()) / (1000 * 60 * 60);
        if (!Number.isFinite(diffHours) || diffHours < 72) {
            return res.status(400).json({
                error: 'Cancellation requests must be submitted at least 3 days (72 hours) before the job.',
            });
        }

        const reason = String((req.body as { reason?: unknown })?.reason || '').trim().slice(0, 1000);
        let adminUsers = await db
            .select()
            .from(users)
            .where(sql`LOWER(TRIM(${users.role})) = 'admin'`);

        // Auto-heal: if there is no admin in users, mirror the first superadmin into users as role=admin.
        if (adminUsers.length === 0) {
            const superRows = await db.select().from(superadmins).limit(1);
            if (superRows.length > 0) {
                const s = superRows[0];
                const existingUser = await db.select().from(users).where(eq(users.email, s.email)).limit(1);
                if (existingUser.length > 0) {
                    await db.update(users).set({ role: 'admin', name: s.name }).where(eq(users.id, existingUser[0].id));
                } else {
                    await db.insert(users).values({
                        email: s.email,
                        passwordHash: s.passwordHash,
                        name: s.name,
                        role: 'admin',
                        isVerified: true,
                    });
                }
                adminUsers = await db
                    .select()
                    .from(users)
                    .where(sql`LOWER(TRIM(${users.role})) = 'admin'`);
            }
        }

        const adminIds = adminUsers
            .map((u) => Number(u.id))
            .filter((id) => Number.isFinite(id) && id > 0);
        if (adminIds.length === 0) {
            return res.status(400).json({ error: 'No admin account available to receive this request.' });
        }

        const msg = `Cancellation request: ${staffProfile.name} asked to cancel booking ${displayBookingLabel} (${booking.date} ${booking.time}).${reason ? ` Reason: ${reason}` : ''}`;
        await poolConnection.query(
            `INSERT INTO staff_cancel_requests (booking_id, staff_user_id, staff_name, reason, status)
             VALUES (?, ?, ?, ?, 'Pending')`,
            [numericBookingId, staffUserId, staffProfile.name, reason || null]
        );
        await db.insert(notifications).values(
            adminIds.map((id) => ({
                userId: id,
                type: 'system',
                message: msg,
                isRead: false,
            }))
        );
        await db.insert(notifications).values({
            userId: staffUserId,
            type: 'system',
            message: `Your cancellation request for booking ${displayBookingLabel} was sent to admin for review.`,
            isRead: false,
        });

        broadcastSync('notifications');
        res.json({ success: true, message: 'Cancellation request sent to admin.' });
    } catch (error) {
        console.error('Staff cancel request error:', error);
        res.status(500).json({ error: 'Failed to submit cancellation request' });
    }
});

app.get('/api/admin/staff-cancel-requests', authenticateToken, async (req: any, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

        const [rows] = await poolConnection.query(
            `
            SELECT r.id, r.booking_id AS bookingId, r.staff_user_id AS staffUserId, r.staff_name AS staffName,
                   r.reason, r.status, r.admin_notes AS adminNote, r.created_at AS createdAt,
                   b.service_type AS serviceType, b.date, b.time, b.status AS bookingStatus
            FROM staff_cancel_requests r
            LEFT JOIN bookings b ON b.id = r.booking_id
            WHERE r.status IN ('Pending', 'Approved')
            ORDER BY r.created_at DESC
        `
        );
        res.json(Array.isArray(rows) ? rows : []);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch cancellation requests' });
    }
});

app.post('/api/admin/staff-cancel-requests/:id/respond', authenticateToken, async (req: any, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        const requestId = parseInt(req.params.id, 10);
        if (!Number.isFinite(requestId)) return res.status(400).json({ error: 'Invalid request id' });
        const decisionRaw = String((req.body || {}).decision || '').trim().toLowerCase();
        if (decisionRaw !== 'approve' && decisionRaw !== 'reject') {
            return res.status(400).json({ error: 'Decision must be approve or reject' });
        }
        const adminNote = String((req.body || {}).adminNote || '').trim().slice(0, 1000);
        const [requestRows] = await poolConnection.query(
            `SELECT * FROM staff_cancel_requests WHERE id = ? LIMIT 1`,
            [requestId]
        );
        const reqRow = Array.isArray(requestRows) ? (requestRows as any[])[0] : null;
        if (!reqRow) return res.status(404).json({ error: 'Request not found' });
        if (String(reqRow.status) !== 'Pending') return res.status(400).json({ error: 'Request already handled' });

        let bookingLabelForNotify = String(reqRow.booking_id);
        const bidNumEarly = Number(reqRow.booking_id);

        if (decisionRaw === 'approve') {
            const numericBookingId = Number(reqRow.booking_id);
            if (!Number.isFinite(numericBookingId) || numericBookingId <= 0) {
                return res.status(400).json({ error: 'Invalid booking reference on request' });
            }
            const bookingRows = await db.select().from(bookings).where(eq(bookings.id, numericBookingId)).limit(1);
            if (!bookingRows.length) return res.status(404).json({ error: 'Booking not found' });
            const booking = bookingRows[0];
            bookingLabelForNotify = String(booking.bookingId ?? numericBookingId);

            let staffProfileId: number | null = null;
            const staffRows = await db
                .select()
                .from(staff)
                .where(eq(staff.userId, Number(reqRow.staff_user_id)))
                .limit(1);
            if (staffRows.length > 0) {
                staffProfileId = Number(staffRows[0].id);
            }

            if (staffProfileId != null) {
                await db
                    .delete(bookingStaff)
                    .where(and(eq(bookingStaff.bookingId, numericBookingId), eq(bookingStaff.staffId, staffProfileId)));
            }

            const remainingLinks = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, numericBookingId));
            let nextAssignedStaffId: number | null =
                booking.assignedStaffId != null ? Number(booking.assignedStaffId) : null;
            if (staffProfileId != null && nextAssignedStaffId === staffProfileId) {
                nextAssignedStaffId = remainingLinks.length > 0 ? Number(remainingLinks[0].staffId) : null;
            }

            const patch: Record<string, unknown> = { assignedStaffId: nextAssignedStaffId };
            if (
                remainingLinks.length === 0 &&
                (String(booking.status) === 'Confirmed' || String(booking.status) === 'Pending')
            ) {
                patch.status = 'Pending';
            }
            await db.update(bookings).set(patch).where(eq(bookings.id, numericBookingId));
        } else if (Number.isFinite(bidNumEarly) && bidNumEarly > 0) {
            const lr = await db
                .select({ bookingId: bookings.bookingId })
                .from(bookings)
                .where(eq(bookings.id, bidNumEarly))
                .limit(1);
            if (lr.length) bookingLabelForNotify = String(lr[0].bookingId ?? bidNumEarly);
        }
        await poolConnection.query(
            `UPDATE staff_cancel_requests
             SET status = ?, admin_notes = ?, responded_by = ?, responded_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [decisionRaw === 'approve' ? 'Approved' : 'Rejected', adminNote || null, Number(req.user.id) || 0, requestId]
        );

        const staffUserId = Number(reqRow.staff_user_id);
        if (Number.isFinite(staffUserId) && staffUserId > 0) {
            await db.insert(notifications).values({
                userId: staffUserId,
                type: 'system',
                message:
                    decisionRaw === 'approve'
                        ? `Admin approved your cancellation request for booking ${bookingLabelForNotify}.`
                        : `Admin declined your cancellation request for booking ${bookingLabelForNotify}.${adminNote ? ` Note: ${adminNote}` : ''}`,
                isRead: false,
            });
        }
        broadcastSync('all');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to respond to cancellation request' });
    }
});

app.post('/api/bookings/:id/invoice', authenticateToken, async (req: any, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const bRow = await selectBookingByRouteParam(req.params.id);
        if (!bRow) return res.status(404).json({ error: 'Booking not found' });
        const displayRef = String(bRow.bookingId ?? bRow.id);

        if (bRow.customerId) {
            await db.insert(notifications).values({
                userId: bRow.customerId,
                type: 'invoice',
                message: `Invoice for Booking #${displayRef} is now available.`,
                isRead: false
            });
        }
        broadcastSync('notifications');
        res.json({ success: true, message: 'Invoice sent' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send invoice' });
    }
});

// ── Stripe Payment for Booking Deposits ──

app.post('/api/bookings/:id/create-payment-intent', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured. Add STRIPE_SECRET_KEY to .env' });
    try {
        const bRow = await selectBookingByRouteParam(req.params.id);
        if (!bRow) return res.status(404).json({ error: 'Booking not found' });

        if ((bRow as any).stripePaymentIntentId) {
            const existing = await stripe.paymentIntents.retrieve((bRow as any).stripePaymentIntentId);
            if (existing.status === 'succeeded') return res.json({ alreadyPaid: true });
            return res.json({ clientSecret: existing.client_secret, paymentIntentId: existing.id });
        }

        const settingsMap = await loadBusinessSettingsMap(db);
        const depositPolicy = settingsMap.depositPolicy ? JSON.parse(settingsMap.depositPolicy) : { requiredPercent: 40 };
        const depositPercent = Number(depositPolicy.requiredPercent) || 40;
        const totalPrice = Number(bRow.totalPrice) || 0;
        const isFullPayment = req.body?.fullPayment === true;
        const chargeAmount = isFullPayment ? totalPrice : +(totalPrice * depositPercent / 100).toFixed(2);
        const amountPence = Math.round(chargeAmount * 100);
        if (amountPence < 30) return res.status(400).json({ error: 'Amount too small for Stripe (minimum £0.30)' });

        const displayRef = String(bRow.bookingId ?? bRow.id);
        const pi = await stripe.paymentIntents.create({
            amount: amountPence,
            currency: 'gbp',
            metadata: { bookingId: String(bRow.id), bookingRef: displayRef },
            description: `${isFullPayment ? 'Full payment' : `Deposit (${depositPercent}%)`} — Booking ${displayRef} — ${bRow.contactName}`,
            receipt_email: bRow.contactEmail || undefined,
        });

        const payUrl = `${publicBaseUrlFromRequest(req)}/pay/booking/${bRow.id}`;
        await db.update(bookings).set({
            stripePaymentIntentId: pi.id,
            stripePaymentLink: payUrl,
        } as any).where(eq(bookings.id, bRow.id));

        res.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id, payUrl, depositAmount: chargeAmount, depositPercent });
    } catch (e: any) {
        console.error('Create booking payment intent error:', e?.message || e);
        res.status(500).json({ error: 'Failed to create payment', detail: String(e?.message || e) });
    }
});

app.get('/api/pay/booking/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const rows = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
        if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
        const b = rows[0];

        if (b.invoicePaid) return res.json({ paid: true, bookingRef: String(b.bookingId ?? b.id) });
        if (!(b as any).stripePaymentIntentId || !stripe) return res.status(400).json({ error: 'No payment set up for this booking' });

        const pi = await stripe.paymentIntents.retrieve((b as any).stripePaymentIntentId);
        if (pi.status === 'succeeded') {
            await db.update(bookings).set({ invoicePaid: true }).where(eq(bookings.id, id));
            return res.json({ paid: true, bookingRef: String(b.bookingId ?? b.id) });
        }

        const brandVars = await loadBrandVars(db);
        const settingsMap = await loadBusinessSettingsMap(db);
        const depositPolicy = settingsMap.depositPolicy ? JSON.parse(settingsMap.depositPolicy) : { requiredPercent: 40 };

        res.json({
            clientSecret: pi.client_secret,
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
            bookingRef: String(b.bookingId ?? b.id),
            customerName: b.contactName,
            total: Number(b.totalPrice),
            depositPercent: Number(depositPolicy.requiredPercent) || 40,
            depositAmount: Number(pi.amount) / 100,
            serviceType: b.serviceType,
            date: b.date,
            time: b.time,
            brandName: brandVars.brand_name || 'CiN Cleaning',
            brandPrimary: brandVars.brand_primary || '#7c3aed',
        });
    } catch (e: any) {
        console.error('Get booking payment info error:', e?.message || e);
        res.status(500).json({ error: 'Failed to load payment info' });
    }
});

app.post('/api/bookings/:id/send-confirmation', authenticateToken, async (req: any, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { adminNote, stripePaymentLink } = req.body || {};

        const booking = await selectBookingByRouteParam(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        const b = booking;
        const displayRef = String(b.bookingId ?? b.id);

        const contactEmail = String(b.contactEmail || '').trim();
        if (!contactEmail) return res.status(400).json({ error: 'No contact email on this booking' });

        const brand = await loadBrandVars(db);
        const settingsMap = await loadBusinessSettingsMap(db);

        // Build extra sections for admin note + payment link
        let extraHtml = '';
        if (adminNote && String(adminNote).trim()) {
            extraHtml += `<div style="background:#f8fafc;border-radius:12px;padding:18px 20px;margin:20px 0;border:1px solid #e2e8f0;">
  <p style="margin:0 0 8px;font-weight:700;color:#0f172a;">Note from admin</p>
  <p style="margin:0;white-space:pre-wrap;">${String(adminNote).trim()}</p>
</div>`;
        }
        if (stripePaymentLink && String(stripePaymentLink).trim()) {
            extraHtml += `<div style="text-align:center;margin:24px 0;">
  <a href="${String(stripePaymentLink).trim()}" style="display:inline-block;background:${brand.brand_primary || '#4f46e5'};color:#ffffff;padding:14px 28px;border-radius:10px;font-weight:700;text-decoration:none;font-size:16px;">Pay Now</a>
  <p style="font-size:12px;color:#64748b;margin-top:10px;">Or copy this link: ${String(stripePaymentLink).trim()}</p>
</div>`;
        }

        // Build a simple booking details summary from DB fields
        const detailsHtml = `<div style="background:#f0fdfa;border-radius:12px;padding:18px 20px;margin:20px 0;border:1px solid #99f6e4;">
  <p style="margin:0 0 6px;font-weight:700;color:#0f172a;">Booking #${displayRef}</p>
  <p style="margin:4px 0;"><strong>Service:</strong> ${b.serviceType || 'Cleaning'}</p>
  <p style="margin:4px 0;"><strong>Date:</strong> ${b.date || '-'} at ${b.time || '-'}</p>
  <p style="margin:4px 0;"><strong>Status:</strong> ${b.status || 'Confirmed'}</p>
</div>${extraHtml}`;

        const sendConfirmTotal = Number.parseFloat(String(b.totalPrice ?? 0)) || 0;
        const detailsHtmlFull =
            detailsHtml + buildDepositBankSectionHtml(settingsMap, sendConfirmTotal);

        const { subject, html } = await renderTransactionalEmail(db, 'client_booking_confirmation', {
            ...brand,
            client_name: b.contactName || 'Guest',
            booking_id: displayRef,
            booking_details_html: detailsHtmlFull,
        });

        await sendEmail({
            to: [{ email: contactEmail, name: b.contactName || 'Guest' }],
            subject,
            htmlContent: html,
        });

        if (b.customerId) {
            await db.insert(notifications).values({
                userId: b.customerId,
                type: 'system',
                message: `Booking #${displayRef} confirmed. Check your email for details${stripePaymentLink ? ' and payment link' : ''}.`,
                isRead: false,
            });
            broadcastSync('notifications');
        }

        res.json({ success: true, message: 'Confirmation email sent' });
    } catch (error) {
        console.error('send-confirmation error:', error);
        res.status(500).json({ error: 'Failed to send confirmation email' });
    }
});

app.post('/api/bookings/:id/reminder', authenticateToken, async (req: any, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { customMessage } = req.body || {};
        let emailSent = false;
        let emailWarning: string | null = null;
        const bRow = await selectBookingByRouteParam(req.params.id);
        if (!bRow) return res.status(404).json({ error: 'Booking not found' });

        const b = bRow;
        const displayRef = String(b.bookingId ?? b.id);
        if (b.customerId) {
            await db.insert(notifications).values({
                userId: b.customerId,
                type: 'system',
                message: `Reminder: You have an upcoming booking #${displayRef} on ${b.date} at ${b.time}.`,
                isRead: false
            });
        }

        if (b.contactEmail) {
            const brand = await loadBrandVars(db);
            const defaultMsg = `This is a reminder for your upcoming <strong>${b.serviceType || 'booking'}</strong> on <strong>${b.date} at ${b.time}</strong>.`;
            const msg = customMessage != null && String(customMessage).trim() ? String(customMessage).trim() : defaultMsg;
            const { subject, html } = await renderTransactionalEmail(db, 'client_booking_reminder', {
                ...brand,
                client_name: b.contactName || 'there',
                booking_id: displayRef,
                service_type: String(b.serviceType || 'Cleaning'),
                service_date: String(b.date || ''),
                service_time: String(b.time || ''),
                custom_message: msg,
            });
            try {
                await sendEmail({
                    to: [{ email: b.contactEmail, name: b.contactName || 'Guest' }],
                    subject,
                    htmlContent: html,
                });
                emailSent = true;
            } catch (mailErr) {
                emailWarning = 'Reminder saved, but email delivery failed.';
                console.error('Reminder email send failed (non-fatal):', mailErr);
            }
        }

        broadcastSync('notifications');
        res.json({
            success: true,
            message: emailWarning || 'Reminder sent',
            emailSent,
            ...(emailWarning ? { warning: emailWarning } : {}),
        });
    } catch (error) {
        console.error('Reminder Error:', error);
        res.status(500).json({ error: 'Failed to send reminder' });
    }
});

app.get('/api/admin/booking-reminder-settings', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const s = await loadBookingReminderSettings(db);
        res.json(s);
    } catch (e) {
        console.error('booking-reminder-settings get', e);
        res.status(500).json({ error: 'Failed to load reminder settings' });
    }
});

app.put('/api/admin/booking-reminder-settings', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const body = req.body || {};
        const next: BookingReminderSettings = {
            masterEnabled: body.masterEnabled !== false,
            send48h: body.send48h !== false,
            send24h: body.send24h !== false,
            notifyAdmin: body.notifyAdmin !== false,
            notifyStaff: body.notifyStaff !== false,
        };
        await saveBookingReminderSettings(db, next);
        res.json(next);
    } catch (e) {
        console.error('booking-reminder-settings put', e);
        res.status(500).json({ error: 'Failed to save reminder settings' });
    }
});

app.get('/api/admin/booking-reminder-log', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '80'), 10) || 80));
        const rows = await db
            .select({
                id: bookingReminderLog.id,
                bookingId: bookingReminderLog.bookingId,
                windowLabel: bookingReminderLog.windowLabel,
                channels: bookingReminderLog.channels,
                createdAt: bookingReminderLog.createdAt,
                // Related booking fields
                bookingRef: bookings.bookingId,
                serviceType: bookings.serviceType,
                bookingDate: bookings.date,
                bookingTime: bookings.time,
                bookingStatus: bookings.status,
                contactName: bookings.contactName,
                contactEmail: bookings.contactEmail,
            })
            .from(bookingReminderLog)
            .leftJoin(bookings, eq(bookingReminderLog.bookingId, bookings.id))
            .orderBy(desc(bookingReminderLog.id))
            .limit(limit);
        res.json(rows);
    } catch (e) {
        console.error('booking-reminder-log', e);
        res.status(500).json({ error: 'Failed to load reminder log' });
    }
});

app.delete('/api/admin/booking-reminder-log/:id', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid log id' });
    try {
        await db.delete(bookingReminderLog).where(eq(bookingReminderLog.id, id));
        res.json({ ok: true });
    } catch (e) {
        console.error('booking-reminder-log delete', e);
        res.status(500).json({ error: 'Failed to delete log row' });
    }
});

app.post('/api/admin/bookings/:id/automatic-reminders/reset', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    const routeParam = Number(req.params.id || '');
    if (!routeParam) return res.status(400).json({ error: 'Invalid booking id' });
    try {
        const foundRow = await selectBookingByRouteParam(routeParam);
        if (!foundRow) return res.status(404).json({ error: 'Booking not found' });
        const numericId = Number(foundRow.id);
        await db
            .update(bookings)
            .set({ reminder48SentAt: null, reminder24SentAt: null })
            .where(eq(bookings.id, numericId));
        await db.delete(bookingReminderLog).where(eq(bookingReminderLog.bookingId, numericId));
        broadcastSync('bookings');
        res.json({ ok: true });
    } catch (e) {
        console.error('automatic-reminders reset', e);
        res.status(500).json({ error: 'Failed to reset automatic reminders' });
    }
});

app.post('/api/admin/booking-reminders/run', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const out = await runAutomaticBookingReminders(db);
        res.json(out);
    } catch (e) {
        console.error('booking-reminders run', e);
        res.status(500).json({ error: 'Failed to run reminder job' });
    }
});

// Staff
app.get('/api/staff', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'staff' && req.user.role !== 'customer') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const results = await db.select().from(staff);
    if (req.user.role === 'staff') {
        // Colleagues' contact, address and bank details are private: cleaners get their own full record only.
        return res.json(results.map((s) => (Number(s.userId) === Number(req.user.id)
            ? s
            : { id: s.id, userId: s.userId, name: s.name, role: s.role, status: s.status, imageUrl: s.imageUrl, email: '' })));
    }
    if (req.user.role === 'admin') {
        // "Working with us since": the date the cleaner's login account was created.
        const userIds = results.map((s) => Number(s.userId)).filter((id) => Number.isFinite(id) && id > 0);
        const joined = userIds.length
            ? await db.select({ id: users.id, createdAt: users.createdAt }).from(users).where(inArray(users.id, userIds))
            : [];
        const joinedById = new Map(joined.map((u) => [Number(u.id), u.createdAt]));
        return res.json(results.map((s) => {
            const at = joinedById.get(Number(s.userId));
            return { ...s, joinedAt: at ? new Date(at as unknown as string).toISOString() : null };
        }));
    }
    if (req.user.role === 'customer') {
        // Expose only assignment-safe public staff fields to client portal.
        return res.json(results.map((s) => ({
            id: s.id,
            name: s.name,
            role: s.role,
            status: s.status,
            imageUrl: s.imageUrl,
            profilePhoto: s.imageUrl,
            rating: 4.9,
            isVerified: s.status === 'Active',
            email: '',
            hourlyRate: Number(s.hourlyRate || 0),
            availability: [],
        })));
    }
    res.json(results);
});

app.post('/api/staff', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const { name, email: rawEmail, role, skills, hourlyRate, status, password, phone, address, imageUrl, adminTabs } = req.body;
        const email = rawEmail.trim().toLowerCase();
        const actualPassword = password || `Pass${Math.random().toString(36).slice(-6)}!`;
        const passwordHash = await bcrypt.hash(actualPassword, 10);

        // Prevent duplicate identities across both auth tables.
        const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);
        const existingSuper = await db.select().from(superadmins).where(eq(superadmins.email, email)).limit(1);
        if (existingUser.length || existingSuper.length) {
            return res.status(400).json({ error: 'An account with this email already exists.' });
        }

        const normalizedRole = String(role || '').trim();
        const isSuperadmin = normalizedRole.toLowerCase() === 'superadmin';
        const isAdmin = normalizedRole.toLowerCase() === 'admin' || normalizedRole === 'Manager';
        const callerIsSuperadmin = req.user?.isSuperadmin === true;
        if ((isAdmin || isSuperadmin) && !callerIsSuperadmin) {
            return res.status(403).json({ error: 'Only superadmin can create admin-level accounts.' });
        }
        const appRole = isSuperadmin ? 'superadmin' : (isAdmin ? 'admin' : 'staff');
        const normalizedAdminTabs = Array.isArray(adminTabs)
            ? adminTabs.filter((x: unknown) => typeof x === 'string').map((x: string) => x.trim()).filter(Boolean)
            : [];
        const createdReferralCode = !isSuperadmin
            ? `STAFF${Math.random().toString(36).substring(7).toUpperCase()}`
            : '';

        if (isSuperadmin) {
            await db.insert(superadmins).values({
                name,
                email,
                passwordHash
            });
        } else {
            const userRes = await db.insert(users).values({
                name,
                email,
                passwordHash,
                role: appRole,
                isVerified: true,
                referralCode: createdReferralCode,
                ...(isAdmin ? { adminTabs: normalizedAdminTabs } : {})
            }).$returningId();

            // Only staff users get a staff profile row.
            if (!isAdmin) {
                await db.insert(staff).values({
                    userId: userRes[0].id,
                    name,
                    email,
                    role,
                    skills,
                    hourlyRate,
                    status: status || 'Active',
                    phone,
                    address,
                    imageUrl
                });
            }
        }

        const brandStaffNotify = await loadBrandVars(db);
        try {
            const referralLink = createdReferralCode
                ? `${publicSiteUrl(req)}/my-account?ref=${encodeURIComponent(createdReferralCode)}`
                : '';
            const staffPortalLink = `${publicSiteUrl(req)}/staff`;
            const { subject, html } = await renderTransactionalEmail(db, 'staff_welcome_credentials', {
                ...brandStaffNotify,
                staff_name: name,
                staff_email: email,
                role: appRole,
                temporary_password: actualPassword,
                staff_portal_link: staffPortalLink,
                referral_code: createdReferralCode,
                referral_link: referralLink,
            });
            await sendEmail({ to: [{ email, name }], subject, htmlContent: html });
        } catch (emailErr) {
            console.error('Failed to send welcome email:', emailErr);
        }

        if (!isSuperadmin && !isAdmin && phone) {
            try {
                await sendSmsFromTemplate(db, 'staff_account_created', phone, {
                    ...brandStaffNotify,
                    staff_name: name,
                    role: String(role || 'Cleaner'),
                    referral_code: createdReferralCode,
                    referral_link: createdReferralCode
                        ? `${publicSiteUrl(req)}/my-account?ref=${encodeURIComponent(createdReferralCode)}`
                        : '',
                });
            } catch (smsErr) {
                console.error('Staff welcome SMS failed:', smsErr);
            }
        }

        res.status(201).json({
            message: `${appRole} account created`,
            credentials: {
                email,
                password: actualPassword,
                role: appRole
            }
        });
    } catch (error) {
        console.error("Create Staff Error:", error);
        res.status(500).json({ error: 'Failed to create staff' });
    }
});

app.put('/api/staff/:id', authenticateToken, async (req: any, res) => {
    const staffId = parseInt(req.params.id, 10);
    if (Number.isNaN(staffId)) return res.status(400).json({ error: 'Invalid staff id' });
    try {
        const { password, currentPassword, ...details } = req.body;
        const requesterUserId = Number(req.user?.id);
        if (!Number.isFinite(requesterUserId) || requesterUserId <= 0) {
            return res.status(401).json({ error: 'Invalid session user.' });
        }

        const staffRec = await db.select().from(staff).where(eq(staff.id, staffId));
        if (staffRec.length === 0) return res.status(404).json({ error: 'Staff not found' });

        // Staff table id !== user id: staff must match their linked user row; admin can edit any staff.
        if (req.user.role !== 'admin') {
            if (req.user.role !== 'staff' || Number(staffRec[0].userId) !== requesterUserId) {
                return res.status(403).json({ error: 'Unauthorized' });
            }
        }

        if (password) {
            const newPw = String(password);
            if (newPw.length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters.' });
            }
            const targetUserId = Number(staffRec[0].userId);
            // Staff self-updates must verify current password. Admins can reset without it.
            if (req.user.role !== 'admin') {
                if (!currentPassword || typeof currentPassword !== 'string') {
                    return res.status(400).json({ error: 'Current password is required to change password.' });
                }
                const targetUser = await db.select().from(users).where(eq(users.id, targetUserId));
                if (!targetUser.length || !targetUser[0].passwordHash) {
                    return res.status(400).json({ error: 'Cannot verify current password.' });
                }
                const matches = await bcrypt.compare(String(currentPassword), String(targetUser[0].passwordHash));
                if (!matches) {
                    return res.status(400).json({ error: 'Current password is incorrect.' });
                }
            }
            const newPasswordHash = await bcrypt.hash(newPw, 10);
            await db.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, targetUserId));
        }

        // Never pass through raw body: clients send full row copies with id/userId/extra keys - Drizzle/MySQL rejects unknown or invalid SET columns.
        const ADMIN_KEYS = [
            'name',
            'email',
            'role',
            'hourlyRate',
            'skills',
            'availability',
            'status',
            'phone',
            'address',
            'postcode',
            'imageUrl',
            'bankName',
            'accountNumber',
            'sortCode',
        ] as const;
        const STAFF_SELF_KEYS = [
            'phone',
            'address',
            'postcode',
            'imageUrl',
            'bankName',
            'accountNumber',
            'sortCode',
            'availability',
        ] as const;
        const keys = req.user.role === 'admin' ? ADMIN_KEYS : STAFF_SELF_KEYS;
        const patch: Record<string, unknown> = {};
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(details, key) && details[key] !== undefined) {
                patch[key] = details[key];
            }
        }

        if (Object.keys(patch).length > 0) {
            await db.update(staff).set(patch as any).where(eq(staff.id, staffId));
        }

        res.json({ message: 'Staff updated' });
    } catch (error) {
        console.error('Update Staff Error:', error);
        const msg = error instanceof Error ? error.message : '';
        if (msg.toLowerCase().includes('data too long')) {
            return res.status(400).json({ error: 'One or more profile fields are too long (likely profile photo). Please use a smaller image or URL.' });
        }
        res.status(500).json({ error: 'Failed to update staff' });
    }
});

app.delete('/api/staff/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const staffId = parseInt(req.params.id);

        // 1. Find userId before deleting staff
        const existingStaff = await db.select().from(staff).where(eq(staff.id, staffId));
        if (!existingStaff.length) return res.status(404).json({ error: 'Staff not found' });

        const userId = existingStaff[0].userId;

        // 2. Delete Staff Record
        await db.delete(staff).where(eq(staff.id, staffId));

        // 3. Delete Linked User Record (Clean up auth)
        if (userId) {
            await db.delete(users).where(eq(users.id, userId));
        }

        res.json({ message: 'Staff and linked user account deleted' });
    } catch (error) {
        console.error("Delete Staff Error:", error);
        res.status(500).json({ error: 'Failed to delete staff' });
    }
});

app.get('/api/staff/:id/weekly-invoice', authenticateToken, async (req: any, res) => {
    try {
        const staffId = parseInt(req.params.id);
        const { weekDate } = req.query; // Optional date in the week
        if (!isAdminUser(req)) {
            if (req.user?.role !== 'staff') {
                return res.status(403).json({ error: 'Unauthorized' });
            }
            const [callerStaff] = await db.select().from(staff).where(eq(staff.userId, Number(req.user.id))).limit(1);
            if (!callerStaff || Number(callerStaff.id) !== Number(staffId)) {
                return res.status(403).json({ error: 'You can only view your own weekly invoice.' });
            }
        }

        const [staffRow] = await db.select().from(staff).where(eq(staff.id, staffId)).limit(1);
        if (!staffRow) return res.status(404).json({ error: 'Staff profile not found' });
        const hourlyRate = Number(staffRow?.hourlyRate || 0);

        // Determine the week range to filter by
        const refDate = weekDate ? new Date(weekDate as string) : new Date();
        const dayOfWeek = refDate.getDay();
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        const weekStart = new Date(refDate);
        weekStart.setDate(refDate.getDate() + mondayOffset);
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        weekEnd.setHours(23, 59, 59, 999);
        const weekStartStr = weekStart.toISOString().slice(0, 10);
        const weekEndStr = weekEnd.toISOString().slice(0, 10);

        // 1. Find all completed bookings where this staff was assigned
        const assignments = await db.select().from(bookingStaff).where(eq(bookingStaff.staffId, staffId));
        const bookingIds = assignments.map(a => a.bookingId).filter((id): id is number => id != null);

        if (bookingIds.length === 0) return res.json({ jobs: [], totalShare: 0, weekStart: weekStartStr, weekEnd: weekEndStr });

        // Fetch bookings details
        const jobs = [];
        let totalShare = 0;

        for (const bid of bookingIds) {
            const booking = await db.select().from(bookings).where(eq(bookings.id, bid));
            if (booking.length && booking[0].status === 'Completed') {
                const bookingDate = booking[0].date;
                if (bookingDate < weekStartStr || bookingDate > weekEndStr) continue;
                const b = booking[0];

                const assignRows = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, bid));
                let staffCount = assignRows.length;
                if (staffCount < 1 && b.assignedStaffId) staffCount = 1;
                staffCount = Math.max(1, staffCount);

                const pd = (b.propertyDetails as { duration?: number } | null) || {};
                const bookedHours = Number(pd.duration) > 0 ? Number(pd.duration) : 2;
                const yourHours = bookedHours / staffCount;
                const yourShare = yourHours * hourlyRate;

                jobs.push({
                    id: b.id,
                    date: b.date,
                    customer: b.contactName,
                    staffCount,
                    bookedHours,
                    yourHours,
                    hourlyRate,
                    yourShare,
                    hours: yourHours,
                });
                totalShare += yourShare;
            }
        }

        res.json({
            week: weekDate || 'Current',
            weekStart: weekStartStr,
            weekEnd: weekEndStr,
            jobs,
            totalShare
        });

    } catch (error) {
        console.error("Weekly Invoice Error", error);
        res.status(500).json({ error: 'Failed to generate weekly invoice' });
    }
});

app.post('/api/staff/:id/invoice', authenticateToken, async (req: any, res) => {
    try {
        const staffId = parseInt(req.params.id);
        if (req.user.role === 'staff') {
            const sp = await db.select().from(staff).where(eq(staff.userId, req.user.id)).limit(1);
            if (!sp.length || sp[0].id !== staffId) {
                return res.status(403).json({ error: 'You can only submit your own invoices.' });
            }
        } else if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const { totalAmount, jobs, week, bankDetails, weekTotalHours, weekJobCount } = req.body; // Passed from frontend for simplicity or recalc

        const jobList = Array.isArray(jobs) ? jobs : [];

        const jobListForEmail = await Promise.all(
            jobList.map(async (j: any) => {
                const bidNum = Number(j.id);
                const br =
                    Number.isFinite(bidNum) && bidNum > 0
                        ? await db.select().from(bookings).where(eq(bookings.id, bidNum)).limit(1)
                        : [];
                const clientJobTotal = br[0] != null ? Number(br[0].totalPrice) : null;
                return { ...j, clientJobTotal };
            })
        );

        const hoursSum = typeof weekTotalHours === 'number'
            ? weekTotalHours
            : jobListForEmail.reduce((s: number, j: any) => s + (Number(j.yourHours ?? j.hours) || 0), 0);
        const jobCount = typeof weekJobCount === 'number' ? weekJobCount : jobListForEmail.length;

        const weekStr = String(week || '');
        const weekParts = weekStr.split(/\s*(?:→|->)\s*|\s+-\s+/);
        const weekStart = weekParts[0]?.trim() || null;
        const weekEnd = weekParts[1]?.trim() || null;

        const [staffRow] = await db.select().from(staff).where(eq(staff.id, staffId)).limit(1);
        const staffName = staffRow?.name ?? `Staff #${staffId}`;

        const settingsMap = await loadBusinessSettingsMap(db);
        const adminTo = adminInvoiceRecipientEmail(settingsMap);
        const tableHtml = weeklyInvoiceJobTableHtml(jobListForEmail);
        const brand = await loadBrandVars(db);
        const { subject, html } = await renderTransactionalEmail(db, 'staff_weekly_invoice_admin', {
            ...brand,
            staff_name: staffName,
            staff_id: String(staffId),
            week: String(week || ''),
            total_amount: Number(totalAmount || 0).toFixed(2),
            hours_sum: Number(hoursSum || 0).toFixed(2),
            job_count: String(jobCount),
            bank_name: bankDetails?.bankName || 'Not provided',
            account_number: bankDetails?.accountNumber || 'Not provided',
            sort_code: bankDetails?.sortCode || 'Not provided',
            job_table_html: tableHtml,
        });
        await sendEmail({
            to: [{ email: adminTo, name: 'Payroll' }],
            subject,
            htmlContent: html,
        });

        await db.insert(staffInvoices).values({
            staffId,
            staffName,
            weekLabel: weekStr || 'Current week',
            weekStart,
            weekEnd,
            totalAmount: Number(totalAmount || 0).toFixed(2),
            weekTotalHours: Number(hoursSum || 0).toFixed(2),
            weekJobCount: jobCount,
            jobsJson: jobListForEmail,
            bankJson: bankDetails ?? null,
            status: 'Pending',
        });

        const adminIds = await getAdminUserIds();
        if (adminIds.length > 0) {
            await db.insert(notifications).values(
                adminIds.map((adminId) => ({
                    userId: adminId,
                    type: 'system',
                    message: `New weekly invoice submitted by ${staffName} (${weekStr || 'Current week'}).`,
                    isRead: false,
                }))
            );
        }

        broadcastSync('all');
        res.json({ success: true, message: 'Invoice submitted to Admin' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to submit invoice' });
    }
});

app.get('/api/staff/:id/invoices-history', authenticateToken, async (req: any, res) => {
    const staffId = parseInt(req.params.id, 10);
    if (Number.isNaN(staffId)) return res.status(400).json({ error: 'Invalid staff id' });
    try {
        if (req.user.role === 'staff') {
            const sp = await db.select().from(staff).where(eq(staff.userId, req.user.id)).limit(1);
            if (!sp.length || Number(sp[0].id) !== staffId) {
                return res.status(403).json({ error: 'You can only view your own invoices.' });
            }
        } else if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const rows = await db
            .select()
            .from(staffInvoices)
            .where(eq(staffInvoices.staffId, staffId))
            .orderBy(desc(staffInvoices.createdAt));

        return res.json(
            rows.map((r) => ({
                id: Number(r.id),
                staffId: Number(r.staffId),
                staffName: r.staffName,
                weekLabel: r.weekLabel,
                weekStart: r.weekStart,
                weekEnd: r.weekEnd,
                totalAmount: parseFloat(String(r.totalAmount || 0)),
                weekTotalHours: parseFloat(String(r.weekTotalHours || 0)),
                weekJobCount: Number(r.weekJobCount || 0),
                jobs: r.jobsJson,
                bankDetails: r.bankJson,
                status: r.status,
                adminNotes: r.adminNotes ?? null,
                createdAt: r.createdAt,
            }))
        );
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Failed to fetch invoice history' });
    }
});

app.get('/api/invoices', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin only' });
    }
    try {
        const rows = await db.select().from(staffInvoices).orderBy(desc(staffInvoices.createdAt));
        res.json(
            rows.map((r) => ({
                id: r.id,
                staffId: r.staffId,
                staffName: r.staffName,
                weekLabel: r.weekLabel,
                weekStart: r.weekStart,
                weekEnd: r.weekEnd,
                totalAmount: parseFloat(String(r.totalAmount)),
                weekTotalHours: parseFloat(String(r.weekTotalHours || 0)),
                weekJobCount: r.weekJobCount,
                jobs: r.jobsJson,
                bankDetails: r.bankJson,
                status: r.status,
                adminNotes: r.adminNotes,
                createdAt: r.createdAt,
            }))
        );
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to fetch invoices' });
    }
});

app.patch('/api/invoices/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin only' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        const { status, adminNotes } = req.body || {};
        // Status is optional so a note can be added or corrected on its own.
        if (status !== undefined && !['Approved', 'Rejected', 'Pending'].includes(String(status))) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        if (status === undefined && adminNotes === undefined) {
            return res.status(400).json({ error: 'Nothing to update' });
        }
        const existing = await db.select().from(staffInvoices).where(eq(staffInvoices.id, id)).limit(1);
        if (!existing.length) return res.status(404).json({ error: 'Invoice not found' });

        const patch: { status?: string; adminNotes?: string | null } = {};
        if (status !== undefined) patch.status = String(status);
        if (adminNotes !== undefined) patch.adminNotes = cleanInvoiceNote(adminNotes);
        await db.update(staffInvoices).set(patch).where(eq(staffInvoices.id, id));

        const staffIdForInvoice = Number(existing[0].staffId);
        const staffRow = await db.select().from(staff).where(eq(staff.id, staffIdForInvoice)).limit(1);
        const staffUserId = Number(staffRow[0]?.userId || 0);
        const statusChanged = status !== undefined && String(status) !== existing[0].status;
        if (staffUserId > 0 && statusChanged && (String(status) === 'Approved' || String(status) === 'Rejected')) {
            const note = patch.adminNotes ? ` Note: ${patch.adminNotes}` : '';
            await db.insert(notifications).values({
                userId: staffUserId,
                type: 'system',
                message: `Your weekly invoice (${existing[0].weekLabel || 'current week'}) was ${String(status).toLowerCase()} by admin.${note}`,
                isRead: false,
            });
        } else if (staffUserId > 0 && !statusChanged && patch.adminNotes && patch.adminNotes !== existing[0].adminNotes) {
            await db.insert(notifications).values({
                userId: staffUserId,
                type: 'system',
                message: `Admin added a note to your weekly invoice (${existing[0].weekLabel || 'current week'}): ${patch.adminNotes}`,
                isRead: false,
            });
        }

        broadcastSync('all');
        res.json({ message: 'Invoice updated' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to update invoice' });
    }
});

app.delete('/api/invoices/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin only' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const existing = await db.select().from(staffInvoices).where(eq(staffInvoices.id, id)).limit(1);
        if (!existing.length) return res.status(404).json({ error: 'Invoice not found' });
        await db.delete(staffInvoices).where(eq(staffInvoices.id, id));

        // Let the cleaner know, so they can resubmit a corrected invoice.
        const staffRow = await db.select().from(staff).where(eq(staff.id, Number(existing[0].staffId))).limit(1);
        const staffUserId = Number(staffRow[0]?.userId || 0);
        if (staffUserId > 0) {
            await db.insert(notifications).values({
                userId: staffUserId,
                type: 'system',
                message: `Your weekly invoice (${existing[0].weekLabel || 'current week'}) was removed by admin. Please check your jobs and submit it again if needed.`,
                isRead: false,
            });
        }

        broadcastSync('all');
        res.json({ message: 'Invoice deleted' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to delete invoice' });
    }
});

// ── Direct Messages (Staff ↔ Admin) ────────────────────────────────────

app.get('/api/direct-messages', authenticateToken, async (req: any, res) => {
    try {
        const userId = Number(req.user.id);
        const userRole = req.user.role;

        let messages;
        if (userRole === 'admin') {
            // Admin sees all direct messages
            messages = await db.select().from(directMessages)
                .orderBy(desc(directMessages.createdAt))
                .limit(100);
        } else {
            // Staff sees messages they sent + messages sent to them (or broadcast to staff)
            messages = await db.select().from(directMessages)
                .where(
                    or(
                        eq(directMessages.senderUserId, userId),
                        eq(directMessages.recipientUserId, userId),
                        and(
                            eq(directMessages.recipientRole, 'staff'),
                            eq(directMessages.recipientUserId, 0)
                        )
                    )
                )
                .orderBy(desc(directMessages.createdAt))
                .limit(100);
        }

        res.json(messages || []);
    } catch (error) {
        console.error('Direct messages fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

app.post('/api/direct-messages', authenticateToken, async (req: any, res) => {
    try {
        const userId = Number(req.user.id);
        const userName = req.user.name || req.user.email;
        const userRole = req.user.role;
        const { text, recipientUserId } = req.body;

        if (!text || !String(text).trim()) {
            return res.status(400).json({ error: 'Message text is required' });
        }

        const senderRole = userRole === 'admin' ? 'admin' : 'staff';
        const recipientRole = senderRole === 'staff' ? 'admin' : 'staff';

        await db.insert(directMessages).values({
            senderUserId: userId,
            senderName: String(userName),
            senderRole,
            recipientRole,
            recipientUserId: recipientUserId ? Number(recipientUserId) : 0,
            text: String(text).trim(),
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Direct message send error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.put('/api/direct-messages/read', authenticateToken, async (req: any, res) => {
    try {
        const userId = Number(req.user.id);
        await db.update(directMessages)
            .set({ isRead: true })
            .where(
                and(
                    or(
                        eq(directMessages.recipientUserId, userId),
                        eq(directMessages.recipientUserId, 0)
                    ),
                    eq(directMessages.isRead, false)
                )
            );
        res.json({ success: true });
    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ error: 'Failed to mark messages as read' });
    }
});

// ── Customer Invoices CRUD ──────────────────────────────────────────────

/** Invoice notes are free text; trim, cap length, and store empty as null. */
function cleanInvoiceNote(value: unknown): string | null {
    const text = String(value ?? '').trim().slice(0, 2000);
    return text || null;
}

/** Customer-facing note block for invoice emails (escaped, line breaks kept). */
function invoiceNotesHtml(notes: string | null | undefined): string {
    if (!notes || !String(notes).trim()) return '';
    const safe = escapeHtmlBasic(String(notes)).replace(/\n/g, '<br />');
    return `<div style="margin-top:20px;padding:16px;background:#f8fafc;border-radius:8px;font-size:13px;color:#475569;"><strong>Notes:</strong><br />${safe}</div>`;
}

async function nextInvoiceNumber(): Promise<string> {
    const [rows] = await poolConnection.query(
        `SELECT invoice_number FROM customer_invoices ORDER BY id DESC LIMIT 1`
    );
    const last = (rows as any[])[0]?.invoice_number as string | undefined;
    let seq = 1;
    if (last) {
        const m = last.match(/(\d+)$/);
        if (m) seq = parseInt(m[1], 10) + 1;
    }
    return `CIN-INV-${String(seq).padStart(4, '0')}`;
}

app.get('/api/customer-invoices', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const rows = await db.select().from(customerInvoices).orderBy(desc(customerInvoices.createdAt));
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to fetch customer invoices' });
    }
});

app.post('/api/customer-invoices', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const { customerName, customerEmail, customerPhone, bookingId, customerId, items, subtotal, vatRate, vatAmount, total, notes, adminNotes, dueDate, status } = req.body;
        if (!customerName || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Customer name and at least one line item required' });
        }
        const invoiceNumber = await nextInvoiceNumber();
        const result = await db.insert(customerInvoices).values({
            invoiceNumber,
            bookingId: bookingId ? Number(bookingId) : null,
            customerId: customerId ? Number(customerId) : null,
            customerName: String(customerName).slice(0, 255),
            customerEmail: customerEmail ? String(customerEmail).slice(0, 255) : null,
            customerPhone: customerPhone ? String(customerPhone).slice(0, 50) : null,
            items,
            subtotal: String(subtotal),
            vatRate: String(vatRate ?? '20.00'),
            vatAmount: String(vatAmount),
            total: String(total),
            status: status || 'draft',
            notes: cleanInvoiceNote(notes),
            adminNotes: cleanInvoiceNote(adminNotes),
            dueDate: dueDate ? String(dueDate) : null,
            createdBy: Number(req.user.id),
        }).$returningId();
        broadcastSync('all');
        res.status(201).json({ id: result[0].id, invoiceNumber, message: 'Invoice created' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to create invoice' });
    }
});

app.get('/api/customer-invoices/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const rows = await db.select().from(customerInvoices).where(eq(customerInvoices.id, id)).limit(1);
        if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
        res.json(rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to fetch invoice' });
    }
});

app.patch('/api/customer-invoices/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const existing = await db.select().from(customerInvoices).where(eq(customerInvoices.id, id)).limit(1);
        if (!existing.length) return res.status(404).json({ error: 'Invoice not found' });

        const { customerName, customerEmail, customerPhone, items, subtotal, vatRate, vatAmount, total, notes, adminNotes, dueDate, status } = req.body;
        const patch: Record<string, any> = {};
        if (customerName !== undefined) patch.customerName = String(customerName).slice(0, 255);
        if (customerEmail !== undefined) patch.customerEmail = customerEmail ? String(customerEmail).slice(0, 255) : null;
        if (customerPhone !== undefined) patch.customerPhone = customerPhone ? String(customerPhone).slice(0, 50) : null;
        if (items !== undefined) patch.items = items;
        if (subtotal !== undefined) patch.subtotal = String(subtotal);
        if (vatRate !== undefined) patch.vatRate = String(vatRate);
        if (vatAmount !== undefined) patch.vatAmount = String(vatAmount);
        if (total !== undefined) patch.total = String(total);
        if (notes !== undefined) patch.notes = cleanInvoiceNote(notes);
        if (adminNotes !== undefined) patch.adminNotes = cleanInvoiceNote(adminNotes);
        if (dueDate !== undefined) patch.dueDate = dueDate ? String(dueDate) : null;
        if (status !== undefined) patch.status = String(status);
        if (status === 'paid') patch.paidAt = new Date();

        await db.update(customerInvoices).set(patch).where(eq(customerInvoices.id, id));
        broadcastSync('all');
        res.json({ message: 'Invoice updated' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to update invoice' });
    }
});

app.delete('/api/customer-invoices/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const existing = await db.select({ id: customerInvoices.id }).from(customerInvoices).where(eq(customerInvoices.id, id)).limit(1);
        if (!existing.length) return res.status(404).json({ error: 'Invoice not found' });
        await db.delete(customerInvoices).where(eq(customerInvoices.id, id));
        broadcastSync('all');
        res.json({ message: 'Invoice deleted' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to delete invoice' });
    }
});

app.get('/api/customer-invoices/:id/preview', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const rows = await db.select().from(customerInvoices).where(eq(customerInvoices.id, id)).limit(1);
        if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
        const inv = rows[0];

        const brandVars = await loadBrandVars(db);
        const lineItems = (inv.items as any[]) || [];

        const fmtDur = (mins: number) => { const h = Math.floor(mins / 60); const m = mins % 60; return m ? `${h}h ${m}m` : `${h}h`; };
        const hasDuration = lineItems.some((li: any) => li.duration);
        const hasRate = lineItems.some((li: any) => li.hourlyRate);

        const itemsHtml = lineItems.map((li: any) => {
            let row = `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtmlBasic(String(li.description || ''))}`;
            if (li.hourlyRate && !hasRate) row += `<br/><span style="font-size:12px;color:#64748b;">&pound;${Number(li.hourlyRate).toFixed(2)}/hr</span>`;
            row += `</td>`;
            row += `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${li.quantity ?? 1}</td>`;
            if (hasRate) row += `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">&pound;${Number(li.hourlyRate || li.unitPrice || 0).toFixed(2)}${li.hourlyRate ? '/hr' : ''}</td>`;
            if (hasDuration) row += `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${li.duration ? fmtDur(li.duration) : '—'}</td>`;
            row += `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">&pound;${Number(li.unitPrice || 0).toFixed(2)}</td>`;
            row += `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;">&pound;${Number(li.lineTotal || 0).toFixed(2)}</td></tr>`;
            return row;
        }).join('');

        const invoiceInnerHtml = `<p>Hi ${escapeHtmlBasic(String(inv.customerName || ''))},</p>
<p>Please find your invoice below.</p>
<div style="background:#f0fdfa;border-radius:12px;padding:18px 20px;margin:20px 0;border:1px solid #99f6e4;">
  <p style="margin:0 0 6px;font-weight:700;color:#0f172a;">Invoice ${inv.invoiceNumber}</p>
  <p style="margin:4px 0;"><strong>Date:</strong> ${inv.createdAt ? new Date(inv.createdAt).toLocaleDateString('en-GB') : 'N/A'}</p>
  ${inv.dueDate ? `<p style="margin:4px 0;"><strong>Due:</strong> ${inv.dueDate}</p>` : ''}
</div>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
  <thead><tr style="background:#f1f5f9;">
    <th style="padding:10px 12px;text-align:left;font-weight:600;">Service</th>
    <th style="padding:10px 12px;text-align:center;font-weight:600;">Hrs/Qty</th>
    ${hasRate ? '<th style="padding:10px 12px;text-align:right;font-weight:600;">Rate</th>' : ''}
    ${hasDuration ? '<th style="padding:10px 12px;text-align:center;font-weight:600;">Duration</th>' : ''}
    <th style="padding:10px 12px;text-align:right;font-weight:600;">Unit Price</th>
    <th style="padding:10px 12px;text-align:right;font-weight:600;">Total</th>
  </tr></thead>
  <tbody>${itemsHtml}</tbody>
</table>
<table style="width:100%;font-size:14px;">
  <tr><td></td><td style="text-align:right;padding:4px 12px;">Subtotal: <strong>&pound;${Number(inv.subtotal).toFixed(2)}</strong></td></tr>
  <tr><td></td><td style="text-align:right;padding:4px 12px;">VAT (${Number(inv.vatRate).toFixed(0)}%): <strong>&pound;${Number(inv.vatAmount).toFixed(2)}</strong></td></tr>
  <tr><td></td><td style="text-align:right;padding:8px 12px;font-size:18px;border-top:2px solid ${brandVars.brand_primary || '#0d9488'};"><strong>Total: &pound;${Number(inv.total).toFixed(2)}</strong></td></tr>
</table>
${invoiceNotesHtml(inv.notes)}
${inv.stripePaymentUrl && inv.status !== 'paid' ? `<div style="text-align:center;margin:28px 0 12px;">
  <a href="${inv.stripePaymentUrl}" style="display:inline-block;padding:14px 40px;background:${brandVars.brand_primary || '#7c3aed'};color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:10px;">Pay Now &mdash; &pound;${Number(inv.total).toFixed(2)}</a>
</div>` : ''}
<p style="color:#64748b;font-size:14px;margin-top:20px;">If you have any questions about this invoice, please don't hesitate to contact us.</p>`;

        const html = await wrapHtmlInEmailShell(db, invoiceInnerHtml, brandVars);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (e: any) {
        console.error('Preview customer invoice error:', e?.message || e);
        res.status(500).json({ error: 'Failed to generate preview' });
    }
});

app.post('/api/customer-invoices/:id/send', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const rows = await db.select().from(customerInvoices).where(eq(customerInvoices.id, id)).limit(1);
        if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
        const inv = rows[0];
        const { via } = req.body; // 'email' | 'sms' | 'both'

        const brandVars = await loadBrandVars(db);
        const companyName = brandVars.brand_name || 'CiN Cleaning';
        const companyPhone = brandVars.brand_phone || '';
        const companyEmail = brandVars.brand_email || '';
        const lineItems = (inv.items as any[]) || [];

        if (via === 'email' || via === 'both') {
            if (!inv.customerEmail) return res.status(400).json({ error: 'No customer email on this invoice' });

            const fmtDur = (mins: number) => { const h = Math.floor(mins / 60); const m = mins % 60; return m ? `${h}h ${m}m` : `${h}h`; };
            const hasDuration = lineItems.some((li: any) => li.duration);
            const hasRate = lineItems.some((li: any) => li.hourlyRate);

            const itemsHtml = lineItems.map((li: any) => {
                let row = `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtmlBasic(String(li.description || ''))}`;
                if (li.hourlyRate && !hasRate) row += `<br/><span style="font-size:12px;color:#64748b;">&pound;${Number(li.hourlyRate).toFixed(2)}/hr</span>`;
                row += `</td>`;
                row += `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${li.quantity ?? 1}</td>`;
                if (hasRate) row += `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">&pound;${Number(li.hourlyRate || li.unitPrice || 0).toFixed(2)}${li.hourlyRate ? '/hr' : ''}</td>`;
                if (hasDuration) row += `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${li.duration ? fmtDur(li.duration) : '—'}</td>`;
                row += `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">&pound;${Number(li.unitPrice || 0).toFixed(2)}</td>`;
                row += `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;">&pound;${Number(li.lineTotal || 0).toFixed(2)}</td></tr>`;
                return row;
            }).join('');

            const invoiceInnerHtml = `<p>Hi ${escapeHtmlBasic(String(inv.customerName || ''))},</p>
<p>Please find your invoice below.</p>
<div style="background:#f0fdfa;border-radius:12px;padding:18px 20px;margin:20px 0;border:1px solid #99f6e4;">
  <p style="margin:0 0 6px;font-weight:700;color:#0f172a;">Invoice ${inv.invoiceNumber}</p>
  <p style="margin:4px 0;"><strong>Date:</strong> ${inv.createdAt ? new Date(inv.createdAt).toLocaleDateString('en-GB') : 'N/A'}</p>
  ${inv.dueDate ? `<p style="margin:4px 0;"><strong>Due:</strong> ${inv.dueDate}</p>` : ''}
</div>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
  <thead><tr style="background:#f1f5f9;">
    <th style="padding:10px 12px;text-align:left;font-weight:600;">Service</th>
    <th style="padding:10px 12px;text-align:center;font-weight:600;">Hrs/Qty</th>
    ${hasRate ? '<th style="padding:10px 12px;text-align:right;font-weight:600;">Rate</th>' : ''}
    ${hasDuration ? '<th style="padding:10px 12px;text-align:center;font-weight:600;">Duration</th>' : ''}
    <th style="padding:10px 12px;text-align:right;font-weight:600;">Unit Price</th>
    <th style="padding:10px 12px;text-align:right;font-weight:600;">Total</th>
  </tr></thead>
  <tbody>${itemsHtml}</tbody>
</table>
<table style="width:100%;font-size:14px;">
  <tr><td></td><td style="text-align:right;padding:4px 12px;">Subtotal: <strong>&pound;${Number(inv.subtotal).toFixed(2)}</strong></td></tr>
  <tr><td></td><td style="text-align:right;padding:4px 12px;">VAT (${Number(inv.vatRate).toFixed(0)}%): <strong>&pound;${Number(inv.vatAmount).toFixed(2)}</strong></td></tr>
  <tr><td></td><td style="text-align:right;padding:8px 12px;font-size:18px;border-top:2px solid ${brandVars.brand_primary || '#0d9488'};"><strong>Total: &pound;${Number(inv.total).toFixed(2)}</strong></td></tr>
</table>
${invoiceNotesHtml(inv.notes)}
${inv.stripePaymentUrl && inv.status !== 'paid' ? `<div style="text-align:center;margin:28px 0 12px;">
  <a href="${inv.stripePaymentUrl}" style="display:inline-block;padding:14px 40px;background:${brandVars.brand_primary || '#7c3aed'};color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:10px;">Pay Now &mdash; &pound;${Number(inv.total).toFixed(2)}</a>
</div>` : ''}
<p style="color:#64748b;font-size:14px;margin-top:20px;">If you have any questions about this invoice, please don't hesitate to contact us.</p>`;

            const html = await wrapHtmlInEmailShell(db, invoiceInnerHtml, brandVars);

            await sendEmail({
                to: [{ email: inv.customerEmail, name: inv.customerName }],
                subject: `Invoice ${inv.invoiceNumber} from ${companyName}`,
                htmlContent: html,
            });
        }

        if (via === 'sms' || via === 'both') {
            if (!inv.customerPhone) return res.status(400).json({ error: 'No customer phone on this invoice' });
            const smsText = `Hi ${inv.customerName}, invoice ${inv.invoiceNumber} for £${Number(inv.total).toFixed(2)} from ${companyName}. ${inv.dueDate ? `Due: ${inv.dueDate}. ` : ''}Please check your email for full details or call us on ${companyPhone || 'our office line'}.`;
            await sendSmsFromTemplate(db, 'generic_sms', inv.customerPhone, {
                brand_name: companyName,
                message_body: smsText,
            });
        }

        await db.update(customerInvoices).set({
            status: inv.status === 'draft' ? 'sent' : inv.status,
            sentAt: new Date(),
            sentVia: String(via || 'email'),
        }).where(eq(customerInvoices.id, id));

        if (inv.customerId) {
            await db.insert(notifications).values({
                userId: inv.customerId,
                type: 'invoice',
                message: `Invoice ${inv.invoiceNumber} for £${Number(inv.total).toFixed(2)} is now available.`,
                isRead: false,
            });
            broadcastSync('notifications');
        }

        broadcastSync('all');
        res.json({ success: true, message: `Invoice sent via ${via || 'email'}` });
    } catch (e: any) {
        console.error('Send customer invoice error:', e?.message || e, e?.stack || '');
        res.status(500).json({ error: 'Failed to send invoice', detail: String(e?.message || e) });
    }
});

// ── Stripe Payment for Customer Invoices ──

app.post('/api/customer-invoices/:id/create-payment-intent', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured. Add STRIPE_SECRET_KEY to .env' });
    try {
        const id = parseInt(req.params.id, 10);
        const rows = await db.select().from(customerInvoices).where(eq(customerInvoices.id, id)).limit(1);
        if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
        const inv = rows[0];

        if (inv.stripePaymentIntentId) {
            const existing = await stripe.paymentIntents.retrieve(inv.stripePaymentIntentId);
            if (existing.status === 'succeeded') return res.json({ alreadyPaid: true });
            return res.json({ clientSecret: existing.client_secret, paymentIntentId: existing.id });
        }

        const amountPence = Math.round(Number(inv.total) * 100);
        const pi = await stripe.paymentIntents.create({
            amount: amountPence,
            currency: 'gbp',
            metadata: { invoiceId: String(inv.id), invoiceNumber: inv.invoiceNumber },
            description: `Invoice ${inv.invoiceNumber} — ${inv.customerName}`,
            receipt_email: inv.customerEmail || undefined,
        });

        const payUrl = `${publicBaseUrlFromRequest(req)}/pay/invoice/${inv.id}`;
        await db.update(customerInvoices).set({
            stripePaymentIntentId: pi.id,
            stripePaymentUrl: payUrl,
        }).where(eq(customerInvoices.id, id));

        res.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id, payUrl });
    } catch (e: any) {
        console.error('Create payment intent error:', e?.message || e);
        res.status(500).json({ error: 'Failed to create payment', detail: String(e?.message || e) });
    }
});

app.get('/api/pay/invoice/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const rows = await db.select().from(customerInvoices).where(eq(customerInvoices.id, id)).limit(1);
        if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
        const inv = rows[0];

        if (inv.status === 'paid') return res.json({ paid: true, invoiceNumber: inv.invoiceNumber });
        if (!inv.stripePaymentIntentId || !stripe) return res.status(400).json({ error: 'No payment set up for this invoice' });

        const pi = await stripe.paymentIntents.retrieve(inv.stripePaymentIntentId);
        if (pi.status === 'succeeded') {
            await db.update(customerInvoices).set({ status: 'paid', paidAt: new Date() }).where(eq(customerInvoices.id, id));
            return res.json({ paid: true, invoiceNumber: inv.invoiceNumber });
        }

        const brandVars = await loadBrandVars(db);
        res.json({
            clientSecret: pi.client_secret,
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
            invoiceNumber: inv.invoiceNumber,
            customerName: inv.customerName,
            total: Number(inv.total),
            items: inv.items,
            brandName: brandVars.brand_name || 'CiN Cleaning',
            brandPrimary: brandVars.brand_primary || '#7c3aed',
        });
    } catch (e: any) {
        console.error('Get payment info error:', e?.message || e);
        res.status(500).json({ error: 'Failed to load payment info' });
    }
});

app.get('/api/my-invoices', authenticateToken, async (req: any, res) => {
    try {
        const rows = await db.select().from(customerInvoices)
            .where(eq(customerInvoices.customerId, req.user.id))
            .orderBy(desc(customerInvoices.createdAt));
        res.json(rows.filter(r => r.status !== 'draft').map(({ adminNotes: _private, ...r }) => r));
    } catch (e: any) {
        console.error('My invoices error:', e?.message || e);
        res.status(500).json({ error: 'Failed to fetch invoices' });
    }
});

app.post('/api/customer-invoices/from-booking/:bookingId', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const bRow = await selectBookingByRouteParam(req.params.bookingId);
        if (!bRow) return res.status(404).json({ error: 'Booking not found' });
        const invoiceNumber = await nextInvoiceNumber();
        const items = [{
            description: bRow.serviceType || 'Cleaning service',
            quantity: 1,
            unitPrice: Number(bRow.totalPrice) || 0,
            lineTotal: Number(bRow.totalPrice) || 0,
        }];
        const subtotal = Number(bRow.totalPrice) || 0;
        const vatRate = 20;
        const vatAmount = +(subtotal * vatRate / 100).toFixed(2);
        const total = +(subtotal + vatAmount).toFixed(2);

        const result = await db.insert(customerInvoices).values({
            invoiceNumber,
            bookingId: bRow.id,
            customerId: bRow.customerId || null,
            customerName: bRow.contactName || 'Customer',
            customerEmail: bRow.contactEmail || null,
            customerPhone: bRow.contactPhone || null,
            items,
            subtotal: String(subtotal),
            vatRate: String(vatRate),
            vatAmount: String(vatAmount),
            total: String(total),
            status: 'draft',
            createdBy: Number(req.user.id),
        }).$returningId();
        broadcastSync('all');
        res.status(201).json({ id: result[0].id, invoiceNumber, message: 'Invoice created from booking' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to create invoice from booking' });
    }
});

// ── Gallery ─────────────────────────────────────────────────────────────

app.get('/api/admin/gallery', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const rows = await db.select().from(galleryItems).orderBy(asc(galleryItems.sortOrder), asc(galleryItems.id));
        res.json(rows.map(mapGalleryRow));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
});

app.post('/api/admin/gallery', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const { title, imageUrl, caption, sortOrder, published } = req.body || {};
        if (!title || !imageUrl) return res.status(400).json({ error: 'title and imageUrl required' });
        await db.insert(galleryItems).values({
            title: String(title).slice(0, 255),
            imageUrl: String(imageUrl),
            caption: caption != null ? String(caption) : null,
            sortOrder: Number(sortOrder) || 0,
            published: published !== false,
        });
        broadcastSync('all');
        res.json({ message: 'Gallery item created' });
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e.message || 'Create failed' });
    }
});

app.patch('/api/admin/gallery/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const { title, imageUrl, caption, sortOrder, published } = req.body || {};
        const patch: Record<string, unknown> = {};
        if (title != null) patch.title = String(title).slice(0, 255);
        if (imageUrl != null) patch.imageUrl = String(imageUrl);
        if (caption !== undefined) patch.caption = caption === null ? null : String(caption);
        if (sortOrder !== undefined) patch.sortOrder = Number(sortOrder) || 0;
        if (published !== undefined) patch.published = Boolean(published);
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'No updates' });
        await db.update(galleryItems).set(patch as any).where(eq(galleryItems.id, id));
        broadcastSync('all');
        res.json({ message: 'Updated' });
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e.message || 'Update failed' });
    }
});

app.delete('/api/admin/gallery/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        await db.delete(galleryItems).where(eq(galleryItems.id, id));
        broadcastSync('all');
        res.json({ message: 'Deleted' });
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e.message || 'Delete failed' });
    }
});

app.get('/api/admin/blog-posts', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const rows = await db.select().from(blogPosts).orderBy(desc(blogPosts.publishedAt), desc(blogPosts.id));
        res.json(rows.map(mapBlogRow));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to load posts' });
    }
});

app.post('/api/admin/blog-posts', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const body = req.body || {};
        const title = String(body.title || '').trim();
        if (!title) return res.status(400).json({ error: 'title required' });
        const rawSlug = String(body.slug || '').trim();
        const slug = rawSlug ? slugify(rawSlug) : slugify(title);
        if (!slug) return res.status(400).json({ error: 'Invalid slug' });
        const bodyHtml = String(body.bodyHtml ?? '').trim();
        if (!bodyHtml) return res.status(400).json({ error: 'bodyHtml required' });
        const published = body.published !== false;
        const publishedAt = published ? (body.publishedAt ? new Date(body.publishedAt) : new Date()) : null;
        await db.insert(blogPosts).values({
            title: title.slice(0, 255),
            slug: slug.slice(0, 200),
            excerpt: body.excerpt != null ? String(body.excerpt) : null,
            bodyHtml,
            heroImageUrl: body.heroImageUrl != null ? String(body.heroImageUrl) : null,
            metaTitle: body.metaTitle != null ? String(body.metaTitle).slice(0, 512) : null,
            metaDescription: body.metaDescription != null ? String(body.metaDescription) : null,
            metaKeywords: body.metaKeywords != null ? String(body.metaKeywords).slice(0, 512) : null,
            published,
            publishedAt,
        });
        broadcastSync('all');
        res.json({ message: 'Post created' });
    } catch (e: any) {
        console.error(e);
        const msg = String(e?.message || e);
        if (msg.toLowerCase().includes('duplicate')) return res.status(409).json({ error: 'Slug already exists' });
        res.status(500).json({ error: msg || 'Create failed' });
    }
});

app.patch('/api/admin/blog-posts/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        const found = await db.select({ id: blogPosts.id }).from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
        if (!found.length) return res.status(404).json({ error: 'Post not found' });
        const body = req.body || {};
        const patch: Record<string, unknown> = {};
        if (body.title != null) patch.title = String(body.title).slice(0, 255);
        if (body.slug != null) {
            const nextSlug = slugify(String(body.slug)).slice(0, 200);
            if (!nextSlug) return res.status(400).json({ error: 'Invalid slug — use letters or numbers (or clear the field to keep the current slug).' });
            patch.slug = nextSlug;
        }
        if (body.excerpt !== undefined) patch.excerpt = body.excerpt === null ? null : String(body.excerpt);
        if (body.bodyHtml != null) patch.bodyHtml = String(body.bodyHtml);
        if (body.heroImageUrl !== undefined) patch.heroImageUrl = body.heroImageUrl === null ? null : String(body.heroImageUrl);
        if (body.metaTitle !== undefined) patch.metaTitle = body.metaTitle === null ? null : String(body.metaTitle).slice(0, 512);
        if (body.metaDescription !== undefined) patch.metaDescription = body.metaDescription === null ? null : String(body.metaDescription);
        if (body.metaKeywords !== undefined) patch.metaKeywords = body.metaKeywords === null ? null : String(body.metaKeywords).slice(0, 512);
        if (body.published !== undefined) {
            patch.published = Boolean(body.published);
            if (body.published && body.publishedAt === undefined) {
                const cur = await db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
                if (cur.length && !cur[0].publishedAt) patch.publishedAt = new Date();
            }
            if (!body.published) patch.publishedAt = null;
        }
        if (body.publishedAt !== undefined) patch.publishedAt = body.publishedAt ? new Date(body.publishedAt) : null;
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'No updates' });
        patch.updatedAt = new Date();
        await db.update(blogPosts).set(patch as any).where(eq(blogPosts.id, id));
        broadcastSync('all');
        res.json({ message: 'Updated' });
    } catch (e: any) {
        console.error(e);
        const errno = e?.errno ?? e?.code;
        const msg = String(e?.message || e || '');
        if (errno === 1062 || msg.toLowerCase().includes('duplicate')) {
            return res.status(409).json({ error: 'That slug is already used by another post. Choose a different slug.' });
        }
        res.status(500).json({ error: e.message || 'Update failed' });
    }
});

app.delete('/api/admin/blog-posts/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
        await db.delete(blogPosts).where(eq(blogPosts.id, id));
        broadcastSync('all');
        res.json({ message: 'Deleted' });
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e.message || 'Delete failed' });
    }
});

// Seasonal Promotions
app.get('/api/promotions/active', async (_req, res) => {
    try {
        const now = new Date().toISOString().slice(0, 10);
        const rows = await db.select().from(promotions).where(
            and(
                eq(promotions.active, true),
                lte(promotions.startDate, now),
                gte(promotions.endDate, now),
            )
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch promotions' });
    }
});

app.get('/api/admin/promotions', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const rows = await db.select().from(promotions).orderBy(desc(promotions.createdAt));
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch promotions' });
    }
});

app.post('/api/admin/promotions', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const { title, description, bannerText, discountCode, discountPercent, startDate, endDate, showOnHomepage, showOnBooking } = req.body;
        if (!title || !startDate || !endDate) return res.status(400).json({ error: 'Title, start date, and end date are required' });
        const inserted = await db.insert(promotions).values({
            title, description: description || null, bannerText: bannerText || null,
            discountCode: discountCode || null, discountPercent: discountPercent || null,
            startDate, endDate,
            showOnHomepage: showOnHomepage !== false,
            showOnBooking: showOnBooking !== false,
        }).$returningId();
        res.json({ id: inserted[0]?.id, message: 'Promotion created' });
    } catch (error) {
        console.error('Create promotion error:', error);
        res.status(500).json({ error: 'Failed to create promotion' });
    }
});

app.patch('/api/admin/promotions/:id', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });
        const updates: Record<string, unknown> = {};
        const allowed = ['title', 'description', 'bannerText', 'discountCode', 'discountPercent', 'startDate', 'endDate', 'active', 'showOnHomepage', 'showOnBooking'];
        for (const key of allowed) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }
        if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updates provided' });
        await db.update(promotions).set(updates as any).where(eq(promotions.id, id));
        res.json({ message: 'Promotion updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update promotion' });
    }
});

app.delete('/api/admin/promotions/:id', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });
        await db.delete(promotions).where(eq(promotions.id, id));
        res.json({ message: 'Promotion deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete promotion' });
    }
});

// Business Settings
app.get('/api/business-settings', async (req, res) => {
    try {
        const settings = await db.select().from(businessSettings);
        const privateKeys = new Set<string>(BREVO_PRIVATE_KEYS as readonly string[]);
        const settingsMap = settings.reduce((acc, curr) => {
            if (privateKeys.has(curr.key)) return acc; // never expose credentials publicly
            const raw = curr.value;
            if (raw && (raw.startsWith('{') || raw.startsWith('['))) {
                try {
                    return { ...acc, [curr.key]: JSON.parse(raw) };
                } catch {
                    return { ...acc, [curr.key]: raw };
                }
            }
            return { ...acc, [curr.key]: raw };
        }, {});
        res.json(settingsMap);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// --- Brevo credentials (admin-only) --------------------------------------
app.get('/api/admin/brevo-settings', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        res.json(getPublicBrevoConfig());
    } catch (error) {
        console.error('[brevo] read failed', error);
        res.status(500).json({ error: 'Failed to load Brevo settings' });
    }
});

app.put('/api/admin/brevo-settings', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const body = (req.body || {}) as Record<string, unknown>;
        const patch: Record<string, string> = {};
        const allowed = [
            'apiKey',
            'senderEmail',
            'senderName',
            'smsSender',
            'smtpHost',
            'smtpPort',
            'smtpUser',
            'smtpPassword',
        ] as const;
        for (const key of allowed) {
            if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
            const raw = body[key];
            if (raw === null) {
                patch[key] = '';
                continue;
            }
            if (typeof raw !== 'string') continue;
            const trimmed = raw.trim();
            // Masked placeholders from the UI (e.g. "abcd••••zz") should be ignored
            if ((key === 'apiKey' || key === 'smtpPassword') && trimmed.includes('•')) continue;
            patch[key] = trimmed;
        }
        if (body.senderEmail != null && typeof body.senderEmail === 'string' && body.senderEmail.trim()) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.senderEmail.trim())) {
                return res.status(400).json({ error: 'Sender email looks invalid.' });
            }
        }
        await persistBrevoConfig(db, patch as any);
        broadcastSync('all');
        res.json({ ok: true, settings: getPublicBrevoConfig() });
    } catch (error) {
        console.error('[brevo] update failed', error);
        res.status(500).json({ error: 'Failed to save Brevo settings' });
    }
});

app.delete('/api/admin/brevo-settings', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        await clearBrevoConfig(db);
        res.json({ ok: true, settings: getPublicBrevoConfig() });
    } catch (error) {
        console.error('[brevo] clear failed', error);
        res.status(500).json({ error: 'Failed to clear Brevo settings' });
    }
});

app.post('/api/admin/brevo-settings/test', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const cfg = getBrevoConfig();
        if (!cfg.apiKey) {
            return res.status(400).json({ error: 'Save a Brevo API key first.' });
        }
        const target = String(req.body?.to || req.user.email || '').trim();
        if (!target || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
            return res.status(400).json({ error: 'A valid recipient email is required.' });
        }
        const brand = cfg.senderName || 'CiN Cleaning';
        await sendEmail({
            to: [{ email: target, name: 'Admin' }],
            subject: `${brand} — Brevo connection test`,
            htmlContent: `<div style="font-family:system-ui,sans-serif;padding:24px;color:#0f172a">
                <h2 style="margin:0 0 12px;">Brevo connection looks good</h2>
                <p>This is a test email sent from the admin portal. If you received this, your Brevo API key and sender are configured correctly.</p>
                <p style="color:#64748b;font-size:12px;margin-top:24px;">Sender: ${cfg.senderName || '—'} &lt;${cfg.senderEmail || '—'}&gt;</p>
            </div>`,
        });
        res.json({ ok: true, to: target });
    } catch (error: any) {
        console.error('[brevo] test failed', error);
        res.status(500).json({ error: error?.message || 'Brevo test email failed.' });
    }
});

/** Settings baked into the frontend's pre-rendered pages at build time. */
const PRERENDERED_SETTING_KEYS = new Set(['seo_settings', 'websiteContent']);
let frontendRebuildTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced Vercel Deploy Hook call so pre-rendered SEO/content picks up admin edits (no-op if not configured). */
function triggerFrontendRebuild(): void {
    const hook = String(process.env.VERCEL_DEPLOY_HOOK_URL || '').trim();
    if (!hook) return;
    if (frontendRebuildTimer) clearTimeout(frontendRebuildTimer);
    frontendRebuildTimer = setTimeout(() => {
        frontendRebuildTimer = null;
        fetch(hook, { method: 'POST' })
            .then((r) => console.log('[frontend rebuild] deploy hook', r.status))
            .catch((e) => console.warn('[frontend rebuild] deploy hook failed', e));
    }, 60_000);
}

app.post('/api/business-settings', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const settings = req.body; // { key: value, key2: value2 }
        const promises = Object.entries(settings).map(([key, value]) => {
            const normalized = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
            return db.insert(businessSettings).values({ key, value: normalized })
                .onDuplicateKeyUpdate({ set: { value: normalized } });
        });
        await Promise.all(promises);
        broadcastSync('all');
        if (Object.keys(settings).some((k) => PRERENDERED_SETTING_KEYS.has(k))) triggerFrontendRebuild();
        res.json({ message: 'Settings updated' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

app.get('/api/bookings/:id/chat', authenticateToken, async (req: any, res) => {
    try {
        const b = await selectBookingByRouteParam(req.params.id);
        if (!b) return res.status(404).json({ error: 'Booking not found' });
        const numericId = Number(b.id);
        const assignments = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, numericId));
        const hasAssignedStaff = Boolean(b.assignedStaffId) || assignments.length > 0;

        if (req.user.role === 'customer') {
            const userEmail = String(req.user.email || '').trim().toLowerCase();
            const bookingEmail = String(b.contactEmail || '').trim().toLowerCase();
            const ownsBooking = b.customerId === req.user.id || (userEmail && bookingEmail && userEmail === bookingEmail);
            if (!ownsBooking) return res.status(403).json({ error: 'Unauthorized' });
        }

        if (req.user.role === 'staff') {
            const staffProfile = await db.select().from(staff).where(eq(staff.userId, req.user.id)).limit(1);
            if (!staffProfile.length) return res.status(403).json({ error: 'Unauthorized' });
            const sid = staffProfile[0].id;
            const isLegacyAssigned = b.assignedStaffId === sid;
            const assigned = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, numericId));
            const isMultiAssigned = assigned.some((a) => a.staffId === sid);
            if (!isLegacyAssigned && !isMultiAssigned) return res.status(403).json({ error: 'Unauthorized' });
        }

        const messages = await db
            .select()
            .from(bookingMessages)
            .where(eq(bookingMessages.bookingId, numericId))
            .orderBy(bookingMessages.createdAt);

        const mapped = messages.map((m) => ({
            id: String(m.id),
            senderId: String(m.senderId || ''),
            senderName: m.senderName,
            senderRole: m.senderRole,
            text: m.text,
            timestamp: m.createdAt,
        }));

        res.json({
            messages: mapped,
            chatClosedByAdmin: Boolean((b as any).chatClosedByAdmin),
            canChatNow: isChatOpenForBooking(b, hasAssignedStaff),
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch chat' });
    }
});

/** In-app bell + WebSocket: notify everyone except the sender (customer, assigned staff, admin inbox). */
async function notifyBookingChatRecipients(
    numericBookingId: number,
    displayBookingId: string,
    b: (typeof bookings.$inferSelect),
    senderId: number,
    senderRole: string,
    senderName: string,
    rawText: string,
) {
    const trimmed = rawText.trim();
    const preview = trimmed.slice(0, 160);
    const line = `Chat · ${displayBookingId}: ${senderName} — ${preview}${trimmed.length > 160 ? '…' : ''}`;
    const targets = new Set<number>();

    if (b.customerId && senderRole !== 'customer') {
        targets.add(Number(b.customerId));
    }

    const staffPkIds: number[] = [];
    const assignment = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, numericBookingId));
    for (const a of assignment) staffPkIds.push(Number(a.staffId));
    if (b.assignedStaffId) staffPkIds.push(Number(b.assignedStaffId));
    const uniqueStaffPks = [...new Set(staffPkIds)];

    if (uniqueStaffPks.length > 0) {
        const stRows = await db.select().from(staff).where(inArray(staff.id, uniqueStaffPks));
        for (const st of stRows) {
            const uid = Number(st.userId);
            if (!uid) continue;
            if (senderRole === 'staff' && uid === senderId) continue;
            targets.add(uid);
        }
    }

    if (senderRole === 'customer' || senderRole === 'staff') {
        targets.add(1);
        const adminUsers = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
        for (const u of adminUsers) targets.add(Number(u.id));
    }

    targets.delete(senderId);

    if (targets.size === 0) return;

    await db.insert(notifications).values(
        [...targets].map((userId) => ({
            userId,
            type: 'chat_message',
            message: line,
            isRead: false,
        })),
    );
}

app.post('/api/bookings/:id/chat', authenticateToken, async (req: any, res) => {
    try {
        const { text } = req.body || {};
        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'Message text is required' });
        }

        const b = await selectBookingByRouteParam(req.params.id);
        if (!b) return res.status(404).json({ error: 'Booking not found' });
        const numericId = Number(b.id);
        const displayRef = String(b.bookingId ?? numericId);
        const assignments = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, numericId));
        const hasAssignedStaff = Boolean(b.assignedStaffId) || assignments.length > 0;
        if (Boolean((b as any).chatClosedByAdmin)) {
            return res.status(403).json({ error: 'Chat has been closed by admin for this booking.' });
        }
        if (req.user.role !== 'admin' && !isChatOpenForBooking(b, hasAssignedStaff)) {
            return res.status(403).json({ error: 'Chat opens 10 minutes before start time once staff is assigned.' });
        }

        if (req.user.role === 'customer') {
            const userEmail = String(req.user.email || '').trim().toLowerCase();
            const bookingEmail = String(b.contactEmail || '').trim().toLowerCase();
            const ownsBooking = b.customerId === req.user.id || (userEmail && bookingEmail && userEmail === bookingEmail);
            if (!ownsBooking) return res.status(403).json({ error: 'Unauthorized' });
        }

        if (req.user.role === 'staff') {
            const staffProfile = await db.select().from(staff).where(eq(staff.userId, req.user.id)).limit(1);
            if (!staffProfile.length) return res.status(403).json({ error: 'Unauthorized' });
            const sid = staffProfile[0].id;
            const isLegacyAssigned = b.assignedStaffId === sid;
            const assigned = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, numericId));
            const isMultiAssigned = assigned.some((a) => a.staffId === sid);
            if (!isLegacyAssigned && !isMultiAssigned) return res.status(403).json({ error: 'Unauthorized' });
        }

        let senderName = req.user.email || req.user.role;
        if (req.user.role === 'admin') {
            const adminRec = await db.select().from(superadmins).where(eq(superadmins.id, req.user.id)).limit(1);
            if (adminRec.length) senderName = adminRec[0].name;
        } else {
            const userRec = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
            if (userRec.length) senderName = userRec[0].name;
        }

        await db.insert(bookingMessages).values({
            bookingId: numericId,
            senderId: req.user.id,
            senderRole: req.user.role,
            senderName,
            text: text.trim(),
        });

        try {
            await notifyBookingChatRecipients(numericId, displayRef, b, req.user.id, req.user.role, senderName, text.trim());
        } catch (e) {
            console.warn('Chat notification insert failed:', e);
        }

        broadcastSync('notifications');
        broadcastSync('all');
        res.status(201).json({ message: 'Chat message sent' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send chat message' });
    }
});

app.get('/api/admin/chat-summaries', authenticateToken, async (req: any, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        const [rows] = await poolConnection.query<RowDataPacket[]>(`
            SELECT
                b.id AS booking_id,
                COALESCE(b.chat_closed_by_admin, 0) AS chat_closed,
                (SELECT COUNT(*) FROM booking_messages m WHERE m.booking_id = b.id) AS msg_count,
                (SELECT m.sender_role FROM booking_messages m WHERE m.booking_id = b.id ORDER BY m.created_at DESC LIMIT 1) AS last_sender_role,
                (SELECT m.created_at FROM booking_messages m WHERE m.booking_id = b.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
            FROM bookings b
            WHERE b.status IN ('Pending','Confirmed','Completed')
        `);
        const list = (rows || []).map((r) => ({
            bookingId: String(r.booking_id ?? ''),
            chatClosed: Boolean(r.chat_closed),
            msgCount: Number(r.msg_count) || 0,
            lastSenderRole: r.last_sender_role ? String(r.last_sender_role) : null,
            lastMessageAt: r.last_message_at
                ? new Date(r.last_message_at as Date).toISOString()
                : null,
        }));
        res.json(list);
    } catch (e) {
        console.error('chat-summaries', e);
        res.status(500).json({ error: 'Failed to load chat summaries' });
    }
});

app.post('/api/bookings/:id/chat/close', authenticateToken, async (req: any, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        const bookingRow = await selectBookingByRouteParam(req.params.id);
        if (!bookingRow) return res.status(404).json({ error: 'Booking not found' });
        const numericId = Number(bookingRow.id);
        if (bookingRow.status === 'Cancelled') {
            return res.status(400).json({ error: 'Cannot manage chat for cancelled bookings.' });
        }

        await db
            .update(bookings)
            .set({ chatClosedByAdmin: true, chatClosedAt: new Date() })
            .where(eq(bookings.id, numericId));
        broadcastSync('all');
        res.json({ message: 'Chat closed by admin' });
    } catch {
        res.status(500).json({ error: 'Failed to close chat' });
    }
});

app.post('/api/bookings/:id/chat/reopen', authenticateToken, async (req: any, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        const bookingRow = await selectBookingByRouteParam(req.params.id);
        if (!bookingRow) return res.status(404).json({ error: 'Booking not found' });
        const numericId = Number(bookingRow.id);
        if (bookingRow.status === 'Cancelled') {
            return res.status(400).json({ error: 'Cannot manage chat for cancelled bookings.' });
        }

        await db
            .update(bookings)
            .set({ chatClosedByAdmin: false, chatClosedAt: null })
            .where(eq(bookings.id, numericId));
        broadcastSync('all');
        res.json({ message: 'Chat reopened by admin' });
    } catch {
        res.status(500).json({ error: 'Failed to reopen chat' });
    }
});

// Theme Settings (Shortcut to only get/set theme_* keys)
app.get('/api/theme', async (req, res) => {
    try {
        const settings = await db.select().from(businessSettings).where(sql`key LIKE 'theme_%'`);
        const settingsMap = settings.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});
        res.json(settingsMap);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch theme settings' });
    }
});

app.post('/api/theme', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const settings = req.body; // { theme_primary: '#...', theme_bg: '#...' }
        const promises = Object.entries(settings).map(([key, value]) => {
            if (!key.startsWith('theme_')) return Promise.resolve();
            return db.insert(businessSettings).values({ key, value: String(value) })
                .onDuplicateKeyUpdate({ set: { value: String(value) } });
        });
        await Promise.all(promises);
        res.json({ message: 'Theme updated' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to update theme' });
    }
});

// Email & SMS templates (seeded defaults; editable in Admin → Settings → Email & SMS)
app.get('/api/email-templates', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        await ensureMessageTemplatesSeededOnce(db);
        const templates = await db.select().from(emailTemplates);
        res.json(templates);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch templates' });
    }
});

app.put('/api/email-templates/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const id = parseInt(req.params.id, 10);
        const { subject, body, active, description } = req.body || {};
        const patch: Record<string, unknown> = {};
        if (subject !== undefined) patch.subject = String(subject);
        if (body !== undefined) patch.body = String(body);
        if (active !== undefined) patch.active = Boolean(active);
        if (description !== undefined) patch.description = String(description);
        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }
        await db.update(emailTemplates).set(patch as any).where(eq(emailTemplates.id, id));
        res.json({ message: 'Template updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update template' });
    }
});

app.get('/api/sms-templates', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'staff') {
        return res.status(403).json({ error: 'Admin or staff only' });
    }
    try {
        await ensureMessageTemplatesSeededOnce(db);
        const rows = await db.select().from(smsTemplates);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch SMS templates' });
    }
});

app.put('/api/sms-templates/:id', authenticateToken, async (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const id = parseInt(req.params.id, 10);
        const { message, active, description } = req.body || {};
        const patch: Record<string, unknown> = {};
        if (message !== undefined) patch.message = String(message);
        if (active !== undefined) patch.active = Boolean(active);
        if (description !== undefined) patch.description = String(description);
        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }
        await db.update(smsTemplates).set(patch as any).where(eq(smsTemplates.id, id));
        res.json({ message: 'SMS template updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update SMS template' });
    }
});

app.patch('/api/bookings/:id/complete', authenticateToken, async (req: any, res) => {
    try {
        if (req.user.role !== 'staff') {
            return res.status(403).json({ error: 'Only staff can submit a job completion with clock-out.' });
        }
        const staffUserId = Number(req.user.id);
        if (!Number.isFinite(staffUserId) || staffUserId <= 0) {
            return res.status(401).json({ error: 'Invalid staff session.' });
        }

        const booking = await selectBookingByRouteParam(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Booking not found' });
        const numericBookingId = Number(booking.id);

        const staffRows = await db.select().from(staff).where(eq(staff.userId, staffUserId)).limit(1);
        if (!staffRows.length) return res.status(403).json({ error: 'Staff profile not found' });
        const staffProfile = staffRows[0];

        const links = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, numericBookingId));
        const assignedToStaff =
            booking.assignedStaffId === staffProfile.id || links.some((x) => x.staffId === staffProfile.id);
        if (!assignedToStaff) {
            return res.status(403).json({ error: 'You can only complete jobs assigned to you.' });
        }

        if (String(booking.status) === 'Cancelled') {
            return res.status(400).json({ error: 'Cannot complete a cancelled booking.' });
        }

        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
        const clockInTime = typeof body.clockInTime === 'string' ? body.clockInTime.trim() : '';
        const clockInAtIso = typeof body.clockInAtIso === 'string' ? body.clockInAtIso.trim() : '';
        const clockOutTime = typeof body.clockOutTime === 'string' ? body.clockOutTime.trim() : '';
        const clockOutAtIso = typeof body.clockOutAtIso === 'string' ? body.clockOutAtIso.trim() : '';

        if (!clockInTime) {
            return res.status(400).json({ error: 'clockInTime is required.' });
        }
        if (!clockInAtIso || !Number.isFinite(Date.parse(clockInAtIso))) {
            return res.status(400).json({ error: 'clockInAtIso must be a valid ISO timestamp from staff clock-in.' });
        }
        if (!clockOutTime) {
            return res.status(400).json({ error: 'clockOutTime is required (staff clock-out).' });
        }
        if (!clockOutAtIso || !Number.isFinite(Date.parse(clockOutAtIso))) {
            return res.status(400).json({ error: 'clockOutAtIso must be a valid ISO timestamp from staff clock-out.' });
        }

        const completionData = {
            ...body,
            clockInTime,
            clockInAtIso,
            clockOutTime,
            clockOutAtIso,
            submittedByStaffUserId: staffUserId,
            submittedByStaffProfileId: Number(staffProfile.id),
        };

        await db.update(bookings)
            .set({
                status: 'Completed',
                workCompletion: completionData
            })
            .where(eq(bookings.id, numericBookingId));

        const updatedBooking = await db.select().from(bookings).where(eq(bookings.id, numericBookingId));

        const b = updatedBooking[0];
        if (!b) return res.status(404).json({ error: 'Booking not found' });

        // Award Loyalty Points
        if (b.customerId && (b.pointsEarned ?? 0) > 0) {
            const cust = await db.select().from(users).where(eq(users.id, b.customerId));
            const currentPoints = cust[0]?.loyaltyPoints || 0;
            await db.update(users).set({ loyaltyPoints: currentPoints + (b.pointsEarned ?? 0) }).where(eq(users.id, b.customerId));

            await db.insert(notifications).values({
                userId: b.customerId,
                type: 'promo',
                message: `🎉 You've earned ${b.pointsEarned} loyalty points!`,
                isRead: false
            });
        }

        broadcastSync('all');
        res.json(b);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to complete booking' });
    }
});

// Notifications
app.get('/api/notifications', authenticateToken, async (req: any, res) => {
    try {
        const userId = req.user.id;
        if (!userId) return res.json([]);

        let userNotifications;
        if (req.user.role === 'admin') {
            const adminIds = await getAdminUserIds();
            if (!adminIds.length) return res.json([]);
            userNotifications = await db
                .select()
                .from(notifications)
                .where(inArray(notifications.userId, adminIds))
                .orderBy(desc(notifications.createdAt));
        } else {
            userNotifications = await db
                .select()
                .from(notifications)
                .where(eq(notifications.userId, userId))
                .orderBy(desc(notifications.createdAt));
        }

        res.json(userNotifications);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

app.post('/api/notifications/:id/read', authenticateToken, async (req: any, res) => {
    try {
        const nid = parseInt(req.params.id, 10);
        if (!Number.isFinite(nid)) return res.status(400).json({ error: 'Invalid notification id' });
        if (req.user.role === 'admin') {
            const adminIds = await getAdminUserIds();
            if (!adminIds.length) return res.status(403).json({ error: 'No admin recipients found' });
            await db
                .update(notifications)
                .set({ isRead: true })
                .where(and(eq(notifications.id, nid), inArray(notifications.userId, adminIds)));
        } else {
            await db
                .update(notifications)
                .set({ isRead: true })
                .where(and(eq(notifications.id, nid), eq(notifications.userId, req.user.id)));
        }
        broadcastSync('notifications');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark read' });
    }
});

app.delete('/api/notifications/:id', authenticateToken, async (req: any, res) => {
    try {
        const notificationId = parseInt(req.params.id, 10);
        if (!Number.isFinite(notificationId)) {
            return res.status(400).json({ error: 'Invalid notification id' });
        }
        if (req.user.role === 'admin') {
            const adminIds = await getAdminUserIds();
            if (!adminIds.length) return res.status(403).json({ error: 'No admin recipients found' });
            await db
                .delete(notifications)
                .where(and(eq(notifications.id, notificationId), inArray(notifications.userId, adminIds)));
        } else {
            await db
                .delete(notifications)
                .where(and(eq(notifications.id, notificationId), eq(notifications.userId, req.user.id)));
        }
        broadcastSync('notifications');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

// Admin Broadcast
app.post('/api/admin/broadcast/email-image', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const dataUrl = String(req.body?.dataUrl || '').trim();
        const parsed = parseDataUrlImage(dataUrl);
        if (!parsed) {
            return res.status(400).json({
                error:
                    'Use a PNG, JPEG, GIF, or WebP under 2.5MB. (HEIC and other formats are not supported — export as JPEG first.)',
            });
        }
        fs.mkdirSync(BROADCAST_EMAIL_UPLOAD_DIR, { recursive: true });
        const fileName = `bcast-${Date.now()}-${randomBytes(8).toString('hex')}.${parsed.ext}`;
        const diskPath = path.join(BROADCAST_EMAIL_UPLOAD_DIR, fileName);
        fs.writeFileSync(diskPath, parsed.buffer);
        const publicPath = `/uploads/broadcast-email/${fileName}`;
        const absoluteUrl = `${publicBaseUrlFromRequest(req)}${publicPath}`;
        res.json({ path: publicPath, url: absoluteUrl });
    } catch (e) {
        console.error('broadcast email-image', e);
        res.status(500).json({ error: 'Failed to save image' });
    }
});

app.post('/api/admin/broadcast/email', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const { subject, body, content, audience, recipientType, specificEmails } = req.body;
        // `content` / `recipientType` / `specificEmails` are the Communication Center's contract;
        // `body` / `audience` are the segment-targeted one. Both are supported.
        const messageBody = body ?? content;
        if (!subject || !messageBody) return res.status(400).json({ error: 'Subject and body are required' });

        const segment = String(
            audience ?? (recipientType === 'all_users' ? 'all' : recipientType ?? 'all'),
        );

        // audience: 'all' | 'customers' | 'staff' | 'inactive' (no booking in 30+ days) | 'specific'
        let recipients: Array<{ email: string; name: string; id: number }> = [];

        if (segment === 'specific') {
            const list = Array.isArray(specificEmails) ? specificEmails : [];
            const wanted = list
                .map((e: unknown) => String(e || '').trim().toLowerCase())
                .filter((e: string) => isPlausibleEmail(e));
            if (wanted.length === 0) {
                return res.status(400).json({ error: 'Add at least one valid email address.' });
            }
            const known = await db
                .select({ id: users.id, email: users.email, name: users.name })
                .from(users)
                .where(inArray(sql`LOWER(TRIM(${users.email}))`, wanted));
            const byEmail = new Map(known.map((u) => [String(u.email || '').toLowerCase(), u]));
            recipients = wanted.map((email: string) => {
                const match = byEmail.get(email);
                return { email, name: match?.name || 'there', id: match?.id ?? 0 };
            });
        } else if (segment === 'inactive') {
            const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
            const allCustomers = await db.select({ id: users.id, email: users.email, name: users.name })
                .from(users)
                .where(sql`LOWER(TRIM(${users.role})) = 'customer'`);
            for (const c of allCustomers) {
                if (!c.email) continue;
                const recentBooking = await db.select({ id: bookings.id })
                    .from(bookings)
                    .where(and(eq(bookings.customerId, c.id), gte(bookings.date, thirtyDaysAgo)))
                    .limit(1);
                if (recentBooking.length === 0) {
                    recipients.push({ email: c.email, name: c.name || 'Customer', id: c.id });
                }
            }
        } else {
            const roleFilter = segment === 'staff'
                ? sql`LOWER(TRIM(${users.role})) IN ('staff', 'admin')`
                : segment === 'customers'
                    ? sql`LOWER(TRIM(${users.role})) = 'customer'`
                    : sql`1=1`;
            const allUsers = await db.select({ id: users.id, email: users.email, name: users.name })
                .from(users)
                .where(roleFilter);
            recipients = allUsers.filter(u => u.email).map(u => ({
                email: u.email!, name: u.name || 'User', id: u.id,
            }));
        }

        if (recipients.length === 0) return res.json({ sent: 0, message: 'No matching recipients' });

        const brand = await loadBrandVars(db);
        let sentCount = 0;
        const errors: string[] = [];

        // Send in batches of 10 to avoid rate limits
        for (let i = 0; i < recipients.length; i += 10) {
            const batch = recipients.slice(i, i + 10);
            for (const r of batch) {
                try {
                    const personalizedBody = String(messageBody)
                        .replace(/\{\{client_name\}\}/g, r.name)
                        .replace(/\{\{brand_name\}\}/g, String(brand.brand_name || 'CiN Cleaning'));
                    const html = await wrapHtmlInEmailShell(db, personalizedBody, brand);
                    await sendEmail({
                        to: [{ email: r.email, name: r.name }],
                        subject: subject.replace(/\{\{brand_name\}\}/g, String(brand.brand_name || 'CiN Cleaning')),
                        htmlContent: html,
                    });
                    sentCount += 1;
                } catch (e: any) {
                    errors.push(`${r.email}: ${e.message || 'failed'}`);
                }
            }
        }

        res.json({ sent: sentCount, total: recipients.length, errors: errors.slice(0, 10) });
    } catch (error) {
        console.error('Bulk email error:', error);
        res.status(500).json({ error: 'Failed to send bulk email' });
    }
});

app.post('/api/admin/broadcast/notification', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const { message, recipientType } = req.body;

        let targetUserIds: number[] = [];
        if (recipientType === 'all_users') {
            const all = await db.select().from(users);
            targetUserIds = all.map(u => u.id);
        } else if (recipientType === 'staff') {
            const allStaff = await db.select().from(staff);
            // Assuming staff table has userId or we join. 
            // Simplification: fetch users where role='staff' or similar
            const staffUsers = await db.select().from(users).where(eq(users.role, 'staff')); // Adjust based on schema
            targetUserIds = staffUsers.map(u => u.id);
        }

        if (targetUserIds.length > 0) {
            await db.insert(notifications).values(
                targetUserIds.map(uid => ({
                    userId: uid,
                    type: 'system',
                    message,
                    isRead: false
                }))
            );
        }

        broadcastSync('notifications');
        res.json({ message: 'Notifications broadcasted' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to broadcast notification' });
    }
});

// Forgot Password
app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        const normalizedEmail = String(email || '').trim().toLowerCase();
        if (!normalizedEmail) return res.status(400).json({ message: 'Email is required' });

        const userRecord = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
        const superadminRecord = await db.select().from(superadmins).where(eq(superadmins.email, normalizedEmail)).limit(1);

        const target = userRecord[0] || superadminRecord[0];
        if (!target) {
            // Best practice: don't reveal if email exists, but return 200 for security
            return res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
        }

        const token = randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 3600000); // 1 hour

        if (userRecord[0]) {
            await db.update(users).set({ resetToken: token, resetTokenExpiry: expiry }).where(eq(users.id, userRecord[0].id));
        } else {
            await db.update(superadmins).set({ resetToken: token, resetTokenExpiry: expiry }).where(eq(superadmins.id, superadminRecord[0].id));
        }

        // Never trust an arbitrary Origin header here: it would let a caller point the emailed token at their own site.
        const requestOrigin = String(req.headers.origin || '').replace(/\/$/, '');
        const origin =
            PUBLIC_SITE_URL ||
            (requestOrigin && corsOrigins.includes(requestOrigin) ? requestOrigin : 'http://localhost:5173');
        const resetLink = `${origin}/reset-password?token=${token}`;

        const brand = await loadBrandVars(db);
        const html = await wrapHtmlInEmailShell(db, `
            <h2 style="color: #4f46e5;">Password Reset Request</h2>
            <p>Hello ${target.name},</p>
            <p>We received a request to reset your password for your ${brand.company_name || 'CiN Cleaning'} account. Click the button below to set a new password:</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${resetLink}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Reset Password</a>
            </div>
            <p>This link will expire in 1 hour. If you did not request this, please ignore this email.</p>
            <p style="font-size: 12px; color: #666; margin-top: 30px;">If the button doesn't work, copy and paste this link: <br> ${resetLink}</p>
        `, brand);

        await sendEmail({
            to: [{ email: normalizedEmail, name: target.name }],
            subject: 'Reset your password',
            htmlContent: html
        });

        res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
    } catch (error: any) {
        console.error('Forgot password error:', error);
        res.status(500).json({ message: 'Failed to process password reset request' });
    }
});

app.post('/api/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) return res.status(400).json({ message: 'Token and new password are required' });

        const userWithToken = await db.select().from(users).where(eq(users.resetToken, token)).limit(1);
        const adminWithToken = await db.select().from(superadmins).where(eq(superadmins.resetToken, token)).limit(1);

        const target = userWithToken[0] || adminWithToken[0];
        const isUser = !!userWithToken[0];

        if (!target || !target.resetTokenExpiry || target.resetTokenExpiry < new Date()) {
            return res.status(400).json({ message: 'Invalid or expired reset token' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        if (isUser) {
            await db.update(users).set({
                passwordHash: hashedPassword,
                resetToken: null,
                resetTokenExpiry: null
            }).where(eq(users.id, target.id));
        } else {
            await db.update(superadmins).set({
                passwordHash: hashedPassword,
                resetToken: null,
                resetTokenExpiry: null
            }).where(eq(superadmins.id, target.id));
        }

        res.json({ message: 'Password reset successful. You can now log in.' });
    } catch (error: any) {
        console.error('Reset password error:', error);
        res.status(500).json({ message: 'Failed to reset password' });
    }
});



// ─── Dynamic Sitemap, Robots, and XSL Stylesheet ───

const SITEMAP_STATIC_PATHS: { path: string; priority: string; changefreq: string }[] = [
    { path: '/', priority: '1.0', changefreq: 'daily' },
    { path: '/residential-cleaning', priority: '0.9', changefreq: 'weekly' },
    { path: '/standard-cleaning', priority: '0.9', changefreq: 'weekly' },
    { path: '/deep-cleaning', priority: '0.9', changefreq: 'weekly' },
    { path: '/end-of-tenancy-cleaning', priority: '0.9', changefreq: 'weekly' },
    { path: '/commercial-cleaning', priority: '0.9', changefreq: 'weekly' },
    { path: '/airbnb-short-let-cleaning', priority: '0.9', changefreq: 'weekly' },
    { path: '/about-us', priority: '0.8', changefreq: 'monthly' },
    { path: '/cleaning-gallery', priority: '0.7', changefreq: 'weekly' },
    { path: '/cleaning-blog', priority: '0.8', changefreq: 'daily' },
    { path: '/cleaning-pricing', priority: '0.8', changefreq: 'monthly' },
    { path: '/contact-us', priority: '0.8', changefreq: 'monthly' },
    { path: '/cleaning-faq', priority: '0.7', changefreq: 'monthly' },
    { path: '/terms-and-conditions', priority: '0.6', changefreq: 'monthly' },
    { path: '/book-cleaning', priority: '0.9', changefreq: 'weekly' },
    ...Object.keys(SERVICE_AREAS).map((slug) => ({
        path: `/cleaning-in-${slug}`,
        priority: '0.8',
        changefreq: 'weekly',
    })),
];

function escXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toW3CDate(d: Date | null | undefined): string {
    if (!d || isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
    return d.toISOString().split('T')[0];
}

app.get('/sitemap.xml', async (req, res) => {
    try {
        // Resolve canonical site URL from SEO settings or request
        let siteUrl = PUBLIC_SITE_URL || `${req.protocol}://${req.get('host')}`;
        try {
            const seoRows = await db.select().from(businessSettings).where(eq(businessSettings.key, 'seo_settings')).limit(1);
            if (seoRows.length && seoRows[0].value) {
                const parsed = JSON.parse(seoRows[0].value);
                if (parsed.siteUrl && String(parsed.siteUrl).trim()) {
                    siteUrl = String(parsed.siteUrl).trim().replace(/\/$/, '');
                }
            }
        } catch { /* use request-based URL */ }

        const today = toW3CDate(new Date());

        // Build static page entries
        const staticEntries = SITEMAP_STATIC_PATHS.map((p) => {
            const loc = p.path === '/' ? `${siteUrl}/` : `${siteUrl}${p.path}`;
            return `  <url>\n    <loc>${escXml(loc)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`;
        });

        // Fetch published blog posts for dynamic entries
        let blogEntries: string[] = [];
        try {
            const posts = await db.select({
                slug: blogPosts.slug,
                publishedAt: blogPosts.publishedAt,
                updatedAt: blogPosts.updatedAt,
            }).from(blogPosts).where(eq(blogPosts.published, true)).orderBy(desc(blogPosts.publishedAt));

            blogEntries = posts.map((post) => {
                const loc = `${siteUrl}/cleaning-blog/${escXml(post.slug)}`;
                const lastmod = toW3CDate(post.updatedAt || post.publishedAt);
                return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`;
            });
        } catch (blogErr) {
            console.error('Sitemap: failed to fetch blog posts:', blogErr);
        }

        const allEntries = [...staticEntries, ...blogEntries].join('\n');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet type="text/xsl" href="/sitemap-style.xsl"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9\n        http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">\n${allEntries}\n</urlset>\n`;

        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
        res.send(xml);
    } catch (err) {
        console.error('Sitemap generation error:', err);
        res.status(500).send('<?xml version="1.0"?><error>Failed to generate sitemap</error>');
    }
});

app.get('/robots.txt', async (_req, res) => {
    try {
        let siteUrl = '';
        try {
            const seoRows = await db.select().from(businessSettings).where(eq(businessSettings.key, 'seo_settings')).limit(1);
            if (seoRows.length && seoRows[0].value) {
                const parsed = JSON.parse(seoRows[0].value);
                if (parsed.siteUrl && String(parsed.siteUrl).trim()) {
                    siteUrl = String(parsed.siteUrl).trim().replace(/\/$/, '');
                }
            }
        } catch { /* ignore */ }
        if (!siteUrl) siteUrl = PUBLIC_SITE_URL || `${_req.protocol}://${_req.get('host')}`;

        const lines = [
            'User-agent: *',
            'Allow: /',
            '',
            '# Private paths',
            'Disallow: /admin',
            'Disallow: /staff',
            'Disallow: /my-account',
            'Disallow: /api/',
            '',
            `Sitemap: ${siteUrl}/sitemap.xml`,
            '',
        ];

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        res.send(lines.join('\n'));
    } catch (err) {
        console.error('robots.txt error:', err);
        res.status(500).send('User-agent: *\nAllow: /\n');
    }
});

app.get('/sitemap-style.xsl', (_req, res) => {
    const xsl = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9">
<xsl:output method="html" indent="yes" encoding="UTF-8"/>
<xsl:template match="/">
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>XML Sitemap</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f172a; color: #e2e8f0; min-height: 100vh;
      padding: 2rem 1rem;
    }
    .container { max-width: 960px; margin: 0 auto; }
    h1 {
      font-size: 1.75rem; font-weight: 800; color: #f8fafc;
      margin-bottom: 0.5rem; letter-spacing: -0.02em;
    }
    .subtitle {
      color: #64748b; font-size: 0.875rem; margin-bottom: 2rem;
      line-height: 1.6;
    }
    .subtitle a { color: #38bdf8; text-decoration: none; }
    .subtitle a:hover { text-decoration: underline; }
    .count {
      display: inline-block; background: #1e293b; color: #38bdf8;
      padding: 0.25rem 0.75rem; border-radius: 9999px;
      font-size: 0.75rem; font-weight: 700; margin-bottom: 1.5rem;
      border: 1px solid #334155;
    }
    table {
      width: 100%; border-collapse: collapse;
      background: #1e293b; border-radius: 1rem; overflow: hidden;
      border: 1px solid #334155;
    }
    th {
      background: #0f172a; color: #94a3b8; font-size: 0.6875rem;
      font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
      padding: 0.875rem 1rem; text-align: left; border-bottom: 1px solid #334155;
    }
    td {
      padding: 0.75rem 1rem; font-size: 0.8125rem;
      border-bottom: 1px solid #1e293b; color: #cbd5e1;
    }
    tr:hover td { background: #334155; }
    td a { color: #38bdf8; text-decoration: none; word-break: break-all; }
    td a:hover { text-decoration: underline; color: #7dd3fc; }
    .priority { font-weight: 700; }
    .priority-high { color: #4ade80; }
    .priority-med { color: #facc15; }
    .priority-low { color: #94a3b8; }
    .footer {
      margin-top: 2rem; text-align: center;
      color: #475569; font-size: 0.75rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>&#x1F5FA; XML Sitemap</h1>
    <p class="subtitle">
      This sitemap is generated dynamically for search engine crawlers.
      You can submit this URL to
      <a href="https://search.google.com/search-console" target="_blank" rel="noopener">Google Search Console</a>.
    </p>
    <span class="count">
      <xsl:value-of select="count(sitemap:urlset/sitemap:url)"/> URLs indexed
    </span>
    <table>
      <tr>
        <th>#</th>
        <th>URL</th>
        <th>Priority</th>
        <th>Change Freq</th>
        <th>Last Modified</th>
      </tr>
      <xsl:for-each select="sitemap:urlset/sitemap:url">
        <xsl:sort select="sitemap:priority" order="descending" data-type="number"/>
        <tr>
          <td><xsl:value-of select="position()"/></td>
          <td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td>
          <td>
            <xsl:attribute name="class">
              priority
              <xsl:choose>
                <xsl:when test="sitemap:priority &gt;= 0.9"> priority-high</xsl:when>
                <xsl:when test="sitemap:priority &gt;= 0.7"> priority-med</xsl:when>
                <xsl:otherwise> priority-low</xsl:otherwise>
              </xsl:choose>
            </xsl:attribute>
            <xsl:value-of select="sitemap:priority"/>
          </td>
          <td><xsl:value-of select="sitemap:changefreq"/></td>
          <td><xsl:value-of select="sitemap:lastmod"/></td>
        </tr>
      </xsl:for-each>
    </table>
    <p class="footer">Auto-generated sitemap &#x2022; Powered by CiN Cleaning</p>
  </div>
</body>
</html>
</xsl:template>
</xsl:stylesheet>`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(xsl);
});

// ── Standalone payment page for customer invoice ──
app.get('/pay/invoice/:id', async (req, res) => {
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || !publishableKey) return res.status(400).send('Invalid request');

    let brandName = 'CiN Cleaning';
    let brandPrimary = '#7c3aed';
    try {
        const vars = await loadBrandVars(db);
        brandName = vars.brand_name || brandName;
        brandPrimary = vars.brand_primary || brandPrimary;
    } catch {}

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay Invoice — ${brandName}</title>
<script src="https://js.stripe.com/v3/"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:480px;width:100%;overflow:hidden}
.header{background:${brandPrimary};color:#fff;padding:24px 28px;text-align:center}
.header h1{font-size:20px;font-weight:800;margin-bottom:4px}
.header p{font-size:14px;opacity:.85}
.body{padding:28px}
.info{display:flex;justify-content:space-between;align-items:center;padding:16px;background:#f1f5f9;border-radius:10px;margin-bottom:20px}
.info .label{font-size:13px;color:#64748b;font-weight:600}
.info .value{font-size:18px;font-weight:800;color:#0f172a}
.items{margin-bottom:20px;font-size:13px}
.items table{width:100%;border-collapse:collapse}
.items th{text-align:left;padding:8px;border-bottom:2px solid #e2e8f0;color:#64748b;font-weight:600;font-size:12px}
.items td{padding:8px;border-bottom:1px solid #f1f5f9}
.items .total-row td{font-weight:700;border-top:2px solid ${brandPrimary};font-size:15px}
#card-element{border:2px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:16px;transition:border-color .2s}
#card-element.StripeElement--focus{border-color:${brandPrimary}}
#card-element.StripeElement--invalid{border-color:#ef4444}
#card-errors{color:#ef4444;font-size:13px;margin-bottom:12px;min-height:20px}
button{width:100%;padding:16px;background:${brandPrimary};color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:opacity .2s}
button:hover{opacity:.9}
button:disabled{opacity:.5;cursor:not-allowed}
.success{text-align:center;padding:40px 28px}
.success .check{width:64px;height:64px;background:#10b981;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
.success .check svg{width:32px;height:32px;color:#fff}
.success h2{font-size:22px;font-weight:800;color:#0f172a;margin-bottom:8px}
.success p{color:#64748b;font-size:14px}
.loading{text-align:center;padding:40px;color:#64748b}
.error-msg{text-align:center;padding:40px;color:#ef4444}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <h1>${brandName}</h1>
    <p>Secure Invoice Payment</p>
  </div>
  <div id="app" class="body"><div class="loading">Loading payment details...</div></div>
</div>
<script>
(async()=>{
  const app=document.getElementById('app');
  try{
    const r=await fetch('/api/pay/invoice/${id}');
    const d=await r.json();
    if(!r.ok){app.innerHTML='<div class="error-msg">'+( d.error||'Unable to load invoice')+'</div>';return}
    if(d.paid){
      app.innerHTML='<div class="success"><div class="check"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></div><h2>Already Paid</h2><p>Invoice '+d.invoiceNumber+' has been paid. Thank you!</p></div>';
      return;
    }
    const items=(d.items||[]);
    const fmtDur=(m)=>{if(!m)return'';const h=Math.floor(m/60),r=m%60;return r?h+'h '+r+'m':h+'h'};
    let itemsHtml=items.map(i=>'<tr><td>'+i.description+'</td><td>'+(i.quantity||1)+'</td>'+(i.duration?'<td>'+fmtDur(i.duration)+'</td>':'')+'<td style="text-align:right">&pound;'+Number(i.lineTotal||0).toFixed(2)+'</td></tr>').join('');
    const hasDur=items.some(i=>i.duration);
    app.innerHTML=
      '<div class="info"><div><div class="label">Invoice</div><div class="value">'+d.invoiceNumber+'</div></div><div><div class="label">Amount Due</div><div class="value">&pound;'+d.total.toFixed(2)+'</div></div></div>'+
      '<div class="items"><table><thead><tr><th>Service</th><th>Qty</th>'+(hasDur?'<th>Duration</th>':'')+'<th style="text-align:right">Total</th></tr></thead><tbody>'+itemsHtml+'<tr class="total-row"><td colspan="'+(hasDur?3:2)+'">Total</td><td style="text-align:right">&pound;'+d.total.toFixed(2)+'</td></tr></tbody></table></div>'+
      '<form id="payment-form"><div id="card-element"></div><div id="card-errors" role="alert"></div><button type="submit" id="pay-btn">Pay &pound;'+d.total.toFixed(2)+'</button></form>';

    const stripe=Stripe(d.publishableKey);
    const elements=stripe.elements({clientSecret:d.clientSecret,appearance:{theme:'stripe'}});
    const card=elements.create('card',{style:{base:{fontSize:'16px',color:'#0f172a','::placeholder':{color:'#94a3b8'}}}});
    card.mount('#card-element');
    card.on('change',e=>{document.getElementById('card-errors').textContent=e.error?e.error.message:''});

    document.getElementById('payment-form').addEventListener('submit',async(ev)=>{
      ev.preventDefault();
      const btn=document.getElementById('pay-btn');
      btn.disabled=true;btn.textContent='Processing...';
      const{error,paymentIntent}=await stripe.confirmCardPayment(d.clientSecret,{payment_method:{card}});
      if(error){
        document.getElementById('card-errors').textContent=error.message;
        btn.disabled=false;btn.textContent='Pay \\u00a3'+d.total.toFixed(2);
      }else if(paymentIntent.status==='succeeded'){
        app.innerHTML='<div class="success"><div class="check"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></div><h2>Payment Successful</h2><p>Invoice '+d.invoiceNumber+' has been paid. You will receive a confirmation shortly.</p></div>';
      }
    });
  }catch(e){app.innerHTML='<div class="error-msg">Something went wrong. Please try again later.</div>'}
})();
</script>
</body>
</html>`);
});

// ── Standalone payment page for booking deposit ──
app.get('/pay/booking/:id', async (req, res) => {
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || !publishableKey) return res.status(400).send('Invalid request');

    let brandName = 'CiN Cleaning';
    let brandPrimary = '#7c3aed';
    try {
        const vars = await loadBrandVars(db);
        brandName = vars.brand_name || brandName;
        brandPrimary = vars.brand_primary || brandPrimary;
    } catch {}

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay Deposit — ${brandName}</title>
<script src="https://js.stripe.com/v3/"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:480px;width:100%;overflow:hidden}
.header{background:${brandPrimary};color:#fff;padding:24px 28px;text-align:center}
.header h1{font-size:20px;font-weight:800;margin-bottom:4px}
.header p{font-size:14px;opacity:.85}
.body{padding:28px}
.info{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}
.info-card{padding:14px;background:#f1f5f9;border-radius:10px}
.info-card .label{font-size:12px;color:#64748b;font-weight:600;margin-bottom:2px}
.info-card .value{font-size:16px;font-weight:800;color:#0f172a}
.info-card.full{grid-column:1/-1}
.deposit-box{background:#f0fdfa;border:2px solid #99f6e4;border-radius:12px;padding:16px;text-align:center;margin-bottom:20px}
.deposit-box .amount{font-size:28px;font-weight:900;color:#0f172a}
.deposit-box .label{font-size:13px;color:#64748b;margin-top:2px}
#card-element{border:2px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:16px;transition:border-color .2s}
#card-element.StripeElement--focus{border-color:${brandPrimary}}
#card-element.StripeElement--invalid{border-color:#ef4444}
#card-errors{color:#ef4444;font-size:13px;margin-bottom:12px;min-height:20px}
button{width:100%;padding:16px;background:${brandPrimary};color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:opacity .2s}
button:hover{opacity:.9}
button:disabled{opacity:.5;cursor:not-allowed}
.success{text-align:center;padding:40px 28px}
.success .check{width:64px;height:64px;background:#10b981;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
.success .check svg{width:32px;height:32px;color:#fff}
.success h2{font-size:22px;font-weight:800;color:#0f172a;margin-bottom:8px}
.success p{color:#64748b;font-size:14px}
.loading{text-align:center;padding:40px;color:#64748b}
.error-msg{text-align:center;padding:40px;color:#ef4444}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <h1>${brandName}</h1>
    <p>Secure Deposit Payment</p>
  </div>
  <div id="app" class="body"><div class="loading">Loading booking details...</div></div>
</div>
<script>
(async()=>{
  const app=document.getElementById('app');
  try{
    const r=await fetch('/api/pay/booking/${id}');
    const d=await r.json();
    if(!r.ok){app.innerHTML='<div class="error-msg">'+(d.error||'Unable to load booking')+'</div>';return}
    if(d.paid){
      app.innerHTML='<div class="success"><div class="check"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></div><h2>Deposit Paid</h2><p>Booking '+d.bookingRef+' deposit has been received. Thank you!</p></div>';
      return;
    }
    app.innerHTML=
      '<div class="info">'+
        '<div class="info-card"><div class="label">Booking Ref</div><div class="value">#'+d.bookingRef+'</div></div>'+
        '<div class="info-card"><div class="label">Service</div><div class="value">'+d.serviceType+'</div></div>'+
        '<div class="info-card"><div class="label">Date</div><div class="value">'+d.date+'</div></div>'+
        '<div class="info-card"><div class="label">Time</div><div class="value">'+d.time+'</div></div>'+
      '</div>'+
      '<div class="deposit-box"><div class="amount">&pound;'+d.depositAmount.toFixed(2)+'</div><div class="label">Deposit ('+d.depositPercent+'% of &pound;'+d.total.toFixed(2)+' total)</div></div>'+
      '<form id="payment-form"><div id="card-element"></div><div id="card-errors" role="alert"></div><button type="submit" id="pay-btn">Pay Deposit &pound;'+d.depositAmount.toFixed(2)+'</button></form>';

    const stripe=Stripe(d.publishableKey);
    const elements=stripe.elements({clientSecret:d.clientSecret,appearance:{theme:'stripe'}});
    const card=elements.create('card',{style:{base:{fontSize:'16px',color:'#0f172a','::placeholder':{color:'#94a3b8'}}}});
    card.mount('#card-element');
    card.on('change',e=>{document.getElementById('card-errors').textContent=e.error?e.error.message:''});

    document.getElementById('payment-form').addEventListener('submit',async(ev)=>{
      ev.preventDefault();
      const btn=document.getElementById('pay-btn');
      btn.disabled=true;btn.textContent='Processing...';
      const{error,paymentIntent}=await stripe.confirmCardPayment(d.clientSecret,{payment_method:{card}});
      if(error){
        document.getElementById('card-errors').textContent=error.message;
        btn.disabled=false;btn.textContent='Pay Deposit \\u00a3'+d.depositAmount.toFixed(2);
      }else if(paymentIntent.status==='succeeded'){
        app.innerHTML='<div class="success"><div class="check"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></div><h2>Payment Successful</h2><p>Your deposit for booking #'+d.bookingRef+' has been received. You will receive a confirmation shortly.</p></div>';
      }
    });
  }catch(e){app.innerHTML='<div class="error-msg">Something went wrong. Please try again later.</div>'}
})();
</script>
</body>
</html>`);
});

// ─── Push notification token registration (mobile apps) ────────────────
app.post('/api/push/register', authenticateToken, (req: any, res) => {
    const userId = Number(req.user?.id);
    const { token, platform } = req.body || {};
    if (!token || !platform) return res.status(400).json({ error: 'token and platform required' });
    registerPushToken(userId, String(token), String(platform));
    res.json({ ok: true });
});

app.post('/api/push/unregister', authenticateToken, (req: any, res) => {
    const userId = Number(req.user?.id);
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    unregisterPushToken(userId, String(token));
    res.json({ ok: true });
});

// ── Expense tracker routes ──

app.get('/api/expenses', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const rows = await db.select().from(expenses).orderBy(desc(expenses.createdAt));
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch expenses' });
    }
});

app.post('/api/expenses', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const { title, amount, category, purpose, receiptUrl, expenseDate } = req.body;
        if (!title || !amount || !expenseDate) {
            return res.status(400).json({ error: 'Title, amount, and date are required' });
        }
        const [result] = await db.insert(expenses).values({
            title: String(title).trim(),
            amount: String(amount),
            category: String(category || 'general').trim(),
            purpose: purpose ? String(purpose).trim() : null,
            receiptUrl: receiptUrl || null,
            expenseDate: String(expenseDate),
            createdBy: req.user?.id || null,
        });
        res.json({ id: result.insertId, message: 'Expense created' });
    } catch (error) {
        console.error('[expenses] create error:', error);
        res.status(500).json({ error: 'Failed to create expense' });
    }
});

app.put('/api/expenses/:id', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });
        const { title, amount, category, purpose, receiptUrl, expenseDate } = req.body;
        await db.update(expenses).set({
            ...(title !== undefined && { title: String(title).trim() }),
            ...(amount !== undefined && { amount: String(amount) }),
            ...(category !== undefined && { category: String(category).trim() }),
            ...(purpose !== undefined && { purpose: purpose ? String(purpose).trim() : null }),
            ...(receiptUrl !== undefined && { receiptUrl }),
            ...(expenseDate !== undefined && { expenseDate: String(expenseDate) }),
        }).where(eq(expenses.id, id));
        res.json({ message: 'Expense updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update expense' });
    }
});

app.delete('/api/expenses/:id', authenticateToken, async (req: any, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });
        await db.delete(expenses).where(eq(expenses.id, id));
        res.json({ message: 'Expense deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete expense' });
    }
});

// The website itself is hosted separately (Vercel); this server only answers API, payment and sitemap routes.
app.get('/', (_req, res) => {
    res.json({ service: 'CiN Cleaning API', status: 'ok', site: PUBLIC_SITE_URL || null });
});

app.use((req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

/** Always JSON for API failures (avoids generic HTML 500 pages that confuse the SPA). */
app.use((err: unknown, req: any, res: any, next: any) => {
    if (res.headersSent) {
        next(err);
        return;
    }
    const statusFromErr =
        err &&
            typeof err === 'object' &&
            'status' in err &&
            typeof (err as { status: unknown }).status === 'number'
            ? (err as { status: number }).status
            : undefined;
    const isJsonSyntax =
        err instanceof SyntaxError && /json|unexpected token/i.test(String((err as Error).message || ''));
    const status =
        statusFromErr && statusFromErr >= 400 && statusFromErr < 600
            ? statusFromErr
            : isJsonSyntax
                ? 400
                : 500;
    const message =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Internal server error';
    console.error('[API]', req?.method, req?.path, message);
    res.status(status).json({
        error:
            status === 400 && isJsonSyntax ? 'Invalid JSON in request body' : message || 'Internal server error',
    });
});

const server = http.createServer(app);
attachRealtime(server);
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
    try {
        // await db.select().from(services).limit(1);
        // await seedGalleryAndBlogIfEmpty(db);
        // await ensureSuperadminsMirroredToAdminUsers();
        console.log('Database connected successfully');
        // await ensureMessageTemplatesSeededOnce(db);
        await loadBrevoConfigFromDb(db);

        await runColumnMigrations();

        // The first-time-visitor popup advertises FIRST10, so the code must exist.
        try {
            const existing = await db
                .select({ id: discounts.id })
                .from(discounts)
                .where(eq(discounts.code, 'FIRST10'))
                .limit(1);
            if (existing.length === 0) {
                await db.insert(discounts).values({
                    code: 'FIRST10',
                    type: 'percentage',
                    value: '10',
                    minOrderValue: '0',
                    isActive: true,
                });
                console.log('Seeded FIRST10 welcome discount');
            }
        } catch (e: any) {
            console.warn('FIRST10 seed:', e?.message);
        }
    } catch (err) {
        console.error('Database connection failed:', err);
    }

    const port = process.env.PORT || 3002;

    server.listen(port, () => {
        console.log(`API running on port: ${port}`);
    });

    const runTrackingMonitor = async (label: string) => {
        try {
            const t = await runJobTrackingMonitor(db);
            if (t.prompted || t.noEnRoute || t.unassigned) console.log(`[job tracking]${label}`, t);
        } catch (err) {
            console.error(`[job tracking]${label}`, err);
        }
    };
    setInterval(() => void runTrackingMonitor(''), 5 * 60 * 1000);
    setTimeout(() => void runTrackingMonitor(' startup'), 60_000);

    const REMINDER_MS = 15 * 60 * 1000;
    setInterval(() => {
        void (async () => {
            try {
                const r = await runAutomaticBookingReminders(db);
                if (r.sent48 > 0 || r.sent24 > 0) {
                    console.log('[booking reminders]', r);
                }
            } catch (err) {
                console.error('[booking reminders]', err);
            }
            try {
                const rv = await runPostCompletionReviewRequests(db);
                if (rv.sent > 0) {
                    console.log('[review requests]', rv);
                }
            } catch (err) {
                console.error('[review requests]', err);
            }
            try {
                const rc = await runRecurringBookingCreation(db);
                if (rc.created > 0) {
                    console.log('[recurring bookings]', rc);
                }
            } catch (err) {
                console.error('[recurring bookings]', err);
            }
            try {
                const rn = await runRebookingNudges(db);
                if (rn.sent > 0) {
                    console.log('[rebooking nudges]', rn);
                }
            } catch (err) {
                console.error('[rebooking nudges]', err);
            }
        })();
    }, REMINDER_MS);
    setTimeout(() => {
        void (async () => {
            try {
                await runAutomaticBookingReminders(db);
            } catch (err) {
                console.error('[booking reminders] startup', err);
            }
            try {
                await runPostCompletionReviewRequests(db);
            } catch (err) {
                console.error('[review requests] startup', err);
            }
            try {
                const rc = await runRecurringBookingCreation(db);
                if (rc.created > 0) {
                    console.log('[recurring bookings] startup', rc);
                }
            } catch (err) {
                console.error('[recurring bookings] startup', err);
            }
            try {
                const rn = await runRebookingNudges(db);
                if (rn.sent > 0) {
                    console.log('[rebooking nudges] startup', rn);
                }
            } catch (err) {
                console.error('[rebooking nudges] startup', err);
            }
        })();
    }, 45_000);
}

void startServer();
