import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { bookings, referralCreditUses, referralRewards, users } from './schema';
import { notifyUsers } from './notify';

/**
 * Referral rewards.
 * - Every referred friend gets one row, so a reward can never be counted twice.
 * - A reward unlocks when the friend's first clean is completed (or the office approves it).
 * - Clients spend unlocked rewards as cleaning credit taken off their next booking (no cash value).
 * - Staff claim unlocked rewards on their weekly invoice, like holiday pay.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `£${n.toFixed(2)}`;

type UserRow = typeof users.$inferSelect;
type RewardRow = typeof referralRewards.$inferSelect;

/** First completed booking for a user (linked account or same email as a guest booking). */
async function firstCompletedBookingId(db: any, u: Pick<UserRow, 'id' | 'email'>): Promise<number | null> {
    const email = String(u.email || '').trim().toLowerCase();
    const rows = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(
            eq(bookings.status, 'Completed'),
            email ? or(eq(bookings.customerId, u.id), sql`LOWER(${bookings.contactEmail}) = ${email}`) : eq(bookings.customerId, u.id),
        ))
        .limit(1);
    return rows[0]?.id ?? null;
}

/**
 * Makes sure every referred user has a reward row, and unlocks any whose friend has already had a clean.
 * Pass `referrerUserId` to limit the work to one referrer. Runs quietly (no notifications).
 */
export async function syncReferralRewards(db: any, rewardAmount: number, referrerUserId?: number): Promise<void> {
    let codeFilter: string | null = null;
    if (referrerUserId) {
        const [ref] = await db.select().from(users).where(eq(users.id, referrerUserId)).limit(1);
        codeFilter = String(ref?.referralCode || '').trim();
        if (!codeFilter) return;
    }
    const referred: UserRow[] = await db
        .select()
        .from(users)
        .where(codeFilter ? eq(users.referredBy, codeFilter) : isNotNull(users.referredBy));
    if (!referred.length) return;

    const codes = [...new Set(referred.map((u) => String(u.referredBy || '').trim()).filter(Boolean))];
    const referrers: UserRow[] = codes.length ? await db.select().from(users).where(inArray(users.referralCode, codes)) : [];
    const referrerByCode = new Map(referrers.map((r) => [String(r.referralCode || '').trim(), r]));
    const existing: RewardRow[] = await db
        .select()
        .from(referralRewards)
        .where(inArray(referralRewards.referredUserId, referred.map((u) => u.id)));
    const byReferred = new Map(existing.map((r) => [r.referredUserId, r]));

    for (const u of referred) {
        const referrer = referrerByCode.get(String(u.referredBy || '').trim());
        if (!referrer || referrer.id === u.id) continue;
        const row = byReferred.get(u.id);
        if (row && row.status !== 'pending') continue;
        // The office marking a referral Completed (isVerified) also unlocks it.
        const bookingId = await firstCompletedBookingId(db, u);
        const unlock = !!bookingId || !!u.isVerified;
        if (!row) {
            try {
                await db.insert(referralRewards).values({
                    referrerUserId: referrer.id,
                    referredUserId: u.id,
                    amount: rewardAmount.toFixed(2),
                    status: unlock ? 'available' : 'pending',
                    unlockedAt: unlock ? new Date() : null,
                    unlockedByBookingId: bookingId,
                });
            } catch {
                // Another request created it at the same moment; the unique key keeps one row.
            }
        } else if (unlock) {
            await db
                .update(referralRewards)
                .set({ status: 'available', unlockedAt: new Date(), unlockedByBookingId: bookingId })
                .where(and(eq(referralRewards.id, row.id), eq(referralRewards.status, 'pending')));
        }
    }
}

/** Called when a booking is completed: unlocks the reward for whoever referred this client and tells them. */
export async function unlockReferralForBooking(
    db: any,
    rewardAmount: number,
    booking: { id: number; customerId?: number | null; contactEmail?: string | null },
): Promise<void> {
    try {
        let u: UserRow | undefined;
        if (booking.customerId) [u] = await db.select().from(users).where(eq(users.id, booking.customerId)).limit(1);
        if (!u && booking.contactEmail) {
            [u] = await db.select().from(users).where(eq(users.email, String(booking.contactEmail).trim().toLowerCase())).limit(1);
        }
        if (!u || !u.referredBy) return;
        const [referrer] = await db.select().from(users).where(eq(users.referralCode, String(u.referredBy).trim())).limit(1);
        if (!referrer || referrer.id === u.id) return;

        const [row] = await db.select().from(referralRewards).where(eq(referralRewards.referredUserId, u.id)).limit(1);
        if (row && row.status !== 'pending') return;
        if (row) {
            await db
                .update(referralRewards)
                .set({ status: 'available', unlockedAt: new Date(), unlockedByBookingId: booking.id })
                .where(and(eq(referralRewards.id, row.id), eq(referralRewards.status, 'pending')));
        } else {
            await db.insert(referralRewards).values({
                referrerUserId: referrer.id,
                referredUserId: u.id,
                amount: rewardAmount.toFixed(2),
                status: 'available',
                unlockedAt: new Date(),
                unlockedByBookingId: booking.id,
            });
        }
        const amount = row ? Number(row.amount) : rewardAmount;
        const friend = String(u.name || 'Your friend').split(' ')[0];
        const isStaff = String(referrer.role || '').toLowerCase() === 'staff';
        await notifyUsers(db, [referrer.id], {
            type: 'promo',
            message: isStaff
                ? `${friend} had their first clean, so your ${money(amount)} referral bonus is ready. Add it to your weekly invoice in Earnings.`
                : `${friend} had their first clean, so ${money(amount)} cleaning credit has been added to your account. It comes off your next booking automatically.`,
            pushTitle: isStaff ? 'Referral bonus ready' : 'You earned cleaning credit',
            data: { type: 'referral' },
        });
    } catch (e) {
        console.error('[referrals] unlock failed:', e);
    }
}

/** Unlocked credit a client has, what they have used, and what is left. */
export async function referralCreditBalance(db: any, userId: number): Promise<{ earned: number; used: number; balance: number }> {
    const [earnedRow] = await db
        .select({ total: sql<string>`COALESCE(SUM(${referralRewards.amount}), 0)` })
        .from(referralRewards)
        .where(and(eq(referralRewards.referrerUserId, userId), eq(referralRewards.status, 'available')));
    const [usedRow] = await db
        .select({ total: sql<string>`COALESCE(SUM(${referralCreditUses.amount}), 0)` })
        .from(referralCreditUses)
        .where(and(eq(referralCreditUses.userId, userId), eq(referralCreditUses.status, 'applied')));
    const earned = round2(Number(earnedRow?.total) || 0);
    const used = round2(Number(usedRow?.total) || 0);
    return { earned, used, balance: round2(Math.max(0, earned - used)) };
}

/** How much credit to take off a new booking for this client (never more than the booking total). */
export async function referralCreditFor(db: any, userId: number, bookingTotal: number): Promise<number> {
    if (!(bookingTotal > 0)) return 0;
    const { balance } = await referralCreditBalance(db, userId);
    return round2(Math.min(balance, bookingTotal));
}

export async function recordReferralCreditUse(db: any, userId: number, bookingId: number, amount: number): Promise<void> {
    if (!(amount > 0)) return;
    await db.insert(referralCreditUses).values({ userId, bookingId, amount: amount.toFixed(2), status: 'applied' });
}

/** Gives the credit back when a booking that used it is cancelled or deleted. Returns the amount restored. */
export async function restoreReferralCreditForBooking(db: any, bookingId: number): Promise<number> {
    const uses = await db
        .select()
        .from(referralCreditUses)
        .where(and(eq(referralCreditUses.bookingId, bookingId), eq(referralCreditUses.status, 'applied')));
    if (!uses.length) return 0;
    await db
        .update(referralCreditUses)
        .set({ status: 'restored' })
        .where(and(eq(referralCreditUses.bookingId, bookingId), eq(referralCreditUses.status, 'applied')));
    const total = round2(uses.reduce((s: number, u: any) => s + Number(u.amount || 0), 0));
    const userIds = [...new Set(uses.map((u: any) => Number(u.userId)))] as number[];
    await notifyUsers(db, userIds, {
        type: 'promo',
        message: `${money(total)} referral credit is back in your account because that booking was cancelled.`,
        pushTitle: 'Credit returned',
        inApp: true,
    }).catch(() => {});
    return total;
}

/** Rewards for one referrer, keyed by the referred user id. */
export async function rewardsForReferrer(db: any, referrerUserId: number): Promise<Map<number, RewardRow>> {
    const rows: RewardRow[] = await db.select().from(referralRewards).where(eq(referralRewards.referrerUserId, referrerUserId));
    return new Map(rows.map((r) => [r.referredUserId, r]));
}

/** Unlocked staff bonuses not yet on an invoice. */
export async function claimableReferralBonuses(db: any, staffUserId: number) {
    const rows: RewardRow[] = await db
        .select()
        .from(referralRewards)
        .where(and(
            eq(referralRewards.referrerUserId, staffUserId),
            eq(referralRewards.status, 'available'),
            eq(referralRewards.payStatus, 'unpaid'),
        ));
    if (!rows.length) return [];
    const friends: UserRow[] = await db.select().from(users).where(inArray(users.id, rows.map((r) => r.referredUserId)));
    const nameById = new Map(friends.map((f) => [f.id, f.name]));
    return rows.map((r) => ({
        id: r.id,
        friendName: String(nameById.get(r.referredUserId) || 'A friend'),
        amount: round2(Number(r.amount) || 0),
        unlockedAt: r.unlockedAt ? new Date(r.unlockedAt as unknown as string).toISOString() : null,
    }));
}

/** Invoice lines for the bonuses a cleaner chose to claim; throws a readable error if any is not claimable. */
export async function referralInvoiceLines(db: any, staffUserId: number, rewardIds: unknown) {
    const ids = [...new Set((Array.isArray(rewardIds) ? rewardIds : []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!ids.length) return { lines: [] as any[], total: 0, ids: [] as number[] };
    const claimable = await claimableReferralBonuses(db, staffUserId);
    const chosen = claimable.filter((c) => ids.includes(c.id));
    if (chosen.length !== ids.length) throw new Error('Some referral bonuses are no longer available to claim. Refresh and try again.');
    const lines = chosen.map((c) => ({
        id: `referral-${c.id}`,
        kind: 'referral',
        referralRewardId: c.id,
        date: (c.unlockedAt || new Date().toISOString()).slice(0, 10),
        customer: `Referral bonus: ${c.friendName}`,
        staffCount: 1,
        bookedHours: 0,
        yourHours: 0,
        hours: 0,
        hourlyRate: 0,
        yourShare: c.amount,
    }));
    return { lines, total: round2(chosen.reduce((s, c) => s + c.amount, 0)), ids: chosen.map((c) => c.id) };
}

export async function markReferralsClaimed(db: any, invoiceId: number, ids: number[]): Promise<void> {
    if (!ids.length) return;
    await db
        .update(referralRewards)
        .set({ payStatus: 'claimed', staffInvoiceId: invoiceId })
        .where(and(inArray(referralRewards.id, ids), eq(referralRewards.payStatus, 'unpaid')));
}

/** Keeps referral bonuses in step with the weekly invoice they were claimed on. */
export async function syncReferralPayForInvoice(db: any, invoiceId: number, invoiceStatus: 'Pending' | 'Approved' | 'Rejected' | 'Deleted'): Promise<void> {
    if (invoiceStatus === 'Approved') {
        await db.update(referralRewards).set({ payStatus: 'paid' }).where(eq(referralRewards.staffInvoiceId, invoiceId));
    } else if (invoiceStatus === 'Pending') {
        await db.update(referralRewards).set({ payStatus: 'claimed' }).where(eq(referralRewards.staffInvoiceId, invoiceId));
    } else {
        await db.update(referralRewards).set({ payStatus: 'unpaid', staffInvoiceId: null }).where(eq(referralRewards.staffInvoiceId, invoiceId));
    }
}
