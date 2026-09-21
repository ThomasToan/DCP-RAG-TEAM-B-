import { describe, it, expect } from 'vitest';
import { getPropertyFacts, lotLabel } from '../src/lib/server/property.js';
import { PropertyError } from '../src/lib/server/property-error.js';
import { loadFixtures, replayFetch } from './helpers/arcgis-fixtures.js';

// Every ArcGIS response below was recorded from the live services (scripts/record_fixtures.js).
const table = loadFixtures();
const noSleep = async () => {};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
const html502 = () => new Response('<html><h1>502 Bad Gateway</h1></html>', { status: 502 });

/** replay fetch that counts requests */
const counted = () => {
	const calls = [];
	return { calls, fetch: replayFetch(table, { onCall: (u) => calls.push(u) }) };
};
const facts = (address, extra = {}) => getPropertyFacts(address, { fetch: replayFetch(table), sleep: noSleep, ...extra });

/** in-memory FactsCache */
const memoryCache = () => {
	const m = new Map();
	return { m, sets: 0, get: async (k) => m.get(k) ?? null, set: async function (k, v) { this.sets++; m.set(k, v); } };
};

describe('property facts: smoke addresses (recorded live data)', () => {
	it('plain R2 lot: Pelaw Main, Cessnock', async () => {
		const f = await facts('15 Ellalong St, Pelaw Main NSW 2321');
		expect(f).toMatchObject({
			address: '15 ELLALONG STREET PELAW MAIN',
			lot: 'Lot 18 DP 246833',
			lga: 'CESSNOCK',
			zone: 'R2',
			zone_name: 'Low Density Residential',
			min_lot_m2: 450,
			fsr: null,
			height_m: null,
			heritage: null,
			bushfire: null,
			flood: null, // Cessnock is outside the 10 LGAs the state flood layer covers: unknown, not "no"
			acid_sulfate: null,
			precincts: [],
			unknown: [],
			cached: false
		});
		// independent check: the same lot measured in a metric CRS (GDA2020 / MGA56) is 1011.32 m2
		expect(Math.abs(f.lot_area_m2 - 1011.32) / 1011.32).toBeLessThan(0.001);
		expect(f.lot_area_source).toBe('computed');
		expect(f.sources.zone).toMatchObject({ plan: 'Cessnock Local Environmental Plan 2011' });
	});

	it('bushfire prone rural lot: Mulbring, Cessnock', async () => {
		const f = await facts('32 Wallis Creek Lane, Mulbring');
		expect(f).toMatchObject({ lga: 'CESSNOCK', zone: 'RU2', bushfire: 'Vegetation Category 1', flood: null, unknown: [], not_covered: ['flood'] });
		expect(f.lot_area_m2).toBeGreaterThan(40000);
	});

	it('heritage item once, not once per polygon: West Wallsend, Lake Macquarie', async () => {
		const f = await facts('4A Mount Sugarloaf Rd, West Wallsend');
		expect(f).toMatchObject({ lga: 'LAKE MACQUARIE', zone: 'C2', heritage: 'item I212', bushfire: 'Vegetation Category 1' });
		expect(f.heritage_detail.length).toBeGreaterThan(0);
	});

	it('flood + acid sulfate: Horsley, Wollongong', async () => {
		const f = await facts('16 Homestead Dr, Horsley');
		expect(f).toMatchObject({ lga: 'WOLLONGONG', zone: 'R2', flood: true, acid_sulfate: 'Class 5', min_lot_m2: 449, unknown: [], not_covered: [] });
	});

	it('a unit number resolves to the parent lot, with a note', async () => {
		const f = await facts('Unit 2/15 Ellalong St, Pelaw Main');
		expect(f.address).toBe('15 ELLALONG STREET PELAW MAIN');
		expect(f.notes.join(' ')).toMatch(/Unit 2 ignored/);
	});

	it('the address is the scope: two spellings give the same bundle', async () => {
		const a = await facts('15 Ellalong St, Pelaw Main');
		const b = await facts('15 ELLALONG STREET PELAW MAIN');
		expect({ ...a, fetched_at: 0, address_input: 0 }).toEqual({ ...b, fetched_at: 0, address_input: 0 });
	});
});

describe('property facts: bad addresses fail clearly and cheaply', () => {
	it('no house number: BAD_ADDRESS with ZERO requests', async () => {
		const { calls, fetch } = counted();
		const err = await getPropertyFacts('Ellalong Street', { fetch, sleep: noSleep }).catch((e) => e);
		expect(err).toBeInstanceOf(PropertyError);
		expect(err.code).toBe('BAD_ADDRESS');
		expect(calls).toHaveLength(0);
	});

	it('misspelt suburb: NOT_FOUND, suggests the real address, at most 3 requests', async () => {
		const { calls, fetch } = counted();
		const err = await getPropertyFacts('15 Ellalong St, Pelo Main', { fetch, sleep: noSleep }).catch((e) => e);
		expect(err.code).toBe('NOT_FOUND');
		expect(err.details.suggestions).toContain('15 ELLALONG STREET PELAW MAIN');
		expect(calls.length).toBeLessThanOrEqual(3);
	});

	it('nonsense address: NOT_FOUND, at most 3 requests, never a substituted neighbour', async () => {
		const { calls, fetch } = counted();
		const err = await getPropertyFacts('999999 Nowhere Rd', { fetch, sleep: noSleep }).catch((e) => e);
		expect(err.code).toBe('NOT_FOUND');
		expect(calls.length).toBeLessThanOrEqual(3);
	});
});

describe('lotLabel', () => {
	it.each([
		[{ lotnumber: '18', sectionnumber: null, planlabel: 'DP246833' }, 'Lot 18 DP 246833'],
		[{ lotnumber: '3', sectionnumber: '2', planlabel: 'DP1234' }, 'Lot 3 Sec 2 DP 1234'],
		[{ lotnumber: null, sectionnumber: null, planlabel: 'SP4529' }, 'SP 4529'] // strata plan: seen at 1 Clarence St, Port Macquarie
	])('%j -> %s', (attrs, label) => expect(lotLabel(attrs)).toBe(label));
});

describe('property facts: flood coverage', () => {
	it('outside the 10 LGAs the state layer covers, "no polygon" is reported as not covered, not as "no flood"', async () => {
		const f = await facts('15 Ellalong St, Pelaw Main'); // Cessnock
		expect(f.flood).toBeNull();
		expect(f.flood_class).toBeNull();
		expect(f.not_covered).toEqual(['flood']);
		expect(f.unknown).toEqual([]); // a permanent data gap, distinct from a service outage
		expect(f.notes.join(' ')).toMatch(/No state flood-planning data exists for CESSNOCK/);
	});

	it('inside a covered LGA the answer is a real boolean, and no gap is reported', async () => {
		const f = await facts('16 Homestead Dr, Horsley'); // Wollongong, in a flood polygon
		expect(f.flood).toBe(true);
		expect(f.not_covered).toEqual([]);
	});

	it('a covered LGA with no polygon on the lot is a genuine false', async () => {
		const real = replayFetch(table);
		// Horsley recorded data, but pretend the lot is outside every flood polygon
		const fetch = async (url, init) => (/Hazard\/MapServer\/(1|230)\//.test(url) ? json({ features: [] }) : real(url, init));
		const f = await getPropertyFacts('16 Homestead Dr, Horsley', { fetch, sleep: noSleep });
		expect(f.flood).toBe(false);
		expect(f.not_covered).toEqual([]);
	});

	it('a bundle with a permanent data gap is still cached (only outages are not)', async () => {
		const cache = memoryCache();
		await getPropertyFacts('15 Ellalong St, Pelaw Main', { fetch: replayFetch(table), cache, sleep: noSleep });
		expect(cache.sets).toBe(1);
	});
});

describe('property facts: cache', () => {
	it('second call is served from cache with no ArcGIS traffic', async () => {
		const cache = memoryCache();
		const { calls, fetch } = counted();
		const first = await getPropertyFacts('15 Ellalong St, Pelaw Main', { fetch, cache, sleep: noSleep });
		const afterFirst = calls.length;
		expect(first.cached).toBe(false);
		expect(afterFirst).toBeGreaterThan(5);

		const second = await getPropertyFacts('15 ELLALONG STREET PELAW MAIN', { fetch, cache, sleep: noSleep });
		expect(second.cached).toBe(true);
		expect(second.zone).toBe('R2');
		expect(calls).toHaveLength(afterFirst);
	});
});

describe('property facts: upstream failures', () => {
	it('flood primary layer 502s: falls over to the mirror layer', async () => {
		const real = replayFetch(table);
		const fetch = async (url, init) => {
			if (url.includes('/Planning/Hazard/MapServer/1/')) return html502();
			if (url.includes('Planning_Portal_Hazard/MapServer/230/')) {
				return json({ features: [{ attributes: { LAY_CLASS: 'Flood Planning Area', AMENDMENT: 'x' } }] });
			}
			return real(url, init);
		};
		const f = await getPropertyFacts('15 Ellalong St, Pelaw Main', { fetch, sleep: noSleep });
		expect(f.flood).toBe(true);
		expect(f.unknown).toEqual([]);
	});

	it('a non-critical layer that is down becomes UNKNOWN, never false, and is not cached', async () => {
		const real = replayFetch(table);
		const fetch = async (url, init) => (url.includes('/Hazard/MapServer/') ? html502() : real(url, init));
		const cache = memoryCache();
		const f = await getPropertyFacts('15 Ellalong St, Pelaw Main', { fetch, cache, sleep: noSleep });
		expect(f.flood).toBeNull(); // not `false`: we do not know
		expect(f.flood_class).toBeNull();
		expect(f.unknown).toEqual(['flood']);
		expect(f.zone).toBe('R2'); // everything else still resolved
		expect(cache.sets).toBe(0); // a transient 502 must not be remembered for 30 days
	});

	it('a critical layer (zone) that is down aborts with UPSTREAM', async () => {
		const real = replayFetch(table);
		const fetch = async (url, init) => (url.includes('/EPI_Primary_Planning_Layers/MapServer/2/') ? html502() : real(url, init));
		const err = await getPropertyFacts('15 Ellalong St, Pelaw Main', { fetch, sleep: noSleep }).catch((e) => e);
		expect(err.code).toBe('UPSTREAM');
		expect(err.message).toContain('zone');
	});

	it('geocoder down: UPSTREAM after one retry, and no other service is touched', async () => {
		const calls = [];
		const fetch = async (url) => (calls.push(url), html502());
		const err = await getPropertyFacts('15 Ellalong St, Pelaw Main', { fetch, sleep: noSleep }).catch((e) => e);
		expect(err.code).toBe('UPSTREAM');
		expect(calls).toHaveLength(2); // attempt + one retry, then stop
	});
});

// Opt-in against the real services: LIVE=1 npx vitest run test/property.test.js
describe.skipIf(!process.env.LIVE)('property facts: LIVE', () => {
	it('resolves Pelaw Main against the real services', async () => {
		const f = await getPropertyFacts('15 Ellalong St, Pelaw Main');
		expect(f.zone).toBe('R2');
		expect(f.lga).toBe('CESSNOCK');
	}, 60_000);
});
