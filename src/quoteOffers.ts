import type { Express } from 'express';
import { desc, eq } from 'drizzle-orm';
import { quoteLeads, quoteOffers } from './schema';
import { loadBrandVars } from './messageTemplates/brand';
import { renderTransactionalEmail } from './messageTemplates/engine';
import { sendEmail } from './services/email';
import { formatHoursMinutes } from './shared/bookingHelpers';

type Auth = (req: any, res: any, next: any) => void;
type Deps = {
    authenticateToken: Auth;
    requireAdmin: (req: any, res: any) => boolean;
    broadcastSync: (scope: 'quotes') => void;
    absoluteSiteUrl: (path: string) => string;
};

type Item = { description: string; detail?: string; quantity: number; unitPrice: number; lineTotal: number };

/** How the price was built, mirroring a booking (service, rate, hours, property, add-ons). */
type QuoteDetails = {
    serviceId?: string | null;
    pricingModel?: 'hourly' | 'itemized' | 'custom';
    region?: 'london' | 'standard' | null;
    hourlyRate?: number | null;
    hours?: number | null;
    frequency?: string | null;
    cleaningMaterials?: 'none' | 'hoover_only' | 'hoover_and_materials' | null;
    callOutCharge?: number | null;
    property?: Record<string, string | number | null>;
    extras?: { id: string; name: string; price: number; quantity: number }[];
};

const PROPERTY_FIELDS: [string, string][] = [
    ['propertyType', 'Property type'],
    ['bedrooms', 'Bedrooms'],
    ['bathrooms', 'Bathrooms'],
    ['toilets', 'Cloakroom toilets'],
    ['livingRooms', 'Living rooms'],
    ['kitchens', 'Kitchens'],
    ['receptionRooms', 'Reception rooms'],
    ['utilityRooms', 'Utility rooms'],
    ['size', 'Size'],
];

const MATERIALS_LABEL: Record<string, string> = {
    none: 'Provided by you',
    hoover_only: 'We bring a hoover',
    hoover_and_materials: 'We bring a hoover and cleaning products',
};

function parseDetails(raw: unknown): QuoteDetails | null {
    let d: any = raw;
    if (typeof raw === 'string') {
        try {
            d = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const num = (v: unknown, max: number) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : null;
    };
    const property: Record<string, string | number | null> = {};
    const p = d.property && typeof d.property === 'object' ? d.property : {};
    for (const [key] of PROPERTY_FIELDS) {
        const v = p[key];
        if (v === undefined || v === null || v === '') continue;
        property[key] = key === 'propertyType' || key === 'size' ? String(v).slice(0, 60) : num(v, 50);
    }
    const extras = (Array.isArray(d.extras) ? d.extras : [])
        .map((e: any) => ({ id: String(e?.id ?? '').slice(0, 40), name: String(e?.name ?? '').slice(0, 160), price: num(e?.price, 100000) ?? 0, quantity: Math.floor(num(e?.quantity, 99) ?? 0) }))
        .filter((e: any) => e.name && e.quantity > 0)
        .slice(0, 40);
    const model = ['hourly', 'itemized', 'custom'].includes(d.pricingModel) ? d.pricingModel : 'custom';
    const materials = ['none', 'hoover_only', 'hoover_and_materials'].includes(d.cleaningMaterials) ? d.cleaningMaterials : null;
    return {
        serviceId: d.serviceId != null ? String(d.serviceId).slice(0, 40) : null,
        pricingModel: model,
        region: d.region === 'london' || d.region === 'standard' ? d.region : null,
        hourlyRate: num(d.hourlyRate, 10000),
        hours: num(d.hours, 200),
        frequency: d.frequency ? String(d.frequency).slice(0, 40) : null,
        cleaningMaterials: materials,
        callOutCharge: num(d.callOutCharge, 10000),
        property,
        extras,
    };
}

/** Everything that appears on the quote. */
type QuoteContent = {
    quoteNumber: string;
    issuedAt: Date;
    clientName: string | null;
    clientEmail: string;
    clientPhone: string | null;
    clientAddress: string | null;
    postcode: string | null;
    propertySummary: string | null;
    serviceType: string | null;
    items: Item[];
    details: QuoteDetails | null;
    subtotal: number;
    discount: number;
    vatRate: number;
    vatAmount: number;
    total: number;
    message: string | null;
    notes: string | null;
    validUntil: string | null;
};

const STATUSES = ['draft', 'sent', 'accepted', 'declined'];
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const round2 = (n: number) => Math.round(n * 100) / 100;
const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max) || null;

function escapeHtml(s: string): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
const multiline = (s: string) => escapeHtml(s).replace(/\n/g, '<br />');

function asItems(raw: unknown): Item[] {
    let list: unknown = raw;
    if (typeof raw === 'string') {
        try {
            list = JSON.parse(raw);
        } catch {
            list = [];
        }
    }
    return (Array.isArray(list) ? list : []).map((it: any) => {
        const quantity = Math.max(0, Number(it?.quantity) || 0);
        const unitPrice = Math.max(0, Number(it?.unitPrice) || 0);
        const detail = String(it?.detail || '').trim().slice(0, 160);
        return {
            description: String(it?.description || '').trim().slice(0, 300),
            ...(detail ? { detail } : {}),
            quantity,
            unitPrice,
            lineTotal: round2(quantity * unitPrice),
        };
    });
}

/** Validates the builder payload and works out the totals on the server. */
function parseQuote(body: any): { error: string } | Omit<QuoteContent, 'quoteNumber' | 'issuedAt' | 'clientEmail'> {
    const items = asItems(body?.items).filter((i) => i.description && i.quantity > 0);
    if (!items.length) return { error: 'Add at least one line with a description and quantity.' };
    if (items.length > 30) return { error: 'A quote can have at most 30 lines.' };
    const subtotal = round2(items.reduce((a, i) => a + i.lineTotal, 0));
    const discount = Math.min(subtotal, Math.max(0, round2(Number(body?.discount) || 0)));
    const vatRate = Math.min(100, Math.max(0, Number(body?.vatRate) || 0));
    const vatAmount = round2(((subtotal - discount) * vatRate) / 100);
    const total = round2(subtotal - discount + vatAmount);
    if (total <= 0) return { error: 'The quote total must be more than £0.' };
    const validUntil = typeof body?.validUntil === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.validUntil) ? body.validUntil : null;
    const pc = text(body?.postcode, 12);
    return {
        items,
        details: parseDetails(body?.details),
        subtotal,
        discount,
        vatRate,
        vatAmount,
        total,
        validUntil,
        message: text(body?.message, 3000),
        notes: text(body?.notes, 3000),
        serviceType: text(body?.serviceType, 160),
        clientName: text(body?.clientName, 160),
        clientPhone: text(body?.clientPhone, 50),
        clientAddress: text(body?.clientAddress, 500),
        postcode: pc ? pc.toUpperCase() : null,
        propertySummary: text(body?.propertySummary, 255),
    };
}

function prettyDate(ymd: string | null): string {
    if (!ymd) return '30 days from the issue date';
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Branded top of the quote: business details on the left, quote number and dates on the right. */
function headerHtml(q: QuoteContent, brand: Record<string, string>): string {
    const primary = brand.brand_primary || '#0d9488';
    const lines = [brand.brand_address, brand.brand_phone, brand.brand_email, brand.brand_website].filter(Boolean).map((l) => escapeHtml(l)).join('<br />');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px;border-bottom:3px solid ${escapeHtml(primary)};">
<tr>
<td style="vertical-align:top;padding:0 0 14px;">
  <div style="font-size:18px;font-weight:800;color:#0f172a;">${escapeHtml(brand.brand_name || 'CiN Cleaning')}</div>
  <div style="font-size:12px;line-height:1.6;color:#64748b;margin-top:4px;">${lines}</div>
</td>
<td style="vertical-align:top;text-align:right;padding:0 0 14px;white-space:nowrap;">
  <div style="font-size:22px;font-weight:800;letter-spacing:2px;color:${escapeHtml(primary)};">QUOTE</div>
  <div style="font-size:12px;line-height:1.6;color:#64748b;margin-top:4px;">No. <strong style="color:#0f172a;">${escapeHtml(q.quoteNumber)}</strong><br />Issued ${escapeHtml(q.issuedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}<br />Valid until ${escapeHtml(prettyDate(q.validUntil))}</div>
</td>
</tr>
</table>`;
}

/** "Prepared for": every customer detail we hold for the quote. */
function customerHtml(q: QuoteContent): string {
    const row = (label: string, value: string | null) =>
        value
            ? `<tr><td style="padding:4px 12px 4px 0;font-size:13px;color:#64748b;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:4px 0;font-size:14px;color:#0f172a;">${multiline(value)}</td></tr>`
            : '';
    const address = [q.clientAddress, q.postcode].filter(Boolean).join(', ') || null;
    return `<div style="margin-top:16px;padding:14px 16px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;">
  <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Prepared for</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    ${row('Name', q.clientName)}${row('Email', q.clientEmail)}${row('Phone', q.clientPhone)}${row('Address', address)}
  </table>
</div>`;
}

/** Service, frequency, hours, hourly rate, materials, and the property (like the invoice). */
function jobHtml(q: QuoteContent): string {
    const d = q.details;
    const cell = (label: string, value: string) =>
        `<td style="padding:6px 8px 6px 0;vertical-align:top;width:50%;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;">${label}</div><div style="font-size:14px;font-weight:700;color:#0f172a;">${escapeHtml(value)}</div></td>`;
    const pairs: [string, string][] = [];
    if (q.serviceType) pairs.push(['Service', q.serviceType]);
    if (d?.frequency) pairs.push(['Frequency', d.frequency]);
    if (d?.pricingModel === 'hourly' && d.hours) pairs.push(['Duration', formatHoursMinutes(Number(d.hours))]);
    if (d?.pricingModel === 'hourly' && d.hourlyRate) {
        pairs.push(['Hourly rate', `£${money(d.hourlyRate)} per hour${d.region === 'london' ? ' (London rate)' : ''}`]);
    }
    if (d?.cleaningMaterials) pairs.push(['Cleaning materials', MATERIALS_LABEL[d.cleaningMaterials] || '']);
    const property: [string, string][] = [];
    for (const [key, label] of PROPERTY_FIELDS) {
        const v = d?.property?.[key];
        if (v === undefined || v === null || v === '' || v === 0) continue;
        property.push([label, String(v)]);
    }
    if (!property.length && q.propertySummary) property.push(['Property', q.propertySummary]);
    if (!pairs.length && !property.length) return '';
    const grid = (list: [string, string][]) => {
        let rows = '';
        for (let i = 0; i < list.length; i += 2) {
            rows += `<tr>${cell(list[i][0], list[i][1])}${list[i + 1] ? cell(list[i + 1][0], list[i + 1][1]) : '<td></td>'}</tr>`;
        }
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}</table>`;
    };
    const title = (t: string, top = false) =>
        `<p style="margin:${top ? 0 : '12px'} 0 4px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;">${t}</p>`;
    return `<div style="margin-top:12px;padding:14px 16px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;">
  ${pairs.length ? title('Job details', true) + grid(pairs) : ''}
  ${property.length ? title('Property', !pairs.length) + grid(property) : ''}
</div>`;
}

/** Email-safe table of quote lines and totals (inline styles only). */
function tableHtml(q: QuoteContent, primary: string): string {
    const cell = 'padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:14px;color:#0f172a;';
    const head = `<tr><td style="padding:0 0 6px;font-size:12px;color:#64748b;">Description</td><td style="padding:0 0 6px;font-size:12px;color:#64748b;text-align:right;">Amount</td></tr>`;
    const rows = q.items
        .map(
            (i) =>
                `<tr><td style="${cell}">${escapeHtml(i.description)}` +
                (i.detail
                    ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(i.detail)}</div>`
                    : i.quantity !== 1
                      ? ` <span style="color:#64748b;">${i.quantity} x £${money(i.unitPrice)}</span>`
                      : '') +
                `</td>` +
                `<td style="${cell}text-align:right;white-space:nowrap;">£${money(i.lineTotal)}</td></tr>`,
        )
        .join('');
    const line = (label: string, value: string, strong = false) =>
        `<tr><td style="padding:6px 0;font-size:${strong ? 16 : 14}px;color:${strong ? '#0f172a' : '#64748b'};${strong ? 'font-weight:700;' : ''}">${label}</td>` +
        `<td style="padding:6px 0;text-align:right;font-size:${strong ? 18 : 14}px;color:${strong ? primary : '#0f172a'};${strong ? 'font-weight:800;' : ''}white-space:nowrap;">${value}</td></tr>`;
    const extra =
        (q.discount > 0 || q.vatAmount > 0 ? line('Subtotal', `£${money(q.subtotal)}`) : '') +
        (q.discount > 0 ? line('Discount', `-£${money(q.discount)}`) : '') +
        (q.vatAmount > 0 ? line(`VAT (${Number(q.vatRate)}%)`, `£${money(q.vatAmount)}`) : '');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${head}${rows}${extra}${line('Total', `£${money(q.total)}`, true)}</table>`;
}

/** Admin's instructions, shown under the prices. */
function notesHtml(q: QuoteContent, primary: string): string {
    if (!q.notes) return '';
    return `<div style="margin-top:16px;padding:14px 16px;border-radius:12px;background:#fffbeb;border:1px solid #fde68a;">
  <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${escapeHtml(primary)};">Notes and instructions</p>
  <p style="margin:0;font-size:14px;line-height:1.6;color:#334155;">${multiline(q.notes)}</p>
</div>`;
}

async function renderQuote(db: any, q: QuoteContent, bookUrl: string): Promise<{ subject: string; html: string }> {
    const brand = await loadBrandVars(db);
    const primary = brand.brand_primary || '#0d9488';
    const personal = q.message
        ? `<p style="margin:12px 0;padding:12px 14px;border-left:3px solid ${escapeHtml(primary)};background:#ffffff;color:#334155;">${multiline(q.message)}</p>`
        : '';
    return renderTransactionalEmail(db, 'client_quote', {
        ...brand,
        client_name: escapeHtml((q.clientName || 'there').split(' ')[0]),
        quote_number: escapeHtml(q.quoteNumber),
        quote_date: escapeHtml(q.issuedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })),
        service_type: escapeHtml(q.serviceType || 'your clean'),
        quote_header: headerHtml(q, brand),
        customer_block: customerHtml(q) + jobHtml(q),
        quote_table: tableHtml(q, primary),
        quote_total: money(q.total),
        valid_until: escapeHtml(prettyDate(q.validUntil)),
        personal_message: personal,
        quote_notes: notesHtml(q, primary),
        book_url: bookUrl,
        brand_phone: escapeHtml(brand.brand_phone || ''),
    });
}

function contentFromRow(row: any): QuoteContent {
    return {
        quoteNumber: row.quoteNumber || `Q-${row.id}`,
        issuedAt: row.sentAt ? new Date(row.sentAt) : row.createdAt ? new Date(row.createdAt) : new Date(),
        clientName: row.clientName,
        clientEmail: row.clientEmail,
        clientPhone: row.clientPhone,
        clientAddress: row.clientAddress,
        postcode: row.postcode,
        propertySummary: row.propertySummary,
        serviceType: row.serviceType,
        items: asItems(row.items),
        details: parseDetails(row.details),
        subtotal: Number(row.subtotal),
        discount: Number(row.discount),
        vatRate: Number(row.vatRate),
        vatAmount: Number(row.vatAmount),
        total: Number(row.total),
        message: row.message,
        notes: row.notes,
        validUntil: row.validUntil,
    };
}

function toApi(row: any) {
    const c = contentFromRow(row);
    return {
        ...c,
        issuedAt: undefined,
        id: Number(row.id),
        leadId: row.leadId ?? null,
        status: row.status,
        sentAt: row.sentAt ? new Date(row.sentAt).toISOString() : null,
        sentCount: Number(row.sentCount || 0),
        createdBy: row.createdBy,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    };
}

/** "3 bed, 2 bath" from the homepage form. */
function leadProperty(lead: any): string | null {
    if (/commercial/i.test(String(lead.serviceType || ''))) return 'Commercial premises';
    return [lead.bedrooms && `${lead.bedrooms} bed`, lead.bathrooms && `${lead.bathrooms} bath`].filter(Boolean).join(', ') || null;
}

function validEmail(v: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * Quotes built in Admin > Quote Requests. Totals are worked out here; the email uses the editable
 * "client_quote" template (Message Templates) inside the branded email shell.
 */
export function registerQuoteOfferRoutes(app: Express, db: any, deps: Deps): void {
    const { authenticateToken, requireAdmin, broadcastSync, absoluteSiteUrl } = deps;
    const bookUrl = () => absoluteSiteUrl('/book-cleaning');

    async function emailQuote(row: any): Promise<void> {
        const q = contentFromRow({ ...row, sentAt: row.sentAt || new Date() });
        const { subject, html } = await renderQuote(db, q, bookUrl());
        await sendEmail({ to: [{ email: q.clientEmail, name: q.clientName || q.clientEmail }], subject, htmlContent: html });
    }

    /** Marks the quote sent and moves a new lead to Contacted. */
    async function markSent(row: any) {
        const now = new Date();
        await db
            .update(quoteOffers)
            .set({ status: row.status === 'accepted' ? 'accepted' : 'sent', sentAt: now, sentCount: Number(row.sentCount || 0) + 1, updatedAt: now })
            .where(eq(quoteOffers.id, row.id));
        if (row.leadId) {
            const [lead] = await db.select({ status: quoteLeads.status }).from(quoteLeads).where(eq(quoteLeads.id, row.leadId)).limit(1);
            if (lead?.status === 'new') {
                await db.update(quoteLeads).set({ status: 'contacted', statusUpdatedAt: now }).where(eq(quoteLeads.id, row.leadId));
            }
        }
    }

    const fetchRow = async (id: number) => (await db.select().from(quoteOffers).where(eq(quoteOffers.id, id)).limit(1))[0];

    app.get('/api/admin/quote-leads/:id/quotes', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const rows = await db.select().from(quoteOffers).where(eq(quoteOffers.leadId, Number(req.params.id))).orderBy(desc(quoteOffers.createdAt));
            res.json(rows.map(toApi));
        } catch (e) {
            console.error('[quotes] list', e);
            res.status(500).json({ error: 'Failed to load quotes' });
        }
    });

    /** Create a quote for a lead. Pass send: true to email it straight away. */
    /** Admin starts a quote from the page header: record the client as a request so it lists with the rest. */
    app.post('/api/admin/quotes', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const email = String(req.body?.clientEmail || '').trim().toLowerCase();
            if (!validEmail(email)) return res.status(400).json({ error: 'Client email looks invalid.' });
            const parsed = parseQuote(req.body);
            if ('error' in parsed) return res.status(400).json({ error: parsed.error });
            const prop = parsed.details?.property || {};
            const inserted = await db.insert(quoteLeads).values({
                firstName: parsed.clientName,
                email,
                phone: parsed.clientPhone,
                postcode: parsed.postcode,
                serviceType: parsed.serviceType || 'Custom quote',
                bedrooms: prop.bedrooms != null && Number(prop.bedrooms) > 0 ? String(prop.bedrooms) : null,
                bathrooms: prop.bathrooms != null && Number(prop.bathrooms) > 0 ? String(prop.bathrooms) : null,
                priceEstimate: money(parsed.total),
                status: 'contacted',
                statusUpdatedAt: new Date(),
                adminNotes: 'Quote started by the office (not from the website form).',
            });
            const leadId = Number((inserted as any)?.[0]?.insertId ?? (inserted as any)?.insertId);
            await createQuote(req, res, leadId);
        } catch (e: any) {
            console.error('[quotes] create standalone', e?.message || e);
            res.status(500).json({ error: 'Failed to create quote' });
        }
    });

    app.post('/api/admin/quote-leads/:id/quotes', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        await createQuote(req, res, Number(req.params.id));
    });

    async function createQuote(req: any, res: any, leadId: number) {
        try {
            const [lead] = await db.select().from(quoteLeads).where(eq(quoteLeads.id, leadId)).limit(1);
            if (!lead) return res.status(404).json({ error: 'Quote request not found' });
            const parsed = parseQuote(req.body);
            if ('error' in parsed) return res.status(400).json({ error: parsed.error });
            const email = String(req.body?.clientEmail || lead.email || '').trim().toLowerCase();
            if (!validEmail(email)) return res.status(400).json({ error: 'Client email looks invalid.' });

            const inserted = await db.insert(quoteOffers).values({
                leadId,
                clientName: parsed.clientName || text(lead.firstName, 160),
                clientEmail: email,
                clientPhone: parsed.clientPhone || text(lead.phone, 50),
                clientAddress: parsed.clientAddress,
                postcode: parsed.postcode || text(lead.postcode, 12),
                propertySummary: parsed.propertySummary || leadProperty(lead),
                serviceType: parsed.serviceType || (lead.serviceType !== 'Pending' ? lead.serviceType : null),
                items: parsed.items,
                details: parsed.details,
                subtotal: money(parsed.subtotal),
                discount: money(parsed.discount),
                vatRate: String(parsed.vatRate),
                vatAmount: money(parsed.vatAmount),
                total: money(parsed.total),
                message: parsed.message,
                notes: parsed.notes,
                validUntil: parsed.validUntil,
                status: 'draft',
                createdBy: String(req.user?.email || req.user?.name || 'admin').slice(0, 160),
            });
            const id = Number((inserted as any)?.[0]?.insertId ?? (inserted as any)?.insertId);
            const d = new Date();
            const quoteNumber = `Q-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}-${String(id).padStart(4, '0')}`;
            await db.update(quoteOffers).set({ quoteNumber }).where(eq(quoteOffers.id, id));
            let row = await fetchRow(id);

            if (req.body?.send === true) {
                try {
                    await emailQuote(row);
                    await markSent(row);
                    row = await fetchRow(id);
                } catch (mailErr: any) {
                    console.error('[quotes] email failed', mailErr?.message || mailErr);
                    broadcastSync('quotes');
                    return res.status(502).json({ error: 'Quote saved as a draft, but the email could not be sent. Open it and press Send again.', quote: toApi(row) });
                }
            }
            broadcastSync('quotes');
            res.status(201).json({ quote: toApi(row), emailed: req.body?.send === true });
        } catch (e: any) {
            console.error('[quotes] create', e?.message || e);
            res.status(500).json({ error: 'Failed to create quote' });
        }
    }

    /** Edit a quote's content or status. */
    app.patch('/api/admin/quotes/:quoteId', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const id = Number(req.params.quoteId);
            const row = await fetchRow(id);
            if (!row) return res.status(404).json({ error: 'Quote not found' });
            const patch: Record<string, unknown> = { updatedAt: new Date() };
            if (req.body?.status !== undefined) {
                const status = String(req.body.status);
                if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
                patch.status = status;
                // An accepted quote means the lead turned into business.
                if (status === 'accepted' && row.leadId) {
                    await db.update(quoteLeads).set({ status: 'converted', statusUpdatedAt: new Date() }).where(eq(quoteLeads.id, row.leadId));
                }
            }
            if (req.body?.items !== undefined) {
                const parsed = parseQuote(req.body);
                if ('error' in parsed) return res.status(400).json({ error: parsed.error });
                const email = String(req.body?.clientEmail || row.clientEmail).trim().toLowerCase();
                if (!validEmail(email)) return res.status(400).json({ error: 'Client email looks invalid.' });
                Object.assign(patch, {
                    clientName: parsed.clientName,
                    clientEmail: email,
                    clientPhone: parsed.clientPhone,
                    clientAddress: parsed.clientAddress,
                    postcode: parsed.postcode,
                    propertySummary: parsed.propertySummary,
                    serviceType: parsed.serviceType,
                    items: parsed.items,
                    details: parsed.details,
                    subtotal: money(parsed.subtotal),
                    discount: money(parsed.discount),
                    vatRate: String(parsed.vatRate),
                    vatAmount: money(parsed.vatAmount),
                    total: money(parsed.total),
                    message: parsed.message,
                    notes: parsed.notes,
                    validUntil: parsed.validUntil,
                });
            }
            await db.update(quoteOffers).set(patch).where(eq(quoteOffers.id, id));
            broadcastSync('quotes');
            res.json(toApi(await fetchRow(id)));
        } catch (e) {
            console.error('[quotes] update', e);
            res.status(500).json({ error: 'Failed to update quote' });
        }
    });

    /** Email (or re-email) a saved quote to the client. */
    app.post('/api/admin/quotes/:quoteId/send', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const id = Number(req.params.quoteId);
            const row = await fetchRow(id);
            if (!row) return res.status(404).json({ error: 'Quote not found' });
            await emailQuote(row);
            await markSent(row);
            broadcastSync('quotes');
            res.json(toApi(await fetchRow(id)));
        } catch (e: any) {
            console.error('[quotes] send', e?.message || e);
            res.status(502).json({ error: 'The email could not be sent. Check the email settings and try again.' });
        }
    });

    /** The exact branded quote the client receives, for preview and printing. */
    app.post('/api/admin/quotes/preview', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            const parsed = parseQuote(req.body);
            if ('error' in parsed) return res.status(400).json({ error: parsed.error });
            const q: QuoteContent = {
                ...parsed,
                quoteNumber: text(req.body?.quoteNumber, 40) || 'Draft',
                issuedAt: new Date(),
                clientEmail: String(req.body?.clientEmail || '').trim(),
            };
            res.json(await renderQuote(db, q, bookUrl()));
        } catch (e) {
            console.error('[quotes] preview', e);
            res.status(500).json({ error: 'Failed to build preview' });
        }
    });

    app.delete('/api/admin/quotes/:quoteId', authenticateToken, async (req: any, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            await db.delete(quoteOffers).where(eq(quoteOffers.id, Number(req.params.quoteId)));
            broadcastSync('quotes');
            res.json({ message: 'Quote deleted' });
        } catch (e) {
            console.error('[quotes] delete', e);
            res.status(500).json({ error: 'Failed to delete quote' });
        }
    });
}
