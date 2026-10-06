import type { Booking, Extra, ServiceConfig } from './shared/types';
import { findConflictsForPatchedBooking, getBookingStaffIds } from './shared/bookingHelpers';
import { bookings, extraServices, services } from './schema';

type BookingRow = typeof bookings.$inferSelect;
type BookingLightRow = Pick<BookingRow,
  'id' | 'bookingId' | 'customerId' | 'serviceType' | 'date' | 'time' | 'status' |
  'totalPrice' | 'addressLine1' | 'addressCity' | 'addressPostcode' |
  'contactName' | 'contactEmail' | 'contactPhone' | 'propertyDetails' | 'extras' | 'assignedStaffId'
>;
type ServiceRow = typeof services.$inferSelect;
type ExtraRow = typeof extraServices.$inferSelect;

function mapServiceRow(r: ServiceRow): ServiceConfig {
  const rawCo = (r as { callOutCharge?: unknown }).callOutCharge;
  const callOutCharge =
    rawCo != null && rawCo !== '' && Number.isFinite(Number(rawCo)) ? Number(rawCo) : rawCo === null ? null : undefined;
  return {
    id: String(r.id),
    name: r.name,
    baseRate: Number(r.baseRate),
    pricingModel: (r.pricingModel as ServiceConfig['pricingModel']) || 'hourly',
    minDuration: r.minDuration ?? 2,
    minNotice: r.minNotice ?? 2,
    ...(callOutCharge !== undefined ? { callOutCharge } : {}),
    description: r.description || '',
    icon: r.icon || '',
    active: r.active !== false,
    features: (r.features as string[] | undefined) || undefined,
  };
}

function mapExtraRow(r: ExtraRow): Extra {
  return {
    id: String(r.id),
    name: r.name,
    price: Number(r.price),
    type: (r.type as Extra['type']) || 'fixed',
    duration: r.duration ?? undefined,
  };
}

export function mapBookingRowToApiShape(row: BookingLightRow, junctionStaffIds: number[]): Booking {
  const pd = (row.propertyDetails as Booking['propertyDetails']) || {
    bedrooms: 0,
    bathrooms: 0,
    toilets: 0,
    livingRooms: 0,
    kitchens: 0,
  };
  return {
    id: Number(row.id),
    bookingId: row.bookingId ?? undefined,
    customerId: row.customerId ?? undefined,
    serviceType: row.serviceType,
    date: row.date,
    time: row.time,
    status: row.status || 'Pending',
    totalPrice: Number(row.totalPrice),
    address: {
      line1: row.addressLine1,
      city: row.addressCity,
      postcode: row.addressPostcode,
    },
    contact: {
      name: row.contactName,
      email: row.contactEmail,
      phone: row.contactPhone || undefined,
    },
    propertyDetails: pd,
    extras: (row.extras as Booking['extras']) || [],
    assignedStaffId: row.assignedStaffId ?? undefined,
    assignedStaffIds: junctionStaffIds,
    duration: pd.duration,
  };
}

function buildPatchedBookingForConflict(
  base: Booking,
  bookingUpdates: Record<string, unknown>,
  assignedStaffIdsFromBody: number[] | undefined
): Booking {
  const next: Booking = { ...base };
  if (bookingUpdates.date !== undefined) next.date = String(bookingUpdates.date);
  if (bookingUpdates.time !== undefined) next.time = String(bookingUpdates.time);
  if (bookingUpdates.status !== undefined) next.status = String(bookingUpdates.status);
  if (bookingUpdates.serviceType !== undefined) next.serviceType = String(bookingUpdates.serviceType);
  if (bookingUpdates.propertyDetails !== undefined) {
    next.propertyDetails = bookingUpdates.propertyDetails as Booking['propertyDetails'];
    const d = next.propertyDetails?.duration;
    if (d != null && Number.isFinite(Number(d))) next.duration = Number(d);
  }
  if (bookingUpdates.extras !== undefined) next.extras = bookingUpdates.extras as Booking['extras'];
  if (bookingUpdates.duration !== undefined) {
    const d = Number(bookingUpdates.duration);
    if (Number.isFinite(d)) next.duration = d;
  }

  if (assignedStaffIdsFromBody !== undefined) {
    const ids = assignedStaffIdsFromBody.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    next.assignedStaffIds = ids;
    next.assignedStaffId = ids[0];
  } else if (bookingUpdates.assignedStaffId !== undefined) {
    const sid = Number(bookingUpdates.assignedStaffId);
    if (Number.isFinite(sid) && sid > 0) {
      next.assignedStaffId = sid;
      next.assignedStaffIds = [sid];
    }
  }

  return next;
}

export function computeAdminPatchScheduleConflicts(
  allRows: BookingLightRow[],
  assignmentMap: Map<number, number[]>,
  targetId: number,
  bookingUpdates: Record<string, unknown>,
  assignedStaffIdsFromBody: number[] | undefined,
  serviceRows: ServiceRow[],
  extraRows: ExtraRow[]
): number[] {
  const baseList = allRows.map((r) => mapBookingRowToApiShape(r, assignmentMap.get(Number(r.id)) || []));
  const base = baseList.find((b) => b.id === targetId);
  if (!base) return [];

  const patched = buildPatchedBookingForConflict(base, bookingUpdates, assignedStaffIdsFromBody);

  if (String(patched.status) === 'Cancelled') return [];
  if (getBookingStaffIds(patched).length === 0) return [];

  const services = serviceRows.map(mapServiceRow);
  const extras = extraRows.map(mapExtraRow);
  const conflicts = findConflictsForPatchedBooking(baseList, patched, services, extras);
  const other = new Set<number>();
  for (const c of conflicts) {
    if (c.bookingIdA === targetId) other.add(c.bookingIdB);
    else if (c.bookingIdB === targetId) other.add(c.bookingIdA);
  }
  return [...other];
}
