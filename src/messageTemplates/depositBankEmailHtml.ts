/** Deposit + bank transfer block for transactional emails (mirrors client confirmation / invoice). */

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseJsonObject(map: Record<string, string>, key: string): Record<string, unknown> | undefined {
  const raw = map[key];
  if (raw == null || typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return undefined;
}

interface BankRow {
  id?: string;
  accountName?: string;
  accountNumber?: string;
  sortCode?: string;
  bankName?: string;
  notes?: string;
  active?: boolean;
}

const FALLBACK_BANKS: BankRow[] = [
  {
    id: 'default-bank-1',
    accountName: 'Surpluslink & co LTD',
    accountNumber: '27847158',
    sortCode: '04-06-05',
    bankName: '',
    notes: '',
    active: true,
  },
];

function parseBankRows(map: Record<string, string>): BankRow[] {
  const raw = map.bankDetails;
  if (!raw || typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x) => x && typeof x === 'object') as BankRow[];
  } catch {
    return [];
  }
}

function payoutBanksForEmail(map: Record<string, string>): BankRow[] {
  const rows = parseBankRows(map);
  const active = rows.filter((b) => b.active !== false);
  return active.length > 0 ? active : FALLBACK_BANKS;
}

/**
 * HTML section: deposit policy + bank cards. Same defaults as `BookingConfirmation` / invoice fallback.
 */
export function buildDepositBankSectionHtml(settingsMap: Record<string, string>, totalAmountGbp: number): string {
  const total = Number.isFinite(totalAmountGbp) ? Math.max(0, totalAmountGbp) : 0;
  const depositPolicy = parseJsonObject(settingsMap, 'depositPolicy');
  const rawPct = depositPolicy?.requiredPercent;
  const depositPercent = Number.isFinite(Number(rawPct))
    ? Math.min(100, Math.max(0, Number(rawPct)))
    : 40;
  const depositAmount = (total * depositPercent) / 100;
  const defaultDepositMessage =
    `To reserve your preferred slot and lock in your cleaner team, we require a ${depositPercent}% deposit before attendance. This confirms your booking in our live rota and guarantees staff dispatch on the day.`;
  const msgRaw = depositPolicy?.message;
  const depositMessage =
    typeof msgRaw === 'string' && msgRaw.trim() ? msgRaw.trim() : defaultDepositMessage;

  const banks = payoutBanksForEmail(settingsMap);
  const bankCards = banks
    .map((bank) => {
      const name = esc(bank.accountName || 'Account');
      const bankName = bank.bankName?.trim()
        ? `<p style="margin:4px 0 0;font-size:12px;font-weight:600;color:#64748b;">${esc(bank.bankName.trim())}</p>`
        : '';
      const notes = bank.notes?.trim()
        ? `<p style="margin:10px 0 0;font-size:12px;color:#64748b;">${esc(bank.notes.trim())}</p>`
        : '';
      return `<div style="border-radius:12px;border:1px solid #bfdbfe;background:#ffffff;padding:14px 16px;margin-bottom:10px;">
  <p style="margin:0;font-size:14px;font-weight:800;color:#0f172a;">${name}</p>
  ${bankName}
  <p style="margin:10px 0 0;font-size:14px;font-weight:600;color:#334155;">Account number: ${esc(bank.accountNumber || '')}</p>
  <p style="margin:4px 0 0;font-size:14px;font-weight:600;color:#334155;">Sort code: ${esc(bank.sortCode || '')}</p>
  ${notes}
</div>`;
    })
    .join('');

  return `<div style="margin:24px 0 0;padding:20px 22px;border-radius:14px;border:1px solid #93c5fd;background:#eff6ff;">
  <p style="margin:0 0 8px;font-size:16px;font-weight:800;color:#1e3a8a;">Payment &amp; bank transfer</p>
  <p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#1e40af;line-height:1.5;">${esc(depositMessage)}</p>
  <p style="margin:0 0 14px;font-size:14px;font-weight:800;color:#172554;">Deposit required: £${esc(depositAmount.toFixed(2))} (${esc(depositPercent)}% of £${esc(total.toFixed(2))})</p>
  <p style="margin:0 0 10px;font-size:13px;font-weight:800;color:#1e3a8a;text-transform:uppercase;letter-spacing:0.04em;">Bank transfer details</p>
  ${bankCards}
</div>`;
}
