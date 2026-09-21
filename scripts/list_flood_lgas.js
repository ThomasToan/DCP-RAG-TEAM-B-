// Which LGAs does the state flood-planning layer actually cover? Paste the output into FLOOD_MAPPED_LGAS (property.js).
//   node scripts/list_flood_lgas.js
import { arcgisQuery } from '../src/lib/server/arcgis.js';
import { FLOOD_MAPPED_LGAS } from '../src/lib/server/property.js';

const ENV = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services';
const URLS = [`${ENV}/Planning/Hazard/MapServer/1/query`, `${ENV}/ePlanning/Planning_Portal_Hazard/MapServer/230/query`];

let names;
for (const url of URLS) {
	try {
		const r = await arcgisQuery(url, { where: '1=1', outFields: 'LGA_NAME', returnDistinctValues: true, returnGeometry: false }, { label: 'flood' });
		names = r.features.map((f) => f.attributes.LGA_NAME).filter(Boolean).sort();
		break;
	} catch (e) {
		console.error(`${url.split('/').slice(-4, -2).join('/')} failed: ${e.message}`);
	}
}
if (!names) process.exit(1);

console.log(`${names.length} LGAs have flood-planning polygons:\n${names.map((n) => `'${n}'`).join(', ')}\n`);
const added = names.filter((n) => !FLOOD_MAPPED_LGAS.has(n));
const gone = [...FLOOD_MAPPED_LGAS].filter((n) => !names.includes(n));
console.log(added.length || gone.length ? `CHANGED since property.js was written. new: [${added}]  removed: [${gone}]` : 'unchanged vs FLOOD_MAPPED_LGAS in property.js');
