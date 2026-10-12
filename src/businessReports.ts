import type { Express } from 'express';
import { and, desc, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import {
    bookingStaff,
    bookings,
    businessReports,
    businessSettings,
    customerInvoices,
    expenses,
    quoteLeads,
    quoteOffers,
    staff,
    staffAssessments,
} from './schema';
import { isGreaterLondonPostcode } from './shared/pricing';
import { loadBrandVars } from './messageTemplates/brand';
import { renderTransactionalEmail } from './messageTemplates/engine';
import { sendEmail } from './services/email';

type Auth = (req: any, res: any, next: any) => void;
type Deps = {
    authenticateToken: Auth;
    requireAdmin: (req: any, res: any) => boolean;
    absoluteSiteUrl: (path: string) => string;
    notifyAdmins: (message: string) => Promise<void>;
};

/** Arrivals up to this many minutes after the booked start count as on time (same as staff performance). */
const ON_TIME_GRACE_MIN = 5;
const AI_MODEL = process.env.REPORT_AI_MODEL || 'claude-sonnet-5-5';
const TZ = 'Europe/London';

/* ───────────────────────── dates (UK time) ───────────────────────── */

const pad = (n: number) => String(n).padStart(2, '0');
const ymdUTC = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Calendar date + weekday + hour in UK time. */
function londonNow(at = new Date()): { ymd: string; weekday: number; hour: number } {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
        weekday: 'short',
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    return { ymd: `${get('year')}-${get('month')}-${get('day')}`, weekday, hour: Number(get('hour')) };
}

function addDays(ymd: string, days: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    return ymdUTC(new Date(Date.UTC(y, m - 1, d + days)));
}

function daysBetween(a: string, b: string): number {
    const [y1, m1, d1] = a.split('-').map(Number);
    const [y2, m2, d2] = b.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/** Monday to Sunday of the week before the one containing `ymd`. */
function previousWeek(ymd: string): { start: string; end: string } {
    const [y, m, d] = ymd.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const thisMonday = addDays(ymd, -((dow + 6) % 7));
    return { start: addDays(thisMonday, -7), end: addDays(thisMonday, -1) };
}

/** UK-local calendar date of a timestamp. */
function londonYmd(v: unknown): string | null {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    if (Number.isNaN(d.getTime())) return null;
    return londonNow(d).ymd;
}

function prettyRange(start: string, end: string): string {
    const f = (s: string, withYear: boolean) => {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
    };
    return `${f(start, false)} to ${f(end, true)}`;
}

/* ───────────────────────── helpers ───────────────────────── */

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const avg = (list: number[]) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
function asObject(raw: unknown): Record<string, any> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
    if (typeof raw === 'string') {
        try {
            const v = JSON.parse(raw);
            return v && typeof v === 'object' ? v : {};
        } catch {
            return {};
        }
    }
    return {};
}
function asArray(raw: unknown): any[] {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const v = JSON.parse(raw);
            return Array.isArray(v) ? v : [];
        } catch {
            return [];
        }
    }
    return [];
}
const inRange = (ymd: string | null, start: string, end: string) => !!ymd && ymd >= start && ymd <= end;

function minutesLate(b: any): number | null {
    const date = String(b.date || '').slice(0, 10);
    const m = String(b.time || '').match(/^(\d{1,2}):(\d{2})/);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !m) return null;
    const wc = asObject(b.workCompletion);
    let arrived: number | null = null;
    if (wc.clockInAtIso) {
        const t = Date.parse(wc.clockInAtIso);
        if (Number.isFinite(t)) arrived = t;
    }
    if (arrived === null && b.arrivedAt) {
        const t = new Date(b.arrivedAt).getTime();
        if (Number.isFinite(t)) arrived = t;
    }
    if (arrived === null) return null;
    // Booked start in UK time: build it from the arrival's UK offset.
    const [y, mo, d] = date.split('-').map(Number);
    const naiveUtc = Date.UTC(y, mo - 1, d, Number(m[1]), Number(m[2]));
    const offsetMin = (() => {
        const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(new Date(naiveUtc));
        const tz = p.find((x) => x.type === 'timeZoneName')?.value || 'GMT';
        const mm = tz.match(/GMT([+-]\d+)(?::(\d+))?/);
        return mm ? Number(mm[1]) * 60 + Math.sign(Number(mm[1])) * Number(mm[2] || 0) : 0;
    })();
    const start = naiveUtc - offsetMin * 60000;
    return Math.round((arrived - start) / 60000);
}

/* ───────────────────────── figures ───────────────────────── */

type Ctx = {
    bookingRows: any[];
    teamByBooking: Map<number, number[]>;
    staffById: Map<number, any>;
    invoices: any[];
    expenseRows: any[];
    leads: any[];
    offers: any[];
    assessments: any[];
    firstBookingByEmail: Map<string, string>;
};

/** Every figure for one period. Pure maths over rows already loaded. */
function periodFigures(ctx: Ctx, start: string, end: string) {
    const dated = ctx.bookingRows.filter((b) => inRange(String(b.date || '').slice(0, 10), start, end));
    const completed = dated.filter((b) => b.status === 'Completed');
    const cancelled = dated.filter((b) => b.status === 'Cancelled');
    const madeInPeriod = ctx.bookingRows.filter((b) => inRange(londonYmd(b.createdAt), start, end));

    const completedValue = round2(completed.reduce((a, b) => a + num(b.totalPrice), 0));

    // Money actually received in the period.
    const invoicesPaid = ctx.invoices.filter((i) => i.status === 'paid' && inRange(londonYmd(i.paidAt), start, end));
    const invoicesPaidTotal = round2(invoicesPaid.reduce((a, i) => a + num(i.total), 0));
    const depositsPaid = ctx.bookingRows.filter((b) => inRange(londonYmd(b.depositPaidAt), start, end));
    const depositsPaidTotal = round2(depositsPaid.reduce((a, b) => a + num(b.depositPaidAmount), 0));
    const moneyReceived = round2(invoicesPaidTotal + depositsPaidTotal);

    // Staff pay for completed work: booked hours ÷ people on the job × each cleaner's rate.
    const team = new Map<number, { id: number; name: string; jobs: number; hours: number; pay: number; ratings: number[]; timed: number; onTime: number }>();
    let staffPay = 0;
    for (const b of completed) {
        const ids = ctx.teamByBooking.get(Number(b.id)) ?? (b.assignedStaffId ? [Number(b.assignedStaffId)] : []);
        const people = Math.max(1, ids.length);
        const hours = num(asObject(b.propertyDetails).duration) > 0 ? num(asObject(b.propertyDetails).duration) : 2;
        const late = minutesLate(b);
        for (const sid of ids) {
            const s = ctx.staffById.get(sid);
            const share = hours / people;
            const pay = share * num(s?.hourlyRate);
            staffPay += pay;
            const t = team.get(sid) ?? { id: sid, name: String(s?.name || 'Cleaner').split(' ')[0], jobs: 0, hours: 0, pay: 0, ratings: [], timed: 0, onTime: 0 };
            t.jobs += 1;
            t.hours += share;
            t.pay += pay;
            if (num(b.rating) > 0) t.ratings.push(num(b.rating));
            if (late !== null) {
                t.timed += 1;
                if (late <= ON_TIME_GRACE_MIN) t.onTime += 1;
            }
            team.set(sid, t);
        }
    }
    staffPay = round2(staffPay);

    const periodExpenses = ctx.expenseRows.filter((e) => inRange(String(e.expenseDate || '').slice(0, 10), start, end));
    const expensesTotal = round2(periodExpenses.reduce((a, e) => a + num(e.amount), 0));
    const expensesByCategory: Record<string, number> = {};
    for (const e of periodExpenses) expensesByCategory[e.category || 'general'] = round2((expensesByCategory[e.category || 'general'] || 0) + num(e.amount));

    // Clients: first ever booking made in the period = new.
    const clientEmails = new Set(madeInPeriod.map((b) => String(b.contactEmail || '').trim().toLowerCase()).filter(Boolean));
    let newClients = 0;
    for (const email of clientEmails) {
        const first = ctx.firstBookingByEmail.get(email);
        if (first && first >= start) newClients += 1;
    }

    const byService: Record<string, { jobs: number; value: number }> = {};
    for (const b of completed) {
        const k = String(b.serviceType || 'Other');
        byService[k] = byService[k] ?? { jobs: 0, value: 0 };
        byService[k].jobs += 1;
        byService[k].value = round2(byService[k].value + num(b.totalPrice));
    }
    const byArea = { london: { jobs: 0, value: 0 }, outsideLondon: { jobs: 0, value: 0 } };
    for (const b of completed) {
        const london = b.priceRegion ? b.priceRegion === 'london' : isGreaterLondonPostcode(b.addressPostcode);
        const k = london ? 'london' : 'outsideLondon';
        byArea[k].jobs += 1;
        byArea[k].value = round2(byArea[k].value + num(b.totalPrice));
    }

    const ratings = completed.map((b) => num(b.rating)).filter((r) => r > 0);
    const lateTimes = completed.map(minutesLate).filter((m): m is number => m !== null);
    const lateNotices = dated.reduce((a, b) => a + asArray(b.lateNotices).length, 0);
    const periodAssessments = ctx.assessments.filter((a) => inRange(londonYmd(a.createdAt), start, end));

    const leadsIn = ctx.leads.filter((l) => inRange(londonYmd(l.createdAt), start, end));
    const quotesSent = ctx.offers.filter((o) => inRange(londonYmd(o.sentAt), start, end));
    const quotesAccepted = ctx.offers.filter((o) => o.status === 'accepted' && inRange(londonYmd(o.updatedAt), start, end));
    const converted = ctx.leads.filter((l) => l.status === 'converted' && inRange(londonYmd(l.statusUpdatedAt), start, end));
    const lost = ctx.leads.filter((l) => l.status === 'lost' && inRange(londonYmd(l.statusUpdatedAt), start, end));

    const onTimePct = lateTimes.length ? Math.round((lateTimes.filter((m) => m <= ON_TIME_GRACE_MIN).length / lateTimes.length) * 100) : null;
    const avgRating = avg(ratings);

    return {
        money: {
            moneyReceived,
            invoicesPaidTotal,
            invoicesPaidCount: invoicesPaid.length,
            depositsPaidTotal,
            depositsPaidCount: depositsPaid.length,
            completedValue,
            staffPay,
            expensesTotal,
            expensesByCategory,
            profit: round2(moneyReceived - staffPay - expensesTotal),
            averageJobValue: completed.length ? round2(completedValue / completed.length) : 0,
        },
        bookings: {
            completed: completed.length,
            scheduled: dated.filter((b) => b.status !== 'Cancelled').length,
            cancelled: cancelled.length,
            shortNoticeCancellations: cancelled.filter((b) => b.shortNoticeCancelFeeConsentedAt).length,
            newBookingsMade: madeInPeriod.length,
            newBookingsValue: round2(madeInPeriod.reduce((a, b) => a + num(b.totalPrice), 0)),
            newClients,
            returningClients: Math.max(0, clientEmails.size - newClients),
            byService: Object.entries(byService)
                .map(([service, v]) => ({ service, ...v }))
                .sort((a, z) => z.value - a.value),
            byArea,
        },
        sales: {
            quoteRequests: leadsIn.filter((l) => l.serviceType !== 'Pending').length,
            unfinishedQuoteRequests: leadsIn.filter((l) => l.serviceType === 'Pending').length,
            quotesSent: quotesSent.length,
            quotesSentValue: round2(quotesSent.reduce((a, o) => a + num(o.total), 0)),
            quotesAccepted: quotesAccepted.length,
            converted: converted.length,
            lost: lost.length,
            conversionRate: converted.length + lost.length ? Math.round((converted.length / (converted.length + lost.length)) * 100) : null,
        },
        quality: {
            averageRating: avgRating === null ? null : round2(avgRating),
            reviews: ratings.length,
            compliments: ratings.filter((r) => r >= 4).length,
            complaints: ratings.filter((r) => r <= 2).length,
            onTimePercent: onTimePct,
            timedJobs: lateTimes.length,
            lateNotices,
            supervisorScore: (() => {
                const v = avg(periodAssessments.map((a) => num(a.rating)).filter((r) => r > 0));
                return v === null ? null : round2(v);
            })(),
            assessments: periodAssessments.length,
        },
        team: [...team.values()]
            .map((t) => ({
                name: t.name,
                jobs: t.jobs,
                hours: round2(t.hours),
                pay: round2(t.pay),
                averageRating: t.ratings.length ? round2(avg(t.ratings) as number) : null,
                onTimePercent: t.timed ? Math.round((t.onTime / t.timed) * 100) : null,
            }))
            .sort((a, z) => z.jobs - a.jobs || z.hours - a.hours),
    };
}

type Figures = ReturnType<typeof periodFigures>;

/** Headline numbers shown as tiles with comparisons. */
const KPI_DEFS: { key: string; label: string; unit: 'money' | 'count' | 'percent' | 'rating'; pick: (f: Figures) => number | null; higherIsBetter: boolean }[] = [
    { key: 'moneyReceived', label: 'Money received', unit: 'money', pick: (f) => f.money.moneyReceived, higherIsBetter: true },
    { key: 'completedValue', label: 'Value of completed jobs', unit: 'money', pick: (f) => f.money.completedValue, higherIsBetter: true },
    { key: 'profit', label: 'Profit (received less pay and expenses)', unit: 'money', pick: (f) => f.money.profit, higherIsBetter: true },
    { key: 'completedJobs', label: 'Jobs completed', unit: 'count', pick: (f) => f.bookings.completed, higherIsBetter: true },
    { key: 'newBookings', label: 'New bookings made', unit: 'count', pick: (f) => f.bookings.newBookingsMade, higherIsBetter: true },
    { key: 'newClients', label: 'New clients', unit: 'count', pick: (f) => f.bookings.newClients, higherIsBetter: true },
    { key: 'cancellations', label: 'Cancellations', unit: 'count', pick: (f) => f.bookings.cancelled, higherIsBetter: false },
    { key: 'averageRating', label: 'Average client rating', unit: 'rating', pick: (f) => f.quality.averageRating, higherIsBetter: true },
    { key: 'onTimePercent', label: 'On-time arrivals', unit: 'percent', pick: (f) => f.quality.onTimePercent, higherIsBetter: true },
    { key: 'quoteRequests', label: 'Quote requests', unit: 'count', pick: (f) => f.sales.quoteRequests, higherIsBetter: true },
];

/** Builds the full report snapshot for a period (with the previous period and a 4-period average). */
export async function buildReport(db: any, start: string, end: string) {
    const length = daysBetween(start, end) + 1;
    const lookbackStart = addDays(start, -length * 4);
    const nextStart = addDays(end, 1);
    const nextEnd = addDays(end, 7);

    const bookingRows: any[] = await db
        .select()
        .from(bookings)
        .where(and(gte(bookings.date, lookbackStart), lte(bookings.date, nextEnd)));
    // Bookings paid or created in the window but dated outside it still count for money/new-booking figures.
    const extraRows: any[] = await db.select().from(bookings).where(gte(bookings.createdAt, new Date(`${lookbackStart}T00:00:00Z`)));
    const byId = new Map<number, any>();
    for (const b of [...bookingRows, ...extraRows]) byId.set(Number(b.id), b);
    const paidRows: any[] = await db.select().from(bookings).where(gte(bookings.depositPaidAt, new Date(`${lookbackStart}T00:00:00Z`)));
    for (const b of paidRows) byId.set(Number(b.id), b);
    const allRows = [...byId.values()];

    const ids = allRows.map((b) => Number(b.id));
    const teamRows: any[] = ids.length ? await db.select().from(bookingStaff).where(inArray(bookingStaff.bookingId, ids)) : [];
    const teamByBooking = new Map<number, number[]>();
    for (const t of teamRows) {
        const list = teamByBooking.get(Number(t.bookingId)) ?? [];
        list.push(Number(t.staffId));
        teamByBooking.set(Number(t.bookingId), list);
    }
    const staffRows: any[] = await db.select().from(staff);
    const staffById = new Map(staffRows.map((s) => [Number(s.id), s]));

    // First booking date per email (for new vs returning clients).
    const firstRows: any[] = await db
        .select({ email: bookings.contactEmail, createdAt: bookings.createdAt })
        .from(bookings)
        .where(lt(bookings.createdAt, new Date(`${addDays(end, 1)}T23:59:59Z`)));
    const firstBookingByEmail = new Map<string, string>();
    for (const r of firstRows) {
        const email = String(r.email || '').trim().toLowerCase();
        const day = londonYmd(r.createdAt);
        if (!email || !day) continue;
        const prev = firstBookingByEmail.get(email);
        if (!prev || day < prev) firstBookingByEmail.set(email, day);
    }

    const since = new Date(`${lookbackStart}T00:00:00Z`);
    const ctx: Ctx = {
        bookingRows: allRows,
        teamByBooking,
        staffById,
        invoices: await db.select().from(customerInvoices),
        expenseRows: await db.select().from(expenses).where(gte(expenses.expenseDate, lookbackStart)),
        leads: await db.select().from(quoteLeads).where(gte(quoteLeads.createdAt, new Date(`${addDays(lookbackStart, -60)}T00:00:00Z`))),
        offers: await db.select().from(quoteOffers).where(gte(quoteOffers.createdAt, since)),
        assessments: await db.select().from(staffAssessments).where(gte(staffAssessments.createdAt, since)),
        firstBookingByEmail,
    };

    const current = periodFigures(ctx, start, end);
    const prev = periodFigures(ctx, addDays(start, -length), addDays(start, -1));
    const history = [1, 2, 3, 4].map((i) => periodFigures(ctx, addDays(start, -length * i), addDays(start, -length * (i - 1) - 1)));

    const kpis = KPI_DEFS.map((d) => {
        const values = history.map(d.pick).filter((v): v is number => v !== null);
        const a = avg(values);
        return {
            key: d.key,
            label: d.label,
            unit: d.unit,
            higherIsBetter: d.higherIsBetter,
            value: d.pick(current),
            previous: d.pick(prev),
            average4: a === null ? null : round2(a),
        };
    });

    // Next week at a glance.
    const upcoming = allRows.filter((b) => inRange(String(b.date || '').slice(0, 10), nextStart, nextEnd) && b.status !== 'Cancelled');
    const unassigned = upcoming.filter((b) => !(teamByBooking.get(Number(b.id))?.length || b.assignedStaffId));
    const openInvoices = ctx.invoices.filter((i) => ['sent', 'overdue', 'pending'].includes(String(i.status)));
    const waitingLeads = ctx.leads.filter((l) => l.status === 'new' && l.createdAt && Date.now() - new Date(l.createdAt).getTime() > 24 * 3600000);

    const notes: string[] = [];
    const undatedDeposits = allRows.filter((b) => b.invoicePaid && !b.depositPaidAt).length;
    if (undatedDeposits) notes.push(`${undatedDeposits} older card deposit${undatedDeposits === 1 ? ' was' : 's were'} paid before payment dates were recorded, so ${undatedDeposits === 1 ? 'it is' : 'they are'} not in money received.`);
    if (!current.quality.timedJobs && current.bookings.completed) notes.push('No clock-in times were recorded for completed jobs, so on-time arrivals could not be measured.');

    return {
        version: 1,
        period: { start, end, days: length, label: prettyRange(start, end) },
        kpis,
        current,
        previous: prev,
        nextWeek: {
            start: nextStart,
            end: nextEnd,
            bookings: upcoming.length,
            expectedValue: round2(upcoming.reduce((a, b) => a + num(b.totalPrice), 0)),
            unassigned: unassigned.length,
        },
        attention: {
            unpaidInvoices: openInvoices.length,
            unpaidInvoicesTotal: round2(openInvoices.reduce((a, i) => a + num(i.total), 0)),
            quoteRequestsWaitingOver24h: waitingLeads.length,
        },
        notes,
    };
}

type Report = Awaited<ReturnType<typeof buildReport>>;

/* ───────────────────────── AI commentary ───────────────────────── */

type Commentary = { summary: string; watchOut: string[]; actions: string[] };

/**
 * Plain-English commentary from the figures only. No client names, emails or addresses are sent;
 * cleaners appear by first name. Returns null if AI is unavailable (the report still works).
 */
export async function writeCommentary(report: Report, brandName: string): Promise<Commentary | null> {
    const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) return null;
    try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey });
        const facts = {
            period: report.period,
            headline: report.kpis.map((k) => ({ metric: k.label, unit: k.unit, value: k.value, previousPeriod: k.previous, average4: k.average4, higherIsBetter: k.higherIsBetter })),
            money: report.current.money,
            bookings: { ...report.current.bookings, byService: report.current.bookings.byService.slice(0, 6) },
            sales: report.current.sales,
            quality: report.current.quality,
            team: report.current.team.slice(0, 12),
            nextWeek: report.nextWeek,
            attention: report.attention,
            dataNotes: report.notes,
        };
        const msg = await client.messages.create({
            model: AI_MODEL,
            max_tokens: 900,
            system:
                `You write the weekly business report for ${brandName}, a UK cleaning company. Use only the figures provided; never invent numbers. ` +
                'British English, plain and direct, no jargon, no em dashes. Money in pounds (£). Compare with the previous period and the 4-period average where useful. ' +
                'Reply with JSON only: {"summary": "2 to 4 sentences", "watchOut": ["up to 3 short points"], "actions": ["exactly 3 specific next steps"]}.',
            messages: [{ role: 'user', content: JSON.stringify(facts) }],
        });
        const text = msg.content
            .map((c: any) => (c.type === 'text' ? c.text : ''))
            .join('')
            .trim();
        const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        const clean = (v: unknown, n: number) => (Array.isArray(v) ? v.map((s) => String(s).replace(/—/g, ',').trim()).filter(Boolean).slice(0, n) : []);
        const summary = String(json.summary || '').replace(/—/g, ',').trim();
        if (!summary) return null;
        return { summary, watchOut: clean(json.watchOut, 3), actions: clean(json.actions, 3) };
    } catch (e: any) {
        console.error('[reports] AI commentary failed:', e?.message || e);
        return null;
    }
}

/* ───────────────────────── settings, saving, email ───────────────────────── */

type ReportSettings = { aiEnabled: boolean; emailEnabled: boolean; recipients: string };
const SETTINGS_KEY = 'reportSettings';

async function loadSettings(db: any): Promise<ReportSettings> {
    const [row] = await db.select().from(businessSettings).where(eq(businessSettings.key, SETTINGS_KEY)).limit(1);
    const v = asObject(row?.value);
    return {
        aiEnabled: v.aiEnabled !== false,
        emailEnabled: v.emailEnabled !== false,
        recipients: typeof v.recipients === 'string' ? v.recipients : '',
    };
}

async function saveSettings(db: any, s: ReportSettings): Promise<void> {
    const value = JSON.stringify(s);
    const [row] = await db.select().from(businessSettings).where(eq(businessSettings.key, SETTINGS_KEY)).limit(1);
    if (row) await db.update(businessSettings).set({ value }).where(eq(businessSettings.key, SETTINGS_KEY));
    else await db.insert(businessSettings).values({ key: SETTINGS_KEY, value });
}

function toApi(row: any) {
    return {
        id: Number(row.id),
        kind: row.kind,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        data: asObject(row.data),
        ai: row.ai ? asObject(row.ai) : null,
        aiModel: row.aiModel,
        emailedAt: row.emailedAt ? new Date(row.emailedAt).toISOString() : null,
        createdBy: row.createdBy,
        generatedAt: row.generatedAt ? new Date(row.generatedAt).toISOString() : null,
    };
}

function escapeHtml(s: string): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatKpi(unit: string, v: number | null): string {
    if (v === null || v === undefined) return '-';
    if (unit === 'money') return `£${v.toFixed(2)}`;
    if (unit === 'percent') return `${v}%`;
    if (unit === 'rating') return v.toFixed(1);
    return String(v);
}

async function emailReport(db: any, row: any, recipients: string[], adminUrl: string): Promise<void> {
    const r = toApi(row);
    const data = r.data as Report;
    const brand = await loadBrandVars(db);
    const primary = brand.brand_primary || '#0d9488';
    const kpiRows = data.kpis
        .slice(0, 8)
        .map((k) => {
            const change = k.value !== null && k.previous !== null ? k.value - k.previous : null;
            const good = change === null || change === 0 ? null : change > 0 === k.higherIsBetter;
            const arrow = change === null || change === 0 ? '' : `<span style="color:${good ? '#059669' : '#dc2626'};font-size:12px;"> ${change > 0 ? '▲' : '▼'} ${formatKpi(k.unit, Math.abs(round2(change)))}</span>`;
            return `<tr><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;font-size:14px;color:#475569;">${escapeHtml(k.label)}</td><td style="padding:7px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-size:15px;font-weight:700;color:#0f172a;white-space:nowrap;">${formatKpi(k.unit, k.value)}${arrow}</td></tr>`;
        })
        .join('');
    const ai = r.ai as Commentary | null;
    const list = (title: string, items: string[]) =>
        items.length ? `<p style="margin:14px 0 6px;font-weight:700;color:#0f172a;">${title}</p><ul style="margin:0;padding-left:18px;color:#334155;">${items.map((i) => `<li style="margin:4px 0;">${escapeHtml(i)}</li>`).join('')}</ul>` : '';
    const aiHtml = ai
        ? `<div style="margin-top:16px;padding:14px 16px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;">
  <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${escapeHtml(primary)};">Summary (written by AI from the figures)</p>
  <p style="margin:0;color:#334155;line-height:1.6;">${escapeHtml(ai.summary)}</p>
  ${list('Watch out for', ai.watchOut)}${list('Suggested actions', ai.actions)}
</div>`
        : '';
    const { subject, html } = await renderTransactionalEmail(db, 'admin_weekly_report', {
        ...brand,
        period_label: escapeHtml(data.period.label),
        money_received: (data.kpis.find((k) => k.key === 'moneyReceived')?.value ?? 0).toFixed(2),
        jobs_completed: String(data.current.bookings.completed),
        kpi_table: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${kpiRows}</table>`,
        ai_summary: aiHtml,
        next_week_line: escapeHtml(
            `${data.nextWeek.bookings} booking${data.nextWeek.bookings === 1 ? '' : 's'} next week worth £${data.nextWeek.expectedValue.toFixed(2)}` +
                (data.nextWeek.unassigned ? `, ${data.nextWeek.unassigned} still without a cleaner.` : '.'),
        ),
        report_url: adminUrl,
    });
    await sendEmail({ to: recipients.map((email) => ({ email })), subject, htmlContent: html });
    await db.update(businessReports).set({ emailedAt: new Date() }).where(eq(businessReports.id, r.id));
}

/** Business inbox by default, or the comma-separated list in report settings. */
async function recipientsFor(db: any, settings: ReportSettings): Promise<string[]> {
    const own = settings.recipients
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
    if (own.length) return [...new Set(own)].slice(0, 10);
    const env = process.env.ADMIN_BOOKING_EMAIL?.trim();
    if (env) return [env];
    const brand = await loadBrandVars(db);
    return brand.brand_email ? [brand.brand_email] : [];
}

/** Builds, saves (replacing a weekly report for the same week) and optionally adds AI commentary. */
async function generateAndSave(db: any, opts: { start: string; end: string; kind: 'weekly' | 'custom'; withAi: boolean; createdBy: string }) {
    const data = await buildReport(db, opts.start, opts.end);
    const brand = await loadBrandVars(db);
    const ai = opts.withAi ? await writeCommentary(data, brand.brand_name || 'CiN Cleaning') : null;
    if (opts.kind === 'weekly') {
        const existing = await db
            .select({ id: businessReports.id })
            .from(businessReports)
            .where(and(eq(businessReports.kind, 'weekly'), eq(businessReports.periodStart, opts.start)));
        if (existing.length) {
            await db
                .update(businessReports)
                .set({ data, ai, aiModel: ai ? AI_MODEL : null, generatedAt: new Date(), createdBy: opts.createdBy })
                .where(eq(businessReports.id, existing[0].id));
            const [row] = await db.select().from(businessReports).where(eq(businessReports.id, existing[0].id)).limit(1);
            return row;
        }
    }
    const inserted = await db.insert(businessReports).values({
        kind: opts.kind,
        periodStart: opts.start,
        periodEnd: opts.end,
        data,
        ai,
        aiModel: ai ? AI_MODEL : null,
        createdBy: opts.createdBy,
    });
    const id = Number((inserted as any)?.[0]?.insertId ?? (inserted as any)?.insertId);
    const [row] = await db.select().from(businessReports).where(eq(businessReports.id, id)).limit(1);
    return row;
}

/* ───────────────────────── schedule + routes ───────────────────────── */

/** Every Monday from 7am UK time: build last week's report once, email it and alert admins. */
export function startWeeklyReportSchedule(db: any, deps: Pick<Deps, 'absoluteSiteUrl' | 'notifyAdmins'>): void {
    let running = false;
    const tick = async () => {
        if (running) return;
        const now = londonNow();
        if (now.weekday !== 1 || now.hour < 7) return;
        const week = previousWeek(now.ymd);
        running = true;
        try {
            const existing = await db
                .select({ id: businessReports.id })
                .from(businessReports)
                .where(and(eq(businessReports.kind, 'weekly'), eq(businessReports.periodStart, week.start)));
            if (existing.length) return;
            const settings = await loadSettings(db);
            const row = await generateAndSave(db, { ...week, kind: 'weekly', withAi: settings.aiEnabled, createdBy: 'automatic' });
            const label = (asObject(row.data) as Report).period.label;
            if (settings.emailEnabled) {
                const to = await recipientsFor(db, settings);
                if (to.length) await emailReport(db, row, to, deps.absoluteSiteUrl('/admin')).catch((e) => console.error('[reports] email failed:', e?.message || e));
            }
            await deps.notifyAdmins(`Weekly report ready: ${label}. Open Reports in the admin dashboard.`);
            console.log(`[reports] weekly report generated for ${label}`);
        } catch (e) {
            console.error('[reports] weekly schedule failed:', e);
        } finally {
            running = false;
        }
    };
    setInterval(() => void tick(), 20 * 60 * 1000);
    setTimeout(() => void tick(), 90_000);
}

export function registerBusinessReportRoutes(app: Express, db: any, deps: Deps): void {
    const { authenticateToken, requireAdmin, absoluteSiteUrl } = deps;
    const okDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

    app.get('/api/admin/reports', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const rows = await db.select().from(businessReports).orderBy(desc(businessReports.periodStart), desc(businessReports.generatedAt)).limit(200);
            res.json(
                rows.map((r: any) => {
                    const d = asObject(r.data) as Report;
                    const k = (key: string) => d.kpis?.find((x) => x.key === key)?.value ?? null;
                    return {
                        id: Number(r.id),
                        kind: r.kind,
                        periodStart: r.periodStart,
                        periodEnd: r.periodEnd,
                        label: d.period?.label || `${r.periodStart} to ${r.periodEnd}`,
                        generatedAt: r.generatedAt ? new Date(r.generatedAt).toISOString() : null,
                        emailedAt: r.emailedAt ? new Date(r.emailedAt).toISOString() : null,
                        hasAi: !!r.ai,
                        headline: { moneyReceived: k('moneyReceived'), completedJobs: k('completedJobs'), profit: k('profit') },
                    };
                }),
            );
        } catch (e) {
            console.error('[reports] list', e);
            res.status(500).json({ error: 'Failed to load reports' });
        }
    });

    app.get('/api/admin/reports/settings', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        const s = await loadSettings(db);
        res.json({ ...s, defaultRecipients: (await recipientsFor(db, { ...s, recipients: '' })).join(', '), aiAvailable: !!String(process.env.ANTHROPIC_API_KEY || '').trim() });
    });

    app.put('/api/admin/reports/settings', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        const s: ReportSettings = {
            aiEnabled: req.body?.aiEnabled !== false,
            emailEnabled: req.body?.emailEnabled !== false,
            recipients: String(req.body?.recipients ?? '').slice(0, 500),
        };
        await saveSettings(db, s);
        res.json(s);
    });

    app.get('/api/admin/reports/:id', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        const [row] = await db.select().from(businessReports).where(eq(businessReports.id, Number(req.params.id))).limit(1);
        if (!row) return res.status(404).json({ error: 'Report not found' });
        res.json(toApi(row));
    });

    /** Generate now: a Monday to Sunday week is saved as that week's report; any other range as a custom report. */
    app.post('/api/admin/reports/generate', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            let { start, end } = req.body || {};
            if (!okDate(start) || !okDate(end)) {
                const w = previousWeek(londonNow().ymd);
                start = w.start;
                end = w.end;
            }
            if (start > end) return res.status(400).json({ error: 'The start date must be before the end date.' });
            if (daysBetween(start, end) > 400) return res.status(400).json({ error: 'Choose a range of up to about a year.' });
            const [sy, sm, sd] = String(start).split('-').map(Number);
            const isWeek = new Date(Date.UTC(sy, sm - 1, sd)).getUTCDay() === 1 && daysBetween(start, end) === 6;
            const settings = await loadSettings(db);
            const withAi = req.body?.ai === undefined ? settings.aiEnabled : req.body.ai === true;
            const row = await generateAndSave(db, {
                start,
                end,
                kind: isWeek ? 'weekly' : 'custom',
                withAi,
                createdBy: String(req.user?.email || 'admin').slice(0, 160),
            });
            res.status(201).json(toApi(row));
        } catch (e) {
            console.error('[reports] generate', e);
            res.status(500).json({ error: 'Failed to build the report' });
        }
    });

    /** Rewrite the AI commentary for a saved report (figures stay as they were). */
    app.post('/api/admin/reports/:id/ai', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const [row] = await db.select().from(businessReports).where(eq(businessReports.id, Number(req.params.id))).limit(1);
            if (!row) return res.status(404).json({ error: 'Report not found' });
            const brand = await loadBrandVars(db);
            const ai = await writeCommentary(asObject(row.data) as Report, brand.brand_name || 'CiN Cleaning');
            if (!ai) return res.status(502).json({ error: 'The AI summary is unavailable right now. The figures are unaffected.' });
            await db.update(businessReports).set({ ai, aiModel: AI_MODEL }).where(eq(businessReports.id, row.id));
            const [updated] = await db.select().from(businessReports).where(eq(businessReports.id, row.id)).limit(1);
            res.json(toApi(updated));
        } catch (e) {
            console.error('[reports] ai', e);
            res.status(500).json({ error: 'Failed to write the summary' });
        }
    });

    app.post('/api/admin/reports/:id/email', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const [row] = await db.select().from(businessReports).where(eq(businessReports.id, Number(req.params.id))).limit(1);
            if (!row) return res.status(404).json({ error: 'Report not found' });
            const to = await recipientsFor(db, await loadSettings(db));
            if (!to.length) return res.status(400).json({ error: 'Add a recipient email in report settings.' });
            await emailReport(db, row, to, absoluteSiteUrl('/admin'));
            res.json({ sentTo: to });
        } catch (e: any) {
            console.error('[reports] email', e?.message || e);
            res.status(502).json({ error: 'The email could not be sent. Check the email settings and try again.' });
        }
    });

    app.delete('/api/admin/reports/:id', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        await db.delete(businessReports).where(eq(businessReports.id, Number(req.params.id)));
        res.json({ message: 'Report deleted' });
    });
}
