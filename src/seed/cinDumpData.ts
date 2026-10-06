import type { MySql2Database } from 'drizzle-orm/mysql2';
import { businessSettings } from '../schema';
import * as schema from '../schema';

type Db = MySql2Database<typeof schema>;

// ---------------------------------------------------------------------------
// business_settings seed data
// ---------------------------------------------------------------------------

const BUSINESS_SETTINGS: Array<{
    key: string;
    value: any;
}> = [
        { key: 'theme_button', value: '#4f46e5' },
        { key: 'theme_background', value: '#f7fcfa' },
        { key: 'theme_primary', value: '#4f46e5' },
        { key: 'phone', value: '07909565925' },
        { key: 'logoUrl', value: 'null' },
        { key: 'primaryColor', value: '#4f46e5' },
        { key: 'website', value: 'www.cleanitneatly.com' },
        { key: 'email', value: 'support@cleanitneatly.com' },
        { key: 'companyName', value: 'CiN Cleaning' },
        { key: 'socialLinks', value: JSON.stringify({ facebook: 'https://www.facebook.com/cleanitneatly', tiktok: 'https://www.tiktok.com/@cleanitneatly', instagram: 'https://www.instagram.com/cleanitneatly' }) },
        { key: 'address', value: 'Manchester and London' },
        {
            key: 'pricingPage',
            value: JSON.stringify({
                eyebrow: 'TRANSPARENT PRICING',
                title: 'OUR PRICES',
                subtitle: 'Premium cleaning should not be a mystery. We offer straightforward hourly rates from £13/hr + VAT with zero hidden fees.',
                popularBadgeLabel: 'Popular',
                selectPlanButtonLabel: 'Select Plan',
                plans: [
                    { id: 'one-off', label: 'ONE-OFF', price: 30, note: 'Perfect for a single deep clean or quick refresh.', popular: false },
                    { id: 'one-month', label: 'ONE MONTH', price: 25, note: 'Maintain a steady sparkle with our monthly introductory package.', popular: true },
                    { id: 'two-months', label: 'TWO MONTHS', price: 23, note: 'Extended consistency for those who value long-term tidy maintenance.', popular: false },
                    { id: 'three-months', label: 'THREE MONTHS', price: 20, note: 'Our quarterly refresh package designed for families and busy professionals.', popular: false },
                    { id: 'six-months', label: 'SIX MONTHS', price: 19, note: 'Commit to cleanliness and save with our half-year premium membership.', popular: false },
                    { id: 'yearly', label: 'YEARLY', price: 18, note: 'The ultimate peace of mind. Full-year professional care for your space.', popular: false },
                ],
                calculator: {
                    title: 'GET A QUOTE',
                    frequencySectionLabel: 'Frequency',
                    frequencies: [
                        { id: 'weekly', label: 'Weekly', factor: 1 },
                        { id: 'fortnightly', label: 'Fortnightly', factor: 0.9 },
                        { id: 'one-time', label: 'One Time', factor: 1.15 },
                    ],
                    serviceLengthLabel: 'Commitment (months)',
                    serviceLengthMin: 3,
                    serviceLengthMax: 6,
                    serviceLengthStep: 3,
                    serviceLengthDefault: 3,
                    hoursPerVisitLabel: 'Hours per Visit',
                    hoursPerVisitMin: 2,
                    hoursPerVisitMax: 8,
                    hoursPerVisitStep: 0.5,
                    hoursPerVisitDefault: 3.5,
                    formula: 'cin_tiered_hourly',
                    baseHourlyRate: 13,
                    estimateLabel: 'Estimated Rate',
                    estimatePrefix: 'FROM £',
                    estimateSuffix: 'PER HOUR',
                    bookButtonLabel: 'BOOK THIS PLAN',
                    decimalPlaces: 2,
                    durationUnitLabel: 'Hours',
                },
            })
        },
        {
            key: 'websiteContent',
            value: JSON.stringify({
                heroes: [
                    {
                        id: 'hero-home', page: 'home',
                        eyebrow: 'CERTIFIED & TRUSTED',
                        title: 'Professional Cleaning You Can Trust.',
                        highlight: 'Trust',
                        subtitle: 'Serving homes and businesses across London and Manchester. Vetted professionals, eco-friendly products, and a 100% satisfaction guarantee. We do not just clean, we restore your space.',
                        ctaPrimary: 'Book a clean', ctaSecondary: 'Residential services', ctaTertiary: 'Contact us',
                        imageUrl: '/uploads/seed/4b5c0f457f.jpg',
                    },
                    {
                        id: 'hero-residential', page: 'residential',
                        eyebrow: 'RESIDENTIAL EXCELLENCE',
                        title: 'A Spotless, Healthy Home.',
                        highlight: 'Spotless',
                        subtitle: 'From regular upkeep to deep transformations, our fully insured teams deliver meticulous cleaning designed around your lifestyle and peace of mind.',
                        ctaPrimary: 'Schedule a Clean', ctaSecondary: 'View Pricing',
                        imageUrl: '/uploads/seed/4b5c0f457f.jpg',
                    },
                    {
                        id: 'hero-commercial', page: 'commercial',
                        eyebrow: 'COMMERCIAL CLEANING',
                        title: 'Immaculate Workspaces.',
                        highlight: 'Immaculate',
                        subtitle: 'Protect your brand, inspire your team, and welcome clients to a pristine environment. 24/7 support and custom schedules available.',
                        ctaPrimary: 'Request Corporate Quote', ctaSecondary: 'View Capabilities',
                        imageUrl: '/uploads/seed/4b5c0f457f.jpg',
                    },
                    {
                        id: 'hero-about', page: 'about',
                        eyebrow: 'ABOUT CiN CLEANING',
                        title: 'Your Premium Cleaning Partner.',
                        highlight: 'Partner',
                        subtitle: 'A family-ethos business combining years of expertise with industry-tested products to deliver unmatched reliability and care.',
                        ctaPrimary: 'Schedule Consultation', ctaSecondary: 'See Standards',
                        imageUrl: '/uploads/seed/4b5c0f457f.jpg',
                    },
                    {
                        id: 'hero-pricing', page: 'pricing',
                        eyebrow: 'TRANSPARENT PRICING',
                        title: 'Our Prices',
                        highlight: 'Prices',
                        subtitle: 'Straightforward rates and plans with no hidden fees.',
                        ctaPrimary: 'Book This Plan', ctaSecondary: 'Get a Quote',
                        imageUrl: '',
                    },
                    {
                        id: 'hero-contact', page: 'contact',
                        eyebrow: 'GET IN TOUCH',
                        title: "Let's restore your space together.",
                        highlight: 'space together',
                        subtitle: 'Tell us about your property and we will recommend the perfect plan.',
                        ctaPrimary: 'Send Inquiry', ctaSecondary: 'Book Now',
                        imageUrl: '',
                    },
                ],
                adverts: [
                    {
                        id: 'ad-home-1',
                        title: 'Spring Deep Clean Offer',
                        description: 'Book a full deep clean this month and get priority scheduling with trusted, vetted operatives.',
                        ctaLabel: 'Book this offer', ctaHref: '/contact-us',
                        imageUrl: '/siteshots/home-reference-final.jpg',
                        active: true,
                    },
                    {
                        id: 'ad-home-2',
                        title: 'Commercial Maintenance Plan',
                        description: 'Keep your workplace presentation-ready with a flexible recurring plan tailored to your team hours.',
                        ctaLabel: 'Request a quote', ctaHref: '/commercial',
                        imageUrl: '/siteshots/commercial.jpg',
                        active: true,
                    },
                ],
                footerBlurb: 'CiN Cleaning Clean It Neatly. Premium residential and commercial cleaning with transparent pricing and vetted teams.',
                footerLinks: [
                    { id: 'f1', label: 'Privacy Policy', href: '#' },
                    { id: 'f2', label: 'Terms', href: '#' },
                    { id: 'f3', label: 'Contact', href: '/contact-us' },
                    { id: 'f4', label: 'Blog', href: '/cleaning-blog' },
                    { id: 'f5', label: 'Contact', href: '/contact-us' },
                ],
            }),
        },
        { key: 'referralRewardAmount', value: 1 },
    ];

// ---------------------------------------------------------------------------
// Seed function
// ---------------------------------------------------------------------------

/** Replaces all business_settings rows with the CiN reference data. */
export async function seedBusinessSettings(db: Db): Promise<void> {
    await db.delete(businessSettings);
    for (const row of BUSINESS_SETTINGS) {
        await db.insert(businessSettings).values({
            key: row.key,
            value: row.value,
        });
    }
    console.log(`  ✓ business_settings — ${BUSINESS_SETTINGS.length} rows inserted`);
}
