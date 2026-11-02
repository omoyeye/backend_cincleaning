import type { Express } from 'express';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { bookingStaff, bookings, notifications, staff, staffAssessments, superadmins, users } from './schema';
import { broadcastSync } from './realtime';
import { pushUsers } from './notify';
import { jobChecklist } from './jobChecklists';

type Auth = (req: any, res: any, next: any) => void;

const SUPERVISOR_ROLES = new Set(['supervisor', 'manager']);

type CheckResult = { task: string; result: 'pass' | 'fail' | 'na'; note?: string };

/** Task-by-task results from a field quality check; null when none were sent, 'invalid' when malformed. */
function parseChecklist(v: unknown): CheckResult[] | null | 'invalid' {
    if (v === null || v === undefined) return null;
    if (!Array.isArray(v) || v.length > 40) return 'invalid';
    const out: CheckResult[] = [];
    for (const raw of v) {
        const task = String((raw as any)?.task ?? '').trim().slice(0, 200);
        const result = (raw as any)?.result;
        if (!task || !['pass', 'fail', 'na'].includes(result)) return 'invalid';
        const note = String((raw as any)?.note ?? '').trim().slice(0, 300);
        out.push(note ? { task, result, note } : { task, result });
    }
    return out.length ? out : null;
}

function score(v: unknown, required: boolean): number | null | 'invalid' {
    if (v === null || v === undefined || v === '') return required ? 'invalid' : null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 'invalid';
}

async function callerStaffRow(db: any, req: any) {
    if (req.user?.role !== 'staff') return null;
    const [row] = await db.select().from(staff).where(eq(staff.userId, Number(req.user.id))).limit(1);
    return row ?? null;
}

function parseStored(v: unknown): any {
    if (typeof v !== 'string') return v ?? null;
    try { return JSON.parse(v); } catch { return null; }
}

/** Admins and staff with the Supervisor/Manager role may assess; cleaners may read their own. */
async function access(db: any, req: any, targetStaffId: number): Promise<{ canRead: boolean; canWrite: boolean; me: any }> {
    if (req.user?.role === 'admin' || req.user?.isSuperadmin) return { canRead: true, canWrite: true, me: null };
    const me = await callerStaffRow(db, req);
    if (!me) return { canRead: false, canWrite: false, me: null };
    const isSupervisor = SUPERVISOR_ROLES.has(String(me.role || '').toLowerCase());
    const isSelf = Number(me.id) === targetStaffId;
    return { canRead: isSelf || isSupervisor, canWrite: isSupervisor && !isSelf, me };
}

export function registerStaffAssessmentRoutes(app: Express, db: any, authenticateToken: Auth): void {
    app.get('/api/staff/:id/assessments', authenticateToken, async (req: any, res) => {
        try {
            const staffId = Number(req.params.id);
            if (!Number.isFinite(staffId)) return res.status(400).json({ error: 'Invalid staff id' });
            const { canRead } = await access(db, req, staffId);
            if (!canRead) return res.status(403).json({ error: 'Unauthorized' });
            const rows = await db
                .select()
                .from(staffAssessments)
                .where(eq(staffAssessments.staffId, staffId))
                .orderBy(desc(staffAssessments.createdAt));
            const bookingIds = [...new Set(rows.map((r: any) => r.bookingId).filter(Boolean))] as number[];
            const refs = bookingIds.length
                ? await db
                      .select({ id: bookings.id, bookingId: bookings.bookingId, date: bookings.date, contactName: bookings.contactName })
                      .from(bookings)
                      .where(inArray(bookings.id, bookingIds))
                : [];
            const byId = new Map(refs.map((b: any) => [Number(b.id), b]));
            res.json(
                rows.map((r: any) => {
                    const b: any = r.bookingId ? byId.get(Number(r.bookingId)) : null;
                    return {
                        ...r,
                        checklist: parseStored(r.checklist),
                        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
                        booking: b ? { id: Number(b.id), bookingId: b.bookingId, date: b.date, clientName: b.contactName } : null,
                    };
                }),
            );
        } catch (e) {
            console.error('[assessments] list', e);
            res.status(500).json({ error: 'Failed to load assessments' });
        }
    });

    app.post('/api/staff/:id/assessments', authenticateToken, async (req: any, res) => {
        try {
            const staffId = Number(req.params.id);
            const [target] = await db.select().from(staff).where(eq(staff.id, staffId)).limit(1);
            if (!target) return res.status(404).json({ error: 'Staff member not found' });
            const { canWrite, me } = await access(db, req, staffId);
            if (!canWrite) return res.status(403).json({ error: 'Only admins and supervisors can add assessments.' });

            const body = (req.body || {}) as Record<string, unknown>;
            const rating = score(body.rating, true);
            const punctuality = score(body.punctuality, false);
            const quality = score(body.quality, false);
            const professionalism = score(body.professionalism, false);
            if ([rating, punctuality, quality, professionalism].includes('invalid')) {
                return res.status(400).json({ error: 'Scores must be whole numbers from 1 to 5 (overall score is required).' });
            }
            const checklist = parseChecklist(body.checklist);
            if (checklist === 'invalid') return res.status(400).json({ error: 'Each checklist task needs a pass, fail or n/a result.' });
            const remark = String(body.remark ?? '').trim().slice(0, 2000);
            if (remark.length < 3) return res.status(400).json({ error: 'Please write a short remark about the assessment.' });

            let bookingId: number | null = null;
            if (body.bookingId !== undefined && body.bookingId !== null && body.bookingId !== '') {
                bookingId = Number(body.bookingId);
                const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
                const links = b ? await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, bookingId)) : [];
                const assigned = b && (Number(b.assignedStaffId) === staffId || links.some((l: any) => Number(l.staffId) === staffId));
                if (!assigned) return res.status(400).json({ error: 'That job is not assigned to this cleaner.' });
            }

            let assessorName = 'Admin';
            if (me) assessorName = me.name;
            else if (req.user?.isSuperadmin) {
                const [s] = await db.select().from(superadmins).where(eq(superadmins.id, Number(req.user.id))).limit(1);
                if (s?.name) assessorName = s.name;
            } else {
                const [u] = await db.select().from(users).where(eq(users.id, Number(req.user.id))).limit(1);
                if (u?.name) assessorName = u.name;
            }

            const [created] = await db
                .insert(staffAssessments)
                .values({
                    staffId,
                    bookingId,
                    assessorUserId: Number(req.user.id) || null,
                    assessorName,
                    rating: rating as number,
                    punctuality: punctuality as number | null,
                    quality: quality as number | null,
                    professionalism: professionalism as number | null,
                    remark,
                    checklist,
                })
                .$returningId();

            if (target.userId) {
                await db.insert(notifications).values({
                    userId: Number(target.userId),
                    type: 'system',
                    message: `New on-the-job assessment from ${assessorName}: ${rating}/5${checklist ? ` (${checklist.filter((c) => c.result === 'pass').length}/${checklist.filter((c) => c.result !== 'na').length} tasks passed)` : ''}. "${remark.slice(0, 120)}${remark.length > 120 ? '...' : ''}"`,
                    isRead: false,
                });
                pushUsers([Number(target.userId)], 'New assessment from ' + assessorName, rating + '/5: ' + remark.slice(0, 120), { type: 'assessment' });
                broadcastSync('notifications');
            }
            res.status(201).json({ id: created.id });
        } catch (e) {
            console.error('[assessments] create', e);
            res.status(500).json({ error: 'Failed to save assessment' });
        }
    });

    /**
     * Quality checks: finished jobs a supervisor can assess in the field against the job's task list.
     * Unchecked jobs come first. A supervisor never assesses themselves.
     */
    async function qaCaller(req: any): Promise<{ ok: boolean; myStaffId: number | null }> {
        if (req.user?.role === 'admin' || req.user?.isSuperadmin) return { ok: true, myStaffId: null };
        const me = await callerStaffRow(db, req);
        if (!me || !SUPERVISOR_ROLES.has(String(me.role || '').toLowerCase())) return { ok: false, myStaffId: null };
        return { ok: true, myStaffId: Number(me.id) };
    }

    async function qaJobs(rows: any[], myStaffId: number | null) {
        if (!rows.length) return [];
        const ids = rows.map((b) => Number(b.id));
        const links = await db.select().from(bookingStaff).where(inArray(bookingStaff.bookingId, ids));
        const staffIds = new Set<number>();
        for (const b of rows) if (b.assignedStaffId) staffIds.add(Number(b.assignedStaffId));
        for (const l of links) staffIds.add(Number(l.staffId));
        const people = staffIds.size
            ? await db.select({ id: staff.id, name: staff.name, imageUrl: staff.imageUrl }).from(staff).where(inArray(staff.id, [...staffIds]))
            : [];
        const personById = new Map(people.map((p: any) => [Number(p.id), p]));
        const done = await db.select().from(staffAssessments).where(inArray(staffAssessments.bookingId, ids));

        return rows.map((b) => {
            const team = new Set<number>();
            if (b.assignedStaffId) team.add(Number(b.assignedStaffId));
            for (const l of links) if (Number(l.bookingId) === Number(b.id)) team.add(Number(l.staffId));
            let wc: any = parseStored(b.workCompletion);
            if (!wc || typeof wc !== 'object') wc = {};
            const cleaners = [...team]
                .filter((sid) => sid !== myStaffId)
                .map((sid) => {
                    const p: any = personById.get(sid);
                    const a: any = done
                        .filter((x: any) => Number(x.bookingId) === Number(b.id) && Number(x.staffId) === sid)
                        .sort((x: any, y: any) => Number(y.id) - Number(x.id))[0];
                    return {
                        id: sid,
                        name: p?.name || 'Cleaner',
                        imageUrl: p?.imageUrl || null,
                        assessment: a
                            ? {
                                  id: Number(a.id),
                                  rating: a.rating,
                                  assessorName: a.assessorName,
                                  remark: a.remark,
                                  checklist: parseStored(a.checklist),
                                  createdAt: a.createdAt ? new Date(a.createdAt).toISOString() : null,
                              }
                            : null,
                    };
                });
            return {
                id: Number(b.id),
                ref: b.bookingId,
                date: b.date,
                time: b.time,
                serviceType: b.serviceType,
                status: b.status,
                clientName: b.contactName,
                address: [b.addressLine1, b.addressCity, b.addressPostcode].filter(Boolean).join(', '),
                finishedAt: typeof wc.clockOutAtIso === 'string' ? wc.clockOutAtIso : null,
                cleanerNotes: typeof wc.notes === 'string' ? wc.notes : null,
                cleanerIssues: typeof wc.issues === 'string' ? wc.issues : null,
                photos: Array.isArray(wc.photos) ? wc.photos.filter((u: unknown) => typeof u === 'string' && /^https?:/.test(u)).slice(0, 8) : [],
                checklist: jobChecklist(b.serviceType, wc),
                cleaners,
                checked: cleaners.length > 0 && cleaners.every((c) => c.assessment),
            };
        }).filter((j) => j.cleaners.length > 0);
    }

    app.get('/api/qa/jobs', authenticateToken, async (req: any, res) => {
        try {
            const { ok, myStaffId } = await qaCaller(req);
            if (!ok) return res.status(403).json({ error: 'Quality checks are for supervisors and managers.' });
            const since = new Date(Date.now() - 30 * 86400000);
            const p = (n: number) => String(n).padStart(2, '0');
            const sinceYmd = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())}`;
            const rows = await db
                .select()
                .from(bookings)
                .where(and(eq(bookings.status, 'Completed'), gte(bookings.date, sinceYmd)))
                .orderBy(desc(bookings.date), desc(bookings.time))
                .limit(150);
            const jobs = await qaJobs(rows, myStaffId);
            jobs.sort((a, b) => Number(a.checked) - Number(b.checked));
            res.json(jobs);
        } catch (e) {
            console.error('[qa] list', e);
            res.status(500).json({ error: 'Failed to load quality checks' });
        }
    });

    app.get('/api/qa/jobs/:id', authenticateToken, async (req: any, res) => {
        try {
            const { ok, myStaffId } = await qaCaller(req);
            if (!ok) return res.status(403).json({ error: 'Quality checks are for supervisors and managers.' });
            const rows = await db.select().from(bookings).where(eq(bookings.id, Number(req.params.id))).limit(1);
            if (!rows.length || rows[0].status !== 'Completed') return res.status(404).json({ error: 'Finished job not found' });
            const [job] = await qaJobs(rows, myStaffId);
            if (!job) return res.status(404).json({ error: 'There is nobody on this job for you to assess.' });
            res.json(job);
        } catch (e) {
            console.error('[qa] job', e);
            res.status(500).json({ error: 'Failed to load the job' });
        }
    });

    app.delete('/api/staff-assessments/:id', authenticateToken, async (req: any, res) => {
        if (req.user?.role !== 'admin' && !req.user?.isSuperadmin) return res.status(403).json({ error: 'Admin only' });
        try {
            await db.delete(staffAssessments).where(eq(staffAssessments.id, Number(req.params.id)));
            res.json({ ok: true });
        } catch (e) {
            console.error('[assessments] delete', e);
            res.status(500).json({ error: 'Failed to delete assessment' });
        }
    });
}
