import { eq, and, inArray, gte, lte, sql } from 'drizzle-orm';
import { bookings, notifications, users, businessSettings, bookingReminderLog, bookingStaff, staff } from './schema';
import { loadBrandVars } from './messageTemplates/brand';
import { renderTransactionalEmail } from './messageTemplates/engine';
import { sendEmail } from './services/email';
import { sendSmsFromTemplate } from './messageTemplates/smsDispatch';
import { broadcastSync } from './realtime';

const MS_HOUR = 3600000;
const SETTINGS_KEY = 'booking_reminder_settings';

export type BookingReminderSettings = {
    masterEnabled: boolean;
    send48h: boolean;
    send24h: boolean;
    notifyAdmin: boolean;
    /** In-app + SMS (if template + mobile) for assigned staff on the booking. */
    notifyStaff: boolean;
};

const DEFAULT_SETTINGS: BookingReminderSettings = {
    masterEnabled: true,
    send48h: true,
    send24h: true,
    notifyAdmin: true,
    notifyStaff: true,
};

type BookingRow = typeof bookings.$inferSelect;

function getBookingStartMs(b: Pick<BookingRow, 'date' | 'time'>): number {
    const [year, month, day] = String(b.date || '').split('-').map(Number);
    const [hours, minutes] = String(b.time || '09:00').split(':').map(Number);
    return new Date(year || 1970, (month || 1) - 1, day || 1, hours || 0, minutes || 0).getTime();
}

function escapeHtmlBasic(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export async function loadBookingReminderSettings(db: any): Promise<BookingReminderSettings> {
    const rows = await db.select().from(businessSettings).where(eq(businessSettings.key, SETTINGS_KEY)).limit(1);
    if (!rows.length || !rows[0].value) return { ...DEFAULT_SETTINGS };
    try {
        const j = JSON.parse(String(rows[0].value)) as Partial<BookingReminderSettings>;
        return {
            masterEnabled: j.masterEnabled !== false,
            send48h: j.send48h !== false,
            send24h: j.send24h !== false,
            notifyAdmin: j.notifyAdmin !== false,
            notifyStaff: j.notifyStaff !== false,
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export async function saveBookingReminderSettings(db: any, s: BookingReminderSettings): Promise<void> {
    const val = JSON.stringify(s);
    const existing = await db.select().from(businessSettings).where(eq(businessSettings.key, SETTINGS_KEY)).limit(1);
    if (existing.length) {
        await db
            .update(businessSettings)
            .set({ value: val, updatedAt: new Date() })
            .where(eq(businessSettings.key, SETTINGS_KEY));
    } else {
        await db.insert(businessSettings).values({ key: SETTINGS_KEY, value: val });
    }
}

async function getAssignedStaffForBooking(
    db: any,
    b: BookingRow,
): Promise<Array<{ id: number; userId: number | null; phone: string | null; name: string }>> {
    const ids = new Set<number>();
    const links = await db.select().from(bookingStaff).where(eq(bookingStaff.bookingId, Number(b.id)));
    for (const row of links) {
        const sid = Number(row.staffId);
        if (Number.isFinite(sid) && sid > 0) ids.add(sid);
    }
    if (b.assignedStaffId != null) {
        const sid = Number(b.assignedStaffId);
        if (Number.isFinite(sid) && sid > 0) ids.add(sid);
    }
    if (ids.size === 0) return [];
    const list = await db.select().from(staff).where(inArray(staff.id, [...ids]));
    return list.map((row: typeof staff.$inferSelect) => ({
        id: Number(row.id),
        userId: row.userId != null ? Number(row.userId) : null,
        phone: row.phone ? String(row.phone).trim() : null,
        name: String(row.name || 'Team'),
    }));
}

async function getAdminUserIdsForReminders(db: any): Promise<number[]> {
    const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`LOWER(TRIM(${users.role})) = 'admin'`);
    return rows.map((r: { id: number }) => Number(r.id)).filter((id: number) => Number.isFinite(id) && id > 0);
}

async function sendOneWindow(db: any, b: BookingRow, window: '48h' | '24h', settings: BookingReminderSettings): Promise<void> {
    const numericBookingId = Number(b.id);
    const displayBookingId = String(b.bookingId ?? numericBookingId);
    const brand = await loadBrandVars(db);
    const svc = escapeHtmlBasic(String(b.serviceType || 'booking'));
    const dt = escapeHtmlBasic(String(b.date || ''));
    const tm = escapeHtmlBasic(String(b.time || ''));
    const customMessage =
        window === '48h'
            ? `This is your <strong>48-hour reminder</strong>: your <strong>${svc}</strong> is scheduled for <strong>${dt} at ${tm}</strong>.`
            : `This is your <strong>24-hour reminder</strong>: your <strong>${svc}</strong> is scheduled for <strong>${dt} at ${tm}</strong>.`;

    const channels: string[] = [];

    if (b.contactEmail) {
        try {
            const { subject, html } = await renderTransactionalEmail(db, 'client_booking_reminder', {
                ...brand,
                client_name: b.contactName || 'there',
                booking_id: displayBookingId,
                service_type: String(b.serviceType || 'Cleaning'),
                service_date: String(b.date || ''),
                service_time: String(b.time || ''),
                custom_message: customMessage,
            });
            await sendEmail({
                to: [{ email: b.contactEmail, name: b.contactName || 'Guest' }],
                subject,
                htmlContent: html,
            });
            channels.push('email');
        } catch (e) {
            console.error('[booking reminder] email failed', numericBookingId, e);
        }
    }

    if (b.contactPhone) {
        try {
            await sendSmsFromTemplate(db, 'client_booking_reminder_sms', b.contactPhone, {
                brand_name: String(brand.brand_name || 'CiN Cleaning'),
                client_name: String(b.contactName || 'there'),
                booking_id: displayBookingId,
                service_type: String(b.serviceType || 'clean'),
                service_date: String(b.date || ''),
                service_time: String(b.time || ''),
                reminder_hint: window === '48h' ? '48h reminder.' : '24h reminder.',
            });
            channels.push('sms');
        } catch (e) {
            console.error('[booking reminder] sms failed', numericBookingId, e);
        }
    }

    if (b.customerId) {
        try {
            await db.insert(notifications).values({
                userId: Number(b.customerId),
                type: 'booking_update',
                message: `${window === '48h' ? '48-hour' : '24-hour'} reminder: booking #${displayBookingId} on ${b.date} at ${b.time}.`,
                isRead: false,
            });
            channels.push('notification');
        } catch (e) {
            console.error('[booking reminder] in-app notification failed', numericBookingId, e);
        }
    }

    if (settings.notifyAdmin) {
        try {
            const adminIds = await getAdminUserIdsForReminders(db);
            const line = `Upcoming job (${window}): #${displayBookingId} — ${b.serviceType} on ${b.date} at ${b.time} — ${b.contactName || 'Guest'}`;
            if (adminIds.length) {
                await db.insert(notifications).values(
                    adminIds.map((userId) => ({
                        userId,
                        type: 'booking_update' as const,
                        message: line,
                        isRead: false,
                    })),
                );
                channels.push('admin');
            }
        } catch (e) {
            console.error('[booking reminder] admin notifications failed', numericBookingId, e);
        }
    }

    if (settings.notifyStaff) {
        try {
            const staffList = await getAssignedStaffForBooking(db, b);
            const staffUsersNotified = new Set<number>();
            let staffSmsSent = 0;
            for (const st of staffList) {
                if (st.userId && Number.isFinite(st.userId) && !staffUsersNotified.has(st.userId)) {
                    await db.insert(notifications).values({
                        userId: st.userId,
                        type: 'booking_update',
                        message: `${window === '48h' ? '48-hour' : '24-hour'} job reminder: #${displayBookingId} — ${b.serviceType} on ${b.date} at ${b.time} (${b.contactName || 'Client'}).`,
                        isRead: false,
                    });
                    staffUsersNotified.add(st.userId);
                }
                if (st.phone) {
                    try {
                        await sendSmsFromTemplate(db, 'staff_booking_reminder_sms', st.phone, {
                            brand_name: String(brand.brand_name || 'CiN Cleaning'),
                            staff_name: st.name,
                            booking_id: displayBookingId,
                            service_type: String(b.serviceType || 'clean'),
                            service_date: String(b.date || ''),
                            service_time: String(b.time || ''),
                            reminder_hint: window === '48h' ? '48h reminder' : '24h reminder',
                        });
                        staffSmsSent += 1;
                    } catch (e) {
                        console.error('[booking reminder] staff sms failed', numericBookingId, st.id, e);
                    }
                }
            }
            if (staffUsersNotified.size > 0) channels.push(`staff_app×${staffUsersNotified.size}`);
            if (staffSmsSent > 0) channels.push(`staff_sms×${staffSmsSent}`);
        } catch (e) {
            console.error('[booking reminder] staff notify failed', numericBookingId, e);
        }
    }

    const stamp =
        window === '48h'
            ? { reminder48SentAt: new Date() as Date }
            : { reminder24SentAt: new Date() as Date };
    await db.update(bookings).set(stamp).where(eq(bookings.id, numericBookingId));

    try {
        await db.insert(bookingReminderLog).values({
            bookingId: numericBookingId,
            windowLabel: window,
            channels: channels.length ? channels.join(',') : 'none',
        });
    } catch (e) {
        console.warn('[booking reminder] log insert failed', numericBookingId, e);
    }

    broadcastSync('notifications');
}

/** Scans upcoming Pending/Confirmed bookings and sends 48h / 24h reminders once each. */
export async function runAutomaticBookingReminders(db: any): Promise<{ scanned: number; sent48: number; sent24: number }> {
    const settings = await loadBookingReminderSettings(db);
    if (!settings.masterEnabled) {
        return { scanned: 0, sent48: 0, sent24: 0 };
    }

    const now = Date.now();
    const minDate = new Date(now - 86400000).toISOString().slice(0, 10);
    const maxDate = new Date(now + 4 * 86400000).toISOString().slice(0, 10);

    const rows = await db
        .select()
        .from(bookings)
        .where(
            and(
                inArray(bookings.status, ['Pending', 'Confirmed']),
                gte(bookings.date, minDate),
                lte(bookings.date, maxDate),
            ),
        );

    let sent48Count = 0;
    let sent24Count = 0;

    for (const b of rows) {
        const startMs = getBookingStartMs(b);
        if (!Number.isFinite(startMs)) continue;
        const hoursUntil = (startMs - now) / MS_HOUR;
        if (hoursUntil <= 0 || hoursUntil > 72) continue;

        const already48 = Boolean((b as any).reminder48SentAt);
        const already24 = Boolean((b as any).reminder24SentAt);

        if (settings.send48h && !already48 && hoursUntil <= 49 && hoursUntil >= 45) {
            await sendOneWindow(db, b, '48h', settings);
            sent48Count += 1;
            continue;
        }
        if (settings.send24h && !already24 && hoursUntil <= 25 && hoursUntil >= 22) {
            await sendOneWindow(db, b, '24h', settings);
            sent24Count += 1;
        }
    }

    return { scanned: rows.length, sent48: sent48Count, sent24: sent24Count };
}

const GOOGLE_REVIEW_URL = 'https://g.page/r/CfoApvyJUbAvEAI/review';
const REVIEW_DELAY_MS = 2 * MS_HOUR;

/** Scans completed bookings and sends a review request email/SMS 2 hours after clock-out. */
export async function runPostCompletionReviewRequests(db: any): Promise<{ scanned: number; sent: number }> {
    const now = Date.now();
    const cutoffDate = new Date(now - 7 * 86400000).toISOString().slice(0, 10);

    const rows = await db
        .select()
        .from(bookings)
        .where(
            and(
                eq(bookings.status, 'Completed'),
                gte(bookings.date, cutoffDate),
                sql`${bookings.reviewRequestSentAt} IS NULL`,
            ),
        );

    let sentCount = 0;

    for (const b of rows) {
        const wc = (b as any).workCompletion;
        const clockOutIso = wc?.clockOutAtIso;
        if (!clockOutIso) continue;

        const clockOutMs = Date.parse(String(clockOutIso));
        if (!Number.isFinite(clockOutMs)) continue;

        const elapsed = now - clockOutMs;
        if (elapsed < REVIEW_DELAY_MS || elapsed > 7 * 86400000) continue;

        const numericBookingId = Number(b.id);
        const displayBookingId = String(b.bookingId ?? numericBookingId);
        const brand = await loadBrandVars(db);

        if (b.contactEmail) {
            try {
                const { subject, html } = await renderTransactionalEmail(db, 'client_job_completed_review', {
                    ...brand,
                    client_name: b.contactName || 'there',
                    booking_id: displayBookingId,
                    service_type: String(b.serviceType || 'Cleaning'),
                    service_date: String(b.date || ''),
                    google_review_url: GOOGLE_REVIEW_URL,
                });
                await sendEmail({
                    to: [{ email: b.contactEmail, name: b.contactName || 'Guest' }],
                    subject,
                    htmlContent: html,
                });
            } catch (e) {
                console.error('[review request] email failed', numericBookingId, e);
            }
        }

        if (b.contactPhone) {
            try {
                await sendSmsFromTemplate(db, 'client_job_completed_review_sms', b.contactPhone, {
                    brand_name: String(brand.brand_name || 'CiN Cleaning'),
                    client_name: String(b.contactName || 'there'),
                    google_review_url: GOOGLE_REVIEW_URL,
                });
            } catch (e) {
                console.error('[review request] sms failed', numericBookingId, e);
            }
        }

        if (b.customerId) {
            try {
                await db.insert(notifications).values({
                    userId: Number(b.customerId),
                    type: 'promo',
                    message: `We'd love your feedback! Leave a quick Google review for your recent clean.`,
                    isRead: false,
                });
            } catch (e) {
                console.error('[review request] notification failed', numericBookingId, e);
            }
        }

        await db.update(bookings)
            .set({ reviewRequestSentAt: new Date() })
            .where(eq(bookings.id, numericBookingId));

        sentCount += 1;
    }

    broadcastSync('notifications');
    return { scanned: rows.length, sent: sentCount };
}

function getNextRecurrenceDate(lastDate: string, frequency: string): string {
    const [y, m, d] = lastDate.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    switch (frequency) {
        case 'Weekly': date.setDate(date.getDate() + 7); break;
        case 'Fortnightly': date.setDate(date.getDate() + 14); break;
        case 'Monthly': date.setMonth(date.getMonth() + 1); break;
        default: return '';
    }
    return date.toISOString().slice(0, 10);
}

export async function runRecurringBookingCreation(db: any): Promise<{ scanned: number; created: number }> {
    const now = Date.now();
    const cutoffDate = new Date(now - 14 * 86400000).toISOString().slice(0, 10);

    const completedRows = await db
        .select({
            id: bookings.id,
            bookingId: bookings.bookingId,
            customerId: bookings.customerId,
            serviceType: bookings.serviceType,
            date: bookings.date,
            time: bookings.time,
            totalPrice: bookings.totalPrice,
            addressLine1: bookings.addressLine1,
            addressCity: bookings.addressCity,
            addressPostcode: bookings.addressPostcode,
            contactName: bookings.contactName,
            contactEmail: bookings.contactEmail,
            contactPhone: bookings.contactPhone,
            propertyDetails: bookings.propertyDetails,
            extras: bookings.extras,
        })
        .from(bookings)
        .where(
            and(
                eq(bookings.status, 'Completed'),
                gte(bookings.date, cutoffDate),
            ),
        );

    let createdCount = 0;

    for (const b of completedRows) {
        const pd = (b.propertyDetails as Record<string, unknown>) || {};
        const frequency = String(pd.frequency || '');
        if (!frequency || frequency === 'One-time') continue;

        const nextDate = getNextRecurrenceDate(b.date, frequency);
        if (!nextDate) continue;

        // Check for existing future booking for same customer + service
        if (b.customerId) {
            const existing = await db
                .select({ id: bookings.id })
                .from(bookings)
                .where(
                    and(
                        eq(bookings.customerId, b.customerId),
                        eq(bookings.serviceType, b.serviceType),
                        gte(bookings.date, b.date),
                        sql`${bookings.status} != 'Cancelled'`,
                        sql`${bookings.id} != ${b.id}`,
                    ),
                )
                .limit(1);
            if (existing.length > 0) continue;
        }

        const newBookingId = `CIN-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        try {
            await db.insert(bookings).values({
                bookingId: newBookingId,
                customerId: b.customerId || null,
                serviceType: b.serviceType,
                date: nextDate,
                time: b.time,
                totalPrice: b.totalPrice,
                addressLine1: b.addressLine1,
                addressCity: b.addressCity,
                addressPostcode: b.addressPostcode,
                contactName: b.contactName,
                contactEmail: b.contactEmail,
                contactPhone: b.contactPhone || null,
                propertyDetails: b.propertyDetails,
                extras: b.extras || null,
                status: 'Pending',
            });

            if (b.customerId) {
                await db.insert(notifications).values({
                    userId: Number(b.customerId),
                    type: 'booking_update',
                    message: `Your recurring ${b.serviceType} has been scheduled for ${nextDate}. Reference: ${newBookingId}`,
                    isRead: false,
                });
            }

            createdCount += 1;
        } catch (e) {
            console.error('[recurring booking] creation failed', b.id, e);
        }
    }

    if (createdCount > 0) broadcastSync('all');
    return { scanned: completedRows.length, created: createdCount };
}

const REBOOKING_NUDGE_DELAY_MS = 21 * 86400000; // 3 weeks

export async function runRebookingNudges(db: any): Promise<{ scanned: number; sent: number }> {
    const now = Date.now();
    const minDate = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
    const maxDate = new Date(now - 18 * 86400000).toISOString().slice(0, 10);

    const rows = await db
        .select({
            id: bookings.id,
            customerId: bookings.customerId,
            serviceType: bookings.serviceType,
            date: bookings.date,
            contactName: bookings.contactName,
            contactEmail: bookings.contactEmail,
            contactPhone: bookings.contactPhone,
            propertyDetails: bookings.propertyDetails,
        })
        .from(bookings)
        .where(
            and(
                eq(bookings.status, 'Completed'),
                gte(bookings.date, minDate),
                lte(bookings.date, maxDate),
            ),
        );

    let sentCount = 0;

    for (const b of rows) {
        const pd = (b.propertyDetails as Record<string, unknown>) || {};
        const frequency = String(pd.frequency || '');
        if (frequency && frequency !== 'One-time') continue;

        // Check if customer has any newer bookings
        if (b.customerId) {
            const newer = await db
                .select({ id: bookings.id })
                .from(bookings)
                .where(
                    and(
                        eq(bookings.customerId, b.customerId),
                        sql`${bookings.date} > ${b.date}`,
                        sql`${bookings.status} != 'Cancelled'`,
                    ),
                )
                .limit(1);
            if (newer.length > 0) continue;
        } else {
            continue; // Skip guest bookings
        }

        const brand = await loadBrandVars(db);
        const siteUrl = String(brand.site_url || 'https://cleanitneatly.com');

        if (b.contactEmail) {
            try {
                const { subject, html } = await renderTransactionalEmail(db, 'client_rebooking_nudge', {
                    ...brand,
                    client_name: b.contactName || 'there',
                    service_type: String(b.serviceType || 'cleaning'),
                    last_booking_date: String(b.date || ''),
                    booking_url: `${siteUrl}/book-cleaning`,
                });
                await sendEmail({
                    to: [{ email: b.contactEmail, name: b.contactName || 'Guest' }],
                    subject,
                    htmlContent: html,
                });
                sentCount += 1;
            } catch (e) {
                console.error('[rebooking nudge] email failed', b.id, e);
            }
        }

        if (b.customerId) {
            try {
                await db.insert(notifications).values({
                    userId: Number(b.customerId),
                    type: 'promo',
                    message: `Time for another clean? Book your next ${b.serviceType} and earn loyalty points!`,
                    isRead: false,
                });
            } catch (e) {
                console.error('[rebooking nudge] notification failed', b.id, e);
            }
        }
    }

    if (sentCount > 0) broadcastSync('notifications');
    return { scanned: rows.length, sent: sentCount };
}
