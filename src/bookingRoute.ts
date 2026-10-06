import { eq, sql } from 'drizzle-orm';
import { bookings } from './schema';

/**
 * Resolve `/api/bookings/:id` path segments: numeric primary key, or public `booking_id` (e.g. CIN-XXXXXX).
 */
export function bookingWhereByUrlParam(raw: string | undefined | null) {
    const s = String(raw ?? '').trim();
    if (!s) return sql`1=0`;
    if (/^\d+$/.test(s)) {
        const n = Number(s);
        if (Number.isFinite(n) && n > 0) return eq(bookings.id, n);
    }
    return eq(bookings.bookingId, s);
}
