import { eq } from 'drizzle-orm';
import { emailTemplates, smsTemplates } from '../schema';
import { DEFAULT_EMAIL_TEMPLATES, DEFAULT_SMS_TEMPLATES } from './defaults';

let seededOnce = false;

/** Idempotent - safe to call from every request path. */
export async function ensureMessageTemplatesSeededOnce(db: any): Promise<void> {
  if (seededOnce) return;
  await ensureMessageTemplatesSeeded(db);
  seededOnce = true;
}

/** Inserts any new default SMS rows (e.g. after upgrading code) — safe to run every server boot. */
// export async function mergeMissingDefaultSmsTemplates(db: any): Promise<void> {
//   for (const row of DEFAULT_SMS_TEMPLATES) {
//     const found = await db.select().from(smsTemplates).where(eq(smsTemplates.name, row.name)).limit(1);
//     if (found.length) continue;
//     await db.insert(smsTemplates).values({
//       name: row.name,
//       message: row.message,
//       description: row.description,
//       variables: row.variables,
//       active: true,
//     });
//   }
// }

/** Inserts any new default email template rows after upgrades — safe every boot. */
// export async function mergeMissingDefaultEmailTemplates(db: any): Promise<void> {
//   for (const row of DEFAULT_EMAIL_TEMPLATES) {
//     const found = await db.select().from(emailTemplates).where(eq(emailTemplates.name, row.name)).limit(1);
//     if (found.length) continue;
//     await db.insert(emailTemplates).values({
//       name: row.name,
//       subject: row.subject,
//       body: row.body,
//       description: row.description,
//       variables: row.variables,
//       active: true,
//     });
//   }
// }

export async function ensureMessageTemplatesSeeded(db: any): Promise<void> {
  for (const row of DEFAULT_EMAIL_TEMPLATES) {
    const found = await db.select().from(emailTemplates).where(eq(emailTemplates.name, row.name)).limit(1);
    if (found.length) continue;
    await db.insert(emailTemplates).values({
      name: row.name,
      subject: row.subject,
      body: row.body,
      description: row.description,
      variables: row.variables,
      active: true,
    });
  }
  for (const row of DEFAULT_SMS_TEMPLATES) {
    const found = await db.select().from(smsTemplates).where(eq(smsTemplates.name, row.name)).limit(1);
    if (found.length) continue;
    await db.insert(smsTemplates).values({
      name: row.name,
      message: row.message,
      description: row.description,
      variables: row.variables,
      active: true,
    });
  }

  const shellRow = DEFAULT_EMAIL_TEMPLATES.find((t) => t.name === 'email_shell');
  if (shellRow) {
    const existing = await db.select().from(emailTemplates).where(eq(emailTemplates.name, 'email_shell')).limit(1);
    const body = String(existing[0]?.body || '');
    const needsLogo = !body.includes('brand_logo_block');
    const needsContact = !body.includes('contact_block');
    if (existing.length && (needsLogo || needsContact)) {
      await db
        .update(emailTemplates)
        .set({
          body: shellRow.body,
          variables: shellRow.variables,
          description: shellRow.description,
        })
        .where(eq(emailTemplates.name, 'email_shell'));
    }
  }

  const clientConfirm = DEFAULT_EMAIL_TEMPLATES.find((t) => t.name === 'client_booking_confirmation');
  if (clientConfirm) {
    const existing = await db.select().from(emailTemplates).where(eq(emailTemplates.name, 'client_booking_confirmation')).limit(1);
    if (existing.length && !String(existing[0].body || '').includes('booking_details_html')) {
      await db
        .update(emailTemplates)
        .set({
          body: clientConfirm.body,
          subject: clientConfirm.subject,
          variables: clientConfirm.variables,
          description: clientConfirm.description,
        })
        .where(eq(emailTemplates.name, 'client_booking_confirmation'));
    }
  }

  const staffWelcome = DEFAULT_EMAIL_TEMPLATES.find((t) => t.name === 'staff_welcome_credentials');
  if (staffWelcome) {
    const existing = await db.select().from(emailTemplates).where(eq(emailTemplates.name, 'staff_welcome_credentials')).limit(1);
    // Keep admin customizations, but auto-upgrade very old default bodies that lacked newer staff tokens.
    const body = String(existing[0]?.body || '');
    if (existing.length && (!body.includes('staff_portal_link') || !body.includes('referral_link'))) {
      await db
        .update(emailTemplates)
        .set({
          body: staffWelcome.body,
          subject: staffWelcome.subject,
          variables: staffWelcome.variables,
          description: staffWelcome.description,
        })
        .where(eq(emailTemplates.name, 'staff_welcome_credentials'));
    }
  }

  const staffSms = DEFAULT_SMS_TEMPLATES.find((t) => t.name === 'staff_account_created');
  if (staffSms) {
    const existingSms = await db.select().from(smsTemplates).where(eq(smsTemplates.name, 'staff_account_created')).limit(1);
    const msg = String(existingSms[0]?.message || '');
    if (existingSms.length && !msg.includes('referral_link')) {
      await db
        .update(smsTemplates)
        .set({
          message: staffSms.message,
          variables: staffSms.variables,
          description: staffSms.description,
        })
        .where(eq(smsTemplates.name, 'staff_account_created'));
    }
  }
}
