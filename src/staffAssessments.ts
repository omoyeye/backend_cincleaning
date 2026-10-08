import type { Express } from 'express';
import { desc, eq, inArray } from 'drizzle-orm';
import { bookingStaff, bookings, notifications, staff, staffAssessments, superadmins, users } from './schema';
import { broadcastSync } from './realtime';
import { pushUsers } from './notify';

type Auth = (req: any, res: any, next: any) => void;

const SUPERVISOR_ROLES = new Set(['supervisor', 'manager']);

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
                })
                .$returningId();

            if (target.userId) {
                await db.insert(notifications).values({
                    userId: Number(target.userId),
                    type: 'system',
                    message: `New on-the-job assessment from ${assessorName}: ${rating}/5. "${remark.slice(0, 120)}${remark.length > 120 ? '...' : ''}"`,
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
