import { mysqlTable, serial, varchar, text, timestamp, int, boolean, json, decimal, longtext } from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';

export const users = mysqlTable('users', {
    id: int().primaryKey().autoincrement(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    role: varchar('role', { length: 50 }).notNull().default('customer'), // customer, admin, staff
    isVerified: boolean('is_verified').default(false),
    loyaltyPoints: int('loyalty_points').default(0),
    referralCode: varchar('referral_code', { length: 20 }).unique(),
    referredBy: varchar('referred_by', { length: 20 }), // Code of the referrer
    /** Optional mobile for welcome SMS and contact */
    phone: varchar('phone', { length: 50 }),
    /** Optional home address — free-text, usually entered alongside postcode. */
    address: text('address'),
    /** Optional UK postcode (uppercase, canonical spaced form). */
    postcode: varchar('postcode', { length: 20 }),
    imageUrl: text('image_url'),
    /** Optional menu-level scope for non-superadmin admins. Empty/null => full admin UI. */
    adminTabs: json('admin_tabs'),
    resetToken: varchar('reset_token', { length: 255 }),
    resetTokenExpiry: timestamp('reset_token_expiry'),
    createdAt: timestamp('created_at').defaultNow(),
});

export const superadmins = mysqlTable('superadmins', {
    id: int().primaryKey().autoincrement(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    resetToken: varchar('reset_token', { length: 255 }),
    resetTokenExpiry: timestamp('reset_token_expiry'),
    createdAt: timestamp('created_at').defaultNow(),
});

export const services = mysqlTable('services', {
    id: int().primaryKey().autoincrement(),
    name: varchar('name', { length: 255 }).notNull(),
    baseRate: decimal('base_rate', { precision: 10, scale: 2 }).notNull(),
    /** Hourly rate for Greater London postcodes (Standard cleaning); null = same as baseRate everywhere. */
    londonRate: decimal('london_rate', { precision: 10, scale: 2 }),
    pricingModel: varchar('pricing_model', { length: 50 }).default('hourly'), // hourly, flat, size_based, room_based, quote
    minDuration: int('min_duration').default(2),
    minNotice: int('min_notice').default(2), // days
    /** Deep / end-of-tenancy fixed call-out fee (£); null = use app default (30) in pricing helpers */
    callOutCharge: decimal('call_out_charge', { precision: 10, scale: 2 }),
    description: text('description'),
    features: json('features'), // Store special features like "Property size-based pricing"
    icon: varchar('icon', { length: 50 }), // lucide icon name
    active: boolean('active').default(true),
    /** Admin-configured trigger + wizard step list for the booking form flow */
    bookingFlow: json('booking_flow'),
});

export const extraServices = mysqlTable('extra_services', {
    id: int().primaryKey().autoincrement(),
    name: varchar('name', { length: 255 }).notNull(),
    price: decimal('price', { precision: 10, scale: 2 }).notNull(),
    type: varchar('type', { length: 50 }).default('fixed'), // fixed, hourly, range (store min price)
    duration: int('duration').default(30), // minutes
    active: boolean('active').default(true),
});

export const discounts = mysqlTable('discounts', {
    id: int().primaryKey().autoincrement(),
    code: varchar('code', { length: 50 }).notNull().unique(),
    type: varchar('type', { length: 20 }).default('fixed'), // 'fixed' or 'percentage'
    value: decimal('value', { precision: 10, scale: 2 }).notNull(),
    minOrderValue: decimal('min_order_value', { precision: 10, scale: 2 }).default('0'),
    expiresAt: timestamp('expires_at'),
    isActive: boolean('is_active').default(true),
    usageLimit: int('usage_limit'),
    usedCount: int('used_count').default(0),
    createdAt: timestamp('created_at').defaultNow(),
});

export const bookings = mysqlTable('bookings', {
    id: int().primaryKey().autoincrement(),
    bookingId: varchar('booking_id', { length: 20 }).unique(), // CIN-XXXXXX
    customerId: int('customer_id').references(() => users.id), // nullable for guest bookings
    serviceType: varchar('service_type', { length: 50 }).notNull(),
    date: varchar('date', { length: 20 }).notNull(), // YYYY-MM-DD
    time: varchar('time', { length: 10 }).notNull(), // HH:MM
    status: varchar('status', { length: 20 }).default('Pending'), // Pending, Confirmed, Completed, Cancelled
    totalPrice: decimal('total_price', { precision: 10, scale: 2 }).notNull(),
    addressLine1: varchar('address_line_1', { length: 255 }).notNull(),
    addressCity: varchar('address_city', { length: 100 }).notNull(),
    addressPostcode: varchar('address_postcode', { length: 20 }).notNull(),
    contactName: varchar('contact_name', { length: 255 }).notNull(),
    contactEmail: varchar('contact_email', { length: 255 }).notNull(),
    contactPhone: varchar('contact_phone', { length: 50 }),
    propertyDetails: json('property_details'), // Store JSON of bedrooms, etc.
    extras: json('extras'), // Array of extra IDs
    instructions: text('instructions'),
    assignedStaffId: int('assigned_staff_id').references(() => staff.id), // new
    workCompletion: json('work_completion'), // Store start/end times, notes, photos, signature

    // New Fields
    discountCode: varchar('discount_code', { length: 50 }),
    discountAmount: decimal('discount_amount', { precision: 10, scale: 2 }).default('0'),
    pointsEarned: int('points_earned').default(0),
    /** Client rating after job completion (1–5); null until submitted */
    rating: int('rating'),
    feedback: text('feedback'),

    chatHistory: json('chat_history'),
    chatClosedByAdmin: boolean('chat_closed_by_admin').default(false),
    chatClosedAt: timestamp('chat_closed_at'),

    /** Admin marks client invoice as paid (shown on customer invoice view). */
    invoicePaid: boolean('invoice_paid').notNull().default(false),
    adminNotes: text('admin_notes'),
    stripePaymentLink: text('stripe_payment_link'),
    stripePaymentIntentId: varchar('stripe_booking_payment_intent_id', { length: 255 }),
    /** When the automatic 48h-before-job reminder was sent (email/SMS/in-app). */
    reminder48SentAt: timestamp('reminder_48h_sent_at'),
    /** When the automatic 24h-before-job reminder was sent. */
    reminder24SentAt: timestamp('reminder_24h_sent_at'),
    /** Client accepted deposit / payment terms on the booking wizard (audit). */
    depositTermsAcceptedAt: timestamp('deposit_terms_accepted_at'),
    /** Client agreed to short-notice cancellation fee when cancelling inside the policy window (audit). */
    shortNoticeCancelFeeConsentedAt: timestamp('short_notice_cancel_fee_consented_at'),
    /** Customer-uploaded proof of deposit or cancellation-fee payment (images/PDF as data URLs). */
    paymentFeeEvidence: json('payment_fee_evidence'),
    /** When the post-completion Google review request was sent (email/SMS/in-app). */
    reviewRequestSentAt: timestamp('review_request_sent_at'),

    /** Pricing region worked out from the postcode at booking time ('london' | 'standard'). */
    priceRegion: varchar('price_region', { length: 20 }),
    /** Hourly rate actually charged for hourly services, so invoices never depend on today's service rate. */
    hourlyRate: decimal('hourly_rate', { precision: 10, scale: 2 }),

    /** When an assigned cleaner tapped "Start travel" for this job. */
    enRouteAt: timestamp('en_route_at'),
    /** Last reported cleaner GPS fix: { lat, lng, at, staffId, staffName }. */
    cleanerLocation: json('cleaner_location'),
    /** Running-late notices sent by staff: [{ staffId, staffName, reason, etaTime, minutesLate, message, sentAt, notified }]. */
    lateNotices: json('late_notices'),
    /** Prompt sent to assigned staff telling them to set off. */
    onTheWayPromptSentAt: timestamp('on_the_way_prompt_sent_at'),
    /** Admin warned that no assigned cleaner was en route close to start time. */
    noEnRouteWarningSentAt: timestamp('no_en_route_warning_sent_at'),
    /** Admin warned that the booking had no assigned cleaner within 24h of start. */
    unassignedWarningSentAt: timestamp('unassigned_warning_sent_at'),
    /** When the cleaner clocked in on site (client is told once). */
    arrivedAt: timestamp('arrived_at'),

    createdAt: timestamp('created_at').defaultNow(),

});

/** Audit log for automatic booking reminders (admin UI + troubleshooting). */
export const bookingReminderLog = mysqlTable('booking_reminder_log', {
    id: int().primaryKey().autoincrement(),
    bookingId: int('booking_id').references(() => bookings.id),
    windowLabel: varchar('window_label', { length: 16 }).notNull(),
    channels: varchar('channels', { length: 160 }).notNull(),
    createdAt: timestamp('created_at').defaultNow()
});

export const staff = mysqlTable('staff', {
    id: int().primaryKey().autoincrement(),
    userId: int('user_id').references(() => users.id),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    role: varchar('role', { length: 50 }).default('Cleaner'), // Cleaner, Supervisor, Manager
    hourlyRate: decimal('hourly_rate', { precision: 10, scale: 2 }),
    skills: json('skills'), // Array of skills e.g. ["Deep Clean", "Carpet"]
    availability: json('availability'), // Store weekly availability
    status: varchar('status', { length: 20 }).default('Active'),
    phone: varchar('phone', { length: 50 }),
    address: text('address'),
    postcode: varchar('postcode', { length: 20 }),
    imageUrl: text('image_url'),
    bankName: varchar('bank_name', { length: 100 }),
    accountNumber: varchar('account_number', { length: 50 }),
    sortCode: varchar('sort_code', { length: 20 }),
});

export const businessSettings = mysqlTable('business_settings', {
    id: int().primaryKey().autoincrement(),
    key: varchar('key', { length: 100 }).notNull().unique(),
    value: longtext('value'), // JSON value or simple string
    updatedAt: timestamp('updated_at').defaultNow(),
});

export const emailTemplates = mysqlTable('email_templates', {
    id: int().primaryKey().autoincrement(),
    name: varchar('name', { length: 100 }).notNull().unique(), // e.g., 'booking_confirmation'
    subject: varchar('subject', { length: 255 }).notNull(),
    body: text('body').notNull(), // HTML content
    description: text('description'),
    variables: json('variables'), // List of available variables for this template
    active: boolean('active').default(true),
    updatedAt: timestamp('updated_at').defaultNow(),
});

export const smsTemplates = mysqlTable('sms_templates', {
    id: int().primaryKey().autoincrement(),
    name: varchar('name', { length: 100 }).notNull().unique(),
    message: text('message').notNull(),
    description: text('description'),
    variables: json('variables'),
    active: boolean('active').default(true),
    updatedAt: timestamp('updated_at').defaultNow(),
});

export const notifications = mysqlTable('notifications', {
    id: int().primaryKey().autoincrement(),
    userId: int('user_id').references(() => users.id),
    type: varchar('type', { length: 50 }).notNull(), // 'booking_update', 'system', 'promo'
    message: text('message').notNull(),
    isRead: boolean('is_read').default(false),
    createdAt: timestamp('created_at').defaultNow(),
});

/** Expo push tokens from the mobile app; one row per device, re-pointed if another user signs in on it. */
export const pushTokens = mysqlTable('push_tokens', {
    id: int().primaryKey().autoincrement(),
    userId: int('user_id').notNull().references(() => users.id),
    token: varchar('token', { length: 255 }).notNull().unique(),
    platform: varchar('platform', { length: 20 }).notNull(),
    createdAt: timestamp('created_at').defaultNow(),
    lastSeenAt: timestamp('last_seen_at').defaultNow(),
});

export const bookingStaff = mysqlTable('booking_staff', {
    id: int().primaryKey().autoincrement(),
    bookingId: int('booking_id').references(() => bookings.id),
    staffId: int('staff_id').references(() => staff.id),
    isPrimary: boolean('is_primary').default(false)
});

export const bookingMessages = mysqlTable('booking_messages', {
    id: int().primaryKey().autoincrement(),
    bookingId: int('booking_id').references(() => bookings.id),
    senderId: int('sender_id').references(() => users.id),
    senderRole: varchar('sender_role', { length: 20 }).notNull(),
    senderName: varchar('sender_name', { length: 255 }).notNull(),
    text: text('text').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
});

/** Staff-submitted weekly pay invoices (admin review). */
export const galleryItems = mysqlTable('gallery_items', {
    id: int().primaryKey().autoincrement(),
    title: varchar('title', { length: 255 }).notNull(),
    imageUrl: text('image_url').notNull(),
    caption: text('caption'),
    sortOrder: int('sort_order').notNull().default(0),
    published: boolean('published').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
});

export const blogPosts = mysqlTable('blog_posts', {
    id: int().primaryKey().autoincrement(),
    title: varchar('title', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 200 }).notNull().unique(),
    excerpt: text('excerpt'),
    bodyHtml: text('body_html').notNull(),
    heroImageUrl: longtext('hero_image_url'),
    metaTitle: varchar('meta_title', { length: 255 }),
    metaDescription: text('meta_description'),
    metaKeywords: text('meta_keywords'),
    published: boolean('published').notNull().default(true),
    publishedAt: timestamp('published_at'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
});

export const staffInvoices = mysqlTable('staff_invoices', {
    id: int().primaryKey().autoincrement(),
    staffId: int('staff_id').references(() => staff.id),
    staffName: varchar('staff_name', { length: 255 }),
    /** e.g. '2026-10-05 → 2026-10-11' (was 20 chars, which rejected the label the portals send). */
    weekLabel: varchar('week_label', { length: 60 }).notNull(),
    weekStart: varchar('week_start', { length: 20 }),
    weekEnd: varchar('week_end', { length: 20 }),
    totalAmount: decimal('total_amount', { precision: 10, scale: 2 }).notNull(),
    weekTotalHours: decimal('week_total_hours', { precision: 10, scale: 2 }).default('0'),
    weekJobCount: int('week_job_count').default(0),
    jobsJson: json('jobs_json').notNull(),
    bankJson: json('bank_json'),
    status: varchar('status', { length: 20 }).notNull().default('Pending'),
    adminNotes: text('admin_notes'),
    createdAt: timestamp('created_at').defaultNow(),
});

export const customerInvoices = mysqlTable('customer_invoices', {
    id: int().primaryKey().autoincrement(),
    invoiceNumber: varchar('invoice_number', { length: 50 }).notNull().unique(),
    bookingId: int('booking_id'),
    customerId: int('customer_id'),
    customerName: varchar('customer_name', { length: 255 }).notNull(),
    customerEmail: varchar('customer_email', { length: 255 }),
    customerPhone: varchar('customer_phone', { length: 50 }),
    items: json('items').notNull(),
    subtotal: decimal('subtotal', { precision: 10, scale: 2 }).notNull(),
    vatRate: decimal('vat_rate', { precision: 5, scale: 2 }).notNull().default('20.00'),
    vatAmount: decimal('vat_amount', { precision: 10, scale: 2 }).notNull(),
    total: decimal('total', { precision: 10, scale: 2 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    /** Shown to the customer on the invoice and in the invoice email. */
    notes: text('notes'),
    /** Private admin note, never shown to the customer. */
    adminNotes: text('admin_notes'),
    dueDate: varchar('due_date', { length: 20 }),
    paidAt: timestamp('paid_at'),
    sentAt: timestamp('sent_at'),
    sentVia: varchar('sent_via', { length: 20 }),
    stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
    stripePaymentUrl: varchar('stripe_payment_url', { length: 500 }),
    createdBy: int('created_by'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
});

/** Supervisor / admin on-the-job assessments of a cleaner (optionally tied to a booking). */
export const staffAssessments = mysqlTable('staff_assessments', {
    id: int().primaryKey().autoincrement(),
    staffId: int('staff_id').notNull().references(() => staff.id),
    bookingId: int('booking_id').references(() => bookings.id),
    assessorUserId: int('assessor_user_id'),
    assessorName: varchar('assessor_name', { length: 255 }).notNull(),
    rating: int('rating').notNull(), // overall 1-5
    punctuality: int('punctuality'), // 1-5, optional
    quality: int('quality'), // 1-5, optional
    professionalism: int('professionalism'), // 1-5, optional
    remark: text('remark').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
});

export const staffCancelRequests = mysqlTable('staff_cancel_requests', {
    id: int().primaryKey().autoincrement(),
    bookingId: int('booking_id').references(() => bookings.id),
    staffUserId: int('staff_user_id').references(() => users.id),
    staffName: varchar('staff_name', { length: 255 }),
    reason: text('reason'),
    adminNotes: text('admin_notes'),
    respondedBy: int('responded_by').references(() => users.id),
    respondedAt: timestamp('responded_at'),
    status: varchar('status', { length: 20 }).notNull().default('Pending'),
    createdAt: timestamp('created_at').defaultNow(),
});

export const promotions = mysqlTable('promotions', {
    id: int().primaryKey().autoincrement(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    bannerText: varchar('banner_text', { length: 500 }),
    discountCode: varchar('discount_code', { length: 50 }),
    discountPercent: int('discount_percent'),
    startDate: varchar('start_date', { length: 20 }).notNull(),
    endDate: varchar('end_date', { length: 20 }).notNull(),
    active: boolean('active').default(true),
    showOnHomepage: boolean('show_on_homepage').default(true),
    showOnBooking: boolean('show_on_booking').default(true),
    createdAt: timestamp('created_at').defaultNow(),
});

/** Leads captured by the homepage instant-quote widget (not real bookings). */
export const quoteLeads = mysqlTable('quote_leads', {
    id: int().primaryKey().autoincrement(),
    firstName: varchar('first_name', { length: 120 }),
    email: varchar('email', { length: 160 }).notNull(),
    phone: varchar('phone', { length: 50 }),
    postcode: varchar('postcode', { length: 12 }),
    serviceType: varchar('service_type', { length: 120 }).notNull(),
    bedrooms: varchar('bedrooms', { length: 10 }),
    bathrooms: varchar('bathrooms', { length: 10 }),
    priceEstimate: decimal('price_estimate', { precision: 10, scale: 2 }),
    /** new | contacted | converted | lost — set by admin */
    status: varchar('status', { length: 20 }).notNull().default('new'),
    brevoSynced: boolean('brevo_synced').notNull().default(false),
    /** Private admin notes (call outcome, follow-up date, etc.). */
    adminNotes: text('admin_notes'),
    /** When the status last changed, so admins can see how long a lead has waited. */
    statusUpdatedAt: timestamp('status_updated_at'),
    createdAt: timestamp('created_at').defaultNow(),
});

/** Admin expense tracker entries (receipts, purchases, business costs). */
export const expenses = mysqlTable('expenses', {
    id: int().primaryKey().autoincrement(),
    title: varchar('title', { length: 255 }).notNull(),
    amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
    category: varchar('category', { length: 100 }).notNull().default('general'),
    purpose: text('purpose'),
    receiptUrl: text('receipt_url'),
    expenseDate: varchar('expense_date', { length: 20 }).notNull(),
    createdBy: int('created_by').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow(),
});

/** Staff-to-admin direct chat messages. */
export const directMessages = mysqlTable('direct_messages', {
    id: int().primaryKey().autoincrement(),
    senderUserId: int('sender_user_id').notNull(),
    senderName: varchar('sender_name', { length: 255 }).notNull(),
    senderRole: varchar('sender_role', { length: 50 }).notNull(), // 'staff' or 'admin'
    recipientRole: varchar('recipient_role', { length: 50 }).notNull(), // 'admin' or 'staff'
    recipientUserId: int('recipient_user_id'), // null = broadcast to all admins
    text: text('text').notNull(),
    isRead: boolean('is_read').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow(),
});

// Relations
export const bookingsRelations = relations(bookings, ({ one, many }) => ({
    customer: one(users, {
        fields: [bookings.customerId],
        references: [users.id],
    }),
    assignedStaff: one(staff, {
        fields: [bookings.assignedStaffId],
        references: [staff.id],
    }),
    staffAssignments: many(bookingStaff)
}));

export const bookingStaffRelations = relations(bookingStaff, ({ one }) => ({
    booking: one(bookings, {
        fields: [bookingStaff.bookingId],
        references: [bookings.id]
    }),
    staff: one(staff, {
        fields: [bookingStaff.staffId],
        references: [staff.id]
    })
}));



export const staffRelations = relations(staff, ({ many }) => ({
    assignments: many(bookingStaff)
}));
