// Regional pricing checks. Run: npm run test:pricing   (add --live to also check postcodes.io lookups)
import assert from 'node:assert/strict';
import {
  calculateHourlyPrice,
  hourlyRateFor,
  isGreaterLondonPostcode,
  lookupPricingRegion,
  postcodeOutward,
} from '../src/shared/pricing';

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e: any) {
    failures.push(`${name}: ${e.message}`);
  }
}

const standard = { baseRate: '18.00', londonRate: '20.00' };
const noLondonRate = { baseRate: '25.00', londonRate: null };

// ── Rates by region ───────────────────────────────────────────────────────────
check('London uses the London rate', () => assert.equal(hourlyRateFor(standard, 'london'), 20));
check('Manchester/elsewhere uses the base rate', () => assert.equal(hourlyRateFor(standard, 'standard'), 18));
check('Unknown region uses the base rate', () => assert.equal(hourlyRateFor(standard, null), 18));
check('Service without a London rate is unchanged in London', () => assert.equal(hourlyRateFor(noLondonRate, 'london'), 25));

// ── Exact totals (pence-exact) ────────────────────────────────────────────────
const total = (input: Parameters<typeof calculateHourlyPrice>[0]) => calculateHourlyPrice(input).total;
const cases: Array<[string, Parameters<typeof calculateHourlyPrice>[0], number]> = [
  ['London 2h', { hourlyRate: 20, hours: 2 }, 40],
  ['London 2.5h', { hourlyRate: 20, hours: 2.5 }, 50],
  ['London 3h', { hourlyRate: 20, hours: 3 }, 60],
  ['London 8h', { hourlyRate: 20, hours: 8 }, 160],
  ['Manchester 2h', { hourlyRate: 18, hours: 2 }, 36],
  ['Manchester 2.5h', { hourlyRate: 18, hours: 2.5 }, 45],
  ['Manchester 3h', { hourlyRate: 18, hours: 3 }, 54],
  ['Manchester 7.5h', { hourlyRate: 18, hours: 7.5 }, 135],
  [
    'London 3h + oven + 2 blinds + hoover & materials',
    { hourlyRate: 20, hours: 3, extras: [{ price: '35.00', quantity: 1 }, { price: '20.00', quantity: 2 }], cleaningMaterials: 'hoover_and_materials' },
    141,
  ],
  [
    'London 3h + extras + materials, 10% off, 10% tip',
    {
      hourlyRate: 20,
      hours: 3,
      extras: [{ price: '35.00', quantity: 1 }, { price: '20.00', quantity: 2 }],
      cleaningMaterials: 'hoover_and_materials',
      discount: { type: 'percentage', value: 10 },
      tip: { percent: 10 },
    },
    139.59, // 141 - 14.10 = 126.90; + 12.69 tip
  ],
  ['London 2h, £20 fixed discount', { hourlyRate: 20, hours: 2, discount: { type: 'fixed', value: '20.00' } }, 20],
  ['Discount bigger than the bill is capped at £0', { hourlyRate: 20, hours: 2, discount: { type: 'fixed', value: 50 } }, 0],
  ['Manchester 2.5h + hoover only, 15% off, £5 tip', { hourlyRate: 18, hours: 2.5, cleaningMaterials: 'hoover_only', discount: { type: 'percentage', value: 15 }, tip: { amount: 5 } }, 45.8],
  ['Unknown materials key adds nothing', { hourlyRate: 18, hours: 2, cleaningMaterials: 'hoover' }, 36],
  ['Negative tip is ignored', { hourlyRate: 20, hours: 2, tip: { amount: -5 } }, 40],
  ['Fractional quantity is floored', { hourlyRate: 20, hours: 2, extras: [{ price: 10, quantity: 1.9 }] }, 50],
];
for (const [name, input, expected] of cases) check(name, () => assert.equal(total(input), expected));

check('Breakdown lines add up to the total', () => {
  const p = calculateHourlyPrice({
    hourlyRate: 20,
    hours: 3,
    extras: [{ price: '35.00', quantity: 1 }],
    cleaningMaterials: 'hoover_only',
    discount: { type: 'percentage', value: 10 },
    tip: { percent: 12.5 },
  });
  assert.equal(p.pence.base + p.pence.extras + p.pence.materials, p.pence.subtotal);
  assert.equal(p.pence.subtotal - p.pence.discount + p.pence.tip, p.pence.total);
});

// ── Greater London postcode table (fallback) ─────────────────────────────────
const london = [
  'E2 7NX', 'EC1A 1BB', 'SW1A 1AA', 'WC2N 5DU', 'N1 9GU', 'NW3 1AB', 'SE10 9NN', 'W1D 3QF', 'E1W 1AA',
  'BR1 3UH', 'CR0 1NX', 'CR9 1DE', 'DA5 1AA', 'DA14 6AA', 'EN1 3XA', 'EN5 1AA', 'HA1 2XY', 'IG1 1AA',
  'IG11 7AA', 'KT1 1EU', 'KT9 1AA', 'RM1 3BD', 'RM14 2AA', 'SM1 1EA', 'TW9 1DN', 'TW14 0AA', 'UB8 1UW',
];
const notLondon = [
  'M3 2BW', 'M1 1AE', 'BR8 7AA', 'CR3 5AA', 'DA1 1DR', 'DA11 0AA', 'EN6 1AA', 'IG10 1AA', 'KT22 7AW',
  'RM16 2AA', 'SM7 1AA', 'TW15 1AA', 'WD6 1AA', 'NE1 7RU', 'S1 2HE', 'WA1 1AA', 'SS1 1AA', 'EH1 1YZ',
];
for (const pc of london) check(`${pc} is Greater London`, () => assert.equal(isGreaterLondonPostcode(pc), true));
for (const pc of notLondon) check(`${pc} is not Greater London`, () => assert.equal(isGreaterLondonPostcode(pc), false));
check('Outward code parsing', () => {
  assert.equal(postcodeOutward('e27nx'), 'E2');
  assert.equal(postcodeOutward('EC1A 1BB'), 'EC1A');
  assert.equal(postcodeOutward('BR1'), 'BR1');
  assert.equal(postcodeOutward('not a postcode'), null);
});

async function liveChecks() {
  // Real postcodes from each district, classified by postcodes.io's official region.
  const expectations: Array<[string, 'london' | 'standard']> = [
    ['E2', 'london'], ['SW1A', 'london'], ['BR1', 'london'], ['CR0', 'london'], ['KT1', 'london'],
    ['SM1', 'london'], ['TW9', 'london'], ['UB8', 'london'], ['M3', 'standard'], ['M14', 'standard'],
    ['DA1', 'standard'], ['KT22', 'standard'], ['RM16', 'standard'], ['SM7', 'standard'], ['TW15', 'standard'],
    ['KT10', 'standard'],
  ];
  for (const [outcode, expected] of expectations) {
    // A random live postcode from exactly this district (search is prefix-based: "KT1" would also match KT10).
    const res = await fetch(`https://api.postcodes.io/random/postcodes?outcode=${encodeURIComponent(outcode)}`);
    const body = (await res.json()) as { result?: { postcode: string; outcode: string } | null };
    const sample = body.result?.outcode === outcode ? body.result.postcode : undefined;
    if (!sample) {
      failures.push(`live ${outcode}: no sample postcode returned`);
      continue;
    }
    const r = await lookupPricingRegion(sample);
    check(`live ${sample} (${outcode}) -> ${expected}`, () => {
      assert.equal(r?.source, 'postcodes.io');
      assert.equal(r?.region, expected);
    });
  }
}

(async () => {
  if (process.argv.includes('--live')) await liveChecks();
  if (failures.length) {
    console.error(`FAILED ${failures.length} check(s):\n  - ${failures.join('\n  - ')}`);
    console.error(`${passed} passed`);
    process.exit(1);
  }
  console.log(`All ${passed} pricing checks passed.`);
})();
