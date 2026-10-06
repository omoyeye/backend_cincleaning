/** Build a single HTML table of booking details for transactional emails. */

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function row(label: string, value: string): string {
  return `<tr>
  <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-weight:700;color:#334155;width:38%;">${esc(label)}</td>
  <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;">${esc(value)}</td>
</tr>`;
}

/** Value cell may contain safe HTML (e.g. &lt;br /&gt;). */
function rowHtml(label: string, valueHtml: string): string {
  return `<tr>
  <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-weight:700;color:#334155;width:38%;">${esc(label)}</td>
  <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;">${valueHtml}</td>
</tr>`;
}

function formatPropertyDetailsHtml(pd: Record<string, unknown> | null | undefined): string {
  if (!pd || typeof pd !== 'object') return '-';
  const order = [
    ['size', 'Property size'],
    ['sqftRange', 'Square footage'],
    ['bedrooms', 'Bedrooms'],
    ['bathrooms', 'Bathrooms'],
    ['toilets', 'Toilets'],
    ['livingRooms', 'Living rooms'],
    ['kitchens', 'Kitchens'],
    ['receptionRooms', 'Reception rooms'],
    ['utilityRooms', 'Utility rooms'],
    ['clockRoomToilets', 'Clock / cloakroom toilets'],
    ['carpetSteamCleaning', 'Carpet steam cleaning'],
    ['duration', 'Booked duration (h)'],
    ['notifyIfMoreTimeNeeded', 'Notify if more time needed'],
    ['callOutCharge', 'Call-out charge (£)'],
    ['commercialDetails', 'Commercial / site details'],
  ] as const;
  const lines: string[] = [];
  for (const [key, label] of order) {
    const v = pd[key];
    if (v === undefined || v === null || v === '') continue;
    if (key === 'notifyIfMoreTimeNeeded') {
      lines.push(`${label}: ${v ? 'Yes' : 'No'}`);
      continue;
    }
    lines.push(`${label}: ${String(v)}`);
  }
  for (const [k, v] of Object.entries(pd)) {
    if (order.some(([x]) => x === k)) continue;
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object') continue;
    lines.push(`${k}: ${String(v)}`);
  }
  if (!lines.length) return '-';
  return lines.map((l) => esc(l)).join('<br />');
}

export interface BuildBookingDetailsEmailOpts {
  bookingId: string;
  pointsToEarn: number;
  discountAmount: number;
  extraNameById: Map<string, string>;
}

/**
 * Rich summary table: contact, address, service, property, extras, instructions, totals.
 */
export function buildBookingDetailsHtml(bookingData: any, opts: BuildBookingDetailsEmailOpts): string {
  const contact = bookingData.contact || {};
  const addr = bookingData.address || {};
  const pd = bookingData.propertyDetails as Record<string, unknown> | undefined;
  const line1 = String(addr.line1 || '');
  const line2 = String(addr.line2 || '');
  const city = String(addr.city || '');
  const pc = String(addr.postcode || '');
  const addressBlock = [line1, line2, city, pc].filter(Boolean).join(', ') || '-';

  const extrasList = Array.isArray(bookingData.extras) ? bookingData.extras : [];
  let extrasCell = '-';
  if (extrasList.length) {
    extrasCell = extrasList
      .map((e: { id: string | number; quantity: number }) => {
        const name = opts.extraNameById.get(String(e.id)) || `Extra #${e.id}`;
        return esc(`${name} × ${e.quantity}`);
      })
      .join('<br />');
  }

  const instr = String(bookingData.instructions || '').trim();
  const instructionsCell = instr ? esc(instr).replace(/\n/g, '<br />') : '-';

  const freq = String(bookingData.frequency || '-');
  const duration =
    bookingData.duration != null && bookingData.duration !== ''
      ? String(bookingData.duration)
      : pd && pd.duration != null
        ? String(pd.duration)
        : '-';

  const discountCode = String(bookingData.discountCode || '').trim();
  const discLine =
    discountCode || opts.discountAmount > 0
      ? `${discountCode ? `Code: ${discountCode}` : 'Discount'} - £${opts.discountAmount.toFixed(2)}`
      : '-';

  const assigned = Array.isArray(bookingData.assignedStaffIds) ? bookingData.assignedStaffIds : [];
  const staffLine = assigned.length ? assigned.map(String).join(', ') : '-';

  const total = Number.parseFloat(String(bookingData.totalPrice ?? 0)).toFixed(2);

  const rows: string[] = [
    row('Booking reference', opts.bookingId),
    row('Service', String(bookingData.serviceType || '-')),
    row('Date', String(bookingData.date || '-')),
    row('Time', String(bookingData.time || '-')),
    row('Frequency', freq),
    row('Duration (hours)', duration),
    row('Contact name', String(contact.name || '-')),
    row('Email', String(contact.email || '-')),
    row('Phone', String(contact.phone || '-')),
    row('Address', addressBlock),
    rowHtml('Property / visit details', formatPropertyDetailsHtml(pd)),
    rowHtml('Extras', extrasCell),
    ...(pd?.cleaningMaterials && pd.cleaningMaterials !== 'none'
      ? [row('Cleaning equipment', pd.cleaningMaterials === 'hoover_and_materials' ? 'Hoover + cleaning materials (+£6.00)' : 'Hoover only (+£3.00)')]
      : []),
    rowHtml('Access & instructions', instructionsCell),
    row('Discount', discLine),
    row('Loyalty points (on completion)', String(opts.pointsToEarn)),
    row('Assigned staff IDs (if any)', staffLine),
    rowHtml('Total', `<strong>£${esc(total)}</strong>`),
  ];

  return `<table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
  <thead>
    <tr>
      <th colspan="2" style="background:#f8fafc;padding:14px 16px;text-align:left;font-size:13px;font-weight:800;color:#0f172a;text-transform:uppercase;letter-spacing:0.06em;">Booking details</th>
    </tr>
  </thead>
  <tbody>${rows.join('')}</tbody>
</table>`;
}
