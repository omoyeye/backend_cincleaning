import { businessSettings } from '../schema';
import { eq, inArray } from 'drizzle-orm';

/**
 * Centralised Brevo credentials / settings used by email + SMS senders.
 *
 * Values are loaded from `business_settings` (admin-editable) on boot, and can
 * be updated at runtime by the admin Brevo settings endpoint without
 * restarting the server. Environment variables act as the last-resort
 * fallback for backwards compatibility.
 *
 * Sensitive values (apiKey, smtpPassword) must NEVER be returned through any
 * unauthenticated endpoint — use `getPublicBrevoConfig()` for the admin UI.
 */
export interface BrevoConfig {
  apiKey: string;
  senderEmail: string;
  senderName: string;
  smsSender: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPassword: string;
}

const BREVO_SETTINGS_KEYS = [
  'brevoApiKey',
  'brevoSenderEmail',
  'brevoSenderName',
  'brevoSmsSender',
  'brevoSmtpHost',
  'brevoSmtpPort',
  'brevoSmtpUser',
  'brevoSmtpPassword',
] as const;

export type BrevoSettingsKey = (typeof BREVO_SETTINGS_KEYS)[number];

export const BREVO_SECRET_KEYS: readonly BrevoSettingsKey[] = [
  'brevoApiKey',
  'brevoSmtpPassword',
] as const;

/** Keys we should strip from the public /api/business-settings response. */
export const BREVO_PRIVATE_KEYS: readonly BrevoSettingsKey[] = BREVO_SETTINGS_KEYS;

function envFallback(): BrevoConfig {
  return {
    apiKey: (process.env.BREVO_API_KEY || '').trim(),
    senderEmail: (process.env.BREVO_SENDER_EMAIL || process.env.BREVO_FROM_EMAIL || '').trim(),
    senderName: (process.env.BREVO_SENDER_NAME || '').trim(),
    smsSender: (process.env.BREVO_SMS_SENDER || process.env.BREVO_SMS_SENDER_NAME || '').trim(),
    smtpHost: (process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com').trim(),
    smtpPort: (process.env.BREVO_SMTP_PORT || '587').trim(),
    smtpUser: (process.env.BREVO_SMTP_USER || '').trim(),
    smtpPassword: (process.env.BREVO_SMTP_PASSWORD || '').trim(),
  };
}

let current: BrevoConfig = envFallback();

export function getBrevoConfig(): BrevoConfig {
  return { ...current };
}

/** Returns a version with secrets masked, safe to render in an admin UI. */
export function getPublicBrevoConfig(): BrevoConfig & {
  apiKeyMasked: string;
  smtpPasswordMasked: string;
  hasApiKey: boolean;
  hasSmtpPassword: boolean;
} {
  const mask = (v: string): string => {
    if (!v) return '';
    if (v.length <= 6) return '•'.repeat(v.length);
    return `${v.slice(0, 4)}••••${v.slice(-2)}`;
  };
  return {
    ...current,
    apiKey: '',
    smtpPassword: '',
    apiKeyMasked: mask(current.apiKey),
    smtpPasswordMasked: mask(current.smtpPassword),
    hasApiKey: Boolean(current.apiKey),
    hasSmtpPassword: Boolean(current.smtpPassword),
  };
}

export function setBrevoConfig(patch: Partial<BrevoConfig>): BrevoConfig {
  current = { ...current, ...normalizePatch(patch) };
  return getBrevoConfig();
}

function normalizePatch(patch: Partial<BrevoConfig>): Partial<BrevoConfig> {
  const out: Partial<BrevoConfig> = {};
  (Object.keys(patch) as (keyof BrevoConfig)[]).forEach((k) => {
    const v = patch[k];
    if (typeof v === 'string') out[k] = v.trim();
  });
  return out;
}

/** Map a `business_settings` key ↔ `BrevoConfig` field. */
function settingsKeyToConfigKey(key: string): keyof BrevoConfig | null {
  switch (key) {
    case 'brevoApiKey':
      return 'apiKey';
    case 'brevoSenderEmail':
      return 'senderEmail';
    case 'brevoSenderName':
      return 'senderName';
    case 'brevoSmsSender':
      return 'smsSender';
    case 'brevoSmtpHost':
      return 'smtpHost';
    case 'brevoSmtpPort':
      return 'smtpPort';
    case 'brevoSmtpUser':
      return 'smtpUser';
    case 'brevoSmtpPassword':
      return 'smtpPassword';
    default:
      return null;
  }
}

function configKeyToSettingsKey(key: keyof BrevoConfig): BrevoSettingsKey {
  switch (key) {
    case 'apiKey':
      return 'brevoApiKey';
    case 'senderEmail':
      return 'brevoSenderEmail';
    case 'senderName':
      return 'brevoSenderName';
    case 'smsSender':
      return 'brevoSmsSender';
    case 'smtpHost':
      return 'brevoSmtpHost';
    case 'smtpPort':
      return 'brevoSmtpPort';
    case 'smtpUser':
      return 'brevoSmtpUser';
    case 'smtpPassword':
      return 'brevoSmtpPassword';
  }
}

export async function loadBrevoConfigFromDb(db: any): Promise<BrevoConfig> {
  try {
    const rows = await db
      .select()
      .from(businessSettings)
      .where(inArray(businessSettings.key, [...BREVO_SETTINGS_KEYS]));
    const fallback = envFallback();
    const merged: BrevoConfig = { ...fallback };
    for (const row of rows as Array<{ key: string; value: string | null }>) {
      const cfgKey = settingsKeyToConfigKey(row.key);
      if (!cfgKey) continue;
      const v = (row.value ?? '').toString().trim();
      if (v) merged[cfgKey] = v;
    }
    current = merged;
    return getBrevoConfig();
  } catch (err) {
    console.warn('[brevoConfig] Failed to load from DB, keeping env defaults:', err);
    return getBrevoConfig();
  }
}

/** Persist a patch to `business_settings` and apply it to the live config. */
export async function persistBrevoConfig(
  db: any,
  patch: Partial<BrevoConfig>,
): Promise<BrevoConfig> {
  const cleaned = normalizePatch(patch);
  const rows = Object.entries(cleaned).map(([k, v]) => ({
    key: configKeyToSettingsKey(k as keyof BrevoConfig),
    value: (v as string) || '',
  }));
  for (const row of rows) {
    await db
      .insert(businessSettings)
      .values({ key: row.key, value: row.value })
      .onDuplicateKeyUpdate({ set: { value: row.value } });
  }
  setBrevoConfig(cleaned);
  return getBrevoConfig();
}

/** Remove all Brevo keys from the DB (used for "disconnect"). */
export async function clearBrevoConfig(db: any): Promise<BrevoConfig> {
  try {
    await db
      .delete(businessSettings)
      .where(inArray(businessSettings.key, [...BREVO_SETTINGS_KEYS]));
  } catch (err) {
    console.warn('[brevoConfig] clear failed:', err);
  }
  current = envFallback();
  return getBrevoConfig();
}

export { BREVO_SETTINGS_KEYS };
// Re-export for other modules that want to guard on eq() too.
export { eq };
