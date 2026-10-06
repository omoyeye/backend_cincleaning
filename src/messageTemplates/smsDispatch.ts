import { eq } from 'drizzle-orm';
import { smsTemplates } from '../schema';
import { interpolateTemplate } from './engine';
import { sendTransactionalSms } from '../services/sms';

/** Loads active SMS template by name and sends via Brevo. No-op if no phone or template missing. */
export async function sendSmsFromTemplate(
  db: any,
  templateName: string,
  rawPhone: string | null | undefined,
  vars: Record<string, string>
): Promise<void> {
  if (!rawPhone || !String(rawPhone).trim()) return;
  const rows = await db.select().from(smsTemplates).where(eq(smsTemplates.name, templateName)).limit(1);
  if (!rows.length || !rows[0].active) {
    console.warn(`[SMS] Template missing or inactive: ${templateName}`);
    return;
  }
  const msg = interpolateTemplate(rows[0].message, vars);
  if (!msg.trim()) return;
  await sendTransactionalSms(String(rawPhone).trim(), msg);
}
