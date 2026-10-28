import { poolConnection } from './db';

/**
 * Idempotent column additions for columns introduced after a database was first created.
 * Runs on server start and before seeding; "duplicate column" errors mean it is already applied.
 */
const COLUMN_MIGRATIONS = [
    'ALTER TABLE `users` ADD COLUMN `marketing_opt_in` BOOLEAN DEFAULT FALSE',
    'ALTER TABLE `bookings` ADD COLUMN `deposit_paid_at` TIMESTAMP NULL DEFAULT NULL',
    'ALTER TABLE `bookings` ADD COLUMN `deposit_paid_amount` DECIMAL(10,2) NULL',
    // Pay in full option and the balance after the clean.
    "ALTER TABLE `bookings` ADD COLUMN `payment_choice` VARCHAR(10) NULL DEFAULT 'deposit'",
    'ALTER TABLE `bookings` ADD COLUMN `paid_in_full_at` TIMESTAMP NULL DEFAULT NULL',
    'ALTER TABLE `bookings` ADD COLUMN `balance_paid_amount` DECIMAL(10,2) NULL',
    'ALTER TABLE `bookings` ADD COLUMN `stripe_balance_intent_id` VARCHAR(255) NULL',
    'ALTER TABLE `bookings` ADD COLUMN `balance_request_sent_at` TIMESTAMP NULL DEFAULT NULL',
    // Paid holiday for contracted staff.
    "ALTER TABLE `staff` ADD COLUMN `contract_type` VARCHAR(20) NULL DEFAULT 'self_employed'",
    "ALTER TABLE `staff` ADD COLUMN `holiday_allowance_days` DECIMAL(4,1) NULL DEFAULT 26",
    "ALTER TABLE `staff` ADD COLUMN `holiday_hours_per_day` DECIMAL(4,2) NULL DEFAULT 8",
    // Public reviews: client consent to publish, and admin moderation.
    'ALTER TABLE `bookings` ADD COLUMN `review_public` BOOLEAN DEFAULT FALSE',
    'ALTER TABLE `bookings` ADD COLUMN `review_hidden` BOOLEAN DEFAULT FALSE',
    // quote_offers columns added after the first version of the table.
    'ALTER TABLE `quote_offers` ADD COLUMN `client_phone` VARCHAR(50) NULL',
    'ALTER TABLE `quote_offers` ADD COLUMN `client_address` TEXT NULL',
    'ALTER TABLE `quote_offers` ADD COLUMN `postcode` VARCHAR(12) NULL',
    'ALTER TABLE `quote_offers` ADD COLUMN `property_summary` VARCHAR(255) NULL',
    'ALTER TABLE `quote_offers` ADD COLUMN `notes` TEXT NULL',
    'ALTER TABLE `quote_offers` ADD COLUMN `details` JSON NULL',
    'ALTER TABLE `customer_invoices` ADD COLUMN `stripe_payment_intent_id` VARCHAR(255) DEFAULT NULL',
    'ALTER TABLE `customer_invoices` ADD COLUMN `stripe_payment_url` VARCHAR(500) DEFAULT NULL',
    'ALTER TABLE `bookings` ADD COLUMN `en_route_at` TIMESTAMP NULL DEFAULT NULL',
    'ALTER TABLE `bookings` ADD COLUMN `cleaner_location` JSON NULL',
    'ALTER TABLE `bookings` ADD COLUMN `late_notices` JSON NULL',
    'ALTER TABLE `bookings` ADD COLUMN `on_the_way_prompt_sent_at` TIMESTAMP NULL DEFAULT NULL',
    'ALTER TABLE `bookings` ADD COLUMN `no_en_route_warning_sent_at` TIMESTAMP NULL DEFAULT NULL',
    'ALTER TABLE `bookings` ADD COLUMN `unassigned_warning_sent_at` TIMESTAMP NULL DEFAULT NULL',
    'ALTER TABLE `users` ADD COLUMN `image_url` TEXT NULL',
    'ALTER TABLE `services` ADD COLUMN `london_rate` DECIMAL(10,2) NULL DEFAULT NULL',
    // Referral credit a client used on a booking.
    'ALTER TABLE `bookings` ADD COLUMN `referral_credit_used` DECIMAL(10,2) NULL',
    'ALTER TABLE `bookings` ADD COLUMN `price_region` VARCHAR(20) NULL DEFAULT NULL',
    'ALTER TABLE `bookings` ADD COLUMN `hourly_rate` DECIMAL(10,2) NULL DEFAULT NULL',
    'ALTER TABLE `quote_leads` ADD COLUMN `admin_notes` TEXT NULL',
    'ALTER TABLE `customer_invoices` ADD COLUMN `admin_notes` TEXT NULL',
    'ALTER TABLE `bookings` ADD COLUMN `arrived_at` TIMESTAMP NULL DEFAULT NULL',
    'ALTER TABLE `quote_leads` ADD COLUMN `status_updated_at` TIMESTAMP NULL DEFAULT NULL',
];

/** One-off data steps that run only when the column they depend on is created for the first time. */
const ON_COLUMN_CREATED: Record<string, string[]> = {
    // Bookings already paid in full by card (admin full-payment links) count as paid in full.
    'ALTER TABLE `bookings` ADD COLUMN `paid_in_full_at` TIMESTAMP NULL DEFAULT NULL': [
        `UPDATE \`bookings\` SET \`paid_in_full_at\` = \`deposit_paid_at\`
         WHERE \`deposit_paid_amount\` IS NOT NULL AND \`deposit_paid_amount\` >= \`total_price\` - 0.01`,
    ],
    // Jobs finished before this feature existed never get a surprise balance request.
    'ALTER TABLE `bookings` ADD COLUMN `balance_request_sent_at` TIMESTAMP NULL DEFAULT NULL': [
        "UPDATE `bookings` SET `balance_request_sent_at` = NOW() WHERE `status` IN ('Completed', 'Cancelled')",
    ],
    // London Standard/General cleaning is £20/hour (Manchester and everywhere else stays on the base rate).
    'ALTER TABLE `services` ADD COLUMN `london_rate` DECIMAL(10,2) NULL DEFAULT NULL': [
        `UPDATE \`services\` SET \`london_rate\` = 20.00
         WHERE \`london_rate\` IS NULL AND \`pricing_model\` = 'hourly'
           AND (LOWER(\`name\`) LIKE '%standard%' OR LOWER(\`name\`) LIKE '%general%'
                OR JSON_UNQUOTE(JSON_EXTRACT(\`booking_flow\`, '$.trigger')) = 'standard')`,
    ],
};

/** Tables added after first deploy (created only if missing). */
const TABLE_MIGRATIONS = [
    `CREATE TABLE IF NOT EXISTS \`business_reports\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`kind\` VARCHAR(20) NOT NULL DEFAULT 'weekly',
        \`period_start\` VARCHAR(10) NOT NULL,
        \`period_end\` VARCHAR(10) NOT NULL,
        \`data\` JSON NOT NULL,
        \`ai\` JSON NULL,
        \`ai_model\` VARCHAR(60) NULL,
        \`emailed_at\` TIMESTAMP NULL DEFAULT NULL,
        \`created_by\` VARCHAR(160) NULL,
        \`generated_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_business_reports_period\` (\`kind\`, \`period_start\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`quote_offers\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`lead_id\` INT NULL,
        \`quote_number\` VARCHAR(40) NULL,
        \`client_name\` VARCHAR(160) NULL,
        \`client_email\` VARCHAR(160) NOT NULL,
        \`client_phone\` VARCHAR(50) NULL,
        \`client_address\` TEXT NULL,
        \`postcode\` VARCHAR(12) NULL,
        \`property_summary\` VARCHAR(255) NULL,
        \`service_type\` VARCHAR(160) NULL,
        \`items\` JSON NULL,
        \`details\` JSON NULL,
        \`subtotal\` DECIMAL(10,2) NOT NULL DEFAULT 0,
        \`discount\` DECIMAL(10,2) NOT NULL DEFAULT 0,
        \`vat_rate\` DECIMAL(5,2) NOT NULL DEFAULT 0,
        \`vat_amount\` DECIMAL(10,2) NOT NULL DEFAULT 0,
        \`total\` DECIMAL(10,2) NOT NULL DEFAULT 0,
        \`message\` TEXT NULL,
        \`notes\` TEXT NULL,
        \`valid_until\` VARCHAR(20) NULL,
        \`status\` VARCHAR(20) NOT NULL DEFAULT 'draft',
        \`sent_at\` TIMESTAMP NULL DEFAULT NULL,
        \`sent_count\` INT NOT NULL DEFAULT 0,
        \`created_by\` VARCHAR(160) NULL,
        \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_quote_offers_lead\` (\`lead_id\`),
        CONSTRAINT \`fk_quote_offers_lead\` FOREIGN KEY (\`lead_id\`) REFERENCES \`quote_leads\` (\`id\`) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS \`push_tokens\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`user_id\` INT NOT NULL,
        \`token\` VARCHAR(255) NOT NULL,
        \`platform\` VARCHAR(20) NOT NULL,
        \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        \`last_seen_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`push_tokens_token_unique\` (\`token\`),
        KEY \`push_tokens_user_idx\` (\`user_id\`),
        CONSTRAINT \`push_tokens_user_id_users_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS \`staff_holidays\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`staff_id\` INT NOT NULL,
        \`start_date\` VARCHAR(10) NOT NULL,
        \`end_date\` VARCHAR(10) NOT NULL,
        \`half_day\` BOOLEAN DEFAULT FALSE,
        \`days\` DECIMAL(4,1) NOT NULL,
        \`holiday_year\` INT NOT NULL,
        \`status\` VARCHAR(20) NOT NULL DEFAULT 'Pending',
        \`note\` TEXT NULL,
        \`admin_note\` TEXT NULL,
        \`decided_at\` TIMESTAMP NULL DEFAULT NULL,
        \`pay_status\` VARCHAR(20) NOT NULL DEFAULT 'unpaid',
        \`pay_amount\` DECIMAL(10,2) NULL,
        \`staff_invoice_id\` INT NULL,
        \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`staff_holidays_staff_year_idx\` (\`staff_id\`, \`holiday_year\`),
        CONSTRAINT \`staff_holidays_staff_id_staff_id_fk\` FOREIGN KEY (\`staff_id\`) REFERENCES \`staff\` (\`id\`) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS \`referral_rewards\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`referrer_user_id\` INT NOT NULL,
        \`referred_user_id\` INT NOT NULL,
        \`amount\` DECIMAL(10,2) NOT NULL,
        \`status\` VARCHAR(20) NOT NULL DEFAULT 'pending',
        \`unlocked_at\` TIMESTAMP NULL DEFAULT NULL,
        \`unlocked_by_booking_id\` INT NULL,
        \`pay_status\` VARCHAR(20) NOT NULL DEFAULT 'unpaid',
        \`staff_invoice_id\` INT NULL,
        \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`referral_rewards_referred_unique\` (\`referred_user_id\`),
        KEY \`referral_rewards_referrer_idx\` (\`referrer_user_id\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`referral_credit_uses\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`user_id\` INT NOT NULL,
        \`booking_id\` INT NOT NULL,
        \`amount\` DECIMAL(10,2) NOT NULL,
        \`status\` VARCHAR(20) NOT NULL DEFAULT 'applied',
        \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`referral_credit_uses_user_idx\` (\`user_id\`),
        KEY \`referral_credit_uses_booking_idx\` (\`booking_id\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`broadcasts\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`channel\` VARCHAR(20) NOT NULL,
        \`audience\` VARCHAR(30) NOT NULL,
        \`subject\` VARCHAR(255) NULL,
        \`body\` LONGTEXT NOT NULL,
        \`recipients\` INT NOT NULL DEFAULT 0,
        \`sent\` INT NOT NULL DEFAULT 0,
        \`failed\` INT NOT NULL DEFAULT 0,
        \`created_by\` VARCHAR(255) NULL,
        \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`broadcasts_created_idx\` (\`created_at\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`staff_assessments\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`staff_id\` INT NOT NULL,
        \`booking_id\` INT NULL,
        \`assessor_user_id\` INT NULL,
        \`assessor_name\` VARCHAR(255) NOT NULL,
        \`rating\` INT NOT NULL,
        \`punctuality\` INT NULL,
        \`quality\` INT NULL,
        \`professionalism\` INT NULL,
        \`remark\` TEXT NOT NULL,
        \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`staff_assessments_staff_idx\` (\`staff_id\`),
        CONSTRAINT \`staff_assessments_staff_id_staff_id_fk\` FOREIGN KEY (\`staff_id\`) REFERENCES \`staff\` (\`id\`) ON DELETE CASCADE,
        CONSTRAINT \`staff_assessments_booking_id_bookings_id_fk\` FOREIGN KEY (\`booking_id\`) REFERENCES \`bookings\` (\`id\`) ON DELETE SET NULL
    )`,
];

/**
 * Staff edited before the login-sync fix kept their old login email. Point each login at the email
 * admin set on the staff profile, unless another account already uses it. Safe to run on every boot.
 */
async function syncStaffLoginEmails(): Promise<void> {
    try {
        const [result] = await poolConnection.query(
            `UPDATE users u
             JOIN staff s ON s.user_id = u.id
             SET u.email = LOWER(TRIM(s.email))
             WHERE s.email IS NOT NULL AND TRIM(s.email) <> ''
               AND LOWER(TRIM(s.email)) <> u.email
               AND NOT EXISTS (SELECT 1 FROM (SELECT email FROM users) taken WHERE taken.email = LOWER(TRIM(s.email)))
               AND NOT EXISTS (SELECT 1 FROM superadmins sa WHERE sa.email = LOWER(TRIM(s.email)))`,
        );
        const changed = Number((result as { affectedRows?: number }).affectedRows || 0);
        if (changed > 0) console.log(`[migrations] Synced ${changed} staff login email(s) to their staff profile.`);
    } catch (e: any) {
        console.warn('[migrations] staff login email sync skipped:', e?.message);
    }
}

/** Column changes that are safe to repeat on every boot (widening only). */
const MODIFY_MIGRATIONS = [
    // Weekly invoice labels like "2026-10-05 → 2026-10-11" are 23 characters; the old limit was 20.
    "ALTER TABLE `staff_invoices` MODIFY COLUMN `week_label` VARCHAR(60) NOT NULL",
];

export async function runColumnMigrations(): Promise<void> {
    for (const statement of TABLE_MIGRATIONS) {
        try {
            await poolConnection.query(statement);
        } catch (e: any) {
            console.warn('Table migration failed:', statement.slice(0, 60), '-', e?.message);
        }
    }
    for (const statement of MODIFY_MIGRATIONS) {
        try {
            await poolConnection.query(statement);
        } catch (e: any) {
            console.warn('Modify migration failed:', statement, '-', e?.message);
        }
    }
    await syncStaffLoginEmails();
    for (const statement of COLUMN_MIGRATIONS) {
        try {
            await poolConnection.query(statement);
            for (const follow of ON_COLUMN_CREATED[statement] ?? []) {
                await poolConnection.query(follow);
            }
        } catch (e: any) {
            if (e?.code === 'ER_DUP_FIELDNAME') continue;
            console.warn('Column migration failed:', statement, '-', e?.message);
        }
    }
}
