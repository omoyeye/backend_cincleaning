/**
 * Transactional SMS via Brevo (same API key as email in many accounts).
 * Admin sets the registered sender name (alphanumeric, country rules apply)
 * through Admin → Settings → Email & SMS → Brevo credentials.
 * @see https://developers.brevo.com/reference/sendtransacsms
 */

import { getBrevoConfig } from './brevoConfig';

function normalizeSmsRecipient(raw: string): string | null {
  const s = raw.replace(/\s/g, '');
  if (!s) return null;
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return `+${s.slice(2)}`;
  // UK mobiles often start with 0
  if (/^0[1-9]\d{9,10}$/.test(s)) return `+44${s.slice(1)}`;
  if (/^44\d{10,11}$/.test(s)) return `+${s}`;
  return `+${s}`;
}

export async function sendTransactionalSms(toRaw: string, content: string): Promise<void> {
  const cfg = getBrevoConfig();
  const apiKey = cfg.apiKey;
  const sender = (cfg.smsSender || 'CiNClean').trim();
  const recipient = normalizeSmsRecipient(toRaw);
  if (!recipient) {
    console.warn('[SMS] Skipped: empty or invalid number');
    return;
  }
  if (!apiKey) {
    console.warn('[SMS] BREVO_API_KEY not set — SMS not sent:', content.slice(0, 80));
    return;
  }
  const body = {
    sender,
    recipient,
    content: content.slice(0, 1000),
    type: 'transactional',
  };
  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('[SMS] Brevo error', res.status, t);
    throw new Error(`SMS send failed (${res.status})`);
  }
}
