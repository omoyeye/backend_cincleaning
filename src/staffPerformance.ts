import type { Express } from 'express';
import { desc, eq, inArray } from 'drizzle-orm';
import { bookingStaff, bookings, staff, staffAssessments, users } from './schema';

type Auth = (req: any, res: any, next: any) => void;

/** Arrivals up to this many minutes after the booked start count as on time (same as the admin profile). */
const ON_TIME_GRACE_MIN = 5;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

function dateOnly(raw: unknown): string {
    if (raw instanceof Date) return ymd(raw);
    return String(raw || '').slice(0, 10);
}

function startMs(date: string, time: unknown): number | null {
    const m = String(time || '').match(/^(\d{1,2}):(\d{2})/);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !m) return null;
    const [y, mo, d] = date.split('-').map(Number);
    return new Date(y, mo - 1, d, Number(m[1]), Number(m[2])).getTime();
}

/** Clock-in from the staff app: ISO timestamp first, then "10:05" / "10:05 AM" on the job date. */
function clockMs(iso: unknown, label: unknown, date: string): number | null {
    if (typeof iso === 'string' && iso) {
        const t = Date.parse(iso);
        if (Number.isFinite(t)) return t;
    }
    const m = String(label || '').match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?/i);
    if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    let h = Number(m[1]);
    const ap = m[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const [y, mo, d] = date.split('-').map(Number);
    return new Date(y, mo - 1, d, h, Number(m[2])).getTime();
}

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

const avg = (list: number[]) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

/**
 * A cleaner's own performance, worked out on the server so the website and the app show the same
 * numbers. Pay uses the weekly-invoice rule: booked hours ÷ people on the job × hourly rate.
 */
export function registerStaffPerformanceRoutes(app: Express, db: any, authenticateToken: Auth): void {
    app.get('/api/staff/me/performance', authenticateToken, async (req: any, res) => {
        try {
            if (req.user?.role !== 'staff') return res.status(403).json({ error: 'Staff only' });
            const [me] = await db.select().from(staff).where(eq(staff.userId, Number(req.user.id))).limit(1);
            if (!me) return res.status(404).json({ error: 'Staff profile not found' });
            const sid = Number(me.id);
            const rate = Number(me.hourlyRate || 0);

            // Every job ever assigned (multi-assign table + legacy single column).
            const assigned = await db.select().from(bookingStaff).where(eq(bookingStaff.staffId, sid));
            const ids = new Set<number>(assigned.map((a: any) => Number(a.bookingId)).filter((n: number) => Number.isFinite(n)));
            const legacy = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.assignedStaffId, sid));
            legacy.forEach((b: any) => ids.add(Number(b.id)));
            const rows: any[] = ids.size ? await db.select().from(bookings).where(inArray(bookings.id, [...ids])) : [];

            // Team size per job.
            const teamRows: any[] = rows.length
                ? await db.select().from(bookingStaff).where(inArray(bookingStaff.bookingId, rows.map((r) => Number(r.id))))
                : [];
            const team = new Map<number, number>();
            teamRows.forEach((t) => team.set(Number(t.bookingId), (team.get(Number(t.bookingId)) || 0) + 1));

            const now = new Date();
            const today = ymd(now);
            const monday = new Date(now);
            monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
            const weekStart = ymd(monday);
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            const weekEnd = ymd(sunday);
            const monthStart = `${today.slice(0, 7)}-01`;

            const jobs = rows
                .map((b) => {
                    const date = dateOnly(b.date);
                    const pd = asObject(b.propertyDetails);
                    const bookedHours = Number(pd.duration) > 0 ? Number(pd.duration) : 2;
                    const people = Math.max(1, team.get(Number(b.id)) || (b.assignedStaffId ? 1 : 1));
                    const yourHours = bookedHours / people;
                    const wc = asObject(b.workCompletion);
                    const start = startMs(date, b.time);
                    let arrived = clockMs(wc.clockInAtIso, wc.clockInTime, date);
                    if (arrived === null && b.arrivedAt) {
                        const t = new Date(b.arrivedAt).getTime();
                        arrived = Number.isFinite(t) ? t : null;
                    }
                    const minutesLate = start !== null && arrived !== null ? Math.round((arrived - start) / 60000) : null;
                    return {
                        id: Number(b.id),
                        ref: b.bookingId || null,
                        date,
                        time: b.time || '',
                        service: b.serviceType || 'Cleaning',
                        client: String(b.contactName || 'Client').split(' ')[0],
                        status: String(b.status || ''),
                        hours: round2(yourHours),
                        pay: round2(yourHours * rate),
                        minutesLate,
                        onTime: minutesLate === null ? null : minutesLate <= ON_TIME_GRACE_MIN,
                        rating: Number(b.rating) > 0 ? Number(b.rating) : null,
                        feedback: b.feedback ? String(b.feedback) : null,
                        lateNotices: asArray(b.lateNotices).length,
                    };
                })
                .sort((a, z) => `${z.date} ${z.time}`.localeCompare(`${a.date} ${a.time}`));

            const completed = jobs.filter((j) => j.status === 'Completed');
            const upcoming = jobs.filter((j) => (j.status === 'Pending' || j.status === 'Confirmed') && j.date >= today);
            const cancelled = jobs.filter((j) => j.status === 'Cancelled');
            const earned = (list: typeof jobs) => round2(list.reduce((a, j) => a + j.pay, 0));
            const rated = jobs.filter((j) => j.rating);
            const timed = jobs.filter((j) => j.onTime !== null);

            const assessmentRows: any[] = await db
                .select()
                .from(staffAssessments)
                .where(eq(staffAssessments.staffId, sid))
                .orderBy(desc(staffAssessments.createdAt));
            const assessments = assessmentRows.map((a) => ({
                id: Number(a.id),
                bookingId: a.bookingId ?? null,
                assessorName: a.assessorName,
                rating: Number(a.rating),
                punctuality: a.punctuality ?? null,
                quality: a.quality ?? null,
                professionalism: a.professionalism ?? null,
                remark: a.remark,
                createdAt: a.createdAt ? new Date(a.createdAt).toISOString() : null,
            }));
            const scores = (k: 'rating' | 'punctuality' | 'quality' | 'professionalism') =>
                avg(assessments.map((a) => a[k]).filter((v): v is number => typeof v === 'number' && v > 0));

            // Last six calendar months, oldest first.
            const months: { month: string; label: string; jobs: number; earned: number; hours: number; avgRating: number | null }[] = [];
            for (let i = 5; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
                const inMonth = completed.filter((j) => j.date.startsWith(key));
                const r = avg(inMonth.map((j) => j.rating).filter((v): v is number => !!v));
                months.push({
                    month: key,
                    label: d.toLocaleDateString('en-GB', { month: 'short' }),
                    jobs: inMonth.length,
                    earned: earned(inMonth),
                    hours: round2(inMonth.reduce((a, j) => a + j.hours, 0)),
                    avgRating: r === null ? null : round2(r),
                });
            }

            let joinedAt: string | null = null;
            if (me.userId) {
                const [u] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, Number(me.userId))).limit(1);
                if (u?.createdAt) joinedAt = new Date(u.createdAt).toISOString();
            }

            const finished = completed.length + cancelled.length;
            const avgClient = avg(rated.map((j) => j.rating as number));
            const supervisor = scores('rating');
            res.json({
                staff: { id: sid, name: me.name, role: me.role, status: me.status, hourlyRate: rate, joinedAt },
                summary: {
                    completed: completed.length,
                    upcoming: upcoming.length,
                    cancelled: cancelled.length,
                    hoursWorked: round2(completed.reduce((a, j) => a + j.hours, 0)),
                    totalEarned: earned(completed),
                    todayEarned: earned(completed.filter((j) => j.date === today)),
                    todayScheduled: earned(upcoming.filter((j) => j.date === today)),
                    weekEarned: earned(completed.filter((j) => j.date >= weekStart && j.date <= weekEnd)),
                    monthEarned: earned(completed.filter((j) => j.date >= monthStart && j.date <= today)),
                    avgClientRating: avgClient === null ? null : round2(avgClient),
                    reviewCount: rated.length,
                    compliments: rated.filter((j) => (j.rating as number) >= 4).length,
                    complaints: rated.filter((j) => (j.rating as number) <= 2).length,
                    punctualityPercent: timed.length ? Math.round((timed.filter((j) => j.onTime).length / timed.length) * 100) : null,
                    timedJobs: timed.length,
                    lateNotices: jobs.reduce((a, j) => a + j.lateNotices, 0),
                    completionRate: finished ? Math.round((completed.length / finished) * 100) : null,
                    supervisorScore: supervisor === null ? null : round2(supervisor),
                    assessmentCount: assessments.length,
                    supervisorBreakdown: {
                        punctuality: scores('punctuality'),
                        quality: scores('quality'),
                        professionalism: scores('professionalism'),
                    },
                },
                months,
                reviews: rated.slice(0, 20).map((j) => ({ id: j.id, ref: j.ref, date: j.date, client: j.client, service: j.service, rating: j.rating, feedback: j.feedback })),
                assessments,
                recentJobs: jobs.filter((j) => j.status === 'Completed' || j.status === 'Cancelled').slice(0, 25),
            });
        } catch (e) {
            console.error('[performance] me', e);
            res.status(500).json({ error: 'Failed to load performance' });
        }
    });
}
