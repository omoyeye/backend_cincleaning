import type { Express } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { bookingStaff, bookings, staff, staffHolidays } from './schema';
import { broadcastSync } from './realtime';
import { adminUserIds, notifyUsers } from './notify';

/**
 * Paid holiday for contracted staff.
 *
 * - Holiday year runs 1 April to 31 March; a request must sit inside one year.
 * - Weekdays (Mon to Fri) count; a single day can be a half day.
 * - Balance: taken (approved, started) + confirmed (approved, upcoming) + pending = booked;
 *   remaining = allowance - booked, and a request can never exceed what remains.
 * - Staff can edit or cancel a request until it is approved. Admin approves, rejects or leaves it pending.
 * - Approved holiday that has started can be claimed as holiday pay on a weekly invoice.
 */

type Auth = (req: any, res: any, next: any) => void;

export const MAX_HOLIDAY_DAYS = 26;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Today in the UK (holiday dates are calendar dates, not instants). */
export function todayUk(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

/** 2026 for any date from 1 April 2026 to 31 March 2027. */
export function holidayYearOf(ymd: string): number {
    const [y, m] = ymd.split('-').map(Number);
    return m >= 4 ? y : y - 1;
}

export function holidayYearRange(year: number): { start: string; end: string; label: string } {
    return { start: `${year}-04-01`, end: `${year + 1}-03-31`, label: `April ${year} to March ${year + 1}` };
}

/** Weekdays between two dates inclusive; a single-day half day counts 0.5. */
export function countHolidayDays(start: string, end: string, halfDay: boolean): number {
    const s = new Date(`${start}T12:00:00Z`);
    const e = new Date(`${end}T12:00:00Z`);
    let days = 0;
    for (const d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) days++;
    }
    if (halfDay && start === end && days === 1) return 0.5;
    return days;
}

export function isContracted(row: any): boolean {
    return String(row?.contractType || '').toLowerCase() === 'contracted';
}

export function allowanceOf(row: any): number {
    if (!isContracted(row)) return 0;
    const n = Number(row?.holidayAllowanceDays);
    return Math.min(MAX_HOLIDAY_DAYS, Math.max(0, Number.isFinite(n) ? n : MAX_HOLIDAY_DAYS));
}

/** Holiday pay for one day: paid hours per day x hourly rate. */
export function dailyHolidayPay(row: any): number {
    const hours = Number(row?.holidayHoursPerDay);
    return round2((Number.isFinite(hours) && hours > 0 ? hours : 8) * (Number(row?.hourlyRate) || 0));
}

export type HolidayBalance = { allowance: number; taken: number; confirmed: number; pending: number; remaining: number };

export function balanceFor(row: any, holidays: any[], year: number, today = todayUk(), excludeId?: number): HolidayBalance {
    const allowance = allowanceOf(row);
    let taken = 0;
    let confirmed = 0;
    let pending = 0;
    for (const h of holidays) {
        if (Number(h.holidayYear) !== year || (excludeId && Number(h.id) === excludeId)) continue;
        const d = Number(h.days) || 0;
        if (h.status === 'Approved') {
            if (String(h.startDate) <= today) taken += d;
            else confirmed += d;
        } else if (h.status === 'Pending') pending += d;
    }
    return {
        allowance,
        taken: round1(taken),
        confirmed: round1(confirmed),
        pending: round1(pending),
        remaining: round1(Math.max(0, allowance - taken - confirmed - pending)),
    };
}

/** Approved holiday that has started and is not yet on an invoice. */
export function claimableHolidays(row: any, holidays: any[], today = todayUk()) {
    const perDay = dailyHolidayPay(row);
    const hours = Number(row?.holidayHoursPerDay) > 0 ? Number(row.holidayHoursPerDay) : 8;
    return holidays
        .filter((h) => h.status === 'Approved' && (h.payStatus || 'unpaid') === 'unpaid' && String(h.startDate) <= today)
        .map((h) => ({
            id: Number(h.id),
            startDate: h.startDate,
            endDate: h.endDate,
            days: Number(h.days) || 0,
            hours: round2((Number(h.days) || 0) * hours),
            hourlyRate: Number(row?.hourlyRate) || 0,
            amount: round2((Number(h.days) || 0) * perDay),
        }));
}

const fmtDay = (ymd: string) =>
    new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const holidayRangeLabel = (h: { startDate: string; endDate: string }) =>
    h.startDate === h.endDate ? fmtDay(h.startDate) : `${fmtDay(h.startDate)} to ${fmtDay(h.endDate)}`;

function serialize(h: any) {
    return {
        id: Number(h.id),
        staffId: Number(h.staffId),
        startDate: h.startDate,
        endDate: h.endDate,
        halfDay: Boolean(h.halfDay),
        days: Number(h.days) || 0,
        holidayYear: Number(h.holidayYear),
        status: h.status,
        note: h.note || null,
        adminNote: h.adminNote || null,
        decidedAt: h.decidedAt ? new Date(h.decidedAt).toISOString() : null,
        payStatus: h.payStatus || 'unpaid',
        payAmount: h.payAmount != null ? Number(h.payAmount) : null,
        staffInvoiceId: h.staffInvoiceId != null ? Number(h.staffInvoiceId) : null,
        createdAt: h.createdAt ? new Date(h.createdAt).toISOString() : null,
    };
}

async function staffById(db: any, id: number) {
    const [row] = await db.select().from(staff).where(eq(staff.id, id)).limit(1);
    return row ?? null;
}

async function callerStaff(db: any, req: any) {
    if (req.user?.role !== 'staff') return null;
    const [row] = await db.select().from(staff).where(eq(staff.userId, Number(req.user.id))).limit(1);
    return row ?? null;
}

const isAdmin = (req: any) => req.user?.role === 'admin' || req.user?.isSuperadmin === true;

async function holidaysOf(db: any, staffId: number) {
    return db.select().from(staffHolidays).where(eq(staffHolidays.staffId, staffId)).orderBy(desc(staffHolidays.startDate));
}

/** Jobs a cleaner is booked on between two dates (shown to admin before approving). */
async function clashingJobs(db: any, staffId: number, start: string, end: string) {
    const links = await db.select({ bookingId: bookingStaff.bookingId }).from(bookingStaff).where(eq(bookingStaff.staffId, staffId));
    const ids = links.map((l: any) => Number(l.bookingId)).filter((n: number) => n > 0);
    const legacy = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.assignedStaffId, staffId));
    const all = [...new Set([...ids, ...legacy.map((l: any) => Number(l.id))])];
    if (!all.length) return [];
    const rows = await db
        .select({ id: bookings.id, bookingId: bookings.bookingId, date: bookings.date, time: bookings.time, status: bookings.status, contactName: bookings.contactName, serviceType: bookings.serviceType })
        .from(bookings)
        .where(inArray(bookings.id, all));
    return rows
        .filter((b: any) => String(b.date) >= start && String(b.date) <= end && !['Cancelled', 'Completed'].includes(String(b.status)))
        .map((b: any) => ({ id: Number(b.id), ref: b.bookingId, date: b.date, time: b.time, client: b.contactName, service: b.serviceType }));
}

/** Validates dates, contract, overlap and balance. Returns an error message or the computed fields. */
async function validateRequest(
    db: any,
    row: any,
    input: { startDate?: unknown; endDate?: unknown; halfDay?: unknown },
    opts: { excludeId?: number; allowPast: boolean },
): Promise<{ error: string } | { startDate: string; endDate: string; halfDay: boolean; days: number; holidayYear: number }> {
    if (!isContracted(row)) return { error: 'Paid holiday is only available to contracted staff.' };
    const startDate = String(input.startDate || '').trim();
    const endDate = String(input.endDate || input.startDate || '').trim();
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) return { error: 'Choose a start and end date.' };
    if (endDate < startDate) return { error: 'The end date must be on or after the start date.' };
    if (!opts.allowPast && startDate < todayUk()) return { error: 'Holiday must start today or later.' };
    const holidayYear = holidayYearOf(startDate);
    if (holidayYearOf(endDate) !== holidayYear) {
        const r = holidayYearRange(holidayYear);
        return { error: `Holiday must fit within one holiday year (${r.label}). Split it into two requests.` };
    }
    const halfDay = input.halfDay === true && startDate === endDate;
    const days = countHolidayDays(startDate, endDate, halfDay);
    if (days <= 0) return { error: 'Those dates are only weekends. Choose at least one weekday.' };

    const existing = await holidaysOf(db, Number(row.id));
    const overlap = existing.find(
        (h: any) =>
            Number(h.id) !== opts.excludeId &&
            (h.status === 'Pending' || h.status === 'Approved') &&
            String(h.startDate) <= endDate &&
            String(h.endDate) >= startDate,
    );
    if (overlap) return { error: `You already have holiday booked from ${holidayRangeLabel(overlap)}.` };

    const bal = balanceFor(row, existing, holidayYear, todayUk(), opts.excludeId);
    if (days > bal.remaining) {
        return { error: `That is ${days} day${days === 1 ? '' : 's'}, but only ${bal.remaining} day${bal.remaining === 1 ? '' : 's'} remain for ${holidayYearRange(holidayYear).label}.` };
    }
    return { startDate, endDate, halfDay, days, holidayYear };
}

/** Keeps holiday pay in step with the weekly invoice it was claimed on. */
export async function syncHolidayPayForInvoice(db: any, invoiceId: number, invoiceStatus: 'Pending' | 'Approved' | 'Rejected' | 'Deleted'): Promise<void> {
    if (invoiceStatus === 'Approved') {
        await db.update(staffHolidays).set({ payStatus: 'paid' }).where(eq(staffHolidays.staffInvoiceId, invoiceId));
    } else if (invoiceStatus === 'Pending') {
        await db.update(staffHolidays).set({ payStatus: 'claimed' }).where(eq(staffHolidays.staffInvoiceId, invoiceId));
    } else {
        await db.update(staffHolidays).set({ payStatus: 'unpaid', staffInvoiceId: null, payAmount: null }).where(eq(staffHolidays.staffInvoiceId, invoiceId));
    }
}

/** Invoice lines for holiday the staff member chose to claim; throws a readable error if any is not claimable. */
export async function holidayInvoiceLines(db: any, staffId: number, holidayIds: unknown) {
    const ids = [...new Set((Array.isArray(holidayIds) ? holidayIds : []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!ids.length) return { lines: [] as any[], total: 0, ids: [] as number[] };
    const row = await staffById(db, staffId);
    const claimable = claimableHolidays(row, await holidaysOf(db, staffId));
    const chosen = claimable.filter((c) => ids.includes(c.id));
    if (chosen.length !== ids.length) throw new Error('Some holiday pay is no longer available to claim. Refresh and try again.');
    const lines = chosen.map((c) => ({
        id: `holiday-${c.id}`,
        kind: 'holiday',
        holidayId: c.id,
        date: c.startDate,
        customer: `Holiday pay: ${holidayRangeLabel(c)} (${c.days} day${c.days === 1 ? '' : 's'})`,
        staffCount: 1,
        bookedHours: c.hours,
        yourHours: c.hours,
        hours: c.hours,
        hourlyRate: c.hourlyRate,
        yourShare: c.amount,
    }));
    return { lines, total: round2(chosen.reduce((s, c) => s + c.amount, 0)), ids: chosen.map((c) => c.id), amounts: Object.fromEntries(chosen.map((c) => [c.id, c.amount])) };
}

export async function markHolidaysClaimed(db: any, invoiceId: number, amounts: Record<number, number>): Promise<void> {
    for (const [id, amount] of Object.entries(amounts)) {
        await db
            .update(staffHolidays)
            .set({ payStatus: 'claimed', staffInvoiceId: invoiceId, payAmount: Number(amount).toFixed(2) })
            .where(and(eq(staffHolidays.id, Number(id)), eq(staffHolidays.payStatus, 'unpaid')));
    }
}

export function registerStaffHolidayRoutes(app: Express, db: any, authenticateToken: Auth): void {
    /** One staff member's holiday for a year: settings, balance, requests and claimable pay. */
    app.get('/api/staff/:id/holidays', authenticateToken, async (req: any, res) => {
        try {
            const staffId = Number(req.params.id);
            if (!isAdmin(req)) {
                const me = await callerStaff(db, req);
                if (!me || Number(me.id) !== staffId) return res.status(403).json({ error: 'Unauthorized' });
            }
            const row = await staffById(db, staffId);
            if (!row) return res.status(404).json({ error: 'Staff not found' });
            const today = todayUk();
            const year = Number(req.query.year) || holidayYearOf(today);
            const all = await holidaysOf(db, staffId);
            const range = holidayYearRange(year);
            res.json({
                staff: {
                    id: Number(row.id),
                    name: row.name,
                    contracted: isContracted(row),
                    allowance: allowanceOf(row),
                    hoursPerDay: Number(row.holidayHoursPerDay) > 0 ? Number(row.holidayHoursPerDay) : 8,
                    hourlyRate: Number(row.hourlyRate) || 0,
                    dailyPay: dailyHolidayPay(row),
                },
                year,
                currentYear: holidayYearOf(today),
                yearLabel: range.label,
                yearStart: range.start,
                yearEnd: range.end,
                today,
                balance: balanceFor(row, all, year, today),
                holidays: all.filter((h: any) => Number(h.holidayYear) === year).map(serialize),
                claimable: claimableHolidays(row, all, today),
            });
        } catch (e) {
            console.error('[holidays] get', e);
            res.status(500).json({ error: 'Could not load holiday' });
        }
    });

    /** Staff book their own holiday; admin can book on someone's behalf (optionally already approved). */
    app.post('/api/staff/:id/holidays', authenticateToken, async (req: any, res) => {
        try {
            const staffId = Number(req.params.id);
            const admin = isAdmin(req);
            if (!admin) {
                const me = await callerStaff(db, req);
                if (!me || Number(me.id) !== staffId) return res.status(403).json({ error: 'Unauthorized' });
            }
            const row = await staffById(db, staffId);
            if (!row) return res.status(404).json({ error: 'Staff not found' });
            const v = await validateRequest(db, row, req.body || {}, { allowPast: admin });
            if ('error' in v) return res.status(400).json({ error: v.error });
            const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
            const approveNow = admin && req.body?.status === 'Approved';
            await db.insert(staffHolidays).values({
                staffId,
                ...v,
                days: v.days.toFixed(1),
                note,
                status: approveNow ? 'Approved' : 'Pending',
                decidedAt: approveNow ? new Date() : null,
            });
            if (!admin) {
                const admins = await adminUserIds(db);
                await notifyUsers(db, admins, {
                    message: `${row.name} requested ${v.days} day${v.days === 1 ? '' : 's'} holiday (${holidayRangeLabel(v)}).`,
                    pushTitle: 'Holiday request',
                    pushBody: `${row.name}: ${holidayRangeLabel(v)} (${v.days} day${v.days === 1 ? '' : 's'})`,
                    data: { type: 'holiday' },
                });
            }
            broadcastSync('all');
            res.json({ ok: true });
        } catch (e) {
            console.error('[holidays] create', e);
            res.status(500).json({ error: 'Could not book holiday' });
        }
    });

    /** Staff edit a request that is not approved yet (a rejected one goes back to pending). */
    app.patch('/api/holidays/:id', authenticateToken, async (req: any, res) => {
        try {
            const id = Number(req.params.id);
            const [h] = await db.select().from(staffHolidays).where(eq(staffHolidays.id, id)).limit(1);
            if (!h) return res.status(404).json({ error: 'Holiday not found' });
            const admin = isAdmin(req);
            if (!admin) {
                const me = await callerStaff(db, req);
                if (!me || Number(me.id) !== Number(h.staffId)) return res.status(403).json({ error: 'Unauthorized' });
            }
            if (!['Pending', 'Rejected'].includes(h.status)) {
                return res.status(400).json({ error: 'Approved holiday can only be changed by the office.' });
            }
            const row = await staffById(db, Number(h.staffId));
            const v = await validateRequest(db, row, { startDate: req.body?.startDate ?? h.startDate, endDate: req.body?.endDate ?? h.endDate, halfDay: req.body?.halfDay ?? h.halfDay }, { excludeId: id, allowPast: admin });
            if ('error' in v) return res.status(400).json({ error: v.error });
            const note = req.body?.note !== undefined ? String(req.body.note || '').trim().slice(0, 1000) || null : h.note;
            await db
                .update(staffHolidays)
                .set({ ...v, days: v.days.toFixed(1), note, status: 'Pending', adminNote: h.status === 'Rejected' ? null : h.adminNote, decidedAt: null, updatedAt: new Date() })
                .where(eq(staffHolidays.id, id));
            broadcastSync('all');
            res.json({ ok: true });
        } catch (e) {
            console.error('[holidays] edit', e);
            res.status(500).json({ error: 'Could not update holiday' });
        }
    });

    /** Staff cancel a request that is not approved; admin can cancel any holiday whose pay is not claimed. */
    app.delete('/api/holidays/:id', authenticateToken, async (req: any, res) => {
        try {
            const id = Number(req.params.id);
            const [h] = await db.select().from(staffHolidays).where(eq(staffHolidays.id, id)).limit(1);
            if (!h) return res.status(404).json({ error: 'Holiday not found' });
            const admin = isAdmin(req);
            if (!admin) {
                const me = await callerStaff(db, req);
                if (!me || Number(me.id) !== Number(h.staffId)) return res.status(403).json({ error: 'Unauthorized' });
                if (!['Pending', 'Rejected'].includes(h.status)) {
                    return res.status(400).json({ error: 'Approved holiday can only be cancelled by the office.' });
                }
            }
            if ((h.payStatus || 'unpaid') !== 'unpaid') {
                return res.status(400).json({ error: 'Holiday pay for this has already been claimed on an invoice.' });
            }
            await db.update(staffHolidays).set({ status: 'Cancelled', updatedAt: new Date() }).where(eq(staffHolidays.id, id));
            if (admin && h.status === 'Approved') {
                const row = await staffById(db, Number(h.staffId));
                if (row?.userId) {
                    await notifyUsers(db, [Number(row.userId)], {
                        message: `Your holiday (${holidayRangeLabel(h)}) was cancelled by the office.`,
                        pushTitle: 'Holiday cancelled',
                        data: { type: 'holiday' },
                    });
                }
            }
            broadcastSync('all');
            res.json({ ok: true });
        } catch (e) {
            console.error('[holidays] cancel', e);
            res.status(500).json({ error: 'Could not cancel holiday' });
        }
    });

    /** Admin: every request for a holiday year, with balances for contracted staff and job clashes. */
    app.get('/api/admin/holidays', authenticateToken, async (req: any, res) => {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
        try {
            const today = todayUk();
            const year = Number(req.query.year) || holidayYearOf(today);
            const staffRows = await db.select().from(staff);
            const all = await db.select().from(staffHolidays).orderBy(desc(staffHolidays.createdAt));
            const byStaff = new Map<number, any[]>();
            all.forEach((h: any) => byStaff.set(Number(h.staffId), [...(byStaff.get(Number(h.staffId)) || []), h]));
            const yearRows = all.filter((h: any) => Number(h.holidayYear) === year && h.status !== 'Cancelled');
            const staffById = new Map(staffRows.map((s: any) => [Number(s.id), s]));
            const requests = await Promise.all(
                yearRows.map(async (h: any) => {
                    const s: any = staffById.get(Number(h.staffId));
                    return {
                        ...serialize(h),
                        staffName: s?.name || `Staff #${h.staffId}`,
                        staffImage: s?.imageUrl || null,
                        clashes: h.status === 'Pending' || (h.status === 'Approved' && String(h.endDate) >= today) ? await clashingJobs(db, Number(h.staffId), h.startDate, h.endDate) : [],
                    };
                }),
            );
            const balances = staffRows
                .filter((s: any) => isContracted(s) && String(s.status || 'Active') !== 'Inactive')
                .map((s: any) => ({
                    staffId: Number(s.id),
                    name: s.name,
                    imageUrl: s.imageUrl || null,
                    onHolidayToday: (byStaff.get(Number(s.id)) || []).some((h: any) => h.status === 'Approved' && h.startDate <= today && h.endDate >= today),
                    ...balanceFor(s, byStaff.get(Number(s.id)) || [], year, today),
                }))
                .sort((a: any, b: any) => a.name.localeCompare(b.name));
            const range = holidayYearRange(year);
            res.json({ year, currentYear: holidayYearOf(today), yearLabel: range.label, today, requests, balances });
        } catch (e) {
            console.error('[holidays] admin list', e);
            res.status(500).json({ error: 'Could not load holidays' });
        }
    });

    /** Admin decision: approve, reject or set back to pending, with an optional note and adjusted days. */
    app.patch('/api/admin/holidays/:id', authenticateToken, async (req: any, res) => {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
        try {
            const id = Number(req.params.id);
            const status = String(req.body?.status || '');
            if (!['Approved', 'Rejected', 'Pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
            const [h] = await db.select().from(staffHolidays).where(eq(staffHolidays.id, id)).limit(1);
            if (!h) return res.status(404).json({ error: 'Holiday not found' });
            if (h.status === 'Cancelled') return res.status(400).json({ error: 'This request was cancelled.' });
            if ((h.payStatus || 'unpaid') !== 'unpaid' && status !== 'Approved') {
                return res.status(400).json({ error: 'Holiday pay for this is already on an invoice, so it must stay approved.' });
            }
            const row = await staffById(db, Number(h.staffId));
            let days = Number(h.days) || 0;
            if (req.body?.days !== undefined && req.body.days !== null && req.body.days !== '') {
                const d = Number(req.body.days);
                if (!Number.isFinite(d) || d <= 0 || Math.round(d * 2) !== d * 2) return res.status(400).json({ error: 'Days must be a whole or half number above 0.' });
                days = d;
            }
            if (status === 'Approved') {
                const bal = balanceFor(row, await holidaysOf(db, Number(h.staffId)), Number(h.holidayYear), todayUk(), id);
                if (days > bal.remaining) {
                    return res.status(400).json({ error: `Only ${bal.remaining} day${bal.remaining === 1 ? '' : 's'} remain for ${row?.name || 'this person'} this holiday year.` });
                }
            }
            const adminNote = req.body?.adminNote !== undefined ? String(req.body.adminNote || '').trim().slice(0, 1000) || null : h.adminNote;
            await db
                .update(staffHolidays)
                .set({ status, adminNote, days: days.toFixed(1), decidedAt: status === 'Pending' ? null : new Date(), updatedAt: new Date() })
                .where(eq(staffHolidays.id, id));
            if (row?.userId && status !== h.status && status !== 'Pending') {
                const note = adminNote ? ` Note: ${adminNote}` : '';
                await notifyUsers(db, [Number(row.userId)], {
                    message: `Your holiday request (${holidayRangeLabel(h)}, ${days} day${days === 1 ? '' : 's'}) was ${status.toLowerCase()}.${note}`,
                    pushTitle: `Holiday ${status.toLowerCase()}`,
                    pushBody: `${holidayRangeLabel(h)}: ${status.toLowerCase()}.${note}`,
                    data: { type: 'holiday' },
                });
            }
            broadcastSync('all');
            res.json({ ok: true });
        } catch (e) {
            console.error('[holidays] decision', e);
            res.status(500).json({ error: 'Could not update holiday' });
        }
    });
}
