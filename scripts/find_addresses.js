// Find real addresses that have a given planning fact, by walking overlay polygons near a centre point.
// Used to get positive controls now, and to pick the 10 eval addresses in Phase 3.
//
//   node scripts/find_addresses.js --want bushfire --near "15 Ellalong St Pelaw Main" [--radius 0.06] [--max 3]
//
// --want   bushfire | flood | heritage | acid_sulfate | zone:R2 | zone:R2:over600 (R2 lot > 600 m2)
import { getPropertyFacts } from '../src/lib/server/property.js';
import { arcgisQuery } from '../src/lib/server/arcgis.js';

const args = Object.fromEntries(
	process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), [])
);
const want = args.want;
const radius = Number(args.radius ?? 0.06);
const max = Number(args.max ?? 3);
if (!want || !(args.near || args.lonlat)) {
	console.error('usage: node scripts/find_addresses.js --want <fact> (--near "<address>" | --lonlat "lon,lat") [--radius 0.06] [--max 3]');
	process.exit(2);
}

const ENV = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services';
const GEOCODE = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Geocoded_Addressing_Theme/FeatureServer/1/query';
const OVERLAYS = {
	bushfire: [`${ENV}/ePlanning/Planning_Portal_Hazard/MapServer/229/query`],
	flood: [`${ENV}/Planning/Hazard/MapServer/1/query`, `${ENV}/ePlanning/Planning_Portal_Hazard/MapServer/230/query`],
	heritage: [`${ENV}/Planning/EPI_Primary_Planning_Layers/MapServer/0/query`],
	acid_sulfate: [`${ENV}/Planning/Protection/MapServer/1/query`],
	zone: [`${ENV}/Planning/EPI_Primary_Planning_Layers/MapServer/2/query`]
};
const [kind, arg1, arg2] = want.split(':');
const layerUrls = OVERLAYS[kind];
if (!layerUrls) throw new Error(`unknown --want ${want}`);

const matches = (f) => {
	switch (kind) {
		case 'bushfire': return !!f.bushfire;
		case 'flood': return f.flood === true;
		case 'heritage': return !!f.heritage;
		case 'acid_sulfate': return !!f.acid_sulfate;
		case 'zone': return f.zone === arg1 && (arg2 !== 'over600' || f.lot_area_m2 > 600) && (arg2 !== 'under500' || f.lot_area_m2 < 500);
	}
};

// Scripts (unlike the library) may loop: the gateway flaps, and a finder run is not a user request.
async function withRetry(fn, tries = 3) {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (e) {
			if (i >= tries || e.code !== 'UPSTREAM') throw e;
			console.error(`  upstream flap (${e.message}); retry ${i}/${tries - 1}`);
			await new Promise((r) => setTimeout(r, 3000));
		}
	}
}
const facts = (a) => withRetry(() => getPropertyFacts(a));

let centre;
let lon, lat;
if (args.lonlat) {
	[lon, lat] = args.lonlat.split(',').map(Number);
	centre = { address: `${lon},${lat}` };
} else {
	centre = await facts(args.near);
	({ lon, lat } = centre.point);
}
const env = JSON.stringify({ xmin: lon - radius, ymin: lat - radius, xmax: lon + radius, ymax: lat + radius, spatialReference: { wkid: 4326 } });

let polys;
for (const url of layerUrls) {
	try {
		const where = kind === 'zone' ? `SYM_CODE='${arg1}'` : '1=1';
		polys = (await arcgisQuery(url, { where, geometry: env, geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: true, outSR: 4326, resultRecordCount: 8 }, { label: kind })).features;
		break;
	} catch (e) {
		console.error(`  (${url.split('/').slice(-4, -2).join('/')} failed: ${e.message})`);
	}
}
console.error(`${polys?.length ?? 0} ${kind} polygon(s) near ${centre.address}`);

const seen = new Set();
let found = 0;
for (const poly of polys ?? []) {
	const pts = poly.geometry.rings.flat();
	const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
	// shrink the bbox towards its middle so candidate addresses are more likely inside the polygon
	const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
	const hw = Math.min((Math.max(...xs) - Math.min(...xs)) / 4, 0.004), hh = Math.min((Math.max(...ys) - Math.min(...ys)) / 4, 0.004);
	const box = JSON.stringify({ xmin: cx - hw, ymin: cy - hh, xmax: cx + hw, ymax: cy + hh, spatialReference: { wkid: 4326 } });
	const addrs = (await arcgisQuery(GEOCODE, { where: '1=1', geometry: box, geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outFields: 'address', returnGeometry: false, resultRecordCount: 12 }, { label: 'geocoder' })).features.map((f) => f.attributes.address);
	for (const a of addrs.slice(0, 6)) {
		if (seen.has(a)) continue;
		seen.add(a);
		try {
			const f = await facts(a);
			if (matches(f)) {
				found++;
				console.log(JSON.stringify({ address: f.address, lga: f.lga, zone: f.zone, lot_area_m2: f.lot_area_m2, min_lot_m2: f.min_lot_m2, heritage: f.heritage, bushfire: f.bushfire, flood: f.flood, acid_sulfate: f.acid_sulfate, unknown: f.unknown }));
				if (found >= max) process.exit(0);
			}
		} catch (e) {
			console.error(`  skip ${a}: ${e.code ?? e.message}`);
		}
	}
}
if (!found) console.error('no matching address found; try a larger --radius or another --near');
