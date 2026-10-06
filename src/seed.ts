import { db } from './db';
import {
    users,
    bookings,
    staff,
    bookingReminderLog,
    bookingMessages,
    bookingStaff,
    staffInvoices,
    extraServices,
    services,
    superadmins,
} from './schema';
import bcrypt from 'bcryptjs';
import { seedBusinessSettings } from './seed/cinDumpData';
import { ensureMessageTemplatesSeededOnce } from './messageTemplates/seed';
import { seedGalleryAndBlogIfEmpty } from './seed/blogGallerySeed';

async function main() {
    console.log('Seeding database...');

    // Clear transactional tables first (FK order)
    await db.delete(bookingReminderLog);
    await db.delete(bookingMessages);
    await db.delete(bookingStaff);
    await db.delete(bookings);
    await db.delete(staffInvoices);
    await db.delete(staff);
    await db.delete(users);

    // Reference / lookup tables
    await seedBusinessSettings(db);
    await ensureMessageTemplatesSeededOnce(db);
    await seedGalleryAndBlogIfEmpty(db);

    // Admin user
    const seedAdminPassword = process.env.SEED_ADMIN_PASSWORD;
    if (!seedAdminPassword || seedAdminPassword.length < 8) {
        throw new Error('SEED_ADMIN_PASSWORD must be set and at least 8 characters long.');
    }
    const hashedAdminPassword = await bcrypt.hash(seedAdminPassword, 10);

    await db.insert(users).values({
        email: 'admin@niceneat.com',
        passwordHash: hashedAdminPassword,
        name: 'Super Admin',
        role: 'admin',
        isVerified: true,
    });

    // create the user superuser record in superadmin table
    await db.insert(superadmins).values({
        email: 'admin@niceneat.com',
        passwordHash: hashedAdminPassword,
        name: 'Super Admin'
    });


    // Create Services
    await db.insert(services).values([
        {
            name: 'General/Standard Cleaning',
            baseRate: '20.00',
            pricingModel: 'hourly',
            minDuration: 2,
            minNotice: 2,
            features: JSON.stringify(['Property size-based pricing']),
            icon: 'Sparkles'
        },
        {
            name: 'Deep Cleaning',
            baseRate: '30.00',
            pricingModel: 'room_based',
            minDuration: 3,
            minNotice: 3,
            callOutCharge: '30.00',
            features: JSON.stringify(['Room-based pricing']),
            icon: 'SprayCan'
        },
        {
            name: 'End of Tenancy Cleaning',
            baseRate: '30.00',
            pricingModel: 'size_based',
            minDuration: 3,
            minNotice: 5,
            callOutCharge: '30.00',
            features: JSON.stringify(['Property type-based']),
            icon: 'Home'
        },
        {
            name: 'AirBnB Cleaning',
            baseRate: '20.00',
            pricingModel: 'bedroom_based',
            minDuration: 2,
            minNotice: 1,
            features: JSON.stringify(['Bedroom-based pricing']),
            icon: 'Hotel'
        },
        {
            name: 'Commercial Cleaning',
            baseRate: '25.00',
            pricingModel: 'quote',
            minDuration: 2,
            minNotice: 2,
            features: JSON.stringify(['Quote-based']),
            icon: 'Building2'
        },
        {
            name: 'Jet Washing/Garden',
            baseRate: '30.00',
            pricingModel: 'quote',
            minDuration: 2,
            minNotice: 2,
            features: JSON.stringify(['Quote-based', 'Surface-type selection']),
            icon: 'Trees'
        },
    ]);

    // Create Extra Services
    await db.insert(extraServices).values([
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
    ]);

    console.log('Seeding complete!');
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
