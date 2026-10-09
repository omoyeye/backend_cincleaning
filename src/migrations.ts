import { poolConnection } from './db';

/**
 * Idempotent column additions for columns introduced after a database was first created.
 * Runs on server start and before seeding; "duplicate column" errors mean it is already applied.
 */
const COLUMN_MIGRATIONS = [
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
    'ALTER TABLE `bookings` ADD COLUMN `price_region` VARCHAR(20) NULL DEFAULT NULL',
    'ALTER TABLE `bookings` ADD COLUMN `hourly_rate` DECIMAL(10,2) NULL DEFAULT NULL',
    'ALTER TABLE `quote_leads` ADD COLUMN `admin_notes` TEXT NULL',
    'ALTER TABLE `customer_invoices` ADD COLUMN `admin_notes` TEXT NULL',
    'ALTER TABLE `bookings` ADD COLUMN `arrived_at` TIMESTAMP NULL DEFAULT NULL',
    'ALTER TABLE `quote_leads` ADD COLUMN `status_updated_at` TIMESTAMP NULL DEFAULT NULL',
];

/** One-off data steps that run only when the column they depend on is created for the first time. */
const ON_COLUMN_CREATED: Record<string, string[]> = {
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
