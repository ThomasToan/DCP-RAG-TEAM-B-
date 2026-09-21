// Try any address against the live NSW services (no DB, no cache).
//   node scripts/try_address.js "15 Ellalong St, Pelaw Main"
import { getPropertyFacts } from '../src/lib/server/property.js';
import { PropertyError } from '../src/lib/server/property-error.js';

const address = process.argv.slice(2).join(' ');
if (!address) {
	console.error('usage: node scripts/try_address.js "<address>"');
	process.exit(2);
}

let calls = 0;
const countingFetch = (...a) => {
	calls++;
	return fetch(...a);
};

const t0 = Date.now();
try {
	const facts = await getPropertyFacts(address, { fetch: countingFetch });
	console.log(JSON.stringify(facts, null, 2));
	console.error(`\n${calls} ArcGIS requests, ${Date.now() - t0} ms`);
} catch (e) {
	if (!(e instanceof PropertyError)) throw e;
	console.log(JSON.stringify({ error: e.code, message: e.message, details: e.details }, null, 2));
	console.error(`\n${calls} ArcGIS requests, ${Date.now() - t0} ms`);
	process.exit(1);
}
