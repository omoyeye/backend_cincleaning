import { randomBytes } from 'crypto';
import { and, eq, isNull, like } from 'drizzle-orm';
import { bookings, customerInvoices } from './schema';
import { siteUrl } from './notify';

/**
 * Public payment links use a random code instead of the booking or invoice number, so nobody can
 * open someone else's payment page by changing a number. Links point at the website (which
 * forwards /pay to the API), never at the API address.
 */
const PAY_TOKEN = /^[A-Za-z0-9_-]{20,48}$/;

export const isPayToken = (key: unknown): key is string => typeof key === 'string' && PAY_TOKEN.test(key);
const newPayToken = () => randomBytes(18).toString('base64url');

export async function bookingPayToken(db: any, b: { id: number; payToken?: string | null }): Promise<string> {
    if (isPayToken(b.payToken)) return b.payToken;
    const token = newPayToken();
    await db.update(bookings).set({ payToken: token } as any).where(eq(bookings.id, Number(b.id)));
    return token;
}

export async function invoicePayToken(db: any, inv: { id: number; payToken?: string | null }): Promise<string> {
    if (isPayToken(inv.payToken)) return inv.payToken;
    const token = newPayToken();
    await db.update(customerInvoices).set({ payToken: token } as any).where(eq(customerInvoices.id, Number(inv.id)));
    return token;
}

export const bookingPayUrl = async (db: any, b: { id: number; payToken?: string | null }) => siteUrl(`/pay/booking/${await bookingPayToken(db, b)}`);
export const invoicePayUrl = async (db: any, inv: { id: number; payToken?: string | null }) => siteUrl(`/pay/invoice/${await invoicePayToken(db, inv)}`);

export async function findBookingByPayToken(db: any, key: unknown) {
    if (!isPayToken(key)) return null;
    const rows = await db.select().from(bookings).where(eq(bookings.payToken, key)).limit(1);
    return rows[0] ?? null;
}

export async function findInvoiceByPayToken(db: any, key: unknown) {
    if (!isPayToken(key)) return null;
    const rows = await db.select().from(customerInvoices).where(eq(customerInvoices.payToken, key)).limit(1);
    return rows[0] ?? null;
}

/** Saved links from before codes existed (…/pay/booking/123) are swapped for coded ones on start-up. */
export async function upgradeLegacyPayLinks(db: any): Promise<number> {
    let n = 0;
    const oldBookings = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(isNull(bookings.payToken), like(bookings.stripePaymentLink, '%/pay/booking/%')));
    for (const b of oldBookings) {
        await db.update(bookings).set({ stripePaymentLink: await bookingPayUrl(db, b) } as any).where(eq(bookings.id, b.id));
        n += 1;
    }
    const oldInvoices = await db
        .select({ id: customerInvoices.id })
        .from(customerInvoices)
        .where(and(isNull(customerInvoices.payToken), like(customerInvoices.stripePaymentUrl, '%/pay/invoice/%')));
    for (const inv of oldInvoices) {
        await db.update(customerInvoices).set({ stripePaymentUrl: await invoicePayUrl(db, inv) }).where(eq(customerInvoices.id, inv.id));
        n += 1;
    }
    return n;
}
