import { arcgisQuery } from './arcgis.js';
import { normaliseAddress } from './address.js';
import { PropertyError } from './property-error.js';
import { ringsAreaM2, formatPlan } from './geo.js';

/**
 * Address -> parcel -> planning facts. This bundle is the SCOPE for everything downstream, exactly as
 * `session` was in the order agent: computed server-side from the address, never an LLM tool argument.
 *
 * No SvelteKit imports on purpose: tests and scripts import this file directly. `fetch` and `cache`
 * are injected.
 */

const SPATIAL = 'https://portal.spatial.nsw.gov.au/server/rest/services';
const ENV = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services';
const EPI = `${ENV}/Planning/EPI_Primary_Planning_Layers/MapServer`;

export const ENDPOINTS = {
	geocode: `${SPATIAL}/NSW_Geocoded_Addressing_Theme/FeatureServer/1/query`,
	lot: `${SPATIAL}/NSW_Land_Parcel_Property_Theme_multiCRS/FeatureServer/8/query`
};

const sq = (s) => s.replace(/'/g, "''");
const distinct = (rows, fn) => [...new Set(rows.map(fn).filter((v) => v != null && v !== ''))];
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// ---------------------------------------------------------------------------------------------
// 1.1 Address -> point
// ---------------------------------------------------------------------------------------------

async function geocodeQuery(where, deps, limit = 20) {
	const r = await arcgisQuery(
		ENDPOINTS.geocode,
		{
			where,
			outFields: 'address,gurasid,principaladdresssiteoid',
			returnGeometry: true,
			outSR: 4326,
			resultRecordCount: limit
		},
		{ ...deps, label: 'geocoder' }
	);
	return r.features ?? [];
}

const uniqueByAddress = (features) => [...new Map(features.map((f) => [f.attributes.address, f])).values()];

/**
 * ONE prefix query resolves both `15 ELLALONG STREET PELAW MAIN` and `15 ELLALONG STREET` (no suburb).
 * Measured on the live layer: `address = 'X'` takes 6-7 s and `= X OR LIKE ...` never returns, while
 * `LIKE 'X%'` takes 0.2 s. So: prefix LIKE, then filter to whole-word matches here (LIKE 'X%' would also
 * match `15 MAINE ...` for key `15 MAIN`).
 *
 * On a miss we spend at most two more queries on *suggestions* and then fail: we never quietly
 * substitute a neighbour's lot, because planning facts for the wrong property are worse than an error.
 */
async function geocode(p, deps) {
	const k = sq(p.key);
	const wholeWord = (f) => f.attributes.address === p.key || f.attributes.address.startsWith(`${p.key} `);
	const hits = uniqueByAddress((await geocodeQuery(`address LIKE '${k}%'`, deps)).filter(wholeWord));
	if (hits.length === 1) return hits[0];
	if (hits.length > 1) {
		throw new PropertyError('AMBIGUOUS', `"${p.input}" matches more than one address. Add the suburb.`, {
			candidates: hits.map((f) => f.attributes.address)
		});
	}

	let suggestions = [];
	if (p.street && p.suburb) {
		// right number + street, wrong/misspelt suburb
		suggestions = uniqueByAddress(await geocodeQuery(`address LIKE '${sq(`${p.houseNumber} ${p.street}`)} %'`, deps, 5));
	}
	if (suggestions.length === 0) {
		// misspelt street: same number, same first letters
		const prefix = (p.key.split(' ')[1] ?? '').slice(0, 4);
		if (prefix) {
			suggestions = uniqueByAddress(await geocodeQuery(`address LIKE '${sq(`${p.houseNumber} ${prefix}`)}%'`, deps, 5));
		}
	}
	throw new PropertyError('NOT_FOUND', `No address found for "${p.input}".`, {
		suggestions: suggestions.map((f) => f.attributes.address)
	});
}

// ---------------------------------------------------------------------------------------------
// 1.2 Point -> lot / DP
// ---------------------------------------------------------------------------------------------

const bboxCentre = (rings) => {
	const pts = rings.flat();
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
};

async function findLot(pt, deps) {
	const base = {
		geometry: `${pt.x},${pt.y}`,
		geometryType: 'esriGeometryPoint',
		inSR: 4326,
		spatialRel: 'esriSpatialRelIntersects',
		outFields: 'lotnumber,sectionnumber,planlabel,lotidstring,planlotarea',
		returnGeometry: true,
		outSR: 4326
	};
	const q = async (extra = {}) =>
		(await arcgisQuery(ENDPOINTS.lot, { ...base, ...extra }, { ...deps, label: 'lot layer' })).features ?? [];

	let feats = await q();
	let nearby = false;
	if (feats.length === 0) {
		// address point sits on a road edge / just outside the lot: one bounded 25 m retry
		feats = await q({ distance: 25, units: 'esriSRUnit_Meter' });
		nearby = feats.length > 0;
	}
	if (feats.length === 0) {
		throw new PropertyError('NO_LOT', 'The address geocoded but no land parcel was found at that point.');
	}

	const scored = feats.map((f) => {
		const [cx, cy] = bboxCentre(f.geometry.rings);
		return { f, area: ringsAreaM2(f.geometry.rings), dist: Math.hypot(cx - pt.x, cy - pt.y) };
	});
	// on-point: biggest wins (stacked strata lots). Nearby: closest wins.
	scored.sort((a, b) => (nearby ? a.dist - b.dist : b.area - a.area));
	const { f, area } = scored[0];
	const a = f.attributes;
	const planArea = num(a.planlotarea);

	return {
		rings: f.geometry.rings,
		label: `Lot ${a.lotnumber}${a.sectionnumber ? ` Sec ${a.sectionnumber}` : ''} ${formatPlan(a.planlabel)}`.trim(),
		areaM2: planArea && planArea > 0 ? planArea : Math.round(area * 10) / 10,
		areaSource: planArea && planArea > 0 ? 'plan' : 'computed',
		nearby,
		lotCount: feats.length
	};
}

// ---------------------------------------------------------------------------------------------
// 1.3 Lot -> planning facts. One entry per layer; `extract` turns attribute rows into facts.
// ---------------------------------------------------------------------------------------------

const epiSource = (layer, r) => (r ? { layer, plan: r.EPI_NAME ?? null, amendment: r.AMENDMENT ?? null } : null);
const BUSHFIRE_ORDER = ['Vegetation Category 1', 'Vegetation Category 2', 'Vegetation Category 3', 'Vegetation Buffer'];
const isConservationArea = (r) => /conservation area/i.test(r.LAY_CLASS ?? '');

/**
 * `mode`   'polygon' = tested against the lot polygon (a bushfire buffer can clip a corner);
 *          'point'   = tested at the address point.
 * `byPoint` if the polygon touches several distinct values (split-zoned lot), re-ask at the point.
 * `critical` failure aborts the lookup; otherwise the fact becomes UNKNOWN (never `false`).
 * `urls`   primary first, then mirrors of the same data.
 */
const FACT_LAYERS = [
	{
		key: 'lga',
		mode: 'point',
		urls: [`${SPATIAL}/NSW_Administrative_Boundaries_Theme/MapServer/8/query`],
		extract: (rows) => ({
			facts: { lga: rows[0]?.lganame ?? null, council: rows[0]?.councilname ?? null },
			source: { layer: 'NSW_Administrative_Boundaries_Theme/8' }
		})
	},
	{
		key: 'zone',
		critical: true,
		byPoint: true,
		urls: [`${EPI}/2/query`],
		keyOf: (r) => r.SYM_CODE,
		extract: (rows, polyRows) => ({
			facts: {
				zone: rows[0]?.SYM_CODE ?? null,
				zone_name: rows[0]?.LAY_CLASS ?? null,
				zones: distinct(polyRows, (r) => r.SYM_CODE),
				lga_epi: rows[0]?.LGA_NAME ?? null
			},
			source: epiSource('EPI_Primary_Planning_Layers/2', rows[0])
		})
	},
	{
		key: 'fsr',
		byPoint: true,
		urls: [`${EPI}/1/query`],
		keyOf: (r) => r.FSR,
		extract: (rows) => ({ facts: { fsr: num(rows[0]?.FSR) }, source: epiSource('EPI_Primary_Planning_Layers/1', rows[0]) })
	},
	{
		key: 'height_m',
		byPoint: true,
		urls: [`${EPI}/5/query`],
		keyOf: (r) => r.MAX_B_H_M ?? r.MAX_B_H,
		extract: (rows) => ({
			facts: { height_m: num(rows[0]?.MAX_B_H_M ?? rows[0]?.MAX_B_H) },
			source: epiSource('EPI_Primary_Planning_Layers/5', rows[0])
		})
	},
	{
		key: 'min_lot_m2',
		byPoint: true,
		urls: [`${EPI}/4/query`],
		keyOf: (r) => r.LOT_SIZE,
		extract: (rows) => {
			const v = num(rows[0]?.LOT_SIZE);
			const ha = /ha/i.test(rows[0]?.UNITS ?? '');
			return {
				facts: { min_lot_m2: v == null ? null : ha ? v * 10000 : v },
				source: epiSource('EPI_Primary_Planning_Layers/4', rows[0])
			};
		}
	},
	{
		key: 'heritage',
		urls: [`${EPI}/0/query`],
		extract: (rows) => {
			const items = rows.filter((r) => !isConservationArea(r));
			const areas = rows.filter(isConservationArea);
			const parts = [];
			if (items.length) {
				// one item can be several polygons sharing an H_ID: list each id once
				const ids = distinct(items, (r) => (/^\d+$/.test(r.H_ID ?? '') ? `I${r.H_ID}` : (r.H_ID ?? '?')));
				parts.push(`item ${ids.join(', ')}`);
			}
			if (areas.length) parts.push('HCA');
			return {
				facts: {
					heritage: parts.length ? parts.join('; ') : null,
					heritage_detail: rows.map((r) => ({ class: r.LAY_CLASS, id: r.H_ID ?? null, name: r.H_NAME ?? null, significance: r.SIG ?? null }))
				},
				source: epiSource('EPI_Primary_Planning_Layers/0', rows[0])
			};
		}
	},
	{
		key: 'bushfire',
		urls: [`${ENV}/ePlanning/Planning_Portal_Hazard/MapServer/229/query`],
		extract: (rows) => {
			const cats = distinct(rows, (r) => r.d_Category);
			const worst = BUSHFIRE_ORDER.find((c) => cats.includes(c)) ?? cats[0] ?? null;
			return { facts: { bushfire: worst }, source: { layer: 'Planning_Portal_Hazard/229' } };
		}
	},
	{
		key: 'flood',
		// Planning/Hazard/1 was seen returning 502 while Planning_Portal_Hazard/230 was fine: same data, so mirror it.
		urls: [`${ENV}/Planning/Hazard/MapServer/1/query`, `${ENV}/ePlanning/Planning_Portal_Hazard/MapServer/230/query`],
		extract: (rows) => ({
			facts: { flood: rows.length > 0, flood_class: rows[0]?.LAY_CLASS ?? null },
			source: { layer: 'Hazard/1', amendment: rows[0]?.AMENDMENT ?? null }
		})
	},
	{
		key: 'acid_sulfate',
		urls: [`${ENV}/Planning/Protection/MapServer/1/query`],
		extract: (rows) => {
			// Class 1 is the most severe, so the lowest class number wins
			const classes = distinct(rows, (r) => r.LAY_CLASS).sort((a, b) => (num(/\d+/.exec(a)?.[0]) ?? 9) - (num(/\d+/.exec(b)?.[0]) ?? 9));
			return { facts: { acid_sulfate: classes[0] ?? null }, source: { layer: 'Protection/1' } };
		}
	},
	{
		key: 'terrestrial_biodiversity',
		urls: [`${ENV}/Planning/Protection/MapServer/10/query`],
		extract: (rows) => ({ facts: { terrestrial_biodiversity: rows.length > 0 }, source: { layer: 'Protection/10' } })
	},
	{
		key: 'foreshore',
		urls: [`${ENV}/ePlanning/Planning_Portal_Principal_Planning/MapServer/26/query`],
		extract: (rows) => ({ facts: { foreshore: rows.length > 0 }, source: { layer: 'Planning_Portal_Principal_Planning/26' } })
	}
];

/** What each layer contributes when it could not be read: `null`, never a guessed `false`. */
const UNKNOWN_VALUE = {
	lga: { lga: null, council: null },
	zone: { zone: null, zone_name: null, zones: [] },
	fsr: { fsr: null },
	height_m: { height_m: null },
	min_lot_m2: { min_lot_m2: null },
	heritage: { heritage: null, heritage_detail: [] },
	bushfire: { bushfire: null },
	flood: { flood: null, flood_class: null },
	acid_sulfate: { acid_sulfate: null },
	terrestrial_biodiversity: { terrestrial_biodiversity: null },
	foreshore: { foreshore: null }
};

async function runFactLayer(layer, geo, deps) {
	const ask = async (geomParams) => {
		let last;
		for (const url of layer.urls) {
			try {
				const r = await arcgisQuery(
					url,
					{ ...geomParams, spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: false },
					{ ...deps, label: layer.key }
				);
				return (r.features ?? []).map((f) => f.attributes);
			} catch (e) {
				if (!(e instanceof PropertyError) || e.code !== 'UPSTREAM') throw e;
				last = e;
			}
		}
		throw last;
	};

	const polyRows = await ask(layer.mode === 'point' ? geo.point : geo.polygon);
	let rows = polyRows;
	if (layer.byPoint && distinct(polyRows, layer.keyOf).length > 1) {
		// split-zoned lot: report the value at the address point, and (for zone) keep the full list
		const atPoint = await ask(geo.point);
		if (atPoint.length) rows = atPoint;
	}
	return layer.extract(rows, polyRows);
}

/** Small concurrency limiter: ~12 layer queries, but never more than `limit` in flight. */
async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]);
			}
		})
	);
	return out;
}

// ---------------------------------------------------------------------------------------------
// 1.4 Public API
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ get(key: string): Promise<object|null>, set(key: string, facts: object): Promise<void> }} FactsCache
 */

/**
 * @param {string} address  as typed by the user
 * @param {{ fetch?: typeof fetch, cache?: FactsCache, sleep?: (ms:number)=>Promise<void>, concurrency?: number }} [opts]
 */
export async function getPropertyFacts(address, opts = {}) {
	const { cache, concurrency = 4, ...deps } = opts;
	const parsed = normaliseAddress(address);

	const hit = cache ? await cache.get(parsed.key) : null;
	if (hit) return { ...hit, cached: true };

	const found = await geocode(parsed, deps);
	const pt = found.geometry;
	const lot = await findLot(pt, deps);

	const geo = {
		point: { geometry: `${pt.x},${pt.y}`, geometryType: 'esriGeometryPoint', inSR: 4326 },
		polygon: {
			geometry: JSON.stringify({ rings: lot.rings, spatialReference: { wkid: 4326 } }),
			geometryType: 'esriGeometryPolygon',
			inSR: 4326
		}
	};

	const results = await mapLimit(FACT_LAYERS, concurrency, async (layer) => {
		try {
			return { layer, ...(await runFactLayer(layer, geo, deps)) };
		} catch (e) {
			if (e instanceof PropertyError && e.code === 'UPSTREAM' && !layer.critical) return { layer, error: e };
			throw e;
		}
	});

	const facts = {};
	const sources = {};
	const unknown = [];
	for (const r of results) {
		if (r.error) {
			Object.assign(facts, UNKNOWN_VALUE[r.layer.key]);
			unknown.push(r.layer.key);
		} else {
			Object.assign(facts, r.facts);
			if (r.source) sources[r.layer.key] = r.source;
		}
	}
	// the LGA layer is not critical; the zone row also carries the LGA name
	if (!facts.lga && facts.lga_epi) facts.lga = facts.lga_epi;
	delete facts.lga_epi;

	const notes = [];
	if (parsed.unit) notes.push(`Unit ${parsed.unit} ignored: facts are for the whole lot.`);
	if (lot.nearby) notes.push('No lot contained the address point; used the nearest lot within 25 m.');
	if (lot.lotCount > 1 && !lot.nearby) notes.push(`${lot.lotCount} lots overlap the address point; used the largest.`);
	if (!facts.zone && !unknown.includes('zone')) notes.push('No land zoning found for this lot.');

	const bundle = {
		address: found.attributes.address,
		address_input: address,
		site_oid: found.attributes.principaladdresssiteoid ?? null,
		point: { lon: pt.x, lat: pt.y },
		lot: lot.label,
		lot_area_m2: lot.areaM2,
		lot_area_source: lot.areaSource,
		...facts,
		precincts: [], // DCP-defined; filled in later from the DCP itself, not from ArcGIS
		unknown, // facts we could not read; the applicability layer must not treat these as "no"
		notes,
		sources,
		fetched_at: new Date().toISOString()
	};

	// Never cache a partial bundle: a transient 502 must not be remembered for 30 days.
	if (cache && unknown.length === 0) await cache.set(parsed.key, bundle);
	return { ...bundle, cached: false };
}
