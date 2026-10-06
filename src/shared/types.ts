// Server copy of frontend/types.ts. Keep in sync when shared shapes change.

export type ServiceType =
  | 'general'
  | 'deep'
  | 'end_of_tenancy'
  | 'airbnb'
  | 'commercial'
  | 'jet_washing';

export enum BookingStatus {
  PENDING = 'Pending',
  CONFIRMED = 'Confirmed',
  COMPLETED = 'Completed',
  CANCELLED = 'Cancelled'
}

export enum AppointmentType {
  BOOKING = 'Booking',
  BREAK = 'Break',
  TRAINING = 'Training',
  MEETING = 'Meeting',
  OTHER = 'Other'
}

export enum RotaStatus {
  SCHEDULED = 'Scheduled',
  CONFIRMED = 'Confirmed',
  COMPLETED = 'Completed',
  CANCELLED = 'Cancelled',
  NOSHOW = 'No-show'
}

export interface DayAvailabilitySlot {
  active: boolean;
  start: string;
  end: string;
}

export type WeeklyAvailability = Record<'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun', DayAvailabilitySlot>;

export interface Extra {
  id: string;
  name: string;
  price: number;
  type?: 'fixed' | 'hourly' | 'range';
  duration?: number;
  icon?: string;
}

export interface SelectedExtra {
  id: string;
  quantity: number;
}

export interface PropertyDetails {
  size?: string; // Property size label (e.g. "Studio")
  bedrooms: number;
  bathrooms: number;
  toilets: number;
  livingRooms: number;
  kitchens: number;
  sqft?: number;
  surfaceType?: string;
  propertyType?: string; // For commercial
  duration?: number; // User selected duration
  notifyIfMoreTimeNeeded?: boolean;
  utilityRooms?: number;
  receptionRooms?: number;
  clockRoomToilets?: number;
  sqftRange?: string; // Dropdown value
  carpetSteamCleaning?: number;
  /** Deep / end-of-tenancy fixed call-out fee (£), stored with the booking */
  callOutCharge?: number;
  /** Commercial / jet-washing site or surface description from the booking wizard */
  commercialDetails?: string;
  /** Customer opted in to SMS updates during booking (stored inside JSON snapshot). */
  smsUpdatesOptIn?: boolean;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: string;
}

export type PaymentFeeEvidenceKind = 'deposit' | 'cancellation_fee';

export interface PaymentFeeEvidenceItem {
  kind: PaymentFeeEvidenceKind;
  /** data URL (image/* or application/pdf) */
  dataUrl: string;
  fileName?: string;
  uploadedAt: string;
  note?: string;
}

export interface PaymentFeeEvidencePayload {
  items: PaymentFeeEvidenceItem[];
}

export interface Booking {
  /** Primary key (INT); use for API URLs and joins. */
  id: number;
  /** Public reference e.g. CIN-XXXXXX (unique); shown on confirmations and emails. */
  bookingId?: string | null;
  customerId?: number; // Optional for guest
  serviceType: string;
  date: string;
  time: string;
  status: string; // Pending, Confirmed, Completed, Cancelled
  totalPrice: number;
  address: {
    line1: string;
    city: string;
    postcode: string;
    line2?: string;
  };
  contact: {
    name: string;
    email: string;
    phone?: string;
  };
  /** Flat phone from API when not nested under `contact` (staff/admin lists). */
  contactPhone?: string;
  propertyDetails: PropertyDetails;
  extras: SelectedExtra[];
  frequency?: 'One-time' | 'Weekly' | 'Fortnightly' | 'Monthly';
  duration?: number;
  instructions?: string;
  assignedStaffId?: number;
  assignedStaffIds?: number[];
  /** Last GPS fix from the assigned cleaner while travelling / on site. */
  cleanerLocation?: CleanerLocation | null;
  /** ISO time the cleaner tapped "Start travel". */
  enRouteAt?: string | null;
  lateNotices?: LateNotice[] | null;
  onTheWayPromptSentAt?: string | null;
  noEnRouteWarningSentAt?: string | null;
  unassignedWarningSentAt?: string | null;
  createdAt?: string;
  chatHistory?: ChatMessage[];
  invoiceId?: string;
  adminNotes?: string;
  stripePaymentLink?: string;
  discountCode?: string;
  discountAmount?: number;
  pointsEarned?: number;
  rating?: number;
  feedback?: string;
  /** Populated after staff completes job (clock in/out, notes, photos) */
  workCompletion?: Partial<WorkCompletionData> | WorkCompletionData;
  /** Client-uploaded deposit or cancellation-fee payment proof (registered customers). */
  paymentFeeEvidence?: PaymentFeeEvidencePayload;
  /** Admin locked chat after job (or manually); from API when present */
  chatClosedByAdmin?: boolean;
  chatClosedAt?: string | null;
  /** Set by admin when the client invoice is paid (shown on invoice view). */
  invoicePaid?: boolean;
  /** Automatic reminder dispatch (server); ISO timestamps when sent. */
  reminder48SentAt?: string | null;
  reminder24SentAt?: string | null;
  /** Server-set when client completes booking after accepting deposit terms (audit). */
  depositTermsAcceptedAt?: string | null;
  /** Server-set when client cancels inside the short-notice window with fee consent (audit). */
  shortNoticeCancelFeeConsentedAt?: string | null;
}

export interface CleanerLocation {
  lat: number;
  lng: number;
  at?: string;
  staffId?: number;
  staffName?: string;
}

export interface LateNotice {
  id: string;
  staffId: number;
  staffName: string;
  reason: string;
  etaTime: string | null;
  minutesLate: number | null;
  message: string;
  sentAt: string;
  notified: { client: boolean; admin: boolean };
}

/** Live tracking snapshot (GET /api/bookings/:id/tracking, /api/admin/live-tracking). */
export interface BookingTracking {
  id: number;
  bookingId?: string | null;
  status: string;
  enRouteAt: string | null;
  cleanerLocation: CleanerLocation | null;
  lateNotices: LateNotice[];
}

/** Per-booking chat activity for admin oversight (GET /api/admin/chat-summaries). */
export type ChatSummary = {
  bookingId: string;
  chatClosed: boolean;
  msgCount: number;
  lastSenderRole: string | null;
  lastMessageAt: string | null;
};

export interface Invoice {
  id: string;
  bookingId: string | number;
  customerName: string;
  customerAddress: string;
  date: string;
  items: { description: string; amount: number }[];
  total: number;
  status: 'Draft' | 'Sent' | 'Paid';
}

/**
 * Archetype a custom service follows. Controls pricing defaults (deep/EOT call-out,
 * airbnb bedroom-based fixed hours), icon suggestions, and the wizard step set.
 * `custom` lets admins pick any combination of steps manually.
 */
export type ServiceTrigger =
  | 'standard'
  | 'deep'
  | 'end_of_tenancy'
  | 'airbnb'
  | 'commercial'
  | 'jet_washing'
  | 'custom';

/** Optional wizard steps admins can toggle. Service + Review are always rendered. */
export type WizardStepKey =
  | 'details'
  | 'extras'
  | 'schedule'
  | 'location'
  | 'requirements'
  | 'invoice';

export interface ServiceBookingFlow {
  trigger: ServiceTrigger;
  /** Ordered list of optional wizard steps the customer will move through. */
  steps: WizardStepKey[];
}

export interface ServiceConfig {
  id: string;
  name: string;
  baseRate: number;
  pricingModel?: 'hourly' | 'flat' | 'size_based' | 'room_based' | 'bedroom_based' | 'quote';
  features?: string[];
  minDuration: number;
  minNotice: number;
  /** Deep / end-of-tenancy call-out fee (£); omit or null to use system default in quotes */
  callOutCharge?: number | null;
  description: string;
  icon: string;
  active: boolean;
  /** Admin-configured trigger + wizard steps this service drives in the booking form. */
  bookingFlow?: ServiceBookingFlow;
}

export interface Notification {
  id: number;
  userId: number;
  type: 'booking_update' | 'system' | 'promo' | 'invoice';
  title?: string; // Frontend expects title
  message: string;
  isRead: boolean;
  createdAt: string;
}

export interface Staff {
  id: number;
  name: string;
  email: string;
  role: 'Staff' | 'Supervisor' | 'Cleaner';
  status: 'Active' | 'Inactive';
  rating?: number;
  isVerified?: boolean;
  hourlyRate: number;
  availability: WeeklyAvailability | null;
  profilePhoto?: string;
  phone?: string;
  address?: string;
  postcode?: string;
  imageUrl?: string;
  bankName?: string;
  accountNumber?: string;
  sortCode?: string;
}

export interface RotaAssignment {
  id: string;
  staffId: string;
  type: AppointmentType;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  status: RotaStatus;
  notes: string;
  bookingId?: string;
}

export interface UserAccount {
  id: string | number;
  name: string;
  email: string;
  role?: string; // 'admin' | 'customer' | 'staff'
  isSuperadmin?: boolean;
  /** Optional admin-only menu scope; empty/undefined means full access. */
  adminTabs?: string[];
  isVerified: boolean;
  bookings: string[]; // Array of booking IDs
  loyaltyPoints?: number;
  referralCode?: string;
  /** Mobile from registration (optional) */
  phone?: string | null;
  address?: string | null;
  postcode?: string | null;
}

export interface WorkCompletionData {
  notes: string;
  issues: string;
  photos: string[]; // Base64 or URLs
  signature: string; // Base64
  clockInTime: string;
  /** Instant when staff clocked in (ISO 8601) — for admin audit. */
  clockInAtIso?: string;
  clockOutTime: string;
  /** Instant when staff tapped clock out (ISO 8601) — must match staff action, not submit time. */
  clockOutAtIso?: string;
  /** Set by API when staff submits completion. */
  submittedByStaffUserId?: number;
  submittedByStaffProfileId?: number;
  /** Staff explanation when clocking out before the booked window ends. */
  earlyClockOutReason?: string;
  location?: {
    lat: number;
    lng: number;
  };
}

export interface StaffNotification {
  id: string;
  title: string;
  message: string;
  timestamp: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  read: boolean;
}

export interface Referral {
  id: string;
  referrerId: string | number;
  referrerName: string;
  referrerType: 'staff' | 'customer';
  referredClientName: string;
  dateReferred: string;
  status: 'Pending' | 'Completed' | 'Paid Out';
  rewardAmount: number;
}

export interface DiscountCode {
  id: string;
  code: string;
  type: 'fixed' | 'percentage';
  value: number;
  usageLimit: number | null;
  usedCount: number;
  isActive: boolean;
  createdAt: string;
}

export interface EmailTemplate {
  id: number;
  name: string;
  subject: string;
  body: string;
  description?: string | null;
  /** Variable names for merge tags, e.g. ["client_name","booking_id"] */
  variables?: string[] | null;
  active?: boolean | null;
}

export interface SmsTemplate {
  id: number;
  name: string;
  message: string;
  description?: string | null;
  variables?: string[] | null;
  active?: boolean | null;
}

export interface SocialMediaLinks {
  facebook?: string;
  instagram?: string;
  tiktok?: string;
  twitter?: string;
  linkedin?: string;
}

/** Single membership / plan card on the public pricing page */
export interface PricingPlanCard {
  id: string;
  label: string;
  price: number;
  note: string;
  popular: boolean;
}

export interface PricingFrequencyOption {
  id: string;
  label: string;
  /** Multiplier applied in the quote calculator (e.g. 0.9 = 10% off vs weekly baseline). */
  factor: number;
}

export type PricingEstimateFormula =
  | 'serviceLength_times_hoursPerVisit_times_factor'
  | 'baseHourlyRate_times_factor'
  /** CiN tiered £/hr: one-time table; weekly −40p/hr after 2h; fortnightly 3mo / 6mo tables + −30p/hr tail */
  | 'cin_tiered_hourly';

export interface PricingCalculatorConfig {
  title: string;
  frequencySectionLabel: string;
  frequencies: PricingFrequencyOption[];
  serviceLengthLabel: string;
  serviceLengthMin: number;
  serviceLengthMax: number;
  serviceLengthStep: number;
  serviceLengthDefault: number;
  hoursPerVisitLabel: string;
  hoursPerVisitMin: number;
  hoursPerVisitMax: number;
  hoursPerVisitStep: number;
  hoursPerVisitDefault: number;
  formula: PricingEstimateFormula;
  /** Used when formula is baseHourlyRate_times_factor */
  baseHourlyRate: number;
  estimateLabel: string;
  estimatePrefix: string;
  estimateSuffix: string;
  bookButtonLabel: string;
  decimalPlaces: number;
  /** Shown after slider values, e.g. "Hours" */
  durationUnitLabel: string;
}

export interface PricingPageConfig {
  eyebrow: string;
  title: string;
  subtitle: string;
  popularBadgeLabel: string;
  selectPlanButtonLabel: string;
  plans: PricingPlanCard[];
  calculator: PricingCalculatorConfig;
}

export interface BusinessSettings {
  companyName: string;
  email: string;
  phone: string;
  website: string;
  primaryColor: string;
  logoUrl?: string | null;
  address?: string;
  socialLinks?: SocialMediaLinks;
  bankDetails?: BankAccountDetail[];
  depositPolicy?: DepositPolicy;
  cancellationPolicy?: CancellationPolicy;
  /** Public marketing pricing page (plans + quote calculator), stored as JSON in business_settings */
  pricingPage?: PricingPageConfig;
  /** Hero copy, images, footer - stored as JSON in business_settings (server source of truth) */
  websiteContent?: WebsiteContent;
}

export interface BankAccountDetail {
  id: string;
  accountName: string;
  accountNumber: string;
  sortCode: string;
  bankName?: string;
  notes?: string;
  active: boolean;
}

export interface DepositPolicy {
  requiredPercent: number;
  message?: string;
}

export interface CancellationPolicy {
  shortNoticeWindowHours: number;
  shortNoticeFeePercent: number;
  consentMessage?: string;
}

export interface CmsHeroSlide {
  id: string;
  page: 'home' | 'residential' | 'commercial' | 'about' | 'pricing' | 'contact';
  eyebrow: string;
  title: string;
  highlight?: string;
  subtitle: string;
  ctaPrimary: string;
  ctaSecondary: string;
  /** Optional third action (e.g. home hero contact link) */
  ctaTertiary?: string;
  imageUrl: string;
}

export interface CmsFooterLink {
  id: string;
  label: string;
  href: string;
}

export interface CmsAdvertCard {
  id: string;
  title: string;
  description: string;
  ctaLabel: string;
  ctaHref: string;
  imageUrl?: string;
  active: boolean;
}

export interface WebsiteContent {
  heroes: CmsHeroSlide[];
  adverts: CmsAdvertCard[];
  footerBlurb: string;
  footerLinks: CmsFooterLink[];
}

/** Public gallery image (admin-managed). */
export interface GalleryItem {
  id: number;
  title: string;
  imageUrl: string;
  caption?: string | null;
  sortOrder: number;
  published: boolean;
}

/** Blog article (admin-managed). */
export interface BlogPost {
  id: number;
  title: string;
  slug: string;
  excerpt?: string | null;
  bodyHtml: string;
  heroImageUrl?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  metaKeywords?: string | null;
  published: boolean;
  publishedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** Keys match `SeoPageId` in src/seo/routePaths.ts */
export interface SeoPageMeta {
  title: string;
  description: string;
  keywords: string;
  /** Optional per-page OG image (absolute or site-relative URL). Empty = use defaultOgImageUrl. */
  ogImageUrl: string;
}

export type SeoPagesConfig = Record<string, SeoPageMeta>;

export interface SiteSeoSettings {
  /** Canonical origin, no trailing slash (e.g. https://www.example.com). Used for canonical, OG URLs, sitemap download. */
  siteUrl: string;
  organizationName: string;
  /** Google Tag Manager container ID, e.g. GTM-XXXXXXX */
  gtmContainerId: string;
  /** Google Analytics 4 measurement ID, e.g. G-XXXXXXXXXX (optional; can also be configured inside GTM). */
  googleAnalytics4Id: string;
  /** meta name="google-site-verification" content */
  googleSiteVerification: string;
  /** Default Open Graph / Twitter image (absolute URL recommended). */
  defaultOgImageUrl: string;
  /** Without @ */
  twitterSite: string;
  /** Extra <meta name="..."> rows for advanced use: one "name|content" per line */
  customMetaLines: string;
  /** Per public / app surface SEO */
  pages: SeoPagesConfig;
  /** Custom scripts to be injected in the head tag */
  scriptHead?: string;
  /** Custom scripts to be injected immediately after the opening body tag */
  scriptBodyStart?: string;
  /** Custom scripts to be injected before the closing body tag */
  scriptBodyEnd?: string;
}
