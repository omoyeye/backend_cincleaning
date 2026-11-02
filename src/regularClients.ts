import type { Express } from 'express';
import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import { bookingStaff, bookings, clientCareLog, notifications, staff, staffHolidays, users } from './schema';
import { adminUserIds, emailAdmins, emailFromTemplate, friendlyDate, notifyUsers, siteUrl } from './notify';
import { loadBusinessSettingsMap } from './messageTemplates/brand';
import { broadcastSync } from './realtime';
import { ukYmd } from './tz';

type Auth = (req: any, res: any, next: any) => void;

/**
 * Regular clients (weekly, fortnightly or monthly): admin visibility and alerts, keeping the same
 * cleaner, a welcome, next-visit messages, milestone and anniversary thank-yous, and a win-back
 * message when a regular goes quiet. Every message is logged in client_care_log so it goes out once.
 */

export type CareSettings = {
    enabled: boolean;
    /** Loyalty points given when a regular client reaches this many completed cleans. */
    milestones: { cleans: number; points: number }[];
    /** Points on the anniversary of their first regular clean (0 = message only). */
    anniversaryPoints: number;
    /** Book each next visit with the client's last cleaner when they are free. */
    sameCleaner: boolean;
    /** Send a "we miss you" message when a regular has no visit booked for a while. */
    winBack: boolean;
    /** Days past their usual gap before a regular counts as quiet. */
    quietDays: number;
};

export const DEFAULT_CARE: CareSettings = {
    enabled: true,
    milestones: [
        { cleans: 5, points: 50 },
        { cleans: 10, points: 100 },
        { cleans: 25, points: 250 },
    ],
    anniversaryPoints: 100,
    sameCleaner: true,
    winBack: true,
    quietDays: 10,
};

export const CARE_SETTINGS_KEY = 'regularClientCare';
const FREQ_DAYS: Record<string, number> = { Weekly: 7, Fortnightly: 14, Monthly: 31 };
const OPEN_STATUSES = ['Pending', 'Confirmed', 'In Progress'];

export async function loadCareSettings(db: any): Promise<CareSettings> {
    try {
        const raw = (await loadBusinessSettingsMap(db))[CARE_SETTINGS_KEY];
        if (!raw) return DEFAULT_CARE;
        const v = JSON.parse(raw);
        const milestones = Array.isArray(v?.milestones)
            ? v.milestones
                  .map((m: any) => ({ cleans: Math.round(Number(m?.cleans)), points: Math.max(0, Math.round(Number(m?.points) || 0)) }))
                  .filter((m: any) => Number.isFinite(m.cleans) && m.cleans > 0)
                  .sort((a: any, b: any) => a.cleans - b.cleans)
            : DEFAULT_CARE.milestones;
        return {
            enabled: v?.enabled !== false,
            milestones,
            anniversaryPoints: Math.max(0, Math.round(Number(v?.anniversaryPoints ?? DEFAULT_CARE.anniversaryPoints) || 0)),
            sameCleaner: v?.sameCleaner !== false,
            winBack: v?.winBack !== false,
            quietDays: Math.min(90, Math.max(1, Math.round(Number(v?.quietDays ?? DEFAULT_CARE.quietDays) || DEFAULT_CARE.quietDays))),
        };
    } catch {
        return DEFAULT_CARE;
    }
}

function parseJson(v: unknown): any {
    if (typeof v !== 'string') return v ?? null;
    try { return JSON.parse(v); } catch { return null; }
}

export function frequencyOf(b: { propertyDetails?: unknown }): string {
    const f = String(parseJson(b.propertyDetails)?.frequency || '');
    return FREQ_DAYS[f] ? f : 'One-time';
}

export function customerKeyOf(b: { customerId?: number | null; contactEmail?: string | null }): string {
    if (b.customerId) return `u:${Number(b.customerId)}`;
    return `e:${String(b.contactEmail || '').trim().toLowerCase()}`;
}

function ordinal(n: number): string {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function daysBetween(a: string, b: string): number {
    const [y1, m1, d1] = a.split('-').map(Number);
    const [y2, m2, d2] = b.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/** Records a care event; false when it was already recorded (so the caller skips sending again). */
async function logOnce(db: any, customerKey: string, kind: string, ref: string, detail?: string): Promise<boolean> {
    try {
        await db.insert(clientCareLog).values({ customerKey: customerKey.slice(0, 190), kind, ref: ref.slice(0, 60), detail: detail?.slice(0, 255) ?? null });
        return true;
    } catch (e: any) {
        if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062 || String(e?.message || '').includes('Duplicate')) return false;
        console.error('[regular clients] log failed', e);
        return false;
    }
}

async function alertAdmins(db: any, title: string, body: string): Promise<void> {
    try {
        await notifyUsers(db, await adminUserIds(db), { type: 'regular_client', message: `${title}: ${body}`, pushTitle: title, pushBody: body });
        await emailAdmins(db, 'admin_regular_client_alert', { alert_title: title, alert_body: body, admin_url: siteUrl('/admin') });
        broadcastSync('notifications');
    } catch (e) {
        console.error('[regular clients] admin alert failed', e);
    }
}

async function messageClient(
    db: any,
    b: any,
    push: { title: string; body: string; type?: string },
    email?: { template: string; vars: Record<string, string> },
): Promise<void> {
    if (b.customerId) {
        await notifyUsers(db, [Number(b.customerId)], { type: push.type || 'booking_update', message: push.body, pushTitle: push.title, pushBody: push.body, data: b.id ? { bookingId: Number(b.id) } : undefined });
    }
    if (email && b.contactEmail) {
        await emailFromTemplate(db, email.template, { email: b.contactEmail, name: b.contactName }, { client_name: String(b.contactName || 'there').split(' ')[0], ...email.vars });
    }
}

async function addPoints(db: any, userId: number | null | undefined, points: number): Promise<boolean> {
    if (!userId || points <= 0) return false;
    const [u] = await db.select({ loyaltyPoints: users.loyaltyPoints }).from(users).where(eq(users.id, Number(userId))).limit(1);
    if (!u) return false;
    await db.update(users).set({ loyaltyPoints: Number(u.loyaltyPoints || 0) + points }).where(eq(users.id, Number(userId)));
    return true;
}

const pointsLine = (points: number, credited: boolean) =>
    points > 0 && credited
        ? `As a thank you, we have added ${points} loyalty points (worth £${(points / 10).toFixed(2)} off a clean) to your account.`
        : 'Thank you for being such a valued client. We look forward to every visit.';

/* ───────────── Events from the booking flow ───────────── */

/** A booking was just created: welcome a first-time regular and tell the office. */
export async function onRegularBookingCreated(db: any, bookingId: number): Promise<void> {
    try {
        const care = await loadCareSettings(db);
        if (!care.enabled) return;
        const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
        if (!b) return;
        const frequency = frequencyOf(b);
        if (frequency === 'One-time') return;
        const key = customerKeyOf(b);
        if (!(await logOnce(db, key, 'welcome', '', `${frequency} from ${b.date}`))) return;

        await messageClient(
            db,
            b,
            { title: 'Welcome to your regular clean', body: `Thank you for choosing a ${frequency.toLowerCase()} clean. We will book each next visit for you after every clean.` },
            {
                template: 'client_regular_welcome',
                vars: {
                    frequency: frequency.toLowerCase(),
                    service_type: String(b.serviceType || ''),
                    service_date: friendlyDate(b.date),
                    service_time: String(b.time || ''),
                    portal_url: siteUrl('/portal'),
                },
            },
        );
        await alertAdmins(db, 'New regular client', `${b.contactName || 'A client'} booked a ${frequency.toLowerCase()} ${b.serviceType} starting ${friendlyDate(b.date)} at ${b.time} (${b.bookingId}). Assign their usual cleaner so they get the same person each visit.`);
    } catch (e) {
        console.error('[regular clients] on created', e);
    }
}

/** A booking was cancelled: if it was a regular visit, the office should follow up. */
export async function onRegularBookingCancelled(db: any, b: any): Promise<void> {
    try {
        const care = await loadCareSettings(db);
        if (!care.enabled || !b) return;
        const frequency = frequencyOf(b);
        if (frequency === 'One-time') return;
        if (!(await logOnce(db, customerKeyOf(b), 'cancelled', String(b.id)))) return;
        await alertAdmins(
            db,
            'Regular client cancelled',
            `${b.contactName || 'A client'} cancelled their ${frequency.toLowerCase()} ${b.serviceType} on ${friendlyDate(b.date)} (${b.bookingId}). No further visits will be booked automatically, so give them a call or rebook them.`,
        );
    } catch (e) {
        console.error('[regular clients] on cancelled', e);
    }
}

/** A clean was completed: thank regular clients when they reach a milestone. */
export async function onRegularCleanCompleted(db: any, bookingId: number): Promise<void> {
    try {
        const care = await loadCareSettings(db);
        if (!care.enabled || !care.milestones.length) return;
        const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
        if (!b) return;
        const key = customerKeyOf(b);
        const mine = await db
            .select({ id: bookings.id, status: bookings.status, propertyDetails: bookings.propertyDetails })
            .from(bookings)
            .where(b.customerId ? eq(bookings.customerId, Number(b.customerId)) : eq(bookings.contactEmail, String(b.contactEmail || '')));
        const isRegular = mine.some((x: any) => x.status !== 'Cancelled' && frequencyOf(x) !== 'One-time');
        if (!isRegular) return;
        const cleans = mine.filter((x: any) => x.status === 'Completed').length;
        const milestone = care.milestones.find((m) => m.cleans === cleans);
        if (!milestone) return;
        if (!(await logOnce(db, key, 'milestone', String(cleans), `${milestone.points} points`))) return;

        const credited = await addPoints(db, b.customerId, milestone.points);
        await messageClient(
            db,
            b,
            {
                title: `Thank you for ${cleans} cleans`,
                body: credited && milestone.points > 0 ? `That was your ${ordinal(cleans)} clean with us. We have added ${milestone.points} loyalty points as a thank you.` : `That was your ${ordinal(cleans)} clean with us. Thank you!`,
                type: 'promo',
            },
            {
                template: 'client_regular_milestone',
                vars: { clean_count: String(cleans), clean_ordinal: ordinal(cleans), reward_line: pointsLine(milestone.points, credited), portal_url: siteUrl('/portal') },
            },
        );
        await alertAdmins(db, 'Regular client milestone', `${b.contactName || 'A client'} has just had their ${ordinal(cleans)} clean.${credited && milestone.points > 0 ? ` ${milestone.points} thank-you points were added.` : ''}`);
    } catch (e) {
        console.error('[regular clients] on completed', e);
    }
}

/* ───────────── Same cleaner on the next visit ───────────── */

function bookedHours(b: any): number {
    const pd = parseJson(b.propertyDetails) || {};
    const h = Number(pd.duration);
    return Number.isFinite(h) && h > 0 ? h : 3;
}

function startMinutes(time: string): number {
    const [h, m] = String(time || '09:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
}

/** Staff on a booking (legacy column plus the junction table). */
async function teamOf(db: any, b: any): Promise<number[]> {
    const links = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, Number(b.id)));
    return [...new Set([...(b.assignedStaffId ? [Number(b.assignedStaffId)] : []), ...links.map((l: any) => Number(l.staffId))])].filter((n) => n > 0);
}

/** Why this cleaner cannot take the visit, or null when they are free. */
async function unavailableReason(db: any, staffId: number, visit: any, excludeBookingId: number): Promise<string | null> {
    const [s] = await db.select().from(staff).where(eq(staff.id, staffId)).limit(1);
    if (!s || String(s.status || 'Active') !== 'Active') return 'is not active';
    const hols = await db.select().from(staffHolidays).where(and(eq(staffHolidays.staffId, staffId), eq(staffHolidays.status, 'Approved')));
    if (hols.some((h: any) => String(h.startDate) <= visit.date && String(h.endDate) >= visit.date)) return 'is on holiday';
    const sameDay = await db.select().from(bookings).where(and(eq(bookings.date, visit.date), ne(bookings.status, 'Cancelled'), ne(bookings.id, excludeBookingId)));
    if (sameDay.length) {
        const ids = sameDay.map((x: any) => Number(x.id));
        const links = await db.select().from(bookingStaff).where(inArray(bookingStaff.bookingId, ids));
        const start = startMinutes(visit.time);
        const end = start + bookedHours(visit) * 60;
        for (const other of sameDay) {
            const onIt = Number(other.assignedStaffId) === staffId || links.some((l: any) => Number(l.bookingId) === Number(other.id) && Number(l.staffId) === staffId);
            if (!onIt) continue;
            const os = startMinutes(other.time);
            const oe = os + bookedHours(other) * 60;
            if (start < oe && os < end) return `already has a job at ${other.time}`;
        }
    }
    return null;
}

/**
 * The next regular visit was just created from `source`: give it the same cleaner(s) when they are free,
 * otherwise ask the office to pick someone. Returns the names of whoever was assigned.
 */
export async function assignUsualCleaner(db: any, newBookingId: number, source: any): Promise<string[]> {
    try {
        const care = await loadCareSettings(db);
        if (!care.enabled || !care.sameCleaner) return [];
        const team = await teamOf(db, source);
        if (!team.length) return [];
        const [visit] = await db.select().from(bookings).where(eq(bookings.id, newBookingId)).limit(1);
        if (!visit) return [];
        const problems: string[] = [];
        for (const sid of team) {
            const why = await unavailableReason(db, sid, visit, newBookingId);
            if (why) {
                const [s] = await db.select({ name: staff.name }).from(staff).where(eq(staff.id, sid)).limit(1);
                problems.push(`${s?.name || 'Their cleaner'} ${why}`);
            }
        }
        if (problems.length) {
            await alertAdmins(
                db,
                'Cleaner needed for a regular client',
                `${visit.contactName || 'A regular client'}'s next visit on ${friendlyDate(visit.date)} at ${visit.time} (${visit.bookingId}) needs a cleaner: ${problems.join('; ')}.`,
            );
            return [];
        }
        await db.update(bookings).set({ assignedStaffId: team[0] }).where(eq(bookings.id, newBookingId));
        await db.insert(bookingStaff).values(team.map((staffId) => ({ bookingId: newBookingId, staffId })));
        const people = await db.select().from(staff).where(inArray(staff.id, team));
        await notifyUsers(db, people.map((p: any) => p.userId), {
            type: 'job_assigned',
            message: `Regular visit booked for you: ${visit.contactName} on ${friendlyDate(visit.date)} at ${visit.time} (${visit.bookingId}).`,
            pushTitle: 'Regular visit booked',
            pushBody: `${visit.contactName}, ${friendlyDate(visit.date)} at ${visit.time}`,
            data: { type: 'job_assigned', bookingId: newBookingId },
        });
        return people.map((p: any) => String(p.name || '').split(' ')[0]).filter(Boolean);
    } catch (e) {
        console.error('[regular clients] same cleaner', e);
        return [];
    }
}

/** Tell the client their next regular visit is booked (in-app is written by the creator; this adds push and email). */
export async function announceNextVisit(db: any, newBookingId: number, cleanerNames: string[]): Promise<void> {
    try {
        const [v] = await db.select().from(bookings).where(eq(bookings.id, newBookingId)).limit(1);
        if (!v) return;
        const frequency = frequencyOf(v).toLowerCase();
        const cleanerLine = cleanerNames.length ? `With ${cleanerNames.join(' and ')}, your usual cleaner${cleanerNames.length > 1 ? 's' : ''}.` : 'We will confirm your cleaner before the day.';
        if (v.customerId) {
            void notifyUsers(db, [Number(v.customerId)], {
                inApp: false,
                message: '',
                pushTitle: 'Your next clean is booked',
                pushBody: `${friendlyDate(v.date)} at ${v.time}. ${cleanerLine}`,
                data: { bookingId: newBookingId },
            });
        }
        if (v.contactEmail) {
            await emailFromTemplate(db, 'client_regular_next_visit', { email: v.contactEmail, name: v.contactName }, {
                client_name: String(v.contactName || 'there').split(' ')[0],
                frequency,
                service_type: String(v.serviceType || ''),
                service_date: friendlyDate(v.date),
                service_time: String(v.time || ''),
                cleaner_line: cleanerLine,
                booking_id: String(v.bookingId || newBookingId),
                portal_url: siteUrl('/portal'),
            });
        }
    } catch (e) {
        console.error('[regular clients] next visit message', e);
    }
}

/* ───────────── Regular client list (admin) and daily care ───────────── */

export type RegularClient = {
    key: string;
    customerId: number | null;
    name: string;
    email: string;
    phone: string | null;
    frequency: string;
    serviceType: string;
    since: string;
    cleans: number;
    lastClean: string | null;
    nextVisit: { id: number; ref: string | null; date: string; time: string; status: string; cleaners: string[] } | null;
    usualCleaner: string | null;
    cancellations60d: number;
    status: 'active' | 'at_risk' | 'lapsed';
    reasons: string[];
};

async function loadRegularGroups(db: any) {
    const since = ukYmd(new Date(Date.now() - 500 * 86400000));
    const rows = await db.select().from(bookings).where(gte(bookings.date, since));
    const groups = new Map<string, any[]>();
    for (const b of rows) {
        const key = customerKeyOf(b);
        if (key === 'e:') continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(b);
    }
    for (const [key, list] of groups) {
        if (!list.some((b) => frequencyOf(b) !== 'One-time')) groups.delete(key);
        else list.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    }
    return groups;
}

export async function listRegularClients(db: any, quietDays = DEFAULT_CARE.quietDays): Promise<RegularClient[]> {
    const groups = await loadRegularGroups(db);
    const allIds = [...groups.values()].flat().map((b) => Number(b.id));
    const links = allIds.length ? await db.select().from(bookingStaff).where(inArray(bookingStaff.bookingId, allIds)) : [];
    const staffRows = await db.select({ id: staff.id, name: staff.name }).from(staff);
    const nameOf = new Map(staffRows.map((s: any) => [Number(s.id), String(s.name)]));
    const teamOfRow = (b: any) =>
        [...new Set([...(b.assignedStaffId ? [Number(b.assignedStaffId)] : []), ...links.filter((l: any) => Number(l.bookingId) === Number(b.id)).map((l: any) => Number(l.staffId))])];

    const today = ukYmd();
    const out: RegularClient[] = [];
    for (const [key, list] of groups) {
        const regular = list.filter((b) => frequencyOf(b) !== 'One-time');
        const latest = regular[regular.length - 1];
        const frequency = frequencyOf(latest);
        const completed = list.filter((b) => b.status === 'Completed');
        const lastClean = completed.length ? completed[completed.length - 1].date : null;
        const upcoming = list.find((b) => OPEN_STATUSES.includes(String(b.status)) && b.date >= today) || null;
        const stuck = list.filter((b) => OPEN_STATUSES.includes(String(b.status)) && b.date < today);
        const cancellations60d = list.filter((b) => b.status === 'Cancelled' && daysBetween(b.date, today) <= 60 && daysBetween(b.date, today) >= -60).length;
        const counts = new Map<number, number>();
        for (const b of completed) for (const sid of teamOfRow(b)) counts.set(sid, (counts.get(sid) || 0) + 1);
        const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];

        const reasons: string[] = [];
        if (stuck.length) reasons.push(`${stuck.length} past visit${stuck.length > 1 ? 's' : ''} not marked complete, so the next one will not be booked`);
        if (!upcoming) reasons.push('No visit booked');
        if (cancellations60d >= 2) reasons.push(`${cancellations60d} cancellations in the last 60 days`);
        else if (cancellations60d === 1) reasons.push('Cancelled a visit recently');
        if (upcoming && !teamOfRow(upcoming).length) reasons.push('Next visit has no cleaner');
        const gap = lastClean ? daysBetween(lastClean, today) : null;
        const lapsed = !upcoming && !stuck.length && gap !== null && gap > FREQ_DAYS[frequency] + quietDays * 3;
        const status: RegularClient['status'] = lapsed ? 'lapsed' : reasons.length ? 'at_risk' : 'active';

        out.push({
            key,
            customerId: latest.customerId ? Number(latest.customerId) : null,
            name: String(latest.contactName || 'Client'),
            email: String(latest.contactEmail || ''),
            phone: latest.contactPhone || null,
            frequency,
            serviceType: String(latest.serviceType || ''),
            since: regular[0].date,
            cleans: completed.length,
            lastClean,
            nextVisit: upcoming
                ? { id: Number(upcoming.id), ref: upcoming.bookingId, date: upcoming.date, time: upcoming.time, status: upcoming.status, cleaners: teamOfRow(upcoming).map((sid) => String(nameOf.get(sid) || 'Cleaner')) }
                : null,
            usualCleaner: usual ? String(nameOf.get(usual[0]) || '') || null : null,
            cancellations60d,
            status,
            reasons,
        });
    }
    const rank = { at_risk: 0, active: 1, lapsed: 2 } as const;
    return out.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

let lastCareRun = 0;

/** Hourly at most: alerts for visits left open, win-back messages and anniversaries. */
export async function runRegularClientCare(db: any): Promise<{ stuck: number; winBack: number; anniversaries: number }> {
    const result = { stuck: 0, winBack: 0, anniversaries: 0 };
    if (Date.now() - lastCareRun < 55 * 60 * 1000) return result;
    lastCareRun = Date.now();
    const care = await loadCareSettings(db);
    if (!care.enabled) return result;
    const groups = await loadRegularGroups(db);
    const today = ukYmd();

    for (const [key, list] of groups) {
        const regular = list.filter((b) => frequencyOf(b) !== 'One-time');
        const latest = regular[regular.length - 1];
        const frequency = frequencyOf(latest);

        // A past visit still open stops the next visit being booked.
        for (const b of list) {
            if (!OPEN_STATUSES.includes(String(b.status)) || frequencyOf(b) === 'One-time') continue;
            if (daysBetween(b.date, today) < 1) continue;
            if (!(await logOnce(db, key, 'stuck', String(b.id)))) continue;
            result.stuck += 1;
            await alertAdmins(
                db,
                'Regular visit not closed',
                `${b.contactName}'s ${frequency.toLowerCase()} visit on ${friendlyDate(b.date)} (${b.bookingId}) is still ${b.status}. Mark it complete or cancelled, otherwise their next visit will not be booked.`,
            );
        }

        const completed = list.filter((b) => b.status === 'Completed');
        const upcoming = list.some((b) => OPEN_STATUSES.includes(String(b.status)));

        // Quiet: no visit booked and past their usual gap.
        if (care.winBack && !upcoming && completed.length) {
            const last = completed[completed.length - 1];
            if (daysBetween(last.date, today) > FREQ_DAYS[frequency] + care.quietDays && (await logOnce(db, key, 'winback', String(last.id)))) {
                result.winBack += 1;
                await messageClient(
                    db,
                    last,
                    { title: 'We miss you', body: `Your ${frequency.toLowerCase()} clean has paused. Book your next visit whenever you are ready.`, type: 'promo' },
                    {
                        template: 'client_regular_winback',
                        vars: {
                            frequency: frequency.toLowerCase(),
                            service_type: String(last.serviceType || ''),
                            last_booking_date: friendlyDate(last.date),
                            booking_url: siteUrl('/book'),
                        },
                    },
                );
                await alertAdmins(db, 'Regular client gone quiet', `${last.contactName} has had no ${frequency.toLowerCase()} visit since ${friendlyDate(last.date)} and nothing is booked. We sent them a "we miss you" message; a personal call helps.`);
            }
        }

        // Anniversary of their first completed regular clean, while they are still regular.
        const firstRegularDone = completed.find((b) => frequencyOf(b) !== 'One-time');
        if (firstRegularDone && (upcoming || (completed.length && daysBetween(completed[completed.length - 1].date, today) <= FREQ_DAYS[frequency] * 2))) {
            const years = Number(today.slice(0, 4)) - Number(String(firstRegularDone.date).slice(0, 4));
            if (years >= 1 && String(firstRegularDone.date).slice(5) === today.slice(5) && (await logOnce(db, key, 'anniversary', String(years)))) {
                result.anniversaries += 1;
                const credited = await addPoints(db, latest.customerId, care.anniversaryPoints);
                const yearsText = `${years} year${years > 1 ? 's' : ''}`;
                await messageClient(
                    db,
                    latest,
                    { title: `${yearsText} with us`, body: `Thank you for ${yearsText} of regular cleans.${credited && care.anniversaryPoints > 0 ? ` We have added ${care.anniversaryPoints} loyalty points.` : ''}`, type: 'promo' },
                    { template: 'client_regular_anniversary', vars: { years: yearsText, reward_line: pointsLine(care.anniversaryPoints, credited), portal_url: siteUrl('/portal') } },
                );
                await alertAdmins(db, 'Regular client anniversary', `${latest.contactName} has been a regular client for ${yearsText} today.`);
            }
        }
    }
    return result;
}

export function registerRegularClientRoutes(app: Express, db: any, authenticateToken: Auth): void {
    app.get('/api/admin/regular-clients', authenticateToken, async (req: any, res) => {
        if (req.user?.role !== 'admin' && !req.user?.isSuperadmin) return res.status(403).json({ error: 'Admin only' });
        try {
            const care = await loadCareSettings(db);
            res.json({ clients: await listRegularClients(db, care.quietDays), settings: care });
        } catch (e) {
            console.error('[regular clients] list', e);
            res.status(500).json({ error: 'Failed to load regular clients' });
        }
    });
}

/** Used by the recurring job's in-app message; kept here so wording stays in one place. */
export async function nextVisitInApp(db: any, customerId: number, serviceType: string, date: string, time: string, ref: string, cleanerNames: string[]) {
    await db.insert(notifications).values({
        userId: customerId,
        type: 'booking_update',
        message: `Your next ${serviceType} is booked for ${friendlyDate(date)} at ${time}${cleanerNames.length ? ` with ${cleanerNames.join(' and ')}` : ''}. Reference: ${ref}`,
        isRead: false,
    });
}
