import type { Express } from 'express';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { bookingMessages, bookingStaff, bookings, notifications, smsTemplates, staff, users } from './schema';
import { broadcastSync } from './realtime';
import { sendTransactionalSms } from './services/sms';
import { sendEmail } from './services/email';
import { interpolateTemplate, wrapHtmlInEmailShell } from './messageTemplates/engine';
import { adminBookingNotifyEmail, loadBrandVars, loadBusinessSettingsMap } from './messageTemplates/brand';
import { sendPushToUsers } from './push';

type BookingRow = typeof bookings.$inferSelect;
type StaffRow = typeof staff.$inferSelect;

/** Assigned staff are prompted to set off this many minutes before start. */
const ON_THE_WAY_PROMPT_MIN = 60;
/** Admin is warned if no assigned cleaner is en route this many minutes before start. */
const NO_EN_ROUTE_WARN_MIN = 30;
/** Admin is warned if a booking is still unassigned this many hours before start. */
const UNASSIGNED_WARN_HOURS = 24;

export type LateNotice = {
    id: string;
    staffId: number;
    staffName: string;
    reason: string;
    etaTime: string | null;
    minutesLate: number | null;
    message: string;
    sentAt: string;
    notified: { client: boolean; admin: boolean };
};

export type CleanerLocation = { lat: number; lng: number; at: string; staffId: number; staffName: string };

function getBookingStartMs(b: Pick<BookingRow, 'date' | 'time'>): number {
    const [year, month, day] = String(b.date || '').split('-').map(Number);
    const [hours, minutes] = String(b.time || '09:00').split(':').map(Number);
    return new Date(year || 1970, (month || 1) - 1, day || 1, hours || 0, minutes || 0).getTime();
}

function localYmd(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function parseLateNotices(raw: unknown): LateNotice[] {
    if (Array.isArray(raw)) return raw as LateNotice[];
    if (typeof raw === 'string') {
        try {
            const j = JSON.parse(raw);
            return Array.isArray(j) ? j : [];
        } catch {
            return [];
        }
    }
    return [];
}

function parseLocation(raw: unknown): CleanerLocation | null {
    let v = raw;
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { return null; }
    }
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const lat = Number(o.lat);
    const lng = Number(o.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
        lat,
        lng,
        at: String(o.at || ''),
        staffId: Number(o.staffId) || 0,
        staffName: String(o.staffName || ''),
    };
}

function readCoords(body: unknown): { lat: number; lng: number } | null {
    const b = (body || {}) as Record<string, unknown>;
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
}

async function getAdminUserIds(db: any): Promise<number[]> {
    const rows = await db.select({ id: users.id }).from(users).where(sql`LOWER(TRIM(${users.role})) = 'admin'`);
    return rows.map((r: { id: number }) => Number(r.id)).filter((id: number) => Number.isFinite(id) && id > 0);
}

async function notifyAdmins(db: any, message: string): Promise<void> {
    const ids = await getAdminUserIds(db);
    if (!ids.length) return;
    await db.insert(notifications).values(ids.map((userId) => ({ userId, type: 'system', message, isRead: false })));
}

async function emailAdmin(db: any, subject: string, innerHtml: string): Promise<void> {
    try {
        const map = await loadBusinessSettingsMap(db);
        const to = adminBookingNotifyEmail(map);
        if (!to) return;
        const brand = await loadBrandVars(db);
        const html = await wrapHtmlInEmailShell(db, innerHtml, brand as Record<string, string>);
        await sendEmail({ to: [{ email: to }], subject, htmlContent: html });
    } catch (e) {
        console.error('[job tracking] admin email failed', e);
    }
}

async function smsWithTemplate(
    db: any,
    templateName: string,
    phone: string | null | undefined,
    vars: Record<string, string>,
    fallback: string,
): Promise<boolean> {
    if (!phone || !String(phone).trim()) return false;
    let msg = fallback;
    try {
        const rows = await db.select().from(smsTemplates).where(eq(smsTemplates.name, templateName)).limit(1);
        if (rows.length && rows[0].active && String(rows[0].message || '').trim()) {
            msg = interpolateTemplate(rows[0].message, vars);
        }
    } catch {
        /* use fallback */
    }
    try {
        await sendTransactionalSms(String(phone).trim(), msg);
        return true;
    } catch (e) {
        console.error('[job tracking] sms failed', templateName, e);
        return false;
    }
}

async function getAssignedStaffRows(db: any, b: BookingRow): Promise<StaffRow[]> {
    const ids = new Set<number>();
    const links = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, Number(b.id)));
    for (const l of links) if (l.staffId != null) ids.add(Number(l.staffId));
    if (b.assignedStaffId != null) ids.add(Number(b.assignedStaffId));
    if (!ids.size) return [];
    return db.select().from(staff).where(inArray(staff.id, [...ids]));
}

/** Resolves the logged-in staff member and confirms they are assigned to the booking. */
async function loadAssignedStaffContext(
    db: any,
    req: any,
    res: any,
): Promise<{ booking: BookingRow; me: StaffRow } | null> {
    if (req.user?.role !== 'staff') {
        res.status(403).json({ error: 'Staff only' });
        return null;
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid booking id' });
        return null;
    }
    const rows = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
    const booking: BookingRow | undefined = rows[0];
    if (!booking) {
        res.status(404).json({ error: 'Booking not found' });
        return null;
    }
    const meRows = await db.select().from(staff).where(eq(staff.userId, Number(req.user.id))).limit(1);
    const me: StaffRow | undefined = meRows[0];
    if (!me) {
        res.status(403).json({ error: 'Staff profile not found' });
        return null;
    }
    const assigned = await getAssignedStaffRows(db, booking);
    if (!assigned.some((s) => Number(s.id) === Number(me.id))) {
        res.status(403).json({ error: 'You are not assigned to this job.' });
        return null;
    }
    const status = String(booking.status || '');
    if (status === 'Cancelled' || status === 'Completed') {
        res.status(400).json({ error: `This job is already ${status.toLowerCase()}.` });
        return null;
    }
    return { booking, me };
}

function trackingView(b: BookingRow) {
    const status = String(b.status || '');
    const live = status !== 'Completed' && status !== 'Cancelled';
    return {
        id: Number(b.id),
        bookingId: b.bookingId,
        status,
        enRouteAt: b.enRouteAt ? new Date(b.enRouteAt as unknown as string).toISOString() : null,
        cleanerLocation: live && b.enRouteAt ? parseLocation(b.cleanerLocation) : null,
        lateNotices: parseLateNotices(b.lateNotices),
    };
}

export function registerJobTrackingRoutes(
    app: Express,
    db: any,
    authenticateToken: (req: any, res: any, next: any) => void,
    requireAdmin: (req: any, res: any) => boolean,
): void {
    app.post('/api/staff/jobs/:id/en-route', authenticateToken, async (req: any, res) => {
        try {
            const ctx = await loadAssignedStaffContext(db, req, res);
            if (!ctx) return;
            const { booking, me } = ctx;
            if (String(booking.date) !== localYmd(new Date())) {
                return res.status(400).json({ error: 'You can only start travel on the day of the job.' });
            }
            const coords = readCoords(req.body);
            const nowIso = new Date().toISOString();
            const firstTime = !booking.enRouteAt;
            const patch: Record<string, unknown> = {};
            if (firstTime) patch.enRouteAt = new Date();
            if (coords) patch.cleanerLocation = { ...coords, at: nowIso, staffId: Number(me.id), staffName: me.name };
            if (Object.keys(patch).length) {
                await db.update(bookings).set(patch).where(eq(bookings.id, Number(booking.id)));
            }

            if (firstTime && req.body?.silent !== true) {
                const ref = String(booking.bookingId ?? booking.id);
                const brand = await loadBrandVars(db);
                const brandName = String(brand.brand_name || 'CiN Cleaning');
                await smsWithTemplate(
                    db,
                    'staff_sms_en_route',
                    booking.contactPhone,
                    { client_name: booking.contactName || 'there', brand_name: brandName, staff_name: me.name },
                    `Hi ${booking.contactName || 'there'}, your ${brandName} cleaner ${me.name} is on the way. You can track them in your client portal.`,
                );
                if (booking.customerId) {
                    const msg = `${me.name} is on the way to your ${booking.serviceType} (booking ${ref}). Track them live in your portal.`;
                    await db.insert(notifications).values({
                        userId: Number(booking.customerId),
                        type: 'booking_update',
                        message: msg,
                        isRead: false,
                    });
                    void sendPushToUsers([Number(booking.customerId)], 'Your cleaner is on the way', msg, { bookingId: Number(booking.id) });
                }
                await notifyAdmins(db, `${me.name} is en route to booking ${ref} (${booking.time}, ${booking.contactName}).`);
                broadcastSync('notifications');
            }
            broadcastSync(firstTime ? 'bookings' : 'location');
            res.json({ enRouteAt: firstTime ? nowIso : booking.enRouteAt });
        } catch (e) {
            console.error('[job tracking] en-route', e);
            res.status(500).json({ error: 'Failed to start travel' });
        }
    });

    app.post('/api/staff/jobs/:id/location', authenticateToken, async (req: any, res) => {
        try {
            const ctx = await loadAssignedStaffContext(db, req, res);
            if (!ctx) return;
            const coords = readCoords(req.body);
            if (!coords) return res.status(400).json({ error: 'Valid lat and lng are required' });
            const loc: CleanerLocation = {
                ...coords,
                at: new Date().toISOString(),
                staffId: Number(ctx.me.id),
                staffName: ctx.me.name,
            };
            await db.update(bookings).set({ cleanerLocation: loc }).where(eq(bookings.id, Number(ctx.booking.id)));
            broadcastSync('location');
            res.json({ ok: true });
        } catch (e) {
            console.error('[job tracking] location', e);
            res.status(500).json({ error: 'Failed to update location' });
        }
    });

    app.post('/api/staff/jobs/:id/running-late', authenticateToken, async (req: any, res) => {
        try {
            const ctx = await loadAssignedStaffContext(db, req, res);
            if (!ctx) return;
            const { booking, me } = ctx;
            const body = (req.body || {}) as Record<string, unknown>;
            const reason = String(body.reason || '').trim().slice(0, 300);
            const note = String(body.note || '').trim().slice(0, 500);
            const etaRaw = String(body.etaTime || '').trim();
            const etaTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(etaRaw) ? etaRaw : null;
            const minsRaw = Number(body.minutesLate);
            const minutesLate = Number.isFinite(minsRaw) && minsRaw > 0 && minsRaw <= 600 ? Math.round(minsRaw) : null;
            const notifyClient = body.notifyClient !== false;
            const notifyAdmin = body.notifyAdmin !== false;

            if (!reason) return res.status(400).json({ error: 'Please give a reason.' });
            if (!etaTime && !minutesLate) return res.status(400).json({ error: 'Please give an arrival time or how many minutes late.' });
            if (!notifyClient && !notifyAdmin) return res.status(400).json({ error: 'Choose at least one recipient.' });

            const brand = await loadBrandVars(db);
            const brandName = String(brand.brand_name || 'CiN Cleaning');
            const ref = String(booking.bookingId ?? booking.id);
            const delayText = minutesLate ? `about ${minutesLate} minutes late` : 'running late';
            const etaText = etaTime ? ` New estimated arrival: ${etaTime}.` : '';
            const clientMessage =
                `Hi ${booking.contactName || 'there'}, ${me.name} from ${brandName} is ${delayText} for your clean today (booked ${booking.time}). ` +
                `Reason: ${reason}.${etaText}${note ? ` ${note}` : ''} Sorry for the inconvenience.`;

            const notice: LateNotice = {
                id: `${Date.now()}-${Number(me.id)}`,
                staffId: Number(me.id),
                staffName: me.name,
                reason,
                etaTime,
                minutesLate,
                message: note,
                sentAt: new Date().toISOString(),
                notified: { client: false, admin: false },
            };

            if (notifyClient) {
                const smsOk = booking.contactPhone
                    ? await sendTransactionalSms(String(booking.contactPhone), clientMessage).then(() => true, (e) => {
                        console.error('[job tracking] late sms failed', e);
                        return false;
                    })
                    : false;
                let emailOk = false;
                if (booking.contactEmail) {
                    try {
                        const html = await wrapHtmlInEmailShell(
                            db,
                            `<p>${escapeHtml(clientMessage)}</p>`,
                            brand as Record<string, string>,
                        );
                        await sendEmail({
                            to: [{ email: booking.contactEmail, name: booking.contactName || 'Guest' }],
                            subject: `Your cleaner is running late (booking ${ref})`,
                            htmlContent: html,
                        });
                        emailOk = true;
                    } catch (e) {
                        console.error('[job tracking] late email failed', e);
                    }
                }
                if (booking.customerId) {
                    await db.insert(notifications).values({
                        userId: Number(booking.customerId),
                        type: 'booking_update',
                        message: clientMessage,
                        isRead: false,
                    });
                    void sendPushToUsers([Number(booking.customerId)], 'Your cleaner is running late', clientMessage, {
                        bookingId: Number(booking.id),
                    });
                }
                await db.insert(bookingMessages).values({
                    bookingId: Number(booking.id),
                    senderId: Number(req.user.id),
                    senderRole: 'staff',
                    senderName: me.name,
                    text: `Running late: ${reason}.${minutesLate ? ` About ${minutesLate} min late.` : ''}${etaText}${note ? ` ${note}` : ''}`,
                });
                notice.notified.client = smsOk || emailOk || Boolean(booking.customerId);
            }

            if (notifyAdmin) {
                await notifyAdmins(
                    db,
                    `LATE: ${me.name} is ${delayText} for booking ${ref} (${booking.time}, ${booking.contactName}). Reason: ${reason}.${etaText}`,
                );
                notice.notified.admin = true;
            }

            const notices = [...parseLateNotices(booking.lateNotices), notice];
            await db.update(bookings).set({ lateNotices: notices }).where(eq(bookings.id, Number(booking.id)));

            broadcastSync('notifications');
            broadcastSync('bookings');
            res.json({ notice });
        } catch (e) {
            console.error('[job tracking] running-late', e);
            res.status(500).json({ error: 'Failed to send running-late notice' });
        }
    });

    app.get('/api/bookings/:id/tracking', authenticateToken, async (req: any, res) => {
        try {
            const id = Number(req.params.id);
            const rows = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
            const b: BookingRow | undefined = rows[0];
            if (!b) return res.status(404).json({ error: 'Booking not found' });
            const role = req.user?.role;
            if (role === 'customer') {
                const email = String(req.user.email || '').trim().toLowerCase();
                const owns = b.customerId === req.user.id || (email && email === String(b.contactEmail || '').trim().toLowerCase());
                if (!owns) return res.status(403).json({ error: 'Unauthorized' });
            } else if (role === 'staff') {
                const meRows = await db.select().from(staff).where(eq(staff.userId, Number(req.user.id))).limit(1);
                const assigned = meRows[0] ? await getAssignedStaffRows(db, b) : [];
                if (!assigned.some((s) => Number(s.id) === Number(meRows[0]?.id))) {
                    return res.status(403).json({ error: 'Unauthorized' });
                }
            } else if (!requireAdmin(req, res)) {
                return;
            }
            res.json(trackingView(b));
        } catch (e) {
            console.error('[job tracking] tracking', e);
            res.status(500).json({ error: 'Failed to load tracking' });
        }
    });

    app.get('/api/admin/live-tracking', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const today = localYmd(new Date());
            const rows: BookingRow[] = await db
                .select()
                .from(bookings)
                .where(and(eq(bookings.date, today), sql`${bookings.status} != 'Cancelled'`));
            res.json(rows.map(trackingView));
        } catch (e) {
            console.error('[job tracking] live-tracking', e);
            res.status(500).json({ error: 'Failed to load live tracking' });
        }
    });

    app.post('/api/admin/jobs/:id/nudge-staff', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const id = Number(req.params.id);
            const rows = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
            const b: BookingRow | undefined = rows[0];
            if (!b) return res.status(404).json({ error: 'Booking not found' });
            const assigned = await getAssignedStaffRows(db, b);
            if (!assigned.length) return res.status(400).json({ error: 'No cleaner is assigned to this booking.' });
            const sent = await promptStaffOnTheWay(db, b, assigned, 'admin');
            await db.update(bookings).set({ onTheWayPromptSentAt: new Date() }).where(eq(bookings.id, id));
            broadcastSync('notifications');
            res.json({ notified: sent });
        } catch (e) {
            console.error('[job tracking] nudge', e);
            res.status(500).json({ error: 'Failed to notify cleaner' });
        }
    });
}

async function promptStaffOnTheWay(db: any, b: BookingRow, assigned: StaffRow[], source: 'auto' | 'admin'): Promise<number> {
    const ref = String(b.bookingId ?? b.id);
    const brand = await loadBrandVars(db);
    const brandName = String(brand.brand_name || 'CiN Cleaning');
    const where = [b.addressLine1, b.addressPostcode].filter(Boolean).join(', ');
    let count = 0;
    for (const s of assigned) {
        const text =
            source === 'admin'
                ? `${brandName}: the office is asking you to head to booking ${ref} at ${b.time} (${where}) now. Open the staff app and tap "Start travel".`
                : `${brandName}: your job ${ref} starts at ${b.time} (${where}). Time to set off. Open the staff app and tap "Start travel".`;
        if (s.userId) {
            await db.insert(notifications).values({ userId: Number(s.userId), type: 'booking_update', message: text, isRead: false });
            void sendPushToUsers([Number(s.userId)], 'Time to head to your job', text, { bookingId: Number(b.id), type: 'job_prompt' });
            count += 1;
        }
        if (s.phone) {
            try {
                await sendTransactionalSms(String(s.phone), text);
            } catch (e) {
                console.error('[job tracking] staff prompt sms failed', s.id, e);
            }
        }
    }
    return count;
}

/** Fields to clear when a booking's schedule or assignment changes, so prompts and warnings fire again. */
export function trackingResetPatch(kind: 'schedule' | 'assignment'): Record<string, null> {
    const base = {
        enRouteAt: null,
        cleanerLocation: null,
        onTheWayPromptSentAt: null,
        noEnRouteWarningSentAt: null,
    };
    return kind === 'schedule' ? { ...base, unassignedWarningSentAt: null } : base;
}

/** Prompts assigned staff to set off, and warns admin about unassigned or not-en-route bookings. */
export async function runJobTrackingMonitor(db: any): Promise<{ prompted: number; noEnRoute: number; unassigned: number }> {
    const now = Date.now();
    const minDate = localYmd(new Date(now - 86400000));
    const maxDate = localYmd(new Date(now + 2 * 86400000));
    const rows: BookingRow[] = await db
        .select()
        .from(bookings)
        .where(and(inArray(bookings.status, ['Pending', 'Confirmed']), gte(bookings.date, minDate), lte(bookings.date, maxDate)));

    let prompted = 0;
    let noEnRoute = 0;
    let unassigned = 0;
    const noEnRouteLines: string[] = [];
    const unassignedLines: string[] = [];

    for (const b of rows) {
        const startMs = getBookingStartMs(b);
        if (!Number.isFinite(startMs)) continue;
        const minutesUntil = (startMs - now) / 60000;
        if (minutesUntil < -120) continue;
        const ref = String(b.bookingId ?? b.id);
        const assigned = await getAssignedStaffRows(db, b);

        if (!assigned.length) {
            if (minutesUntil <= UNASSIGNED_WARN_HOURS * 60 && !b.unassignedWarningSentAt) {
                const line = `Booking ${ref} on ${b.date} at ${b.time} (${b.contactName}, ${b.addressPostcode}) has no cleaner assigned.`;
                await notifyAdmins(db, `WARNING: ${line}`);
                unassignedLines.push(line);
                await db.update(bookings).set({ unassignedWarningSentAt: new Date() }).where(eq(bookings.id, Number(b.id)));
                unassigned += 1;
            }
            continue;
        }

        if (b.enRouteAt) continue;

        if (minutesUntil <= ON_THE_WAY_PROMPT_MIN && minutesUntil > -60 && !b.onTheWayPromptSentAt) {
            await promptStaffOnTheWay(db, b, assigned, 'auto');
            await db.update(bookings).set({ onTheWayPromptSentAt: new Date() }).where(eq(bookings.id, Number(b.id)));
            prompted += 1;
        }

        if (minutesUntil <= NO_EN_ROUTE_WARN_MIN && !b.noEnRouteWarningSentAt) {
            const names = assigned.map((s) => s.name).join(', ');
            const when = minutesUntil > 0 ? `starts in ${Math.round(minutesUntil)} min` : `was due ${Math.round(-minutesUntil)} min ago`;
            const line = `No cleaner is on the way to booking ${ref} (${b.time}, ${b.contactName}); it ${when}. Assigned: ${names}.`;
            await notifyAdmins(db, `WARNING: ${line}`);
            noEnRouteLines.push(line);
            await db.update(bookings).set({ noEnRouteWarningSentAt: new Date() }).where(eq(bookings.id, Number(b.id)));
            noEnRoute += 1;
        }
    }

    if (noEnRouteLines.length || unassignedLines.length) {
        const parts: string[] = [];
        if (noEnRouteLines.length) {
            parts.push(`<p><strong>No cleaner on the way</strong></p><ul>${noEnRouteLines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`);
        }
        if (unassignedLines.length) {
            parts.push(`<p><strong>Unassigned bookings within ${UNASSIGNED_WARN_HOURS} hours</strong></p><ul>${unassignedLines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`);
        }
        await emailAdmin(db, 'Action needed: booking coverage warning', `${parts.join('')}<p>Open the admin Live Map to follow up.</p>`);
    }

    if (prompted || noEnRoute || unassigned) broadcastSync('notifications');
    return { prompted, noEnRoute, unassigned };
}
