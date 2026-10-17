import { and, eq, gte, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { bookings } from './schema';
import { loadBusinessSettingsMap, loadBrandVars } from './messageTemplates/brand';
import { adminUserIds, emailFromTemplate, friendlyDate, notifyUsers, siteUrl, smsFromTemplate } from './notify';
import { broadcastSync } from './realtime';

/**
 * Booking payments: deposit or pay in full at booking, and the balance after the clean.
 *
 * Amount paid so far:
 *  - paid in full (paidInFullAt)            -> the whole total
 *  - deposit paid by card                   -> depositPaidAmount
 *  - deposit marked paid by admin (bank)    -> deposit % of the total
 * Balance = total - paid so far.
 */

export type PaymentChoice = 'deposit' | 'full';

const round2 = (n: number) => Math.round(n * 100) / 100;

export function depositPercentOf(settingsMap: Record<string, string>): number {
    try {
        const p = settingsMap.depositPolicy ? JSON.parse(settingsMap.depositPolicy) : null;
        const n = Number(p?.requiredPercent);
        return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 40;
    } catch {
        return 40;
    }
}

export function normalizeChoice(raw: unknown): PaymentChoice {
    return String(raw || '').toLowerCase() === 'full' ? 'full' : 'deposit';
}

export type PaymentSummary = {
    choice: PaymentChoice;
    total: number;
    depositPercent: number;
    depositAmount: number;
    amountPaid: number;
    balanceDue: number;
    /** unpaid: nothing yet; deposit_paid: balance still owed; paid: nothing owed. */
    stage: 'unpaid' | 'deposit_paid' | 'paid';
};

export function paymentSummary(b: any, depositPercent: number): PaymentSummary {
    const total = round2(Number(b.totalPrice) || 0);
    const depositAmount = round2((total * depositPercent) / 100);
    let amountPaid = 0;
    if (b.paidInFullAt) amountPaid = total;
    else if (b.invoicePaid) {
        const card = Number(b.depositPaidAmount);
        amountPaid = Number.isFinite(card) && card > 0 ? card : depositAmount;
        amountPaid += Number(b.balancePaidAmount) || 0;
    }
    amountPaid = round2(Math.min(total, amountPaid));
    const balanceDue = round2(Math.max(0, total - amountPaid));
    const stage = total <= 0 || balanceDue < 0.01 ? (amountPaid > 0 || total <= 0 ? 'paid' : 'unpaid') : amountPaid > 0 ? 'deposit_paid' : 'unpaid';
    return { choice: normalizeChoice(b.paymentChoice), total, depositPercent, depositAmount, amountPaid, balanceDue, stage };
}

/** Booking fields the portals need (added to every booking a client or admin loads). */
export function paymentFieldsForViewer(b: any, depositPercent: number) {
    const s = paymentSummary(b, depositPercent);
    return { paymentChoice: s.choice, amountPaid: s.amountPaid, balanceDue: s.balanceDue, paymentStage: s.stage, depositAmount: s.depositAmount };
}

/** Amount to charge for the first payment, from the client's choice. */
export function firstChargeAmount(total: number, depositPercent: number, choice: PaymentChoice): number {
    return choice === 'full' ? round2(total) : round2((total * depositPercent) / 100);
}

type Deps = { db: any; stripe: Stripe | null };

/** Stripe webhook / pay page: record a successful card payment against its booking (safe to call twice). */
export async function recordBookingPayment({ db }: Deps, pi: Stripe.PaymentIntent): Promise<void> {
    const bookingId = Number(pi.metadata?.bookingId);
    if (!Number.isFinite(bookingId) || bookingId <= 0) return;
    const rows = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
    const b = rows[0];
    if (!b) return;
    const amountPaid = (Number(pi.amount_received || pi.amount) || 0) / 100;
    const kind = String(pi.metadata?.kind || '');
    const paidAtLabel = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const ref = String(b.bookingId ?? b.id);
    const what = `${b.serviceType || 'Cleaning'} on ${friendlyDate(b.date)} at ${b.time}`;

    let isNew = false;
    let label = 'Deposit';
    if (kind === 'balance') {
        if (b.paidInFullAt) return;
        await db
            .update(bookings)
            .set({ paidInFullAt: new Date(), balancePaidAmount: amountPaid.toFixed(2), invoicePaid: true } as any)
            .where(eq(bookings.id, bookingId));
        isNew = true;
        label = 'Balance';
    } else {
        if (b.invoicePaid) return;
        const total = Number(b.totalPrice) || 0;
        const full = amountPaid >= total - 0.01;
        await db
            .update(bookings)
            .set({
                invoicePaid: true,
                depositPaidAt: new Date(),
                depositPaidAmount: amountPaid.toFixed(2),
                ...(full ? { paidInFullAt: new Date() } : {}),
            } as any)
            .where(eq(bookings.id, bookingId));
        isNew = true;
        label = full ? 'Payment in full' : 'Deposit';
    }
    if (!isNew) return;
    console.log(`[stripe] Booking #${bookingId} ${label.toLowerCase()} recorded (£${amountPaid.toFixed(2)})`);
    broadcastSync('all');

    await emailFromTemplate(db, 'client_payment_receipt', { email: b.contactEmail, name: b.contactName }, {
        client_name: b.contactName || 'there',
        amount: amountPaid.toFixed(2),
        reference_label: ref,
        payment_for: `${label}: ${what}`,
        paid_at: paidAtLabel,
    });
    await notifyUsers(db, await adminUserIds(db), {
        message: `${label} received: £${amountPaid.toFixed(2)} for booking ${ref} (${b.contactName}).`,
        pushTitle: 'Payment received',
    });
    if (b.customerId) {
        await notifyUsers(db, [b.customerId], {
            type: 'booking_update',
            message: `Thank you, we received £${amountPaid.toFixed(2)} for booking ${ref}.`,
            pushTitle: 'Payment received',
            data: { type: 'booking_update', bookingId },
        });
    }
    broadcastSync('notifications');
}

/** A Stripe payment for the remaining balance, reused while it is still open. */
async function ensureBalanceIntent({ db, stripe }: Deps, b: any, balance: number): Promise<Stripe.PaymentIntent | null> {
    if (!stripe) return null;
    const pence = Math.round(balance * 100);
    if (pence < 30) return null;
    if (b.stripeBalanceIntentId) {
        try {
            const pi = await stripe.paymentIntents.retrieve(b.stripeBalanceIntentId);
            if (pi.status === 'succeeded') return pi;
            if (pi.status !== 'canceled') {
                if (pi.amount !== pence) return await stripe.paymentIntents.update(pi.id, { amount: pence });
                return pi;
            }
        } catch {
            /* create a fresh one below */
        }
    }
    const ref = String(b.bookingId ?? b.id);
    const pi = await stripe.paymentIntents.create({
        amount: pence,
        currency: 'gbp',
        metadata: { bookingId: String(b.id), bookingRef: ref, kind: 'balance' },
        description: `Balance - Booking ${ref} - ${b.contactName || 'Client'}`,
        receipt_email: b.contactEmail || undefined,
    });
    await db.update(bookings).set({ stripeBalanceIntentId: pi.id } as any).where(eq(bookings.id, b.id));
    return pi;
}

/** The first payment (deposit or full), created on demand if the booking has none yet. */
async function ensureFirstIntent({ db, stripe }: Deps, b: any, amount: number, choice: PaymentChoice, payUrl: string): Promise<Stripe.PaymentIntent | null> {
    if (!stripe) return null;
    const pence = Math.round(amount * 100);
    if (pence < 30) return null;
    if (b.stripePaymentIntentId) {
        try {
            const pi = await stripe.paymentIntents.retrieve(b.stripePaymentIntentId);
            if (pi.status === 'succeeded') return pi;
            if (pi.status !== 'canceled') {
                if (pi.amount !== pence || pi.metadata?.kind !== choice) {
                    return await stripe.paymentIntents.update(pi.id, { amount: pence, metadata: { ...pi.metadata, kind: choice } });
                }
                return pi;
            }
        } catch {
            /* create a fresh one below */
        }
    }
    const ref = String(b.bookingId ?? b.id);
    const pi = await stripe.paymentIntents.create({
        amount: pence,
        currency: 'gbp',
        metadata: { bookingId: String(b.id), bookingRef: ref, kind: choice },
        description: `${choice === 'full' ? 'Full payment' : 'Deposit'} - Booking ${ref} - ${b.contactName || 'Client'}`,
        receipt_email: b.contactEmail || undefined,
    });
    await db.update(bookings).set({ stripePaymentIntentId: pi.id, stripePaymentLink: payUrl } as any).where(eq(bookings.id, b.id));
    return pi;
}

/** Email, SMS and push asking the client to pay the balance after their clean. */
export async function sendBalanceRequest(db: any, b: any, depositPercent: number): Promise<boolean> {
    const s = paymentSummary(b, depositPercent);
    if (s.stage !== 'deposit_paid' || s.balanceDue < 0.01) return false;
    const ref = String(b.bookingId ?? b.id);
    const payUrl = siteUrl(`/pay/booking/${b.id}`);
    const brand = await loadBrandVars(db);
    const vars = {
        client_name: String(b.contactName || 'there'),
        booking_id: ref,
        service_type: String(b.serviceType || 'Cleaning'),
        service_date: friendlyDate(b.date),
        total: s.total.toFixed(2),
        amount_paid: s.amountPaid.toFixed(2),
        balance: s.balanceDue.toFixed(2),
        pay_url: payUrl,
        brand_name: String(brand.brand_name || 'CiN Cleaning'),
    };
    await emailFromTemplate(db, 'client_balance_due', { email: b.contactEmail, name: b.contactName }, vars);
    await smsFromTemplate(db, 'client_balance_due_sms', b.contactPhone, vars);
    if (b.customerId) {
        await notifyUsers(db, [b.customerId], {
            type: 'invoice',
            message: `Your clean (${ref}) is done. Please pay the balance of £${s.balanceDue.toFixed(2)}.`,
            pushTitle: 'Balance due',
            pushBody: `Your clean is done. Tap to pay the balance of £${s.balanceDue.toFixed(2)}.`,
            data: { type: 'booking_update', bookingId: Number(b.id) },
        });
    }
    await db.update(bookings).set({ balanceRequestSentAt: new Date() } as any).where(eq(bookings.id, b.id));
    broadcastSync('notifications');
    return true;
}

/** Scheduled: completed jobs with only the deposit paid get one balance request. */
export async function runBalanceRequests(db: any): Promise<{ scanned: number; sent: number }> {
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rows = await db
        .select()
        .from(bookings)
        .where(
            and(
                eq(bookings.status, 'Completed'),
                eq(bookings.invoicePaid, true),
                gte(bookings.date, since),
                sql`${bookings.paidInFullAt} IS NULL`,
                sql`${bookings.balanceRequestSentAt} IS NULL`,
            ),
        );
    if (!rows.length) return { scanned: 0, sent: 0 };
    const pct = depositPercentOf(await loadBusinessSettingsMap(db));
    let sent = 0;
    for (const b of rows) {
        try {
            if (await sendBalanceRequest(db, b, pct)) sent += 1;
            else await db.update(bookings).set({ balanceRequestSentAt: new Date() } as any).where(eq(bookings.id, b.id));
        } catch (e) {
            console.error('[balance request] failed', b.id, e);
        }
    }
    return { scanned: rows.length, sent };
}

export function registerBookingPaymentRoutes(
    app: any,
    deps: Deps & { authenticateToken: any; publicBaseUrlFromRequest: (req: any) => string },
): void {
    const { db, stripe, authenticateToken, publicBaseUrlFromRequest } = deps;

    const loadBooking = async (raw: string) => {
        const id = parseInt(raw, 10);
        if (!Number.isFinite(id)) return null;
        const rows = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
        return rows[0] || null;
    };

    /** Public pay page data: the first payment (deposit or full) or the balance after a deposit. */
    app.get('/api/pay/booking/:id', async (req: any, res: any) => {
        try {
            let b = await loadBooking(req.params.id);
            if (!b) return res.status(404).json({ error: 'Booking not found' });
            const pct = depositPercentOf(await loadBusinessSettingsMap(db));
            const brandVars = await loadBrandVars(db);
            const base = {
                bookingRef: String(b.bookingId ?? b.id),
                customerName: b.contactName,
                serviceType: b.serviceType,
                date: b.date,
                time: b.time,
                brandName: brandVars.brand_name || 'CiN Cleaning',
                brandPrimary: brandVars.brand_primary || '#7c3aed',
                publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
            };

            // Catch payments that succeeded before the webhook arrived.
            for (const field of ['stripePaymentIntentId', 'stripeBalanceIntentId'] as const) {
                if (stripe && b[field]) {
                    try {
                        const pi = await stripe.paymentIntents.retrieve(b[field]);
                        if (pi.status === 'succeeded') await recordBookingPayment(deps, pi);
                    } catch {
                        /* ignore */
                    }
                }
            }
            b = (await loadBooking(String(b.id))) || b;
            const s = paymentSummary(b, pct);

            if (s.stage === 'paid') return res.json({ ...base, paid: true, total: s.total, amountPaid: s.amountPaid });
            if (b.status === 'Cancelled') return res.status(400).json({ error: 'This booking was cancelled.' });
            if (!stripe) return res.status(400).json({ error: 'Online payment is not available right now.' });

            if (s.stage === 'deposit_paid') {
                const pi = await ensureBalanceIntent(deps, b, s.balanceDue);
                if (!pi) return res.status(400).json({ error: 'No balance to pay online.' });
                return res.json({ ...base, stage: 'balance', clientSecret: pi.client_secret, amount: s.balanceDue, total: s.total, amountPaid: s.amountPaid });
            }

            const payUrl = `${publicBaseUrlFromRequest(req)}/pay/booking/${b.id}`;
            const amount = firstChargeAmount(s.total, pct, s.choice);
            const pi = await ensureFirstIntent(deps, b, amount, s.choice, payUrl);
            if (!pi) return res.status(400).json({ error: 'No payment set up for this booking' });
            return res.json({
                ...base,
                stage: 'initial',
                clientSecret: pi.client_secret,
                choice: s.choice,
                amount,
                total: s.total,
                depositPercent: pct,
                depositAmount: s.depositAmount,
            });
        } catch (e: any) {
            console.error('Get booking payment info error:', e?.message || e);
            res.status(500).json({ error: 'Failed to load payment info' });
        }
    });

    /** Switch between paying the deposit and paying in full (only before anything is paid). */
    app.post('/api/pay/booking/:id/option', async (req: any, res: any) => {
        try {
            const b = await loadBooking(req.params.id);
            if (!b) return res.status(404).json({ error: 'Booking not found' });
            const pct = depositPercentOf(await loadBusinessSettingsMap(db));
            const s = paymentSummary(b, pct);
            if (s.stage !== 'unpaid') return res.status(409).json({ error: 'A payment has already been made for this booking.' });
            const choice = normalizeChoice(req.body?.choice);
            await db.update(bookings).set({ paymentChoice: choice } as any).where(eq(bookings.id, b.id));
            const amount = firstChargeAmount(s.total, pct, choice);
            const payUrl = `${publicBaseUrlFromRequest(req)}/pay/booking/${b.id}`;
            const pi = await ensureFirstIntent(deps, { ...b, paymentChoice: choice }, amount, choice, payUrl);
            res.json({ choice, amount, clientSecret: pi?.client_secret || null });
        } catch (e: any) {
            console.error('Change payment option error:', e?.message || e);
            res.status(500).json({ error: 'Could not change the payment option' });
        }
    });

    /** Admin: the client paid the rest another way (cash or bank transfer). */
    app.post('/api/admin/bookings/:id/mark-paid-in-full', authenticateToken, async (req: any, res: any) => {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        try {
            const b = await loadBooking(req.params.id);
            if (!b) return res.status(404).json({ error: 'Booking not found' });
            const pct = depositPercentOf(await loadBusinessSettingsMap(db));
            const s = paymentSummary(b, pct);
            await db
                .update(bookings)
                .set({
                    invoicePaid: true,
                    paidInFullAt: new Date(),
                    ...(s.stage === 'deposit_paid' ? { balancePaidAmount: s.balanceDue.toFixed(2) } : {}),
                } as any)
                .where(eq(bookings.id, b.id));
            broadcastSync('all');
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: 'Could not update the booking' });
        }
    });

    /** Admin: send (or resend) the balance request now. */
    app.post('/api/admin/bookings/:id/send-balance-request', authenticateToken, async (req: any, res: any) => {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        try {
            const b = await loadBooking(req.params.id);
            if (!b) return res.status(404).json({ error: 'Booking not found' });
            const pct = depositPercentOf(await loadBusinessSettingsMap(db));
            const ok = await sendBalanceRequest(db, b, pct);
            if (!ok) return res.status(400).json({ error: 'There is no balance to request for this booking.' });
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: 'Could not send the balance request' });
        }
    });
}
