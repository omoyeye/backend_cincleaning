// Resets a database to a clean, production-like state. Safe to run repeatedly.
//   npm run db:seed            reference data + admin account
//   npm run db:seed -- --demo  also a demo cleaner, customer and bookings for local testing
// WARNING: deletes all users, staff, bookings and related records in the database DATABASE_URL points at.
import { db, poolConnection } from './db';
import {
    users,
    bookings,
    staff,
    bookingReminderLog,
    bookingMessages,
    bookingStaff,
    staffInvoices,
    staffCancelRequests,
    staffAssessments,
    customerInvoices,
    notifications,
    directMessages,
    expenses,
    quoteLeads,
    extraServices,
    services,
    superadmins,
} from './schema';
import bcrypt from 'bcryptjs';
import { seedBusinessSettings } from './seed/cinDumpData';
import { ensureMessageTemplatesSeededOnce } from './messageTemplates/seed';
import { seedGalleryAndBlogIfEmpty } from './seed/blogGallerySeed';
import { runColumnMigrations } from './migrations';

const WITH_DEMO = process.argv.includes('--demo');

/** Matches the live site's services (cleanitneatly.com/api/services). */
const SERVICES = [
    {
        name: 'General/Standard Cleaning',
        baseRate: '18.00',
        londonRate: '20.00',
        pricingModel: 'hourly',
        minDuration: 2,
        minNotice: 2,
        callOutCharge: null,
        description: '',
        features: JSON.stringify(['Property size-based pricing']),
        icon: 'Sparkles',
        active: true,
        bookingFlow: { steps: ['details', 'extras', 'schedule', 'location', 'requirements', 'invoice'], trigger: 'standard' },
    },
    {
        name: 'Deep Cleaning',
        baseRate: '25.00',
        pricingModel: 'room_based',
        minDuration: 1,
        minNotice: 3,
        callOutCharge: '25.00',
        description: '',
        features: JSON.stringify(['Room-based pricing']),
        icon: 'SprayCan',
        active: true,
        bookingFlow: { steps: ['details', 'extras', 'schedule', 'location', 'requirements', 'invoice'], trigger: 'deep' },
    },
    {
        name: 'End of Tenancy Cleaning',
        baseRate: '25.00',
        pricingModel: 'size_based',
        minDuration: 1,
        minNotice: 3,
        callOutCharge: '25.00',
        description: '',
        features: JSON.stringify(['Property type-based']),
        icon: 'Home',
        active: true,
        bookingFlow: { steps: ['details', 'extras', 'schedule', 'location', 'requirements', 'invoice'], trigger: 'end_of_tenancy' },
    },
    {
        name: 'AirBnB Cleaning',
        baseRate: '20.00',
        pricingModel: 'bedroom_based',
        minDuration: 2,
        minNotice: 1,
        callOutCharge: null,
        description: null,
        features: JSON.stringify(['Bedroom-based pricing']),
        icon: 'Hotel',
        active: true,
        bookingFlow: null,
    },
    {
        name: 'Commercial Cleaning',
        baseRate: '20.00',
        pricingModel: 'quote',
        minDuration: 1,
        minNotice: 2,
        callOutCharge: '20.00',
        description: '',
        features: JSON.stringify(['Quote-based']),
        icon: 'Building2',
        active: true,
        bookingFlow: { steps: ['details', 'schedule', 'location', 'requirements'], trigger: 'commercial' },
    },
    {
        name: 'Jet Washing/Garden',
        baseRate: '30.00',
        pricingModel: 'quote',
        minDuration: 2,
        minNotice: 2,
        callOutCharge: null,
        description: null,
        features: JSON.stringify(['Quote-based', 'Surface-type selection']),
        icon: 'Trees',
        active: false,
        bookingFlow: null,
    },
];

const EXTRAS = [
    { name: 'Reception', price: '20.00', duration: 45, type: 'fixed' },
    { name: 'Bathroom/Ensuite', price: '25.00', duration: 60, type: 'fixed' },
    { name: 'Bedroom', price: '20.00', duration: 60, type: 'fixed' },
    { name: 'Clock room toilet', price: '15.00', duration: 30, type: 'fixed' },
    { name: 'Kitchen', price: '25.00', duration: 60, type: 'fixed' },
    { name: 'Conservatory', price: '30.00', duration: 90, type: 'fixed' },
    { name: 'Utility', price: '10.00', duration: 30, type: 'fixed' },
    { name: 'Patio/balcony', price: '30.00', duration: 90, type: 'fixed' },
    { name: 'Study', price: '20.00', duration: 45, type: 'fixed' },
    { name: 'Single Oven', price: '35.00', duration: 60, type: 'fixed' },
    { name: 'Double Oven', price: '50.00', duration: 75, type: 'fixed' },
    { name: 'Range Oven', price: '70.00', duration: 120, type: 'fixed' },
    { name: 'Single Fridge', price: '35.00', duration: 60, type: 'fixed' },
    { name: 'Double Fridge', price: '55.00', duration: 75, type: 'fixed' },
    { name: 'Washer', price: '20.00', duration: 60, type: 'fixed' },
    { name: 'Dryer', price: '20.00', duration: 60, type: 'fixed' },
    { name: 'Dishwasher', price: '20.00', duration: 60, type: 'fixed' },
    { name: 'Carpet steam cleaning', price: '35.00', duration: 60, type: 'hourly' },
    { name: 'Single mattress', price: '25.00', duration: 30, type: 'fixed' },
    { name: 'Double mattress', price: '35.00', duration: 45, type: 'fixed' },
    { name: 'King size mattress', price: '45.00', duration: 60, type: 'fixed' },
    { name: 'Arm chair', price: '20.00', duration: 30, type: 'fixed' },
    { name: '2 seater sofa', price: '30.00', duration: 45, type: 'fixed' },
    { name: '3 seater sofa', price: '40.00', duration: 60, type: 'fixed' },
    { name: 'Reachable external window', price: '5.00', duration: 15, type: 'fixed' },
    { name: 'Window blind', price: '20.00', duration: 0, type: 'range' },
    { name: 'Hallway/Staircase', price: '10.00', duration: 30, type: 'fixed' },
];

function ymd(offsetDays: number): string {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Clock-in/out record as the staff app saves it, for a past demo job (local date/time). */
function workDone(daysAgo: number, inHHMM: string, outHHMM: string, extra: Record<string, unknown> = {}) {
    const at = (hm: string) => {
        const [y, m, d] = ymd(-daysAgo).split('-').map(Number);
        const [h, mi] = hm.split(':').map(Number);
        return new Date(y, m - 1, d, h, mi).toISOString();
    };
    return { clockInTime: inHHMM, clockInAtIso: at(inHHMM), clockOutTime: outHHMM, clockOutAtIso: at(outHHMM), notes: 'All rooms done.', ...extra };
}

function hhmm(offsetMinutes: number): string {
    const d = new Date(Date.now() + offsetMinutes * 60000);
    return `${String(d.getHours()).padStart(2, '0')}:${d.getMinutes() < 30 ? '00' : '30'}`;
}

async function seedDemo(passwordHash: string): Promise<void> {
    const [cleanerUser] = await db
        .insert(users)
        .values({ email: 'cleaner@example.com', passwordHash, name: 'Demo Cleaner', role: 'staff', isVerified: true, phone: '07700900001' })
        .$returningId();
    const [cleaner] = await db
        .insert(staff)
        .values({
            userId: cleanerUser.id,
            name: 'Demo Cleaner',
            email: 'cleaner@example.com',
            role: 'Cleaner',
            hourlyRate: '13.00',
            status: 'Active',
            phone: '07700900001',
        })
        .$returningId();
    const [customer] = await db
        .insert(users)
        .values({ email: 'customer@example.com', passwordHash, name: 'Demo Customer', role: 'customer', isVerified: true, referralCode: 'DEMO01' })
        .$returningId();

    const base = {
        customerId: customer.id,
        serviceType: 'General/Standard Cleaning',
        contactName: 'Demo Customer',
        contactEmail: 'customer@example.com',
        contactPhone: null,
        extras: [],
    };
    const rows = [
        { ...base, bookingId: 'CIN-DEMO01', date: ymd(0), time: hhmm(60), status: 'Confirmed', totalPrice: '54.00', priceRegion: 'standard', hourlyRate: '18.00', addressLine1: '10 Deansgate', addressCity: 'Manchester', addressPostcode: 'M3 2BW', propertyDetails: { bedrooms: 2, bathrooms: 1, duration: 3, frequency: 'One-time' }, assignedStaffId: cleaner.id },
        { ...base, bookingId: 'CIN-DEMO02', date: ymd(0), time: hhmm(240), status: 'Pending', totalPrice: '40.00', priceRegion: 'london', hourlyRate: '20.00', addressLine1: '1 Hackney Road', addressCity: 'London', addressPostcode: 'E2 7NX', propertyDetails: { bedrooms: 1, bathrooms: 1, duration: 2, frequency: 'One-time' }, assignedStaffId: null },
        { ...base, bookingId: 'CIN-DEMO03', date: ymd(-7), time: '10:00', status: 'Completed', totalPrice: '54.00', priceRegion: 'standard', hourlyRate: '18.00', addressLine1: '10 Deansgate', addressCity: 'Manchester', addressPostcode: 'M3 2BW', propertyDetails: { bedrooms: 2, bathrooms: 1, duration: 3, frequency: 'Weekly' }, assignedStaffId: cleaner.id, rating: 5, feedback: 'Spotless, thank you!', workCompletion: workDone(7, '10:07', '13:04'), enRouteAt: new Date(workDone(7, '09:35', '09:35').clockInAtIso) },
        { ...base, bookingId: 'CIN-DEMO04', date: ymd(-3), time: '09:00', status: 'Completed', totalPrice: '40.00', priceRegion: 'london', hourlyRate: '20.00', addressLine1: '1 Hackney Road', addressCity: 'London', addressPostcode: 'E2 7NX', propertyDetails: { bedrooms: 1, bathrooms: 1, duration: 2, frequency: 'One-time' }, assignedStaffId: cleaner.id, rating: 2, feedback: 'Skirting boards and the oven door were missed.', workCompletion: workDone(3, '09:31', '11:15', { issues: 'Hoover battery ran low.', earlyClockOutReason: 'Client asked to finish early.' }), lateNotices: [{ id: 'demo-late-1', staffId: cleaner.id, staffName: 'Demo Cleaner', reason: 'Heavy traffic', etaTime: '09:30', minutesLate: 30, message: '', sentAt: new Date(Date.now() - 3 * 86400000).toISOString(), notified: { client: true, admin: true } }] },
    ];
    for (const row of rows) {
        const [b] = await db.insert(bookings).values(row as any).$returningId();
        if (row.assignedStaffId) await db.insert(bookingStaff).values({ bookingId: b.id, staffId: row.assignedStaffId });
    }

    // Homepage free-quote requests: a fresh one, an unfinished one left waiting, and one that went on to book.
    const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);
    await db.insert(quoteLeads).values([
        { firstName: 'Jane', email: 'jane.quote@example.com', phone: '07700 900123', postcode: 'SW1A 1AA', serviceType: 'Deep Cleaning', bedrooms: '2', bathrooms: '1', priceEstimate: '150.00', status: 'new', createdAt: daysAgo(0.1) },
        { firstName: 'Sam', email: 'unfinished@example.com', serviceType: 'Pending', status: 'new', createdAt: daysAgo(2) },
        { firstName: 'Demo', email: 'customer@example.com', postcode: 'M3 2BW', serviceType: 'Standard Cleaning', bedrooms: '2', bathrooms: '1', priceEstimate: '54.00', status: 'contacted', adminNotes: 'Called back, booking a weekly clean.', statusUpdatedAt: daysAgo(9), createdAt: daysAgo(10) },
    ]);
    console.log('  ✓ demo data — cleaner@example.com (staff), customer@example.com (customer), 4 bookings, 3 quote requests');
}

async function main() {
    const target = new URL(String(process.env.DATABASE_URL));
    console.log(`Seeding ${target.hostname}:${target.port || 3306}${target.pathname}${WITH_DEMO ? ' (with demo data)' : ''}...`);

    const seedAdminPassword = process.env.SEED_ADMIN_PASSWORD;
    if (!seedAdminPassword || seedAdminPassword.length < 8) {
        throw new Error('SEED_ADMIN_PASSWORD must be set and at least 8 characters long.');
    }

    await runColumnMigrations();

    // Children before parents so foreign keys never block the reset.
    for (const table of [
        bookingMessages,
        bookingReminderLog,
        bookingStaff,
        staffCancelRequests,
        staffAssessments,
        customerInvoices,
        notifications,
        directMessages,
        expenses,
        quoteLeads,
        bookings,
        staffInvoices,
        staff,
        users,
        superadmins,
        services,
        extraServices,
    ]) {
        await db.delete(table);
    }

    await seedBusinessSettings(db);
    await ensureMessageTemplatesSeededOnce(db);
    await seedGalleryAndBlogIfEmpty(db);

    const passwordHash = await bcrypt.hash(seedAdminPassword, 10);
    await db.insert(users).values({
        email: 'admin@niceneat.com',
        passwordHash,
        name: 'Super Admin',
        role: 'admin',
        isVerified: true,
    });
    await db.insert(superadmins).values({ email: 'admin@niceneat.com', passwordHash, name: 'Super Admin' });

    await db.insert(services).values(SERVICES as any);
    await db.insert(extraServices).values(EXTRAS);
    console.log(`  ✓ admin account, ${SERVICES.length} services, ${EXTRAS.length} extras`);

    if (WITH_DEMO) await seedDemo(passwordHash);

    console.log('Seeding complete!');
}

main()
    .then(() => poolConnection.end())
    .then(() => process.exit(0))
    .catch(async (err) => {
        console.error(err);
        await poolConnection.end().catch(() => {});
        process.exit(1);
    });
