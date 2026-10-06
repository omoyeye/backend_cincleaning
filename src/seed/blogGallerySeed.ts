import type { MySql2Database } from 'drizzle-orm/mysql2';
import { sql } from 'drizzle-orm';
import { blogPosts, galleryItems } from '../schema';
import * as schema from '../schema';

type Db = MySql2Database<typeof schema>;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 180);
}

const SEED_POSTS: Array<{
  title: string;
  slug: string;
  excerpt: string;
  heroImageUrl: string;
  metaTitle: string;
  metaDescription: string;
  metaKeywords: string;
  bodyHtml: string;
}> = [
    {
      title: 'How to Prepare Your Home for a Professional Deep Clean (UK)',
      slug: 'prepare-home-professional-deep-clean-uk',
      excerpt:
        'A practical checklist for decluttering, access, and expectations - so your deep clean delivers maximum value.',
      heroImageUrl: '/siteshots/residential-reference-new.jpg',
      metaTitle: 'Prepare Your Home for a Deep Clean | CiN Cleaning UK',
      metaDescription:
        'Declutter, clear surfaces, and secure pets before your cleaners arrive. Practical UK-focused tips for a better deep clean outcome.',
      metaKeywords:
        'deep clean preparation, home cleaning UK, professional cleaner checklist, before deep clean',
      bodyHtml: `
<article>
<p class="lead">A professional deep clean works best when your home is ready for efficient, uninterrupted access. Use this guide to prepare your space and get the most from your booking.</p>
<h2>1. Clear horizontal surfaces</h2>
<p>Remove paperwork, toys, and small items from worktops, tables, and bathroom cabinets. Cleaners can sanitise surfaces faster when they are not moving dozens of loose objects.</p>
<h2>2. Secure pets and plan access</h2>
<p>Let your cleaning team know about pets, alarms, and parking. If you are in a flat with a buzzer or coded entry, confirm access instructions in advance.</p>
<h2>3. Identify priorities</h2>
<p>Highlight ovens, inside cupboards, or skirting boards if you want extra attention. A short list helps teams sequence work in the time you have booked.</p>
<h2>4. Laundry and fragile items</h2>
<p>Hang delicate clothing and store valuables. Deep cleaning focuses on fixtures and surfaces; reducing clutter protects your belongings.</p>
<h2>5. After the visit</h2>
<p>Ventilate rooms briefly if products were used in enclosed spaces. If anything needs a touch-up, contact your provider within their stated guarantee window.</p>
<p><a href="/book-cleaning">Book a deep clean with CiN Cleaning</a> when you are ready - we will confirm scope and timing with you.</p>
</article>`,
    },
    {
      title: 'Eco-Friendly Cleaning: What to Ask Your Cleaning Company',
      slug: 'eco-friendly-cleaning-questions-uk',
      excerpt:
        'Key questions about products, dilution, ventilation, and waste - so you can choose a service aligned with your environmental values.',
      heroImageUrl: '/siteshots/homepage-new-reference.jpg',
      metaTitle: 'Eco-Friendly Cleaning Questions to Ask | CiN Cleaning',
      metaDescription:
        'What to ask about detergents, concentrates, microfibre, and waste. Make informed choices for healthier homes and workplaces.',
      metaKeywords:
        'eco cleaning UK, green cleaning products, sustainable cleaning company, non-toxic cleaning',
      bodyHtml: `
<article>
<p class="lead">“Eco-friendly” is not a regulated label on every product. Use these questions to understand what actually happens in your home or office.</p>
<h2>What products are used, and how are they diluted?</h2>
<p>Concentrated formulas reduce plastic and transport emissions. Ask whether staff follow manufacturer dilution ratios - overuse does not mean better results.</p>
<h2>How do you reduce single-use plastic?</h2>
<p>Reusable bottles, refill systems, and bulk purchasing are common improvements. Microfibre cloths can replace disposable wipes when laundered correctly.</p>
<h2>How is ventilation handled?</h2>
<p>Even low-odour products benefit from airflow during and after cleaning. Good operators plan room order so occupied spaces remain usable.</p>
<h2>What about waste and recycling?</h2>
<p>Ask whether packaging is recycled on-site and how chemical containers are disposed of under UK waste rules.</p>
<p>Ready to align your schedule with greener practices? <a href="/contact-us">Contact CiN Cleaning</a> to discuss your requirements.</p>
</article>`,
    },
    {
      title: 'Commercial vs Residential Cleaning: What Businesses Need to Know',
      slug: 'commercial-vs-residential-cleaning-businesses',
      excerpt:
        'Why contract cleaning differs from domestic visits: frequency, compliance, risk assessments, and out-of-hours access.',
      heroImageUrl: '/siteshots/pricing-reference.jpg',
      metaTitle: 'Commercial vs Residential Cleaning Explained | CiN',
      metaDescription:
        'Understand scheduling, compliance, documentation, and KPIs that matter for offices, retail, and hospitality cleaning in the UK.',
      metaKeywords:
        'commercial cleaning UK, office cleaning contract, workplace cleaning, residential vs commercial',
      bodyHtml: `
<article>
<p class="lead">Residential cleaning prioritises home comfort and family routines. Commercial cleaning prioritises brand presentation, safety, and compliance - often across larger footprints and stricter schedules.</p>
<h2>1. Frequency and scope</h2>
<p>Businesses often need daily or weekly touchpoints for high-traffic areas, while homes may run fortnightly or monthly maintenance cycles.</p>
<h2>2. Risk and compliance</h2>
<p>Food-prep areas, washrooms, and public corridors may require documented checks. Staff training and site-specific instructions are standard.</p>
<h2>3. Access windows</h2>
<p>Many commercial teams work outside core hours to avoid disrupting employees and customers. Residential visits are typically daytime or early evening.</p>
<h2>4. Measurement and accountability</h2>
<p>Contracts may use checklists, audits, or spot inspections. Clarify expectations up front so quality stays consistent.</p>
<p>Explore <a href="/commercial-cleaning">commercial cleaning with CiN</a> or <a href="/contact-us">request a site walkthrough</a>.</p>
</article>`,
    },
    {
      title: 'End-of-Tenancy Cleaning Checklist: Protect Your Deposit',
      slug: 'end-of-tenancy-cleaning-checklist-uk',
      excerpt:
        'Room-by-room focus areas landlords often inspect: kitchens, bathrooms, carpets, and fixtures - plus what to photograph before handover.',
      heroImageUrl: '/siteshots/about.jpg',
      metaTitle: 'End of Tenancy Cleaning Checklist UK | CiN Cleaning',
      metaDescription:
        'Kitchens, ovens, bathrooms, floors, and fixtures: a practical checklist to support a smooth tenancy checkout and deposit return.',
      metaKeywords:
        'end of tenancy clean UK, move out cleaning checklist, deposit cleaning, tenancy checkout',
      bodyHtml: `
<article>
<p class="lead">End-of-tenancy cleaning is about restoring a property to a fair, documented standard. This checklist helps you focus effort where inspections are strictest.</p>
<h2>Kitchen</h2>
<p>Degrease oven hobs and interior where required, clean inside cupboards, fridge/freezer voids, and behind appliances if accessible. Descale taps and sinks.</p>
<h2>Bathrooms</h2>
<p>Remove limescale, clean grout lines, polish mirrors, and sanitise toilets. Check silicone seals around baths and showers.</p>
<h2>Floors and carpets</h2>
<p>Vacuum edges and under furniture where possible. Note professional carpet cleaning if the tenancy requires it.</p>
<h2>Windows and woodwork</h2>
<p>Clean glass, sills, and skirting boards. Fingerprints and dust lines are common deduction triggers.</p>
<h2>Documentation</h2>
<p>Take dated photos before you leave and keep receipts for professional cleaning. If you book CiN, <a href="/book-cleaning">reserve your slot early</a> - busy periods fill quickly.</p>
</article>`,
    },
    {
      title: 'How Much Does a Cleaner Cost in London? A 2026 Price Guide',
      slug: 'how-much-does-a-cleaner-cost-london',
      excerpt:
        'What London households actually pay for standard, deep, and end-of-tenancy cleaning - and which factors move the price up or down.',
      heroImageUrl: '/siteshots/pricing-reference.jpg',
      metaTitle: 'How Much Does a Cleaner Cost in London? 2026 Guide | CiN Cleaning',
      metaDescription:
        'A clear breakdown of cleaning prices in London: hourly rates, deep clean and end-of-tenancy costs, and what changes the final quote.',
      metaKeywords:
        'cleaner cost london, cleaning prices london, how much does a cleaner cost, domestic cleaning rates UK',
      bodyHtml: `
<article>
<p class="lead">Cleaning quotes vary widely across London. Here is what drives the number, so you can compare offers fairly.</p>
<h2>Hourly versus fixed-price work</h2>
<p>Regular and standard cleaning is usually charged by the hour, with a minimum visit length so the job can be done properly. Deep cleans, end-of-tenancy, and commercial work are normally quoted per job, because the scope depends on the property rather than the clock.</p>
<h2>What moves the price</h2>
<p>Property size and number of bathrooms matter most. Beyond that: how recently the property was professionally cleaned, whether ovens or fridges are included, access and parking, and how much notice you give.</p>
<h2>Recurring visits cost less per clean</h2>
<p>A home on a weekly or fortnightly schedule stays on top of the work, so each visit is shorter than a one-off catch-up clean. That is why regular plans usually work out cheaper over a year.</p>
<h2>Questions worth asking any cleaner</h2>
<p>Are products and equipment included? Is the company insured? Will the same cleaner return each visit? Is there a short-notice cancellation fee?</p>
<p>See our <a href="/cleaning-pricing">current pricing</a>, or <a href="/book-cleaning">get an instant quote</a> by entering your property details.</p>
</article>`,
    },
    {
      title: 'Finding a Reliable Cleaner in East London',
      slug: 'reliable-cleaner-east-london',
      excerpt:
        'Hackney, Stratford, Bow and Bethnal Green: how to find a cleaning team that turns up, and what local residents should check first.',
      heroImageUrl: '/siteshots/residential-a.jpg',
      metaTitle: 'Reliable Cleaners in East London | CiN Cleaning',
      metaDescription:
        'Looking for a cleaner in East London? What to check before you book, which services suit flats and shared houses, and how to get a same-week slot.',
      metaKeywords:
        'cleaner east london, cleaning services hackney, domestic cleaner stratford, house cleaning bethnal green',
      bodyHtml: `
<article>
<p class="lead">East London has a high share of flats, shared houses, and short tenancies - which shapes the kind of cleaning most residents actually need.</p>
<h2>Check insurance and vetting first</h2>
<p>Ask whether cleaners are background-checked and whether the company carries public liability insurance. A company that cannot answer this quickly is a company to avoid.</p>
<h2>Match the service to the property</h2>
<p>For a flat on a regular schedule, a <a href="/standard-cleaning">standard clean</a> is usually enough. Moving out of a rental? You want <a href="/end-of-tenancy-cleaning">end-of-tenancy cleaning</a> to inventory standard. Managing a short let? <a href="/airbnb-short-let-cleaning">Turnaround cleaning</a> between guests is a different job again.</p>
<h2>Access and keys</h2>
<p>Most clients are at work during the clean. Agree the access arrangement up front - key safe, concierge, or a neighbour - and confirm it in writing.</p>
<h2>Booking around demand</h2>
<p>Month-end is the busiest window in East London because tenancies turn over. Book early if you need a date near the end of the month.</p>
<p>We cover the area from Hackney to Newham: see <a href="/cleaning-in-east-london">cleaning services in East London</a>.</p>
</article>`,
    },
    {
      title: 'Airbnb Turnaround Cleaning: How Hosts Keep 5-Star Reviews',
      slug: 'airbnb-turnaround-cleaning-five-star-reviews',
      excerpt:
        'Cleanliness is the single biggest driver of short-let reviews. Here is the turnaround routine that keeps ratings high.',
      heroImageUrl: '/siteshots/residential-reference-new.jpg',
      metaTitle: 'Airbnb Turnaround Cleaning Guide | Short Let Cleaning UK',
      metaDescription:
        'A practical turnaround checklist for Airbnb and short-let hosts, plus how professional cleaners keep standards consistent between guests.',
      metaKeywords:
        'airbnb cleaning, short let cleaning london, turnaround cleaning, airbnb host cleaning checklist',
      bodyHtml: `
<article>
<p class="lead">Guests forgive a lot, but not a dirty bathroom. Cleanliness is consistently the most-mentioned factor in short-let reviews.</p>
<h2>The turnaround routine</h2>
<p>Strip and remake every bed with fresh linen. Reset the kitchen, including crockery and cutlery. Scrub the bathroom, shower glass included. Vacuum and mop throughout. Restock consumables, empty every bin, and wipe switches, handles, and remote controls.</p>
<h2>Consistency beats effort</h2>
<p>A single great clean does not protect your rating - every guest gets the same first impression. A professional team working from a fixed checklist produces the same result on the tenth turnaround as the first.</p>
<h2>Build in a buffer</h2>
<p>Same-day checkout and check-in leaves almost no margin. Where your calendar allows, leave a gap so a delayed checkout does not force a rushed clean.</p>
<h2>Photograph the reset</h2>
<p>A quick photo set after each turnaround helps with damage claims and keeps your listing photos honest.</p>
<p>See our <a href="/airbnb-short-let-cleaning">Airbnb and short-let cleaning service</a>, or <a href="/book-cleaning">book a turnaround</a>.</p>
</article>`,
    },
    {
      title: 'Deep Clean or Standard Clean: Which Do You Actually Need?',
      slug: 'deep-clean-or-standard-clean',
      excerpt:
        'The difference between a standard visit and a deep clean, and how to tell which one your home needs right now.',
      heroImageUrl: '/siteshots/homepage-new-reference.jpg',
      metaTitle: 'Deep Clean vs Standard Clean: Which Do You Need? | CiN Cleaning',
      metaDescription:
        'A straightforward comparison of deep cleaning and standard cleaning - what each covers, how long it takes, and when to book which.',
      metaKeywords:
        'deep clean vs standard clean, what is a deep clean, types of cleaning service UK',
      bodyHtml: `
<article>
<p class="lead">This is the question we are asked most often. The short answer: a standard clean maintains, a deep clean resets.</p>
<h2>What a standard clean covers</h2>
<p>Dusting and surfaces, vacuuming and mopping, kitchen worktops and appliance exteriors, bathroom clean and sanitise, beds made, bins emptied. It keeps an already-maintained home in good order.</p>
<h2>What a deep clean adds</h2>
<p>Inside the oven, fridge, and cupboards. Limescale removal and grout scrubbing. Skirting boards, light fittings, extractor filters, and behind movable appliances and furniture. It takes considerably longer because it reaches the places a weekly visit never gets to.</p>
<h2>How to choose</h2>
<p>Book a <a href="/deep-cleaning">deep clean</a> if the property has not been professionally cleaned in six months or more, if you are moving in or out, or after building work or a big event. Otherwise a <a href="/standard-cleaning">standard clean</a> on a regular schedule is the better value.</p>
<h2>A common pattern</h2>
<p>Many clients start with one deep clean to reset the property, then move onto a fortnightly standard schedule to hold that standard.</p>
<p>Not sure? <a href="/book-cleaning">Start a booking</a> and tell us about the property - we will recommend the right service.</p>
</article>`,
    },
  ];


export async function seedGalleryAndBlogIfEmpty(db: Db) {
  const gRow = await db.select({ c: sql<number>`count(*)` }).from(galleryItems);
  const countG = Number(gRow[0]?.c ?? 0);
  if (countG === 0) {
    const imgs = [
      { title: 'Residential shine', url: '/siteshots/residential-reference-new.jpg', caption: 'Living spaces refreshed to a calm, finished standard.' },
      { title: 'Commercial presentation', url: '/siteshots/pricing-reference.jpg', caption: 'Workplaces ready for clients and teams.' },
      { title: 'Detail-led care', url: '/siteshots/homepage-new-reference.jpg', caption: 'Consistent quality across every visit.' },
    ];
    for (let i = 0; i < imgs.length; i++) {
      await db.insert(galleryItems).values({
        title: imgs[i].title,
        imageUrl: imgs[i].url,
        caption: imgs[i].caption,
        sortOrder: i,
        published: true,
      });
    }
  }

  // Additive by slug: re-running adds newly authored posts without touching
  // existing ones (including any the admin has since edited).
  const existing = await db.select({ slug: blogPosts.slug }).from(blogPosts);
  const haveSlugs = new Set(existing.map((r) => r.slug));
  const now = new Date();
  for (const p of SEED_POSTS) {
    if (haveSlugs.has(p.slug)) continue;
    await db.insert(blogPosts).values({
      title: p.title,
      slug: p.slug,
      excerpt: p.excerpt,
      bodyHtml: p.bodyHtml.trim(),
      heroImageUrl: p.heroImageUrl,
      metaTitle: p.metaTitle,
      metaDescription: p.metaDescription,
      metaKeywords: p.metaKeywords,
      published: true,
      publishedAt: now,
    });
  }
}
