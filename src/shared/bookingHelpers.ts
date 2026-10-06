// Server copy of frontend/src/utils/bookingHelpers.ts (pure booking/scheduling logic only).
// Keep in sync with the frontend when duration or overlap rules change.
import type { Booking, Extra, ServiceConfig, ServiceTrigger, WizardStepKey } from './types';

/** Fixed call-out fee for Deep cleaning & End of tenancy (GBP). */
export const DEEP_EOT_CALL_OUT_GBP = 30;

/** All optional wizard steps the admin can toggle — Service + Review are always on. */
export const ALL_WIZARD_STEPS: WizardStepKey[] = [
  'details',
  'extras',
  'schedule',
  'location',
  'requirements',
  'invoice',
];

/** Default optional steps for a given trigger archetype. */
export function defaultStepsForTrigger(trigger: ServiceTrigger): WizardStepKey[] {
  switch (trigger) {
    case 'airbnb':
    case 'commercial':
    case 'jet_washing':
      // Simple / fast-path flows: skip Extras & Invoice tip step.
      return ['details', 'schedule', 'location', 'requirements'];
    case 'custom':
      return ['details', 'schedule', 'location', 'requirements'];
    default:
      return [...ALL_WIZARD_STEPS];
  }
}

/** Derive a trigger archetype from a service row (explicit `bookingFlow.trigger` wins). */
export function getServiceTrigger(
  serviceConfig?: ServiceConfig | null,
  serviceTypeName?: string
): ServiceTrigger {
  const explicit = serviceConfig?.bookingFlow?.trigger;
  if (explicit) return explicit;
  const sId = String(serviceConfig?.id ?? '').toLowerCase();
  const sName = String(serviceConfig?.name ?? serviceTypeName ?? '').toLowerCase();
  if (sId === 'airbnb' || sName.includes('airbnb')) return 'airbnb';
  if (sId === 'commercial' || sName.includes('commercial')) return 'commercial';
  if (sId === 'jet_washing' || sName.includes('jet')) return 'jet_washing';
  if (sId === 'end_of_tenancy' || sName.includes('end of tenancy')) return 'end_of_tenancy';
  if (sId === 'deep' || (sName.includes('deep') && !sName.includes('airbnb'))) return 'deep';
  return 'standard';
}

/** Resolve the optional wizard steps for a service; honors explicit `bookingFlow.steps`. */
const WIZARD_STEP_LITERALS = [
  'service',
  'details',
  'extras',
  'schedule',
  'location',
  'requirements',
  'invoice',
  'review',
] as const;

export type WizardStepLiteral = (typeof WIZARD_STEP_LITERALS)[number];

export function wizardStepLiteral(absoluteIndex: number): WizardStepLiteral {
  if (absoluteIndex < 0 || absoluteIndex >= WIZARD_STEP_LITERALS.length) return 'service';
  return WIZARD_STEP_LITERALS[absoluteIndex] as WizardStepLiteral;
}

/** Minimum characters for commercial / jet-washing quote description before continuing. */
export const COMMERCIAL_OR_JET_DETAILS_MIN_CHARS = 25;

export function isPlausibleBookingEmail(email: string): boolean {
  const t = email.trim();
  if (t.length < 5 || t.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

/** Loose UK postcode check (allows optional space). */
export function isPlausibleUkPostcode(postcode: string): boolean {
  const compact = postcode.replace(/\s+/g, '').toUpperCase();
  if (compact.length < 5 || compact.length > 8) return false;
  return /^[A-Z]{1,2}\d[A-Z0-9]?\d[A-Z]{2}$/.test(compact);
}

/** Uppercase UK postcode with a single outward/inward space (e.g. SW1A 1AA). */
export function normalizeUkPostcode(postcode: string): string {
  const compact = String(postcode || '').replace(/\s+/g, '').toUpperCase();
  if (compact.length <= 3) return compact;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`.trim();
}

/**
 * Live postcode validation via postcodes.io (UK).
 * Note: postcodes.io is not Royal Mail directly, but checks valid UK postcode datasets used operationally.
 */
export async function verifyUkPostcodeLive(postcode: string): Promise<{ ok: boolean; normalized: string }> {
  const normalized = normalizeUkPostcode(postcode);
  if (!isPlausibleUkPostcode(normalized)) return { ok: false, normalized };
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(normalized)}/validate`);
    if (!r.ok) return { ok: false, normalized };
    const data = (await r.json().catch(() => ({}))) as { result?: boolean };
    return { ok: Boolean(data.result), normalized };
  } catch {
    return { ok: false, normalized };
  }
}

/** Digits-only length check suitable for UK mobiles. */
export function isPlausibleBookingPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

export function parseWizardLocalDateTime(dateYYYYMMDD: string, timeHHMM: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYYYYMMDD.trim())) return null;
  if (!/^\d{2}:\d{2}$/.test(timeHHMM.trim())) return null;
  const [y, mo, d] = dateYYYYMMDD.split('-').map(Number);
  const [h, mi] = timeHHMM.split(':').map(Number);
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

/** True if booking start is at least `minNoticeHours` from now (0 = no restriction). */
export function isBookingAtLeastNoticeHoursAhead(
  dateYYYYMMDD: string,
  timeHHMM: string,
  minNoticeHours: number
): boolean {
  const t = parseWizardLocalDateTime(dateYYYYMMDD, timeHHMM);
  if (!t) return false;
  const hours = Number.isFinite(Number(minNoticeHours)) ? Math.max(0, Number(minNoticeHours)) : 0;
  const earliest = new Date(Date.now() + hours * 60 * 60 * 1000);
  return t.getTime() >= earliest.getTime();
}

export function resolveBookingFlowSteps(
  serviceConfig?: ServiceConfig | null,
  serviceTypeName?: string
): WizardStepKey[] {
  const explicit = serviceConfig?.bookingFlow?.steps;
  if (Array.isArray(explicit) && explicit.length > 0) {
    // Preserve admin order but ignore unknown values.
    const seen = new Set<WizardStepKey>();
    const clean: WizardStepKey[] = [];
    for (const s of explicit) {
      if (ALL_WIZARD_STEPS.includes(s) && !seen.has(s)) {
        seen.add(s);
        clean.push(s);
      }
    }
    if (clean.length) return clean;
  }
  return defaultStepsForTrigger(getServiceTrigger(serviceConfig, serviceTypeName));
}

export function isDeepOrEOTService(serviceConfig?: ServiceConfig | null, serviceTypeName?: string): boolean {
  const trig = getServiceTrigger(serviceConfig, serviceTypeName);
  return trig === 'deep' || trig === 'end_of_tenancy';
}

/** Resolved call-out for deep/EOT from service row; null/undefined on service → app default. */
export function resolveDeepEotCallOutChargeGbp(serviceConfig?: ServiceConfig | null): number {
  const c = serviceConfig?.callOutCharge;
  if (c != null && Number.isFinite(Number(c))) return Number(c);
  return DEEP_EOT_CALL_OUT_GBP;
}

/** Call-out £ included in total for Deep / EOT; uses booking snapshot, then service, then default. */
export function getCallOutChargeGbp(booking: Partial<Booking>, serviceConfig?: ServiceConfig | null): number {
  if (!isDeepOrEOTService(serviceConfig, booking.serviceType)) return 0;
  const stored = booking.propertyDetails?.callOutCharge;
  if (stored != null && Number.isFinite(Number(stored))) return Number(stored);
  return resolveDeepEotCallOutChargeGbp(serviceConfig);
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function getYYYYMMDD(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function getTodayYYYYMMDD(): string {
  return getYYYYMMDD(new Date());
}

export function getTomorrowYYYYMMDD(): string {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  return getYYYYMMDD(t);
}

/** Normalize booking.date to YYYY-MM-DD for comparisons */
export function normalizeBookingDate(raw: string | undefined): string {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    return `${m[3]}-${mo}-${d}`;
  }
  try {
    const dt = new Date(s);
    if (!Number.isNaN(dt.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    }
  } catch {
    /* ignore */
  }
  return s;
}

/**
 * Parse a calendar date string (YYYY-MM-DD after normalize) in the user's local timezone.
 * `new Date('2026-04-14')` is UTC midnight and shifts the displayed day west of UTC — avoid that for booking dates.
 */
export function parseLocalDateFromYYYYMMDD(raw: string | undefined): Date | null {
  const n = normalizeBookingDate(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(n)) return null;
  const [y, mo, d] = n.split('-').map(Number);
  if (!y || !mo || !d) return null;
  const dt = new Date(y, mo - 1, d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function roundHours(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Consistent user-facing label for known extra items across wizard, invoices, and admin screens. */
export function getExtraDisplayLabel(name: string): string {
  const raw = String(name || '').trim();
  const lower = raw.toLowerCase();
  const isCloakroomToilet =
    (lower.includes('cloakroom') || /cloak\s*room/.test(lower) || lower.includes('clockroom') || /clock\s*room/.test(lower)) &&
    (lower.includes('toilet') || /\bwc\b/.test(lower));
  if (isCloakroomToilet) return 'Cloakroom Toilet (£15/30min each)';
  return raw;
}

/** Minutes allocated per extra when DB has no duration (aligned with BookingWizard). */
export function estimateExtraDurationMinutes(ex: Extra): number {
  const lowerName = String(ex?.name ?? '').toLowerCase();
  // Keep these room rules stable even if misconfigured durations exist in admin extras.
  if (lowerName.includes('bedroom')) return 60;
  if (lowerName.includes('bathroom')) return 60;
  if (
    lowerName.includes('cloakroom') ||
    /cloak\s*room/.test(lowerName) ||
    lowerName.includes('clockroom') ||
    lowerName.includes('clock room') ||
    lowerName.includes('toilet') ||
    /\bwc\b/.test(lowerName)
  ) {
    return 30;
  }
  if (lowerName.includes('reception')) return 60;
  if (lowerName.includes('kitchen')) return 60;
  if (lowerName.includes('utility')) return 30;
  if (lowerName.includes('carpet')) return 60;
  const configured = ex.duration;
  if (configured != null && Number.isFinite(configured) && configured >= 0) return configured;
  return 30;
}

function matchesHourlyStyleService(serviceConfig: ServiceConfig, bookingServiceType?: string): boolean {
  const sId = String(serviceConfig.id);
  const sName = (serviceConfig.name || '').toLowerCase();
  const hint = String(bookingServiceType || '').toLowerCase();
  return ['general', 'airbnb', 'commercial', 'hourly'].some(
    (t) => sId === t || sName.includes(t) || hint.includes(t)
  );
}

/**
 * Same rules as BookingWizard `calculatedDuration`: hourly services use booked duration;
 * deep/EOT-style itemized jobs use minDuration + per-extra time from config or name heuristics.
 */
export function computeBookedDurationHours(
  booking: Partial<Booking>,
  serviceConfig: ServiceConfig,
  extrasList: Extra[]
): number {
  if (matchesHourlyStyleService(serviceConfig, booking.serviceType)) {
    const n = Number(booking.duration ?? booking.propertyDetails?.duration ?? serviceConfig.minDuration);
    if (Number.isFinite(n) && n > 0) return roundHours(n);
    return roundHours(Number(serviceConfig.minDuration) > 0 ? serviceConfig.minDuration : 2);
  }

  let totalHours = Number(serviceConfig.minDuration) > 0 ? serviceConfig.minDuration : 1;
  const extraTime = (booking.extras ?? []).reduce((sum, item) => {
    const ex = extrasList.find((e) => String(e.id) === String(item.id));
    if (!ex) return sum;
    const dMin = estimateExtraDurationMinutes(ex);
    return sum + (dMin / 60) * item.quantity;
  }, 0);
  return roundHours(totalHours + extraTime);
}

export interface DurationBreakdownLine {
  extraId: string;
  label: string;
  quantity: number;
  hoursPerUnit: number;
  lineHours: number;
}

export interface DurationBreakdown {
  model: 'hourly' | 'itemized';
  baseLabel: string;
  baseHours: number;
  lines: DurationBreakdownLine[];
  totalHours: number;
}

/** Human-readable hours, e.g. 12, 11.5, 0.5 */
export function formatBookedHoursLabel(hours: number): string {
  if (!Number.isFinite(hours)) return '-';
  const rounded = roundHours(hours);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
}

export function getDurationBreakdown(
  booking: Partial<Booking>,
  serviceConfig: ServiceConfig | null | undefined,
  extrasList: Extra[]
): DurationBreakdown {
  if (!serviceConfig) {
    const total = Number(booking.duration ?? booking.propertyDetails?.duration);
    const t = Number.isFinite(total) && total > 0 ? roundHours(total) : 2;
    return {
      model: 'hourly',
      baseLabel: 'Booked duration',
      baseHours: t,
      lines: [],
      totalHours: t,
    };
  }

  const totalHours = computeBookedDurationHours(booking, serviceConfig, extrasList);

  if (matchesHourlyStyleService(serviceConfig, booking.serviceType)) {
    const baseHours = roundHours(
      Number(booking.duration ?? booking.propertyDetails?.duration ?? serviceConfig.minDuration) > 0
        ? Number(booking.duration ?? booking.propertyDetails?.duration ?? serviceConfig.minDuration)
        : serviceConfig.minDuration || 2
    );
    // Hourly bookings bill a single booked duration; extras add cost, not separate booked hours in our model.
    return {
      model: 'hourly',
      baseLabel: 'Scheduled clean time',
      baseHours,
      lines: [],
      totalHours,
    };
  }

  const baseHours = roundHours(Number(serviceConfig.minDuration) > 0 ? serviceConfig.minDuration : 1);
  const lines: DurationBreakdownLine[] = (booking.extras ?? []).map((item) => {
    const ex = extrasList.find((e) => String(e.id) === String(item.id));
    const idStr = String(item.id);
    if (!ex) {
      return {
        extraId: idStr,
        label: idStr,
        quantity: item.quantity,
        hoursPerUnit: 0,
        lineHours: 0,
      };
    }
    const dMin = estimateExtraDurationMinutes(ex);
    const hoursPerUnit = roundHours(dMin / 60);
    return {
      extraId: idStr,
      label: getExtraDisplayLabel(ex.name),
      quantity: item.quantity,
      hoursPerUnit,
      lineHours: roundHours(hoursPerUnit * item.quantity),
    };
  });

  return {
    model: 'itemized',
    baseLabel: 'Base visit (minimum)',
    baseHours,
    lines,
    totalHours,
  };
}

/**
 * Total booked hours. Pass `serviceConfig` + `extrasList` to recompute itemized/hourly totals
 * (fixes invoices when legacy rows only stored the wrong `duration`).
 */
export function getBookingDurationHours(
  booking: Partial<Booking>,
  serviceConfig?: ServiceConfig | null,
  extrasList?: Extra[] | null
): number {
  if (serviceConfig && extrasList != null) {
    return computeBookedDurationHours(booking, serviceConfig, extrasList);
  }
  const d = booking.duration ?? booking.propertyDetails?.duration ?? serviceConfig?.minDuration;
  const n = Number(d);
  if (Number.isFinite(n) && n > 0) return roundHours(n);
  return 2;
}

/** Local calendar week Monday–Sunday as YYYY-MM-DD (inclusive). */
export function getLocalWeekMondayToSundayRange(ref: Date = new Date()): { start: string; end: string } {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const day = d.getDay();
  const offsetFromMonday = (day + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - offsetFromMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: getYYYYMMDD(monday), end: getYYYYMMDD(sunday) };
}

export function bookingHasStaff(b: Booking): boolean {
  return !!(b.assignedStaffId || (b.assignedStaffIds && b.assignedStaffIds.length > 0));
}

/** How many staff are assigned (multi-assign table + legacy single id). Minimum 1. */
export function getAssignedStaffCount(booking: Pick<Booking, 'assignedStaffId' | 'assignedStaffIds'>): number {
  const ids = Array.isArray(booking.assignedStaffIds) ? booking.assignedStaffIds : [];
  if (ids.length > 0) return ids.length;
  if (booking.assignedStaffId != null) return 1;
  return 1;
}

export function compareBookingDateTime(a: Booking, b: Booking): number {
  const da = a.date.localeCompare(b.date);
  if (da !== 0) return da;
  return (a.time || '00:00').localeCompare(b.time || '00:00');
}

/** All staff PKs assigned to a booking (legacy single + multi-assign). */
export function getBookingStaffIds(b: Pick<Booking, 'assignedStaffId' | 'assignedStaffIds'>): number[] {
  const ids = new Set<number>();
  if (b.assignedStaffId != null) {
    const n = Number(b.assignedStaffId);
    if (Number.isFinite(n) && n > 0) ids.add(n);
  }
  const multi = Array.isArray(b.assignedStaffIds) ? b.assignedStaffIds : [];
  for (const x of multi) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) ids.add(n);
  }
  return [...ids];
}

function resolveServiceConfigForBooking(booking: Partial<Booking>, services: ServiceConfig[]): ServiceConfig | null {
  const hint = String(booking.serviceType || '').trim().toLowerCase();
  if (!hint) return null;
  return (
    services.find(
      (s) =>
        String(s.name || '')
          .trim()
          .toLowerCase() === hint ||
        String(s.id).toLowerCase() === hint
    ) || null
  );
}

/** Start of visit in local time (ms). */
export function parseBookingStartMs(dateStr: string | undefined, timeStr: string | undefined): number {
  const d = normalizeBookingDate(String(dateStr || ''));
  if (!d) return NaN;
  const parts = d.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return NaN;
  const [y, mo, day] = parts;
  const t = String(timeStr || '09:00').trim();
  const [hh, mmRaw] = t.split(':');
  const mm = mmRaw !== undefined ? mmRaw : '0';
  const h = Number(hh);
  const m = Number(mm);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return new Date(y, mo - 1, day, h, m, 0, 0).getTime();
}

export type StaffScheduleConflict = {
  staffId: number;
  bookingIdA: number;
  bookingIdB: number;
};

/**
 * Same staff member scheduled for overlapping time windows (Pending / Confirmed / Completed; excludes Cancelled).
 * Uses booked duration from service config + extras when possible.
 */
export function findStaffScheduleConflicts(
  bookings: Booking[],
  services: ServiceConfig[],
  extras: Extra[]
): StaffScheduleConflict[] {
  const active = bookings.filter((b) => b.status !== 'Cancelled');
  const withStaff = active.filter((b) => bookingHasStaff(b));

  const byStaff = new Map<number, Booking[]>();
  for (const b of withStaff) {
    for (const sid of getBookingStaffIds(b)) {
      if (!Number.isFinite(sid)) continue;
      if (!byStaff.has(sid)) byStaff.set(sid, []);
      byStaff.get(sid)!.push(b);
    }
  }

  function windowFor(b: Booking): { start: number; end: number } | null {
    const svc = resolveServiceConfigForBooking(b, services);
    const hrs = getBookingDurationHours(b, svc, extras);
    const start = parseBookingStartMs(b.date, b.time);
    if (!Number.isFinite(start)) return null;
    const end = start + Math.max(1 / 60, hrs) * 3600000;
    return { start, end };
  }

  const out: StaffScheduleConflict[] = [];
  const seen = new Set<string>();

  for (const [staffId, list] of byStaff) {
    const items = list
      .map((b) => ({ b, w: windowFor(b) }))
      .filter((x): x is { b: Booking; w: { start: number; end: number } } => x.w !== null)
      .sort((a, b) => a.w.start - b.w.start);

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (items[j].w.start >= items[i].w.end) break;
        const A = items[i].b;
        const B = items[j].b;
        const na = Number(A.id);
        const nb = Number(B.id);
        const id1 = na <= nb ? na : nb;
        const id2 = na <= nb ? nb : na;
        const key = `${staffId}:${id1}:${id2}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ staffId, bookingIdA: id1, bookingIdB: id2 });
      }
    }
  }

  return out;
}

/** Merge one booking into the full list and return conflicts that involve that booking id. */
export function findConflictsForPatchedBooking(
  allBookings: Booking[],
  patchedTarget: Booking,
  services: ServiceConfig[],
  extras: Extra[]
): StaffScheduleConflict[] {
  const merged = allBookings.map((b) => (b.id === patchedTarget.id ? patchedTarget : b));
  return findStaffScheduleConflicts(merged, services, extras).filter(
    (c) => c.bookingIdA === patchedTarget.id || c.bookingIdB === patchedTarget.id
  );
}

export function conflictingBookingIdsForTarget(conflicts: StaffScheduleConflict[], targetId: number): number[] {
  const ids = new Set<number>();
  for (const c of conflicts) {
    if (c.bookingIdA === targetId) ids.add(c.bookingIdB);
    else if (c.bookingIdB === targetId) ids.add(c.bookingIdA);
  }
  return [...ids];
}

/** Human-readable visit window (date, start–end time, estimated duration) for overlap messaging. */
export function formatVisitWindowLabel(b: Booking, services: ServiceConfig[], extras: Extra[]): string {
  const dateStr = normalizeBookingDate(b.date) || String(b.date || '').slice(0, 10) || '?';
  const startClock = String(b.time || '09:00').trim().slice(0, 5);
  const svc = resolveServiceConfigForBooking(b, services);
  const hrs = getBookingDurationHours(b, svc, extras);
  const startMs = parseBookingStartMs(b.date, b.time);
  if (!Number.isFinite(startMs)) {
    return `${dateStr} ${startClock} (~${hrs}h est.)`;
  }
  const endMs = startMs + Math.max(1 / 60, hrs) * 3600000;
  const end = new Date(endMs);
  const endDate = getYYYYMMDD(end);
  const endClock = `${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
  if (endDate !== dateStr) {
    return `${dateStr} ${startClock} → ${endDate} ${endClock} (~${hrs}h est.)`;
  }
  return `${dateStr} ${startClock}–${endClock} (~${hrs}h est.)`;
}

export type OverlapConflictDetail = {
  staffId: number;
  otherBookingId: number;
  thisWindowLabel: string;
  otherWindowLabel: string;
};

/**
 * Each row is one overlapping pair (same staff, visit windows intersect in time — not merely the same calendar date).
 */
export function getOverlapConflictDetailsForPatchedBooking(
  allBookings: Booking[],
  patchedTarget: Booking,
  services: ServiceConfig[],
  extras: Extra[]
): OverlapConflictDetail[] {
  const conflicts = findConflictsForPatchedBooking(allBookings, patchedTarget, services, extras);
  const out: OverlapConflictDetail[] = [];
  const seen = new Set<string>();
  for (const c of conflicts) {
    const otherId = c.bookingIdA === patchedTarget.id ? c.bookingIdB : c.bookingIdA;
    if (!otherId || otherId === patchedTarget.id) continue;
    const key = `${c.staffId}:${otherId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const other = allBookings.find((x) => x.id === otherId);
    if (!other) continue;
    out.push({
      staffId: c.staffId,
      otherBookingId: otherId,
      thisWindowLabel: formatVisitWindowLabel(patchedTarget, services, extras),
      otherWindowLabel: formatVisitWindowLabel(other, services, extras),
    });
  }
  return out;
}
