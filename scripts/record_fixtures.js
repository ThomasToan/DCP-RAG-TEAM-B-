// Record real ArcGIS responses for the property.js tests. Re-run only when you change a layer or add an address.
//   node scripts/record_fixtures.js
// Records only good responses, and re-runs an address until every layer answered (the gateway flaps).
import { getPropertyFacts } from '../src/lib/server/property.js';
import { loadFixtures, saveFixtures, recordingFetch } from '../test/helpers/arcgis-fixtures.js';

/** [address, should resolve?] */
const SCENARIOS = [
	['15 Ellalong St, Pelaw Main', true], // plain R2, no overlays
	['32 Wallis Creek Lane, Mulbring', true], // RU2 + bushfire
	['4A Mount Sugarloaf Rd, West Wallsend', true], // heritage item + bushfire
	['16 Homestead Dr, Horsley', true], // R2 + flood + acid sulfate
	['15 Ellalong St, Pelo Main', false], // misspelt suburb -> NOT_FOUND + suggestion
	['999999 Nowhere Rd', false] // nothing at all -> NOT_FOUND
];

const table = loadFixtures();
const fetchRec = recordingFetch(table);

for (const [address, shouldResolve] of SCENARIOS) {
	for (let attempt = 1; attempt <= 6; attempt++) {
		try {
			const f = await getPropertyFacts(address, { fetch: fetchRec });
			if (f.unknown.length === 0) {
				console.log(`ok   ${address}  (${f.zone}, ${f.lot_area_m2} m2)`);
				break;
			}
			console.log(`  ${address}: unknown ${f.unknown.join(',')}, retrying (${attempt})`);
		} catch (e) {
			if (!shouldResolve && (e.code === 'NOT_FOUND' || e.code === 'BAD_ADDRESS')) {
				console.log(`ok   ${address}  (${e.code}, as expected)`);
				break;
			}
			console.log(`  ${address}: ${e.code ?? e.message}, retrying (${attempt})`);
		}
		await new Promise((r) => setTimeout(r, 3000));
	}
}
saveFixtures(table);
console.log(`\n${Object.keys(table).length} responses saved to test/fixtures/arcgis.json`);
