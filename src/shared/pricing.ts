/**
 * Regional hourly pricing, shared by the website, the mobile app and the API.
 * Keep the three copies identical: frontend/src/utils/pricing.ts, backend/src/shared/pricing.ts, mobile/utils/pricing.ts.
 * All money maths runs in whole pence, so totals never drift by a penny between client and server.
 */

export type PricingRegion = 'london' | 'standard';

export interface RegionalRateService {
  baseRate: number | string;
  londonRate?: number | string | null;
}

/** Greater London (City + all 32 boroughs): postcode areas that are London throughout. */
const WHOLE_LONDON_AREAS = new Set(['E', 'EC', 'N', 'NW', 'SE', 'SW', 'W', 'WC']);

/** Outer postcode areas: the districts that fall inside Greater London. */
const LONDON_DISTRICTS: Record<string, readonly number[]> = {
  BR: [1, 2, 3, 4, 5, 6, 7], // Bromley
  CR: [0, 2, 4, 5, 7, 8, 9, 44, 90], // Croydon, Mitcham, Coulsdon, Thornton Heath, Purley
  DA: [5, 6, 7, 8, 14, 15, 16, 17, 18], // Bexley, Bexleyheath, Erith, Sidcup, Welling, Belvedere
  EN: [1, 2, 3, 4, 5], // Enfield, Barnet
  HA: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], // Harrow, Wembley, Ruislip, Pinner, Northwood, Stanmore, Edgware
  IG: [1, 2, 3, 4, 5, 6, 8, 11], // Ilford, Woodford Green, Barking
  KT: [1, 2, 3, 4, 5, 6, 9], // Kingston, New Malden, Worcester Park, Surbiton, Chessington
  RM: [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], // Romford, Dagenham, Hornchurch, Rainham, Upminster
  SM: [1, 2, 3, 4, 5, 6], // Sutton, Carshalton, Wallington, Morden
  TW: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], // Twickenham, Hounslow, Richmond, Teddington, Feltham
  UB: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // Southall, Hayes, Uxbridge, Northolt, Greenford, West Drayton
};

export const MATERIALS_PENCE: Record<string, number> = {
  hoover_only: 300,
  hoover_and_materials: 600,
};

/** Outward code ("SW1A", "E2", "BR1") from a full or partial UK postcode, or null. */
export function postcodeOutward(raw: string | null | undefined): string | null {
  const compact = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!compact) return null;
  const full = compact.match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
  if (full) return full[1];
  const outwardOnly = compact.match(/^[A-Z]{1,2}\d[A-Z\d]?$/);
  return outwardOnly ? compact : null;
}

/** District-table check used when the postcode API is unavailable (and for outward-only postcodes). */
export function isGreaterLondonPostcode(raw: string | null | undefined): boolean {
  const outward = postcodeOutward(raw);
  if (!outward) return false;
  const m = outward.match(/^([A-Z]{1,2})(\d{1,2})/);
  if (!m) return false;
  const [, area, digits] = m;
  if (WHOLE_LONDON_AREAS.has(area)) return true;
  const districts = LONDON_DISTRICTS[area];
  return Boolean(districts && districts.includes(Number(digits)));
}

function positiveOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** London hourly rate if the service has one configured, else null. */
export function londonRateOf(service: RegionalRateService | null | undefined): number | null {
  return service ? positiveOrNull(service.londonRate) : null;
}

/** Hourly rate for a region: the London rate inside Greater London when configured, otherwise the base rate. */
export function hourlyRateFor(service: RegionalRateService, region: PricingRegion | null | undefined): number {
  const london = londonRateOf(service);
  if (region === 'london' && london !== null) return london;
  const base = Number(service.baseRate);
  return Number.isFinite(base) && base > 0 ? base : 0;
}

export interface HourlyPriceInput {
  hourlyRate: number;
  hours: number;
  extras?: Array<{ price: number | string; quantity: number }>;
  cleaningMaterials?: string | null;
  discount?: { type: string; value: number | string } | null;
  tip?: { percent?: number | null; amount?: number | null } | null;
}

export interface HourlyPriceBreakdown {
  hourlyRate: number;
  hours: number;
  base: number;
  extras: number;
  materials: number;
  subtotal: number;
  discount: number;
  afterDiscount: number;
  tip: number;
  total: number;
  pence: { base: number; extras: number; materials: number; subtotal: number; discount: number; afterDiscount: number; tip: number; total: number };
}

const toPounds = (pence: number) => pence / 100;

/** Hourly job price: rate x hours + extras + materials, minus discount, plus tip. */
export function calculateHourlyPrice(input: HourlyPriceInput): HourlyPriceBreakdown {
  const ratePence = Math.max(0, Math.round(Number(input.hourlyRate) * 100) || 0);
  const hours = Number.isFinite(Number(input.hours)) && Number(input.hours) > 0 ? Number(input.hours) : 0;
  const basePence = Math.round(ratePence * hours);

  const extrasPence = (input.extras ?? []).reduce((sum, ex) => {
    const unit = Math.max(0, Math.round(Number(ex.price) * 100) || 0);
    const qty = Math.max(0, Math.floor(Number(ex.quantity) || 0));
    return sum + unit * qty;
  }, 0);

  const materialsPence = MATERIALS_PENCE[String(input.cleaningMaterials ?? '')] ?? 0;
  const subtotalPence = basePence + extrasPence + materialsPence;

  let discountPence = 0;
  if (input.discount) {
    const value = Number(input.discount.value);
    if (Number.isFinite(value) && value > 0) {
      discountPence =
        input.discount.type === 'percentage'
          ? Math.round((subtotalPence * Math.min(value, 100)) / 100)
          : Math.round(value * 100);
    }
  }
  discountPence = Math.min(Math.max(0, discountPence), subtotalPence);
  const afterDiscountPence = subtotalPence - discountPence;

  let tipPence = 0;
  if (input.tip) {
    const amount = Number(input.tip.amount);
    const percent = Number(input.tip.percent);
    if (input.tip.amount != null && Number.isFinite(amount)) tipPence = Math.round(amount * 100);
    else if (Number.isFinite(percent)) tipPence = Math.round((afterDiscountPence * percent) / 100);
  }
  tipPence = Math.max(0, tipPence);
  const totalPence = afterDiscountPence + tipPence;

  return {
    hourlyRate: toPounds(ratePence),
    hours,
    base: toPounds(basePence),
    extras: toPounds(extrasPence),
    materials: toPounds(materialsPence),
    subtotal: toPounds(subtotalPence),
    discount: toPounds(discountPence),
    afterDiscount: toPounds(afterDiscountPence),
    tip: toPounds(tipPence),
    total: toPounds(totalPence),
    pence: {
      base: basePence,
      extras: extrasPence,
      materials: materialsPence,
      subtotal: subtotalPence,
      discount: discountPence,
      afterDiscount: afterDiscountPence,
      tip: tipPence,
      total: totalPence,
    },
  };
}

export interface RegionLookup {
  region: PricingRegion;
  source: 'postcodes.io' | 'district-table';
}

const regionCache = new Map<string, RegionLookup>();

/**
 * Pricing region for a postcode: postcodes.io's official region ("London" = Greater London),
 * falling back to the district table if the lookup fails. Returns null for an unusable postcode.
 */
export async function lookupPricingRegion(
  postcode: string | null | undefined,
  timeoutMs = 6000,
): Promise<RegionLookup | null> {
  const compact = String(postcode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const outward = postcodeOutward(compact);
  if (!outward) return null;
  const cached = regionCache.get(compact);
  if (cached) return cached;

  const isFullPostcode = compact.length > outward.length;
  if (isFullPostcode) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(compact)}`, {
        signal: controller?.signal,
      });
      if (res.ok) {
        const body = (await res.json()) as { result?: { region?: string | null } };
        const lookup: RegionLookup = {
          region: body?.result?.region === 'London' ? 'london' : 'standard',
          source: 'postcodes.io',
        };
        regionCache.set(compact, lookup);
        return lookup;
      }
    } catch {
      /* network error or timeout: use the district table */
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { region: isGreaterLondonPostcode(compact) ? 'london' : 'standard', source: 'district-table' };
}
